# 07a · Feature guide: the job side

As of 2026-11-03 (main @ b89d5256).

A map of every job-side feature: what it does for the user, how it flows, where the code is, what data it writes, which providers it calls, and what is easy to break. Paths below are relative to the repository root; server paths are under `server/src/` unless stated. The binding rulings (D1 never submit, D3 no fabrication, D5 parity, D6 per-market sources) are summarised in [01-product-overview.md](01-product-overview.md#binding-rulings).

The decisive spec for everything in this file is [`../jobright-clone/market/MARKET_STRATEGY.md`](../jobright-clone/market/MARKET_STRATEGY.md) (§1 sources, §2 search/retrieve/match). Its research and design background is [`../jobright-clone/market/SEARCH_RETRIEVE_MATCH.md`](../jobright-clone/market/SEARCH_RETRIEVE_MATCH.md); the engineering design is [`../jobright-clone/ARCHITECTURE.md`](../jobright-clone/ARCHITECTURE.md) §4–6.

Most server files open with a long header comment that states the rules of that file. Read it before editing; it is usually more current than any document.

## Pipeline at a glance

```
sources (adapters)  ──jobs-plan (02:00)──▶ RAIngestQuery (what to ask, per provider)
   │                ──jobs-ingest (*/10)─▶ normalize → market hooks → upsert/dedupe → RAJob
   │                ──jobs-boards (*/5)──▶ employer boards: diff listing, close removed
   ▼
queue (RAWorkItem, drained by queue-drain */5)
   job.enrich  → LLM enrichment (skills, requirements, sponsorship, summary)
   job.index   → search document (tsvector) + job embedding (RAJobEmbedding)
   job.score   → AI fit (RAJobMatchScore)            ◀── score-precompute (*/15)
   user.embed  → resume/intent vector (RAUserEmbedding)
   ▼
feed query: 3 retrieval legs fused by reciprocal rank → getFits → rank → card
jobs-maintain (03:30): expiry by stated deadline / age rules / unseen (cn)
```

Crons are HTTP routes in `cron/handlers.ts` (`PLATFORM_CRON_JOBS`), scheduled in `vercel.json`, each run once per served brand inside `runWithBrand` with a 240 s budget split between brands. Locally the same table runs in process unless `ROBOAPPLY_CRON_DISABLED=true`. Trap: a local API pointed at a real database sends real alerts and calls paid providers from those in-process crons. For a safe local run see [`../jobright-clone/HANDOFF.md`](../jobright-clone/HANDOFF.md) §3 ("How step 5 was run"): `ROBOAPPLY_CRON_DISABLED=true`, `ENRICH_DAILY_JOBS=0`, `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true`.

---

## Job sources and ingestion

**For the user.** The job list fills itself from many sources; every card names its source and opens the employer's (or source's) own page.

