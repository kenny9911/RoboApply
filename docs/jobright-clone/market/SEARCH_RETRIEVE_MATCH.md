# Search, retrieve and match: best practice, audit of our pipeline, and the design to build

**Date:** 2026-10-11. **Branch:** `feat/jobright-clone`. **Scope:** both brands (RoboApply = international incl. Taiwan, GoApply = mainland China).
**Status:** research and design only. No code, schema or data was changed. Nothing here overrides D1–D5.

**How to read confidence marks:** *confirmed* = read in our code, measured on our database, or read on a primary source page; *likely* = one credible secondary source or a primary page I could not open in full; *inferred* = my reasoning from confirmed facts.

**What I measured.** Two read-only SQL census runs against the clone's Neon branch (`SET default_transaction_read_only = on`; counts only, no row content exported). No job-provider API was called (0 of the 8 allowed probes used), because the question here is ranking and matching, not source coverage.

---

## 1. Summary

1. **Our retrieval is "hard filters, newest 400"; relevance never picks the candidates.** `retrievalSql` orders by `postedAt DESC LIMIT 400` (`server/src/features/feed/sql.ts`, `FEED_LIMITS.retrievalLimit`). That is adequate at today's 1,847 live jobs. It stops being adequate as soon as a search matches more than 400 jobs in the window: the best match that is the 401st newest is invisible until the user scrolls past 400 cards. (confirmed in code; consequence inferred)
2. **The quick estimate (pre-score) mostly re-scores the user's own filters.** Title overlap is 1.0 by construction when the saved search has a role filter (the SQL already required it); logistics is "met" by construction (stored rows: 98.3 average when stated); industry is never scored because 100% of live jobs have a company with no industries; seniority is compared with the Level filter chips, not with the resume. Only the skills fraction discriminates, and it drops out when a post lists no skills, so the remaining weights renormalize to 100. This is the direct cause of the "100/100 Great fit" finding. (confirmed in code and data)
3. **The estimate and the AI score are on different scales, and the feed mixes them.** Stored scorer-v3 rows average 42.5 (sd 22.2, n=202). The feed ranks by `fit = ai ?? (pre − 5)`. The precompute cron AI-scores the jobs with the highest estimate, so exactly the jobs the system looked at hardest drop below the ones it never read. (code confirmed; effect inferred; the 202 rows come from verification test accounts, so the true mean will differ, but the scale gap is structural)
4. **There is no single fit record.** The AI cache key is (user, job, resume variant) plus resume hash, model and prompt version. Feed, detail, Similar jobs, alerts, Ready list, Assistant and the tailoring kit each choose their own variant and their own pre-or-AI rule. That is why one job showed 61, 63, "Good fit" and 69. (confirmed in code)
5. **Text matching is literal.** Skills are free strings (7,397 distinct strings over 17,376 mentions; "communication" is the most common "skill"); the keyword check compares normalized strings and whole words. There is no alias, no canonical skill id and no semantic fallback. (confirmed)
6. **Title-to-role matching has a precision bug.** A one-word synonym matches any title that contains the word. `architect` (building architect, under Design) captures "Java Backend Architect"; 22 of the 58 live Design jobs are tagged `architect`, and enrichment is not allowed to correct a deterministic match. (confirmed in code and data)
7. **There are no embeddings on jobs or users.** `pgvector` 0.8.6 is available on the Neon branch (PostgreSQL 18.6) and not installed. Neon retired `pg_search` on 2026-09-21; its BM25 replacement is `lakebase_text`. `pg_trgm` works on Chinese text on this database; `to_tsvector('simple', …)` does not segment Chinese. (confirmed by query and Neon docs)

**The design in one paragraph.** Keep the deterministic ingest, the quote-verified enrichment, the server-computed total and the honest "not stated" model. Add (a) a canonical skill and role layer, (b) one embedding per job and per user in a side table, (c) hybrid candidate retrieval (filters + lexical + dense, fused by reciprocal rank), (d) an estimate that shrinks toward a prior instead of renormalizing and is calibrated to the AI scale, (e) one `getFit(user, job)` function every surface calls, (f) a requirement-level, anchored LLM scorer, and (g) an evaluation harness that gates every change. Per market, only the providers differ (embedding model, reranker, tokenizer); the pipeline and the contract are identical (D5).

---

## 2. Best practice, 2024–2026

### 2.1 Architecture: retrieve cheaply, rank expensively

