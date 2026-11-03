# RoboApply engineering handbook

As of 2026-11-03 (main @ b89d5256).

Start here if you are new to the project. The handbook is the current picture of the product, the code and how we work; the older documents in `docs/` are the specifications and records behind it, and the map at the end says which of them still bind.

## Reading order

| # | Chapter | Read it to learn |
|---|---|---|
| 01 | [Product overview](01-product-overview.md) | What RoboApply and GoApply are, the owner rulings (D1 to D6), the user journey, routes, prices, locales |
| 02 | [Architecture](02-architecture.md) | The components and how they connect, request flow, brand resolution, auth, background work, configuration layers, what stops the API from booting |
| 03 | [Codebase map](03-codebase-map.md) | Where things live, the conventions to follow, where to add a route or a page, a "where do I look for X" table |
| 04 | [Local development](04-local-development.md) | Setup, env files and their precedence, running the stack, **which database your `.env` points at**, signing in locally |
| 05 | [Data model](05-data-model.md) | The multi-file Prisma schema, core entities, JSON columns, schema-change rules, purge and encryption |
| 06 | [AI and LLM stack](06-ai-and-llm-stack.md) | How a model is chosen (admin blob over env), fallbacks, brand policy, the Assistant's tool streaming, thinking-token headroom, how to change a model safely |
| 07a | [Feature guide: jobs](07a-feature-guide-jobs.md) | Job sources and ingestion, feed and retrieval, fit scoring, resume, tracker, alerts, Assistant, extension |
| 07b | [Feature guide: interview, billing, platform](07b-feature-guide-interview-billing-platform.md) | Practice interviews (voice and text, prep agents), credits and billing (Stripe, Alipay), growth and mail, admin, SEO, GoApply and compliance |
| 08 | [Testing and quality gates](08-testing-and-quality-gates.md) | Vitest, running one test, `npm run check`, CI, i18n, the pre-PR checklist |
| 09 | [Deployment and operations](09-deployment-and-operations.md) | Vercel topology, crons, production env, release and rollback, logs, incident table |
| 10 | [Status and roadmap](10-status-and-roadmap.md) | What is shipped, what is blocked on the owner, what to pick up next, risks and debt |

For a first week: read 01 to 03 on day one, set up with 04 and run the suite with 08, then take a near-term task from 10 §5 and read the 07 section and the spec it points to before you change code.

## Rules that are easy to break

Each is explained in the chapter named. Breaking one has cost real time before.

| Rule | Where |
|---|---|
| The product never submits a job application (D1). It prepares and fills; the user clicks Submit. Copy never claims auto-apply. | [01](01-product-overview.md) |
| Never fabricate data, sources, prices or counts (D3). Simulated interviewers are labelled simulated; a company's interview style is "from public sources" only when sources are cited. | [01](01-product-overview.md), [07b](07b-feature-guide-interview-billing-platform.md) |
| Both brands have the same features (D5). A `CN_<NAME>` variable is an optional override of `<NAME>`, never a gate. Sources, prices and payment rails are per market (D6). | [01](01-product-overview.md), [02](02-architecture.md) |
| The Alipay path and its tests are frozen. Do not edit them. | [07b](07b-feature-guide-interview-billing-platform.md) |
| Schema changes are additive only. There is no migrations folder; `db push` applies the schema. Never push to a database you have not identified. | [05](05-data-model.md) |
| The main checkout's `.env` points at the **production** database, and a local API runs the platform crons (alerts, mail, push, queue drain) in process unless you switch them off. | [04](04-local-development.md) |
| The local `.env` may hold a live Stripe key. No test or command may call Stripe or another paid provider. | [04](04-local-development.md) |
| In production the admin `llm_stack.production` row overrides the Vercel env. The Assistant needs a model whose provider streams tool calls, or the production API refuses to boot. | [06](06-ai-and-llm-stack.md), [09](09-deployment-and-operations.md) |
| After a deploy, check an `/api/v1/*` route. `/api/health` is served by Next and stays green when the API is down. | [09](09-deployment-and-operations.md) |
| Frontend code talks to the API only through `lib/api/`. Server relative imports keep their `.js` suffix. Route handlers stay thin. | [03](03-codebase-map.md) |
| User-facing copy changes go into all nine locales, and `npm run check` must pass. | [08](08-testing-and-quality-gates.md) |
| Never commit `.env`, `.env.local`, keys or production data. Document configuration in `.env.example`. | [04](04-local-development.md) |

