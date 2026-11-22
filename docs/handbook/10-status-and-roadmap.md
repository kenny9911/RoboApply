# 10 · Status and roadmap

As of 2026-11-03 (main @ b89d5256); updated 2026-11-21 for PRs #17, #18 and #15, and 2026-11-22 for Pulse, PRs #21 and #22 and the open branches (main @ 62eb63a1); 2026-11-23 for PRs #23 and #24 (gateway fallbacks and effort; the saved auto-fallback list).

Where the project stands, what blocks a full launch, and what to work on next. "Verified" means checked against the code or git on 2026-11-03; "doc only" means taken from a plan or carry-over list and not re-checked; "last known (date)" means from the owner's earlier session notes.

## 1. Summary

- RoboApply (international, Taiwan included) is live at www.roboapply.io from `main`. `origin/main` is at `62eb63a1` (2026-11-22: Pulse, PRs #21 and #22); Vercel auto-deploys `main`. The owner's notes say PR #17 was deployed 2026-11-13; later deploys were not checked against Vercel here.
- The jobright-style product (feed, job detail, fit scoring, tailoring, Assistant, tracker, practice, billing UI, admin console) is merged and deployed, but several capabilities are **dark in production for lack of configuration, not code**: crons never run (`CRON_SECRET` unset), Stripe cannot charge, web push is off, original resume files are not stored, mail goes out from a `robohire.io` sender, and voice practice depends on a worker with no production host.
- GoApply (mainland) shares the codebase and has full feature parity but is **closed** in production (`ALLOWED_BRANDS=roboapply`) and has no mainland deployment; its launch waits on legal filings.
- Apart from this handbook's own branch (`docs/handbook`, PR #12), one branch is open and unmerged on 2026-11-22: `perf/page-weight-dead-code` (section 3); every other branch is merged into `main` (checked with `git branch -r --no-merged origin/main`).

## 2. What is shipped on main

### 2.1 Timeline

| Date | What | Commit(s) |
|---|---|---|
| 2026-07-02 | Moved to RoboApply's own Neon project (off the shared RoboHire DB) | last known; database-side change |
| 2026-07-03 | First working production API (ESM, read-only fs, proxy matcher, env) | see [09](09-deployment-and-operations.md) 1.3 |
| 2026-07 | Landing v2, LiveKit worker fixes and portability (Docker, deploy recipes), external job providers (JSearch, Active Jobs DB, LinkedIn via RapidAPI) | `00f615c`, `3dbc3fd`, `1e3f790` |
| 2026-08 / 09 | Clarity redesign, settings rail, natural-language job search agent, practice rebuilt as one screen, GPT-6 Luna/Sol allowed for interviews and priced | `56badf8a`, `94405faa`, `ce45b92a`, `30e0b73d`, `105f5ce1` |
| 2026-09-20 | OpenAI reasoning headroom via OpenRouter (PR #2) | `f346d5f1` |
| 2026-10-09 | `/en` forces English (PR #3); PDF runtime bundled for the function; Alipay callbacks routed to RoboApply; admin payments and usage console | `3b70322e`, `83afd9e0`, `116a7e2e`, `783d5e27`, `7bb7311f` |
| 2026-10-10 | LLM failover to a direct provider when the primary key is dead; interview session create/prepare split; Parley pilot (off by default) | `6d1e704e`, `3c731358`, `3aa63dda`, `72d0b93d` |
| 2026-10-12 | **PR #4: Jobright clone**, RoboApply and GoApply on one codebase (waves 1 to 5, parity wave PAR-1..11, market phases M1..M5, 8,412 translated strings) | merge `355be094` |
| 2026-10-12 | **PR #5: interview practice planned for the real job** (prep agents and skills, 15/20/30-minute sessions) | merge `a90f43af` |
| 2026-10-13 | Default model `google/gemini-3.8-flash`; thinking reserve for Gemini (fixes plans falling back to the catalog panel) | `1078e924`, `9b5d87cd` |
| 2026-10-20 | Prep brief must-haves as a list; retired leftover mock components | merges `20936b9e`, `6150e634` |
| 2026-10-21 | Credits enforced on legacy mock interviews | `7223616a` |
| 2026-10-31 | Admin read-only "view as"; add-resume nudge on `/jobs`; `OPENROUTER_BASE_URL`; npm audit fixes (body-parser, multer, zod, undici, fast-uri); Next 16.4.1 security; AI-first resume hub; **Paper design system** (replaces Clarity) | merges `c3f5d2aa`, `8dbb2a24`, `0666dde7`, `e9d5449d`, `ebfc5375`, `2fa9a39b`, `b89d5256` |
| 2026-11-13 | **PR #17: resume.io clone with the agent-driven redesign** (also carries PRs #13, #14, #16): Desk design system, `/dashboard` home with the agent desk, Ready to apply folded into Applications (Getting ready · Sent), two-screen resume-first onboarding, one-tap Prepare application, Assistant tools that add to the list and prepare, resume editor tabs, Paper job detail and fit-filter follow-ups | merge `368bf7c7` |
| 2026-11-18 | **PR #18**: opt-in weekly preparation of the list, first-class target companies in the job search, a `/pay` pay check built from what postings state. **PR #15**: a visit record and the `/admin/visitors` report of visitors and sign-ups, privacy-notice updates (its docs say schema SCHEMA-9 was applied to the production database) | merges `7d882cf1`, `5a9ee9dd` |
| 2026-11-22 | **PR #20: Pulse**, RoboApply's own design system, replaces Desk (`feat/brand-pulse`). **PR #21**: `next` 16.4.5 for the 2026-11-03 security release (seven moderate advisories). **PR #22**: the LLM gateway, `/admin/llm` (named provider entries and a model per functionality area; see [06](06-ai-and-llm-stack.md)) | merges `f92c735e`, `35e39bb6`, `1780ea4c`, `62eb63a1` |
| 2026-11-23 | **PR #23**: LLM gateway areas get up to three fallback models and a reasoning effort (Medium unless set); an unassigned area runs on the Default area; models resolve from the gateway first, then env, with no model chosen in code (the hard-coded auto-fallback list became `LLM_AUTO_FALLBACK_MODELS`). **PR #24**: that list is a saved setting too (`autoFallbackModels` in the `llm_stack` row, read before the env); production sets it to `openrouter/openai/gpt-6-luna` in the row and in the Vercel env | merge `8eed8eb7`; `feat/llm-auto-fallback-db` |

PR numbers after #5 are not in the commit messages: the branches were merged locally with plain `git merge` and pushed, and GitHub then marked the PRs merged (all on 2026-10-31): #6 prep brief must-haves as a list, #7 `google/gemini-3.8-flash` with the Gemini thinking reserve (opened 2026-10-13), #8 admin view-as, #9 AI-first resume hub, #10 Paper design system, #11 Next 16.4.1 security. Checked with `gh pr list --state all` on 2026-11-03.

### 2.2 What the product does today (RoboApply, production)

- Sign-up/sign-in (email and password, Google), onboarding chat, resume upload and parsing, resume check, AI-first resume hub, guided builder and tailoring (AI gated by the `ai.text` flag and the resume's check).
- Job feed from employer boards (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, SmartRecruiters and others), Taiwan open data and 事求人, metered providers within budgets; hybrid retrieval, scorer v4 fit with a requirement checklist; job detail; natural-language search; saved filters; tracker. **Note:** the feed is stocked by crons, which do not run in production (section 4); what production shows is what earlier writes left and what on-demand paths fetch. Unverified how fresh production's feed is.
- Assistant (copilot, tool-streaming through OpenRouter), practice interviews in text and voice with planned interviewers, reports and coaching.
- Billing UI and plans (USD) with refunds and withdrawal flows; payments cannot be taken until Stripe is configured.
- Admin console: users (with view-as), credits, payments, sources, system health, reports, visitors, the LLM gateway.
- Browser extension (autofill that stops before Submit; ruling D1). Store listing status unverified.

The product never submits an application for the user (D1); auto-apply was removed in WP-75 (the V1 submitter crons are gone from `server/src/cron/handlers.ts`).

## 3. In flight

| Item | State |
|---|---|
| Leftover worktrees | Eight under `.claude/worktrees/`, all clean and merged. Remove only after checking each is clean and its commits are on `main` (an earlier blanket cleanup deleted uncommitted work). |
| `perf/page-weight-dead-code` (6 commits ahead, 2026-11-18, not merged) | Page-weight and dead-code clean-up (unused re-exports). |
| Stale session notes | Notes for the Paper redesign, resume hub and Next 16.4.1 called them unmerged; all three merged on 2026-10-31, and the resume.io clone on 2026-11-13. |

## 4. Owner and ops items still open

Status verified against `docs/jobright-clone/HANDOFF.md` section 6, `orch/parity-verify-results.md` and the `requests/*carryover*.md` files, plus session notes. None of these can be checked from the repository alone: production configuration is "last known".

| Item | Why it matters | Who | Pointer |
|---|---|---|---|
| `CRON_SECRET` unset on Vercel | Every cron route answers 401; no feed ingest, enrichment, alerts, lifecycle mail, reminders, account purge or interview cleanup has ever run in production. Setting it starts all 16 at once, including up to `ENRICH_DAILY_JOBS` (default 8,000) LLM calls a day per market. | Owner decides budgets; engineer sets them | HANDOFF §6; [09](09-deployment-and-operations.md) §2 |
| Stripe keys and live webhook | RoboApply cannot take payments. Needs `STRIPE_SECRET_KEY`, the live endpoint `/api/v1/roboapply/stripe/webhook` with its 14 event types and `STRIPE_WEBHOOK_SECRET`; a test key and `stripe listen` secret for local checks. Tax route (Stripe Tax) and EU/UK/TW withdrawal wording are open too. | Owner (accounts); counsel (wording) | `market/STRIPE_TEST_RECIPE.md`; `MARKET_TASK_PLAN.md` §6 |
| `roboapply.io` not verified in Resend | Production mail goes out from a `robohire.io` sender; setting a `roboapply.io` sender before verification makes every send fail. | Owner (DNS) | HANDOFF §6 |
| S3/R2 write key | Uploaded resume originals cannot be stored or downloaded (the dev key got "Access Denied"; production has none). | Owner | parity-verify-results 4.5 |
| VAPID keys | Web push is off on both brands. | Engineer can generate; owner sets | parity-verify-results §2 |
| Production host for the voice worker | Voice practice depends on a worker that last ran on the owner's Mac. Docker image and recipes are ready; LiveKit hosted agents lack a Tokyo region. | Owner (VM); engineer (deploy) | `interview-agent/deploy/`; [09](09-deployment-and-operations.md) §7 |
| Parley VM | The Parley pilot is ready; blocked on a VM. | Owner | `scripts/parley-vercel-env.sh` |
| OpenRouter key replacement, OpenAI credits | Local OpenRouter key revoked (401) since 2026-10-20; OpenAI key had no credits. Production copilot must run through OpenRouter; whether production shares the dead key is unverified. Google models on OpenRouter got a ToS 403 in production. | Owner | HANDOFF §6; [09](09-deployment-and-operations.md) §8 |
| Alipay callback secret | GoApply lists CNY prices but cannot open a payment until `ALIPAY_CALLBACK_SECRET` is set; then one supervised ¥12 order. | Owner | `market/ALIPAY_CUTOVER.md` |
| GoApply launch (CN-0 / CN-1) | Entity, ICP filing, PIPL package, generative-AI registration, SMS templates, 公安备案, content safety, collecting entity; then the mainland stack or opening goapply.top on Vercel by removing `ALLOWED_BRANDS`. | Owner and counsel; engineer runs the kit | [`docs/runbooks/cn-deploy.md`](../runbooks/cn-deploy.md); `CN_TW_LAUNCH_PLAN.md` |
| Recruiter-bank posting pages | RoboHire/GoHire bank jobs are synced but hidden until `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` / `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` exist; GoHire syndication route to be built in the other repository. | Owner; second repository | `market/GOHIRE_SYNDICATION.md` |
| Sponsorship importers | USCIS H-1B hub and UK sponsor register importers have never been run; the job-page sponsorship block shows nothing. | Engineer, after owner downloads the files | `waveM5-carryover.md` Owner 7 |
| Paid Active Jobs DB plan, USAJOBS key | Licensed feed is behind its quota gate (free month used up); USAJOBS adapter reports disabled without a key. | Owner | `waveM5-carryover.md` Owner 4–6 |
| Workable connector terms | Workable read from the first deploy unless `ATS_WORKABLE_DISABLED=true`; its terms are unconfirmed. | Owner | `waveM5-carryover.md` Owner 1 |
| `PUBLIC_DISPLAY_PROVIDERS` | Which sources may appear on public pages. | Owner, counsel | `docs/job-search/SOURCE_REGISTER.md` §4 |
| Next.js security follow-ups | 2026-11-03 release to apply (section 3). | Engineer | — |
| Admin login provisioning | Any new admin needs a `SeekerProfile` row or login answers 403 `not_a_seeker_account` (verified error code). | Engineer | `server/src/features/auth/errors.ts` |

The full lists, numbered: "Owner steps still open" (42 steps) in [`docs/jobright-clone/README.md`](../jobright-clone/README.md), and the "Owner" sections of [`requests/wavePAR-carryover.md`](../jobright-clone/requests/wavePAR-carryover.md) and `requests/waveM1…M5-carryover.md`. Where they differ, `waveM5-carryover.md` is the most recent.

## 5. Roadmap and backlog

### 5.1 Near-term engineering tasks a new member can pick up

| Task | Pointer | Status |
|---|---|---|
| Add tests that pin the deploy invariants (`"type": "module"`, `server/**` in `includeFiles`, `'/'` in the proxy matcher, no file logging under `VERCEL`). No test covers them today. | `__tests__/deploy/`, `proxy.ts`, `vercel.json`, `LoggerService.ts` | verified missing |
| Admin UI (or a reviewed script) for the per-key fields of the `llm_stack.production` override (`defaultModel`, `fallbackModel`, `purposes.*`): the LLM gateway (PR #22) edits only area assignments and provider entries, so other production model changes are still raw DB writes. Per-area fallbacks and reasoning effort landed on 2026-11-23; its own open items (token budgets, per-model prices, capability checks) are under "Not done" in [`docs/llm-gateway.md`](../llm-gateway.md). | `server/src/lib/llm/llmStackConfigResolver.ts`, `server/src/lib/llm/gatewayAdmin.ts` | partly done (2026-11-23) |
| Fix stale docs: README (DB "shared with RoboHire", "7 cron jobs", "On the `feat/jobright-clone` branch"), AGENTS.md (`schema.prisma` is now a folder; "work in progress on feat/practice-prep" is merged), `.env.example` DB header, `prisma.config.ts` and `server/src/app.ts` headers, ENGINEERING_PLAN §3/§4/§7, HANDOFF "nothing is on main". | those files | verified stale |
| Additive schema requests from the market wave: `RAUserUiState.prevFeedVisitAt` ("New" chips stable within a sitting), `RAJob.sourceScope` (Taiwan closure by absence), optional `RAJob.liveCheckedAt`, `RAJob.workShifts`, `RAH1bEmployerStat.asOf`, `RAJob.taxonomySource`. Each needs owner review of the SQL. | `requests/waveM5-carryover.md` "Owner decisions / schema" 18–22 | verified: none of these columns exist |
| Durable company-style cache for practice prep (today an in-memory TTL cache per instance). | `server/src/interview-engine/prep/companyStyle.ts`, `cache.ts`; `PREP_AGENTS.md` "Open items" | verified per-instance |
| Start company research as soon as a company is typed; multi-round interview loop; report graded against the plan's focus. | `docs/interview-practice/PREP_AGENTS.md` | doc only |
| Fix package X1–X4 and file-unowned fixes left by the M5 gate (e.g. an automatic cure for mistaken `ats_removed` closures, X3). | `requests/waveM5-carryover.md` "Fix package" sections | doc only |
| Geocoder reads 苏州 as 肃州区 (Gansu) on some postings. | `orch/parity-verify-results.md` "Noted, not changed" | doc only |
| Browser retests left for a person: Safari/Firefox, 375 px, Taiwan extras, sources console, closed-job notice. | `orch/parity-verify-results.md` | doc only |
| A Taiwan-native TTS voice for zh-TW practice (the configured one was rejected by the gateway and degraded to a generic Mandarin voice). | last known 2026-07-12 | unverified |
| ~~Leftover Clarity styling in the open-job detail panel and the fit-tier filter.~~ Done: `2f3c0fb4` and `6e36ade4`, merged with PR #17. | `docs/design-system.md` | verified 2026-11-15 |

### 5.2 Larger initiatives

- **Turn on the platform crons safely**: decide budgets (`ENRICH_DAILY_JOBS`, `SCORE_DAILY_BUDGET`, provider budgets), set `CRON_SECRET`, watch the first runs (`waveM5-carryover.md` "What the first runs after this merge do": Workable reads, the daily 事求人 read queuing about 1,100 enrichments, the GoHire bank re-read).
- **Production voice**: host the LiveKit worker (or Parley) near the LiveKit Japan edge; production env for the worker contract.
- **Payments for RoboApply**: Stripe live, tax, then pricing tuning from the practice-cost panel (PC-5).
- **GoApply launch**: legal track (CN-0/CN-1), mainland kit deploy, Edge Add-ons listing, Alipay cut-over, a mainland board list of 50+ boards, the Chinese match-evaluation gate on a real corpus (SM-1).
- **Match quality**: recruiter pair judgments (about 400 per market) to calibrate the scorer; live scorer runs (SM-8); ESCO/O*NET skill ids (SM-6); HNSW index once a market passes about 200,000 rows (needs a migration decision because Prisma cannot declare it and `db push` would drop it). Source: `MARKET_TASK_PLAN.md` §6.
- **Recruiter-bank syndication**: the GoHire syndication route and the candidate-facing posting pages in the RoboHire/GoHire repository.
- **Trim the legacy schema**: `server/prisma/schema/legacy.prisma` still holds 149 of 246 models, most RoboHire-era. Needs a careful, owner-approved plan because the schema is additive-only and `db push` managed.
- **Landing claims**: `docs/LANDING_GAP_ANALYSIS.md` (2026-07-11) lists interviewer avatars, skills assessments and vision feedback as claims without product. Its P0 list (continuous ingest, real submission, the review queue) is superseded: ingest was built in the clone and auto-submission was dropped by ruling D1.

### 5.3 Owner decisions pending

Doc only; each is numbered in the carry-over lists.

- Cron budgets and the date to set `CRON_SECRET`.
- Stripe account (shared with RoboHire or not), selling entity and tax route; EU/UK/TW withdrawal wording (counsel).
- `PUBLIC_DISPLAY_PROVIDERS`; Workable; a paid Active Jobs DB plan and its country/taxonomy filters.
- Taiwan: which 事求人 staff categories are public; filter wording (中班), pay floor units, district scope; the pay-rule update when the amendment is promulgated.
- The free daily tailoring cap differs per market (3 on GoApply, 2 on RoboApply): intended or not (parity-verify-results).
- GoApply: the 测试 rule, `CN_RECRUITMENT_INFO_MODE` values, `CN_STORAGE_MODE=redact`, student plans, Google sign-in, consent for GoHire jobs without recorded consent (`wavePAR-carryover.md` Owner 14–25b, `waveM5-carryover.md` Owner 13).
- Legacy `/v2/discover` 45-day freshness bound vs the feed's rule (`waveM5-carryover.md` Owner 16).
- Exploration slot in Recommended (SM-12), not built.

## 6. Risks and tech debt

| Risk | Detail |
|---|---|
| Configuration, not code, gates most of production | Section 4. Each item needs the owner; the code paths behind them (crons, Stripe, push, storage) have only run on dev stacks and Neon branches. First production runs will surface new problems; plan to watch them. |
| One env change can take the whole API down | Startup assertions block boot (copilot model, residency). Happened 2026-10-13. Mitigation: simulate the check locally, verify an `/api/v1/*` route after every redeploy, keep the previous deployment URL for `vercel promote`. |
| Hidden model configuration | `AppConfig` `llm_stack.production` overrides env with no admin UI; Vercel secrets cannot be read back. Nobody can see the effective production model set without a database read. |
| Paid-provider dependency | LLMs (OpenRouter, Google, OpenAI, DeepSeek), LiveKit Cloud and its inference gateway, Resend, RapidAPI (JSearch, Active Jobs DB), Tavily, GoHire parse API, Stripe. Keys have died silently before (OpenRouter 401, OpenAI 429); the LLM fallback hides it except for `LLM_SERVICE` warnings. Model allowlists and docs lag the gateways (probe with `verify:llm`). |
| The main checkout's `.env` is production | A careless `npm run dev`, script or `db push` from the main checkout touches real users. Neon branches are production copies, too. |
| Stale docs | README, AGENTS.md, ENGINEERING_PLAN, HANDOFF and several file headers describe an older state (section 5.1). The jobright-clone planning docs are large and numerous (TASK_PLAN, MARKET_TASK_PLAN, 13 carry-over lists); some sentences in them were superseded by later gates. |
| Legacy RoboHire-era models and code | 149 models in `legacy.prisma`; `AppConfig`/`SystemLLMKey` rows copied from RoboHire (some undecryptable under RoboApply's key and deactivated); recruiter-only concepts in shared modules. |
| Large modules | `InterviewSessionService.ts` (3,307 lines), `app/(auth)/practice/[id]/page.tsx` (2,171), `RoboApplyBillingService.ts` (2,138), `LLMService.ts` (1,911), `FeedQueryService.ts` (1,876), `features/agent/service.ts` (1,694), `PDFService.ts` (1,619). Change them with focused tests. |
| Frozen and additive-only areas | Alipay tests `A<n> …`, `fulfilPass.ts` and the Alipay callback must not change; the schema is additive-only. Both rules have already cost time when ignored (`HANDOFF.md` §5). |
| Load-sensitive tests | Per the owner, some tests fail with "Hook timed out" when the full suite runs under load and pass alone (unverified here). Re-run the failing file alone before debugging. The extension and interview-agent tests are not part of root `npm test`; CI runs them as separate jobs. |
| Single-person operations | Vercel, Neon, Resend, Stripe, LiveKit, RapidAPI and DNS (Cloudflare) are on the owner's accounts; the voice worker last ran on his Mac. |
| Next.js release cadence | Security releases arrive monthly; bumps must start from the current pin. `npm audit` lags the advisory feed. |
