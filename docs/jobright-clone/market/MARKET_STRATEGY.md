# Market strategy: job sources, matching, pricing and payments per market

**Date:** 2026-10-11. **Branch:** `feat/jobright-clone` @ `aee60e6`. **Status:** the decisive specification that follows from D5 and D6 (`docs/jobright-clone/README.md`). It synthesises the seven research notes in this folder and settles every point where they disagree.

**Inputs (all read in full):** `JOB_SOURCES_INTL.md`, `JOB_SOURCES_TW.md`, `JOB_SOURCES_CN.md`, `SEARCH_RETRIEVE_MATCH.md`, `PRICING_INTL.md`, `PRICING_CN.md`, `PAYMENTS_AUDIT.md`. Each claim below is traceable to one of them (cited as INTL, TW, CN, MATCH, P-INTL, P-CN, PAY with a section number); the primary URLs are in those notes. Facts I re-checked in code today are marked *(re-checked)*.

**Relation to `GOAPPLY_PARITY_PLAN.md`** (written the same day from the D5 audits). That plan owns capability defaults and provider fallbacks; this file owns sources, matching, prices and rails (D6). They agree on almost everything. This file adopts the parity plan's rulings on the recruitment-info mode default (`licensed`), the payments kill switch, the collecting entity and the required callback secret, and **overrides it on four points**, each explained in §8: JSearch is not a GoApply source; `linkedin` leaves RoboApply's provider list; GoApply student passes get default prices; a staleness cut-off must not apply to employer-board or bank rows. `planCatalog.ts` is owned by the parity plan's bundle PAR-6: requirement PC-1 builds on it or is folded into it.

**Precedence.** D1 (never submit an application), D3 (never fabricate data), D5 (same capability on both brands), D6 (per-market sources, prices and rails; Alipay keeps working exactly as it does; Stripe implemented fully). Where this document changes an earlier number or default in `PRODUCT_PLAN.md`, `TASK_PLAN.md` or `CN_TW_LAUNCH_PLAN.md`, this document wins and requirement OT-1 updates those files.

**Not legal or tax advice.** Section 7 lists what counsel, a tax adviser or the owner must settle. Nothing in the build waits on them unless a requirement says so.

---

## 0. Decisions