## Map of the older documents

| Document | Status | Use it for |
|---|---|---|
| [`docs/jobright-clone/README.md`](../jobright-clone/README.md) and its plans (`TASK_PLAN.md`, `PRODUCT_PLAN.md`, `ARCHITECTURE.md`, `GOAPPLY_PARITY_PLAN.md`, `CN_TW_LAUNCH_PLAN.md`, `FEATURE_CATALOG.md`) | **Binding** owner rulings D1 to D6; the plans are the record of the two-brand build (merged 2026-10-12) | Scope and contracts of a feature, per-brand behaviour |
| [`docs/jobright-clone/market/`](../jobright-clone/market/) (`MARKET_STRATEGY.md`, `MARKET_TASK_PLAN.md`, `ALIPAY_CUTOVER.md`, `STRIPE_TEST_RECIPE.md`, `BOARD_SEEDS.md`, `GOHIRE_SYNDICATION.md`) | **Binding** for sources, prices and payment rails (D6) | Job sources, prices, Stripe and Alipay work |
| [`docs/jobright-clone/HANDOFF.md`](../jobright-clone/HANDOFF.md) | Record; §2 is stale (the work is on `main` now), §6 lists owner items | The verification recipe and the owner list |
| [`docs/jobright-clone/requests/`](../jobright-clone/requests/), [`orch/`](../jobright-clone/orch/) | Carry-over lists and the verification report | Open follow-ups from the build |
| [`docs/interview-practice/PREP_AGENTS.md`](../interview-practice/PREP_AGENTS.md) | Current | Before changing the practice setup, `interview-engine/prep/` or `skills/` |
| [`docs/roboapply/OVERHAUL_RULINGS.md`](../roboapply/OVERHAUL_RULINGS.md), [`ONBOARDING_SPEC.md`](../roboapply/ONBOARDING_SPEC.md), [`OVERHAUL_SPEC.md`](../roboapply/OVERHAUL_SPEC.md) | Binding where not superseded: the colour and type rulings gave way to Paper; auto-apply is gone | Product positioning, onboarding |
| [`docs/design-system.md`](../design-system.md), [`docs/skillry-style-reference.md`](../skillry-style-reference.md) | **Current** design system (Paper, October 2026) | Any UI work |
| [`docs/job-search/`](../job-search/) | `RUNBOOK.md`, `SOURCE_REGISTER.md`, `ATS_BOARDS.md` current; `LINKEDIN_STRATEGY.md` and `PROVIDER_EVALUATION.md` superseded (LinkedIn dropped); `PRODUCT_SPEC.md` describes a page that now redirects to `/jobs/explore` | Job-search API and providers |
| [`docs/CROSSBANK_JOBSEARCH_SPEC.md`](../CROSSBANK_JOBSEARCH_SPEC.md) | Spec of the RoboHire/GoHire bank search | Cross-bank jobs |
| [`docs/LLM_COSTS.md`](../LLM_COSTS.md) | Generated by `npm run llm:costs` from `server/src/lib/modelCostTable.ts` | Model prices |
| [`docs/runbooks/`](../runbooks/) | Current runbooks: mainland deploy, Edge add-ons publish | Operations |
| [`docs/ENGINEERING_PLAN.md`](../ENGINEERING_PLAN.md), [`docs/TASK_PLAN.md`](../TASK_PLAN.md) | Historical (July 2026 extraction from RoboHire); partly stale: the database is no longer shared, there are 16 crons, not 7 | Why the deploy looks the way it does |
| [`docs/LANDING_GAP_ANALYSIS.md`](../LANDING_GAP_ANALYSIS.md) | Stale (July 2026: auto-apply, old prices) | Background only |

## Keeping the handbook current

Update the chapter in the same change as the code it describes, and move the "As of" line. When a plan document and the code disagree, the code is the truth; say so in the chapter and fix or mark the plan. Chapter 10 is the one to touch whenever an owner item is done or a branch lands.
