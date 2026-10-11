# Market wave: task plan

**Date:** 2026-10-11. **Branch:** `feat/jobright-clone`. **Specification:** [`MARKET_STRATEGY.md`](MARKET_STRATEGY.md) (decisive; where this plan or an item disagrees with it, the strategy wins). **Executable plan:** [`../orch/market-bundles.json`](../orch/market-bundles.json) (40 bundles, 201 items; `node docs/jobright-clone/orch/check-bundles.mjs docs/jobright-clone/orch/market-bundles.json` reports 0 problems). This file is the human-readable companion: it adds nothing the bundles file does not say, except the owner list and the coverage table.

**What runs before:** the GoApply parity wave (`GOAPPLY_PARITY_PLAN.md`, `orch/parity-bundles.json`). It already builds JC-1, the interim JC-2 reader, the JC-4 routing and first seed, JC-7, the `linkedin` line of JI-2, AL-1, AL-2, AL-5, the GoApply half of PC-1 and PC-2. Nothing here rebuilds those; items verify them.

**Rulings that bind every bundle:** D1 the product never submits an application. D3 nothing is fabricated (data, sources, licences, prices, counts). D5 both brands have the same capability; a China-specific provider is an optional override that falls back to the shared stack. D6 sources, prices and rails are per market; Alipay keeps working exactly as it does (additive only; the A1 to A12 characterisation tests stay green and unedited); Stripe is implemented completely.

## 1. Phases

Phases run in order. Bundles of one phase run in parallel in separate worktrees, so inside a phase no path has two owners. A phase holds at most 8 bundles; the three domain drafts held 15 and 16 bundles in their second and third phases, so the plan has five work phases instead of three (M1 = rollout phase A, M2 + M3 = phase B, M4 + M5 = phases C and D, with the billing consumers of the refund engine in M4).

### M0

Schema foundation only. Merged first; then the orchestrator runs `server/prisma/sql/001_vector.sql` and pushes the additive diff to the database branch.

| Id | Bundle | Requirements | Namespaces | Depends on | Items |
|---|---|---|---|---|---|
| MKT-0 | Schema foundation: every additive model, column and index of the market wave, the vector extension file and the additive-only check | SM-2, SM-5, SM-6, SM-7, SM-8, SM-12, JI-3, JI-4, JI-5, JI-7, JI-11, JT-7, ST-4, ST-9, AL-7 | — | — | 5 |

### M1

Rollout phase A: Stripe safety, catalog and checkout; pricing page; Taiwan pay parser and source contracts; harness; taxonomy; estimate v2 and the fit contract; documents and env examples.

| Id | Bundle | Requirements | Namespaces | Depends on | Items |
|---|---|---|---|---|---|
| MKT-1A | Stripe safety first, USD catalog defaults, catalog sync by lookup key, checkout rail (server) | ST-0, PC-1, ST-1, ST-2 | — | — | 6 |
| MKT-1B | Pricing page and plan sheet from the plans API, refund lines, free autofill 20 a day, checkout attempt key (web) | PC-3, PC-4, ST-2 | credits, billingCn | — | 5 |
| MKT-1C | Taiwan pay parser (JT-1) and the contracts the source wave builds on | JT-1, JI-1, JI-2, JT-2, JT-4, JI-9, JT-9, JI-7 | — | — | 4 |
| MKT-1D | Evaluation harness, fixtures and the ten invariant specs, written first (SM-1) | SM-1 | — | — | 5 |
| MKT-1E | Role taxonomy precision, enrichment override and backfill; data quality (SM-2, SM-10; query labels of SM-11) | SM-2, SM-10, SM-11 | — | MKT-0 | 6 |
| MKT-1F | Estimate v2, the fit contract (getFit / getFits / getVariantFit) and one-scale ranking input (SM-3, SM-4, core of SM-5) | SM-3, SM-4, SM-5 | landing | MKT-0 | 6 |
| MKT-1G | Plan documents follow the market strategy; env examples for the Stripe safety rule, the price variables and the other M1 variables (OT-1; env docs of ST-0 and PC-1) | OT-1, ST-0, PC-1 | — | — | 3 |

### M2

Rollout phase B, billing and match foundations: Alipay wire parity, Stripe lifecycle, refunds, billing UI; every consumer on `getFit`; skill vocabulary; search document and embeddings.

| Id | Bundle | Requirements | Namespaces | Depends on | Items |
|---|---|---|---|---|---|
| MKT-2A | Alipay, additive only: wire parity with production and callback tolerance (rail file and origins) | AL-3, AL-4 | — | — | 5 |
| MKT-2B | Stripe webhook lifecycle: new events, re-read, price-first, several secrets, reconcile, portal by code, endpoint check; billing mails (server) | ST-3, ST-5, ST-7, AL-6 | — | MKT-1A | 8 |
| MKT-2C | Subscription changes: switch with pending_if_incomplete, resume, idempotency keys, tax switch (server) | ST-5, ST-6, ST-8 | — | MKT-1A | 3 |
| MKT-2D | Refund engine: issueRefund, charge.refunded, disputes, pro-rata withdrawal rule, withdrawPurchase, refund mails (server) | ST-4, ST-9 | — | MKT-0, MKT-1A | 6 |
| MKT-2E | Billing UI for the subscription lifecycle: reconcile on return, in-app switch, resume, payment update, GoApply link for mainland visitors (web) | ST-3, ST-5, ST-6, ST-7, AL-6 | credits, billingCn | MKT-1A, MKT-1B | 6 |
| MKT-2F | Every consumer reads the one fit: lists, Assistant, tailoring, stored snapshots, the every-seam contract test; Similar jobs takes a vector source (rest of SM-5) | SM-5, SM-3, SM-11, SM-7 | fit, tailor | MKT-0, MKT-1D, MKT-1F | 7 |
| MKT-2G | Canonical skill vocabulary: table access, aliases in three scripts, related-evidence graph, seed and review tooling (SM-6, foundation) | SM-6 | — | MKT-0 | 4 |
| MKT-2H | Search document and embeddings write path: embeddings client, CJK segmentation, searchDoc / searchTsv, job and user vectors, sweep; relevance seam (SM-7 foundation, SM-11) | SM-7, SM-11, SM-9, SM-12 | — | MKT-0, MKT-1F | 7 |

### M3

Rollout phase B, job sources: quota, planner, posting identity, employer boards, Taiwan open data, provider health, mainland deep links; plus the cut-over runbooks.

| Id | Bundle | Requirements | Namespaces | Depends on | Items |
|---|---|---|---|---|---|
| MKT-3A | Ingest core: monthly quota from response headers, one budget per provider, JSearch as a demand-only source | JI-1, JI-6, JT-3, JC-6 | — | MKT-1C | 5 |
| MKT-3B | Planner: adapter cost model, no SEO seeds on per-request providers, demand windows, Taiwan query variants | JI-2, JI-6, JT-3, SM-11 | — | MKT-1C, MKT-1E | 4 |
| MKT-3C | Posting identity and lifecycle: atsPostingKey, canonical-row priority, JSearch link rules, expiry rules, carry-through fields | JI-5, JI-6, JC-7, JI-10, JI-8, JI-7, JT-7 | — | MKT-0, MKT-1C | 7 |
| MKT-3D | Employer boards: sources for both markets, discovery, bulk import, seeds, sync throughput and its own cron | JI-3, JI-4, JC-4, JT-5 | jobsTw | MKT-0, MKT-1C | 7 |
| MKT-3E | Taiwan: 台灣就業通 open-data adapter with a resumable sweep and attribution, zh-Hant role labels, 通俗職業 map, import denylist | JT-2, JT-4, JT-5 | — | MKT-1C, MKT-1E | 7 |
| MKT-3F | Provider health in the admin System panel: plan, remaining quota, days to reset, dead sources visible | JI-1 | admin | MKT-1C | 3 |
| MKT-3G | Mainland deep links: nine boards, ordered by audience, built only from the user's own query | JC-5 | jobsCn | — | 3 |
| MKT-3H | Runbooks and pre-flight: Alipay cut-over with the notify check, Stripe test-mode pass (documents and one script) | AL-8, ST-0 | — | MKT-1A, MKT-2A, MKT-2B, MKT-2D | 3 |

### M4

Billing consumers of the refund engine and match phases C and D: withdrawal, admin billing, UI; enrichment v3, skills in the estimate, hybrid retrieval, scorer v4, search surfaces.

| Id | Bundle | Requirements | Namespaces | Depends on | Items |
|---|---|---|---|---|---|
| MKT-4A | Self-service withdrawal endpoints (signed in and on the public cancel page) and consent retention after account deletion (server) | ST-9 | — | MKT-0, MKT-2C, MKT-2D | 3 |
| MKT-4B | Admin billing server: refund action, manual CN refund record, practice-cost readout, Stripe health; invoice history with refunded marker (server) | ST-4, AL-7, PC-5, ST-3, ST-10 | — | MKT-0, MKT-2B, MKT-2D | 5 |
| MKT-4C | Billing UI: "Withdraw from contract", admin console for refunds, CN refund record, practice cost and Stripe health; history with paging and refunded marker (web) | ST-9, ST-4, AL-7, PC-5, ST-3, ST-10 | credits, billingCn, admin | MKT-2D, MKT-2E, MKT-3F | 5 |
| MKT-4D | Enrichment v3: canonical skill ids at write time, honest keywords, requirements extracted once per posting (SM-6 write path, SM-8 job side) | SM-6, SM-8, SM-2, JI-11 | — | MKT-0, MKT-1E, MKT-2G, MKT-2H, MKT-3C | 6 |
| MKT-4E | Canonical skills in the estimate and a three-state keyword check; fit-card checklist UI; skills gate (SM-6 read path) | SM-6, SM-3, SM-8 | fit | MKT-0, MKT-1D, MKT-1F, MKT-2F, MKT-2G | 4 |
| MKT-4F | Feed: hybrid retrieval by reciprocal rank, the residual text as a ranking query, then the ranking refinements (SM-7, SM-9 feed part, SM-12) | SM-7, SM-9, SM-12, SM-11 | jobs, landing | MKT-0, MKT-1D, MKT-1F, MKT-2H | 8 |
| MKT-4G | Scorer v4: requirement checklist with anchored statuses, server-computed numbers, resume-first prompt, pinned version per market (SM-8) | SM-8, SM-5 | — | MKT-0, MKT-1D, MKT-1F, MKT-2F | 4 |
| MKT-4H | Search surfaces outside the feed: planner relevance terms and the job-search API on both brands, Assistant job tools with cited ids (SM-9) | SM-9 | assistant | MKT-1F, MKT-2F, MKT-2H | 4 |

### M5

Job-source phases C and D: licensed feed, more connectors, closure and freshness, new public sources, GoHire syndication, Taiwan extras, sponsorship facts; final documents and env examples.

| Id | Bundle | Requirements | Namespaces | Depends on | Items |
|---|---|---|---|---|---|
| MKT-5A | Licensed feed (Active Jobs DB): hourly window sync with the expired feed behind the quota gate; Active Jobs DB for the mainland | JI-7, JC-6 | — | MKT-3A, MKT-3B, MKT-3C, MKT-3D | 7 |
| MKT-5B | More board connectors: Workable, Recruitee, Personio, Lever EU, Greenhouse pay ranges and deadline; 北森 behind CN_ATS_BEISEN_ENABLED | JI-8, JC-8 | — | MKT-3C, MKT-3D | 5 |
| MKT-5C | Closure and freshness: on-demand liveness check, three date facts, mainland unseen rule, sponsorship label rule | JI-10, JI-11 | jobDetail | MKT-2F, MKT-3C, MKT-3D, MKT-4F | 6 |
| MKT-5D | New public sources: USAJobs and 事求人, and the source register document | JI-9, JT-9, JI-12 | — | MKT-3C, MKT-3E | 3 |
| MKT-5E | GoHire bank over the syndication endpoint: hardened HTTP adapter, mirror read for live cross-bank search, the contract for the second repository | JC-2, JC-3 | — | MKT-3C | 4 |
| MKT-5F | Taiwan extras: pay-rule note from config, district level and shift pattern with their filters, provenance and helper text | JT-6, JT-7, JT-8 | jobsTw, filters | MKT-3C, MKT-3E, MKT-4F | 5 |
| MKT-5G | Sponsorship facts with source and date: USCIS H-1B Employer Data Hub and the UK Register of Licensed Sponsors next to the DOL LCA loader | JI-11 | companyFacts | MKT-0, MKT-3C | 4 |
| MKT-5H | Env examples for every variable of M2 to M5, the mainland deploy kit variables, and the final pass over the plan documents (OT-1; env docs of every later requirement) | OT-1 | — | MKT-1G | 3 |