| # | Decision | Why (source) |
|---|---|---|
| M-1 | **International backbone = public ATS job boards we read ourselves** (Greenhouse, Lever incl. EU, Ashby, SmartRecruiters; then Workable, Recruitee, Personio), bulk-seeded and auto-discovered. Free, employer-direct, exact dates, real closure. | INTL §1, §4.4, §5 |
| M-2 | **One licensed feed for ATSs with no public API: Fantastic.jobs Active Jobs DB**, used as an hourly window sync with the vendor's expired feed, never as title-by-city search. The feed sync turns itself on only when the plan's monthly job quota is at least 20,000. Until the owner buys a plan the pipeline runs without it. TheirStack is the alternative only if public SEO job pages become a launch requirement. | INTL §4.1, §6.2 |
| M-3 | **JSearch is demand-only long tail** (a signed-in user's own role × city), never SEO seeds, never the feed base, never public pages. Rows whose only link is LinkedIn or Indeed are not ingested. | INTL §3.1, §6.3 |
| M-4 | **The LinkedIn feed is dropped.** Do not subscribe; remove `linkedin` from RoboApply's `jobProviders`. The TW note asked to subscribe it; the INTL and CN notes say no. No wins: our own display rule already strips LinkedIn names and links, LinkedIn's terms reach third-party scraped data, and the ATS feed carries the employer-direct copy of most of those jobs. | INTL §4.1, §4.7; TW §3.4; CN §4.3 |
| M-5 | **Taiwan = 台灣就業通 open data (OGDL v1) + JSearch queried in Traditional Chinese + seeded ATS boards.** The licence is confirmed by reading it; the adapter ships on by default. Commercial boards (104, 1111, 518, yes123, Cake, Yourator, Meet.jobs) are partnership-only and never fetched. | TW §1, §3 |
| M-6 | **Mainland = ingest first, search our own index.** Sources in order: user import and deep links (9 boards), `ats_public` rows located in mainland China (seeded now), GoHire bank over HTTPS (the interim list reader today, a syndication endpoint next: fix B), Active Jobs DB with `location=China` once a paid plan exists, 北森 boards behind a flag after counsel. **JSearch is not a GoApply source** (this overrides the parity plan's §3.9 row; §8). No mainland board is ever scraped. | CN §1, §3, §6 |
| M-7 | **The GoApply job feed is on by default.** `CN_RECRUITMENT_INFO_MODE` unset resolves to `licensed` (the parity plan's ruling; the CN note proposed `partner_deeplink`, which differs only in forcing every apply through the partner page). Each row opens its own apply link: a bank job opens the GoHire page, a board job opens the employer's page. Every non-GoHire posting shows 来源, the original link and 最后核验. `off` remains the kill switch. | CN §2.1, §5.2; parity §3.2 |
| M-8 | **One fit per (user, job), computed against the primary resume, served by one function `getFit` to every surface.** Estimate v2 replaces renormalisation with per-market priors and never reads filter chips. Ranking never mixes two score scales. Logistics stays inside the approved 35/30/15/10/10 rubric; a check satisfied only by the user's own hard filter contributes the prior, not 100. | MATCH §4.3–4.7, §8.1 |
| M-9 | **Evaluation harness and invariant tests are written before the matching fixes**, and gate every later change. | MATCH §6, §7 |
| M-10 | **Embeddings live in side tables; retrieval becomes recency + lexical + dense fused by reciprocal rank.** Default embedding model for both brands: OpenAI `text-embedding-3-small` at 1024 dimensions; `CN_EMBED_MODEL` is an optional override (recommended: Alibaba `text-embedding-v4`, Beijing). Chinese is segmented in the application with `Intl.Segmenter`. | MATCH §4.9, §5 |
| M-11 | **RoboApply prices (USD):** weekly $9.99, monthly $24.99, **quarterly $54.99** (was $59.99), **7-day pass $9.99** (was $6.99), packs $9.99 / $24.99, student $17.49 / $37.99. Reasons for the two changes in §4.1. | P-INTL §5 |
| M-12 | **GoApply prices (CNY, whole yuan, non-renewing):** 周卡 ¥12, 月卡 ¥39, 季卡 ¥99, packs ¥29 / ¥79, **学生月卡 ¥29, 学生季卡 ¥69** (new keys, D5 parity). | P-CN §6 |
| M-13 | **Prices are catalog defaults in code.** Env values are overrides. No plan is ever `price_unset`. | D6; PAY §A6 G1, §B3 |
| M-14 | **Free `autofill` rises from 5 to 20 a day on both brands** (the INTL note asked for RoboApply only; D5 makes it both; a deterministic fill costs no model call). All other credit caps stay. | P-INTL §5.1; P-CN §7 |
| M-15 | **Stripe prices are real Products and Prices synced from the catalog by `lookup_key`**, created on first use, not Checkout `price_data`. Created with `tax_behavior: inclusive` so the number on `/pricing` is the number charged in every country. Tax collection stays off until `STRIPE_TAX_ENABLED=true`. | PAY §B3; P-INTL §7.5 |
| M-16 | **Plan changes stay in the app; the Stripe portal handles payment method, invoices, billing details and cancel.** Resume, refunds, disputes, SCA on renewals and lost-event recovery are implemented. | PAY §B4 |
| M-17 | **Alipay: the brand decides the rail (GoApply), the wire contract to the GoHire worker returns to production's shape, and the rail opens with one credential (the callback secret) instead of six gates.** Twelve "do not break" rules (§5.2) are frozen by tests before any other billing change. | PAY §A5, §A6 |
| M-18 | **A mainland visitor on roboapply.io gets a link to GoApply for RMB and Alipay**, not a cross-brand redirect and not a second Alipay path on RoboApply. The clone must not replace production on roboapply.io before goapply.top serves the Alipay flow. | PAY §A6 G11, §C1 |
| M-19 | **GoApply never auto-renews.** 连续包月 would need a second Alipay product and a notice before every deduction. WeChat Pay stays an optional second rail behind a chooser with Alipay first. | P-CN §5; PAY §A4 R13 |
| M-20 | **No launch offer, no PPP prices, no Stripe Adaptive Pricing.** Taiwan is charged in USD with a "約 NT$…" reference line; a real TWD list is V2. | P-INTL §6; P-CN §1 |

---

## 1. Job sources per market

### 1.1 What works today with the keys we have *(probes of 2026-10-11)*

| Provider | Key | State today | Used by |
|---|---|---|---|
| Public ATS boards (`ats_public`) | none needed | Works. Greenhouse returned 728 jobs with full text in one call; Ashby returned pay on 96% of 165 jobs. **No seed list exists**, so it reads almost nothing. | intl, TW, CN |
| JSearch `/search-v2` | `RAPID_API_KEY` | Works. 10,000 requests a month, about 9,770 left. | intl, TW |
| 台灣就業通 open data | none needed | Works from a non-Taiwan IP. At least 17,275 open vacancies. Adapter is a stub. | TW |
| RoboHire bank | `DATABASE_URL` family | Works. | intl |
| Active Jobs DB (Fantastic.jobs on RapidAPI) | `RAPID_API_KEY` | **Dead until about 2026-10-28.** Free BASIC plan: 25 requests and 250 jobs a month; HTTP 429. Ingest budgets assume 300 calls a day. | intl, TW, later CN |
| LinkedIn Job Search API | `RAPID_API_KEY` | HTTP 403, not subscribed. **Dropped (M-4).** | — |
| GoHire bank | `DATABASE_URL_GOHIRE` | **Off.** The endpoint has no TLS (answered `N` to a Postgres SSLRequest); our guard correctly refuses plaintext. | CN |
| JSearch `country=cn` | `RAPID_API_KEY` | Returns rows, but 60 of 60 had no apply link and no pay, and the publisher label misstates the source. **Not a source.** | — |
| USAJobs | none yet | Free key needed. | intl |

### 1.2 International (RoboApply; US, CA, UK, EU, AU, SG, remote)

| Tier | Source | Role | How it is queried | Cadence |
|---|---|---|---|---|
| 0 | `ats_public` | Backbone | No query. One listing call per board; classify role and country after fetch; diff ids to open and close. | Adaptive: boards that changed in the last 48 h every 2 h; quiet boards every 12–24 h; new boards immediately. 4–8 boards in flight; own cron entry. |
| 0 | `bank_robohire` | Exclusive recruiter jobs | Cursor on `updatedAt|id`. | Every 10 min (unchanged). |
| 1 | Fantastic.jobs `active-ats` (when the plan allows) | Workday, iCIMS, Oracle, SuccessFactors, ADP, UKG, Paylocity | Backfill once `time_frame=7d`, then `time_frame=1h&limit=1000` with offset paging; `location` = OR of full country names; `exclude_source` = every ATS we read directly; `description_format=text`. | Hourly new, hourly `expired-ats?time_frame=1h`, daily `1d` after 01:00 UTC, monthly `1m`. |
| 2 | JSearch | A user's own role × city when tiers 0–1 give too few | `query="{role} in {city}"`, `country`, `date_posted=3days` for hot tuples and `week` for cold; `work_from_home=true` for remote. No SEO seeds. | 6 h hot / 24 h cold, inside a monthly budget metered from response headers. |
| 3 | USAJobs (when a key exists) | US federal roles | `DatePosted=1` daily (`7` on first run), 500 per page. | Daily. |
| — | Arbeitnow, Jobicy, RemoteOK, Reed | Optional, each only after its terms are confirmed in writing | — | Later. |

**Company list for tier 0.** (1) Parse every ingested apply URL to `(ats, tenant)` and upsert a candidate `RACareerSiteSource` (`enabled=false`, `origin='discovered'`); enable it after one successful list-only read whose company name matches. (2) Bulk import (CSV/JSON) on the admin route. (3) A seed file of candidate tenants built from Common Crawl host patterns and the open-apply slug lists (slugs only, never its job dump), each validated against the live board before it is enabled. (4) Users' target companies and tracker entries.

**Until the licensed feed is bought** the feed is tiers 0, 2 and the bank. That is honest and it works; the feed header must not imply full-market coverage. The admin System panel shows each provider's plan, remaining quota and days to reset, so a dead source is visible the day it dies.

### 1.3 Taiwan (RoboApply, `zh-TW`, `market='intl'`, country `TW`)

| Source | Role | How it is queried | Cadence |
|---|---|---|---|
| `tw_open_data` (台灣就業通, dataset 44062, OGDL v1) | Breadth and disclosed pay for service, healthcare, manufacturing, operations (software is about 1% of rows) | `GET free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx`. No paging, 1,000-row cap: sweep `CITY` (22 codes); split capped counties by `zipno` (3-digit postal code); split capped districts by `jobno` 大類 (22 codes). | One sweep a day, sequential, with a pause and an identifying User-Agent. |
| JSearch `country=tw` | 104 / 1111 postings through Google's job index (the main white-collar window) | Two variants per demand tuple: `{zh-Hant role} {zh-Hant city}` with `language=zh-TW`, and one English variant. `date_posted=month` (a one-week non-tech query returned 0 rows). | 12 h. |
| `ats_public` with Taiwan postings | Multinationals and startups, mostly English | Board sync as §1.2. Seed the 14 boards confirmed live (coupang, ubiquiti, appier, binance, canonical, asteralabs, piccollage, stripe, shopback-2, BoschGroup, crypto, okx, dcard, kraken.com). | As §1.2. |
| Active Jobs DB | Workday / SuccessFactors employers in Taiwan | Covered by the same window sync once a plan exists; measure Taiwan volume before raising budgets. | As §1.2. |
| 事求人 (dataset 7229) | Public-sector vacancies | One XML file. Never store `VITAE_EMAIL` or `CONTACT_METHOD`. | Later. |

**Before the open-data adapter ships** the pay parser must stop reading `依學經歷、證照核薪(每月經常性薪資達4萬元以上)` as NT$40,000 a month (it does today; 8.4% of rows, 38% of IT rows). Pay comes only from numeric `NT_L` / `NT_U`. The floor-clause patterns become threshold-agnostic because the Ministry of Labor has announced a move to about NT$50,000 (not passed).

**Attribution** on every open-data row (the licence voids itself without it): `資料來源：勞動部勞動力發展署 {year}「台灣就業通網站職缺清單」，依政府資料開放授權條款第1版公開釋出`, linked to `https://data.gov.tw/license`. No 台灣就業通 logo.

### 1.4 Mainland China (GoApply)

No mainland source offers lawful keyword search over the market, so GoApply ingests feeds into `RAJob (market='cn')` and searches its own index.

| Tier | Source | Real jobs now? | What it needs |
|---|---|---|---|
| 0 | User import (paste a link or JD) | Yes, shipped | Nothing. Private to the user; full matching, tailoring and tracking. Legal footing: SPC Guiding Case 263. |
| 0 | Deep links built from the user's own query | Yes (3 boards) | Extend to 9: add 前程无忧, 拉勾, 实习僧, 牛客, 国聘, 24365; order by audience. Each URL pattern checked in a browser before it ships. |
| 1 | `ats_public` rows located in mainland China | Yes, connectors exist | Route by posting location into `market='cn'`; a seed of China-hiring boards, each validated against its live board (at least 50 boards with a mainland posting before GoApply's production launch). This is what fills the feed first. |
| 1 | GoHire bank over HTTPS | Thin today | Interim: the parity plan's HTTPS list reader (it sees only the jobs the service key's user may see). Target: a syndication route in the GoHire backend (second repo; `GOHIRE_SYNDICATION_URL`) returning open + published jobs with tombstones, `employerVerified` and `syndicationConsentAt`, plus an HTTP variant of the bank adapter here. Only this source may carry 企业直招. Recruiter test postings (empty company, titles containing 测试) are skipped and counted. |
| 1 | Active Jobs DB, `location=China` | Likely; unmeasured | Paid plan; adapter markets `['intl','cn']`; send role text only, never user data. |
| 2 | 北森 tenant boards (`<tenant>.zhiye.com`) | Yes | Built behind `CN_ATS_BEISEN_ENABLED` (default off) until counsel signs off under 反不正当竞争法 Art. 13(3). 2 tenants in flight, 30-minute floor per tenant, hard cap per run, identifying User-Agent, takedown path. |
| 3 | 24365, 国聘, ATS channel registration (北森 / Moka / 飞书), 猎聘 | Later | Partnerships through the licensed entity. |

**Display rules (five-ministry notice, CN §5.2).** GoHire bank jobs open the GoHire page and carry the licence line when `CN_HR_LICENCE_HOLDER` and `CN_HR_LICENCE_NUMBER` are set (never a made-up licence). Every other posting shows `来源：{original publisher}`, the original link and `最后核验 {date}`. A posting with no usable apply URL is not shown. GoApply never accepts postings from employers directly. The feed header says where postings come from ("来自 GoHire 与 N 家企业招聘官网", N computed) and never implies full-market coverage; a thin result set shows the deep links.

### 1.5 Dedupe, closure and normalisation (all markets)

| Topic | Rule |
|---|---|
| Dedupe keys | K1 `(sourceBoard, externalId)` (exists). **K2 `atsPostingKey = {ats}:{tenant}:{postingId}`** parsed from apply and source URLs (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday, iCIMS patterns), used before K3. K3 `sha1(company|title|place)` (exists), with the employer's domain replacing the name when a source gives one. |
| Canonical row | `ats_public` priority 5 (ties with `activejobs` at 10 today). Mainland: GoHire bank > employer board > aggregator. Taiwan twins: prefer the row with disclosed pay. Tie-break on an employer-host apply URL before recency. The tracker stores the row the user opened, not the canonical one. |
| Closure | Boards: absent from a complete listing → closed; `application_deadline` → `expiresAt`; three failed syncs disable the source and archive its rows after 48 h. Feed: vendor expired feed by id. JSearch: no signal, so 21 days for rows whose only link is a board or aggregator. Open data: `STOP_DATE`. USAJobs: `ApplicationCloseDate`. Mainland: source validity when stated, else disappearance, else 45 days unseen. On job open and on "Ready to apply", confirm an ATS-host link against the ATS's documented single-posting JSON endpoint; show "closed" instead of a dead link. |
| Dates | Three separate facts: `postedAt` (employer's), `firstSeenAt` (ours), `lastSeenAt`. "New" uses `firstSeenAt`. Mainland naive times are UTC+8. A missing posted date shows "last verified", never "posted". |
| Source label | The original publisher, never the aggregator. No LinkedIn name, logo or URL on any source field. JSearch rows in Taiwan read "104人力銀行 · 經由 Google 職缺搜尋" style. Never imply a partnership. |
| Pay | Never invent a range. Per currency and period plausibility bound; implausible values are excluded from pay sort. Taiwan: monthly TWD as posted; 面議 verbatim; never show or filter on the statutory threshold. Mainland: monthly × `salaryMonths`, shown as posted (`18-28K·15薪`); bare ATS numbers are ambiguous and not filterable. |
| Text | HTML to text; strip recruiter phone numbers, WeChat ids and QR fields; run the CN fraud rules on every mainland row; agencies labelled 代招. |
| Provider fields first | Map the feed's own level, work arrangement, employment type, skills and taxonomy before calling a model; store a provider's sponsorship flag as "the provider's reading". |

### 1.6 Forbidden (all markets)

Indeed, LinkedIn, Glassdoor (direct or through Apify, Bright Data, Mantiks, SerpApi or any "scraper API"); Workday CXS and any career-site HTML; a candidate's own LinkedIn session; Remotive (its terms forbid showing listings to collect sign-ups); 104, 1111, 518, yes123, Cake, Yourator, Meet.jobs HTML or private JSON; BOSS直聘, 智联, 猎聘, 前程无忧, 拉勾 search results; 飞书招聘 public endpoints (signed and captcha-gated); Moka boards without the official API and employer authorisation; reverse-engineered "MCP servers" for mainland boards; bought scraped posting datasets; 企查查-style company-keyed recruitment APIs as a feed (no source, no link); JSearch `country=cn` rows.

---

## 2. Search → retrieve → match

One pipeline and one contract for both brands (D5). Only providers and language handling differ.

### 2.1 Target design

1. **Ingest and normalise** (deterministic), then one quote-verified enrichment call per job. Kept.
2. **Canonical layers.** The 307-node role tree with `en`, `zh` and new `zhHant` labels, plus a new canonical skill vocabulary `RASkill` with aliases in three scripts.
3. **Retrieval** = three legs under the same scope and filter predicates, 200 rows each, fused by reciprocal rank (k = 60), union capped at 400: A recency (today's query); B lexical (`searchDoc` → generated `tsvector('simple')` + GIN, CJK segmented in the application; trigram fallback); C dense (exact distance over the filtered rows in `RAJobEmbedding`; HNSW only past about 200k live rows per market).
4. **Estimate v2** on every candidate: user level from the resume, graded role similarity, hard canonical skills only, priors instead of renormalisation, coverage and confidence, calibrated to the AI scale.
5. **AI score** on the shortlisted few: scorer v4 fills a requirement checklist with anchored statuses and verbatim quotes; the server computes every number.
6. **`getFit(userId, jobId)`** is the only place a fit is assembled. Every surface reads it.
7. **Ranking** keeps its published factors; the fit input is on one scale.
8. **Evaluation harness** gates every change.

### 2.2 The fit contract (one source of truth)

New `server/src/features/match/fit.ts` exporting `getFit`, `getFits` (never calls a model) and `getVariantFit` (tailoring only). The canonical fit is always against the **primary resume**. A score for another resume version is a separately named measure ("With this version") shown only in tailoring.

| # | Invariant (each is a test) |
|---|---|
| I1 | Feed card, job detail, Similar jobs, alerts, Ready list, Assistant, extension and tailoring kit return the same `score`, `tier` and `kind` for the same user and job at the same time. |
| I2 | A fresh AI fit beats an estimate on every surface. No surface is estimate-only. |
| I3 | Changing filter chips never changes a fit. |
| I4 | A posting that backs less than 60% of the rubric weight cannot be `great`; its confidence is `low`. |
| I5 | A displayed tier changes only when the score crosses a threshold by at least 3 points, or inputs changed. |
| I6 | Stored snapshots (alert mails, notifications, kit "before") carry `kind`, `version`, `scoredAt`; in-app views re-read the live fit. |
| I7 | A model or prompt change is a version bump with a planned backfill; old rows keep serving until replaced. |
| I8 | On GoApply without AI consent `getFit`, retrieval and precompute make zero model calls. |

### 2.3 Concrete changes to our code, in build order

| Step | Change | Files | Schema (additive) |
|---|---|---|---|
| 1 | Harness, fixtures and the ten invariant tests, written first and failing | new `server/src/features/match/eval/**`, `package.json` (`eval:match`) | none |
| 2 | Taxonomy precision: discipline-ambiguous head nouns match alone only when they are the whole title; modifier lexicon; enrichment may override a deterministic match scored under 0.9; backfill | `jobs/taxonomy/match.ts`, `taxonomy.v1.json`, `jobs/enrich/reconcile.ts` | `RAJob.titleMatchScore` |
| 2 | Data quality: pay plausibility bound; country-only location filters by country; company industries from provider fields or enrichment | `jobs/normalize/salary.ts`, `feed/sql.ts`, `jobs/companies/**` | none |
| 3 | Estimate v2 | `match/preScore.ts`, `match/context.ts` | none |
| 3 | Ranking input: delete `pre − 5`; one scale | `feed/ranking.ts`, `/help/ranking` copy | none |
| 4 | `getFit` and migration of every consumer | new `match/fit.ts`; `alerts/service.ts`, `jobs/detail/service.ts`, `agent/deps.ts`, `onboarding/match.ts`, `extension/defaultDeps.ts`, `copilot/tools/jobs.ts`, `resume/tailor/TailorService.ts`, `feed/FeedQueryService.ts` | `RAJobMatchScore.jobContentHash`, `.rubricVersion` |
| 5 | Canonical skills and the three-state keyword check (Shown / Related / Not shown) | new `server/src/features/skills/**`; `jobs/enrich/*`, `match/keywordRows.ts` | `RASkill`, `RAJob.skillIds` |
| 6 | Embeddings, `searchDoc`, hybrid retrieval; Similar jobs by job vector | `server/prisma/sql/001_vector.sql`, `feed/sql.ts`, `feed/FeedQueryService.ts`, `jobs/detail/service.ts`, new embed workers | `vector` extension; `RAJobEmbedding`, `RAUserEmbedding`; `RAJob.searchDoc`, `.searchTsv`, `.contentHash`, `.lang` |
| 7 | Scorer v4; requirements extracted once per job; resume-first prompt; pinned model per market; tier hysteresis | `roboapply/v2/agents/RAJobMatchScorerAgent.ts`, `match/MatchService.ts`, `jobs/enrich/*` | `RAJob.requirements` |
| 8 | Natural-language search: residual text becomes the lexical and dense query, labelled as ranking, not as a checked requirement; Assistant tools see the user's imports and the card renders the cited ids | `job-search/agent.ts`, `feed` nlQuery, `copilot/tools/jobs.ts` | none |
| 9 | Ranking refinements (freshness tail, same-role collapse, title-level negatives). The exploration slot waits for the owner. | `feed/ranking.ts`, `feed/affinity.ts` | none |

Steps 1–4 fix every honesty finding from browser verification with no new vendor, extension or credential.

### 2.4 Estimate v2 in numbers

Starting priors per not-stated dimension (from 202 stored scorer-v3 rows; re-estimated monthly per market on real pairs): title_level 44, skills 39, industry 24, career_path 45. A job that lists no skills, with a perfect title and logistics, then scores at most 65, never 100. Confidence: `high` at coverage ≥ 0.75, `medium` 0.5–0.75, `low` below. Until a market has 500 (estimate, AI) pairs, rank every row on the v2 estimate plus `0.5 × (ai − estimate)` for scored rows; after that, an isotonic map refreshed weekly. Low-confidence unscored rows do not pass a "Good or better" view.

### 2.5 Per-market and multilingual handling

| Topic | RoboApply (intl, Taiwan) | GoApply (mainland) |
|---|---|---|
| Provider queries | English L3 label and up to two synonyms; Taiwan adds the `zhHant` label with `language=zh-TW` | The `zh` label and the CN alias layer (前端 / Web前端 / FE, 后端 / 服务端, 管培生…) |
| Lexical tokens | `simple` config; Traditional Chinese segmented in the app and folded to Simplified in the token copy | `Intl.Segmenter('zh')` with a bigram fallback; `pg_trgm` stays the fuzzy fallback |
| Embedding | `EMBED_MODEL` (default OpenAI `text-embedding-3-small`@1024) | `CN_EMBED_MODEL` when set, else the shared default (D5). Vectors never cross markets. |
| Scorer model | One pinned `LLM_MATCHING_MODEL` | `CN_LLM_*` override when set, else shared; one pinned version at a time |
| Eligibility | Visa sponsorship, citizenship, clearance | 届别, 学历, 校招 / 社招 / 实习 / 兼职 from the source's own category; 届别 only from a stated quote; an age cap is flagged, never used to filter users |
| Fit card wording | Visa wording where relevant; pay annualised in one currency | No visa wording; pay as posted |
| Role tree | 307 nodes, `soc` crosswalk; Taiwan 通俗職業 小類 code → L3 map for open-data rows | Same nodes; never copy the BOSS or 智联 trees; optional 职业分类大典 code for reporting |
| Skills | English canonical labels; ESCO and O*NET ids where a label matches | Same ids with Chinese labels and aliases; certificates (CPA, 教师资格证, 一建, CET-6) as first-class skills |
| Consent | n/a | Without 个性化推荐: legs A and B with the typed query only, no user vector, no fit. Without "Use AI": estimate only. |

**GoApply relevance is unmeasured today** (zero `market='cn'` rows in the clone index). Fit ships on GoApply as on RoboApply (D5), with the estimate's confidence shown; the Chinese subset of the harness must pass its gates on a real corpus (GoHire bank + CN board rows + imports) before GoApply's production launch. That is a release gate, not a feature flag.

### 2.6 Evaluation harness and gates

40 test personas per market with a resume each; pooled candidates from a frozen index snapshot; graded 0–3 labels from an LLM judge (UMBRELA-style) with a 10% audit by RoboHire and GoHire recruiters (judge–human weighted kappa ≥ 0.6 before any metric is trusted). `npm run eval:match` is fixture-only and runs in CI; `-- --live` runs nightly.

| Layer | Gate to ship |
|---|---|
| Retrieval | Recall@200 hybrid ≥ recency-only + 15 points; no persona more than 5 below its baseline |
| Ranking | NDCG@10 and @20 no regression |
| Estimate vs AI | Tier kappa ≥ 0.5; "estimate Great, AI below Possible" under 5% |
| Scorer | ICC ≥ 0.85 over 3 runs; tier flips under 5%; Spearman with human grades ≥ 0.6 |
| Taxonomy | Category precision ≥ 95% on 300 labelled titles per market |
| Skills | Precision of "Not shown" ≥ 95% |
| Language | zh-TW, zh-CN and cross-language subsets within 10% relative of English |
| Latency | Feed p95 no worse than today + 150 ms |

Invariant tests (from the verification findings): a job with no skills and no level cannot be Great; Level chips do not change fit; the same score on every endpoint; a senior resume against an internship is at most Possible; "Java Backend Architect" is not in Design and "Landscape Architect" is; a country-only location filters by country; PostgreSQL is related evidence for "relational databases" and no skill is listed twice; an AI-scored job never ranks below an unscored one solely for being scored; an implausible pay value is not sorted as pay; zero model calls without GoApply AI consent.

---

## 3. Credits and entitlements (identical capability on both brands)

Every paid plan on either brand unlocks the same Pro column of `server/src/platform/credits/catalog.ts`. The only free-tier difference is `tailor` (GoApply 3 a day, RoboApply 2), an existing product decision.

| Bucket | Free | Pro (printed as "Up to …") |
|---|---|---|
| `fit_analysis` | 10 / day | 200 / day |
| `tailor` | 2 / day (GoApply 3) | 50 / day |
| `cover_letter` | 2 / day | 50 / day |
| `resume_check` | 1 / day | 20 / day |
| `rewrite` | 20 / day | 300 / day |
| `outreach` | 3 / day | 50 / day |
| `assistant` | 30 / day | 300 / day |
| `autofill` | **20 / day** (was 5) | 100 / day |
| `ai_answer` | 10 / day | 200 / day |
| `job_import` | 10 / day | 50 / day |
| `ready_kits` | 3 / week | 30 / week |
| `competitiveness` | 1 / week | 3 / day, full report |
| Saved searches / instant alerts | 1 / 1 a day | 10 / as they arrive (stored cap 100 a day) |
| Practice interview credits (1 credit = 20 min) | 1 after email (GoApply: phone) verification + 1 for the checklist | per plan (§4) + packs |

---

## 4. Pricing

### 4.1 RoboApply (USD, Stripe)

| Plan key | Name | Price | Catalog default (cents) | Renews | Practice credits | Label the code computes |
|---|---|---|---|---|---|---|
| `free` | Free | $0 | — | — | 1 + 1 | — |
| `pro_weekly` | Pro, billed weekly | $9.99 / week | `999` | weekly | 1 / week | "about $43 a month" |
| `pro_monthly` | Pro Monthly (default selection) | $24.99 / month | `2499` | monthly | 3 / month | — |
| `pro_quarterly` | Pro Quarterly | **$54.99 / 3 months** | `5499` | every 3 months | 3 / month | "Save 26%" |
| `pro_week_pass` | 7-day pass | **$9.99 once** | `999` | never | 1 | — |
| `practice_pack_5` | Practice pack (5) | $9.99 once | `999` | never | 5, valid 12 months | — |
| `practice_pack_15` | Practice pack (15) | $24.99 once | `2499` | never | 15, valid 12 months | — |
| `student_monthly` (flag `student`) | Student Monthly | $17.49 / month | `1749` | monthly | 3 / month | "30%" |
| `student_quarterly` (flag `student`) | Student Quarterly | $37.99 / 3 months | `3799` | every 3 months | 3 / month | "30%" |

**Why quarterly moves from $59.99 to $54.99.** Our "Save N%" label is floored: (7,497 − 5,999) / 7,497 = 19.98% prints "Save 19%", not the 20% the product plan promised. The category's quarterly discount is 25% (Jobright, Simplify+, Huntr, Kickresume). $54.99 prints "Save 26%" and is the plan with the best retention and the fewest renewal events.

**Why the 7-day pass moves from $6.99 to $9.99.** The pass and the weekly plan grant the same thing. At $6.99 the non-renewing pass is cheaper for every length of use, so the auto-renewing weekly plan is bought only by mistake, and a mistaken $9.99 renewal can become a $15 dispute. At the same price the page can say something true: the price is the same whether or not it renews. Three passes ($29.97) still cost more than a month.

**Taiwan reference (charged in USD; shown as "約 NT$…").** At NT$31.78 per US$1 (Taipei close 2026-10-06), for illustration only; the line is computed from the admin's `fx.reference` rate with source and date and hides itself after 45 days: $9.99 ≈ NT$317; $24.99 ≈ NT$794; $54.99 ≈ NT$1,748; $17.49 ≈ NT$556; $37.99 ≈ NT$1,207.

**Real TWD list (V2, off until `PRICE_<KEY>_TWD_CENTS` is set):** weekly NT$299, monthly NT$749, quarterly NT$1,650 ("Save 26%", same label as USD), pass NT$299, packs NT$299 / NT$749, student NT$519 / NT$1,150.

### 4.2 GoApply (CNY, Alipay; whole yuan, tax-inclusive, one-time, 到期不自动续费)

| Plan key | Name | Price | Catalog default (fen) | Access | Practice credits | Label the code computes |
|---|---|---|---|---|---|---|
| `free` | 免费版 | ¥0 | — | — | 1 + 1 | — |
| `pro_week_pass` | 会员周卡 | ¥12 | `1200` | 7 days | 1 | — |
| `pro_monthly` | 会员月卡 (default selection) | ¥39 | `3900` | 30 days | 3 | — |
| `pro_quarterly` | 会员季卡 | ¥99 | `9900` | 90 days | 3 per calendar month while the pass is live | "省 15%" |
| `practice_pack_5` | 面试练习包 5 次 | ¥29 | `2900` | valid 12 months | 5 | — |
| `practice_pack_15` | 面试练习包 15 次 | ¥79 | `7900` | valid 12 months | 15 | "省 9%" at most |
| `student_monthly` (flag `student`, new) | 学生月卡 | ¥29 | `2900` | 30 days | 3 | "25%" |
| `student_quarterly` (flag `student`, new) | 学生季卡 | ¥69 | `6900` | 90 days | 3 per calendar month | "30%" |

Evidence in P-CN §2: 知页 sells a 7-day card at exactly ¥12; resume-only memberships are ¥18–28 a month; 牛客 is ¥25 a month and ¥60 for 90 days; seeker VIPs for experienced hires are ¥58–98. One public price for every buyer plus a published student rule (《互联网平台价格行为规则》 Art. 8 and Art. 15).

### 4.3 Catalog rules (code)

| Rule | RoboApply | GoApply |
|---|---|---|
| Default amount | In `planCatalog.ts` (table 4.1) | In `planCatalog.ts` (table 4.2) |
| Override | `PRICE_<PLANKEY>_USD_CENTS`; `STRIPE_PRICE_<PLANKEY>_CENTS` read as an alias | `CN_PRICE_<PLANKEY>_FEN`; an override that is not a multiple of 100 is ignored and logged (the worker bills whole yuan) |
| Sellable | amount present (always) and the Stripe rail is available | amount present (always) and `CN_PAYMENTS_ENABLED` is not explicitly `false` |
| Price id | Resolved at checkout through the catalog sync (§5.1). `STRIPE_PRICE_<PLANKEY>` together with `_CENTS` remains an optional pin; a pin without `_CENTS` is ignored and logged. | none (amount-priced) |
| Never | `price_unset` for any plan in the tables | `price_unset`; ¥x.9 prices; a first-month discount; auto-renewal |
| A price change | New lookup key → new Stripe Price; existing subscribers keep theirs | Applies to new orders only; the amount of a pending order is never edited |

### 4.4 Renewal and refund rules

| Topic | RoboApply | GoApply |
|---|---|---|
| Renewal | Weekly, monthly, quarterly renew until cancelled. The unticked acknowledgement names period and price and is stored; kept until the later of 3 years after consent and 1 year after the subscription ends (California AB 2863). Weekly is never preselected. | None. Buying again while a pass is live extends from its end date. |
| Reminders | 2 days before a weekly renewal, 5 days before monthly and quarterly, one annual reminder. Our own standard, not a legal day count. | A courtesy message 3 days before a 30- or 90-day pass ends. |
| Cancel | One click, at period end; `/cancel` reachable from every footer without signing in; "Keep my plan" resumes while the period is live. | n/a |
| Plan change | In the app, with a proration quote and a new acknowledgement. | Buy another pass. |
| Refund, first purchase | Within 7 days (weekly plan and pass: 48 hours) if fewer than 5 paid-only credits were used. | Same rule (周卡: 48 hours). |
| Refund, mistaken renewal | Within 3 days. | n/a |
| Refund, packs | While no credit from the pack is used. | Same. |
| Statutory withdrawal | EU / EEA (incl. IS, LI, NO) / UK / Taiwan: 14 days. Without the waiver box: full refund. **With the box ticked: pro-rata refund for unused days on a subscription** (default until counsel rules; the "lose the right once it starts" exception covers digital content, not a subscription service). A used pass and used practice credits keep today's rule. A labelled "Withdraw from contract" entry is shown for 14 days after each EU / EEA purchase (Directive (EU) 2023/2673, applying from 2026-06-19). | Activated digital memberships are outside the 7-day no-reason return; our published rule above is more generous. |
| How a refund is executed | `refunds.create` from an audit-logged admin action or the self-service withdrawal; entitlements are reversed only by the `charge.refunded` webhook, so a Dashboard refund behaves the same. | By hand in the Alipay merchant console (the rail has no refund call), then recorded with an admin action that reverses the entitlement once. |
| Printed on `/pricing` | The four refund lines above, in plain words, without naming competitors. | The same, plus 一次性付款 · 到期不自动续费, the day count and (when configured) the collecting entity. |

---

## 5. Payments

### 5.1 Stripe for RoboApply: complete implementation

**State today** (PAY §B1): Checkout for subscriptions and one-time payments, raw-body webhook with signature check, replay-safe grants, cancel at period end, switch with proration quote, payment-failed mail, portal session and invoice history exist and are tested (281 billing tests pass). Nothing is purchasable because a plan needs both `STRIPE_PRICE_<KEY>` and `_CENTS` and none is set.

**Safety first.** The clone worktree's `.env` holds a **live** Stripe secret key *(re-checked: prefix only, value not printed)* and no webhook secret. Requirement ST-0 makes the Stripe rail refuse catalog writes and checkout when a live key is used outside a production runtime, unless `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true`. Development and browser verification need a `sk_test_` key and a `stripe listen` secret from the owner. Automated tests always use the fake client (`setStripeClientForTests`).

| Topic | Specification |
|---|---|
| Catalog sync | New `platform/billing/stripeCatalog.ts`. Products with fixed ids `ra_pro`, `ra_pro_student`, `ra_pro_week_pass`, `ra_practice_pack` (`resource_already_exists` is success). Lookup key `ra_<planKey>_<currency>_<amountMinor>_incl`, e.g. `ra_pro_monthly_usd_2499_incl`. `resolveStripePriceId(planKey, currency)`: memory cache → `prices.list({ lookup_keys, active: true })` (≤ 10 keys per call) → `prices.create({ product, currency, unit_amount, lookup_key, tax_behavior: 'inclusive', recurring: { interval: 'week' | 'month', interval_count: 1 | 3 }, metadata: { product: 'roboapply', planKey } }, { idempotencyKey: 'catalog:<lookup_key>' })`. One in-flight promise per key. `planKeyForPrice`: `price.metadata.planKey` → parse the lookup key → env pins → legacy map. `getPlanCatalog()` stays synchronous and never calls Stripe. |
| Checkout | `mode: 'subscription'` for weekly / monthly / quarterly (quarterly = `interval: 'month', interval_count: 3`); `mode: 'payment'` with `invoice_creation` for the pass and packs. Add `adaptive_pricing: { enabled: false }`, `locale` from the app locale, `customer_update: { address: 'auto', name: 'auto' }`, `subscription_data.description`, and `custom_text.submit` repeating period, price and "cancel any time in Settings or at /cancel". Existing rules stay: acknowledgement recorded before Stripe opens; a pass is refused while a plan renews; a subscription is refused while any plan is live; student gate. |
| Idempotency keys | `customers.create`: `customer:<seekerProfileId>`. `checkout.sessions.create`: `checkout:<userId>:<planKey>:<currency>:<client Idempotency-Key or 10-minute bucket>`. Switch: `switch:<subId>:<planKey>:<prorationDate>`. Cancel / resume: `cancel|resume:<subId>:<periodEnd>`. Refund: `refund:<pi>:<amount|full>`. |
| Webhook | One endpoint `POST /api/v1/roboapply/stripe/webhook`. Events and effects in the table below. Per-effect claims in `RACreditLedger` stay (no event table). `STRIPE_WEBHOOK_SECRET` accepts a comma-separated list for rotation. Keep answering 500 on failure: every step is replay-safe. On every subscription event, re-read the subscription from Stripe before syncing, so a late older event cannot roll state back. Resolve the plan from the **price** first, subscription metadata second. |
| Switch | Quote → confirm stays. `confirmSwitch` uses `payment_behavior: 'pending_if_incomplete'`; when the result carries `pending_update`, answer `{ requiresAction: true, hostedInvoiceUrl }`. Every Pro ↔ Pro switch is offered in the plan sheet through `SwitchQuoteSheet`. |
| Cancel and resume | Cancel exists. New `POST /api/v1/roboapply/credits/resume` (plan live and `cancelAtPeriodEnd` true → records the acknowledgement, `cancel_at_period_end: false`). A cancellation that arrives from the portal sends the confirmation mail once (claim `cancel:<sub>:<periodEnd>`). |
| Dunning and SCA | `past_due` keeps Pro while Stripe retries (exists). `invoice.payment_action_required` → one mail with the hosted invoice link. The failed-payment banner opens a portal session with `flow_data: { type: 'payment_method_update' }`. |
| Refunds and disputes | New `platform/billing/stripeRefunds.ts`: `issueRefund` (ownership through `stripeCustomerId`; payment intent from the checkout session or `invoicePayments.list`). Entitlements change only on `charge.refunded`: full refund of a pack → zero what is left of that grant; the running pass → end access; a subscription invoice → cancel now and reset the period's practice credits; partial → record only. `charge.dispute.created` → as a full refund, flag the account. |
| Portal | Configuration created by code and passed to every session: invoices on, payment method on, customer details and tax id on, cancel at period end with reasons on, **subscription update off**. |
| Tax | Off by default. `STRIPE_TAX_ENABLED=true` adds `automatic_tax`, `tax_id_collection` and `billing_address_collection: 'required'` to Checkout and `automatic_tax` to switches. |
| Currency | USD for every buyer. TWD later through the same catalog (`PRICE_<KEY>_TWD_CENTS`, two-decimal minor units). |
| GoApply guard | Stripe never serves GoApply; no webhook event activates anything for a `goapply` object. |

| Event | Action | Claim / guard |
|---|---|---|
| `checkout.session.completed`, `.async_payment_succeeded` | Subscription: sync row + grant. Payment: pass or pack. | `billing:checkout:<session>` (exists) |
| `checkout.session.async_payment_failed`, `.expired` | Log only | none |
| `customer.subscription.created` | Attach the subscription id to the row found by `metadata.seekerProfileId`; state only | unique `stripeSubscriptionId` |
| `customer.subscription.updated`, `.deleted`, `.pending_update_applied`, `.pending_update_expired` | Re-read, then sync; cancel mail when cancelled outside the app | `cancel:<sub>:<periodEnd>` |
| `invoice.paid` | Period credits; switch credits | period guard; `billing:invoice:<invoice>` (exists) |
| `invoice.payment_failed` | `past_due` + mail | `billing:payfail:<invoice>` (exists) |
| `invoice.payment_action_required` | Mail with the hosted invoice link | `billing:payaction:<invoice>` |
| `charge.refunded` | Reverse entitlements, mail | `billing:refund:<charge>:<amount_refunded>` |
| `charge.dispute.created` | Reverse + flag | `billing:dispute:<dispute>` |

**Local test recipe** (PAY §B6; the owner runs the two steps that touch the Stripe account): a `sk_test_` key in `.env`; `stripe login`; `stripe listen --forward-to localhost:4621/api/v1/roboapply/stripe/webhook` and paste the `whsec_…`; open `http://localhost:3621/settings/billing`: the plans show $9.99 / $24.99 / $54.99, pass $9.99, packs $9.99 / $24.99 with no further setup. Cards: `4242 4242 4242 4242` success; `4000 0027 6000 3184` 3-D Secure; `4000 0000 0000 9995` insufficient funds; `4000 0000 0000 0341` attaches then fails on the next charge. Replay any event with `stripe events resend <evt_id>`: the response carries `duplicate: true` and nothing changes twice.

### 5.2 Alipay for GoApply: the "do not break" contract

The clone branch rewrote the Alipay path against D6 (PAY §0.1). The rewrite is well tested and its fulfilment logic is stronger than production's, so it is kept, but every wire difference that the product does not require goes back to production's shape, and the following rules are frozen by characterisation tests (AL-1) **before** any other billing change merges.

| # | Rule |
|---|---|
| A1 | `GET` and `POST /api/v1/roboapply/billing/alipay/callback` stay public (no auth, no CSRF, no capability flag), read parameters from query **and** JSON body, and stay mounted after `express.json`. |
| A2 | Answers: HTTP 200 `{ code: 0 }` for success, closed, no-action **and replays**; 400 with 40001 (missing params) / 40002 (unknown order); 403 / 40003 for a wrong secret; 500 / 50001 on an exception. Never non-200 to a replay of a paid order. |
| A3 | `AlipayOrder.outTradeNo` is unique and is the only key the callback uses. `tier` keeps the `ra_` prefix; a tier without it returns `not_found` (recruiter orders share the table). |
| A4 | One order activates once and grants once, under replay and under two concurrent notifies. |
| A5 | Worker request: endpoint default `https://worker.gohire.top/payment/payment/create`; `pay_channel: 'alipay'`; `platform: 'gohire'` unless overridden; whole-yuan numeric `total_amount`; `package_data` with the four string fields; `notify_url` on a host that serves the callback route; `?cb=` URL-encoded. |
| A6 | A callback whose `cb` does not match the configured secret is refused before any database write; the comparison is constant-time. |
| A7 | A pending legacy `ra_starter` / `ra_growth` order still fulfils: 30 days, plan credits, CNY, `market: 'cn'`. |
| A8 | `AlipayOrder` is never widened destructively: `tier`, `amount`, `status`, `completedAt` keep their meaning; new facts go in nullable columns or ledger rows. |
| A9 | CN rails sell one-time products only. `fulfilPass` refuses a subscription-kind plan. No auto-debit, no stored agreement. |
| A10 | Every completed `ra_*` order stays listed in `/billing/history` and is downloadable by its owner only. |
| A11 | Stripe never serves GoApply, and the Stripe webhook never activates a `goapply` object. |
| A12 | WeChat Pay work does not change the Alipay rail registration or the `fulfilPass` signature. |

### 5.3 Alipay: the minimal additive mapping of GoApply plans

Nothing here changes `fulfilPass`, the callback route, the claim or the table.

| # | Change | File |
|---|---|---|
| G1 | CNY catalog defaults (table 4.2); `CN_PRICE_<KEY>_FEN` overrides; non-whole-yuan override ignored. Student passes added as `kind: 'pass'`. | `planCatalog.ts` |
| G2 | `CN_PAYMENTS_ENABLED` becomes a kill switch: on unless explicitly `false` / `0` / `off`. `.env.example` stops shipping `=false`. | `planCatalog.ts`, `flags.ts` |
| G3 | `pay.alipay` no longer requires `ALIPAY_API_URL` (the rail already has the default worker URL). | `flags.ts:331` |
| G4 | **Callback secret stays required** (`ALIPAY_CALLBACK_SECRET`; the rail's own credential, as `STRIPE_SECRET_KEY` is Stripe's). The buyer sees the order number, so an unauthenticated callback could fulfil an unpaid order; production has that hole whenever the secret is unset. Without the secret GoApply lists plans and prices and cannot open a payment. The one addition: a callback **without** `cb` is accepted only for an order created before `ALIPAY_SECRETLESS_UNTIL` (ISO timestamp, default unset), which covers orders production created before the cut-over if it ran without a secret. Today the clone answers 503 to those. | `alipayWorker.ts` |
| G5 | Collecting entity: not a gate. When `CN_PAYMENT_COLLECTING_ENTITY` is set it is printed on subject, body and receipt; when unset one startup warning. `CN_PAYMENT_REQUIRE_ENTITY=true` restores the hard gate. | `alipayWorker.ts` |
| G6 | `body` is sent only when an entity is configured (production sends none). | `alipayWorker.ts` |
| G7 | Order number prefix `RAORDER_` for both brands; the brand is in `AlipayOrder.brand`. | `alipayWorker.ts` |
| G8 | GoApply `notify_url` origin: `CN_ALIPAY_NOTIFY_ORIGIN` → `CN_BACKEND_URL` → `BACKEND_URL` → `https://www.roboapply.io` (the origin production proved in `783d5e2`). `return_url` stays on the GoApply app origin. | `origins.ts`, `alipayWorker.ts` |
| G9 | Amount check stays, tolerant: a value equal to the order in yuan passes; a value exactly 100 × the expected yuan is accepted as fen; anything unparseable or implausible is treated as not stated and logged. A genuine mismatch still refuses. | `alipayWorker.ts` |
| G10 | `package_data.package_id`: the plan key by default; `CN_ALIPAY_PACKAGE_ID_MODE=legacy` sends `starter` and keeps the plan key in `package_name` (the fallback if the worker validates the id). | `alipayWorker.ts` |
| G11 | Rail chooser on the GoApply plan sheet: Alipay first and default; WeChat Pay second only when available. | `PlanPicker.tsx` |
| G12 | RoboApply plan sheet, edge country `CN`: one line linking to GoApply for RMB and Alipay; the legacy ¥-pass renewal reminder carries the same link. No redirect. | `PlanPicker.tsx`, billing email template |
| G13 | Manual refund record: an audit-logged admin action marks a completed CN order refunded and reverses its entitlement once (ledger claim `billing:refund:cn:<orderId>`), after the money was returned in the merchant console. | `features/credits/adminRoutes.ts`, `fulfilPass.ts` is **not** touched |

**Cut-over checklist (owner present; settles PAY §A4 R8–R12).**
1. Check whether `ALIPAY_CALLBACK_SECRET` is set in Vercel production today. If it is, reuse the same value. If not, choose one and either set it on `main` first and wait out the cashier's order lifetime, or set `ALIPAY_SECRETLESS_UNTIL` to the deploy time.
2. On a preview deployment, set `CN_ALIPAY_NOTIFY_ORIGIN` to that preview's own origin (a notify sent to production would not find the order: different database).
3. Buy one 会员周卡 (¥12). Capture the worker's raw callback (method, query, body). Confirm activation and the receipt. Refund it in the merchant console and record the refund (G13).
4. From the captured callback: confirm `cb` came back, the `total_amount` format, and that the worker accepted the plan key as `package_id`. Tighten G9 and G10 accordingly.
5. Do not point roboapply.io at the clone until goapply.top serves this flow (M-18), and make sure the notify origin is served by the same deployment and database that created the order.

### 5.4 WeChat Pay

Unchanged and optional: its own routes, notify and agreement gate; it fulfils through the same `fulfilPass`. It appears as the second choice in the rail chooser only when configured. Same CNY prices.

---

## 6. Rollout order

| Phase | Content | Needs the owner? |
|---|---|---|
| A | AL-1 (freeze the Alipay contract), PC-1…PC-4 (catalog defaults, student passes, autofill, pricing copy), AL-2…AL-5 (rail opens, wire parity, tolerance, chooser), ST-0…ST-2 (guard, catalog sync, checkout) | A `sk_test_` key and webhook secret for browser verification only |
| A | SM-1 (harness), SM-2…SM-5 (taxonomy, estimate v2, ranking input, `getFit`), SM-10 (data quality), JT-1 (pay parser) | Additive schema push for SM-2 / SM-5 |
| B | JI-1…JI-6 (quota metering, planner, sources and discovery, throughput, posting key, JSearch demotion), JT-2…JT-5, JC-1, JC-4, JC-5, JC-7, SM-11 | Schema push for JI-3 / JI-5 |
| B | ST-3…ST-10 (webhook, refunds, switch, resume, portal, tax switch, withdrawal rules, history), AL-6…AL-7, PC-5 | — |
| C | SM-6…SM-9 (skills, embeddings and hybrid retrieval, scorer v4, natural-language search), JI-7…JI-10, JC-2, JC-3, JC-6 | `vector` extension; paid feed plan; GoHire endpoint (second repo) |
| D | JI-11, JI-12, JT-6…JT-9, JC-8, SM-12 | Counsel, partnerships, USAJobs key |
| Every phase | OT-1 (plan documents follow this file), OT-2 (all locales, copy and design gates) | — |
| Gate | AL-8 supervised ¥12 order; Stripe test-mode scenario pass; harness gates on each market's subset | Owner present for AL-8 |

---

## 7. What needs the owner

**Purchases and keys**
1. A paid Active Jobs DB plan: upgrade the RapidAPI listing on app 8974502, or a Fantastic.jobs direct key (`FANTASTIC_API_KEY`; from $250 a month for 100k jobs). Measure monthly volume with the vendor's count endpoint on a trial before choosing a tier. Until then the feed runs on boards, the bank and JSearch.
2. A Stripe **test** key (`sk_test_…`) and a `stripe listen` webhook secret for the clone `.env`; later the live webhook endpoint and its secret.
3. A free USAJobs API key.
4. Optional: a 百炼 (DashScope) key if GoApply should embed in the mainland.

**Alipay**
5. `ALIPAY_CALLBACK_SECRET` in the GoApply environment (the value production uses, or a new one). Is it set in production today? (Decides step 1 of the cut-over. Until it is set GoApply shows prices and cannot open a payment.)
6. The legal name of the Alipay merchant behind worker platform `gohire`, and confirmation that GoApply may sell through it (no 二清); who issues refunds from that merchant account and how fast.
7. One supervised ¥12 order on a preview deployment (§5.3).
8. Confirm the default of M-18 (link mainland visitors on roboapply.io to GoApply).

**GoHire (second repo)**
9. Approve the syndication endpoint work package in the RoboHire/GoHire backend and issue a service key with the new scope; add `employerVerified`, `syndicationConsentAt` and a validity period to the bank schema.
10. Confirm that GoHire's entity holds a 人力资源服务许可证 with 网络招聘服务 in scope, and supply `CN_HR_LICENCE_HOLDER` / `CN_HR_LICENCE_NUMBER`.

**Schema (additive; each diff shown before the push to the Neon branch)**
11. `RAJob.atsPostingKey`, `.titleMatchScore`, `.skillIds`, `.searchDoc`, `.searchTsv`, `.contentHash`, `.lang`, `.requirements`; `RACareerSiteSource.origin`, `.discoveredFrom`; `RAJobMatchScore.jobContentHash`, `.rubricVersion`; `RASkill`; `CREATE EXTENSION vector` with `RAJobEmbedding` and `RAUserEmbedding`; the pending SR-16b-1.

**Counsel and tax**
12. Tax route for RoboApply: own registrations (EU Non-Union OSS, UK VAT, later Taiwan) with Stripe Tax, or Stripe Managed Payments as merchant of record; which legal entity sells RoboApply.
13. The withdrawal waiver for subscriptions in the EU, UK and Taiwan (the default until then is pro-rata), the wording of the EU withdrawal control per locale, and the German cancellation-button label.
14. A memo on reading employer ATS boards in the mainland under 反不正当竞争法 (2025) Art. 13(3) (北森, Moka's AES envelope, link-out vs substitution, takedown); whether GoApply's entity needs its own 备案.
15. Public display of jobs (`PUBLIC_DISPLAY_PROVIDERS`, OPS-A4): recommended first entries are `tw_open_data` (OGDL v1 permits it) and `usajobs`; a written answer from Fantastic.jobs on public pages and retention; counsel on employer-board rows and JSearch redisplay.
16. Optional Taiwan-counsel check of the OGDL attribution sentence.

**Product and people**
17. Read the average cost of the last 50 real practice sessions. If it is above $1.00 (RoboApply) reprice the 15-pack to $27.99; if above about ¥3.5 (GoApply) move the packs to ¥39 / ¥99. One catalog default each.
18. About 400 pair judgments per market from RoboHire and GoHire recruiters for the first calibration, then about 100 a quarter.
19. A Taiwan-native reviewer for the `zhHant` role labels.
20. Student verification on GoApply: verified `.edu.cn` email at launch; decide whether a 学信网 report upload with manual review follows.
21. Approve the exploration slot in Recommended (one in ten, disclosed) before it is built.
22. Partnership outreach: Taiwan (Meet.jobs, Yourator, 104's partner programme, 1111, Cake), mainland (24365, 国聘, 北森 / Moka / 飞书 channel registration, 猎聘), and whether Canada, Germany or France justify partner agreements.

---

## 8. Where the research notes disagreed

| Topic | Positions | Ruling |
|---|---|---|
| LinkedIn Job Search API | TW: subscribe. INTL, CN: do not. | Do not subscribe; remove from the registry (M-4). |
| Quarterly price | Owner starting point and PAY defaults: $59.99. P-INTL: $54.99. | $54.99 (M-11). |
| 7-day pass | Owner starting point and PAY defaults: $6.99. P-INTL: $9.99, or $6.99 as a welcome price, or drop the practice credit. | $9.99 list price; no welcome price (the owner ruled no launch offer). |
| Free `autofill` | P-INTL: 20 on RoboApply. P-CN: keep 5 on GoApply. | 20 on both (D5). |
| `CN_PAYMENTS_ENABLED` and the collecting entity | P-CN: keep both as gates. PAY: kill switch; entity not a gate. | PAY's reading; D5 overrides R-15. A strict mode exists. |
| Callback secret | PAY and the parity plan: keep it required. D5: never dark for a missing credential. | Required. It is the rail's own credential and it closes a forgery hole. One addition: a dated window for orders created before the cut-over (G4). |
| JSearch `country=cn` on GoApply | Parity plan §3.9: on, with a "search at the source" link in place of an apply link. CN note: must stay off. | **Off.** The probe found 60 of 60 rows published as LinkedIn listings (most of them copies of 猎聘 postings), 0 of 60 with an apply link or pay, the date filter ignored and a 907-day-old row returned. A card the user cannot open is not a job; the text belongs to a direct mainland competitor and reaches us third-hand (Bing → LinkedIn → JSearch), which is the scrape-and-substitute pattern of SPC Guiding Case 262; and our own rule already refuses LinkedIn-only rows on RoboApply (M-3). D5 asks for the same capability, not for filler inventory. The feed is filled by employer boards and the GoHire bank, and thin results show the deep links. |
| Recruitment-info mode default | CN note: `partner_deeplink`. Parity plan: `licensed`. | `licensed`: each row opens its own apply link, which is the behaviour both wanted. |
| GoApply student pass prices | Parity plan: no default, an owner price. P-CN: ¥29 / ¥69. | ¥29 / ¥69 as catalog defaults (D6: never price-unset). |
| Staleness cut-off at ingest | Parity plan: skip rows older than `MAX_AGE_DAYS` in both markets. INTL: employer postings are old by design (Greenhouse median 40 days). | The cut-off applies to aggregator rows only. Employer-board, bank and open-data rows close by listing diff, tombstone or stated deadline, never by posting age. |
| Stripe price objects | P-INTL: env price ids. PAY: catalog sync by lookup key. | Catalog sync (D6: defaults in code). Env ids remain as pins. |
| `tax_behavior` | P-INTL: inclusive. PAY: unset. | Inclusive at creation; it has no effect until Stripe Tax is on, and it keeps the shown price equal to the charged price. |
| GoApply fit before a Chinese corpus exists | MATCH: do not show fit publicly until validated. D5: same capability. | Fit ships with confidence shown; the Chinese harness subset is a production release gate. |
| Taiwan open-data licence flag | Stub: needs a person and counsel. TW: confirmed by reading; counsel optional. | Confirmed; the adapter is on by default for signed-in users. Public pages stay an owner decision. |
| GoHire bank transport | Fix A (TLS on the DB endpoint), fix B (HTTPS syndication), fix C (dev tunnel). | Fix B. No database credentials leave the mainland, the allow-list and consent are enforced at the source, and `api.gohire.top` already serves valid TLS. |

---

## 9. Implementation requirements (index)

Paths are under `server/src/` unless they start with another top-level folder. Every requirement also carries: `npm run typecheck:server`, the relevant Vitest files, `npm run check` when copy or UI changes, English strings in `i18n/staging/<namespace>.en.json` then all locales (OT-2), and no commit by a work-package agent. "Owner" marks what cannot be done by code alone.

### 9.1 Pricing and catalog

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| PC-1 | Catalog default amounts for both brands; `PRICE_<KEY>_USD_CENTS` / `STRIPE_PRICE_<KEY>_CENTS` alias / `CN_PRICE_<KEY>_FEN` overrides; non-whole-yuan override ignored; RoboApply sellable without a price id; `CN_PAYMENTS_ENABLED` as kill switch | `platform/billing/planCatalog.ts`, `planCatalog.test.ts`, `planViews.ts`, `.env.example` | With an empty env every plan in §4.1 and §4.2 has the listed amount and none is `price_unset`; quarterly prints 26 / 15; `CN_PRICE_PRO_MONTHLY_FEN=3990` is ignored and logged |
| PC-2 | GoApply `student_monthly` / `student_quarterly` as passes (30 / 90 days, flag `student`, never preselected) | `planCatalog.ts`, `fulfilPass.test.ts` (new cases only) | Both keys resolve at 2900 / 6900 fen; `studentDiscountPercent` gives 25 and 30; a paid order for either activates the right day count |
| PC-3 | Free `autofill` 20 a day on both brands | `platform/credits/catalog.ts`, its tests, pricing copy | Default catalog shows 20 for both brands; an AppConfig override still wins |
| PC-4 | `/pricing` and plan sheet: amounts and labels only from `GET /billing/plans`; refund lines; TWD reference line; GoApply 一次性付款 · 到期不自动续费 and day counts | `components/features/credits/PlanPicker.tsx`, `BillingView.tsx`, the pricing page, `lib/pricing.ts`, i18n | With no price env both brands' pricing pages show §4 amounts; no hard-coded amount in any bundle; copy gate passes |
| PC-5 | Admin readout: average cost of the last 50 practice sessions per brand, from `UsageDeductionLog` | `features/credits/adminRoutes.ts`, `components/features/credits/AdminCreditsConsole.tsx` | The panel shows the average with the sample size, or "not enough sessions" under 10 |

### 9.2 Stripe

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| ST-0 | Live-key guard outside production; `maxNetworkRetries: 2`, `appInfo`; env docs | `platform/billing/stripeClient.ts`, `rails/stripe.ts`, `.env.example` | A live key with `VERCEL_ENV != production` makes the rail unavailable and no Stripe write is attempted; the override flag restores it |
| ST-1 | Catalog sync by `lookup_key` | new `platform/billing/stripeCatalog.ts` + test | Empty env + key: every MVP plan resolves a price at the default amount; second resolve makes no call; two concurrent resolves create one price; a pin skips the sync |
| ST-2 | Checkout through the catalog; idempotency keys; `adaptive_pricing` off; `locale`; `custom_text` | `rails/stripe.ts`, `RoboApplyBillingService.ts` | Session uses the synced price id; the same request twice sends the same idempotency key; a GoApply request never reaches Stripe |
| ST-3 | Webhook: new events, re-read on subscription events, price-first plan resolution, several secrets | `roboapply/services/RoboApplyBillingService.ts`, `roboapply/routes/stripeWebhook.ts`, new `platform/billing/integration/stripeWebhook.events.test.ts` | `subscription.created` + `invoice.paid` activates once when `checkout.session.completed` never arrives; a stale update does not roll back; a portal price change records the new plan |
| ST-4 | Refunds and disputes | new `platform/billing/stripeRefunds.ts` + test, `features/credits/adminRoutes.ts`, email templates | Full refund of a pack / pass / subscription reverses the right thing once; replay is a no-op; partial refund changes no access |
| ST-5 | Switch with `pending_if_incomplete`; every Pro ↔ Pro switch in the app | `platform/billing/subscriptions.ts`, `SwitchQuoteSheet.tsx`, `PlanPicker.tsx` | A declined proration leaves the plan unchanged and returns `requiresAction` |
| ST-6 | Resume | `subscriptions.ts`, `features/credits/{routes,service,contract}.ts`, `BillingView.tsx`, `CancelSubscription.tsx` | Resume turns renewal back on and records the acknowledgement; refused after the period ended and for a pass |
| ST-7 | Portal configuration by code; `flow: payment_method_update`; cancel mail for portal cancellations | new `platform/billing/stripePortal.ts` + test, `roboapply/routes/billing.ts`, `PaymentFailedBanner.tsx` | The configuration is created once and reused, with subscription update off |
| ST-8 | `STRIPE_TAX_ENABLED` switch | `rails/stripe.ts`, `subscriptions.ts` | Off: no tax fields sent. On: `automatic_tax`, tax id collection and required address are sent |
| ST-9 | Withdrawal rules: pro-rata with the waiver; EU withdrawal control; consent retention; one country list | `platform/billing/refunds.ts`, `acknowledgements.ts`, `lib/pricing.ts`, `BillingView.tsx`, `PublicCancelFlow.tsx` | A German subscriber who ticked the waiver and withdraws on day 5 of 30 is quoted 25/30 of the price; Norway sees the waiver box |
| ST-10 | Invoice history: paid / open / uncollectible only, paging, refunded marker, CN channel label | `RoboApplyBillingService.ts`, `components/v3/account/billingHistory.tsx` | Drafts and voids are not listed; a refunded invoice shows the marker |

### 9.3 Alipay (additive only)

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| AL-1 | Characterisation tests for rules A1–A12, merged first | `roboapply/services/RoboApplyBillingService.alipay.test.ts`, `platform/billing/rails/rails.test.ts`, `fulfilPass.test.ts`, `roboapply/routes/billing.test.ts` | Every rule has a named test; all pass on the branch before and after AL-2…AL-7 |
| AL-2 | Rail available with production's configuration: kill switch, no `ALIPAY_API_URL` requirement, entity not a gate; the callback secret stays required | `platform/flags.ts`, `rails/alipayWorker.ts` | With only `ALIPAY_CALLBACK_SECRET` set a GoApply 月卡 checkout creates an order whose `notify_url` carries `cb`; `CN_PAYMENTS_ENABLED=false` closes it; without the secret plans list with prices and checkout answers `rail_not_configured` |
| AL-3 | Wire parity: `RAORDER_`, `body` only with an entity, notify origin order, `package_id` mode | `rails/alipayWorker.ts`, `platform/billing/origins.ts` | The request body for GoApply differs from production's only in subject, amount and package fields |
| AL-4 | Callback tolerance: fen accepted, implausible amount logged as not stated, secret-less window by order date | `rails/alipayWorker.ts` | `total_amount=3900` and `39.00` both fulfil a ¥39 order; `40.00` refuses; a no-`cb` callback fulfils only an order older than `ALIPAY_SECRETLESS_UNTIL` |
| AL-5 | Rail chooser, Alipay first | `components/features/credits/PlanPicker.tsx`, tests | With WeChat Pay configured the sheet offers both and defaults to Alipay; without it only Alipay |
| AL-6 | Mainland visitor on roboapply.io: link to GoApply; legacy reminder mail | `PlanPicker.tsx`, `platform/email/templates/billing/index.ts` | Edge country CN on RoboApply shows the line; no redirect happens |
| AL-7 | Manual refund record for CN orders | `features/credits/adminRoutes.ts`, admin console | Marking an order refunded ends that pass or zeroes that pack once; a second click is a no-op; the order stays in history with a marker |
| AL-8 | Cut-over runbook and supervised order | new `docs/jobright-clone/market/ALIPAY_CUTOVER.md` | Owner: the five steps of §5.3 are done and the captured callback is attached |

### 9.4 Job sources: international

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| JI-1 | Monthly quota from response headers; one budget per provider; provider health in the admin System panel | `features/jobs/ingest/{config,pipeline}.ts`, `roboapply/v2/lib/{raRapidApiJobs,raFantasticJobs}.ts`, admin System panel | A 429 with `remaining: 0` stops planning for that provider until reset and the panel shows plan, remaining and days to reset |
| JI-2 | Adapter cost model; no SEO seeds on per-request providers; unsubscribed providers not planned; `linkedin` removed from RoboApply | `ingest/planner.ts`, `sources/types.ts`, `ingest/providers.ts`, `platform/brand/registry.ts` | With defaults no seed query is planned for JSearch and none at all for LinkedIn |
| JI-3 | Career-site sources: bulk import, discovery from apply URLs, validated seed file | `features/jobs/sources/atsPublic/{service,routes,sync}.ts`, `ingest/pipeline.ts`, schema | Ingesting a row with a `boards.greenhouse.io/{token}` link creates a disabled candidate; a matching list-only read enables it |
| JI-4 | Board sync throughput: 4–8 in flight, adaptive interval, own cron, per-ATS cap, User-Agent, disable after three failures | `sources/atsPublic/{adapter,shared,sync,http}.ts`, `vercel.json` | A 728-posting board is fully read in one run; 1,000 fixture boards are scheduled within the interval |
| JI-5 | `atsPostingKey`; `ats_public` priority 5; employer domain in the fuzzy key; tracker keeps the opened row | `features/jobs/normalize/{ats,identity,source}.ts`, `ingest/upsert.ts`, schema | A JSearch row and a board row for the same Greenhouse posting collapse to one canonical board row |
| JI-6 | JSearch demand-only: direct link by host, LinkedIn- or Indeed-only rows not ingested, window by refresh interval, 21-day life | `roboapply/v2/lib/raRapidApiJobs.ts`, `normalize/{adapters,identity}.ts`, `ingest/adapters/rapidApi.ts` | A row whose only link is on linkedin.com is skipped and counted; an employer-host link is marked direct |
| JI-7 | Licensed feed window sync with the expired feed; quota gate; direct-key transport; provider fields mapped first | new `ingest/adapters/fantasticFeed.ts`, `normalize/adapters.ts` | On a BASIC plan the sync does not run; on a ≥ 20k plan an hourly window pages by offset and an expired id archives its row |
| JI-8 | Connectors: Workable, Recruitee, Personio; Lever EU; Greenhouse pay ranges and deadline | `sources/atsPublic/{connectors,contract}.ts`, `normalize/ats.ts` | Fixture boards for each ATS produce normalised rows with apply URL, dates and (where given) pay |
| JI-9 | USAJobs adapter | new `features/jobs/sources/usaJobs.ts` | Without a key the adapter reports disabled; with fixtures it maps pay range and close date |
| JI-10 | Closure and freshness: three date facts, "New" on first seen, on-demand liveness check; a posting-age cut-off never drops board, bank or open-data rows | `ingest/{maintain,tracking,pipeline}.ts`, `features/jobs/detail/service.ts` | Opening a job whose ATS endpoint answers 404 shows it closed and archives it; a 300-day-old posting still listed by its board is ingested |
| JI-11 | Sponsorship facts with source and date | new `features/jobs/companies/sponsorship/**` | A company fact shows year, count and source; no job is labelled as sponsoring without a quote or a labelled provider reading |
| JI-12 | Source register | new `docs/job-search/SOURCE_REGISTER.md` | One row per provider: plan, quota, permitted surfaces, attribution, retention, date read |

### 9.5 Job sources: Taiwan

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| JT-1 | Pay parser: 依學經歷 / 核薪 are negotiable; floor clause threshold-agnostic | `features/jobs/normalize/salary.ts`, `sources/atsPublic/hooks.ts`, tests | The 台灣就業通 no-figure sentence parses to no figure, negotiable true; a 5萬 clause is removed from card text |
| JT-2 | 台灣就業通 adapter | `features/jobs/sources/twOpenData.ts`, `sources/index.ts`, `normalize/{source,types}.ts` | A fixture sweep splits a capped county by district; rows carry attribution, `STOP_DATE` expiry and pay only from numeric fields |
| JT-3 | zh-TW JSearch variant | `ingest/planner.ts`, `ingest/adapters/rapidApi.ts` | A TW tuple plans one zh-Hant query with `language=zh-TW` and one English query, both `date_posted=month` |
| JT-4 | `zhHant` labels and synonyms; 通俗職業 小類 → L3 map | `features/jobs/taxonomy/{taxonomy.v1.json,taxonomy.ts}`, new map file | `taxonomyLabel(id,'zh-TW')` returns Traditional Chinese; an open-data row with code `080202` gets the software role |
| JT-5 | Seed Taiwan career-site sources; denylist adds 518, yes123, meet.jobs | atsPublic seed, `features/jobs/import/**` | The 14 boards exist as sources with `countryCode='TW'`; an import of a 518 link is refused with the existing message |
| JT-6 | Pay-rule tooltip from AppConfig (threshold, source link, as-of date) | `features/tw/**`, pricing/feed UI | Changing the config changes the tooltip without a deploy; the threshold is never shown as a job's pay |
| JT-7 | District level and shift-pattern filter | `features/jobs/geo/**`, feed filters | `新竹縣竹北市` resolves to county and district; the district filter returns only that district |
| JT-8 | Taiwan provenance and helper text | job card and detail UI, i18n | A JSearch row from 104 reads as found through Google's job search; the pay filter says it mostly selects open-data rows |
| JT-9 | 事求人 adapter without contact fields | new source file | Rows link to `VIEW_URL`; no e-mail or phone is stored |

### 9.6 Job sources: mainland China

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| JC-1 | Feed on by default (mode unset → `licensed`, with the parity plan); source line, original link, 最后核验; per-row apply target; honest feed header; deep links when results are thin | `platform/flags.ts`, `features/cn/jobs/{mode,card,service}.ts` | With an empty env GoApply's feed capabilities are on; a board row shows 来源 and opens the employer page; a bank row opens the GoHire page; `off` closes the feed |
| JC-2 | GoHire bank over HTTPS; live cross-bank search reads the synced mirror; test postings filtered | `features/jobs/ingest/adapters/bank.ts`, `roboapply/v2/lib/{raBankClients,raBankProviders}.ts` | With `GOHIRE_SYNDICATION_URL` set and a stub server, a cursor sync upserts rows and a tombstone archives one |
| JC-3 | Syndication endpoint in the GoHire backend | second repo `RoboHire/backend/src/routes/**` | Owner: the route returns the agreed columns over TLS with a scoped service key |
| JC-4 | `ats_public` rows with a mainland location enter `market='cn'`; seed China-hiring boards | `features/jobs/sources/atsPublic/**`, `ingest/pipeline.ts` | A Greenhouse fixture posting in 上海 lands in the GoApply index and not in RoboApply's |
| JC-5 | Deep links for 9 boards, ordered by audience | `features/cn/jobs/deeplinks.ts`, tests | Only allow-listed hosts are built; a 校招 user sees 实习僧 / 牛客 / 24365 / 国聘 first |
| JC-6 | Active Jobs DB for `cn` behind the quota gate | `ingest/adapters/rapidApi.ts`, `fantasticFeed.ts` | With quota the adapter serves both markets and sends no user data; without it nothing is planned |
| JC-7 | Mainland normalisation; a row without a usable apply URL is never listed; `jsearch` is not in GoApply's provider list | `features/jobs/normalize/**`, `features/cn/jobs/**`, `platform/brand/registry.ts`, `ingest/providers.ts` | `1.5-2.5万` → 15,000–25,000 monthly; a recruiter phone number is stripped; GoApply's resolved providers never include `jsearch`; no `market='cn'` row without an apply URL reaches the feed |
| JC-8 | 北森 connector behind `CN_ATS_BEISEN_ENABLED` | `features/jobs/sources/atsPublic/connectors.ts` | Off by default; with fixtures it honours the per-tenant floor and never stores the QR field |

### 9.7 Search, retrieve and match

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| SM-1 | Harness, fixtures, ten invariant tests | new `features/match/eval/**`, `package.json` | `npm run eval:match` runs offline; the invariants fail before the fixes and pass after |
| SM-2 | Taxonomy precision and backfill | `features/jobs/taxonomy/{match.ts,taxonomy.v1.json}`, `enrich/reconcile.ts` | ≥ 95% category precision on the labelled set; the architect cases pass |
| SM-3 | Estimate v2 | `features/match/{preScore,context}.ts` | A no-skills job is never Great; Level chips do not move any fit |
| SM-4 | Ranking input on one scale | `features/feed/ranking.ts`, help copy | The pairwise test (invariant 8) passes; `pre − 5` is gone |
| SM-5 | `getFit` and every consumer | new `features/match/fit.ts` + consumers | The contract test calls every seam and gets one score |
| SM-6 | Canonical skills; three-state keyword check | new `features/skills/**`, `enrich/*`, `match/keywordRows.ts` | "Not shown" precision ≥ 95%; no duplicate chips |
| SM-7 | Embeddings, `searchDoc`, hybrid retrieval, Similar jobs | `prisma/sql/001_vector.sql`, `features/feed/{sql,FeedQueryService}.ts`, workers | Recall@200 gate met; feed p95 within budget |
| SM-8 | Scorer v4 | `roboapply/v2/agents/RAJobMatchScorerAgent.ts`, `features/match/MatchService.ts` | ICC ≥ 0.85; tier flips under 5% |
| SM-9 | Natural-language relevance leg; Assistant tools | `job-search/agent.ts`, feed nlQuery, `features/copilot/tools/jobs.ts` | Residual text changes order and is labelled as ranking; the card shows exactly the cited jobs |
| SM-10 | Data quality: pay plausibility, country-only location, company industries | `features/jobs/normalize/salary.ts`, `features/feed/sql.ts`, `features/jobs/companies/**` | "$60,000,000 an hour" is not sorted as pay; a country-only entry filters by country |
| SM-11 | Per-market handling: CJK segmentation helper, `zh` / `zhHant` query labels, GoApply fit-card wording, embedding override | `features/jobs/normalize/**`, `features/jobs/marketHooks.ts`, `ingest/planner.ts` | `产品 经理` segments consistently at ingest and query; GoApply's fit card has no visa wording and shows pay as posted |
| SM-12 | Ranking refinements | `features/feed/{ranking,affinity}.ts` | A 10-day-old job outranks a 40-day-old one on freshness; same-role rows collapse |

### 9.8 Other

| ID | Requirement | Files | Accepted when |
|---|---|---|---|
| OT-1 | Plan documents follow this file | `docs/jobright-clone/{README,PRODUCT_PLAN,TASK_PLAN,CN_TW_LAUNCH_PLAN,ARCHITECTURE}.md` | Prices, defaults and file paths in those documents agree with §4 and §5 |
| OT-2 | Locales and gates | `i18n/**` | Every new string exists in all locales; `npm run check` passes |