| Practice | What the sources say | Confidence |
|---|---|---|
| Multi-stage pipeline | LinkedIn's job and people search uses query understanding, embedding-based retrieval, then a cross-encoder small language model for final ranking; an LLM "relevance judge" acts as teacher and labeller, and the production rankers are distilled from it. [arXiv 2510.22101](https://arxiv.org/html/2510.22101v1), [arXiv 2602.07309](https://arxiv.org/html/2602.07309v1) | confirmed (papers' own claims) |
| Exhaustive retrieval is acceptable | LinkedIn skips approximate indexes and scans exhaustively on GPU. For us the equivalent is exact pgvector search over the rows that already passed hard filters. [Substack summary](https://machinelearningatscale.substack.com/p/linkedin-architecture-for-production) | likely |
| LLM query understanding | A fine-tuned LLM for job-search query understanding reduced poor matches and raised NDCG in LinkedIn's A/B test. [arXiv 2509.09690](https://ar5iv.labs.arxiv.org/html/2509.09690) | likely |
| Hybrid lexical + dense with rank fusion | Run a keyword query and a vector query over the same rows and merge by reciprocal rank fusion, `1/(k+rank)` with k≈60, because BM25 and cosine scores are on different scales. [ParadeDB manual](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual), [Tiger Data docs](https://www.tigerdata.com/docs/learn/tutorials/hybrid-search) | confirmed |
| Filtered vector search in Postgres | pgvector applies filters after the index scan; 0.8 added iterative scans (`hnsw.iterative_scan`, `relaxed_order`) so a selective filter still fills the LIMIT. For very selective filters, use the B-tree and exact distance; for low-cardinality filters, partial HNSW indexes. `halfvec` halves storage with minor recall loss. [AWS on pgvector 0.8](https://aws.amazon.com/blogs/database/supercharging-vector-search-performance-and-relevance-with-pgvector-0-8-0-on-amazon-aurora-postgresql), [pgEdge docs](https://docs.pgedge.com/pgvector/v0-8-5/iterative-index-scans/), [BigData Boutique](https://bigdataboutique.com/blog/pgvector-in-production) | confirmed |
| Person–job fit is more than text similarity | The academic line from BOSS-era datasets models job requirements against candidate experience item by item (ability-aware attention) and adds behaviour history. [arXiv 1810.04040](https://arxiv.org/abs/1810.04040), [arXiv 1812.08947](https://arxiv.org/pdf/1812.08947), [arXiv 2206.09116](https://arxiv.org/pdf/2206.09116) | confirmed |
| LLM explanations at scale | Indeed fine-tuned a smaller model for match explanations and cut tokens by 60%, with human-labelled ground truth for automated evaluation. [OpenAI case study](https://openai.com/index/indeed/) | likely (vendor case study) |

**What this means for us.** We are a few thousand to a few hundred thousand jobs per market, not billions. We do not need a search cluster or a GPU. Postgres with `pgvector`, the existing GIN indexes and one LLM call per shortlisted job is the right size. The discipline to copy is the shape: cheap recall of a few hundred candidates by several independent signals, a cheap calibrated estimate on all of them, an expensive judge on the top few, and a judge-labelled evaluation set.

### 2.2 Normalization and taxonomies

| Asset | Facts | Use for us | Confidence |
|---|---|---|---|
| ESCO v1.2 | 3,039 occupations, about 13,900 skills, 28 languages (European languages plus Arabic and Ukrainian; I found no Chinese edition). Each occupation maps to ISCO-08; an official ESCO–O*NET crosswalk exists. [ESCO v1.2 launch deck](https://esco.ec.europa.eu/system/files/2024-05/V1.2%20Launch%20-%20ESCO%20SEC%20combined%20-%20final%20clean.pdf), [ENISA crosswalk](https://www.enisa.europa.eu/sites/default/files/2024-12/esco-ecsf-crosswalk.pdf), [ESCO–O*NET report](https://esco.ec.europa.eu/en/about-esco/publications/publication/crosswalk-between-esco-and-onet-technical-report) | Seed skill labels and alternative labels in European languages; crosswalk codes on our role nodes. | confirmed (counts); likely (no Chinese) |
| O*NET-SOC | US occupation codes; our taxonomy already carries `soc` on some nodes (`taxonomy.v1.json`). | Keep as the intl crosswalk; join key for LCA and wage data. | confirmed in code |
| LinkedIn Skills Graph | About 39–41 thousand skills; LinkedIn maps free text from jobs, profiles and courses to skill ids and learns many surface forms per skill. Not available as an open dataset. [LinkedIn engineering](https://engineering.linkedin.com/blog/2023/extracting-skills-from-content-to-fuel-the-linkedin-skills-graph) | Pattern to copy: canonical id plus many aliases; not a data source. | confirmed |
| Lightcast Open Skills | 33,000+ skills with ids and a 3-level hierarchy; free API tier, extraction capped at 50 requests a month. [Lightcast](https://lightcast.io/open-skills), [free access](https://docs.lightcast.io/lightcast-api/docs/free-api-access) | Optional alias seed; check licence terms before storing. | confirmed |
| 国家职业分类大典 (2022) | 1,639 occupations in 8 major groups; 97 marked digital (S) and 134 green (L). New occupations are added by MOHRSS notices (17 occupations and 42 工种 in July 2025; 12 more published for comment in July 2026). [CNR/中新网](https://www.chinanews.com.cn/cj/2022/09-28/9862314.shtml), [中新网 2025](https://www.chinanews.com/sh/2025/09-26/10489684.shtml) | A government crosswalk code for reporting. It is an occupation list, not a skill vocabulary, and it is far coarser than job-board titles. | confirmed |
| BOSS直聘 / 智联 职位类目 | Proprietary three-level position trees. I found no licence or open publication. | Do not copy a competitor's tree. Use our own nodes with Chinese labels and learn aliases from GoHire bank titles and user-typed titles. | inferred |
| Taiwan 職業標準分類 (6th rev.) | 10 major, 39 sub-major, 125 minor, 380 unit groups, based on ISCO. [DGBAS e-book](https://statdb.mol.gov.tw/html/svy12/0.%E8%81%B7%E6%A5%AD%E6%A8%99%E6%BA%96%E5%88%86%E9%A1%9E%E9%9B%BB%E5%AD%90%E6%9B%B8.pdf) | Crosswalk code for Taiwan statistics; 104's own category list was not found in public form. | confirmed |

**Practice.** Every large matcher keeps two layers: a small curated role tree for browsing and filters (we have 307 nodes with `en` and `zh` labels), and a large alias-rich skill vocabulary with canonical ids. We have the first and lack the second.

### 2.3 Embedding models and hosting

Prices are per million input tokens. Aggregator figures are marked *likely*; confirm on the vendor page before budgeting.

| Model | Price | Dimensions | Notes | Confidence |
|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | $0.02 (batch about half) | 1536, shortenable | Cheapest mainstream API; key already in `.env`. Weakest of this list on multilingual benchmarks. [layer3labs](https://www.layer3labs.io/guides/openai-embedding-models-pricing) | likely |
| OpenAI `text-embedding-3-large` | $0.13 (batch $0.065) | 3072, shortenable | [costgoat](https://costgoat.com/pricing/openai-embeddings) | likely |
| Voyage `voyage-4-lite` / `voyage-4` / `voyage-4-large` | $0.02 / $0.06 / $0.12 | 1024 default | Vendor positions `voyage-4-large` as its best multilingual retriever. Public MTEB coverage for the v4 family is thin (2 of 131 multilingual tasks), so vendor claims are hard to verify. [Voyage docs](https://docs.voyageai.com/docs/embeddings), [comparison](https://www.buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026) | likely |
| Cohere `embed-v4` | $0.10–0.12 (sources disagree) | 256–1536 | 128K context; multilingual. [tokencost](https://tokencost.app/embeddings) | likely |
| Google `gemini-embedding-001` / Gemini Embedding 2 | $0.15 / $0.20 | up to 3072, shortenable | Key already in `.env`. [tokencost](https://tokencost.app/blog/gemini-embedding-2-pricing) | likely |
| Alibaba `text-embedding-v4` (百炼, Beijing) | ¥0.5 (batch half); 1M free tokens for 90 days | 64–2048, default 1024; 8,192-token input | Mainland-hosted. Singapore region ¥0.514, no free quota. [百炼 docs](https://docs.bailian.console.aliyun.com/zh/model-studio/text-embedding-v4), [pricing](https://help.aliyun.com/zh/model-studio/model-pricing) | confirmed |
| 智谱 `embedding-3` | ¥0.5 | 64–1024 per the doc page read | 8K context, 10 texts per call. [bigmodel docs](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3) | confirmed (verify the dimension ceiling in the console) |
| `BAAI/bge-m3` (open weights) | Free tier on SiliconFlow with rate limits; self-host free | 1024 | One model yields dense and sparse vectors; 100+ languages. [SiliconFlow pricing](https://www.siliconflow.cn/pricing) | likely |
| Qwen3-Embedding 0.6B / 4B / 8B (open weights) | Self-host, or routed providers | 1024 / 2560 / 4096, shortenable | MTEB multilingual, June 2025: 8B 70.58 (first at the time), 4B 69.45, 0.6B 64.33; BGE-M3 59.56. Stated support for cross-lingual retrieval. Verify the licence field on the model card. [HF model card](https://huggingface.co/Qwen/Qwen3-Embedding-4B) | confirmed (scores, 2025 snapshot); licence unverified |

Rerankers (second stage for free-text queries): Cohere Rerank 4 about $2.0–2.5 per 1,000 searches of up to 100 documents ([OpenRouter](https://openrouter.ai/cohere/rerank-4-pro)); Voyage `rerank-2.5` $0.05/M tokens and `-lite` $0.02/M ([OpenRouter](https://openrouter.ai/voyageai/rerank-2.5)); Alibaba `qwen3-rerank` ¥0.5/M tokens, up to 500 documents of 4,000 tokens, 100+ languages ([阿里云](https://help.aliyun.com/zh/model-studio/embedding-rerank-model/)); `bge-reranker-v2-m3` free tier on SiliconFlow ([pricing](https://www.siliconflow.cn/pricing)). All *likely* except Alibaba (*confirmed*).

**Hosting facts that constrain us.**

| Fact | Source | Confidence |
|---|---|---|
| The clone's Neon branch runs PostgreSQL 18.6; `vector` 0.8.6 and `pg_trgm` 1.6 are available; only `pg_trgm` is installed. | census query on `pg_available_extensions` | confirmed |
| Neon deprecated `pg_search` (ParadeDB BM25) for new projects on 2026-03-19 and retired it on 2026-09-21. The replacement is `lakebase_text`: a `lakebase_bm25` index over a standard `tsvector` column, queried with `<@>` and `to_bm25query`. Its tokenizer (`lakebase_tokenizer`) documents lowercase, Unicode normalization, stop words, synonyms and English stemming; no Chinese segmentation is documented. | [Neon pg_search page](https://neon.com/docs/extensions/pg_search), [lakebase_text](https://neon.com/docs/extensions/lakebase-text), [lakebase_tokenizer](https://neon.com/docs/extensions/lakebase-tokenizer) | confirmed |
| On this database (`C.UTF-8`), `pg_trgm` produces trigrams for Chinese text: `similarity('软件工程师','高级软件工程师（后端）') = 0.31`, and `ILIKE '%软件工程师%'` matches. | census query | confirmed |
| `to_tsvector('simple','高级软件工程师 Java 北京')` yields `'高级软件工程师'` as one token. Postgres full-text search needs segmented input for Chinese. | census query | confirmed |
| Aliyun RDS PostgreSQL lists `zhparser`, `pg_jieba`, `pg_bigm` and `rum` (each needs `shared_preload_libraries`). I did not confirm the `pgvector` row on that page. | [阿里云 RDS 插件列表](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/extensions-supported-by-apsaradb-rds-for-postgresql) | likely |

**Consequence.** Tokenize Chinese in the application (we already use `Intl.Segmenter('zh')` in `enrich/keywords.ts`) and store space-separated tokens. The same SQL then works on Neon and on a mainland Postgres with no database-specific segmenter.

### 2.4 LLM scoring: what makes it trustworthy

| Finding | Source | Confidence |
|---|---|---|
| Zero-shot GPT-4 resume ratings correlate only weakly with human ratings; prompting with reasoning helps; humans and the model often apply different criteria. | [NAACL Findings 2025](https://aclanthology.org/2025.findings-naacl.270.pdf) | confirmed |
| Models still show education-related and some demographic effects in job–resume matching; newer models reduced explicit gender and race effects. | [NAACL Industry 2025](https://aclanthology.org/2025.naacl-industry.55/) | confirmed |
| Single pointwise scores are noisy: intraclass correlation 0.58–0.77 depending on the model; about 45% of variance is within-item noise, so "8 vs 9" is not a real difference. | [arXiv 2606.13685](https://arxiv.org/pdf/2606.13685) | likely (preprint) |
| Unbounded numeric scores calibrate poorly; bounded, criterion-level rubrics are more reproducible. Rubric option order causes position bias. | [Autorubric, arXiv 2603.00077](https://arxiv.org/html/2603.00077v1), [arXiv 2602.02219](https://arxiv.org/html/2602.02219v2) | likely (preprints) |
| Post-hoc calibration removes average offset but explains little per-item variance. | [arXiv 2610.02492](https://arxiv.org/html/2610.02492) | likely (preprint) |
| LLM relevance labels (UMBRELA) reproduce the system rankings of human NIST assessors at TREC 2024 on nDCG@20, nDCG@100 and Recall@100 across 77 runs. They are reliable for comparing systems, less so per item. | [arXiv 2406.06519](https://arxiv.org/abs/2406.06519), [arXiv 2411.08275](https://www.arxiv.org/pdf/2411.08275) | confirmed |

**Rules that follow.**
1. Ask the model for small, anchored judgments per requirement, with a verbatim quote, and compute the number on the server. We already compute the total on the server and guard quotes; the per-component 0–100 free number is the weak part.
2. Show tiers and a short list of reasons first; the number second. Do not let a 2-point difference change what the user sees.
3. A score must be a stored fact with a version, reused everywhere, and recomputed only when its inputs change.
4. Keep protected and proxy attributes out of the input. We already strip names and never read school tier.
5. Use the LLM judge to evaluate systems (which ranking is better), and humans to audit the judge.

### 2.5 Feed ranking, feedback and cold start

- **Freshness** matters twice in job search: a newer post is more likely to be open, and applying early helps. Decay should be steep for the first days and flat afterwards, and it should use how recently we last saw the post live, not only the posting date. (inferred; consistent with our `lastSeenAt` and `postedAtEstimated` fields)
- **Diversity:** cap per company (we do), collapse the same role posted in several cities, and avoid a page of near-identical titles. (inferred)
- **Feedback:** explicit negative feedback with a reason is the most valuable signal and should change filters visibly (we do this). Implicit signals (save, apply click, long dwell, seen-but-skipped) should adjust ranking gradually. Learned ranking needs thousands of labelled interactions; we have 19 in the clone database. Heuristic weights are correct for now; log everything so a learned model is possible later. (confirmed count; inferred recommendation)
- **Cold start:** with no resume, the user's onboarding answers are the query. A short "intent text" built from titles, level, skills and industries, embedded once, gives a relevance-ordered first feed before any resume exists. (inferred)

---

## 3. Audit of the current pipeline

### 3.1 The index today (clone database, live public canonical rows)

| Measure | Value |
|---|---|
| Live jobs | 1,847, all `market='intl'` (jsearch 1,658; activejobs 113; robohire 70; gohire 6). **Zero `market='cn'` rows.** |
| Posted in the last 3 / 14 days | 610 / 1,728 |
| No skills / 1–2 skills | 5.4% / 3.2%; mean 9.4 skills per job |
| No taxonomy | 4.2% |
| No seniority | 21.6% |
| No pay disclosed | 40.8% |
| No education level / no minimum years | 61.4% / 52.8% |
| Company with no industries | **100%** |
| Enriched by a model | 94% (`openai/gpt-6-luna`); 3.6% rules-only |
| Distinct skill strings / mentions | 7,397 / 17,376; 1,426 mentions have four or more words |
| Most frequent "skills" | communication (290), python (262), ci/cd (149), java (145), sql (116), attention to detail (112) |
| Design category | 58 jobs, 22 tagged `architect`; samples: "Java Backend Architect", "Principal Architect - Machine Learning", "Microservices Architect" |
| Scorer v3 rows | 202; mean 42.5, sd 22.2, range 0–97. Component means: title_level 43.7, skills 39.1, industry 24.1, career_path 44.5, logistics 98.3 (not stated in 44% of rows) |
| Models in the score cache | `openrouter/openai/gpt-6-luna` and `deepseek/deepseek-v4-flash` |
| Interaction events | 19 |
| Descriptions containing Chinese | 80 of 1,847 |

The GoApply half of the pipeline has never run on real Chinese postings in this environment. Every Chinese-specific statement below is from code reading and research, not from measured behaviour.

### 3.2 Stage by stage

| Stage | What it does now | Verdict |
|---|---|---|
| **Ingest planning** `jobs/ingest/planner.ts` | Demand tuples (role × country × city) from active users' default searches, plus SEO seeds; refresh 6/12/24 h with back-off. | **Keep.** Good cost control. Gap: the provider query is the English role label only; for GoApply and Taiwan it must send the `zh` label and local synonyms. |
| **Normalize** `jobs/normalize/*` | Pure functions for title, company, location, salary, level, dedupe key `sha1(company|title|place)`, `searchText` = title + company + 10 skills (max 500 chars). | **Keep**, with fixes: `searchText` is too thin for keyword search (a term that appears only in the description is unfindable); no content hash of the posting is stored for score staleness. |
| **Role taxonomy** `jobs/taxonomy/match.ts` | Dictionary match of title tokens against labels and synonyms; score = 0.5 + 0.5 × coverage; threshold 0.6. | **Change.** A one-token synonym reaches 0.72–0.80 on any 2–3 word title containing it. `architect`, `designer`, `developer`, `analyst`, `consultant` are discipline-ambiguous head nouns. `enrich/reconcile.ts` line 400 lets the model set a taxonomy id only when the deterministic one is empty, so the error is permanent. |
| **Enrichment** `jobs/enrich/*` | One structured call: taxonomy from ≤15 candidates, seniority, ≤15 skills `{skill, kind, required}`, sponsorship and requirement flags with quotes, summary, education. Quotes verified as substrings. Keywords = skills then TF-IDF over the post's own sentences. | **Keep the contract; change the skill output.** `kind` (hard/soft) is extracted but `RAJob.skills` mixes both and the score counts soft skills. Skills are not canonicalized. The TF-IDF tail produces phrases such as "shared backend systems" that the keyword check then reports as missing. |
| **Feed retrieval** `feed/sql.ts` | Scope + filter predicates on indexed columns, `ORDER BY postedAt DESC LIMIT 400`, 14-day window widened to 45 days below 60 rows. `q` uses `searchText ILIKE` or trigram word similarity. | **Change.** Correct and fast, but recency is the only ordering signal at retrieval. Location predicate bug: a country-only entry with radius 0 is treated as "same city" (verification finding, in fix group G3). |
| **Quick estimate** `match/preScore.ts` | Five weighted dimensions (35/30/15/10/10); not-stated dimensions drop out and weights renormalize. | **Change (highest priority).** See 3.3. |
| **AI score** `match/MatchService.ts`, `RAJobMatchScorerV3Agent` | Four judged components 0–100 with ≤3 verbatim quotes each; logistics deterministic; server sums; cache by (user, job, variant) + resume hash + model + prompt version; 80/day/user and 20,000/day/brand. | **Keep the architecture; tighten the rubric.** Free 0–100 per component with no anchors; temperature 0.1; the prompt puts the job first and the resume last, which defeats prompt-prefix caching across the 25 jobs scored for one user; the job's content is not in the freshness key; a model change silently invalidates and re-scores everything. |
| **Precompute** `match/cron.ts` | Every 15 min: for users active in 7 days, take the feed's top 50, AI-score up to 25 a day with no fresh score, best estimate first. | **Keep; change the pick order** to the fused retrieval rank once the estimate is fixed. Today it picks among many ties at 95–100. |
| **Feed ranking** `feed/ranking.ts` | `0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·sourceQuality + goal points`; `fit = ai ?? (pre − 5)`; company scatter 2 per 20; sponsorship-first; every factor published on `/help/ranking`. | **Keep the structure and the transparency; fix the fit input.** The `−5` offset assumes the two scales differ by 5 points; measured component means differ by 40–60. `freshnessHalfLifeHours: 72` is used as `e^(−h/72)`, a half-life of about 50 hours, and it is ≈0 after two weeks, so every older job ties on freshness. |
| **Affinity** `feed/affinity.ts` | Counters per role id, company and first three skills; +0.10 save, +0.15 apply click, +0.25 applied, −0.10 hide; ×0.98 per day. | **Keep.** Cheap and explainable. Gaps: no title-level negative ("wrong title" does not keep the same title off the Ready weekly list); "first three skills" is arbitrary once skills have ids. |
| **Similar jobs** `jobs/detail/service.ts` | Same `primaryTaxonomyId` (or same normalized title) and country, newest first, ranked by the estimate. | **Change.** It never uses a cached AI score, and "same role id" inherits taxonomy errors. Dense nearest neighbours of the job vector are the natural implementation. |
| **Alerts** `alerts/service.ts` | Candidates from the feed seam, scored with `preScoreMany`, tier stored with the notification. | **Change.** Always the estimate even when an AI score exists; the stored tier goes stale. |
| **Keyword check** `match/keywordRows.ts` | Title by taxonomy overlap; years; degree; skills and keywords by `skillKey` equality or whole-word mention (substring for CJK). | **Change.** Literal. No alias, no "related evidence" state, duplicates such as `typescript/node.js`, `TypeScript`, `Node.js`. |
| **Natural-language search** `job-search/agent.ts`, `feed.nlQuery` | An LLM planner returns 1–2 role queries plus country, location, remote, date and type; everything else is listed as "unverified preferences". `planToFilters` turns the plan into a FilterSet patch; the legacy agent path instead fans out to live RapidAPI providers. | **Keep the planner and its honesty rule; add a relevance leg.** Today the residual text ("climate startups", "uses Rust") is shown as unmatched and does not influence the order. |
| **Assistant tools** `copilot/tools/jobs.ts` | `search_jobs` and `top_fit_jobs` call `feedService.preview` (≤8 items); `analyze_fit` calls `scoreJob` with the thread's resume. | **Keep the seam.** It inherits every feed improvement. Fixes: private imports are invisible to the tools; the answer text and the card can list different jobs; `analyze_fit` can score a different variant than the job page shows. |

### 3.3 Why the estimate says 100

`preScore()` for a user whose saved search has a role filter, on a job that lists no skills:

| Dimension | Weight | Value | Why |
|---|---|---|---|
| title_level | 35 | 100 | `taxonomyOverlap` is 1 whenever the job sits under a target role, and the SQL already required `taxonomyIds && $targets`. The seniority factor is 1.0 when the job's level is one of the **filter chips** (`targetSeniority: filters.seniority` in `match/context.ts`), and 0.8 when either side is unknown. |
| skills | 30 | dropped | `total === 0` → `not_stated`. |
| industry | 15 | dropped | No company has industries. |
| logistics | 10 | 100 | Location, pay and visa were hard filters. |
| career_path | 10 | dropped | Never stated in the estimate. |
| **Total** | | **(35·100 + 10·100) / 45 = 100** | Weights renormalize over 45 of 100 points. |

Three design errors combine:
1. **Selection features reused as scoring features.** A job that passed the filter gets full marks for passing the filter.
2. **Renormalization rewards missing information.** The less a posting says, the higher it can score.
3. **The user's level is read from a control, not from evidence.** Changing the Level chips changed the "fit" from 100 to 84 to 74 in verification. Fit must describe the person and the job.

The same errors explain "internship rated Great for a senior resume" (the chips included that level, or the job's level was unknown → 0.8) and "unrelated jobs rated Great" (taxonomy mis-tags plus trivial logistics).

### 3.4 Why one job shows three results

| Surface | Code path | Score it shows |
|---|---|---|
| Feed card, Ready list | `FeedQueryService.score` → cached AI for the **primary** resume, else estimate | 61 (estimate, before any AI score existed) |
| Job detail | `scoreJob(mode: on_demand)` for the primary resume | 63 (AI) |
| Assistant | `scoreJob(resumeVariantId: ctx.resumeId)` | "Good fit": another (user, job, variant) row or a new model call |
| Tailoring kit "Before" | `TailorService.aiScore(userId, jobId, base.id)` for the **base variant of the tailoring session** | 69 |
| Similar jobs, alerts | `preScoreMany` only | 91 / 87 / tier "good" |

Each (user, job, variant) row is an independent sample from a model at temperature 0.1 with an unanchored 0–100 scale, and the tiers have hard edges at 45, 65 and 80. A 6-point spread across samples is expected noise; crossing 65 turns it into two different labels.

### 3.5 Verification findings mapped to root causes

| Finding (`orch/verify-results.json`) | Root cause | Fixed by (section 4) |
|---|---|---|
| 100/100 "Great fit" when the post states no skills | Renormalization; filter features reused | C2 |
| Fit changes with the Level filter | Seniority read from filter chips | C2 |
| Internship "Great 84" for a senior resume; Senior Python role "Possible 59" | Same, plus literal skill match | C2, C4 |
| Feed 73/59 vs Similar 91/87 vs alert "good" | No single fit function; estimate-only paths | C1 |
| Job page 63, Assistant "Good", kit 69 | Variant-keyed cache, independent samples, hard tier edges | C1, C6 |
| Keyword check lists skills the resume has; duplicate chips | Free-string skills, no aliases | C4 |
| "Design" lists software and AI architects | One-token synonym match; enrichment cannot override | C3 |
| Country-only location treated as same city | Radius 0 without a city compared on `locationCity` | Fix group G2/G3 (already triaged) |
| "$60,000,000 an hour" sorted to the top of Highest pay | No plausibility bound per period | Add a per-currency, per-period sanity range in `normalize/salary.ts`; exclude implausible values from pay sort |
| GoApply fit card uses visa wording and annualized CNY | Market wording, not matching logic | Market hooks for labels; show pay as posted (`18-28K·15薪`) |
| Assistant card and answer list different jobs | Card renders the tool result; the model filters in prose | The model must reference job ids; the card renders exactly those ids |
| Assistant cannot see imported jobs | Feed preview scope vs private rows in tools | Include `ownerUserId = user` rows in the job tools |

---

## 4. The design

Priorities: **P0** = honesty and correctness, before any launch; **P1** = retrieval quality; **P2** = scale and learning.

### 4.1 What to keep

1. Deterministic normalize, then one quote-verified enrichment call per job.
2. The server computes every total; the model never emits one.
3. Deterministic logistics, shared by estimate and AI score.
4. "Not stated" as a first-class value in the UI. (The arithmetic changes; the honesty does not.)
5. CitationGuard on evidence and the PII strip before any prompt; school tier never an input.
6. The feed session and cursor, company scatter, sponsorship-first, and the public `/help/ranking` list of factors.
7. Budgets: 80 on-demand scores per user per day, a brand budget, precompute cap per user.
8. The FilterSet as the one preference store, and the deterministic "Not interested → filter diff" loop.
9. The trigram index on `searchText` for typeahead and fuzzy title or company lookup.

### 4.2 Changes, in priority order

| ID | Priority | Change | Area |
|---|---|---|---|
| **C1** | P0 | One fit source of truth: `getFit(userId, jobId)`; every surface calls it. | `features/match` + all consumers |
| **C2** | P0 | Estimate v2: evidence-based level, prior shrinkage instead of renormalization, coverage and confidence, hard skills only. | `match/preScore.ts`, `match/context.ts` |
| **C3** | P0 | Role taxonomy precision: ambiguous head nouns, enrichment may override weak deterministic matches, backfill. | `jobs/taxonomy`, `jobs/enrich/reconcile.ts` |
| **C4** | P0 | Canonical skills with aliases; three-state keyword check. | new `features/skills`, `jobs/enrich`, `match/keywordRows.ts` |
| **C5** | P0 | Stop mixing scales in ranking: calibrated estimate, no `−5`. | `feed/ranking.ts` |
| **C6** | P1 | Scorer v4: requirement checklist with anchored levels; resume-first prompt; pinned model per market; job content hash in the key; tier hysteresis. | `RAJobMatchScorerAgent`, `MatchService` |
| **C7** | P1 | Embeddings side tables and hybrid retrieval (filters + lexical + dense, RRF). | schema, `feed/sql.ts`, `FeedQueryService` |
| **C8** | P1 | Natural-language search: residual text becomes a relevance query, labelled as ranking, not as a verified filter. | `feed.nlQuery`, copilot tools |
| **C9** | P1 | Evaluation harness and CI invariants. | new `server/src/features/match/eval` |
| **C10** | P2 | Feed ranking: freshness tail, same-role collapse, exploration slot, title-level negative feedback. | `feed/ranking.ts`, `feed/affinity.ts` |
| **C11** | P2 | Reranker for free-text queries; learned weights once interaction volume allows. | `feed` |

### 4.3 C1 — the scoring contract (one score, one source)

**Rule.** For a user and a job there is exactly one **fit**, computed against the user's **primary resume** and current profile. Every surface reads it through one function. A score for another resume version is a different, explicitly named measure ("with this tailored version") and appears only in tailoring, next to the canonical fit.

```ts
// server/src/features/match/fit.ts  (the only place a fit is assembled)
export interface Fit {
  jobId: string;
  /** 0–100 on the calibrated scale, or null when nothing can be compared. */
  score: number | null;
  tier: 'great' | 'good' | 'possible' | 'unlikely' | null;
  kind: 'ai' | 'estimate';
  /** Share of rubric weight backed by stated evidence on both sides, 0–1. */
  coverage: number;
  confidence: 'high' | 'medium' | 'low';
  dimensions: MatchDimension[];
  requirements: RequirementCheck[];        // C6; [] for an estimate
  topOverlap: string | null;
  topGap: string | null;
  basis: {
    resumeVariantId: string | null;        // always the primary for the canonical fit
    resumeContentHash: string | null;
    jobContentHash: string;                // new: title + requirements + skills
    searchProfileVersion: number | null;   // logistics only
  };
  version: { rubric: 'fit_v4'; estimator: 'est_v2'; model: string | null; prompt: string | null };
  scoredAt: string;
}

export function getFit(userId: string, jobId: string, opts?: { allowModelCall?: boolean }): Promise<Fit>;
export function getFits(userId: string, jobIds: string[]): Promise<Map<string, Fit>>; // never calls a model
export function getVariantFit(userId: string, jobId: string, variantId: string): Promise<Fit>; // tailoring only
```

**Invariants (each becomes a test in C9).**

| # | Invariant |
|---|---|
| I1 | Feed card, job detail, Similar jobs, alerts, Ready list, Assistant, extension and kit return the same `score`, `tier` and `kind` for the same (user, job) at the same time. |
| I2 | Precedence is fixed: a fresh AI fit beats an estimate everywhere. No surface is "estimate only". |
| I3 | The fit does not change when filter chips change. Only resume content, profile facts, the job's content, the rubric version, or the user's logistics answers change it; a logistics change moves the logistics dimension only. |
| I4 | A job whose posting backs less than 60% of the rubric weight cannot be `great`, and its confidence is `low`. |
| I5 | A displayed tier changes only when the new score crosses the threshold by at least 3 points (hysteresis), or when inputs changed. |
| I6 | Stored snapshots (alert emails, notifications, kit "before") carry `kind`, `version` and `scoredAt`; in-app views re-read the live fit. |
| I7 | A model or prompt change is a version bump with a planned backfill, never a silent cache miss. Old rows keep serving until replaced. |
| I8 | On GoApply without AI consent, `getFit` never calls a model and returns the estimate with its reason (existing rule, unchanged). |

**Storage.** Reuse `RAJobMatchScore`: the canonical row is the one for the primary variant. Add `jobContentHash` and `rubricVersion` columns (additive). Estimates are not persisted; they are cheap and deterministic, and I1 holds because every surface calls the same function with the same inputs.

**Consumer changes.** `alerts/service.ts`, `jobs/detail/service.ts` (Similar), `agent/deps.ts` (`fitsFor`), `onboarding/match.ts`, `extension/defaultDeps.ts` switch from `preScoreMany` to `getFits`. `copilot/tools/jobs.ts` `analyze_fit` drops `resumeVariantId: ctx.resumeId` unless the user explicitly asked about a version. `TailorService` shows the canonical fit as "Your fit" and the variant fit as "With this version".

### 4.4 C2 — estimate v2

The estimate must answer the same question as the AI score, with less information, and say how sure it is.

1. **User level from evidence.** Derive `userLevel` from the resume and profile (`yearsExperience`, the level words in the two most recent titles, people-management signals) with the same six-level scale. The Level chips filter the list and nothing else. With no resume, use the onboarding answer and mark confidence `low`.
2. **Graded role similarity.** Compare the job's role with the user's **recent and target roles**, not with "is inside the filter": same role 1.0, same group 0.6, same category 0.3 (existing), blended with title-embedding cosine once C7 exists. This spreads scores inside a filtered list.
3. **Hard skills, canonical ids.** Numerator and denominator use `kind = 'hard'` canonical skills, required skills weighted 1 and preferred 0.5 (the same rule the AI prompt states). Soft skills are shown, never scored.
4. **Shrink, do not renormalize.** A not-stated dimension contributes its **prior** (the long-run mean of that component over AI scores for the market) with its full weight. Starting priors from the 202 stored rows: title_level 44, skills 39, industry 24, career_path 45. Re-estimate monthly per market. A job that lists no skills then scores at most `35·T + 30·39 + 15·24 + 10·L + 10·45` over 100: with a perfect title and logistics that is 65, never 100.
5. **Logistics cannot add what the filter guaranteed.** Keep the 10 points in the rubric, and keep `not_met` as a real penalty. When every logistics check is `met` only because the saved search made it a hard filter, it contributes the prior, not 100. (This keeps the rubric the owner approved; it removes the free 10 points.)
6. **Coverage and confidence.** `coverage` = weight of dimensions with stated evidence on both sides ÷ 100. `high` ≥ 0.75, `medium` 0.5–0.75, `low` below. Cards show the tier with "Quick estimate" as today, plus one plain reason at low confidence ("This post lists no skills").
7. **Calibrate to the AI scale.** Fit a monotone map (isotonic regression) from estimate to AI score on all (estimate, AI) pairs per market, refreshed weekly by a cron; the estimate shown and ranked is the mapped value. Until 500 pairs exist, the priors in point 4 do most of this work.

### 4.5 C3 — role taxonomy precision

1. Mark discipline-ambiguous one-word phrases (`architect`, `designer`, `developer`, `engineer`, `analyst`, `consultant`, `manager`, `specialist`, `technician`, and Chinese equivalents such as 设计师, 工程师, 顾问, 专员) as **head nouns**. A head noun alone matches only when it is the whole title after level words are removed. Otherwise the modifiers decide: "Java Backend Architect" must match on `software_architect` through added synonyms and a modifier lexicon (java, backend, cloud, data, ai, ml, security, solutions, enterprise, 后端, 云, 数据).
2. Store the deterministic match score. In `reconcile.ts`, let the enrichment model choose among the candidates (which include the deterministic pick) whenever that score is below 0.9; keep deterministic-wins only for exact matches.
3. Add the three nearest role nodes by title embedding to the candidate list (C7), so the model always sees a plausible alternative.
4. Backfill: re-match every live row whose stored match score is below 0.9; log changes.
5. Test set: 300 labelled titles per market (include every head noun in several disciplines); gate at 95% precision at the category level.

### 4.6 C4 — canonical skills and an honest keyword check

**Table.** `RASkill(id, kind 'hard'|'soft', labelEn, labelZh, labelZhHant, aliases text[], esco, lightcast, embedding)`. Seed it from our own data first: cluster the 7,397 distinct enrichment strings by embedding and string similarity, have a model name each cluster and propose aliases, and review the top 1,000 by frequency by hand. Then attach ESCO and O*NET ids where a label matches. Chinese and Traditional Chinese labels and aliases come from GoHire bank postings and from model-proposed pairs (机器学习 ↔ machine learning ↔ 機器學習), reviewed for the top terms.

**Write path.** Enrichment maps each extracted skill to a canonical id (exact alias, then embedding neighbour above a strict threshold, else a new "unreviewed" skill that is shown but not scored). `RAJob.skillsDetail` gains `skillId`; `RAJob.skills` keeps display strings for the GIN filter; a new `skillIds text[]` column with a GIN index serves filters and affinity. Resume parsing maps the same way.

**Keyword check with three states.**

| State | Rule | Shown as |
|---|---|---|
| Shown | Canonical id match, or an alias appears as a whole word in the resume | "Your resume shows it", with the quote |
| Related | A closely related skill is shown (same parent, or embedding neighbour above threshold), e.g. PostgreSQL for "relational databases" | "Related: your resume shows PostgreSQL" — the user decides whether to add the exact term |
| Not shown | Neither | "Not in your resume" |

Only hard skills and concrete terms (tools, certifications, methods) enter the check. Generic words ("software engineering", "communication") and TF-IDF phrases without a canonical id are dropped at the source (`enrich/keywords.ts`), with Chinese and generic stop lists as the verification finding asked. Chips are de-duplicated by id and rendered with the canonical casing.

### 4.7 C5 — ranking input

- `fitForRank` = AI score when fresh, else the **calibrated** estimate (C2 point 7). Delete the `−5`.
- Until calibration exists (fewer than 500 pairs in a market), rank every row on one scale: the v2 estimate, plus `0.5 × (ai − estimate)` for rows that have an AI score. This removes the cliff between scored and unscored rows.
- Fit-tier view (`passesTier`): unscored rows no longer pass a "Good or better" view by default at `low` confidence.
- Update `/help/ranking` copy to match (all locales, copy gate).

### 4.8 C6 — scorer v4

**Shape.** The model fills a checklist; the server computes the components.

```jsonc
{
  "requirements": [
    { "id": "r1", "kind": "skill|experience|education|domain|scope",
      "text": "5+ years building backend services",       // verbatim from the post
      "importance": "must|preferred",
      "status": "met|partly|not_shown|not_applicable",
      "evidence": "Led the rewrite of the billing API …"  // verbatim from the resume, or ""
    }
  ],
  "level": { "post": "senior", "resume": "senior", "direction": "match|post_higher|post_lower" },
  "domain": { "status": "direct|adjacent|unrelated|not_stated", "evidence": "…" },
  "trajectory": { "status": "toward|neutral|away|no_history", "evidence": "…" },
  "strengths": [], "gaps": [], "summary": ""
}
```

- **Anchors, not free numbers.** `met` = 1, `partly` = 0.5, `not_shown` = 0. Skills component = weighted share of requirement points (must ×1, preferred ×0.5). Level: match 100, one level apart 60, two 25, more 0. Domain: direct 100, adjacent 60, unrelated 20. Trajectory: toward 100, neutral 60, away 25. Three to four levels per judgment follows the reliability evidence in 2.4.
- **Extract requirements once per job.** The `requirements[]` list (text, kind, importance) is a property of the posting. Produce it in enrichment and store it on the job; the per-user call only fills `status` and `evidence`. Every user is then judged against the same checklist, which removes one source of variance and shortens the per-user output.
- **Prompt order for caching.** System rubric, then the candidate's resume and profile, then the job. The first two are identical across the 25 jobs precomputed for one user, so provider prompt caching applies to the largest part of the input. Use the provider's batch interface for precompute where the model has one.
- **One pinned model per market**, recorded in `version.model`. Changing it is a planned migration (I7).
- **Freshness key** adds `jobContentHash`.
- **Borderline rule.** When the total lands within 3 points of a tier edge, the stored tier is the one on the same side as the estimate; no second model call. This implements I5 without extra cost.
- **Language.** The checklist statuses are enums, so the number is language-independent. Only `strengths`, `gaps` and `summary` are localized, and "regenerate the prose" never changes the score (already true today).

**Cost per score (inferred from prompt limits in the code).** Resume ≤ 8,000 characters, profile ≤ 3,000, posting ≤ 11,000, rubric about 700 tokens: roughly 4–6 thousand input tokens and under 1,000 output tokens. With resume-first caching, most of the input after the first job of a batch is cached. At the brand cap of 20,000 scores a day that is on the order of 100 million input tokens a day at worst; the per-user caps (25 precomputed, 80 on demand) are the real control and stay.

### 4.9 C7 — retrieval schema and hybrid retrieval

**Decision: embeddings live in side tables, not on `RAJob`.** Reasons: the Prisma model for `RAJob` stays untouched (vector types are `Unsupported` in Prisma and need raw SQL anyway); a row can be re-embedded with a new model without rewriting the 21 MB job table; each market can use a different model; dropping the feature is one `DROP TABLE`.

```sql
-- server/prisma/sql/001_vector.sql (run once per database, like 000_extensions.sql)
CREATE EXTENSION IF NOT EXISTS vector;            -- 0.8.6 on the Neon branch

CREATE TABLE "RAJobEmbedding" (
  "jobId"       text PRIMARY KEY REFERENCES "RAJob"("id") ON DELETE CASCADE,
  "market"      text NOT NULL,
  "model"       text NOT NULL,                    -- e.g. 'openai/text-embedding-3-small@1024'
  "contentHash" text NOT NULL,                    -- sha1 of the embedded card text
  "embedding"   halfvec(1024) NOT NULL,
  "embeddedAt"  timestamp(3) NOT NULL DEFAULT now()
);
CREATE INDEX "RAJobEmbedding_market_idx" ON "RAJobEmbedding" ("market");

CREATE TABLE "RAUserEmbedding" (
  "userId"      text NOT NULL,
  "market"      text NOT NULL,
  "kind"        text NOT NULL,                    -- 'intent' (onboarding/search) | 'resume' (primary resume)
  "model"       text NOT NULL,
  "sourceHash"  text NOT NULL,
  "embedding"   halfvec(1024) NOT NULL,
  "updatedAt"   timestamp(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "market", "kind")
);

-- Add later, only when a market passes ~200k live rows:
-- CREATE INDEX … ON "RAJobEmbedding" USING hnsw ("embedding" halfvec_cosine_ops)
--   WITH (m = 16, ef_construction = 64) WHERE "market" = 'intl';
```

- **1024 dimensions, half precision.** Every candidate model can output 1024 (native or shortened). A `halfvec(1024)` is about 2 KB per row: 100,000 jobs ≈ 0.2 GB, 1,000,000 ≈ 2 GB, before any index.
- **No approximate index at first.** The vector leg runs under the same hard-filter `WHERE` as today and orders the surviving rows by exact distance. At tens of thousands of rows per market this is a sequential distance computation over a filtered set, with no filtered-ANN recall problem. Add partial HNSW indexes per market with `hnsw.iterative_scan = relaxed_order` when a market outgrows that.
- **What is embedded for a job** (the "card text", at most about 500 tokens): title; role labels (`en` and `zh`); level; canonical required skills, then preferred; the two-sentence enrichment summary; the first 1,200 characters of requirements. Not the company boilerplate, benefits or legal text.
- **What is embedded for a user:** `intent` = target titles and roles, level, top skills, industries and the free-text goal from onboarding (exists before any resume: the cold-start vector); `resume` = the last two titles with their bullet text, canonical skills, summary. Query-side instruction or input type is set where the model supports it.
- **Lexical document.** Add `RAJob.searchDoc text` (title, role labels in both scripts, canonical skill labels and aliases, summary, requirements head; CJK segmented in the application with `Intl.Segmenter`, Traditional folded to Simplified for the token copy) and a generated `searchTsv tsvector` using the `simple` configuration, with a GIN index. Keep `searchText` and its trigram index for typeahead. On Neon, a `lakebase_bm25` index on `searchTsv` is an optional upgrade from `ts_rank_cd` to BM25; the design does not depend on it.
- **Other additive columns:** `RAJob.skillIds text[]` (GIN), `RAJob.contentHash text`, `RAJob.titleMatchScore real`, `RAJob.lang text`.

**Retrieval (three legs, same scope and filter predicates, fused by reciprocal rank with k = 60).**

| Leg | Query | Size | Purpose |
|---|---|---|---|
| A. Recency | Today's statement: newest first within the window | 200 | Freshness; guarantees new posts are seen |
| B. Lexical | `searchTsv @@ query` ranked by `ts_rank_cd` (or BM25), where the query is the typed `q`, or the user's target titles and top skills when `q` is empty; trigram fallback for short or misspelled input | 200 | Exact terms: tools, certifications, company names |
| C. Dense | `JOIN "RAJobEmbedding"`, `ORDER BY embedding <=> $userVector` (resume vector, else intent vector; the query vector when `q` or free text is present) | 200 | Meaning: synonyms, adjacent titles, cross-language |

Union (≤ 600 rows, typically 250–400 after overlap) → estimate v2 on all → rank as today (fit, freshness, affinity, source quality) with the fused retrieval rank as a tie-breaker and as the precompute pick order → session. `FEED_LIMITS.retrievalLimit` stays 400 as the cap on the union. GoApply users without 个性化推荐 get legs A and B with their typed query only: no profile vector, no fit, exactly as the current rule requires.

**Write path.** A new work kind `job.embed` queued after `job.enrich` (dedupe key `job.embed:<id>:<contentHash>:<model>`); `user.embed` queued when the primary resume hash or the search profile's role fields change. Both use the existing queue and budgets. Cost for 100,000 jobs at 500 tokens: 50 million tokens, about $1 at $0.02/M or ¥25 at ¥0.5/M.

**Similar jobs** becomes "nearest 50 by job vector within the same market and country, minus hidden and flagged, re-ordered by `getFits`".

### 4.10 C8 — natural-language search

1. Keep the planner and its rule that only supported constraints become filters.
2. Residual text no longer stops at "unmatched". It becomes the query for legs B and C, and the response says so in plain words: "Ranked by closeness to: climate startups, Rust. These were not checked as requirements." This is honest (D3) and useful.
3. The Assistant's `search_jobs` passes `q` through the same path, so it inherits hybrid retrieval. Tools include the user's own imported jobs. The job-list card renders exactly the ids the model cites.
4. The legacy `job-search/agent.ts` live fan-out to RapidAPI stays for the public API product and for on-demand ingest of a query the index has never seen (results are ingested, then searched through the same pipeline; they are not ranked in a separate code path).

### 4.11 C10–C11 — feed ranking and learning

| Topic | Change |
|---|---|
| Freshness | `100 × (0.7·e^(−h/48) + 0.3·e^(−h/336))`: steep for two days, a slow tail over two weeks, so a 10-day-old job still outranks a 40-day-old one. Use the smaller of posting age and "days since last seen live" when a provider stops listing a job. Fix the constant's name. |
| Same role, several cities | Collapse rows with the same normalized company and title into one card with "also in N locations" (23 groups / 53 jobs in today's index). |
| Exploration | One slot in every ten on Recommended is drawn from candidates ranked 30–100 whose role or company the user has no affinity for yet. Published on `/help/ranking`. It is how affinity learns for new users. |
| Negative feedback by title | "Not interested: wrong title" adds a negative weight on the role id and on the normalized title cluster, applied in Recommended and in the Ready weekly selection. |
| Seen and skipped | A job shown in the first screen on three sessions and never opened loses up to 10 rank points. Uses the existing impression log. |
| Reranker | For free-text queries only: a cross-encoder reranks the top 100 of the fused list by query–job relevance before the fit ranking. Not used for resume–job fit; the scorer does that with evidence. |
| Learned weights | When a market has about 5,000 positive interactions, fit the four factor weights by logistic regression on (impression → save or apply). Keep the published-factor model; only the weights move, and the page shows the current values. |

---

## 5. Per-market specifics

Both brands run the same pipeline, the same contract and the same invariants (D5). The differences are providers and language handling. Vectors never cross markets, because every statement filters on `market`, so the two brands can use different embedding models without any compatibility concern.

| Topic | RoboApply (international, Taiwan) | GoApply (mainland) |
|---|---|---|
| Database | Neon PostgreSQL 18.6; `vector` 0.8.6 available (confirmed). | Same code. If the mainland deployment moves to a domestic Postgres, verify `vector` and `pg_trgm` there before CN-1; the design needs no other extension. |
| Embedding model | Shared default `EMBED_MODEL`. Start with OpenAI `text-embedding-3-small` at 1024 (key present, lowest cost) as the baseline, and let the harness decide against `text-embedding-3-large`, Gemini embedding and `voyage-4` on the multilingual and Traditional Chinese sets. | Optional override `CN_EMBED_MODEL` (D5: when absent, fall back to the shared default). Recommended override: Alibaba `text-embedding-v4`, Beijing region, ¥0.5/M, 1024 dims, so resume and profile text is processed in the mainland. Alternatives: 智谱 `embedding-3`; `bge-m3` self-hosted. Which processor is acceptable is a consent and residency decision already tracked in CN_TW_LAUNCH_PLAN. |
| Reranker (C11) | Cohere Rerank 4 or Voyage `rerank-2.5`. | `qwen3-rerank` or `bge-reranker-v2-m3`. |
| Scorer model | One pinned `LLM_MATCHING_MODEL`. | Optional `CN_LLM_*` override; otherwise the shared model. The score cache already holds rows from two models; under I7 a brand has one pinned scorer version at a time. |
| Lexical tokenization | Latin: `simple` configuration plus an English-stemmed copy. Traditional Chinese and Japanese postings: application-side segmentation; Traditional folded to Simplified in the token copy (`normalize/zhVariants.ts` already folds titles). | Application-side segmentation (`Intl.Segmenter('zh')`), bigram fallback for unknown words. `pg_trgm` remains the fuzzy fallback; it works on Chinese on this database. |
| Role taxonomy | Current 307 nodes; `soc` crosswalk; add ESCO or ISCO codes. Taiwan: add 繁體 labels and Taiwan title vocabulary (工程師, 專員, 儲備幹部); keep the Taiwan salary rule TW-03. | Same nodes with `zh` labels; add mainland-specific roles and aliases (运营 families, 新媒体, 管培生, 销售代表 variants, 事业单位 or 国企 tracks as employer tags, not roles). Learn aliases from GoHire bank titles. Optional 大典 code for reporting. Do not copy BOSS or 智联 trees. |
| Skills | English canonical labels; ESCO and O*NET ids where they match. | Same ids with Chinese labels and aliases; certificates common in Chinese postings (CPA, 教师资格证, 一建, CET-6, 普通话等级) as first-class "certification" skills. |
| Requirements specific to the market | Visa sponsorship, citizenship, clearance (exists). | 届别, 学历, 校招 or 社招, 实习天数, 薪资月数 (exist as tags). The scorer treats 届别 and 学历 as eligibility inside title_level (exists). School tier stays a user-side filter and never an input. |
| Pay comparison | Annualized, same currency only (exists). Add a plausibility bound per currency and period. | Monthly × `salaryMonths`; display exactly as posted (`18-28K·15薪`); daily pay for internships (exists). |
| Cross-language cases | English resume ↔ Chinese or Japanese posting, and the reverse, are common for Taiwan and for foreign firms. Dense leg and the scorer handle them; canonical skill ids make the keyword check cross-language; Latin tool names match lexically in any script. | Chinese resume ↔ Chinese posting is the main case. English resume ↔ Chinese posting (returnees, foreign firms) works the same way. Evidence quotes stay in their source language; prose follows the UI locale. |
| Sources and search APIs | Covered in the sibling market documents. For this pipeline: every provider row passes the same normalize → enrich → embed path; provider-supplied skills and level fields are mapped to canonical ids first, and the model fills only what is missing. | Same. Today there are zero mainland rows in the index; nothing about GoApply relevance is validated until a real corpus (GoHire bank plus user imports) is loaded. The harness in section 6 must run on that corpus before GoApply shows fit publicly. |
| Personalization consent | Not applicable. | Without 个性化推荐: legs A and B only, no user vector, no fit. Without "Use AI": estimate only, no model call. Both rules exist and must stay in `getFit` and in retrieval. |

---

## 6. Evaluation harness

Nothing in section 4 ships on opinion. Each change is accepted by numbers on a fixed set, and the verification bugs become permanent tests.

### 6.1 Offline relevance set

| Element | Design |
|---|---|
| Profiles | 40 per market: test personas (role, level, skills, location, pay, visa or 届别) with a resume each. Cover the top 15 role groups, three levels, career changers, new graduates, and for RoboApply at least 8 Traditional Chinese and 4 cross-language cases. These are fixtures and never shown to users. |
| Candidate pool | For each profile, the union of the top 50 from every retrieval variant under test (pooling), from a frozen snapshot of the real index. |
| Labels | Graded 0–3 (not relevant, related, good match, excellent match) by an LLM judge with a fixed UMBRELA-style prompt and a stronger model than the production scorer. |
| Human audit | 10% of labels re-judged by people who recruit for a living. We have them: RoboHire and GoHire recruiters. Track judge–human agreement (quadratic-weighted kappa); below 0.6, fix the judge prompt before trusting any metric. |
| Storage | Labels, embeddings and judge outputs are cached in the repository's test fixtures so CI runs without network. |

### 6.2 Metrics and gates

| Layer | Metric | Gate to ship |
|---|---|---|
| Retrieval | Recall@200 of label ≥ 2 jobs against the pool | Hybrid ≥ recency-only + 15 points; no profile below its baseline by more than 5 |
| Ranking | NDCG@10 and NDCG@20 on Recommended | No regression; target +10% relative for C2 and C7 |
| Estimate vs AI | Tier agreement (weighted kappa); mean AI score per estimate decile (reliability curve); share of "estimate Great, AI below Possible" | Kappa ≥ 0.5; the last share under 5% |
| Scorer stability | Three runs on 100 pairs: intraclass correlation; tier flip rate | ICC ≥ 0.85; flips under 5% |
| Scorer validity | Spearman correlation with human grades on the audited pairs | ≥ 0.6, and not below the current scorer |
| Taxonomy | Category-level precision on 300 labelled titles per market | ≥ 95%; every head-noun case correct |
| Skills | Precision and recall of shown / related / not shown against 100 hand-labelled resume–job pairs | Precision of "not shown" ≥ 95% (we must not tell users they lack what they have) |
| Language | The same metrics on the Traditional Chinese, Simplified Chinese and cross-language subsets | Within 10% relative of the English subset |
| Cost and latency | Tokens per score, embedding tokens per job, feed p95 | Feed p95 no worse than today plus 150 ms |

### 6.3 Invariant tests (from the verification findings)

1. A job with no listed skills and no stated level cannot be `great`; its confidence is `low`.
2. Changing `filters.seniority` does not change any fit.
3. `getFit` equals the value served by the feed, detail, Similar, alerts, Ready, Assistant and extension endpoints for the same user and job (one contract test that calls every seam).
4. A senior resume against an internship is at most `possible`.
5. "Java Backend Architect", "Lead AI Architect" and "Principal Architect - Machine Learning" are not in Design; "Landscape Architect" is.
6. A location entry with a country and no city filters by country.
7. The keyword check reports PostgreSQL as related evidence for "relational databases" and never lists the same skill twice.
8. An AI-scored job never ranks below an unscored job solely because it was scored (pairwise test on the ranking function with equal true quality).
9. A pay value outside the plausible range for its period is not sorted as pay.
10. On GoApply without AI consent, zero model calls are made by `getFit`, retrieval or precompute.

### 6.4 Online measures (after launch)

Save rate and apply-click rate in the top 10; hide rate; share of "Not interested: wrong title / wrong level"; the daily feed rating; share of top-10 cards whose AI score is below Possible (guardrail); estimate-to-AI gap on jobs users open (drift monitor for the calibration map); zero-result rate for free-text search. Each with at least 200 exposures per arm before any conclusion; small-sample numbers are not published (D3).

### 6.5 Commands

- `npm run eval:match` — fixture-only, no network, runs in CI with the invariants.
- `npm run eval:match -- --live` — nightly, re-embeds and re-judges against the current index and writes a dated report.
- A model or prompt change must attach both reports to its change request.

---

## 7. Rollout order

| Step | Content | Depends on | Schema |
|---|---|---|---|
| 1 | C9 fixtures and invariant tests written first, failing | — | none |
| 2 | C3 taxonomy fix and backfill; pay plausibility bound; location fix (G2/G3) | — | `titleMatchScore` (additive) |
| 3 | C2 estimate v2 with priors, coverage, evidence-based level; C5 ranking input | step 1 | none |
| 4 | C1 `getFit` and migration of every consumer | step 3 | `jobContentHash`, `rubricVersion` on `RAJobMatchScore` (additive) |
| 5 | C4 canonical skills; three-state keyword check | — | `RASkill`, `RAJob.skillIds` (additive) |
| 6 | C7 embeddings, `searchDoc`, hybrid retrieval; Similar jobs on vectors | step 5 for card text | `vector` extension; two side tables; `searchDoc`, `searchTsv`, `contentHash`, `lang` (additive) |
| 7 | C6 scorer v4 with job-level requirement extraction; calibration cron | steps 4, 5 | `RAJob.requirements` JSON (additive) |
| 8 | C8 natural-language relevance leg; C10 ranking refinements | step 6 | none |
| 9 | C11 reranker and learned weights | interaction volume | none |

Steps 1–4 fix every honesty finding without any new vendor, extension or credential. Every schema item is additive and goes through the usual diff-and-confirm push to the Neon branch first.

---

## 8. Decisions needed from the owner

1. **Logistics in the number.** Keep the approved 35/30/15/10/10 rubric, with the rule that a logistics check satisfied only by the user's own hard filter contributes the prior instead of 100 (recommended), or move logistics out of the number entirely and show it as separate checks.
2. **Embedding processors.** Confirm OpenAI as the embedding processor for RoboApply resumes and profiles, and whether GoApply should use a mainland provider (recommended: Alibaba `text-embedding-v4`, Beijing) or the shared default until a mainland credential exists.
3. **`vector` extension** on the Neon branch and then on the main database (one `CREATE EXTENSION`, same procedure as `pg_trgm`).
4. **Human audit time** from RoboHire and GoHire recruiters: about 400 pair judgments per market for the first calibration, then about 100 a quarter.
5. **Exploration slot** in Recommended (one in ten), disclosed on `/help/ranking`.
6. **Skill vocabulary sources.** Approve seeding from ESCO and O*NET, and decide whether Lightcast Open Skills may be used as an alias reference under its licence.

---

## 9. Sources

Primary and measured:
- Our code: `server/src/features/{jobs,feed,match,copilot}/**`, `server/src/job-search/**`, `server/src/roboapply/v2/agents/RAJobMatchScorerAgent.ts`, `server/prisma/schema/ra-jobs.prisma`, `ra-match.prisma`; `docs/jobright-clone/ARCHITECTURE.md` §4; `docs/jobright-clone/orch/verify-results.json`.
- Read-only census of the clone's Neon branch, 2026-10-11 (section 3.1 and the hosting table in 2.3).
- Neon: [pg_search status](https://neon.com/docs/extensions/pg_search), [lakebase_text](https://neon.com/docs/extensions/lakebase-text), [lakebase_tokenizer](https://neon.com/docs/extensions/lakebase-tokenizer), [migration guide](https://neon.com/docs/extensions/migrate-pg-search-to-lakebase-text).
- Alibaba 百炼: [text-embedding-v4](https://docs.bailian.console.aliyun.com/zh/model-studio/text-embedding-v4), [pricing](https://help.aliyun.com/zh/model-studio/model-pricing), [embedding and rerank](https://help.aliyun.com/zh/model-studio/embedding-rerank-model/). 智谱: [embedding-3](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3). 阿里云 RDS: [extensions](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/extensions-supported-by-apsaradb-rds-for-postgresql).
- LinkedIn: [arXiv 2602.07309](https://arxiv.org/html/2602.07309v1), [arXiv 2510.22101](https://arxiv.org/html/2510.22101v1), [arXiv 2512.07846](https://arxiv.org/html/2512.07846v2), [arXiv 2509.09690](https://ar5iv.labs.arxiv.org/html/2509.09690), [skills extraction](https://engineering.linkedin.com/blog/2023/extracting-skills-from-content-to-fuel-the-linkedin-skills-graph).
- Person–job fit: [arXiv 1810.04040](https://arxiv.org/abs/1810.04040), [arXiv 1812.08947](https://arxiv.org/pdf/1812.08947), [arXiv 2206.09116](https://arxiv.org/pdf/2206.09116).
- LLM scoring and judging: [NAACL Findings 2025.270](https://aclanthology.org/2025.findings-naacl.270.pdf), [NAACL Industry 2025.55](https://aclanthology.org/2025.naacl-industry.55/), [arXiv 2606.13685](https://arxiv.org/pdf/2606.13685), [arXiv 2603.00077](https://arxiv.org/html/2603.00077v1), [arXiv 2602.02219](https://arxiv.org/html/2602.02219v2), [arXiv 2610.02492](https://arxiv.org/html/2610.02492), [UMBRELA](https://arxiv.org/abs/2406.06519), [TREC 2024 RAG study](https://www.arxiv.org/pdf/2411.08275).
- pgvector and hybrid search: [AWS on 0.8.0](https://aws.amazon.com/blogs/database/supercharging-vector-search-performance-and-relevance-with-pgvector-0-8-0-on-amazon-aurora-postgresql), [iterative scans](https://docs.pgedge.com/pgvector/v0-8-5/iterative-index-scans/), [ParadeDB hybrid manual](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual).
- Taxonomies: [ESCO v1.2 launch](https://esco.ec.europa.eu/system/files/2024-05/V1.2%20Launch%20-%20ESCO%20SEC%20combined%20-%20final%20clean.pdf), [ESCO–O*NET crosswalk](https://esco.ec.europa.eu/en/about-esco/publications/publication/crosswalk-between-esco-and-onet-technical-report), [Lightcast Open Skills](https://lightcast.io/open-skills), [职业分类大典 2022](https://www.chinanews.com.cn/cj/2022/09-28/9862314.shtml), [新职业 2025](https://www.chinanews.com/sh/2025/09-26/10489684.shtml), [Taiwan 職業標準分類](https://statdb.mol.gov.tw/html/svy12/0.%E8%81%B7%E6%A5%AD%E6%A8%99%E6%BA%96%E5%88%86%E9%A1%9E%E9%9B%BB%E5%AD%90%E6%9B%B8.pdf).

Secondary (prices and benchmark tables; verify on vendor pages before budgeting): [layer3labs](https://www.layer3labs.io/guides/openai-embedding-models-pricing), [costgoat](https://costgoat.com/pricing/openai-embeddings), [tokencost](https://tokencost.app/embeddings), [Voyage docs](https://docs.voyageai.com/docs/embeddings), [Qwen3-Embedding card](https://huggingface.co/Qwen/Qwen3-Embedding-4B), [SiliconFlow pricing](https://www.siliconflow.cn/pricing), [OpenRouter Cohere Rerank 4](https://openrouter.ai/cohere/rerank-4-pro), [OpenRouter Voyage rerank-2.5](https://openrouter.ai/voyageai/rerank-2.5), [Indeed case study](https://openai.com/index/indeed/).

**Staleness notes.** Embedding and reranker prices change often and several figures come from aggregators. The Qwen3 benchmark scores are a mid-2025 snapshot. The Neon extension facts are as of October 2026. The database numbers describe the clone branch on 2026-10-11, which holds verification test data, not production traffic.
