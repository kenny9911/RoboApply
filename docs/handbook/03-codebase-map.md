# Codebase map

As of 2026-11-03 (main @ b89d5256).

A guided tour of the source tree: what each directory is for, the conventions the code actually follows, and where to look for common tasks. For how the pieces talk to each other at runtime, read [02-architecture.md](02-architecture.md) first; models are in [05-data-model.md](05-data-model.md) and the gates in [08-testing-and-quality-gates.md](08-testing-and-quality-gates.md).

The repository holds four separately built packages:

| Package | Root | Build / test |
|---|---|---|
| Web app + API (one `package.json`) | repo root, `server/` | `npm run build`, `npm test`, `npm run typecheck:server`, `npm run typecheck:web`, `npm run check` |
| Voice worker | [`interview-agent/`](../../interview-agent) | `npm --prefix interview-agent run typecheck` / `test` |
| Browser extension | [`extension/`](../../extension) | `npm --prefix extension run typecheck` / `test` / `build` |
| (none; data and kits) | `deploy/`, `rules-research/` | n/a |

CI ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) runs all three packages' typecheck and tests plus `npm run check`.

## 1. Frontend (repo root)

### `app/` — routes

Next.js 16 App Router. Route groups (parenthesised folders do not appear in the URL):

| Folder | What lives there | Gate |
|---|---|---|
| [`app/(auth)/`](../../app/(auth)) | The signed-in product: `jobs`, `applications`, `resume`, `practice` (the four main destinations), plus `settings`, `profile`, `assistant`, `ready`, `inbox`, `invite`, `coaching`, `referrals`, `job-search` (API keys page) and `admin` (the admin console). The layout mounts the app shell and the global slots (Assistant rail, out-of-credits sheet, announcements, tour). | Every first segment must be listed in [`lib/proxyPaths.ts`](../../lib/proxyPaths.ts); a test enforces it. |
| [`app/(onboarding)/`](../../app/(onboarding)) | `onboarding/[step]`, the setup flow. Sits outside the app shell, so it must use theme tokens rather than literal colours. | Protected prefix. |
| [`app/(public)/`](../../app/(public)) | `login`, `signup`, `forgot-password`, `reset-password`, `verify-email`, `bind-phone`. | Public. |
| [`app/[locale]/`](../../app/[locale]) | Localized landing pages (`/es`, `/ja`, ...; only locales the brand serves, others 404). | Public. |
| `app/page.tsx` | The marketing landing at `/`, always served, signed in or not. | Public. |
| Other top-level folders | Public SEO and utility pages: `job/[idSlug]` (public job page), `browse/`, `campus/` (GoApply), `features/[slug]`, `tools/` (free tools), `pricing`, `legal/[doc]` (reads `content/legal/<market>/*.md` at request time), `help`, `security`, `about`, `developers/job-search`, `extension`, `r/[code]` (referral links), `unsubscribe/[token]`, `alerts/confirm`, `cancel`, `auth/callback` (OAuth). Also `sitemap.xml`, `sitemaps/`, `robots.ts`, `llms.txt`, `manifest.webmanifest`. | Public. |
| [`app/api/`](../../app/api) | Next route handlers `health` and `revalidate` (SEO cache invalidation, gated by `INTERNAL_API_SECRET`). Everything else under `/api/v1/*` is Express. | n/a |

Routing rules that are easy to break:

- **Redirects live only in `next.config.mjs` `redirects()`.** `proxy.ts` does brand, auth gate and `x-pathname`, and deliberately nothing else; two copies of the router once reversed a product decision. Old routes (`/home`, `/tracker`, `/mock-interview`, `/account`, ...) 308 to their successors there.
- The root layout is `force-dynamic`, which is why [`pages/`](../../pages) exists: a Pages Router `404.tsx` / `500.tsx` (plus the `_app` / `_error` Next requires alongside them) so the static error pages prerender. Nothing else uses the Pages Router.

### `components/`

