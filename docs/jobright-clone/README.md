# Jobright clone: document index

**Branch:** `feat/jobright-clone`. **Revised:** 2026-10-11 (owner rulings D5 and D6; the parity wave; the market wave, section [Market wave (D6)](#market-wave-d6)) and 2026-10-12 (the market wave as built: the state of each phase and the owner steps still open, in that section).

We are cloning jobright.ai (an AI job-search copilot) into one codebase that serves two brands. Every product feature and onboarding flow is in scope.
- **RoboApply** at `roboapply.io`: the international market, **including Taiwan**.
- **GoApply** at `goapply.top`: mainland China.

The brand is resolved per request from the Host header. Older research notes say "RoboHire.io" for the international brand. That was a typo. RoboHire stays our separate recruiter product.

**The two brands have the same functions (D5).** A capability that is on for RoboApply is on for GoApply by default, and GoApply runs on the same shared stack (models, email, voice, storage) unless a China-specific provider is configured as an optional override. What differs is what follows from the market: job sources, language, currency, prices, the payment rail, extra sign-in methods and legal lines. The rulings are at the end of this file; the specification is [`GOAPPLY_PARITY_PLAN.md`](GOAPPLY_PARITY_PLAN.md).

## Binding owner decisions (2026-10-09)

| ID | Decision |
|---|---|
| **D1** | The product never submits an application for the user. "Ready to apply" and the extension find jobs, prepare materials and fill forms. The user always clicks Submit. Copy never claims auto-apply. |
| **D2** | Existing code may be overwritten where it conflicts with the clone. We keep the parts that work: resume editor, tailor and export, tracker, AI mock interview, Stripe and Alipay billing, job providers, cross-bank search, design tokens, 9-locale i18n, and the copy and design gates. |
| **D3** | Honesty. We never fabricate data a user would rely on. Every number shows its source. Features that need data we lack are either rebuilt on honest substitutes or gated on a real provider. |
| **D4** | The live AI mock-interview fixes are Wave 0 (Track A), already running on `main`. This plan does not re-plan them. |
| **D5** | (2026-10-11) GoApply and RoboApply have the same robust functionality; only the job board, job sources and job-search APIs differ, plus what follows from the market. Full text [below](#d5--brand-parity-owner-2026-10-11-binding-overrides-task_plan-r-13--r-14--r-15-and-cn_tw-gating). |
| **D6** | (2026-10-11) Job sources, prices and payment rails are per market: Alipay (the existing implementation, unchanged) for mainland China, Stripe for the international brand. Full text [below](#d6--per-market-sources-pricing-and-payment-rails-owner-2026-10-11-binding). |

## The documents

| File | What it is | Read it when |
|---|---|---|
| [`GOAPPLY_PARITY_PLAN.md`](GOAPPLY_PARITY_PLAN.md) | **The D5 specification.** How GoApply reaches the same functions as RoboApply: the env rule (`CN_X` is an optional override of `X`), capability defaults, the shared-stack fallbacks per area, the per-brand job source registry, the variables introduced (§4), the eleven implementation bundles (§5; machine-readable in [`orch/parity-bundles.json`](orch/parity-bundles.json)), every audit gap and its decision (§6), the verification steps (§7) and **what needs the owner (§8)**. It supersedes the GoApply gating rules of the three plans below. | You touch anything that behaves differently per brand, a `CN_` variable, a capability flag or a GoApply job source. |
| [`market/MARKET_STRATEGY.md`](market/MARKET_STRATEGY.md) | **The D6 specification.** Per market: job sources and how to search, retrieve and match; the price ladders (USD and CNY); the payment rails, with the twelve "do not break" rules of the existing Alipay path (§5.2); its own owner list (§7). The research notes behind it are the other files in [`market/`](market/). | You touch a job source, a price, a plan or a payment rail. |
| [`market/MARKET_TASK_PLAN.md`](market/MARKET_TASK_PLAN.md) and [`orch/market-bundles.json`](orch/market-bundles.json) | **The market wave's plan.** The bundles file is the executable plan (40 bundles in six phases, M0 to M5, each with its items, owned files, schema and env variables); the task plan is its readable companion (phase table, the one owner of each hot file per phase, the cross-bundle contracts, the env variables per phase, the owner-only list, the coverage of every requirement). | You work on a market bundle, or want to know which phase builds a requirement of the strategy. |
| [`market/ALIPAY_CUTOVER.md`](market/ALIPAY_CUTOVER.md), [`market/STRIPE_TEST_RECIPE.md`](market/STRIPE_TEST_RECIPE.md), [`market/BOARD_SEEDS.md`](market/BOARD_SEEDS.md), [`market/GOHIRE_SYNDICATION.md`](market/GOHIRE_SYNDICATION.md), [`../job-search/SOURCE_REGISTER.md`](../job-search/SOURCE_REGISTER.md), [`../job-search/ATS_BOARDS.md`](../job-search/ATS_BOARDS.md) | **The market wave's working documents.** The Alipay cut-over runbook with its notify check; the Stripe test-mode scenario pass; how the employer-board seed lists were measured and the launch criteria proposed for them; the syndication route specified for the GoHire backend; the register of every job source (plan, quota, where its rows may be shown, the credit it asks for), which is the input of the `PUBLIC_DISPLAY_PROVIDERS` decision; the employer-board systems, their switches and the steps before the 北森 flag. The last three are written in phase M5. | You run a cut-over or a test pass, add or judge a job source, or work on the second repository. |
| [`orch/parity-verify.md`](orch/parity-verify.md) | The step-by-step verification of the parity wave after its bundles are merged (commands, expected output, what counts as "not configured"). | You verify the wave, or want to see what "GoApply works by default" means in practice. |
| [`TASK_PLAN.md`](TASK_PLAN.md) | **The executable plan.** Covers precedence and conflict rulings (§1), rules for every work package (§2), waves 0–5 and INT (§3–§9), the owner/OPS track (§10), dependencies and seams (§11), risks (§12), the coverage matrix (§13), the machine-readable WP list (Appendix A) and the Revision log. | Always. It is the plan of record for the orchestrator and every coding agent. |
| [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md) | User-facing behaviour: positioning, naming, information architecture, onboarding screens O0–O9 and G0–G7, the feature matrix with one decision per catalog ID and brand, pricing and credits, notifications, metrics, and cross-cutting product rules. | You build a screen, write copy, or need a feature's scope. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Engineering design: brand infrastructure, the multi-file Prisma data model, API surface, the ingestion and matching pipeline, the Assistant (copilot), the Chrome extension, credits and billing, notifications, SEO, i18n staging, testing, and file ownership. | You write server or data code, or need a contract. |
| [`CN_TW_LAUNCH_PLAN.md`](CN_TW_LAUNCH_PLAN.md) | Market specifics: brand registry values, capabilities, launch stages CN-0 and CN-1, mainland legal and filing steps, credentials, data residency, Taiwan specifics, and the zh / zh-TW glossary. It maps its work packages to `TASK_PLAN` IDs at the top. Its rule that a GoApply feature stays off until a China-specific credential or licence exists is superseded by D5; the strict mainland posture it describes is now an opt-in. | You touch GoApply, Taiwan, consent, residency or Chinese copy. |
| [`FEATURE_CATALOG.md`](FEATURE_CATALOG.md) | The reverse-engineered Jobright catalog: about 200 feature IDs, onboarding S0–S12, pricing, and CN deltas. | You need to know what Jobright does for a given ID. |
| [`research/`](research/) | Eight raw research notes: product surface, onboarding, matching and jobs, Orion/agent/extension, resume suite, network/tracker/interview, business/growth/SEO, and China market. | Background only. Its claims are folded into the plans above. |

## How to read them

1. **Precedence.** D1–D6 come first. Then `GOAPPLY_PARITY_PLAN.md` for capability defaults and provider fallbacks on GoApply (D5), and `market/MARKET_STRATEGY.md` for job sources, prices and payment rails (D6). Then `TASK_PLAN.md` §1–§2. Then `PRODUCT_PLAN.md` for behaviour, names, routes and prices. Then `ARCHITECTURE.md` for code layout, data and API. Then `CN_TW_LAUNCH_PLAN.md` for market and legal specifics. Last comes `FEATURE_CATALOG.md`. The older rule "where CN_TW is stricter on legal, residency or data egress, CN_TW wins" now holds only for an operator who chooses the strict mainland posture (`CN_RESIDENCY_STRICT`, `CN_LLM_DOMESTIC_ONLY`); it never turns a GoApply feature off by default. No plan document tells you that GoApply needs a China-specific credential, a licence mode or a payments switch to function: where an older sentence still reads that way, D5 wins.
2. **Coding agents** read three things: their own WP section and Appendix A entry in `TASK_PLAN.md`, `TASK_PLAN.md` §1–§2, and the sections of the other plans that the WP cites. Each WP runs in its own git worktree (§2.4). It edits only the paths it owns, writes English strings to `i18n/staging/<namespace>.en.json`, and never commits or pushes. Always cite the full path `docs/jobright-clone/TASK_PLAN.md`; the repo also has an unrelated `docs/TASK_PLAN.md`.
3. **The orchestrator** follows `TASK_PLAN.md` §4.0 for setup, hot files and the gates G0–G7 with the SCHEMA-n steps, §2.5 for merges, and §11 for ordering.
4. **The owner** reads `TASK_PLAN.md` §10 (OPS), the open decisions at the end of this file, `GOAPPLY_PARITY_PLAN.md` §8 (what GoApply still needs from the owner; summarised under D5 below) and `market/MARKET_STRATEGY.md` §7.
5. **What changed on 2026-10-10:** three reviews (feasibility, honesty, completeness) raised 102 items. All were accepted; a few took an alternative the critic offered. The full list is the Revision log at the end of `TASK_PLAN.md`.
6. **What changed on 2026-10-11:** the owner ruled D5 (brand parity) and D6 (per-market sources, prices and rails). Four audits found 130 places where GoApply had less than RoboApply; `GOAPPLY_PARITY_PLAN.md` decides each one and the parity wave (11 bundles) builds them. TASK_PLAN R-03, R-13, R-14, R-15 and the invite-only GoApply sign-up are superseded (marked in place there).

## Shape of the plan

| Wave | WPs | Content |
|---|---|---|
| 0 | Track A | Interview and LLM resilience (on `main`) |
| 1 | 10 | Foundation: schema move and additions, brand core (server, web), platform plumbing, credits and the preference store, area scaffolds, web plumbing, shell and IA, route shells and stubs |
| 2 | 17 | Auth (both brands), brand UI, compliance, LLM routing and egress, content safety, residency, inventory (2 parts), enrichment, scoring, profile, filters, billing (2 parts), resume check, events |
| 3 | 16 | Onboarding (both brands), feed API and UI, job detail, job import, tailoring and the resume hub, cover letters, tracker, notifications (2 parts), marketing, CN and TW jobs, practice entry |
| 4 | 16 | Assistant (API, UI), Ready to apply (API, UI), people, extension (web, package), SEO, tools, campus calendar, question bank, PWA and push, WeChat Pay, interview seam, resume builder, GoApply AI-interview format |
| 5 | 13 | Extension adapters (intl, CN), coaching, WeChat notices, admin, cleanup, CN deploy kit, competitiveness report, visitor surfaces, account V2, invite friends, offer comparison, interview-agent backend |
| INT | 15 | Schema reconciliation and db push #2, i18n merge plus 8 translations, final wiring, gates and build, browser verification per brand, cleanup |
| FIX | 9 groups | Fixes from the browser-verification pass (`orch/verify-fix-groups.json`, `requests/waveFIX-carryover.md`) |
| PAR | 11 bundles | D5 brand parity: `brandEnv` fallback and capability defaults (PAR-1, merged first), then LLM, accounts and messaging, voice, storage and disclosures, payments, GoApply job sources, feed and job detail, job search and workspace, public surfaces, docs and the verification list (`orch/parity-bundles.json`, handoffs in `orch/handoffs-par/`) |
| Market | 40 bundles, phases M0 to M5, after PAR | D6: the requirements of `market/MARKET_STRATEGY.md` §9 that the parity bundles did not already build. Phase table, state and open owner steps in the next section; plan in `orch/market-bundles.json` and `market/MARKET_TASK_PLAN.md`; handoffs in `orch/handoffs-mkt/` |

## Market wave (D6)

The market wave builds what owner ruling D6 asks for: job sources chosen per market, one way to search, retrieve and match jobs, a price ladder per market, the complete Stripe implementation for RoboApply, and the additive mapping of GoApply's plans onto the existing Alipay rail, which keeps working exactly as it does. **The specification is [`market/MARKET_STRATEGY.md`](market/MARKET_STRATEGY.md)**: it is decisive, and where it changes an earlier number or default in `PRODUCT_PLAN.md`, `TASK_PLAN.md` or `CN_TW_LAUNCH_PLAN.md` it wins (its "Precedence" paragraph; requirement OT-1 keeps those files in line). **The executable plan is [`orch/market-bundles.json`](orch/market-bundles.json)** (40 bundles; each bundle lists its items, the files it alone owns in its phase, its schema and its env variables), **with its companion [`market/MARKET_TASK_PLAN.md`](market/MARKET_TASK_PLAN.md)** (the phase table, the hot-file owner per phase, the cross-bundle API contracts, the env variables per phase, the owner-only list and the coverage of every requirement of the strategy's §9). **The parity wave merges first** (PAR-1 to PAR-11, [`GOAPPLY_PARITY_PLAN.md`](GOAPPLY_PARITY_PLAN.md)): it already builds the requirements listed in `TASK_PLAN.md` §14.3, and the market bundles verify those instead of rebuilding them.

Phases run in order, M0 to M5. The bundles of one phase run in parallel, each in its own worktree, and no path has two owners inside a phase. M0 is the additive schema alone, applied to the database branch before any other phase starts. The titles below are the bundles file's own.

| Phase | Bundle | Title (from `orch/market-bundles.json`) |
|---|---|---|
| M0 | MKT-0 | Schema foundation: every additive model, column and index of the market wave, the vector extension file and the additive-only check |
| M1 | MKT-1A | Stripe safety first, USD catalog defaults, catalog sync by lookup key, checkout rail (server) |
| M1 | MKT-1B | Pricing page and plan sheet from the plans API, refund lines, free autofill 20 a day, checkout attempt key (web) |
| M1 | MKT-1C | Taiwan pay parser (JT-1) and the contracts the source wave builds on |
| M1 | MKT-1D | Evaluation harness, fixtures and the ten invariant specs, written first (SM-1) |
| M1 | MKT-1E | Role taxonomy precision, enrichment override and backfill; data quality (SM-2, SM-10; query labels of SM-11) |
| M1 | MKT-1F | Estimate v2, the fit contract (getFit / getFits / getVariantFit) and one-scale ranking input (SM-3, SM-4, core of SM-5) |
| M1 | MKT-1G | Plan documents follow the market strategy; env examples for the Stripe safety rule, the price variables and the other M1 variables (OT-1; env docs of ST-0 and PC-1) |
| M2 | MKT-2A | Alipay, additive only: wire parity with production and callback tolerance (rail file and origins) |
| M2 | MKT-2B | Stripe webhook lifecycle: new events, re-read, price-first, several secrets, reconcile, portal by code, endpoint check; billing mails (server) |
| M2 | MKT-2C | Subscription changes: switch with pending_if_incomplete, resume, idempotency keys, tax switch (server) |
| M2 | MKT-2D | Refund engine: issueRefund, charge.refunded, disputes, pro-rata withdrawal rule, withdrawPurchase, refund mails (server) |
| M2 | MKT-2E | Billing UI for the subscription lifecycle: reconcile on return, in-app switch, resume, payment update, GoApply link for mainland visitors (web) |
| M2 | MKT-2F | Every consumer reads the one fit: lists, Assistant, tailoring, stored snapshots, the every-seam contract test; Similar jobs takes a vector source (rest of SM-5) |
| M2 | MKT-2G | Canonical skill vocabulary: table access, aliases in three scripts, related-evidence graph, seed and review tooling (SM-6, foundation) |
| M2 | MKT-2H | Search document and embeddings write path: embeddings client, CJK segmentation, searchDoc / searchTsv, job and user vectors, sweep; relevance seam (SM-7 foundation, SM-11) |
| M3 | MKT-3A | Ingest core: monthly quota from response headers, one budget per provider, JSearch as a demand-only source |
| M3 | MKT-3B | Planner: adapter cost model, no SEO seeds on per-request providers, demand windows, Taiwan query variants |
| M3 | MKT-3C | Posting identity and lifecycle: atsPostingKey, canonical-row priority, JSearch link rules, expiry rules, carry-through fields |
| M3 | MKT-3D | Employer boards: sources for both markets, discovery, bulk import, seeds, sync throughput and its own cron |
| M3 | MKT-3E | Taiwan: 台灣就業通 open-data adapter with a resumable sweep and attribution, zh-Hant role labels, 通俗職業 map, import denylist |
| M3 | MKT-3F | Provider health in the admin System panel: plan, remaining quota, days to reset, dead sources visible |
| M3 | MKT-3G | Mainland deep links: nine boards, ordered by audience, built only from the user's own query |
| M3 | MKT-3H | Runbooks and pre-flight: Alipay cut-over with the notify check, Stripe test-mode pass (documents and one script) |
| M4 | MKT-4A | Self-service withdrawal endpoints (signed in and on the public cancel page) and consent retention after account deletion (server) |
| M4 | MKT-4B | Admin billing server: refund action, manual CN refund record, practice-cost readout, Stripe health; invoice history with refunded marker (server) |
| M4 | MKT-4C | Billing UI: "Withdraw from contract", admin console for refunds, CN refund record, practice cost and Stripe health; history with paging and refunded marker (web) |
| M4 | MKT-4D | Enrichment v3: canonical skill ids at write time, honest keywords, requirements extracted once per posting (SM-6 write path, SM-8 job side) |
| M4 | MKT-4E | Canonical skills in the estimate and a three-state keyword check; fit-card checklist UI; skills gate (SM-6 read path) |
| M4 | MKT-4F | Feed: hybrid retrieval by reciprocal rank, the residual text as a ranking query, then the ranking refinements (SM-7, SM-9 feed part, SM-12) |
| M4 | MKT-4G | Scorer v4: requirement checklist with anchored statuses, server-computed numbers, resume-first prompt, pinned version per market (SM-8) |
| M4 | MKT-4H | Search surfaces outside the feed: planner relevance terms and the job-search API on both brands, Assistant job tools with cited ids (SM-9) |
| M5 | MKT-5A | Licensed feed (Active Jobs DB): hourly window sync with the expired feed behind the quota gate; Active Jobs DB for the mainland |
| M5 | MKT-5B | More board connectors: Workable, Recruitee, Personio, Lever EU, Greenhouse pay ranges and deadline; 北森 behind CN_ATS_BEISEN_ENABLED |
| M5 | MKT-5C | Closure and freshness: on-demand liveness check, three date facts, mainland unseen rule, sponsorship label rule |
| M5 | MKT-5D | New public sources: USAJobs and 事求人, and the source register document |
| M5 | MKT-5E | GoHire bank over the syndication endpoint: hardened HTTP adapter, mirror read for live cross-bank search, the contract for the second repository |
| M5 | MKT-5F | Taiwan extras: pay-rule note from config, district level and shift pattern with their filters, provenance and helper text |
| M5 | MKT-5G | Sponsorship facts with source and date: USCIS H-1B Employer Data Hub and the UK Register of Licensed Sponsors next to the DOL LCA loader |
| M5 | MKT-5H | Env examples for every variable of M2 to M5, the mainland deploy kit variables, and the final pass over the plan documents (OT-1; env docs of every later requirement) |

What needs the owner (keys, purchases, counsel, the second repository) is listed below; the full text is the strategy's §7 and section 6 of `market/MARKET_TASK_PLAN.md`. The gates the orchestrator runs between phases are in section 1 of that file.

### State of each phase (2026-10-12)

The wave is built. The gates ran on the merged tree with no payment provider, no model and no embeddings endpoint behind them (tests use fixtures and fakes), and the only database step was the additive schema push of M0 to the clone's database branch. What a gate applied and what it handed on is in `requests/waveM1-carryover.md` to `requests/waveM4-carryover.md`.

| Phase | What it delivered | State |
|---|---|---|
| M0 | The additive schema: the skill vocabulary, the embedding side tables, the search document columns, refund and consent-archive tables, the posting key and the board sync columns | Merged. Applied to the clone's database branch (pgvector installed first). Every other database still needs the same two steps before it runs this code |
| M1 | The Stripe safety rule, USD catalog defaults and the catalog sync; the pricing page from the plans API; the Taiwan pay parser; the evaluation harness; taxonomy precision; estimate v2 and the one fit | Merged and gated (`npm run eval:match -- --enforce M1`) |
| M2 | Alipay wire parity (additive); the Stripe webhook lifecycle, plan switch, resume, refunds and the pro-rata withdrawal; the billing UI; every surface on the one fit; the skill vocabulary; the search document and embeddings | Merged and gated (`--enforce M2`) |
| M3 | Quota read from response headers and one budget per provider; the planner without SEO seeds on JSearch; posting identity and closure; the employer boards with their own cron; the 台灣就業通 adapter; provider health in the admin System panel; nine mainland deep links specified; the Alipay cut-over runbook and the Stripe test recipe | Merged and gated. The deep links are built and **not delivered**: three boards are live |
| M4 | Self-service withdrawal and the admin billing console; enrichment v3 (canonical skills, requirement lines); skills in the estimate and the three-state keyword check; hybrid retrieval; scorer v4; the Assistant's job tools and the job-search API on both brands; 512 employer boards validated against their live public APIs | Merged and gated (`--enforce M4`; 758 test files, 19,637 tests, both type checks, `npm run check`). Not run: the Stripe test-mode pass, which needs the owner's test key |
| M5 | The licensed feed behind its quota gate and Active Jobs DB for the mainland; more board connectors and the 北森 connector behind its flag (off); closure, three date facts and the on-demand liveness check; USAJobs, 事求人 and the source register; the GoHire bank over the syndication endpoint (this repository's side); Taiwan extras; sponsorship facts with source and date; the env examples and this pass over the plan documents | The last phase: eight bundles built in parallel; they merge at the M5 gate (section 1 of `market/MARKET_TASK_PLAN.md`). What each really delivered is in its handoff, `orch/handoffs-mkt/MKT-5A.md` to `MKT-5H.md` |
| After M5 | The locale pass, once for the whole wave: merge `i18n/staging`, translate into the other eight locales, `npm run check` (requirement OT-2; the orchestrator's step) | Open |

Built and deliberately off or gated until the owner acts (nothing is fabricated to fill the gap, D3): the licensed feed (no paid plan yet; the free plan's monthly quota is used up), USAJobs (no key), the GoHire syndication transport (the route does not exist yet in the GoHire backend), the 北森 connector (counsel first), recruiter-bank rows on both brands (no candidate-facing posting page yet), six of the nine mainland deep links (URL patterns unconfirmed), Stripe Tax (`STRIPE_TAX_ENABLED`), public job pages (`PUBLIC_DISPLAY_PROVIDERS` is empty). On by default since phase M5, each with its own switch: the daily 事求人 read (`TW_GOV_JOBS_ENABLED`), the Workable connector (`ATS_WORKABLE_DISABLED`) and the on-demand posting check (`LIVENESS_CHECK_DISABLED`).

### Owner steps still open

The steps someone has to carry out, taken from section 6 of `market/MARKET_TASK_PLAN.md` and from the "Owner" sections of `requests/waveM1-carryover.md` to `requests/waveM4-carryover.md`. Those files hold the detail and the entry numbers. They also hold the choices a bundle made that only wait for a yes or a no; each is one place in code and runs on its default today, so they are not repeated here: step 42 says where they are. The steps the M5 bundles ask for come from their handoffs (`orch/handoffs-mkt/`): those of MKT-5A to MKT-5G, as they stood on 2026-10-12, are in this list. No secret and no account detail is repeated here; variables are named, values never.

**Databases and the first deploy**

1. On every database before it runs this code: `server/prisma/sql/001_vector.sql`, then the additive push, in the order of `server/prisma/sql/README.md` (the diff is shown to the owner before each push).
2. `ALLOWED_BRANDS=roboapply` on every Vercel environment until GoApply is to go live; remove it that day.
3. Read "What the first runs after this merge do" in `requests/waveM3-carryover.md` and `requests/waveM4-carryover.md` before the first cron run against a database: the first runs rewrite the standing queries and bank rows, load the seeded boards, start the Taiwan sweep (unless `TW_OPEN_DATA_JOBS_ENABLED=false`) and turn every stored fit stale. Since phase M5 they also read the 事求人 file once a day wherever the ingest cron runs for RoboApply (unless `TW_GOV_JOBS_ENABLED=false`), and the board sync starts checking and reading the Workable and Lever EU boards that discovery has recorded since M3 (step 31). Set the embedding key and run the skills CLI `embed-labels` before enrichment v3 runs there.
4. `JOB_SOURCES_CONTACT` and `CN_JOB_SOURCES_CONTACT` before the first production run, so the User-Agent of the board sync and the Taiwan sweep names a monitored mailbox or page.
5. Confirm the hosting plan allows one more cron entry (`jobs-boards`, every 5 minutes) and that the mainland stack runs the regenerated CronJob file.
6. On a deployment that sets `JOB_PROVIDERS_<BRAND>`, check the value: a list without `ats_public` now also stops that brand's board postings from being written.
7. The data steps, each with a dry run first: the role and pay backfills, the search-document backfill, the skills review round trip, the Traditional-to-Simplified table.
8. Measure the board sync on its first production day: requests and bytes per host, rows written per `jobs-boards` run, WAL volume per day, the size of the `RAJob` TOAST table, and the feed's p95 while a run is writing. Its cost was computed and never measured against a database. Record the feed's p95 before and after the deploy as well: its 150 ms gate has no measurement yet.
9. Look at the screens of phases M3 to M5 once in a browser, on both brands, light and dark, at 375 px and 1280 px: nothing of those phases was seen in a browser by the gates.

**Stripe (RoboApply)**

10. A Stripe test key and a `stripe listen` secret in the clone `.env`, with `NEXT_PUBLIC_ROBOAPPLY_URL` set to the clone's local web origin, `http://localhost:3621` (Checkout's return addresses are built from it), then the scenario pass of `market/STRIPE_TEST_RECIPE.md`. It was run at no gate; scenarios j, k and l come first, and one scenario checks the one assumption about Stripe's own data that the withdrawal amount rests on.
11. The live webhook endpoint subscribed to the fourteen event types, and its secret. Say whether the Stripe account is shared with RoboHire (the code assumes it may be).
12. A restricted key needs write access to Products, Prices and Billing Portal configurations and read access to Webhook Endpoints. A production that does not run on Vercel must set `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION`.
13. The tax route and the selling entity; then Stripe Tax and the registrations in the Dashboard; then `STRIPE_TAX_ENABLED=true`.
14. The retry schedule for failed renewals, in the Stripe Dashboard (Billing, Revenue recovery). It is a Dashboard setting; the code is correct for either end state, a deleted or an unpaid subscription.
15. With counsel: the withdrawal waiver for subscriptions in the EU, the UK and Taiwan, the label of the control per locale, the German wording of the cancellation button, and the staged withdrawal strings that wait for counsel (`requests/waveM4-carryover.md`, Owner 8); whether a plan switch is a purchase of its own; whether a renewal paid inside the 14 days goes back with its purchase; whether closing an account should refund unused paid time; whether the confirm must be bound to the quoted amount before the first sale (designed, not built).
16. Read the practice-cost panel and decide the pack prices; decide the one listing rule for student plans on both brands.

**Alipay (GoApply)**

17. `ALIPAY_CALLBACK_SECRET` in GoApply's environment, and whether production has it today (that decides `ALIPAY_SECRETLESS_UNTIL`).
18. Confirm that GoApply's own origin serves the callback from the deployment and database that create its orders, or name the origin for `CN_ALIPAY_NOTIFY_ORIGIN`; the pre-flight script proves it.
19. One supervised order with the five steps of `market/ALIPAY_CUTOVER.md`, the captured callback attached. Before the day: choose the test deployment's host (section 2.1 of that file) and name who can read the payment worker's log.
20. The legal name of the Alipay merchant (`CN_PAYMENT_COLLECTING_ENTITY`), confirmation that GoApply may sell through it, and who returns money in the merchant console.
21. Confirm that a mainland visitor on RoboApply gets a link to GoApply (no redirect), and do not point RoboApply's domain at this code before GoApply's domain serves the Alipay flow.
22. With counsel: GoApply's refund lines on `/pricing` (their stored version carries a pending-counsel mark until they are cleared), and whether keeping the `cn_pay_terms_ack` acknowledgement for 3 years after an account is deleted fits PIPL data minimisation.

**Job sources**

23. A paid Active Jobs DB plan: the RapidAPI listing, or a direct Fantastic.jobs key (`FANTASTIC_TRANSPORT=direct` and `FANTASTIC_API_KEY`; the marketplace subscription of Active Jobs DB is then not used at all). Before buying, measure the month with the vendor's count endpoint, with the filters the sync will send: with the thirteen default countries and no taxonomy filter the volume is far above a plan of 100,000 postings, so trim `INGEST_FEED_COUNTRIES` and set `INGEST_FEED_TAXONOMIES` until the count fits. A sync that does not fit never overspends; it stops at the day's budget, falls behind and says so in the log. Get the vendor's written answer on public pages and retention. The first week costs more than a normal one (the backfill of seven days): accept a partial backfill or raise `INGEST_FEED_DAILY_JOBS` for those days. On the first paid day watch the tally of the first runs: no response of this API was ever recorded, and the expired route of the RapidAPI listing could not be checked on the free plan (`FANTASTIC_EXPIRED_PATH` corrects it without a deploy). After a plan change in the middle of a period set `INGEST_QUOTA_RECHECK_HOURS` or `FANTASTIC_MONTHLY_JOBS`. For the mainland stack, check that the provider's host answers from a mainland network (handoff MKT-5A, Requests 7 to 10 and Known gaps 1, 2 and 10).
24. A free USAJobs API key and the contact e-mail it was issued to (`USAJOBS_API_KEY`, `USAJOBS_USER_AGENT_EMAIL`). The API was never called: on the first run with the key, have one page compared with the notes beside the fixtures (handoff MKT-5D, Known gaps 1).
25. In the GoHire / RoboHire repository, in the order of `market/GOHIRE_SYNDICATION.md` section 14: approve the work package (the syndication route, the verified-employer, consent and validity facts, and a candidate-facing posting page; until that page exists bank rows are held on both brands), issue the scoped service key, confirm GoHire's licence and supply `CN_HR_LICENCE_HOLDER` and `CN_HR_LICENCE_NUMBER`, run the read-only probe (`scripts/gohire-syndication-probe.mjs`). Then `GOHIRE_SYNDICATION_URL`, `GOHIRE_SYNDICATION_KEY` and the two posting-page templates, each template identical wherever crons run against one database.
26. Before the 北森 connector is ever switched on, the five steps of `docs/job-search/ATS_BOARDS.md` section 5.2: counsel's memo on reading employer boards in the mainland (it must cover public pages too if `PUBLIC_DISPLAY_PROVIDERS` is ever to include `ats_public`), a curated tenant list, one recorded real response with the mapper checked against it (the wire shape is unverified and the fixture is synthetic), `CN_JOB_SOURCES_CONTACT`, then the flag.
27. Mainland deep links. Two rulings first: whether the search pages of 前程无忧 and 拉勾 may be opened by hand to confirm a link pattern and whether linking to them is intended at all, and whether an agent may load the six pages in a browser. Then confirm the search URL pattern of each of the six boards from a mainland network; only confirmed patterns are shown.
28. Accept or change the launch criteria for the seeded boards (`market/BOARD_SEEDS.md` section 7). The mainland list holds 52 boards with a mainland posting, a margin of two over the 50 the strategy asks for.
29. In the admin sources console: name `lever/octoenergy` (or write the document that confirms the employer, or switch the board off); until then its postings show the company "octoenergy".
30. Decide `PUBLIC_DISPLAY_PROVIDERS` after reading `docs/job-search/SOURCE_REGISTER.md`; counsel on public display of employer-board rows and of JSearch rows. If USAJOBS rows go on public pages, decide whether to print the sentence its terms encourage (that the product is not run or endorsed by OPM).
31. Decide **before the deploy** whether the Workable connector stays on: the vendor does not document its endpoint for third parties, and the first board sync reads the Workable boards already recorded. While the decision is open, set `ATS_WORKABLE_DISABLED=true`. After the deploy, read one Greenhouse board that publishes pay ranges: the list call returns the pay key, and a filled range has not been seen on one yet (handoff MKT-5B, Known gaps 3).
32. Taiwan: how a 台灣就業通 posting with no deadline ends; a Taiwan-native reviewer for the Traditional Chinese role labels, then `zhHantReview` in `taxonomy.v1.json`; the postal code list if the engineer could not retrieve an official one; the pay rule when the amendment is promulgated (stored through the admin route `PUT /api/v1/roboapply/admin/tw/pay-rule`; the console has no form for it yet, and no deploy is needed); partnership outreach; which of the thirteen 事求人 staff categories that nothing confirms as open to the public may be listed (they are left out until a Taiwan reviewer says so). Optional: Taiwan counsel's check of the open-data credit sentence and a courtesy notice to the dataset's contact about the daily sweep.
33. Sponsor registers. First export one fiscal year from the USCIS hub as CSV and run its importer with `--dry-run`: the hub's current column layout was not read from a file. Then, per database, download the USCIS and UK sponsor register files and run the two importers (each with `--as-of` and a dry run first) and the existing LCA importer, and again when new files are published (handoff MKT-5G, Known gaps 1 and 2). With counsel, low: the UK register can list sole traders under their own names.
34. One read of a SmartRecruiters posting known to be closed, to see whether its API answers 404 or 400. With 400 the on-demand check confirms such rows but only their board sync closes them (handoff MKT-5C, Known gaps 4).

**Search and match**

35. Confirm the embedding processor for RoboApply resumes and profiles, and decide whether GoApply embeds in the mainland (`CN_EMBED_*`).
36. Confirm by eye two facts that were read through a fetch tool on 2026-10-11: the price row of the default embedding model (`server/src/lib/modelPricing.ts`, shown in `docs/LLM_COSTS.md`), and that Alibaba `text-embedding-v4` accepts at most 10 inputs per request (both env examples repeat that figure, with the date). A model with no price row, a mainland model for example, has its tokens logged and its cost recorded as unknown until its price is read on the vendor's own pricing page and a row is added.
37. The harness: about 400 pair judgments per market from recruiters; `EVAL_JUDGE_MODEL`; the first live run; the scorer recordings (the current scorer and the earlier one) and the retrieval vectors, so the gates that read `no_fixture` are measured. **The Chinese subset must pass on a real corpus before GoApply's production launch.**
38. A recruiter's pass over the engineer-written labels: the 100 skill pairs of the skills gate and the labelled title sets. Until then those gates guard against regressions and measure nothing about real postings.
39. Skills: approve the two public sources of identifiers and say whether Lightcast Open Skills may be used at all (no code reads it); review the most frequent skills and the certificate labels; decide what to do while a posting that enrichment has not rewritten yet is below the gate for "Not shown".
40. Approve the exploration slot in Recommended before it is built (it is in no bundle).
41. Later, when a market passes about 200,000 live rows: the dense leg needs an HNSW index, which the schema tool cannot declare and a push would drop. That needs a decision on how the schema is migrated.
42. Confirm or overrule the choices the wave made. They are listed at the end of section 6 of `market/MARKET_TASK_PLAN.md` (priors and the logistics rule, tier hysteresis, the Best fit blend, the reserve and tick shares, the cancel key, the tax rule for switch quotes) and, with the reason for each, under "Owner" in the four carry-over files (the entries headed "Decisions", "Choices" and "Known and accepted for now") and in the M5 handoffs. Of M5: whether a GoHire job with no recorded consent may be shown to signed-in GoApply users (today yes, and never on a public page); whether the weekly re-read of a bank should run for the mainland only; the 48 MB answer limit of the board connectors; whether 中班 should read "Evening"; whether a new pay floor on a Taiwan search should start as TWD a month.

## Open owner decisions

Most of these have a safe default, so the code does not wait on them.
1. **Neon branch and pushes.** Create the clone branch and run `pg_trgm`. Then confirm db push #1, the additive push at each wave gate (SCHEMA-2…5) and push #2 (OPS-A1).
2. **Prices** for each brand and interval, the 7-day pass, packs and the referral reward. Also whether to offer an optional "Welcome price". Decided since: D6 sets prices per market and the catalog carries real default amounts in code, so a plan is never "price not set" (`market/MARKET_STRATEGY.md` M-11 to M-13 and §4: GoApply's CNY ladder since the parity wave, RoboApply's USD ladder since phase M1 of the market wave; an env value is an override). There is no launch offer (OPS-B1, below).
3. **Public display of jobs.** Decide which providers' terms allow public pages (default: none). RoboHire/GoHire also need an employer consent-to-syndicate field before any bank job goes public or is opened to AI crawlers (OPS-A4).
4. **Recruiter opt-in in RoboHire/GoHire** for being contactable by candidates. Until it exists, hiring contacts stay as deep links only (OPS-A10).
5. **GoHire parsing for RoboApply resumes**, which sends them to a mainland server (OD-3). Default: off.
6. **Track A** (OPS-A7):
   - ship recording off by default;
   - sign off WP-43, WP-63a/b and WP-66.
7. **Copy-gate additions**, including the per-locale bans and the 北森/牛客 ban (OPS-A8).
8. **Stripe test-mode prices** for every plan key before INT (OPS-A9). *Superseded by MARKET_STRATEGY M-13 and M-15 (2026-10-11):* no price id has to be created or configured. Stripe products and prices are created from the catalog on first use, and `STRIPE_PRICE_<PLANKEY>` is only an optional pin. What browser verification needs from the owner is a Stripe **test** key (`sk_test_…`) and a `stripe listen` webhook secret in the clone `.env` (strategy §7 item 2); a live key is refused outside production.
9. **Counsel and privacy program** (OPS-C/D):
   - EU/UK representative;
   - DPAs with every processor;
   - auto-renewal, withdrawal and `/cancel` flows;
   - AI-generated markers on exports;
   - GoApply cross-border consent text (required whenever GoApply runs on the shared stack or offshore; it is generated from the stack in use), or a PIPL standard contract if any sensitive data is transferred;
   - whether the mainland deployment should run the strict posture (`CN_RESIDENCY_STRICT`, `CN_STORAGE_MODE=redact`, `CN_LLM_DOMESTIC_ONLY`);
   - the collecting entity for GoApply payments (no 二清). The Alipay rail no longer waits for it: the entity is printed once `CN_PAYMENT_COLLECTING_ENTITY` is set.
10. **GoApply staging:**
    - curation staff for the campus calendar (OPS-B4/B6). The calendar is on by default and stays empty until staff publish events (nothing is invented); `CN_CAMPUS_CALENDAR_ENABLED=false` hides it. It no longer depends on the recruitment-info mode;
    - the Chinese brand name (OPS-B3);
    - the mainland filing sequence C-1…C-17. The code does not wait for a filing: each licence or filing number is printed when it is set.
11. **GoApply launch scope and what it still needs** (D5): the nine items of `GOAPPLY_PARITY_PLAN.md` §8, summarised under D5 below.

## Owner decisions — 2026-10-10 (binding; answers to the plan's open items)

| Item | Decision |
|---|---|
| OPS-A1 clone database | **Neon branch** of the RoboApply project. The owner creates it and puts `DATABASE_URL` / `DIRECT_DATABASE_URL` in the clone worktree's `.env`; every additive push goes to the branch first, each diff shown to the owner. The main DB is pushed only at release. |
| Track A recording default | **Off.** Shipped on `main` in `8278e5f` (`INTERVIEW_ENGINE_RECORDING_ENABLED` is opt-in). WP-43 adds per-session consent, WP-63a the 90-day purge. |
| OPS-B1 prices | **The price ladders of `market/MARKET_STRATEGY.md` §4 (decisions M-11 and M-12), as catalog defaults in code.** RoboApply (USD, Stripe): Pro $9.99/week, $24.99/month, $54.99/quarter; 7-day pass $9.99; practice packs 5 for $9.99, 15 for $24.99; student $17.49/month, $37.99/quarter. GoApply (CNY, Alipay, non-renewing passes): ¥12 week / ¥39 month / ¥99 quarter; practice packs ¥29 / ¥79; student passes ¥29 month / ¥69 quarter. No launch offer. An env value is an override, never a prerequisite (M-13): `PRICE_<PLANKEY>_USD_CENTS` for RoboApply, `CN_PRICE_<PLANKEY>_FEN` (whole yuan) for GoApply. No Stripe price id has to be configured: prices are created from the catalog on first use, and `STRIPE_PRICE_<PLANKEY>` is an optional pin. A brand can open a payment once its rail's own credential is set (M-25): RoboApply the Stripe key **and** a webhook secret, GoApply `ALIPAY_CALLBACK_SECRET`; until then it lists its plans and prices. `CN_PAYMENTS_ENABLED` is a kill switch (unset means on; `false` stops GoApply charging). *The first form of this row (2026-10-10, the PRODUCT_PLAN §6.3 proposals) had the quarter at $59.99 and the 7-day pass at $6.99; both values are superseded by MARKET_STRATEGY M-11 (2026-10-11). Its §4.1 gives the two reasons: at $59.99 the floored "Save N%" label printed 19%, not the 20% the product plan promised, and at $6.99 the non-renewing pass undercut the weekly plan that grants the same thing.* |
| OPS-A8 copy-gate additions | **Approved as listed in TASK_PLAN R-12** (incl. `unlimited`, `guarantee` affirmative, standalone ATS/JD, per-locale auto-apply bans, zh 北森/牛客). |

## D5 — Brand parity (owner, 2026-10-11; binding, overrides TASK_PLAN R-13 / R-14 / R-15 and CN_TW gating)

> "Both GoApply and RoboApply should have the same robust functionalities; the differences are the job board, job sources, job search APIs."

- A capability that is on for RoboApply is **on for GoApply by default**. GoApply never ships a feature dark because a China-specific credential or licence is missing.
- China-specific providers (`CN_LLM_*`, `CN_EMAIL_*`, `CN_LIVEKIT_*` / `CN_VOICE_*`, SMS, WeChat) are **optional overrides**: when set they are used; when absent GoApply **falls back to the shared stack** (the same LLM routing, email transport and voice infrastructure RoboApply uses).
- What legitimately differs: the **job board, job sources and job-search APIs** per brand, and what follows from the market (default language, currency, payment rail, additional sign-in methods, legal footer).
- Consent prompts, AI-generated labels and GoApply's additional features (campus calendar, 内推码, 一键填表, AI 面试 format) stay: they add to the product, they do not remove from it.
- D1 (never submit an application) and D3 (never fabricate data) are unchanged and apply to both brands.

**Specification and status.** [`GOAPPLY_PARITY_PLAN.md`](GOAPPLY_PARITY_PLAN.md) turns this ruling into code and is implemented by the parity wave (11 bundles, [`orch/parity-bundles.json`](orch/parity-bundles.json); PAR-1, the foundation, is merged; verification in [`orch/parity-verify.md`](orch/parity-verify.md)). It supersedes TASK_PLAN R-03 (no `CN_X` to `X` fallback), R-13 (GoApply domestic-only models), R-14 (recruitment-info mode default `off`), R-15 (GoApply payments off), the invite-only GoApply sign-up and the "ships dark" principle of `CN_TW_LAUNCH_PLAN.md`.

**What it means in one table.**

| Area | GoApply with only the shared credentials | Optional override | Off switch or strict choice |
|---|---|---|---|
| Models (AI text, vision, Assistant, practice) | the same provider, models and fallback chain as RoboApply; the content-safety filter still runs on every GoApply call | `CN_LLM_PROVIDER`, `CN_LLM_MODEL` and the other `CN_LLM_*` settings, per key | `CN_LLM_DOMESTIC_ONLY=true` (mainland endpoints only) |
| Email | Resend through the shared key, sender name GoApply | `CN_EMAIL_TRANSPORT=aliyun_dm`, `CN_EMAIL_FROM` | `CN_EMAIL_TRANSPORT=none` |
| Voice and video practice | the shared LiveKit project, worker and speech models | `CN_LIVEKIT_*` (one group, anchored on `CN_LIVEKIT_URL`), the CN speech pair | `FLAG_GOAPPLY_INTERVIEW_VOICE=false`; `CN_INTERVIEW_CAMERA_PUBLISH=false` for audio only |
| Storage | the shared store, under a `goapply/` key prefix | `CN_S3_*` (one group, anchored on `CN_S3_BUCKET`) | `CN_STORAGE_MODE=redact\|discard`; `CN_RESIDENCY_STRICT=true` |
| Web push | the shared VAPID pair | `CN_VAPID_*` (anchored on `CN_VAPID_PUBLIC_KEY`) | `FLAG_GOAPPLY_WEB_PUSH=false` |
| Sign-up and sign-in | open, email + password first | phone OTP and WeChat appear when their credentials are set | `CN_SIGNUP_MODE=invite\|closed` |
| Job feed, recommendations, alerts | on (`CN_RECRUITMENT_INFO_MODE` unset reads as `licensed`) | — | `CN_RECRUITMENT_INFO_MODE=off` |
| Campus calendar | on; empty until staff publish events | — | `CN_CAMPUS_CALENDAR_ENABLED=false` |
| Plans and payments | CNY catalog defaults, purchasable through Alipay once `ALIPAY_CALLBACK_SECRET` is set | `CN_PRICE_<KEY>_FEN` (whole yuan), WeChat Pay merchant | `CN_PAYMENTS_ENABLED=false` |
| Coaching, student prices, free tools, public job pages, job-search API | on, under the same gates as RoboApply | — | `FLAG_GOAPPLY_<KEY>=false` |
| Deployment | every deployment serves both brands | — | `ALLOWED_BRANDS=roboapply` keeps GoApply closed; the mainland kit keeps `ALLOWED_BRANDS=goapply` |

The variables, with defaults, are in the repository-root `.env.example`; the mainland kit (`deploy/cn/`) asks for topology only.

**What stays different (by design).** Job sources and job-search providers; default language and locale set; currency and price ladder; the payment rail and plan shape (one-time passes on GoApply, subscriptions on RoboApply); Google and LINE sign-in (RoboApply) and phone and WeChat sign-in (GoApply); the legal footer; visa, H-1B, EEO and Taiwan fields (RoboApply); the campus calendar, 内推码, the deadline sort, the AI 面试 format, the consent prompts and AI-generated labels (GoApply).

**Two facts measured on 2026-10-11 that shape the GoApply job feed** (parity plan §3.9 and §10):

1. **A recruiter-bank job has no working apply link today.** `https://www.gohire.top/jobs/<id>` and `https://www.robohire.io/jobs/<id>`, the links the code used to build, render each site's "Page not found": neither product has a candidate-facing posting page. A job with no working apply link is never listed, so bank rows are synced, counted and **held** until the bank's page exists and its address is configured (`GOHIRE_PUBLIC_JOB_URL_TEMPLATE`, `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE`; no default). RoboApply builds no apply page for them (D1). The same rule holds RoboApply's RoboHire-bank rows. This corrects the sentence "a bank job opens the GoHire page" where it still appears without that condition: [`market/JOB_SOURCES_CN.md`](market/JOB_SOURCES_CN.md) §2.1 and §8 rule 3 (the display rule of its §5 depends on it), and the earlier form of `market/MARKET_STRATEGY.md` M-7, which now carries the condition as its finding C18. The files under `market/` are not edited by the parity wave; read them with this correction.
2. **The employer boards are the source that fills the GoApply feed in this wave.** A read-only probe of the documented job-board APIs our connectors already call found 27 public employer boards listing 1,828 postings located in mainland China. Each seeded board is re-checked through the connector; every posting opens on the employer's own page and shows its source. JSearch is not a GoApply source, and no mainland board is scraped. *Since the market wave: the mainland seed holds 52 boards (`market/BOARD_SEEDS.md`), and Active Jobs DB may add mainland postings only behind its paid-plan gate.*

**What still needs the owner** (parity plan §8; GoApply functions without any of these):

1. The Alipay credential in the GoApply environment (`ALIPAY_CALLBACK_SECRET`; `ALIPAY_API_URL` only if the worker is not the default). Until then plans and prices show and no payment can be opened.
2. Optional mainland providers for latency and deliverability: a domestic model, Aliyun DirectMail or a verified `goapply.top` sender, `CN_LIVEKIT_*` with DashScope speech, `CN_S3_*`, an SMS provider, WeChat credentials.
3. Legal note, cross-border processing: on the shared stack GoApply data is processed by the same offshore processors as RoboApply. Counsel reviews the consent wording and decides on `CN_RESIDENCY_STRICT`, `CN_STORAGE_MODE=redact` and `CN_LLM_DOMESTIC_ONLY` for the mainland deployment.
4. Legal note, camera video on GoApply: on, behind the per-session consent; `CN_INTERVIEW_CAMERA_PUBLISH=false` restores audio only.
5. Legal note, launch scope: a production deployment serves GoApply from its first deployment: through the brand override on its `*.vercel.app` hosts at once (no DNS change needed), and on `goapply.top` as soon as its DNS points there. **Set `ALLOWED_BRANDS=roboapply` on every Vercel environment (Production and Preview) before the wave branch is pushed**, and remove it on the day GoApply goes live. A mistyped value never opens GoApply: the deployment then serves RoboApply only and logs the bad value.
6. GoHire jobs on GoApply need a candidate-facing posting page and a syndication endpoint (or TLS on its database) in the GoHire / RoboHire repository.
7. Two confirmations on job data: move the six legacy `sourceBoard = 'gohire'` rows to `market = 'cn'`; and whether RoboHire-bank jobs located in mainland China may appear under GoApply.
8. Listings: the published GoApply extension build and store id; the first campus calendar events; more verified China-hiring employer boards (at least 50 before the production launch; *since phase M4 of the market wave the mainland seed holds 52, each answered by its live board API on 2026-10-11: `market/BOARD_SEEDS.md`*).
9. Google sign-in on GoApply: a decision. It stays RoboApply-only until the owner says yes and registers the GoApply redirect on the Google client.

One more decision the foundation bundle raised: should `CN_RECRUITMENT_INFO_MODE=false` (or `0`, `no`) close the GoApply job feed like `off`? Today only the word `off` does; any other value is read as `licensed` and startup logs it as a mistake.

Settings and decisions the other bundles raised in their handoffs (`orch/handoffs-par/`); none blocks GoApply:

- **Email sender.** On the shared Resend account GoApply mail goes out from the shared verified sender (`ROBOAPPLY_EMAIL_FROM`) under the name GoApply. Keep that variable set wherever GoApply runs: without it and without `CN_EMAIL_FROM` the sender is `noreply@goapply.top`, which Resend refuses while that domain is unverified.
- **Public job pages on GoApply** follow the same owner gate as RoboApply's (`PUBLIC_DISPLAY_PROVIDERS`, default empty). Employer-board postings get a signed-out page and a sitemap entry only once `ats_public` is in that list; signed-in users see them either way.
- **The GoHire bank is read only with `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true`** (the cross-tenant guard that already existed). Without it the bank is skipped and the feed fills from the employer boards.
- **`CN_STORAGE_MODE`.** `redact` removes ID numbers and health details from the stored text and keeps the uploaded file; `discard` keeps no original and no photo. An unknown value is read as `discard` (a typo in a privacy switch never keeps more than intended), unlike the other new switches, which read an unknown value as the default. Say if `redact` should also drop the file, or if this switch should match the others.
- **Integration keys on GoApply** return nothing until the operator adds `index` to `JOB_SEARCH_API_PROVIDERS` (or `CN_JOB_SEARCH_API_PROVIDERS`), the same rule as RoboApply's sources. Decide whether GoApply keys should return its index by default.

## D6 — Per-market sources, pricing and payment rails (owner, 2026-10-11; binding)

- **Job sources are per market.** Each market's job-search APIs and sources are researched and chosen on their own merits, together with the right way to search, retrieve and match jobs (`docs/jobright-clone/market/`).
- **Prices are set per market**: a USD ladder for the international brand and a CNY ladder for mainland China. Catalog defaults carry real amounts; a plan is never "price not set".
- **Mainland China pays with Alipay — the existing implementation. It must keep working exactly as it does.** New GoApply plans are mapped onto it additively; the request, callback and verification path is not rewritten.
- **The international brand pays with Stripe**, implemented fully (subscriptions, one-time passes and packs, webhooks, cancel, refunds, portal).

**Specification and status.** [`market/MARKET_STRATEGY.md`](market/MARKET_STRATEGY.md), with its research notes in `market/`. The parity wave already builds the parts of it that D5 needs (the list is `GOAPPLY_PARITY_PLAN.md` §9 and `TASK_PLAN.md` §14): the GoApply feed on by default with a source line on every card, the GoHire bank over HTTPS, employer-board postings located in mainland China entering GoApply's index, JSearch removed from GoApply and `linkedin` from RoboApply, characterisation tests for the twelve Alipay rules, the Alipay rail opening with its callback secret alone, the CNY catalog defaults with the kill switch, and GoApply student passes. The rest of that file's requirements were built by the market wave: six phases, M0 to M5, with the state of each phase and the owner steps still open in the section [Market wave (D6)](#market-wave-d6) above. Its owner list is its §7.