**Sources per brand.** The per-brand list is `features/jobs/sources/registry.ts` (brand list from `platform/brand/registry.ts` `jobProviders`, plus adapters registered for the brand's market); `features/jobs/ingest/providers.ts` decides which are active right now. `JOB_PROVIDERS_<BRAND>` can only narrow the list.

| Provider id | What | Brands | Code | Switches and limits |
|---|---|---|---|---|
| `ats_public` | Employer boards read through their public posting APIs: Greenhouse, Lever (+EU), Ashby, SmartRecruiters, Workable, Recruitee, Personio; 北森 only behind `CN_ATS_BEISEN_ENABLED` (off, counsel first). Workday is not read (no public API, no scraping). The **backbone** of both brands. | both (postings routed to a market by their own location) | `features/jobs/sources/atsPublic/` (connectors, `discovery.ts`, `seeds.*.json`: 505 intl, 41 TW, 52 CN boards), sync in `features/jobs/ingest/boards.ts` | `ATS_PUBLIC_SOURCES_DISABLED`, `ATS_WORKABLE_DISABLED`, `ATS_BOARDS_CONCURRENCY`; `JOB_SOURCES_CONTACT` for the User-Agent |
| `activejobs` | Active Jobs DB (Fantastic.jobs) search via RapidAPI | RoboApply; GoApply only once a paid plan opens the gate | `features/jobs/ingest/adapters/rapidApi.ts`, client `roboapply/v2/lib/raFantasticJobs.ts` | `RAPID_API_KEY`, `INGEST_ACTIVEJOBS_DAILY_CALLS` (default 300), `RA_ONBOARDING_ACTIVEJOBS_DISABLED` |
| `activejobs_feed` | Active Jobs DB licensed feed: hourly window sync plus expired feed | both, **gated** until the plan allows ≥ 20,000 postings/month (not bought) | `ingest/adapters/fantasticFeed.ts` | `FANTASTIC_*`, `INGEST_FEED_*`, `FANTASTIC_FEED_DISABLED` |
| `jsearch` | JSearch (OpenWeb Ninja) `/search-v2` via RapidAPI; Google-for-Jobs aggregator. **Demand-only**: a signed-in user's own role and place, never SEO seeds, never public pages, never GoApply | RoboApply only | `ingest/adapters/rapidApi.ts`, client `roboapply/v2/lib/raRapidApiJobs.ts` | `INGEST_JSEARCH_DAILY_CALLS` (default 200), `RA_ONBOARDING_JSEARCH_DISABLED` |
| `bank_robohire` / `bank_gohire` | Recruiter banks (RoboHire, GoHire job tables). GoHire is read over HTTPS (syndication endpoint, not yet built on GoHire's side) or its DB | RoboHire → RoboApply, GoHire → GoApply | `ingest/adapters/bank.ts`, `syndication.ts`, `roboapply/v2/lib/raBankClients.ts` | Read only with `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true`; `RA_CROSSBANK_DISABLED`; rows **held** (not listed) until `*_PUBLIC_JOB_URL_TEMPLATE` is set |
| `tw_open_data` | 台灣就業通 open data (OGDL v1), resumable sweep with attribution | RoboApply (Taiwan) | `features/jobs/sources/twOpenData.ts` | `TW_OPEN_DATA_JOBS_ENABLED` (on) |
| `tw_gov_jobs` | 事求人 public-sector list, read daily | RoboApply (Taiwan) | `sources/twGovJobs.ts` | `TW_GOV_JOBS_ENABLED` (on) |
| `usajobs` | USAJobs API | RoboApply | `sources/usaJobs.ts` | needs `USAJOBS_API_KEY` (not set; never called live) |
| `user_import` | The user's own import from a link or pasted text (not an ingest source) | both | `features/jobs/import` | see [Job import](#job-import-added-by-you) |

Not sources: **LinkedIn** (dropped by M-4; the registry refuses the id on every brand, `DROPPED_PROVIDERS`), mainland commercial boards (never scraped; GoApply shows **deep links** to nine mainland boards built from the user's own query, `features/cn/jobs/deeplinks.ts`, only confirmed URL patterns shown).

**Flow.**
1. `jobs-plan` (02:00 UTC) runs the demand-driven planner (`ingest/planner.ts`): demand tuples from active users' default search profiles, plus SEO seed tuples only for sources that cost nothing per request. Writes `RAIngestQuery`.
2. `jobs-ingest` (every 10 min) leases due queries (`ingest/run.ts`), calls the adapter, and runs `processJobs` (`ingest/pipeline.ts`): normalize (`features/jobs/normalize/`) → market hooks (`features/jobs/marketHooks.ts`, e.g. CN fraud rules) → upsert and dedupe (`ingest/upsert.ts`) → enqueue `job.enrich`.
3. `jobs-boards` (every 5 min, once per invocation, not per brand) reads due employer boards and diffs their listings: a posting the board stopped listing is archived `source_removed`.
4. `jobs-maintain` (03:30) expires and closes rows (`ingest/maintain.ts`).
5. Onboarding's `matching` step calls `ingestForProfile` (targeted ingest for the new profile) so the first feed has jobs.

**Quota and budgets.** One budget per metered provider (`ingest/quota.ts`, `ingest/config.ts`): the daily call cap is the env value (or default) further capped by what the provider's response headers say is left of the month, spread over the days to reset, minus a 5 % reserve for people's own searches. Readings are stored in AppConfig `jobs.providerQuota.v1` and shown in the admin System panel. Mainland: `INGEST_<PROVIDER>_CN_DAILY_CALLS` defaults to 0 (no metered call for GoApply). The public job-search API has its own per-brand budget (`job-search/quota.ts`: `JOB_SEARCH_USER_PER_MINUTE` 10, `JOB_SEARCH_USER_DAILY_LIMIT` 100, `JOB_SEARCH_GLOBAL_DAILY_LIMIT` 250 per brand, `CN_` overrides).

**Posting identity and dedupe** (`normalize/identity.ts`, `normalize/ats.ts`).
- `dedupeKey` = sha1(company | normalized title | place), company = employer domain when known. Duplicate groups keep one canonical row (`applyDedupe` in `ingest/upsert.ts`; the priority rule between sources is in MARKET_STRATEGY §1.5 and MKT-3C, not restated here).
- `atsPostingKey` = `<ats>:<tenant>:<postingId>`, written for postings on the nine supported board systems whatever provider brought them; the liveness check reads it.
- Expiry: the source's stated deadline, for every source. Without one, only aggregator rows age out (45 days; a JSearch row whose only link is a job board, 21). Employer boards, banks, open-data and government rows **never expire by age**; they close by listing diff, tombstone, sweep absence or deadline. Mainland rows unseen by any source for 45 days are archived.

**Enrichment.** `job.enrich` (`features/jobs/enrich/`) writes skills (canonical ids from `features/skills`), up to 12 requirement lines per posting (`ENRICH_REQUIREMENTS_MAX`), sponsorship with a verbatim quote, citizenship/clearance flags, scam signals, seniority, an AI summary (shown labelled as AI-written). Budget: `ENRICH_DAILY_JOBS` model calls per market per day (default 8,000; `0` disables LLM enrichment, rule-based parts still run). Over budget, work is deferred, not dropped. Each `ENRICH_VERSION` bump re-enriches rows gradually; readers must tolerate rows without the newer fields.

**Closure and liveness** (`features/jobs/liveness/`). When a person opens a job, clicks apply, or a Ready kit is prepared, a public open row with an `atsPostingKey` on Greenhouse, Lever or SmartRecruiters is checked against the ATS's documented single-posting JSON endpoint. Only a JSON 404 means closed; a timeout, 5xx, 429 or redirect means "unknown" and changes nothing. A closed posting is archived and shown "no longer listed" with no apply link. Off switch: `LIVENESS_CHECK_DISABLED`.

**Public display.** `PUBLIC_DISPLAY_PROVIDERS` (default empty) decides whose rows may appear on signed-out pages, sitemaps and the ticker (`features/seo/scope.ts`). `jsearch` and `linkedin` are ignored whatever the list says. Signed-in users see all sources either way. Taiwan rows that owe a credit line are only shown by callers that print it.

**Traps.**
- A posting with no usable apply link is never listed, on either brand. This is why bank rows are invisible today.
- Never add a provider without its row in [`../job-search/SOURCE_REGISTER.md`](../job-search/SOURCE_REGISTER.md): `sources/sourceRegister.test.ts` fails otherwise.
- `JOB_PROVIDERS_<BRAND>` without `ats_public` also stops board postings being written for that brand.
- The first cron runs against a fresh database rewrite standing queries, load the seeded boards, start the Taiwan sweep and mark every stored fit stale. Read "What the first runs after this merge do" in `docs/jobright-clone/requests/waveM3-carryover.md` and `waveM4-carryover.md` first.
- [`../jobright-clone/HANDOFF.md`](../jobright-clone/HANDOFF.md) §6 (2026-10-12) says `CRON_SECRET` was not set on Vercel, so no cron had run in production. Setting it starts all 16 schedules at once, including LLM enrichment. Unverified today.

**Data.** `RAJob`, `RACompany`, `RAIngestQuery`, `RAProviderUsage`, `RACareerSiteSource`, `RASponsorRegisterEntry`, `RAH1bEmployerStat` (`server/prisma/schema/ra-jobs.prisma`); `RAWorkItem` (queue).

**Read.** MARKET_STRATEGY §1; [`../job-search/ATS_BOARDS.md`](../job-search/ATS_BOARDS.md) (board systems, switches, legal); [`../job-search/SOURCE_REGISTER.md`](../job-search/SOURCE_REGISTER.md); [`../jobright-clone/market/BOARD_SEEDS.md`](../jobright-clone/market/BOARD_SEEDS.md); `market/JOB_SOURCES_{INTL,TW,CN}.md`; [`../jobright-clone/market/GOHIRE_SYNDICATION.md`](../jobright-clone/market/GOHIRE_SYNDICATION.md). The older [`../CROSSBANK_JOBSEARCH_SPEC.md`](../CROSSBANK_JOBSEARCH_SPEC.md) (July 2026) describes the legacy cross-bank search behind `/api/v1/roboapply/v2/discover` (`roboapply/v2/services/RACrossBankSearchService.ts`), still mounted pending an owner decision; the feed no longer depends on it.

---

## Feed, search and retrieval

**For the user.** `/jobs` shows a ranked list ("Recommended", "Best fit", newest, and other sorts) under the user's saved search, with filter chips, a natural-language search box ("remote backend jobs in Berlin paying over 80k"), "What's limiting your results", hide/report, and a category browse at `/jobs/explore`.

**Flow** (`features/feed/FeedQueryService.ts` `query`):
1. Scope and filter predicates (`feed/sql.ts`): market, visibility, listability, the search's filters. A typed `q` is a filter (every word must match); `relevance` (≤ 240 chars, e.g. the residual of an NL query) only orders.
2. Retrieval for Recommended / Best fit: three legs of 200 rows each under the same predicates (`feed/hybridSql.ts`): **A** recency (14-day window, widened to 45 under 60 rows), **B** lexical (`ts_rank_cd` on `RAJob.searchTsv`), **C** dense (pgvector distance on `RAJobEmbedding` against the query text or the user's vector). Fused by reciprocal rank (k = 60, cap 400).
3. Fits for the window via `match.getFits` (no model call).
4. Rank (`feed/ranking.ts`): `0.55·fit + 0.20·freshness + 0.15·affinity + 0.10·sourceQuality` plus goal and skill adjustments, minus "seen and skipped"; sponsorship-first when the user needs a visa; one card per (company, title) with other places attached. The public explanation is `/help/ranking`.
5. Fit-tier view, company scatter, stored as an `RAFeedSession` (30 min) that later pages slice.

NL search (`POST /feed/nl-query`) uses an LLM to turn the sentence into filters plus a relevance text; gated by AI consent and 10/min. The public job-search API (`/api/v1/job-search`, keys at `/job-search/developers`, reference at `/developers/job-search`; `server/src/job-search/`) fans out to JSearch/Active Jobs DB live and to our own index (`index-provider.ts`). API sources need an explicit `JOB_SEARCH_API_PROVIDERS` grant (redistribution rights); see [`../job-search/RUNBOOK.md`](../job-search/RUNBOOK.md).

**Search documents and vectors** (`features/retrieval/`). `job.index` writes `searchDoc`/`searchTsv` (CJK segmented, Traditional folded to Simplified for matching) and the job embedding; `user.embed` writes the resume (else intent) vector. Default model OpenAI `text-embedding-3-small` at 1024 dimensions (`EMBED_*`, `CN_EMBED_*` override). Vectors never cross markets or model tags. On GoApply a user vector exists only with AI consent and a live 个性化推荐 grant; without that grant the feed is not personalised at all.

**Location parsing** (`features/jobs/geo/`). `parseLocation.ts` turns provider text ("Austin, TX", "Hybrid (Taipei City, Taiwan)", "上海市静安区") into city/region/country with coordinates only from the city table (`cities.json`); unknown cities keep their words and get no coordinates. Taiwan gets district level (`twDistricts.ts`). Work model words count only when stated.

**Job pages.** Signed-in detail `/jobs/[id]` (`features/jobs/detail/service.ts`): job, sourced company facts, cached fit and "Why this job", tracker state, similar jobs (nearest vectors, re-ordered by fit), People links, liveness check. Public `/job/[idSlug]` and `/browse/*` come from `features/seo` and follow `PUBLIC_DISPLAY_PROVIDERS` and flag `seo.browse` (off by default).

**Frontend.** `app/(auth)/jobs/page.tsx` → `components/features/feed` (`JobsWorkspace`, `Explore`), `components/features/filters`, `components/features/job` (`JobDetailPanel`), `components/features/search`; API `lib/api/feed.ts`, `lib/api/search.ts`, `lib/api/jobs.ts`.

**Server.** `features/feed` (`/api/v1/roboapply/feed`, public `/api/v1/public/feed`), `features/search` (search profiles, taxonomy), `features/jobs/detail`, `features/jobs/taxonomy` (role taxonomy `taxonomy.v1.json`; its ids are frozen by a test), `features/retrieval`.

**Data.** `RASearchProfile`, `RASavedSearch`, `RACareerGoal` (`ra-search.prisma`); `RAJobUserState`, `RAJobInteraction`, `RAFeedSession`, `RAFeedRating`, `RAUserAffinity` (`ra-feed.prisma`); `RAJobEmbedding`, `RAUserEmbedding` (`ra-retrieval.prisma`).

**Traps.**
- Changing a filter chip must never change a fit (invariant INV-2). Filters narrow; they are not score inputs.
- `relevance` is never a filter; `q` always is. Mixing them broke counts vs lists once (see the `hybridSql.ts` header).
- Raw SQL on `RAJob` must list its columns (`FEED_COLUMNS`) and never select `searchTsv`.
- The dense leg uses exact distance; past about 200,000 live rows per market it needs an HNSW index that the Prisma schema cannot declare (owner decision pending).
- GoApply with `CN_RECRUITMENT_INFO_MODE=off` must return no third-party posting from any seam; seams check the mode themselves.

**Read.** MARKET_STRATEGY §2; SEARCH_RETRIEVE_MATCH §4.9; [`../jobright-clone/PRODUCT_PLAN.md`](../jobright-clone/PRODUCT_PLAN.md) (feed and filters).

---

## Matching and scoring

**For the user.** Every job shows one fit: a tier word (Great fit · Good fit · Possible · Unlikely), a 0–100 number with "This is not your chance of getting hired.", the requirement checklist (met / partly / not shown, with resume quotes) and the gap in plain words.

**The fit contract** (`features/match/fit.ts`). There is exactly one fit per (user, job), against the user's **primary** resume. Every surface reads it through `getFit` (one job; may call the model if allowed), `getFits` (lists, never a model call) or `getVariantFit` (tailoring only). Ten seams are wired and tested for INV-3 ("every surface shows the same score"): feed card, job detail, similar jobs, alerts, Ready list, Assistant (two), extension chip, tailoring kit, onboarding result. A new reader of `getFit*` fails `features/match/eval/enforced.test.ts` until it is listed there.

What a fit is:
- The **estimate** (`match/preScore.ts`, "Quick estimate"): deterministic, always computed, no model. Weights 35/30/15/10/10 (title/level, skills, industry, logistics, career path; `MATCH_WEIGHTS`), per-market priors for what it cannot compare.
- The **AI score** from scorer v4 (`RAJobMatchScorerV4Agent` in `roboapply/v2/agents/RAJobMatchScorerAgent.ts`; arithmetic in `match/scorerV4.ts`): the model fills one status per stored requirement line with a quote; the server verifies quotes are verbatim in the PII-stripped resume and computes the numbers. Lines about age, gender, 户口, citizenship and similar are never judged. `MATCH_SCORER_RUBRIC=fit_v3` is the rollback.
- Once a market has enough (estimate, AI) pairs (`MATCH_CALIBRATION_MIN_PAIRS`, 500), an isotonic map puts the estimate on the AI scale (`match/calibration.ts`).

**Pinned scorer per market.** The scorer model is `LLM_MATCHING_MODEL` (GoApply: `CN_LLM_MATCHING_MODEL` when set; unset falls back to `LLM_MODEL`); production may override it through AppConfig `llm_stack` (`lib/llm/llmStackConfigSchema.ts`). The pin is (model, prompt, rubric) (`match/config.ts` `currentScorerPin`). Changing any part is a version change: stored scores keep serving flagged `stale` and are replaced gradually, never bulk-invalidated. `match/scorerRoute.ts` refuses a model whose route the brand may not use (RoboApply never sends user data to a mainland endpoint); then the fit is the estimate labelled `ai_unavailable`.

**score-precompute** (every 15 min; `match/cron.ts`). For each brand's users active in the last 7 days (up to 200 per run), with AI consent and a resume: take the top 50 of their feed in feed order and queue `job.score` for pairs without a fresh score. Limits: `SCORE_PRECOMPUTE_PER_USER_DAY` (25), brand budget `SCORE_DAILY_BUDGET` (20,000/day; `CN_SCORE_DAILY_BUDGET`), on-demand cap 80/user/day. AI scores are a platform cost, never a user credit. The same run refreshes calibration and runs the retrieval sweep (queues `job.index` / `user.embed`).

**Evaluation harness** (`features/match/eval/`, README there). `npm run eval:match` runs fixtures only (no network, no DB); `npm run eval:match -- --enforce M4` is the gate every matching change must pass (exit 0). The ten invariants (INV-1…10) also run in `npm test` via `enforced.test.ts`. `--live` needs `EVAL_LIVE=1` in the shell and calls models. Never edit the ranking baseline by hand (`--write-baseline` only on purpose). Many gates still read `no_fixture` or `untrusted` until recruiters label pairs (owner step).

**Fit explanations.** "Why this job" and the checklist come from the stored v4 row (`match/evidence.ts`, CitationGuard: only verbatim quotes survive). The three-state keyword check (`GET /feed/skills-check`, `features/resume/keywords`) reports a skill as shown, related evidence (e.g. PostgreSQL for "relational databases"), or not shown. Competitiveness report (`/jobs/report`, `match/CompetitivenessService.ts`, credit `competitiveness`).

**About `lib/matchScoreReconcile.ts`.** It is RoboHire's recruiter-side score reconciler (invite bars, Dealbreaker clamps), reached only through `lib/matchBilling.ts` `runMatchWithQuota` and `agents/ResumeMatchAgent.ts`. It is **not** on the candidate fit path; do not tune it to change RoboApply fits.

**Data.** `RAJobMatchScore`, `RAKeywordExtraction`, `RAFitReport`, `MatchCalibration` (`ra-match.prisma`, `legacy.prisma`).

**Traps.** INV-8: scoring a job must never push it below unscored jobs of equal quality (ranking uses one scale). INV-10: on GoApply without AI consent, `getFit`, the feed and the precompute make zero model calls. A senior resume against an internship is at most Possible (INV-4).

**Read.** MARKET_STRATEGY §2.1–2.6; `features/match/eval/README.md`; SEARCH_RETRIEVE_MATCH §4.8; [`../roboapply/OVERHAUL_RULINGS.md`](../roboapply/OVERHAUL_RULINGS.md) C2–C6 (tiers, rubric, wording).

---

## Resume: upload, hub, editor, tailoring, export

**For the user.** Upload a resume (PDF, DOCX, image, or a LinkedIn PDF export), keep up to 5 base resumes plus tailored versions, edit, run a resume check, tailor a version to a job with every new claim to verify, export PDF/DOCX.

**Upload and parse.** `POST /api/v1/roboapply/v2/resumes/upload` (`roboapply/v2/routes/resumes.ts`) → `RAResumeService.uploadAndCreate` → `lib/candidateResumeIngest.ts`.
- **GoApply**: GoHire's parse API first (when configured), the local pipeline as fallback. A file is read only with the user's AI consent (`ai_resume_parsing`; else 503 before reading).
- **RoboApply**: the local pipeline by default. GoHire is used only when the owner adds `roboapply` to `GOHIRE_PARSE_BRANDS` (default `goapply`) **and** the user granted `intl_cross_border_cn_parse` (the file goes to a mainland server). `localParser=1` forces local.
- The local pipeline's vision OCR is a fallback only: it is known to fabricate content on scanned Chinese resumes, which is why GoHire is preferred where allowed.
- Limits: 5 base resumes (409 `resume_limit_reached`), 10 uploads/imports a day (429). Parsing costs no credit. Originals go to object storage (GoApply under `goapply/` or its own bucket; `CN_STORAGE_MODE=redact|discard` strips ID and health data).

**Resume hub** (`/resume`; AI-first redesign merged October 2026, commit `b7eb7a48`): library cards with real-resume thumbnails, an "Up next" list, AI tailoring panel, "Ask the Assistant", resume check status (`components/features/resume/hub/`, `ResumeHub.tsx`, page `app/(auth)/resume/page.tsx`). AI controls are gated like the tailor availability check; without AI the hub still lists, edits and exports.

**Editor and builder.** `/resume/[id]` (editor, layout panel, `TailorSheet`), `/resume/new` (`features/resume/builder`, AI section suggestions), `/resume/[id]/check` (`features/resume/check`: rules plus an AI pass whose findings must quote the resume, credit `resume_check`).

**Tailoring** (`features/resume/tailor/TailorService.ts`, UI `components/features/tailor`). One `tailor` credit → a tailored version in `review`. The prompt gets only the PII-stripped base and profile; every keyword, number or statement the base does not show becomes a pending **claim** the user must keep, edit or remove ("Verify details"). `finalize` and export refuse while claims are pending (409 `unverified_claims`). The old tailor-diff/apply routes answer 410. The flow shows two separate measures, not a before/after pair: "Your fit" (THE fit, against the main resume, via `getFit`) and "With this version" (`getVariantFit`, computed only at finalize). Each is shown only when it is a real AI fit, else "—".

**Export.** `RAResumeService` → `renderResumePdf` / `renderResumeDocx`; exported files carry the AI-generated marker where required.

**Cover letters** (`/resume/letters`; `features/coverletter`). Create from a resume variant and a job (or pasted post), credit `cover_letter`; every sentence cited; `claimCheck.ts` rejects a letter that presents a job-post fact as the candidate's experience (one retry, then 409, credit released). Versions, rewrite (20/day/letter, no credit), PDF/DOCX export, attach to an application (`RAApplicationArtifact`).

**Data.** `RAResumeVariant`, `RAResumeGrade`, `RATailorSession` (`ra-resume.prisma`); `RACoverLetter`.

**Traps.** AI gate everywhere: `aiAllowed(user)` and the brand's `ai.text` capability are checked before any credit or model call (503 `ai_unavailable`); reading, editing and exporting always keep working. Credits are reserved first, committed only after save, released on failure; `Idempotency-Key` replays return the paid result. Comments in `lib/candidateResumeIngest.ts` say the V2 routes may import `lib/*` but not `services/*`, enforced by `scripts/check-roboapply-v2-boundary.mjs`; that script no longer exists (unverified whether anything still enforces the rule). Cross-area imports inside `server/src/features/**` must go through the other area's `index.ts` or `contract.ts` (`features/boundary.test.ts`).

**Read.** PRODUCT_PLAN (F-RES-*, F-CL-*); ARCHITECTURE §3.6; ruling C12 in TASK_PLAN.

---

## Applications tracker

**For the user.** `/applications`: a pipeline board (RoboApply: Saved · Applied · First call · Interviewing · Final round · Offer · Rejected; GoApply: 收藏 → 网申 → 测评 → 笔试 → AI面试 → 面试 → Offer → 三方 / 未通过), outcomes ("They said no", "I withdrew", "Job was pulled"), follow-up reminders, CSV export.

**Flow.** "Apply on company site" on any surface calls `jobDetailService.recordApplyClick`: opens the employer URL and moves the entry to Applied at once, undoable for 24 h (R1/C11). The same Undo covers "I applied", opening a Ready kit, and the extension's "I submitted".

**Code.** UI `components/v3/pipeline`, `components/features/tracker`; server `features/tracker` (`/api/v1/roboapply/v2/tracker`; ladders in `stages.ts`, CN ladder in `features/cn/tracker`), legacy CRUD `roboapply/v2/routes/tracker.ts` on the same service. Reminders producer in `tracker/cron.ts` (hourly `reminders` cron).

**Data.** `RATrackerEntry`, `RATrackerEvent`, `RAApplicationArtifact`, `RACareerInsight` (`ra-tracker.prisma`).

**Traps.** Every write records an `RATrackerEvent` in the same transaction. Every writer that can move a job to Saved or Applied takes the advisory lock `trackerEntryLockKey(userId, jobId)` (shared with the job page) so concurrent clicks never create two entries. Status values are validated against the brand's ladder; legacy statuses stay readable.

---

## Ready to apply

**For the user.** `/ready` (flag `agent`): a weekly list of good-fit jobs from the user's saved search, and per-job **kits** (tailored resume, cover letter if the posting asks, saved answers) to review, then "Open application". The user submits on the employer site (D1).

**Code.** `features/agent` (`service.ts` state machine, `workers.ts` `agent.prepare`, `cron.ts` `ready-weekly`), UI `components/features/agent` (`ReadyPage`, `SetupWizard`, `KitReview`). Credit `ready_kits` per week, proposed before work starts. A job enters the list and a kit is prepared only while the posting is still listed (liveness check; a closed job answers 410 `gone`, reason `job_closed`). Without AI the kit is the user's own resume and saved answers.

**Data.** `RAAgentSettings`, `RAAgentQueueItem`, `RAAgentKitEvent`, `RAAnswerBankItem` (`ra-agent.prisma`).

---

## Job alerts, notifications, inbox

**For the user.** Alerts for saved searches (instant or daily/weekly digest), reminders (tracker follow-ups, Ready kits, campus deadlines), lifecycle emails; all visible in `/inbox`, and by email and web push per preferences in `/settings`.

**Flow.**
- `job-alerts` (every 15 min; `features/alerts/service.ts`): per saved search with alerts on. Instant: ≤ 5 new jobs at Possible or better, ≥ 3 h apart, capped by plan (`instant_alerts`: free 1/day). Digest: daily or Monday 08:00 local, up to 10/15 jobs. Never in quiet hours (21:00–08:00 local), never a zero-job send. Fits come from `getFits` (no model call) and are snapshotted on the card.
- `reminders` (hourly) runs registered producers (tracker, agent, campus); `lifecycle-emails` (hourly) runs `features/lifecycle`.
- Delivery (`features/alerts/deliver.ts`): in-app `SeekerNotification` row first (source of truth), then email, then registered channels (web push, WeChat 公众号 on GoApply). Each channel's failure is isolated.
- Email: `platform/email` with the Resend transport (`transports/resend.ts`; GoApply may use Aliyun DirectMail via `CN_EMAIL_TRANSPORT`), signed unsubscribe link and RFC 8058 headers, logged in `RAEmailLog`. Non-transactional mail is suppressed unless the preference gate is installed (`installEmailPreferenceGate`).
- Web push (`features/push`): VAPID keys `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (GoApply's own set when `CN_VAPID_PUBLIC_KEY` is set); without keys the area answers 501 `provider_not_configured`, nothing is simulated.
- Inbox (`features/notifications`): list, unread count, mark read, preferences; legacy auto-apply rows are hidden.
- Visitors can subscribe to alerts without an account (`/tools/job-alerts`, `features/visitor`, `RAAnonAlertSubscription`).

**Data.** `RAAlertDelivery`, `RAPushSubscription`, `RAEmailLog`, `RAAnonAlertSubscription`, `RAUnsubscribeFeedback` (`ra-notify.prisma`); `SeekerNotification`.

**Traps.** Alerts have no router of their own: settings live on `/search-profiles` and `/notifications/preferences`. Mail sender: per [`../jobright-clone/HANDOFF.md`](../jobright-clone/HANDOFF.md) §6, `roboapply.io` has no Resend DNS records yet and production sends from `EMAIL_FROM` (as of 2026-10-12). "Tips and reminders" default off in the EEA/UK/CH/CA, unknown countries and GoApply.

---

## The Assistant (copilot)

**For the user.** A chat at `/assistant` and as a side rail ("Ask" in the top bar) that searches jobs, explains fits, compares salaries, proposes filter changes, tailors resumes and drafts letters, with job cards in the reply.

**Flow** (`features/copilot/CopilotService.ts` `handleTurn`): thread ownership → AI consent (503 with zero model calls) → GoApply phone binding → Idempotency-Key → brand daily budget → reserve one `assistant` credit → context (profile snapshot, active filters, job in context, confirmed memory, rolling summary, last 12 messages, PII-redacted) → up to 4 model rounds with tool calls (task `copilot`, streaming) → persist, commit or release the credit. SSE events: `meta`, `delta`, `tool`, `card`, `done`.

**Tools** (`features/copilot/tools/`, registry in `registry.ts`): jobs (`search_jobs`, `top_fit_jobs`, `similar_jobs`, `added_jobs`, `get_job`, `analyze_fit`, `show_jobs`, `company_insights`, `salary_context`, `competitiveness`), filters (`get_current_filters`, `propose_filter_change`, `set_sort`), you (`get_profile_gaps`, `resume_issues`, `rewrite_resume_section`, `application_summary`, `campus_deadlines`, `explain_feature`, `remember`), actions (`tailor_resume`, `write_cover_letter`, `interview_prep`, `draft_outreach`, `find_connections`, `add_external_job`). Changes are **proposals** the user confirms (`RACopilotProposal`), never silent writes.

**Invariants.** A tool may only reference job ids that a tool returned in this turn or the job in context; search results are held back until the model cites them with `show_jobs` (uncited lists are shown whole and logged `jobs_not_cited`). Tool errors become data for the model, never exceptions. A turn whose save fails expires its proposals.

**Code.** UI `components/features/copilot` (`AssistantPage`, `CopilotRail`, `CopilotThread`), API `lib/api/copilot.ts`; server `features/copilot` (`/api/v1/roboapply/copilot`). A visitor variant exists (`/api/v1/public/copilot`, flag `visitorAssistant`, off by default).

**Data.** `RACopilotThread`, `RACopilotMessage`, `RACopilotProposal`, `RACopilotMemory` (`ra-copilot.prisma`). **Read.** ARCHITECTURE §5.

---

## Job import ("Added by you")

`/jobs/added`; `features/jobs/import`. The user pastes a link (read through Firecrawl, `FIRECRAWL_API_KEY`; on a mainland deployment a guarded direct fetch, `directFetch.ts`; else "paste the text") or the text itself; the server extracts a draft, the user confirms, the save costs a `job_import` credit (never for a job that already exists). `urlPolicy.ts` and `IMPORT_FETCH_DENYLIST` refuse unsafe hosts. Also used by the extension's "Save" and the Assistant's `add_external_job`. Imported rows are private (`user_import`) and never expire.

---

## Chrome extension

**For the user.** On an employer application form, "Fill this form" (GoApply 一键填表) fills fields from the profile and saved answers; the user checks and submits; the panel then asks "Did you submit this application?".

**Code.** `extension/` (separate MV3 package; `npm --prefix extension test|typecheck|build|build:goapply`). Adapters per ATS in `extension/src/adapters/intl` and `/cn`; brand builds in `extension/src/brands`. Server side `features/extension` (`/api/v1/roboapply/ext`: pairing codes, devices, status, answers; public `/api/v1/public/ext`); web pages `app/extension` and `components/features/extension`. Credits `autofill` (20/day free) and `ai_answer` (AI-drafted answers). Pairing: `/extension` page sends a token; set `NEXT_PUBLIC_EXT_ID` / `NEXT_PUBLIC_CN_EXT_ID` locally.

**Invariant (D1), enforced in CI.** `npm run check:extension` (`scripts/check-extension-no-submit.mjs`, also run by every extension build and test) fails if any file other than `extension/src/adapters/_kit/interact.ts` clicks, submits, dispatches synthetic click/submit/keyboard events or listens for submits; `interact.ts` may only export `openListbox` and `chooseOption`, both guarded by `assertNotSubmitLike`. `userMarkedSubmitted` is set only from the user's own answer (`features/agent` `markUserSubmitted`).

**Data.** `RAExtensionDevice`, `RAAutofillRun`, `RASiteRequest` (`ra-extension.prisma`). **Read.** [`../../extension/README.md`](../../extension/README.md); ARCHITECTURE §6.

---

## Network and referrals

- **People at a company** (`features/network`, `/api/v1/roboapply/network`): deep links to search people at the employer, the user's own contacts, a LinkedIn `Connections.csv` import (3/day; email column discarded), and AI outreach drafts (credit `outreach`). There is **no send path**: the user copies the draft. Email lookup answers 501 (no licensed provider). Hiring contacts on RoboApply are `deeplinks_only`. The `contacts-sync` cron (04:45) reads opted-in recruiters from the banks.
- **内推码 hub** (`/referrals`, GoApply only, flag `cn.referralCodes`; `features/cn/referrals`): users share referral codes, moderators approve them, anyone can report.
- **Invite friends** (`/invite`, flag `invites`; `features/growth`) is a growth referral programme, not job referrals.

Data: `RAContact`, `RAContactImport`, `RAOutreachDraft` (`ra-network.prisma`), `RACnReferralCode`, `RACnReferralReport`.

---

## Sponsorship and company facts

RoboApply shows visa sponsorship facts with source and date: the posting's own quote (enrichment), the DOL LCA data, the USCIS H-1B Employer Data Hub and the UK Register of Licensed Sponsors (`features/jobs/data/` importers, `features/jobs/companies/`). The registers are loaded by running the importers with `--as-of` and a dry run first; on a database where they were not run, no fact is shown (never estimated). Company pages and facts: `features/jobs/companies` (`/api/v1/roboapply/companies`).

---

## Stale or unverifiable points found while writing this

- Team notes describe the job-search providers as "JSearch + Active Jobs DB + LinkedIn". LinkedIn is dropped (MARKET_STRATEGY M-4) and refused in code; [`../job-search/LINKEDIN_STRATEGY.md`](../job-search/LINKEDIN_STRATEGY.md) and [`../job-search/PROVIDER_EVALUATION.md`](../job-search/PROVIDER_EVALUATION.md) predate that ruling.
- [`../job-search/PRODUCT_SPEC.md`](../job-search/PRODUCT_SPEC.md) describes the `/job-search` workspace page, which was deleted; the path redirects to `/jobs/explore`.
- `README.md` (jobright-clone) says 512 employer boards were validated; the seed files hold 505 (intl), 41 (TW) and 52 (CN) boards. The counts measure different things (validation run vs current seed lists); not reconciled here.
- The `lib/proxyPaths.ts` header says to add new routes to `APP_PATHS` in `app/robots.ts`; `robots.ts` now derives its list from `PROTECTED_PREFIXES` through `lib/seo.ts`.
- `lib/candidateResumeIngest.ts` cites `scripts/check-roboapply-v2-boundary.mjs`, which does not exist.
- Whether `CRON_SECRET` is now set in production, and whether any production cron has run, could not be checked from the repository.
- Nothing in this file was run against a database, a provider or a browser.