| Folder | Contents |
|---|---|
| [`components/features/<area>/`](../../components/features) | Most product UI, one folder per area, mirroring the server's feature areas (`feed`, `match`, `tailor`, `resume`, `practice`, `copilot`, `credits`, `onboarding`, `tracker`, `settings`, `marketing`, ... and the GoApply-only `*-cn`, `campus`). New UI goes here. |
| [`components/v3/`](../../components/v3) | The app shell and design primitives. `v3/shell/` holds `HybridShell` (the frame), `Sidebar`, `MobileNav`, `CommandPalette`, and [`destinations.ts`](../../components/v3/shell/destinations.ts), the single per-brand navigation list every nav surface reads. `v3/primitives/` holds `Btn`, `Sheet`, `Modal`, `Tabs`, `FitMeter`, `EmptyState`, ... Other `v3/` folders are earlier screens still in use (resume editor, account, admin). |
| `components/ui/`, `components/auth/`, `components/landing/`, `components/job-search/`, `AuthGate.tsx` | Older generic pieces, auth screens, landing helpers, the developer API key workspace, and the client-side session gate. |

Design rules (Paper design system: warm paper, ink actions, lime highlighter) are in [docs/design-system.md](../design-system.md) and enforced by `npm run check:design`.

### `hooks/`

One folder per area (`hooks/feed`, `hooks/tailor`, `hooks/practice`, ...) wrapping `lib/api/*` calls in TanStack Query. [`hooks/shared/`](../../hooks/shared) holds cross-area hooks: `useCredits`, `useCreditGate` (opens the out-of-credits sheet on a 402), `useEntitlements`, `useLaunchTailor`, `useLaunchPractice`, `useOpenAssistant`. A few older single-file hooks sit at the top level (`useAccount`, `useAdmin`, `useViewAs`, ...).

### `lib/`

