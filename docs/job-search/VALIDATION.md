# Job search release verification

## Job Search Agent update — 2026-09-14

Implemented the explicit Search Job action, natural-language planning, a maximum of two bounded source searches, LinkedIn provenance filtering, per-query diagnostics, explicit filter overrides, cancellation, and the corresponding website/API endpoint. Public API documentation includes the agent request example. The shared integration skill now records agent quota and provenance invariants.

- **Full acceptance harness passed** under Node 24.21.0: **862 tests in 89 files**, including **245 focused tests in 14 files**. Server typecheck, design/copy/LLM-cost checks, and exact locale/ICU parity passed (1,458 messages across nine namespaces).
- **Production build passed**: Prisma client generation, Express compilation, and Next.js 16.3 webpack build in `/tmp/roboapply-agent-build.64ylhY`. No environment files were copied, no schema was pushed, and the active development `.next` directory was preserved.
- **Runtime contract smoke passed** against the running local Express application: OpenAPI returned 200 and exposed `agentSearchJobs`; an unauthenticated agent request returned 401 before planning.
- **Browser QA passed** using the actual components in the isolated fixture preview: desktop English/light and mobile Traditional Chinese/dark, explicit submit, resulting plan/criteria, LinkedIn-only, partial coverage, and visible publisher attribution. Screenshots are under `output/playwright/job-agent-*.png`. Fixtures clearly label fictional jobs and block live requests.
- **Independent review** found and resolved lowercase country display, role-less intent reported as a transient outage, and inability to override inferred LinkedIn-only intent. Adapter regressions now preserve LinkedIn URLs when employer application links are preferred and reject misleading hostname alternatives. The backend agent and primary agent cross-reviewed quota, cancellation, source rights, and HTTP behavior.

No paid model or provider evaluation was performed in this update. Natural-language planning has synthetic contract/behavior coverage; real-model interpretation quality remains unmeasured. Dedicated LinkedIn entitlement, live yield/latency, and additional standalone redistribution rights remain activation work, as documented in [LINKEDIN_STRATEGY.md](LINKEDIN_STRATEGY.md). These checks establish local implementation/build acceptance, not production deployment or complete LinkedIn inventory.

## Original service release — 2026-09-12

Verified locally on 2026-09-12 using **Node 24.21.0**. This records implemented and tested behavior, not a production deployment or commercial data license.

## Agent harness

| Workstream | Execution and evidence |
| --- | --- |
| Provider evaluation agent | Reviewed nine RapidAPI offerings against primary sources; wrote the rights matrix and reusable evaluation skill. |
| Backend service agent | Implemented provider orchestration, migrated live Fantastic endpoints, added the optional Hiring Index adapter, and ran provider/service regressions. |
| Website agent | Implemented the search, developer key, and public API guide screens, responsive styles, metadata, and interaction tests. |
| Website localization subagent | Translated 134 strings into eight additional locales and produced exact-key/ICU/API-identifier validation. |
| Primary agent | Product specification, API/key/quota layer, OpenAPI, integration tests, reusable integration skill, browser QA, and final acceptance harness. |
| Separate implementation review | Backend agent reviewed the primary agent’s API/key/quota code; closed a readiness/usage race, enforced zero quotas and explicit isolation, and added structured parser errors. A skill forward test confirmed website caches and merged source attribution cannot bypass partner permissions. |

## Automated acceptance

- `node scripts/job-search-harness.mjs --full`: **passed**.
- Full repository suite: **789 tests in 88 files passed**.
- Focused job-search/provider/website suite: **172 tests in 13 files passed** (included in the full suite, not additional tests).
- Server TypeScript: passed. Frontend TypeScript: passed both independently and during production build.
- Locale integrity: nine namespaces, 134 strings each, exact key/placeholder correspondence and source parity passed.
- Design, copy, and LLM-cost policy checks: passed.
- Both reusable personal skills passed `quick_validate.py`.
- `git diff --check`: passed.

Harness artifacts are local ignored files under `logs/job-search-*.log` and `logs/job-search-harness.json`. The harness runs offline fixtures and does not call paid providers.

## Build

Prisma generation, Express compilation, and Next.js 16.3.0 production build passed in an isolated copy at `/tmp/roboapply-search-build.ChfqzK`, with no `.env` files copied and no database schema push. The webpack build path was used so the copy could reuse installed dependencies by symlink. All three new page routes were included in the production route table. The final backend service adjustment was copied into that build and Express was recompiled successfully. The active development `.next` directory was not used by production build.

## Runtime and browser evidence

- Read-only PostgreSQL transaction verified the existing `ApiKey` and `ApiUsageRecord` contracts and the advisory-lock query. No records or schema were changed by this probe.
- The real Express app serves the OpenAPI document; unauthenticated integration access and session `/auth/me` requests return 401. Authentication implementation and session-cookie constants were preserved.
- Browser verification used the actual website components through the clearly labeled, network-isolated fixture preview at `http://localhost:3613/job-search`. Checked desktop light, mobile Traditional Chinese dark, search submission/results/partial coverage, and key creation/once-only display/confirmed revocation. It does not submit real applications or create real API keys.
- Screenshots are in `output/playwright/`; fixture screenshots demonstrate presentation and interactions, not live inventory.

## Live provider observations

The initial legacy Fantastic endpoint returned 404, leading to a verified migration to `/active-ats` and `/active-jb`. After that change, the Taiwan/Taipei smoke returned 14 valid Active Jobs DB postings in approximately 3.3 seconds. The bounded aggregate returned 10, all with descriptions, publication dates, and direct application links. None had normalized salary values.

JSearch separately returned six jobs in approximately 7.1 seconds but exceeded the 20-second deadline during the combined smoke. The response correctly retained the successful source and reported partial coverage. Hiring Index returned 403 with the current subscription, so it remains opt-in. These are bounded connectivity observations, not a full coverage or SLA benchmark. No job payloads or credentials were saved; aggregate evidence is in `logs/job-search-live-smoke.json`.

## Remaining activation work

External source resale is **not activated**. `JOB_SEARCH_API_PROVIDERS` stays empty until the applicable integration redistribution rights are recorded. Existing website subscriptions do not imply those rights. Hiring Index needs an entitled subscription before activation. No subscriptions were purchased, vendor messages sent, production schema pushed, or public deployment performed.

The code, website, API contract, tests, provider evaluation, reusable skills, and local preview are complete. Production activation follows [RUNBOOK.md](RUNBOOK.md).