### Gates between phases (orchestrator)

| After | Run and check |
|---|---|
| M0 merge | Review `docs/jobright-clone/schema-diffs/market-additive.sql` (additive only). On the database branch: `000_extensions.sql` if never run, `001_vector.sql`, read `prisma migrate diff`, `npm run db:push`, read the diff again (empty apart from `KNOWN_DRIFT.md` pairs). The owner sees both diffs (SM-7 acceptance). No code from the M0 merge on runs against a database that lacks this push (the generated client already selects the new columns). |
| M1 merge | `npm run eval:match -- --enforce M1` exits 0. `npx vitest run -t "A[0-9]+ "` (the 43 Alipay contract tests) green with no diff in a test body (MKT-1A changes the Stripe rail that the A11 tests cover). Marketing page tests on the merged tree (MKT-1B owns `pages.test.tsx`; MKT-1F changes `landing.ranking.fit.body`). OT-2: merge staging, translate, `npm run check`. *Run 2026-10-11:* all of the above green except OT-2, which the orchestrator runs once after the last phase (`requests/orchestrator-queue.md`); what the gate applied and what it handed on is in `requests/waveM1-carryover.md`. |
| M2 merge | `npm run eval:match -- --enforce M2`; nine invariants now run in `npm test`. Similar jobs test on the merged tree (the cast in `jobs/detail` of MKT-2F meets `similarJobIds` of MKT-2H). All A1 to A12 tests green and unedited. OT-2. *Run 2026-10-11:* all of the above green except OT-2 (once, after the last phase). The Similar jobs loader is typed against the real feed export and has a merged-tree test; what the gate applied and what it handed on is in `requests/waveM2-carryover.md`. |
| M3 merge | Cross-bundle acceptance lines of JI-5 (MKT-3C writes `atsPostingKey`, MKT-3D discovery reads it), JT-3 (MKT-3B plans, MKT-3A builds the zh-TW query) and JI-3. The `jobs-boards` cron is in `vercel.json`, `cron/handlers.ts` and the regenerated `deploy/cn/k8s/cronjobs.yaml` with one schedule. OT-2. |
| M4 merge | `npm run eval:match -- --enforce M4`; all ten invariants in `npm test`. Feed count and list agree for a typed query. Stripe test-mode scenario pass from `STRIPE_TEST_RECIPE.md` (needs the owner's test key). OT-2. |
| M5 merge | `__tests__/deploy/envExample.test.ts`; full gates: `npm test`, `npm run typecheck:server`, `npm run typecheck:web`, `npm run check`, `npm run build` when no dev server uses the same `.next`. OT-2. Then the owner steps of section 6 (the AL-8 supervised order with `ALIPAY_CUTOVER.md`, the Chinese harness subset on a real corpus before GoApply's production launch). |

## 2. Hot files: one owner per phase

A bundle that needs a line in a file it does not own writes a Request in its handoff (to the owning bundle id or the orchestrator) and does not edit the file. Env variables are not a Request: they go in the handoff section "Env variables added or redefined".

| File | M1 | M2 | M3 | M4 | M5 |
|---|---|---|---|---|---|
| `server/src/app.ts` | — | — | — | — | — |
| `server/src/features/index.ts` | — | — | — | — | MKT-5F (mounts `features/tw`) |
| `server/src/platform/flags.ts (+ flags.test.ts)` | MKT-1A (one line at `pay.stripe`, one import) | — | — | — | — |
| `server/src/platform/brand/**` | — | — | — | — | — |
| `server/src/cron/** (handlers.ts)` | — | — | MKT-3D (`jobs-boards`) | — | — |
| `vercel.json, deploy/cn/k8s/cronjobs.yaml` | — | — | MKT-3D | — | — |
| `.env.example, deploy/cn/cn.env.example` | MKT-1G | — | — | — | MKT-5H |
| `package.json` | MKT-1D (script `eval:match`) | — | — | — | — |
| `components/v3/shell/destinations.ts` | — | — | — | — | — |
| `lib/proxyPaths.ts` | — | — | — | — | — |
| `i18n/staging/index.ts` | — | — | — | — | MKT-5G (registers `companyFacts`) |
| `server/src/platform/billing/index.ts` | MKT-1A | MKT-2D | — | — | — |
| `server/src/roboapply/services/RoboApplyBillingService.ts, roboapply/routes/billing.ts` | MKT-1A | MKT-2B | — | MKT-4B | — |
| `server/src/features/credits/{routes,service,contract}.ts` | MKT-1A (service, contract) | MKT-2C | — | MKT-4A | — |
| `server/src/platform/billing/rails/alipayWorker.ts` | — | MKT-2A (additive only) | — | — | — |
| `components/features/credits/, hooks/credits/` | MKT-1B | MKT-2E | — | MKT-4C | — |
| `server/src/features/feed/ (directory)` | MKT-1F | MKT-2H | — | MKT-4F (named files, incl. sql.ts, contract.ts) | MKT-5C (items.ts, contract.ts, FeedQueryService.ts), MKT-5F (sql.ts) |
| `server/src/features/jobs/enrich/` | MKT-1E | MKT-2H (service.ts, workers.ts) | — | MKT-4D | — |
| `server/src/features/jobs/normalize/` | MKT-1C (named files) | — | MKT-3C | — | MKT-5A (adapters.ts), MKT-5F (normalizeProviderJob.ts) |
| `server/src/features/jobs/taxonomy/` | MKT-1C (taxonomy.ts), MKT-1E (match.ts, taxonomy.v1.json, queryLabels.ts, index.ts) | — | MKT-3E | — | — |
| `server/src/features/jobs/ingest/planner.ts` | — | — | MKT-3B | — | MKT-5A |
| `server/src/features/jobs/ingest/{pipeline,config}.ts` | — | — | MKT-3A | — | MKT-5A (config.ts) |
| `server/src/features/jobs/ingest/{upsert,maintain}.ts` | — | — | MKT-3C | — | MKT-5C (maintain.ts) |
| `server/src/features/jobs/sources/atsPublic/` | MKT-1C (hooks.ts) | — | MKT-3D | — | MKT-5B |
| `server/src/features/jobs/detail/` | — | MKT-2F | — | — | MKT-5C |
| `server/src/features/match/ (fit.ts, MatchService.ts, preScore.ts, contract.ts)` | MKT-1F | MKT-2F (fit.ts, contract.ts, index.ts, routes.ts) | — | MKT-4E (preScore, context, contract), MKT-4G (fit.ts, MatchService.ts) | — |
| `server/src/features/admin/, components/v3/admin/SystemConsole.tsx, namespace admin` | — | — | MKT-3F | MKT-4C (SystemConsole.tsx and the namespace only) | — |
| `docs/jobright-clone/{README,PRODUCT_PLAN,TASK_PLAN,CN_TW_LAUNCH_PLAN,ARCHITECTURE}.md` | MKT-1G | — | — | — | MKT-5H |

M0: MKT-0 alone owns `server/prisma/schema/`, `server/prisma/sql/`, `server/prisma/__tests__/`, `scripts/check-schema-additive.mjs` and `docs/jobright-clone/schema-diffs/`. No later bundle edits a `*.prisma` file.

## 3. Cross-bundle contracts

Producer and consumer never run in the same worktree, so each contract below is written identically in the items of both sides. Where producer and consumer share a phase the consumer codes against this text (types by hand, a cast, or an injected function) and the seam is checked at the phase gate.

### 3.1 Billing

| Contract | Producer | Consumers | Shape |
|---|---|---|---|
| Stripe env helpers `platform/billing/stripeEnv.ts` | MKT-1A | MKT-2B, MKT-4B, `flags.ts` (same bundle) | `stripeSecretKey(env)`, `stripeKeyMode(env): 'none' \| 'test' \| 'live'` (`test` only for `sk_test_` / `rk_test_`; every other key is `live`), `liveKeyAllowed(env)`, `stripeKeyUsable(env): { usable, reason: 'missing' \| 'live_key_outside_production' \| null }`, `stripeWebhookSecrets(env): string[]` (both variables, the RoboApply name first, comma-split, de-duplicated), `stripeRailReady(env)` = usable key AND a webhook secret the webhook route can verify with. `getStripe()` returns null when the key is not usable. *As built (M2 gate):* three more exports, `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` (**true** since MKT-2B item 1: `routes/stripeWebhook.ts` tries every secret of `stripeWebhookSecrets()` in order, each trimmed; both halves were merged together and the gate checked both), `stripeWebhookCanVerify(env)` and `stripeRailBlocker(env): 'missing' \| 'live_key_outside_production' \| 'webhook_secret_missing' \| 'webhook_secret_unverifiable' \| null`. A comma-separated list, a blank RoboApply variable in front of a real secret and a secret with whitespace around it all verify and open the rail. A secret with whitespace INSIDE it never verifies and keeps the rail closed (`webhook_secret_unverifiable`). |
| Catalog sync `platform/billing/stripeCatalog.ts` | MKT-1A | MKT-2B (price-first plan resolution); checkout and switch in MKT-1A itself | `resolveStripePriceId(stripe, plan, currency)` (as built: the function takes the client and the resolved plan, which both callers hold; the strategy writes `(planKey, currency)`); lookup key `ra_<planKey>_<currency>_<amountMinor>_incl`; products `ra_pro`, `ra_pro_student`, `ra_pro_week_pass`, `ra_practice_pack`; `planKeyForPrice(price)`: `metadata.planKey` → lookup key → env pins → legacy map. `getPlanCatalog()` stays synchronous. A plan whose catalog currency is not USD is refused (`plan_not_sellable`) with no Stripe call, and the Stripe rail refuses an order whose brand does not list `stripe` before it creates a customer (rule A11 as tested). |
| Event seam `platform/billing/stripeEvents.ts` | MKT-1A | MKT-2B, MKT-2D | `registerStripeEventHandler(type, handler)`, `stripeEventHandler(type)`, handler = `(event, ctx: { stripe, db, now }) => Promise<StripeEventResult>`; `claimBillingEvent(db, userId, key, refType, now)` (ledger row with idempotency key `billing:<key>`); `invoiceSubscriptionId(invoice)`; `findBillingOwnerByCustomer(db, stripeCustomerId)`; new error codes `nothing_to_resume`, `refund_not_available`, `withdrawal_not_available` (all 409). |
| `GET /billing/plans` additive fields | MKT-1A | MKT-1B | `checkout.collectingEntity: string \| null` (GoApply only) and `refundPolicy: { firstPurchaseDays: 7, shortPlanHours: 48, paidOnlyCreditLimit: 5, accidentalRenewalDays: 3, withdrawalDays: 14, packValidMonths: 12, version: string }`. *As built (M2 gate):* `version` is the PUBLIC label: `refund-v2-2026-10` on RoboApply since MKT-2D added the pro-rata withdrawal rule, `refund-v1-2026-10` on GoApply, whose rules did not change (the stored `REFUND_POLICY_VERSION` may carry an internal suffix that is never sent, `publicRefundPolicyVersion`; the web prints no version and treats it as an opaque string), and a third field `studentOffer: Array<{ key: 'student_monthly' \| 'student_quarterly', amountMinor, studentDiscountPercent }> \| null` (the brand's student prices for a caller who is not sent the student plans themselves; null otherwise, so always null on RoboApply). The three fields are optional members of `PlansResponse` and required in `PlansResponseSent`; the web reads them through `plansBillingFacts` (`lib/api/account.ts`) and hides the refund column unless all six numbers are positive integers. Seam test: `__tests__/contracts/billingPlans.seam.test.ts`. |
| Checkout attempt key | MKT-1B (web sends) | MKT-1A (server reads) | Request header `Idempotency-Key` matching `/^[A-Za-z0-9_-]{8,64}$/`, a UUID made each time the plan sheet opens. Stripe key `checkout:<userId>:<planKey>:<currency>:<attempt>`; without the header a 60-second bucket; a conflict answers 502 `payment_provider_error` with `details.reason 'idempotency_conflict'`. |
| `POST /api/v1/roboapply/billing/checkout/reconcile` | MKT-2B | MKT-2E | Request `{ sessionId }` → `{ status: 'fulfilled' \| 'already_fulfilled' \| 'pending', mode: 'payment' \| 'subscription', planKey: string \| null }`; errors 403 `forbidden`, 404 `not_found`, 422 `invalid_request`, 429 `rate_limited`, 503 `stripe_not_configured`, 502 `payment_provider_error`. Same claim as the webhook (`billing:checkout:<session>`). *As built (M2 gate):* `sessionId` matches `/^cs_[A-Za-z0-9_]{8,200}$/` on both sides (a test compares the two patterns); a GoApply host answers 403 with no Stripe call; an old subscription session of the caller's own (its subscription ended, or the row moved on) answers `already_fulfilled` and changes nothing; a subscription session whose first payment is still open answers `pending`; 10 calls a minute per user, failing open. The web stops on 403, 404, 422 and 503 and asks again on 429, 502 and `pending` (at most 4 calls per page view). |
| `POST /billing/portal` | MKT-2B | MKT-2E | Request `{ flow?: 'payment_method_update' }` → `{ url }`; errors 409 `no_customer`, 503 `stripe_not_configured`, 502 `payment_provider_error`. Configuration created by code (`stripePortal.ts`), subscription update off. *As built (M2 gate):* a missing body is accepted (the web's plain "Manage payment" call sends none); a brand without the Stripe rail answers 409 `no_customer` with no Stripe call, also on a deployment that holds no usable Stripe key (the brand is looked at before the client; 503 is RoboApply's answer there). |
| Plan switch | MKT-2C (`confirmSwitch`), MKT-2B (route) | MKT-2E | `confirmSwitch` → `{ planKey, stripeSubscriptionId, requiresAction: boolean, hostedInvoiceUrl?: string \| null }`. `POST /billing/switch { planKey, confirm: true, prorationDate, autoRenewAck, withdrawalWaiver? }` → `{ switched: true, planKey }` \| `{ switched: false, requiresAction: true, hostedInvoiceUrl: string \| null, planKey }`; without `confirm` → `{ quote }` as today. *As built (M2 gate):* `hostedInvoiceUrl` is present only with `requiresAction: true` and can be null (no invoice, no hosted page, or its read failed; the sheet then offers Manage payment); the update clears our cancel marker (`metadata.cancelSource: ''`); a Stripe failure is 502 `payment_provider_error` (every Stripe call of the quote and the confirm: the two subscription reads, the price lookup, the preview and the update); on `switched: true` the new plan, interval, price and period end are already on the row (the route syncs it from Stripe before it answers, state only, and never fails the answer when that read fails), so one read of `GET /billing/plan` after the answer shows the new plan; confirming the same quote again after the webhook wrote the new plan is 409 `switch_not_available`, so the page reads the plan again and never re-confirms; a declined proration leaves the subscription active, and `invoice.payment_failed` for it changes nothing and sends no mail (the handler re-reads the subscription; test at the gate). |
| `POST /api/v1/roboapply/credits/resume` | MKT-2C | MKT-2E | Request `{ autoRenewAck: true }` → `{ status: 'resumed', planKey: string, renewsAt: string \| null }`; errors 409 `nothing_to_resume`, 422 `auto_renew_ack_required`, 503 `rail_not_configured`, 502 `payment_provider_error`. *As built (M2 gate):* an unknown body field is 422 `invalid_request`; a GoApply account, a pass, a plan that still renews, an ended period and a legacy plan (`starter`, `growth`: no renewal terms on file) all answer 409; the acknowledgement records the price the subscription row holds (asked from Stripe when the row has none), which is the figure `GET /billing/plan` `current.amountMinor` shows and the only one the web prints in the box. |
| Refund engine `platform/billing/stripeRefunds.ts`, `refunds.ts`, `acknowledgements.ts` | MKT-2D | MKT-4A, MKT-4B, MKT-4C | `issueRefund`, `withdrawalQuote(userId, deps)`, `withdrawPurchase({ userId, purchaseId, actor }, deps)` (cancels the subscription first, idempotency key `withdraw:<subId>`, then refunds); `WITHDRAWAL_COUNTRIES` (EU 27 + IS, LI, NO + GB + TW), the one list the web mirrors; rows in `RABillingRefund`. Exported from the billing index since M2. *As built (M2 gate):* `withdrawalQuote` → `{ purchase, decision } \| null` and throws `payment_provider_error` when Stripe cannot be read; the pro-rata period is the one the invoice paid for (its subscription line), not the subscription's current period; a completed withdrawal is closed (claim `billing:withdraw:<purchaseId>`), so a second call is 409 `withdrawal_not_available`; `reversePackGrant` and `reversePassPeriod` (with `purchasedAt`) are exported for the manual CN record; `RefundDecision` has two new required fields, `prorata` and `endsAccess`; the index also exports `resumeSubscription`, `switchIdempotencyKey`, `renewalChangeIdempotencyKey` and their types. *Changed at the M2 gate (cross-review):* a withdrawal is per PURCHASE. `withdrawalQuotes(userId, deps)` → every open quote, the latest purchase first; `withdrawalQuote` is the first of them; `withdrawPurchase` takes the purchase the caller names (`purchaseId` = the invoice id of the purchase, never "the latest invoice"). A purchase is a paid invoice of the last 14 days that is not a renewal; `purchase.amountMinor` is everything paid under it so far (its own invoice plus the renewals of its subscription paid since), `purchase.chargedAt` is when it was paid and the 14 days run from it. Without the waiver `decision.amountMinor` is all of that; with it, the unused days of the running period (`RefundInput.purchasedAt` carries the purchase time when the charge is a renewal). The billing country falls back to the invoice's customer address when the account holds none. `IssueRefundInput.attemptKey` (optional; letters, digits, `-`, `_`) names one refund decision and is the last part of the idempotency key: the admin action sends one per refund it confirms. |
| Endpoint check `platform/billing/stripeHealth.ts` | MKT-2B | MKT-4B | `checkStripeWebhookEndpoint` → `{ checked: boolean, url: string \| null, missingEvents: string[], reason?: 'not_found' \| 'restricted_key' \| 'error' }` against `EXPECTED_STRIPE_EVENTS` (the fourteen types of strategy 5.1). Never edits the endpoint. Imported by file path. *As built (M2 gate):* an optional second argument `{ origin }` (the public origin Stripe delivers to; exact on scheme, host and port): with it the endpoint at that origin is reported, without it the endpoint on our path that misses the most events. A second read-only check, `checkStripePrices(stripe, env)` → `{ checked, pinsChecked, lookupKeysChecked, issues, reason? }` (pinned prices against the catalog; a synced price that was archived). Neither is wired to a route yet (MKT-4B). |
| Withdrawal (signed in) | MKT-4A | MKT-4C | `GET /api/v1/roboapply/credits/withdrawal` → `{ available: boolean, purchase: { source: 'stripe', id, planKey, chargedAt, amountMinor, currency } \| null, quote: { rule: 'withdrawal_14d' \| 'withdrawal_14d_prorata', refundMinor, currency, deadline, prorata: { usedDays, periodDays } \| null, endsAccess: true, region: 'eu' \| 'uk' \| 'tw' } \| null }`. `POST` same path `{ purchaseId, confirm: true }` → `{ status: 'withdrawn', refundMinor, currency, accessEnded: true }`; errors 409 `withdrawal_not_available`, 429, 503 `rail_not_configured`, 502. GoApply always answers `available: false`. |
| Withdrawal (public cancel link) | MKT-4A | MKT-4C | `POST /api/v1/public/cancel/preview { token }` → `{ planKey, accessUntil: string \| null, withdrawal: { refundMinor, currency, rule, deadline } \| null }`; 410 `cancel_token_invalid`. `POST /api/v1/public/cancel/confirm { token, withdraw?: boolean }` → `CancelResponse & { withdrawal?: { status: 'withdrawn' \| 'not_available', refundMinor: number \| null, currency: string \| null } }`. |
| Admin refunds | MKT-4B | MKT-4C | `POST /api/v1/roboapply/admin/credits/refunds { userId, target: { invoiceId } \| { checkoutSessionId }, amountMinor?, reason }` → `{ refundId, amountMinor, currency, full }`; errors 404, 409 `refund_not_available`, 503, 502. `GET …/refunds?userId=&cursor=` → `{ items: Array<{ id, userId, brand, rail, kind: 'refund' \| 'withdrawal' \| 'dispute' \| 'manual_cn', amountMinor, currency, full, entitlementReversed, reason, actor, invoiceId, checkoutSessionId, alipayOrderId, createdAt }>, cursor }`. |
| Manual CN refund record (AL-7) | MKT-4B | MKT-4C, runbook MKT-3H | `GET /api/v1/roboapply/admin/credits/cn-orders?userId=` → `{ items: Array<{ id, outTradeNo, planKey, channel: 'alipay' \| 'wechatpay', amountMinor, completedAt, refunded: 'full' \| 'partial' \| null }> }`. `POST …/cn-orders/:orderId/refund { reason, confirmMoneyReturned: true, refundedAmountMinor? }` → `{ status: 'recorded' \| 'already_recorded', orderId, entitlement: 'pass_ended' \| 'pass_shortened' \| 'pack_zeroed' \| 'none' }`; errors 404, 409 `order_not_completed`, 422. Claim `billing:refund:cn:<orderId>`; `fulfilPass.ts` untouched. |
| Practice cost and Stripe health | MKT-4B | MKT-4C (credits console and the System panel line) | `GET …/admin/credits/practice-cost` → `{ brands: { roboapply: PracticeCost, goapply: PracticeCost } }`, `PracticeCost = { sampleSize, averageUsd: number \| null, enough: boolean, maxSessions: 50, minSessions: 10, oldest, newest }`. `GET …/admin/credits/stripe-health` → `{ keyMode, usable, refusedReason, webhookSecrets: number, railReady, endpoint: { checked, url, missingEvents, reason? }, pinnedPlans: string[] }`; never a key, secret or price id. |
| Billing history | MKT-4B | MKT-4C | `GET /api/v1/roboapply/billing/history?cursor=&limit=` → `{ invoices: BillingInvoice[], nextCursor: string \| null }`, `BillingInvoice = { id, kind: 'stripe' \| 'alipay', date, amountMinor, currency, status, description, downloadable, channel?: 'card' \| 'alipay' \| 'wechatpay', refunded?: 'full' \| 'partial' }`; `channel` is sent only when `kind` does not imply it (WeChat Pay orders) and `refunded` only on a refunded row, so every existing row keeps its exact shape (the A10 test compares rows with `toEqual`); only paid, open and uncollectible invoices. |
| Alipay notify origin `platform/billing/origins.ts` | MKT-2A | pre-flight script MKT-3H | `alipayNotifyOrigin(brand, env)`: `CN_ALIPAY_NOTIFY_ORIGIN` → `CN_BACKEND_URL` → the brand's canonical origin (`https://www.goapply.top`); never `BACKEND_URL`, never another brand's host. Order prefix `RAORDER_`; `package_id` = plan key (`CN_ALIPAY_PACKAGE_ID_MODE=legacy` sends `starter`). Answer codes of rule A2 unchanged. `verifyCallback` reads the order only when `total_amount` can be a fen amount (no decimal point, a multiple of 100) and never throws because of that read; the secret-less window opens the database only inside a live window (the A6 tests run on a database that throws). *As built (M2 gate):* the pure form is `resolveAlipayNotifyOrigin(brand, env)` → `{ origin, source, ignoredOverride }` (the pre-flight script fails when `ignoredOverride` is set); an override is a bare https origin (scheme, host, optional port), anything else is ignored with a warning; the window accepts only an order PRODUCTION created (an Alipay row with no brand, created before the instant), never an order this code created; the notify host and the window state are logged once at boot (`reportAlipayRailOnce`, also asked by `platform/startup.ts`). |

### 3.2 Job sources

| Contract | Producer | Consumers | Shape |
|---|---|---|---|
| Provider ids and adapter options | MKT-1C | MKT-3A, 3B, 3C, 3E, 5A, 5D | `NormalizeProvider` = `JobProvider \| 'ats_public' \| 'tw_open_data' \| 'tw_gov_jobs' \| 'usajobs' \| 'activejobs_feed'`; `PROVIDER_META` entries with priorities `tw_open_data` 12, `tw_gov_jobs` 12, `usajobs` 8, `activejobs_feed` 10 (the feed writes `sourceBoard 'activejobs'`). `JobSourceAdapter` gains optional `costModel?: 'free' \| 'per_job' \| 'per_request'` and `isEnabledFor?(market)`; helpers `adapterCostModel(adapter)`, `adapterEnabledFor(adapter, market)`. `ProviderJobInput` gains optional `taxonomyId`, `sponsorshipProvider: 'offered' \| 'not_offered' \| null`, `locationDistrict`, `workShift`. `NormalizeContext.companyDomains?: ReadonlyMap<string, string>`. `TaxonomyNode.zhHant?`, `synonyms.zhHant?`. |
| Quota snapshot `jobs/ingest/quotaContract.ts` | MKT-1C (types and parser), MKT-3A (writer) | MKT-3F (reader), MKT-3B, MKT-5A | AppConfig key `jobs.providerQuota.v1`, value `{ version: 1, providers: { [provider]: { provider, plan: string \| null, requestsLimit, requestsRemaining, jobsLimit, jobsRemaining, resetAt, observedAt, lastStatus, lastCallCost, state: 'ok' \| 'exhausted' \| 'not_subscribed' \| 'unauthorized' \| 'unknown' } } }`; `parseProviderQuota`, `serializeProviderQuota`, `daysToReset(snapshot, now)`, `usageKey(provider, market)` = `provider` for intl and `provider:cn` for cn. No schema change. |
| Refresh interval by country | MKT-3B (`planner.ts`) | MKT-3A (`pipeline.ts`) | `RefreshInput = { origin, demandScore, consecutiveEmpty, country?: string \| null }`; hot demand 6 h, cold demand 24 h, Taiwan demand 12 h, seeds 24 h, bank 30 min. `pipeline.ts` passes a variable `{ …, country: query.params.country ?? null }` to `nextRunDelayMs`, so it compiles with or without the new field. |
| Identifying User-Agent `jobs/sources/userAgent.ts` | MKT-1C | MKT-3D, 3E, 5B, 5D (every adapter that reads a public job-board or open-data endpoint) | `sourceUserAgent(market, env)` → `RoboApplyJobs/1.0 (+<contact>)` or `GoApplyJobs/1.0 (+<contact>)`, contact = the brand's OWN contact variable or the brand site URL. *As built (M1 gate):* RoboApply reads `JOB_SOURCES_CONTACT` only and GoApply `CN_JOB_SOURCES_CONTACT` only (`brandOwnEnv`; the name is in `BRAND_OWN_ENV`), so RoboApply's contact is never sent to a mainland board. Exported from `jobs/sources/index.ts`; consumers call the function with the market of the request and never read the variable. |
| Provider query labels `jobs/taxonomy/queryLabels.ts` | MKT-1E | MKT-3B | `providerQueryLabels(roleId, { market, country })` → `Array<{ text, language: 'en' \| 'zh-TW' \| 'zh-CN' }>`: intl English label and up to two synonyms; TW adds one zh-TW item once a Traditional label exists; cn the zh label and up to two aliases. |
| Posting key | MKT-3C (writes `RAJob.atsPostingKey`) | MKT-3D discovery, MKT-5C liveness | String `{ats}:{tenant}:{postingId}` parsed from apply and source URLs; dedupe uses it before the fuzzy key, inside one market only. Priorities: `ats_public` 5, `bank_gohire` 3, `bank_robohire` 15. |
| Sponsorship source | MKT-3C (provider reading), MKT-4D (posting quote) | MKT-5C (badges), MKT-5A (feed flag) | `RAJob.sponsorshipSource`: `'posting_quote'` or `'provider:<provider id>'`. A provider reading never overwrites a quoted row; a row with a non-null `sponsorshipEvidence` counts as quoted even when the source is null. |
| Career-site source state | MKT-0 (columns), MKT-3D (writer) | MKT-5A (`exclude_source` rule: 200 enabled boards), MKT-5B | `RACareerSiteSource.origin 'admin' \| 'seed' \| 'import' \| 'discovered'`, `discoveredFrom`, `countries: string[]` (empty = every country the brands serve), `failCount`, `lastChangeAt`, `nextSyncAt`, `disabledAt`. A posting located in both markets is written twice, the mainland copy with `externalId` suffix `#cn`. |
| Board sync cron | MKT-3D | orchestrator (deploy), MKT-5B | `GET /api/v1/cron/jobs-boards`, schedule `*/5 * * * *`, in `vercel.json`, `PLATFORM_CRON_JOBS` and the mainland CronJob file; kill switch `ATS_PUBLIC_SOURCES_DISABLED`. |
| Provider health in the System status | MKT-3F | web System panel (same bundle); MKT-4C adds its own panel beside it | `ProviderUsageRow` gains `market`, `plan`, `requestsLimit`, `requestsRemaining`, `jobsLimit`, `jobsRemaining`, `resetAt`, `daysToReset`, `observedAt`, `costModel`, `state: 'ok' \| 'low' \| 'exhausted' \| 'not_subscribed' \| 'unauthorized' \| 'gated' \| 'disabled' \| 'unknown'`. |
| GoHire syndication wire (JC-2, JC-3) | second repository (owner); validated here by MKT-5E | MKT-5E adapter | `GET <GOHIRE_SYNDICATION_URL>?cursor=<updatedAt ISO\|id>&limit=<n>` over https → `{ items: SyndicatedJob[], tombstones: Array<{ id, updatedAt, reason? }>, nextCursor: string \| null, hasMore: boolean }`; a job is the columns of `BANK_SYNC_SELECT` plus `education`, `headcount`, `employerVerified: boolean`, `syndicationConsentAt`, `validFrom`, `validUntil`. Unknown keys are stripped; a page that fails validation writes nothing. Written out for the other repository in `market/GOHIRE_SYNDICATION.md`. |
| Company sponsorship facts (JI-11) | MKT-5G | job page (same bundle) | `GET /api/v1/roboapply/companies/:id/sponsorship` → `{ facts: SponsorshipFact[], disclaimer }`, fact kinds `dol_lca`, `uscis_h1b_hub`, `uk_sponsor_register`, each with `source: { name, url, sourceFile, asOf }`; exact normalised-name match only; RoboApply only. |
| Taiwan pay rule (JT-6) | MKT-5F | pay note (same bundle) | `GET /api/v1/roboapply/tw/pay-rule` and `PUT /api/v1/roboapply/admin/tw/pay-rule`; AppConfig key `tw.payRule.v1` (threshold, source link, as-of date). The threshold is never shown as a job's pay. |

### 3.3 Search, retrieve and match

| Contract | Producer | Consumers | Shape |
|---|---|---|---|
| The fit contract `features/match/fit.ts` | MKT-1F | MKT-2F (every consumer), MKT-4E, MKT-4G, MKT-4H | `getFit(userId, jobId, opts?: { allowModelCall?, mode?, locale? })` (primary resume; a model call only when allowed and every gate passes), `getFits(userId, jobIds, opts?: { context?, rows? })` → `Map<jobId, Fit>` (at most 500 ids, never a model call; a caller that already loaded the rows hands them over and no row is read again; a list never reads a description), `getVariantFit(userId, jobId, variantId)` (tailoring only). *As built (M1 gate):* `basis.jobContentHash` is `string \| null` (on a `getFits` row it is the stored `RAJob.contentHash`, null until MKT-2H writes it), a stored AI score for an earlier version of the posting keeps serving with `stale: true`, new wire fields are optional, and `createFitService(deps \| service \| { service })` binds the three functions to in-memory dependencies (the harness uses it). `Fit = { jobId, score, tier, kind: 'ai' \| 'estimate', coverage, confidence, confidenceReason, dimensions, requirements: RequirementCheck[], topOverlap, topGap, basis: { resumeVariantId, resumeContentHash, jobContentHash, searchProfileVersion }, version: { rubric: 'fit_v3' \| 'fit_v4', estimator: 'est_v2', model, prompt }, scoredAt, stale }`. `toWireKind('estimate')` = `'pre'`; `fitToView(fit)`. |
| Requirement wire types `features/match/contract.ts` | MKT-1F | MKT-4D (extraction), MKT-4G (scorer v4), MKT-4E (UI) | `JobRequirement = { id, kind: 'skill' \| 'experience' \| 'education' \| 'domain' \| 'scope', text, importance: 'must' \| 'preferred' }`; `RequirementCheck = JobRequirement & { status: 'met' \| 'partly' \| 'not_shown' \| 'not_applicable', evidence: string }`; `MatchFitView.requirements`. Stored once per posting in `RAJob.requirements = { v: 1, contentHash, model, extractedAt, items }`. |
| Job content hash `features/match/jobHash.ts` | MKT-1F | MKT-2H (`RAJob.contentHash`), MKT-4G | `jobContentHash(row)` = sha1 of the normalised title, the requirement text and the sorted skills. One function for the score key and the index. |
| Preparer hook `features/match/prepare.ts` | MKT-1F | MKT-4E (skill vocabulary loader) | `registerMatchPreparer(fn: () => Promise<void>)`, `runMatchPreparers()`; awaited by `MatchService.userContext` before the estimate. |
| Projections carry the M0 columns | MKT-1F | MKT-2H, 4D, 4E, 4F, 4G | `MatchJobRecord` and `JOB_SELECT`: `skillIds`, `contentHash`, `lang`, `requirements`, `titleMatchScore`; `FEED_COLUMNS`: the same without `requirements`. |
| Harness `features/match/eval/` | MKT-1D | MKT-2F (`seamRegistry.ts`, `enforced.test.ts`), MKT-4E, 4F, 4G (suites and fixtures) | `npm run eval:match [-- --live] [--enforce M1\|M2\|M4\|all] [--market intl\|cn\|all] [--suite <name>]`; `registerInvariants({ enforce })` declares INV-1 to INV-10 (due M1: 1, 2, 4, 5, 6, 8, 9, 10; due M2: 3; due M4: 7). |
| Skill vocabulary `features/skills/` | MKT-2G | MKT-4D (write path), MKT-4E (estimate and keyword check) | `SkillVocabulary { idOf(term), kindOf(id), reviewed(id), label(id, locale), parentOf(id), childrenOf(id), size }`; `loadVocabulary()` with `ready()` and `current()`; `canonicalize(term, deps?: { embed?, nearest?, create? })` → `{ skillId, status: 'reviewed' \| 'unreviewed', via: 'alias' \| 'embedding' \| 'new' \| 'none' }`; `userSkillIds(skills, resumeText)`. Table `RASkill`. *As built (M2 gate):* `label(id, locale)` may return an EMPTY string, which means "show the posting's own string" (an unreviewed skill written in another script); `current()` is the committed seed (273 skills) until the table was read, and `ready()` never rejects; `RASkill.status` holds four values (`reviewed`, `unreviewed`, `dropped`, `seed`) and a consumer reads a skill's status from the vocabulary (`reviewed(id)`), never from the row; `deps` also takes `learn(skillId, aliasKey)`, and `skillStoreDeps(db, { model })` supplies `nearest`, `create` and `learn` (`model` = `resolveEmbeddingConfig(brand, env).modelTag`); a throwing `embed` is NOT caught by `canonicalizeMany`, so the caller maps `{ unavailable }` and a thrown `EmbeddingsError` to null; the term primitives live in `features/skills/terms.ts` and `features/match/terms.ts` re-exports them (the area boundary rule). *Changed at the M2 gate (cross-review):* `evidenceFor(skillId, haveIds)` → `{ state: 'shown' \| 'related' \| 'not_shown' \| 'unscored', via }`; `unscored` is the answer for a skill the vocabulary has not reviewed (or does not hold) that the person does not list exactly, and nothing may render "Not in your resume" for it; a vector of zeros is refused by `vectorLiteral`. |
| Embeddings client `platform/embeddings/client.ts` | MKT-2H | MKT-4D (skills), MKT-4F (query vector) | `resolveEmbeddingConfig(brand, env)` → `{ model, apiKey, baseUrl, batchSize, dimensions: 1024, modelTag }`; `embedTexts(brand, texts, { purpose: 'job' \| 'user' \| 'query' \| 'skill', carriesUserData, userId?, requestId? })` → `{ vectors, model, tokens }` \| `{ unavailable: reason }`. No key or a policy refusal means unavailable, never an error and never a fake vector. *As built (M2 gate):* `unavailable` is `'no_key' \| 'policy' \| 'budget'`; a FAILED call (HTTP, timeout, wrong-sized answer, a budget counter that cannot be read) throws `EmbeddingsError`, so a queue worker retries and a request path catches it; `embeddingAvailability(brand, { carriesUserData })` answers the same three checks with no request; a key is never sent to an endpoint it was not configured for (`EMBED_API_KEY` only with `EMBED_BASE_URL`; GoApply's `CN_EMBED_BASE_URL` and `CN_EMBED_API_KEY` are one pair, and half of it means GoApply embeds nothing: `embeddingEnvProblems`, reported at boot); usage is logged under SKU `ra_embed` (in `DeductionSku` and the feature catalog since the gate); a vector of zeros in the answer is a malformed answer (`EmbeddingsError('bad_response')`), and the retrieval and skills areas refuse to store or query with one. |
| Retrieval seam `features/retrieval/` | MKT-2H | MKT-2F (through `feed/index.ts similarJobIds`), MKT-4F, MKT-4H | `writeSearchDoc(jobId, { searchDoc, contentHash, lang })` (one statement with `to_tsvector('simple', …)`), `upsertJobEmbedding`, `nearestJobsByJob(jobId, { market, country, modelTag, limit })`, `userVector(userId, market, modelTag)`, `currentModelTag(market)`, `toTsQuery(text)` in `retrieval/segment.ts` (the OR of the segmented tokens). Vectors never cross markets. |
| Feed pre-wiring | MKT-2H | MKT-4F, MKT-4H | `FEED_LIMITS.legLimit 200`, `rrfK 60` (`retrievalLimit` stays 400); `FeedOrder` value `query_match`; `FeedItem.alsoIn?: { count, locations: string[], jobIds: string[] }`; `POST /feed/query` accepts `relevance` (≤ 240 characters, order only); `planToFilters` → `{ patch, unmatched, rankedBy }`; `NlQueryResponse.rankedBy: string[]`; `feed/rankingText.ts` (published texts, `FRESHNESS_CURVE`); `sql.ts qPredicateSql(q)`; `feed/index.ts similarJobIds(row, limit)`. |
| Typed-query predicate | MKT-4F | counts, samples, alerts (same file); MKT-5F builds on it | `wideQPredicateSql(q)` in `feed/sql.ts`: `(j."searchTsv" @@ to_tsquery('simple', $q) OR qPredicateSql(q))`; the narrow predicate alone under 3 Latin characters. `predicateFor` case `q` returns it. |
| New-since instant | MKT-5C | feed items (same bundle) | `ItemContext.newSince?: Date \| null` passed by `FeedQueryService`; `isNew` = `firstSeenAt` after it, else after now minus 48 hours. |

## 4. Schema delivered by M0 (MKT-0)

All additive: new models, nullable or defaulted columns, new indexes. No existing column changes type, nullability or default; nothing is renamed; `AlipayOrder` is untouched. Exact Prisma text is in the `schema` array of MKT-0.

| File | Change | Needed by |
|---|---|---|
| ra-jobs.prisma, `RAJob` | `atsPostingKey String?`, `sponsorshipSource String?`, `locationDistrict String?`, `workShift String?`, `titleMatchScore Float? @db.Real`, `skillIds String[] @default([])`, `searchDoc String? @db.Text`, `searchTsv Unsupported("tsvector")?` (written by the application, not generated), `contentHash String?`, `lang String?`, `requirements Json?`, relation `embedding RAJobEmbedding?`; indexes `[market, atsPostingKey]`, `[market, locationCountry, locationDistrict]`, GIN on `skillIds`, GIN on `searchTsv` | JI-5, JI-7, JI-11, JT-7, SM-2, SM-6, SM-7, SM-8 |
| ra-jobs.prisma, `RACareerSiteSource` | `origin String @default("admin")`, `discoveredFrom String?`, `countries String[] @default([])`, `failCount Int @default(0)`, `lastChangeAt DateTime?`, `nextSyncAt DateTime?`, `disabledAt DateTime?`; index `[enabled, nextSyncAt]` | JI-3, JI-4, JC-4, JT-5 |
| ra-jobs.prisma, new `RASponsorRegisterEntry` | USCIS H-1B Employer Data Hub and UK sponsor register rows; unique `[source, employerNameNormalized, period]` | JI-11 |
| ra-match.prisma, `RAJobMatchScore` | `jobContentHash String?`, `rubricVersion String?` | SM-5, SM-8 |
| ra-feed.prisma, `RAUserAffinity` | `titleWeights Json @default("{}")` | SM-12 |
| ra-resume.prisma, `RATailorSession` | `fitSnapshot Json?` | SM-5 (invariant I6) |
| new ra-skills.prisma, `RASkill` | canonical skill vocabulary with aliases (GIN), optional `Unsupported("halfvec(1024)")` label vector | SM-6 |
| new ra-retrieval.prisma, `RAJobEmbedding`, `RAUserEmbedding` | side tables with `Unsupported("halfvec(1024)")`, cascade on job and user; raw SQL access only; one back-relation line in `User` (legacy.prisma) | SM-7 |
| ra-credits.prisma, new `RABillingRefund` | readable record of refunds, withdrawals, disputes and manual CN refunds; unique `[rail, externalRef]`; no relation fields | ST-4, ST-9, AL-7, ST-10 |
| ra-credits.prisma, new `RABillingConsentArchive` | checkout acknowledgements kept after account deletion until `retainUntil`; no relation fields | ST-9 (consent retention) |
| sql/001_vector.sql | `CREATE EXTENSION IF NOT EXISTS vector;` and nothing else (run once per database before the push) | SM-7 |

Not added because it exists: the SR-16b-1 columns (`RAJob.lastSeenQueryId`, `RAJob.lastSeenRun`, `RAIngestQuery.runCount`), `RAJob.sponsorship`, `sponsorshipEvidence`, `skills`, `searchText`. Not needed: provider quota snapshots, the seed hash and the Taiwan pay rule live in `AppConfig`. Beyond strategy section 7 item 11 (named in the diff header for the owner): `RAJob.sponsorshipSource`, `locationDistrict`, `workShift`; the four sync-state columns of `RACareerSiteSource`; `RAUserAffinity.titleWeights`; `RATailorSession.fitSnapshot`; the tables `RASponsorRegisterEntry`, `RABillingRefund`, `RABillingConsentArchive`.

Rule for the M0 engineer: only `npx prisma validate`, `npm run db:generate`, `node scripts/check-schema-additive.mjs`, the two type checks and the two test files. The orchestrator reviews `schema-diffs/market-additive.sql` and applies it to the database branch (`001_vector.sql` first). If the `searchTsv` GIN index needs a raw operator class, the pair is recorded in `schema-diffs/KNOWN_DRIFT.md`.

## 5. Env variables introduced or redefined

Documented in `.env.example` by MKT-1G (M1 variables) and MKT-5H (all later ones). Defaults in brackets are in code; no variable is required for a brand to work except the rail credentials named in strategy M-25.

| Phase | Bundle | Variable: meaning (default) |
|---|---|---|
| M1 | MKT-1A | STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: true lets a live Stripe key work when VERCEL_ENV is not production (default unset = refused) |
| M1 | MKT-1A | STRIPE_WEBHOOK_SECRET / ROBOAPPLY_STRIPE_WEBHOOK_SECRET: now REQUIRED for the Stripe rail to be available (the RoboApply name is read first). As built: since MKT-2B (M2) each variable accepts a comma-separated list and the webhook tries every secret, each trimmed (default unset = plans listed, payments_disabled) |
| M1 | MKT-1A | STRIPE_SECRET_KEY: redefined. A key starting with sk_test_ or rk_test_ is a test key; every other key is treated as a live key and works only when VERCEL_ENV is production or with the override (default unset = no Stripe rail) |
| M1 | MKT-1A | PRICE_<PLANKEY>_USD_CENTS: overrides a RoboApply catalog amount, positive integer cents (default: catalog 999 / 2499 / 5499 / 999 / 999 / 2499 / 1749 / 3799) |
| M1 | MKT-1A | STRIPE_PRICE_<PLANKEY>_CENTS: read as an alias of PRICE_<PLANKEY>_USD_CENTS (default unset) |
| M1 | MKT-1A | STRIPE_PRICE_<PLANKEY>: optional pin of a Stripe price id, honoured only together with an amount variable (default unset = price resolved by the catalog sync) |
| M1 | MKT-1A | PRICE_<PLANKEY>_TWD_CENTS: Taiwan price in TWD minor units, multiple of 100 (default unset = Taiwan pays USD with the reference line) |
| M1 | MKT-1A | STRIPE_PRICE_<PLANKEY>_TWD_CENTS: alias of PRICE_<PLANKEY>_TWD_CENTS; STRIPE_PRICE_<PLANKEY>_TWD: optional pin (default unset) |
| M1 | MKT-1C | JOB_SOURCES_CONTACT: RoboApply's contact URL or mailto printed in the User-Agent of every job-board and open-data request (default: https://www.roboapply.io). Never read for GoApply |
| M1 | MKT-1C | CN_JOB_SOURCES_CONTACT: the same for GoApply (default: https://www.goapply.top). Added after review so one brand's contact never reaches the other market's boards |
| M1 | MKT-1D | EVAL_LIVE: 1 allows "npm run eval:match -- --live" to read the database (read-only) and call models; anything else refuses (unset). Read from the shell only, never from an env file, so `.env.example` describes it without an entry |
| M1 | MKT-1D | EVAL_JUDGE_MODEL: model id of the relevance judge for --live; must differ from the scorer model of the market being judged (the resolved LLM_MATCHING_MODEL, or GoApply's own) (unset: --live refuses to judge). Shell or `.env` |
| M1 | MKT-1F | MATCH_PRIORS: JSON {title_level, skills, industry, logistics, career_path} overriding the starting priors per not-stated component (44 / 39 / 24 / 50 / 45); a malformed value keeps the defaults, like MATCH_WEIGHTS. As built: four of the five are replaced by the market's own mean once a component has 200 model-scored values; logistics never is |
| M1 | MKT-1F | CN_MATCH_PRIORS: the same for GoApply; unset falls back to MATCH_PRIORS, then the defaults (D5) |
| M1 | MKT-1F | MATCH_CALIBRATION_MIN_PAIRS: (estimate, AI) pairs a market needs before the isotonic map replaces the blend (500) |
| M2 | MKT-2A | CN_ALIPAY_NOTIFY_ORIGIN: bare https origin (scheme, host, optional port; no path or query) that receives GoApply Alipay notifies; set it to another host only when that host runs this code on the same database. A value that is not such an origin is ignored and the startup line is a warning (default unset -> CN_BACKEND_URL -> https://www.goapply.top) |
| M2 | MKT-2A | ALIPAY_SECRETLESS_UNTIL: a full ISO instant WITH a zone (2026-10-20T08:00:00Z or …+08:00); a callback without cb is accepted only for an Alipay order production created (a row with no brand) before it, and only until 7 days after it. Anything that is not such an instant keeps the window closed, with a warning at startup (default unset = never) |
| M2 | MKT-2A | CN_ALIPAY_PACKAGE_ID_MODE: legacy sends package_id starter and the plan key in package_name (default unset = the plan key as package_id) |
| M2 | MKT-2B | STRIPE_WEBHOOK_SECRET: accepts a comma-separated list so the CLI secret and the Dashboard endpoint secret can both be live during rotation (no default) |
| M2 | MKT-2B | STRIPE_BILLING_PORTAL_URL: read nowhere; remove it from the examples (the portal configuration is created by code) |
| M2 | MKT-2C | STRIPE_TAX_ENABLED: true (also 1, yes, on) adds automatic tax, tax id collection and a required billing address to Checkout. As built: a switch quote asks for automatic tax only when the subscription already carries it (so the quote equals the charge), and a switch never turns automatic tax on for an older subscription; owner decision pending (waveM2-carryover, Owner). Needs Stripe Tax and registrations in the Dashboard (default unset = off) |
| M2 | MKT-2G | SKILL_EMBED_MATCH_MIN: cosine above which an unknown skill string is mapped to its nearest canonical skill (0.86; tuned by the skills gate, never below 0.8) |
| M2 | MKT-2H | EMBED_MODEL: embedding model for both brands (openai/text-embedding-3-small); requested at 1024 dimensions, the size of the halfvec columns |
| M2 | MKT-2H | EMBED_API_KEY: key of the embeddings endpoint (unset -> OPENAI_API_KEY, but only while EMBED_BASE_URL is unset: a key is never sent to an endpoint it was not configured for) |
| M2 | MKT-2H | EMBED_BASE_URL: OpenAI-compatible base URL (unset -> OPENAI_BASE_URL, then https://api.openai.com/v1) |
| M2 | MKT-2H | EMBED_BATCH_SIZE: inputs per request, at most 96; set it to the vendor's limit when that is lower (a refused batch is halved and the working size remembered per process) (96) |
| M2 | MKT-2H | CN_EMBED_MODEL: optional GoApply override of EMBED_MODEL (unset -> the shared value; recommended by the strategy: Alibaba text-embedding-v4 in the Beijing region) |
| M2 | MKT-2H | CN_EMBED_API_KEY / CN_EMBED_BASE_URL: optional GoApply endpoint and key, ONE PAIR: set both or neither. With one of them set GoApply embeds nothing (reported at boot); for a separate GoApply account on the shared endpoint set the URL to that same endpoint (unset -> shared) |
| M2 | MKT-2H | CN_EMBED_BATCH_SIZE: optional GoApply override of EMBED_BATCH_SIZE; 10 for text-embedding-v4 (the vendor's limit, to be confirmed by the owner) (unset -> shared) |
| M2 | MKT-2H | EMBED_DAILY_TOKENS: tokens a brand may embed per UTC day before the workers defer to the next day; 0 switches embedding off (20000000); CN_EMBED_DAILY_TOKENS overrides it for GoApply |
| M3 | MKT-3A | INGEST_QUOTA_RESERVE_SHARE: share of a provider's monthly request limit that ingest leaves for interactive searches (0.05) |
| M3 | MKT-3A | INGEST_<PROVIDER>_DAILY_CALLS: upper bound of the daily call budget; the effective budget is also capped by remaining quota / days to reset (existing defaults) |
| M3 | MKT-3A | INGEST_<PROVIDER>_CN_DAILY_CALLS: daily call budget for GoApply, counted under <provider>:cn (0) |
| M3 | MKT-3A | INGEST_CURSOR_TICK_SHARE: share of one ingest tick a single cursor source may use (0.4) |
| M3 | MKT-3A | RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET: deprecated alias of INGEST_<PROVIDER>_DAILY_CALLS |
| M3 | MKT-3D | ATS_BOARDS_CONCURRENCY: board listings read in flight by the board sync, clamped to 4-8 (6) |
| M3 | MKT-3D | ATS_SR_DETAILS_PER_RUN: SmartRecruiters posting texts read per board and run (100) |
| M3 | MKT-3D | ATS_DISCOVERY_VALIDATIONS_PER_RUN: candidate sources validated per board-sync run (20) |
| M3 | MKT-3D | ATS_PUBLIC_SOURCES_DISABLED: existing kill switch for every public job-board read (false) |
| M3 | MKT-3E | TW_OPEN_DATA_JOBS_ENABLED: false turns the 台灣就業通 adapter off (on by default; the OGDL v1 licence is confirmed) |
| M3 | MKT-3E | TW_OPEN_DATA_JOBS_URL: the open-data endpoint (https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx) |
| M3 | MKT-3E | TW_OPEN_DATA_REQUESTS_PER_FETCH: sequential requests per adapter fetch (5) |
| M3 | MKT-3E | TW_OPEN_DATA_PAUSE_MS: pause between two requests (1500) |
| M3 | MKT-3E | TW_OPEN_DATA_SWEEP_HOURS: hours between two sweep starts (24) |
| M4 | MKT-4D | ENRICH_REQUIREMENTS_MAX: requirement lines kept per posting (12) |
| M4 | MKT-4F | FEED_HYBRID: off switches retrieval back to the recency leg only (on) |
| M4 | MKT-4F | FEED_QUERY_EMBED_TIMEOUT_MS: how long a request waits for the vector of a typed query before it runs without the dense leg (800) |
| M4 | MKT-4G | MATCH_SCORER_RUBRIC: fit_v4 or fit_v3; the rubric the scorer writes for both brands (fit_v4); CN_MATCH_SCORER_RUBRIC overrides it for GoApply |
| M4 | MKT-4G | LLM_MATCHING_MODEL / CN_LLM_MATCHING_MODEL: existing; the one pinned scorer model per market (unset -> LLM_MODEL; GoApply unset -> the shared value) |
| M5 | MKT-5A | FANTASTIC_MONTHLY_JOBS: jobs a month of the purchased Active Jobs DB plan, when responses do not state it (unset) |
| M5 | MKT-5A | FANTASTIC_FEED_DISABLED: true stops the licensed feed sync (false) |
| M5 | MKT-5A | FANTASTIC_TRANSPORT: rapidapi \| direct (rapidapi) |
| M5 | MKT-5A | FANTASTIC_API_KEY: key of a direct Fantastic.jobs plan (unset) |
| M5 | MKT-5A | FANTASTIC_API_KEY_HEADER: header name for the direct key when the vendor documentation could not be confirmed in code (unset) |
| M5 | MKT-5A | FANTASTIC_FEED_PATH / FANTASTIC_EXPIRED_PATH: route overrides (/active-ats, /expired-ats) |
| M5 | MKT-5A | INGEST_FEED_DAILY_JOBS: hard daily job budget of the feed (monthly jobs / 31) |
| M5 | MKT-5A | INGEST_FEED_CN_DAILY_JOBS: daily job budget of the mainland feed sync (20% of the daily budget) |
| M5 | MKT-5A | INGEST_FEED_COUNTRIES: ISO codes the international feed sync asks for (US,CA,GB,IE,DE,FR,NL,ES,IT,SE,AU,SG,TW) |
| M5 | MKT-5A | INGEST_FEED_TAXONOMIES: optional vendor taxonomy filter (unset) |
| M5 | MKT-5A | CN_ACTIVEJOBS_ENABLED: false keeps Active Jobs DB off for GoApply even with a paid plan (on) |
| M5 | MKT-5B | ATS_WORKABLE_DISABLED: true turns the Workable connector off (false) |
| M5 | MKT-5B | CN_ATS_BEISEN_ENABLED: true registers the 北森 connector; needs counsel sign-off first (false) |
| M5 | MKT-5B | CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN: hard cap per 北森 tenant and run (200) |
| M5 | MKT-5B | CN_ATS_TENANT_DENYLIST: comma list of tenant tokens that are never read (empty) |
| M5 | MKT-5C | LIVENESS_CHECK_DISABLED: true turns the on-demand posting check off (false) |
| M5 | MKT-5C | LIVENESS_RECHECK_HOURS: a row confirmed listed within this many hours is not checked again (6) |
| M5 | MKT-5D | USAJOBS_API_KEY: free key from developer.usajobs.gov; without it the adapter is disabled (unset) |
| M5 | MKT-5D | USAJOBS_USER_AGENT_EMAIL: the contact e-mail the key was issued to, sent as the API requires (unset) |
| M5 | MKT-5D | USAJOBS_DISABLED: true turns the adapter off (false) |
| M5 | MKT-5D | TW_GOV_JOBS_ENABLED: false turns the 事求人 adapter off (on) |
| M5 | MKT-5D | TW_GOV_JOBS_URL: dataset URL override (the documented endpoint) |
| M5 | MKT-5D | TW_GOV_JOBS_INCLUDE_TRANSFERS: true also ingests 一般人員 transfer posts, tagged (false) |
| M5 | MKT-5E | GOHIRE_SYNDICATION_URL: the GoHire syndication endpoint; when set it is the bank transport (unset: the parity wave's transports) |
| M5 | MKT-5E | GOHIRE_SYNDICATION_KEY: scoped service key for that endpoint (falls back to GOHIRE_API_KEY) |
| M5 | MKT-5E | GOHIRE_BANK_TRANSPORT: db \| api \| off, from the parity wave; syndication is implied by GOHIRE_SYNDICATION_URL |

## 6. Owner-only list

Code is built as far as it can go behind the documented switch or quota gate; these steps need the owner, a purchase, counsel or the second repository. Two requirements are owner-only by nature: **JC-3** (the syndication route in the RoboHire / GoHire repository; this repository's side is MKT-5E) and the supervised order of **AL-8** (the script and runbook are MKT-3H).

**Billing**

- ST-0 / section 7 item 2: put an sk_test_ key in the clone .env and run stripe login + stripe listen to obtain a whsec_ secret (browser verification only; all automated tests use the fake client). The code side refuses the live key outside production and closes the rail without a webhook secret; docs/jobright-clone/market/STRIPE_TEST_RECIPE.md (MKT-3H) lists the steps and the scenario pass.
- ST-3 / section 7 item 2: create the live webhook endpoint https://www.roboapply.io/api/v1/roboapply/stripe/webhook subscribed to the fourteen event types and set its secret; say whether the Stripe account is shared with RoboHire (the code assumes it may be and ignores foreign objects). The admin "Stripe" panel shows missing events; the code never edits the endpoint.
- ST-1 / ST-7: if a restricted key is used it needs write access to Products, Prices and Billing Portal configurations and read access to Webhook Endpoints; products, prices and the portal configuration are otherwise created by code on first use.
- ST-8 / section 7 item 12: choose the tax route (own registrations with Stripe Tax, or Stripe Managed Payments) and the selling entity; activate Stripe Tax and add registrations in the Dashboard, then set STRIPE_TAX_ENABLED=true. The switch and tax_behavior inclusive prices are built.
- ST-9 / section 7 item 13: counsel on the withdrawal waiver for subscriptions in the EU, UK and Taiwan, the label of the withdrawal control per locale and the German cancellation-button wording. Built with the pro-rata default; each label is its own i18n key.
- AL-8 / section 7 item 7: one supervised ¥12 order on a deployment the worker can reach, with the five steps of section 5.3, the captured callback attached. Code side: scripts/alipay-notify-preflight.mjs and docs/jobright-clone/market/ALIPAY_CUTOVER.md (MKT-3H); AL-4 tolerance and CN_ALIPAY_PACKAGE_ID_MODE are the knobs the capture decides.
- AL-2 / AL-4 / section 7 item 5: set ALIPAY_CALLBACK_SECRET in the GoApply environment and say whether production has it today (decides ALIPAY_SECRETLESS_UNTIL). Until it is set GoApply lists prices and cannot open a payment.
- AL-3 / section 7 item 8a: confirm that https://www.goapply.top serves /api/v1/* from the deployment and database that create GoApply orders, or name the origin for CN_ALIPAY_NOTIFY_ORIGIN (the pre-flight script proves it).
- AL-6 / section 7 item 8: confirm the default of M-18 (mainland visitors on roboapply.io get a link to GoApply, no redirect, no second Alipay path).
- AL-7 / section 7 item 6: the legal name of the Alipay merchant behind worker platform gohire (CN_PAYMENT_COLLECTING_ENTITY), confirmation that GoApply may sell through it, and who returns money in the merchant console and how fast. The admin action only records a refund already made.
- PC-5 / section 7 item 17: read the practice-cost panel; above $1.00 a session (RoboApply) reprice the 15-pack to $27.99, above about ¥3.5 (GoApply) move the packs to ¥39 / ¥99: one catalog default each (PRICE_PRACTICE_PACK_15_USD_CENTS, CN_PRICE_PRACTICE_PACK_5_FEN / _15_FEN as overrides until the default is changed).
- Schema (section 7 item 11, M0): the additive diff for RABillingRefund and RABillingConsentArchive is shown to the owner before the push to the Neon branch; no existing table is altered (AlipayOrder untouched, rule A8).
- Stripe Dashboard: the retry schedule for failed renewals (Billing, Revenue recovery) is a Dashboard setting; the code is correct for either end state (subscription deleted or unpaid).

**Job sources**

- JC-3: build GET /api/v1/syndication/jobs in the RoboHire / GoHire backend (second repository), issue a scoped service key, add employerVerified, syndicationConsentAt and a validity period to the bank schema, then set GOHIRE_SYNDICATION_URL and GOHIRE_SYNDICATION_KEY. Code side prepared by MKT-5E: the validated wire contract, the HTTP adapter with a stub-server test, the mirror read, docs/jobright-clone/market/GOHIRE_SYNDICATION.md and a read-only probe script.
- JI-7 / JC-6: buy a paid Active Jobs DB plan (upgrade the RapidAPI listing on app 8974502 or a Fantastic.jobs direct key), measure monthly volume with the vendor's count endpoint first, and get a written answer on public pages and retention. Code side prepared by MKT-5A: the window sync, expired feed and mainland sync run by themselves once the plan's monthly job quota is at least 20,000 (or FANTASTIC_MONTHLY_JOBS is set); until then the adapter is gated and the panel says so.
- JI-7: confirm the direct API's authentication header and the expired-feed route from the vendor documentation if the engineer could not; set FANTASTIC_API_KEY_HEADER / FANTASTIC_EXPIRED_PATH accordingly. Trim INGEST_FEED_COUNTRIES after the volume measurement.
- JI-9: request a free USAJobs API key and set USAJOBS_API_KEY and USAJOBS_USER_AGENT_EMAIL. Code side prepared by MKT-5D: the adapter with fixtures; it reports disabled until the key exists.
- JC-8: obtain counsel's memo on reading employer ATS boards in the mainland under 反不正当竞争法 (2025) Art. 13(3), then record one real 北森 response for the fixture, curate the tenant list and set CN_ATS_BEISEN_ENABLED=true. Code side prepared by MKT-5B: the connector behind the flag with per-tenant floor, in-flight limit, cap, takedown path and docs/job-search/ATS_BOARDS.md.
- JC-4 / JI-3: bring the mainland-hiring board list to at least 50 boards with a mainland posting before GoApply's production launch (bulk import on the admin route, then validation by the board sync; discovery adds candidates from ingested links). The seed files contain only the boards the research notes confirm (BoschGroup, Ubisoft2 and what the parity engineer verified).
- JT-4: a Taiwan-native reviewer signs off the zhHant role labels and synonyms (they ship marked draft); set zhHantReview in taxonomy.v1.json when done.
- JT-2 / JT-7: if the engineer could not retrieve an official 3-digit postal code list with its licence, supply it so geo/twDistricts.json can be filled (the sweep runs on its fallback split until then). Optional: a Taiwan-counsel check of the OGDL attribution sentence and a courtesy notice to the dataset contact about the daily sweep.
- JC-5: check from a mainland network any deep-link pattern the engineer left with verifiedOn null (前程无忧, 拉勾, 实习僧, 牛客, 国聘, 24365) and report the working URL shape; only verified patterns are shown.
- JI-11: download the USCIS H-1B Employer Data Hub files and the UK Register of Licensed Sponsors and run the two importers (and the existing LCA importer) against the production database; repeat when new files are published. Code side prepared by MKT-5G: loaders, table, API and the job-page block.
- JI-12 / OPS-A4: decide PUBLIC_DISPLAY_PROVIDERS (recommended first entries: tw_open_data and usajobs) after reading docs/job-search/SOURCE_REGISTER.md; counsel on public display of employer-board rows and JSearch redisplay.
- JI-8: Workable publishes no statement that third parties may read its widget endpoint; decide whether ATS_WORKABLE_DISABLED should be set. Greenhouse pay ranges on the list call are unverified: check one live board after deploy.
- JT-6: when the Ministry of Labor's amendment is promulgated, update AppConfig tw.payRule.v1 (threshold, as-of date, source link) from the admin route; no deploy is needed.
- Schema: review the additive diff of the M0 bundle (RAJob.atsPostingKey, sponsorshipSource, locationDistrict, workShift and two indexes; RACareerSiteSource origin, discoveredFrom, countries, failCount, lastChangeAt, nextSyncAt, disabledAt and one index; new model RASponsorRegisterEntry) and push it to the Neon branch before M1 starts.
- JI-4: confirm the Vercel plan allows one more cron (jobs-boards every 5 minutes makes 16) and add the same job to the mainland CronJob deployment from the regenerated deploy/cn/k8s/cronjobs.yaml.

**Search, retrieve and match**

- SM-7: run server/prisma/sql/001_vector.sql on the Neon branch (and later on each database), read the schema diff, push, and confirm the second diff is empty. The code side prepares the Prisma models, the SQL file, scripts/check-schema-additive.mjs and server/prisma/sql/README.md (MKT-0). The push also creates the three SR-16b-1 columns that are already declared.
- SM-7, SM-11: confirm OpenAI as the embedding processor for RoboApply resumes and profiles, and decide whether GoApply embeds in the mainland (a 百炼 key and CN_EMBED_MODEL / CN_EMBED_BASE_URL / CN_EMBED_API_KEY). The code side runs on the shared default with no key change, switches the dense leg off by itself when no key is set or when CN_LLM_DOMESTIC_ONLY forbids the endpoint, and never sends a GoApply user's text without the AI consent and the 个性化推荐 grant.
- SM-7: read the embedding model's price on the vendor's own pricing page so the cost row can be added (server/src/lib/modelPricing.ts); until then tokens are logged and the cost is recorded as unknown.
- SM-1: about 400 pair judgments per market from RoboHire and GoHire recruiters for the first calibration, then about 100 a quarter; choose EVAL_JUDGE_MODEL; run "npm run eval:match -- --live" (needs EVAL_LIVE=1 and model keys) nightly or before a release. The code side prepares the snapshot export, the judge with its cache, the audit CSV export and import, kappa, and the dated report (MKT-1D).
- SM-1 / strategy 2.5: the Chinese subset of the harness must pass its gates on a real corpus (GoHire bank rows, mainland board rows, imports) before GoApply's production launch. That is a release gate the owner runs with --live --market cn; the code ships fit on GoApply with its confidence shown.
- SM-2, SM-10: run the two backfills with --apply after reading their dry run (re-match of stored roles; clearing implausible stored pay). The engineers deliver the CLI with a dry-run default and never run it against a database.
- SM-3: confirm the logistics rule (strategy keeps logistics inside the 35/30/15/10/10 rubric; a check met only through the user's own hard filter contributes the prior) and the neutral starting prior of 50 for logistics, the one prior the strategy does not give a number for. Priors and the calibration map are then re-estimated from real (estimate, AI) pairs by the cron once a market has 200 and 500 pairs.
- SM-6: approve seeding identifiers from ESCO and O*NET and supply the two files for "skills cli attach-ids"; decide whether Lightcast Open Skills may be used at all (it is not read by any code here); review the top 1,000 skills by frequency through the CSV round trip; a Taiwan-native reviewer for labelZhHant.
- SM-8: record three scorer runs on 100 pairs per market with the pinned model (live mode) and review them so the offline scorer suite has its fixture; the gates (ICC >= 0.85, tier flips under 5%, Spearman >= 0.6 against human grades) can only be read from that run and the recruiter audit.
- SM-12: approve the exploration slot in Recommended (one in ten, disclosed on /help/ranking) before it is built. It is not planned in any bundle.
- SM-7 later: when a market passes about 200,000 live rows an HNSW index is needed; Prisma 7.10 cannot declare one and db push would drop it, so that step needs an owner decision on how the schema is migrated.

**Choices the plan made that the owner may overrule** (each a named constant or an additive field): the refund-line numbers served by `GET /billing/plans`; a refunded pass shortens the end date by its length; English `custom_text` on Stripe Checkout; the System panel shows a summary line and the credits console the full Stripe readout; 5% quota reserve, 40% tick share for cursor sources, 5-minute board cron with 6 in flight, sweep of 5 requests per fetch, source priorities, `INGEST_FEED_COUNTRIES`, 北森 cap 200, liveness recheck 6 h; logistics prior 50, related evidence counts half, skill-embedding threshold 0.86, wrong-title weight −0.25, seen-and-skipped 5 / 7.5 / 10 points, dense-leg model switch at 90% coverage (as built in M2: at the crossover, `MODEL_SWITCH_SHARE = 0.5`, because `RAJobEmbedding` keeps one row per job and 90% would leave queries on a model that holds a tenth of the rows; owner confirmation pending, `requests/waveM2-carryover.md`, Owner); invariant I3 read strictly (the estimate no longer takes the role from the saved search's filter). Three more M2 choices that depart from the item text and wait for the owner in the same list: the five-part cancel / resume idempotency key, the tax rule for switch quotes, and pro-rata withdrawal decided before the 7-day first-purchase rule.

## 7. Coverage of MARKET_STRATEGY section 9

Every requirement id of section 9 is listed. "Bundles" are the bundles whose `requirements` array names the id, in phase order (an earlier bundle may only prepare a contract or a column; the bundle titles of section 1 say which part each one builds).

| Requirement | Bundles | Parity wave | Owner step | Note |
|---|---|---|---|---|
| PC-1 | MKT-1A, MKT-1G | GoApply half: parity wave PAR-6 | — |  |
| PC-2 | — | parity wave: PAR-6 (complete) | — |  |
| PC-3 | MKT-1B | — | — |  |
| PC-4 | MKT-1B | — | — |  |
| PC-5 | MKT-4B, MKT-4C | — | read the panel and reprice if above the threshold |  |
| ST-0 | MKT-1A, MKT-1G, MKT-3H | — | test key and `stripe listen` secret for browser verification |  |
| ST-1 | MKT-1A | — | — |  |
| ST-2 | MKT-1A, MKT-1B | — | — |  |
| ST-3 | MKT-2B, MKT-2E, MKT-4B, MKT-4C | — | live webhook endpoint and its secret |  |
| ST-4 | MKT-0, MKT-2D, MKT-4B, MKT-4C | — | — |  |
| ST-5 | MKT-2B, MKT-2C, MKT-2E | — | — |  |
| ST-6 | MKT-2C, MKT-2E | — | — |  |
| ST-7 | MKT-2B, MKT-2E | — | — |  |
| ST-8 | MKT-2C | — | tax route, Stripe Tax registrations |  |
| ST-9 | MKT-0, MKT-2D, MKT-4A, MKT-4C | — | counsel on the waiver and the labels |  |
| ST-10 | MKT-4B, MKT-4C | — | — |  |
| AL-1 | — | parity wave: PAR-6, first item (complete) | — |  |
| AL-2 | — | parity wave: PAR-1 (flags), PAR-6 (complete) | — |  |
| AL-3 | MKT-2A | — | confirm the notify origin |  |
| AL-4 | MKT-2A | — | callback secret in the GoApply environment |  |
| AL-5 | — | parity wave: PAR-6 (complete) | — |  |
| AL-6 | MKT-2B, MKT-2E | — | confirm the M-18 default |  |
| AL-7 | MKT-0, MKT-4B, MKT-4C | — | merchant entity; refunds are made in the merchant console |  |
| AL-8 | MKT-3H | — | owner only: the supervised ¥12 order (code side: script and runbook) |  |
| JI-1 | MKT-1C, MKT-3A, MKT-3F | — | — |  |
| JI-2 | MKT-1C, MKT-3B | `linkedin` line: parity wave PAR-1 | — |  |
| JI-3 | MKT-0, MKT-3D | — | 50 mainland-hiring boards before GoApply launch |  |
| JI-4 | MKT-0, MKT-3D | — | Vercel plan allows a 16th cron |  |
| JI-5 | MKT-0, MKT-3C | — | — |  |
| JI-6 | MKT-3A, MKT-3B, MKT-3C | — | — |  |
| JI-7 | MKT-0, MKT-1C, MKT-3C, MKT-5A | — | paid Active Jobs DB plan |  |
| JI-8 | MKT-3C, MKT-5B | — | decision on the Workable endpoint |  |
| JI-9 | MKT-1C, MKT-5D | — | free USAJobs key |  |
| JI-10 | MKT-3C, MKT-5C | — | — |  |
| JI-11 | MKT-0, MKT-4D, MKT-5C, MKT-5G | — | download the files and run the importers |  |
| JI-12 | MKT-5D | — | `PUBLIC_DISPLAY_PROVIDERS` decision |  |
| JT-1 | MKT-1C | — | — |  |
| JT-2 | MKT-1C, MKT-3E | — | official postal code list if not retrievable |  |
| JT-3 | MKT-3A, MKT-3B | — | — |  |
| JT-4 | MKT-1C, MKT-3E | — | Taiwan-native reviewer |  |
| JT-5 | MKT-3D, MKT-3E | — | — |  |
| JT-6 | MKT-5F | — | update the config when the amendment is promulgated |  |
| JT-7 | MKT-0, MKT-3C, MKT-5F | — | — |  |
| JT-8 | MKT-5F | — | — |  |
| JT-9 | MKT-1C, MKT-5D | — | — |  |
| JC-1 | — | parity wave: PAR-1, PAR-7, PAR-11, PAR-8 (complete) | — |  |
| JC-2 | MKT-5E | interim reader: parity wave PAR-7 | — |  |
| JC-3 | MKT-5E | — | owner only: route in the RoboHire / GoHire repository (code side here: contract, adapter with stub-server test, mirror read, probe) |  |
| JC-4 | MKT-3D | routing and first seed: parity wave PAR-7 | — |  |
| JC-5 | MKT-3G | — | verify unverified deep-link patterns from a mainland network |  |
| JC-6 | MKT-3A, MKT-5A | — | paid plan |  |
| JC-7 | MKT-3C | parity wave: PAR-1, PAR-7; priority 3 for the GoHire bank and the checks: here | — |  |
| JC-8 | MKT-5B | — | counsel memo, then enable the flag |  |
| SM-1 | MKT-1D | — | recruiter judgments, judge model, live runs |  |
| SM-2 | MKT-0, MKT-1E, MKT-4D | — | run the backfill with --apply |  |
| SM-3 | MKT-1F, MKT-2F, MKT-4E | — | confirm the logistics prior |  |
| SM-4 | MKT-1F | — | — |  |
| SM-5 | MKT-0, MKT-1F, MKT-2F, MKT-4G | — | — |  |
| SM-6 | MKT-0, MKT-2G, MKT-4D, MKT-4E | — | approve ESCO / O*NET seeding, hand review |  |
| SM-7 | MKT-0, MKT-2F, MKT-2H, MKT-4F | — | vector extension and push; embedding processor decision |  |
| SM-8 | MKT-0, MKT-4D, MKT-4E, MKT-4G | — | recorded live runs for the gates |  |
| SM-9 | MKT-2H, MKT-4F, MKT-4H | — | — |  |
| SM-10 | MKT-1E | — | run the pay backfill with --apply | pay plausibility and country-only location already exist on the branch (verified by invariants 6 and 9); this wave adds the backfill and company industries |
| SM-11 | MKT-1E, MKT-2F, MKT-2H, MKT-3B, MKT-4F | — | — |  |
| SM-12 | MKT-0, MKT-2H, MKT-4F | — | approve the exploration slot (not built) |  |
| OT-1 | MKT-1G, MKT-5H | — | — |  |
| OT-2 | — | — | — | orchestrator after every phase: merge `i18n/staging`, translate into all locales, `npm run check` (every bundle stages its English strings) |

No requirement is uncovered. JC-3 and the AL-8 order are owner-only; their code-side counterparts are planned (MKT-5E, MKT-3H).

## 8. Changes made in consolidation

The three domain drafts are kept in `orch/market-plan/` (`billing.json`, `sources.json`, `match.json`). Item text is theirs except for the following.

| # | Change | Why |
|---|---|---|
| Ids | MKT-B1…B11, MKT-J1…J15, MKT-S0…S11 became MKT-0 and MKT-<phase><letter>: 1A = B1, 1B = B2, 1C = J1, 1D = S1, 1E = S2, 1F = S3; 2A…2E = B3…B7, 2F = S4, 2G = S5, 2H = S6; 3A…3G = J2…J8, 3H = B11; 4A = B8, 4B = B9, 4C = B10, 4D = S7, 4E = S8, 4F = S9, 4G = S10, 4H = S11; 5A…5G = J9…J15. Every reference inside items, schema and env text was rewritten. | One id scheme for the orchestrator. |
| Phases | Three work phases became five. Billing M2 and match M2 → M2; sources M2 → M3; billing M3 and match M3 → M4; sources M3 → M5; the runbook bundle (B11) → M3. | A phase carries at most 8 bundles; the drafts had 15 and 16. The order keeps every dependency and every cross-domain assumption (match M3 after sources M2; sources M3 after match M2). |
| M0 | One schema bundle. It folds the match draft's S0 with the schema arrays of B6, B8, J4, J5 and J15, checked against the models on the branch; adds the reviewable diff file and the `KNOWN_DRIFT` rule for a raw operator class. | The drafts had one schema bundle for match only; billing and sources listed their schema as input. |
| New bundles | MKT-1G and MKT-5H (plan documents, `.env.example`, `deploy/cn/cn.env.example`). | OT-1 and the "env docs" of ST-0 and PC-1 had no owner; `.env.example` is a hot file that no draft owned. |
| Harness stage names | In MKT-1D, MKT-2F and MKT-4E the third stage `M3` became `M4` (`--enforce M1\|M2\|M4\|all`; INV-7 due M4). | The stage names are the phase names. |
| Feed predicate (SM-7) | MKT-4F now owns `feed/sql.ts` and `feed/contract.ts` and makes the two changes the match draft had left as requests: case `q` of `predicateFor` uses the wide predicate; the unused `freshnessHalfLifeHours` is deleted. | The files have no other owner in M4 now, and the draft's sentence "belongs to another bundle in this phase" was no longer true. |
| New-since instant (JI-10) | MKT-5C owns `FeedQueryService.ts` and passes `newSince` itself. | The sources draft had a request to another domain for one argument; the file is free in M5. |
| Sponsorship source (JI-11) | New item in MKT-4D: enrichment writes `sponsorshipSource = 'posting_quote'`; MKT-3C's item points to it. | MKT-3C had left it as a handoff note for "another owner". |
| Provider query labels (SM-11) | MKT-3B builds its Taiwan and mainland query texts with `providerQueryLabels` from MKT-1E. | Both drafts described the function; the planner item did not call it. |
| Stripe endpoint health (ST-3) | MKT-4C adds a summary line to the admin System panel (owns `SystemConsole.tsx` and the `admin` namespace in M4); the full readout stays in the credits console. | Strategy 5.1 names the System panel; the billing draft could not own it in its phase. |
| Wording | Relative phase wording ("the next phase", "in this same phase", "M2 and M3 bundles", "see sharedFiles") was replaced by the real phase or bundle in MKT-1A, 1C, 1E, 2G, 2H, 3C, 3H, 4B, 4F. | The sentences were written for a three-phase layout. |
| Schema arrays | Every bundle with a schema array depends on MKT-0 and says so in the last entry. | One delivery point. |

Shared files named by the drafts and how each is settled: `flags.ts` and its fixtures → MKT-1A; `RAAdminOperationsService.ts` → MKT-1A; `.env.example` → MKT-1G and MKT-5H; `pages.test.tsx` → MKT-1B with a merge-time check; `SystemConsole.tsx` → MKT-3F then MKT-4C; `retention.ts` and `SeekerAccountPurgeService.ts` → MKT-4A; `docs/jobright-clone/market/` → single files only (MKT-3H, MKT-5E), never the directory; `normalize/` → MKT-1C (files), MKT-3C (folder), MKT-5A and MKT-5F (files); `taxonomy/` → MKT-1C and MKT-1E (files), MKT-3E (folder); `planner.ts` → MKT-3B, MKT-5A; `marketHooks.ts` → MKT-3E; `upsert.ts`, `maintain.ts` → MKT-3C, MKT-5C; `pipeline.ts` → MKT-3A; cron files → MKT-3D; admin files → MKT-3F; `feed/sql.ts` → MKT-1F, MKT-2H, MKT-4F, MKT-5F in turn; `search/filterSet.ts`, `components/features/filters/`, namespace `filters` → MKT-5F; `feed/items.ts`, `feed/contract.ts` → MKT-2H, MKT-4F (contract), MKT-5C; `FeedQueryService.ts` → MKT-1F, MKT-2H, MKT-4F, MKT-5C; `jobs/detail/` → MKT-2F, MKT-5C; `agent/` → MKT-2F, MKT-5C (deps.ts, service.ts); `components/features/job/` → MKT-5C and MKT-5G (disjoint files); `jobs/companies/` → MKT-1E, MKT-5G; `features/index.ts` → MKT-5F; `i18n/staging/index.ts` → MKT-5G; `raExternalJobTypes.ts` → MKT-3A, MKT-5A; `package.json` → MKT-1D; namespace `landing` → MKT-1F, MKT-4F; `jobs/enrich/` → MKT-1E, MKT-2H (two files), MKT-4D; `modelPricing.ts` and `docs/LLM_COSTS.md` → MKT-2H; `JobCard.tsx` → MKT-2F, MKT-5C; marketing `CompanyPages.tsx` and `catalog.ts` → MKT-4F; namespace `jobs` → MKT-4F; `server/src/job-search/` → MKT-4H; the prisma files → MKT-0.

## 9. Critic review (2026-10-11)

Read: the strategy (sections 0 to 6, 9, 10), both plan files, about 70 item bodies in full and every item's FILES and TESTS lines by script; more than 30 file, function and line anchors re-checked in the code (all correct); the research notes where an item cites a tenant, an endpoint or a URL pattern. New input the planners did not have: the parity wave's PAR-6 handoff and its 43 tests named `A<n> …` in the PAR-6 worktree. Those tests are stricter than the twelve rules read alone, and four items contradicted them.

| # | Finding | Evidence | Fix |
|---|---|---|---|
| K1 | The Stripe rail would have accepted a GoApply order: the item replaced "has a Stripe price id" by "is sellable and has an amount", and GoApply plans are sellable with a CNY amount since the parity wave. | `rails.test.ts` "A11 the Stripe rail refuses a GoApply order before it creates a customer or a session" expects `plan_not_sellable` and no Stripe call | MKT-1A items 3 and 4: brand check in the rail, currency check in the catalog sync, acceptance lines |
| K2 | The amount tolerance read the order on every valid callback. The A6 tests run a valid callback on a database object that throws. | `rails.test.ts` "A6 the secret may arrive…" and "A6 the trade facts…" | MKT-2A item 4: read the order only when the value can be fen (no decimal point, multiple of 100); the read never throws; item 5 opens the database only inside a live window |
| K3 | AL-3 named one pre-existing assertion to adapt; the parity tests hold three that are not A-tests (order prefix, and two "body is the subject" assertions for the no-entity case). | `rails.test.ts` as built; PAR-6 findings 1 and 2 | MKT-2A items 1 and 3 name the three; the order-number pattern allowed no underscore in the user part |
| K4 | ST-10 added `channel` and `refunded` to every history row. The A10 test compares the rows with `toEqual`. | `routes/billing.test.ts` "A10 GET /history lists every completed ra_ order…" | MKT-4B item 5, MKT-4C item 5, contract table: optional keys, omitted when they add nothing |
| K5 | A GoApply-branded Stripe session must keep answering `handled: true`; subscription and invoice events could rewrite the brand of a stored row. | A11 test in `RoboApplyBillingService.stripe.test.ts`; PAR-6 finding 10 | MKT-2B item 1 |
| K6 | Cold demand queries kept today's 12 h refresh; strategy 1.2 says 24 h, and 1.3 says 12 h for Taiwan. | `planner.ts` `REFRESH` | MKT-3B item 3 and MKT-3A item 2 (one optional field, passed through a variable) |
| K7 | Active Jobs DB could never reach GoApply: `adaptersForBrand` drops a built-in provider the brand does not list, and no bundle may edit the brand registry. | `ingest/providers.ts`, `platform/brand/registry.test.ts` | MKT-5A item 6 adds the rule in `providers.ts` |
| K8 | "Test postings filtered" (JC-2) was stated only for the other repository. | strategy 1.4, 9.6 | MKT-5E item 2: skipped and counted on every transport |
| K9 | `dependsOn` missed two earlier owners of the same files. | `taxonomy/` (MKT-1E), `jobs/detail/` (MKT-2F) | MKT-3E, MKT-5C |

Left as written, with the reason: five work phases (a phase holds at most 8 bundles); AL-3 and AL-4 in M2 (they share `rails.test.ts` with MKT-1A in M1); OT-2 as the orchestrator's step (engineers may not edit `i18n/messages`); MKT-3D as one bundle of seven items (its items share five files; the notes say which item to hand over if the session runs out). Not re-read in full: about 130 item bodies of the job-source and match bundles, which were checked by keyword against the numbers of strategy 1, 2.4 and 2.6 and by their FILES lines only.