| Path | Purpose |
|---|---|
| [`lib/api/`](../../lib/api) | **The only code that talks to the API.** [`client.ts`](../../lib/api/client.ts) is the fetch wrapper (credentials, error normalisation into `RoboApiError.code`, stale-session redirect, view-as-ended reload, dev brand header); one module per area (`feed.ts`, `match.ts`, `credits.ts`, ...). `lib/api/contracts/<area>.ts` are type-only re-exports of the server's `contract.ts` files. `lib/api/v2/` is the older V2 surface, with a stub implementation (`lib/stub/`) used only in tests or with `NEXT_PUBLIC_USE_STUB_API=true`. `npm run check:api-boundary` fails on a new raw `/api/v1/` string anywhere else in `app/`, `components/`, `hooks/` or `lib/` (existing offenders are baselined in `scripts/api-boundary-baseline.json`). |
| [`lib/brand/`](../../lib/brand) | Web brand runtime, `BrandProvider`, metadata, `%BRAND%` token substitution, and the generated registry mirror (never edit `registry.generated.ts`; run `npm run gen:brand`). |
| [`lib/server/`](../../lib/server) | Server-only helpers for server components: `brand.ts` (reads the proxy's `x-ra-brand`), `publicApi.ts` (cached server-side reads of the public SEO API; the one other place allowed to name `/api/v1/`). |
| [`lib/auth/`](../../lib/auth) | `AuthProvider`, `useAuth`, sign-in routing, two-step sign-in. |
| [`lib/flags.ts`](../../lib/flags.ts) | `useFlag` / `useCapabilities`; fails closed. |
| `lib/config.ts`, `lib/proxyPaths.ts` | `API_BASE`, `SESSION_COOKIE_NAME`; the protected-path list shared by the proxy and the API client. |
| `lib/i18n.ts`, `lib/localeConfig.ts`, `lib/serverLocale.ts`, `lib/locale.ts` | Locale constants (light, client-safe) versus bundle loading (server-side), locale resolution from cookie and path. |
| `lib/seo.ts`, `lib/pricing.ts`, `lib/ui/popupGate.ts`, `lib/theme.tsx`, ... | Single-purpose helpers. |

### `i18n/`, `content/`, `styles/`, `public/`

- [`i18n/messages/<locale>.json`](../../i18n/messages): the nine web bundles (`en`, `zh`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `pt`, `de`), loaded by next-intl. [`i18n/brands/goapply/`](../../i18n/brands/goapply) holds GoApply word overrides for existing keys (no new keys). [`i18n/staging/`](../../i18n/staging) is the multi-agent wave pipeline (section 3). [`i18n/glossary/zh-variants.json`](../../i18n/glossary) feeds the Simplified/Traditional check.
- [`content/legal/<market>/`](../../content/legal): legal documents as Markdown, read at request time by `app/legal` and shipped to the API function via `includeFiles`.
- [`styles/`](../../styles): global CSS and `tokens.css` (design tokens) plus per-area sheets and `styles/brands/`.
- [`public/`](../../public): static assets and `sw.js` (the push service worker).

## 2. Server (`server/src/`)

`app.ts` builds the Express app (pipeline in [02-architecture.md §2](02-architecture.md#2-request-flow)). The rest:

### `features/` — the product, one folder per area

Mounted from the single table `FEATURE_MOUNTS` in [`features/index.ts`](../../server/src/features/index.ts). A typical area has `contract.ts` (zod schemas and wire types), `routes.ts` (thin router factory `create<Area>Router(deps)`), `service.ts`, a `repo.ts` / `store.ts` (Prisma access, sometimes with a `memoryStore.ts` for tests), `workers.ts` (queue handlers), `cron.ts`, and `index.ts` (public surface).

| Area | Responsibility |
|---|---|
| `auth`, `auth-cn`, `account-v2` | New auth paths (OAuth, devices, sign-up policy); GoApply phone OTP and WeChat; two-step sign-in (TOTP) and student status. |
| `onboarding`, `onboarding-cn` | Setup stage machine and first job matches; GoApply schools, provinces and market snapshot. |
| `profile` | Candidate profile, completeness, resume sync, sensitive-field encryption, Taiwan fields. |
| `search` | Search profiles (the one preference store) and the job taxonomy. |
| `feed` | Ranked, paginated job feed (hybrid SQL + vector retrieval, affinity, ranking), plus a public feed. |
| `jobs` | Everything about postings: `ingest` (planner, quota, provider adapters, board sync, upsert), `sources` (source registry, employer ATS boards and their seeds, Taiwan open data), `normalize`, `enrich` (LLM enrichment), `detail`, `companies`, `import` (user-imported jobs), `liveness`, `geo`, `taxonomy`, `backfill`. |
| `retrieval` | Search documents and embeddings for jobs and users; Traditional/Simplified folding. |
| `match` | Fit scoring (pre-score, scorer v4, calibration, competitiveness, evidence), score precompute, the evaluation harness (`npm run eval:match`). |
| `skills` | Skill vocabulary, canonicalisation, seeds and a CLI (`npm run skills`). |
| `copilot` | The Assistant: tool-calling chat, tools, budgets, guardrails, proposals. |
| `resume` | Resume suite: `tailor`, `builder`, `check`, keywords, layout. |
| `coverletter`, `offers`, `network` | Cover letters; offer comparison; outreach drafts and contact import. |
| `tracker` | Application tracker additions (follow-ups, CSV export, events). |
| `agent` | "Ready" weekly preparation and reminders (never applies for the user). |
| `extension` | Extension device auth, autofill answers and question types. |
| `credits`, `billing-cn` | Credits API, plans, cancellation, admin billing; WeChat Pay. |
| `notifications`, `push`, `notify-cn`, `alerts`, `lifecycle`, `announcements` | In-app notifications and email, web push, WeChat MP notices, job alerts, lifecycle email, "What's new". |
| `growth`, `visitor`, `seo`, `tools` | Invites and referrals, attribution; logged-out Assistant and alerts; SEO pages; free tools. |
| `prep`, `coaching` | Interview question bank; human coaching roster. |
| `compliance` | Consents, legal documents, data export and purge, AI labels, retention. |
| `cn/` | GoApply-only: `jobs`, `campus`, `referrals` (内推码), `interview`, `tracker` ladder. |
| `tw` | Taiwan: pay-disclosure rule, county and district table. |
| `admin`, `support`, `uistate`, `brand`, `interview` | Admin console API (users, view-as, overrides, costs, queue, moderation); support tickets; per-user UI state; public brand + capabilities; interview retention cron. |

Rules from `features/index.ts`: a feature router declares only paths no legacy router serves; capability checks are per route (`requireFlag(key)` after auth), never `router.use(requireFlag)`; admin routers mount at `/api/v1/roboapply/admin/<area>` behind `requireAuth + requireAdmin`. Unfinished handlers are tagged `markStub` and answer 501.

### Other server directories

| Path | Purpose |
|---|---|
| [`roboapply/`](../../server/src/roboapply) | The code extracted from RoboHire. `routes/` are the still-live legacy routers (`auth`, `billing`, `account`, `stripeWebhook`); `engine/` holds seeker sessions, `seekerAuth` and the profile service; `services/` billing, reminders, account purge and data wipe; `schedulers/` the node-cron mirror and graceful shutdown; `v2/` the V2 router aggregate (`goal`, `tracker`, `resumes`, `insights`, `preferences`, `mock`, `discover`, `admin`) with its `RA*` agents and services (tailor, rewrite, match scorer, interview generators, cross-bank search). Much of the live resume and tracker API still runs here; feature areas extend these paths additively. |
| [`interview-engine/`](../../server/src/interview-engine) | Practice-interview control plane: `sessions/` (`InterviewSessionService`), `routes/` (internal UI routes, `/v1` external and `/practice`, worker `callbacks`, LiveKit and Parley `webhooks`), `prep/` (job search, industries, per-job plans, company style; see [PREP_AGENTS.md](../interview-practice/PREP_AGENTS.md)), `skills/`, `providers/` (per-brand voice plane), `livekit/`, `parley/`, `scoring/`, `prompt/`, `catalog/`, `storage/`, `billing/`. |
| [`platform/`](../../server/src/platform) | Cross-cutting services: brand, flags, http envelope, SSE, LLM policy, embeddings, credits, billing rails, email, queue, rate limit, residency, PII, SMS, view-as, startup. One line each in [02-architecture.md §7](02-architecture.md#7-platform-services-serversrcplatform). |
| [`services/`](../../server/src/services) | Older shared services: [`services/llm/LLMService.ts`](../../server/src/services/llm/LLMService.ts) and the provider classes, `LoggerService`, `EmailService` (legacy; new mail goes through `platform/email`), resume parsing (`ResumeParserService`, `GoHireResumeParseService`, `DocumentParsingService`), `PDFService`, storage. |
| [`agents/`](../../server/src/agents) | `BaseAgent` (LLM call, language detection, retry) and the original resume parse and match agents. Newer agents live beside their feature (`features/*/…Agent.ts`, `roboapply/v2/agents/`). |
| [`lib/`](../../server/src/lib) | Prisma client (`prisma.ts`, pooled URL handling), request context (AsyncLocalStorage), cookie options, `lib/llm/` (model selection, the `llm_stack` AppConfig resolver, per-task settings), model cost table, PDF parsing, BYOK keys, subscription gate. |
| [`middleware/`](../../server/src/middleware) | `auth.ts` (`requireAuth`, `optionalAuth`, view-as, brand gate), `admin.ts`, `usageMeter.ts`, `userActivity.ts`. |
| [`cron/handlers.ts`](../../server/src/cron/handlers.ts) | Every Vercel Cron endpoint and the `PLATFORM_CRON_JOBS` table. |
| [`job-search/`](../../server/src/job-search) | The Job Search API: a public API-key product at `/api/v1/job-search` and the website's own router at `/api/v1/roboapply/v2/job-search`; keys, quota, OpenAPI, the hiring index. |
| [`brands/`](../../server/src/brands) | **Not the product brand.** RoboHire/GoHire recruiter-bank config selected by `APP_NAME` (via `lib/brand.ts`). |
| [`i18n/email/`](../../server/src/i18n/email) | Email strings in the nine locales (+ `staging/`). |
| `types/`, `utils/`, `test/` | Shared types (Express `req.user`), small utilities, server test harness (`routeHarness.ts`, `fakePrisma.ts`). |
| `generated/` | Prisma client output. Generated by `npm run db:generate` (also on `npm install`); gitignored; never edit. |

### Database schema

[`server/prisma/schema/`](../../server/prisma/schema) is a multi-file schema loaded as one folder ([`prisma.config.ts`](../../prisma.config.ts)): `_datasource.prisma` (generator and datasource), `legacy.prisma` (the models inherited from RoboHire: `User`, `Session`, `AppConfig`, ...) and one `ra-<area>.prisma` per area (`ra-jobs`, `ra-match`, `ra-feed`, `ra-credits`, `ra-platform` with `RAWorkItem`, ...). Layout and model docs: [ARCHITECTURE.md §2](../jobright-clone/ARCHITECTURE.md). Schema changes are additive only; review SQL with `scripts/check-schema-additive.mjs` and follow [HANDOFF.md §5](../jobright-clone/HANDOFF.md). Do not `db push` against a database you have not identified. `server/prisma/sql/` holds hand-written SQL (pgvector).

## 3. Other top-level directories

| Path | What it is |
|---|---|
| [`interview-agent/`](../../interview-agent) | LiveKit voice worker (`src/main.ts`, `agent.ts`, `callbacks.ts`, `backends/`, `plugins/`), with `Dockerfile`, `docker-compose.yml` and `deploy/` recipes. Run locally by `npm run dev` through the supervisor script. |
| [`extension/`](../../extension) | MV3 extension: `src/adapters/` (ATS form adapters, `intl` and `cn`), `background/`, `content/`, `popup/`, `brands/`, own `i18n/`. Only `src/adapters/_kit/interact.ts` may click. |
| [`deploy/cn/`](../../deploy/cn) | GoApply mainland kit: API/web/gateway Dockerfiles, compose, env examples, Kubernetes manifests and preflight. |
| [`scripts/`](../../scripts) | See below. |
| [`__tests__/`](../../__tests__) | Root Vitest tests that span modules: brand parity and invariants, proxy paths vs route tree, contract mirrors (`contracts/`), deploy parity (`deploy/`: cron parity, env example, deploy kit), route shells, components and hooks. `setup.ts` is the global Vitest setup. |
| [`e2e/ia-dry-run.py`](../../e2e/ia-dry-run.py) | A Playwright (Python) walk of the information architecture through real UI clicks; run by hand against a running stack. |
| [`pages/`](../../pages) | Pages Router error shadows only (section 1). |
| [`rules-research/`](../../rules-research) | Two JSON files of bilingual hiring rules (cross-industry, public sector). Nothing in the source imports them; they appear to be research data for RoboHire's rules feature (unverified). |
| `output/`, `logs/` | Local artifacts, gitignored (`output/playwright/`, daily `logs/*.jsonl` from `LoggerService`). Not part of the product. |
| `.claude/worktrees/` | Agent worktrees from parallel sessions; not part of the product, excluded from Vitest. |

### Scripts worth knowing

| Script | Does |
|---|---|
| `dev-web-after-api.ts`, `dev-interview-agent.sh`, `restart.sh`, `dev-clone.sh` | Dev stack: readiness-gated web start, worker supervisor, scoped restart, second two-brand stack on 4621/3621. |
| `gen-brand-mirror.mjs` (`npm run gen:brand`) | Copies the brand registry to `lib/brand/registry.generated.ts`; `--check` for drift. |
| `check-design.mjs`, `check-copy.mjs`, `check-zh-variants.mjs`, `check-api-boundary.mjs`, `check-extension-no-submit.mjs`, `print-llm-costs.ts --check` | The six gates behind `npm run check`: design rules, banned words and equal key sets across the nine bundles, Simplified vs Traditional vocabulary, the `lib/api` boundary and typed Prisma in new code, the extension never submits, `docs/LLM_COSTS.md` matches the cost table. |
| `i18n-merge-staging.mjs` (`npm run i18n:merge`) | Folds `i18n/staging/*` into the bundles and writes `_pending-translation.json`. |
| `check-schema-additive.mjs` | Refuses a schema diff that drops, renames or tightens anything. |
| `gen-cn-cronjobs.mjs` | Regenerates the mainland Kubernetes CronJobs from `vercel.json`. |
| `verify-llm-brand.ts` (`npm run verify:llm`) | Shows how each LLM task resolves per brand; `--probe` sends a 1-token request (costs money). |
| `alipay-notify-preflight.mjs`, `parley-provision.ts`, `parley-vercel-env.sh` | Alipay cut-over check; Parley pilot setup. |
| `board-seeds/`, `job-search-*.{mjs,ts}`, `tw-jobno-catalog.mjs`, `gohire-syndication-probe.mjs` | Job-source tooling (seed validation, harnesses, probes). Several call real providers. |

## 4. Conventions

These are checked against the code, and most are enforced by a test or a gate.

**Server modules.** The server compiles with `module: NodeNext`, so every relative import in `server/src` ends in `.js` (`import { route } from '../../platform/http.js'`), even from `.ts` files. A missing suffix typechecks in some editors and fails at runtime. The root `package.json` and `server/package.json` both mark ESM; [`api/index.ts`](../../api/index.ts) explains why both are needed on Vercel.

**Thin handlers.** A route parses input with the area's zod contract (`parseBody`, `parseQuery` from `platform/http.ts`, 422 on failure), calls a service, and writes the envelope (`ok()` / `HttpError`). Business logic goes in `service.ts`, data access in the repo/store. New code uses typed Prisma; `prisma as any` in `features/` or `platform/` fails `check:api-boundary` (legacy `roboapply/` code still uses it).

**Adding an API route.**

1. Add the schema and wire types to `server/src/features/<area>/contract.ts`.
2. Add the handler to that area's `routes.ts`; new area: create the folder and add one row to `FEATURE_MOUNTS` in `features/index.ts`. Gate it with `requireFlag(key)` if the capability can be off.
3. Mirror the contract types in `lib/api/contracts/<area>.ts` (type-only re-export) and call the route from `lib/api/<area>.ts`, never from a component.
4. If it is a read sent as POST, add it to `VIEW_AS_READ_POSTS`. If it spends credits, use `creditService.withCredit`.
5. Background work: an `enqueue` kind with a handler in `workers.ts` and an import in `platform/queue/registry.ts`; a schedule: `PLATFORM_CRON_JOBS`, `vercel.json` and `node scripts/gen-cn-cronjobs.mjs`.

**Adding a page.** Signed-in pages go under `app/(auth)/<segment>/page.tsx` and the segment must be added to `PROTECTED_PREFIXES` in `lib/proxyPaths.ts`; public pages go outside `(auth)` and `(onboarding)`. Navigation entries go in `components/v3/shell/destinations.ts` (per brand, per flag). A renamed or removed route gets a redirect in `next.config.mjs`, nowhere else. Hide a feature behind `useFlag` when its capability can be off.

**Copy and i18n.** Components read every string from the bundles via next-intl; no literal user-facing text. Keys must exist in all nine locale bundles: next-intl renders a missing key as its literal dotted path without throwing, and only `npm run check:copy` catches it. Bundles never contain a literal brand name; write `%BRAND%` (and `%OTHER_BRAND%`), which `lib/i18n.ts` replaces per request. Recent work on main adds keys straight to `i18n/messages/en.json` and the other eight bundles; the staging route (`i18n/staging/<ns>.en.json`, then `npm run i18n:merge`) exists for parallel agent waves. Per HANDOFF, GoApply-only namespaces (`authCn`, `billingCn`, `jobsCn`, `onboardingCn`, `practiceCn`, `notifyCn`, `campus`, `landing.cnHome`) are required only in `en` and `zh`. Email strings live in `server/src/i18n/email/`, extension strings in `extension/src/i18n/`. The repository's `i18n-locale-sync` skill covers translation register and validation.

**Tests.** Unit tests are co-located as `*.test.ts(x)` next to the source, in `server/src` and the web folders alike (some areas use a local `__tests__/` folder). Root `__tests__/` holds cross-module tests. One Vitest config ([`vitest.config.mts`](../../vitest.config.mts), jsdom) runs both web and server tests; `interview-agent/` and `extension/` have their own runners. The config pins `DATABASE_URL` to a closed port, so a test that reaches Prisma fails fast; tests must not touch a real database or the network. Server routes are tested through `server/src/test/routeHarness.ts` with injected deps.

## 5. Where do I look for X

Paths starting with `features/`, `platform/`, `services/`, `roboapply/`, `interview-engine/`, `cron/` or `job-search/` are under `server/src/`; `app/`, `components/`, `hooks/` and `lib/` without a `server/src/` prefix are the web app at the repo root.

| Task | Start here |
|---|---|
| Job matching score | [`features/match/`](../../server/src/features/match) (`preScore.ts`, `scorerV4.ts`, `calibration.ts`, `MatchService.ts`, `cron.ts` for precompute, `eval/`); legacy scorer `roboapply/v2/agents/RAJobMatchScorerAgent.ts`; UI `components/features/match/` |
| Job feed and ranking | `features/feed/` (`FeedQueryService.ts`, `hybridSql.ts`, `ranking.ts`), `features/retrieval/` |
| Where jobs come from | `features/jobs/ingest/` (planner, quota, adapters), `features/jobs/sources/` (registry, `atsPublic/` boards and seeds); [docs/job-search/](../job-search), [CROSSBANK_JOBSEARCH_SPEC.md](../CROSSBANK_JOBSEARCH_SPEC.md) |
| Resume upload and parsing | `services/ResumeParserService.ts`, `services/GoHireResumeParseService.ts`, `server/src/lib/candidateResumeIngest.ts`, `roboapply/v2/routes/resumes.ts` |
| Resume tailoring | `features/resume/tailor/TailorService.ts`; legacy `roboapply/v2/agents/RAResumeTailorAgent.ts`; UI `components/features/tailor/`, `hooks/tailor/` |
| Credits and billing | `platform/credits/`, `platform/billing/` (plans, rails, Stripe), `features/credits/`, `features/billing-cn/`, `roboapply/routes/billing.ts`, `roboapply/routes/stripeWebhook.ts`, `roboapply/services/RoboApplyBillingService.ts`; market rules in [docs/jobright-clone/market/](../jobright-clone/market) |
| Practice interview setup | `interview-engine/prep/` and `skills/`, `interview-engine/routes/externalRoutes.ts` (`/practice`), `sessions/InterviewSessionService.ts`; UI `app/(auth)/practice/`, `components/features/practice/`; [PREP_AGENTS.md](../interview-practice/PREP_AGENTS.md) |
| Voice interview runtime | `interview-agent/src/`, `interview-engine/providers/`, `interview-engine/livekit/`, `interview-engine/parley/` |
| LLM model selection | `server/src/lib/llm/llmModels.ts`, `llmStackConfigSchema.ts` (purpose keys, AppConfig keys), `llmStackConfigResolver.ts`, `services/llm/LLMService.ts`, `services/llm/providerPrefixes.ts`, `platform/llm/brandPolicy.ts`; `npm run verify:llm`; costs in `server/src/lib/modelCostTable.ts` and [docs/LLM_COSTS.md](../LLM_COSTS.md) |
| The Assistant (copilot) | `features/copilot/` (`CopilotService.ts`, `tools/`), UI `components/features/copilot/` |
| Email templates | `platform/email/templates/` (`registry.ts`, `_shell.ts`, per-area folders), strings in `server/src/i18n/email/`, transports in `platform/email/transports/` |
| Feature flags | `platform/flags.ts` (resolver, `requireFlag`), registry defaults in `platform/brand/registry.ts`, client `lib/flags.ts` |
| Brand behaviour | `platform/brand/` (registry, runtime, `brandEnv`), `lib/brand/`, `proxy.ts`, `i18n/brands/goapply/` |
| Sign-in and sessions | `roboapply/routes/auth.ts`, `features/auth/`, `features/auth-cn/`, `middleware/auth.ts`, `lib/cookieOptions.ts`, `lib/api/client.ts`, `lib/auth/` |
| Admin console and view-as | `features/admin/` (`viewAs.ts`, `overrides.ts`, `system.ts`), `platform/viewAs/`, `app/(auth)/admin/`, `hooks/useViewAs.ts` |
| Crons and queue | `cron/handlers.ts`, `roboapply/schedulers/RoboApplyCronService.ts`, `platform/queue/`, `features/*/workers.ts` |
| Public Job Search API | `server/src/job-search/`, page `app/developers/job-search/` |
| Navigation | `components/v3/shell/destinations.ts` |
| Redirects | `next.config.mjs` `redirects()` |
| Prisma models | `server/prisma/schema/ra-<area>.prisma`, `legacy.prisma` |
| Design tokens and rules | `styles/tokens.css`, [docs/design-system.md](../design-system.md), `scripts/check-design.mjs` |
