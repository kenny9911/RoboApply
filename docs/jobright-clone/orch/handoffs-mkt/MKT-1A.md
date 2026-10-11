# MKT-1A

Stripe safety first, USD catalog defaults, catalog sync by lookup key, checkout rail (server). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1A`, branch `wp/MKT-1A`. Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser. No command reached Stripe or any other provider: every Stripe test uses a hand-written fake, `setStripeClientForTests` or a mocked SDK.

All six items are done, plus one carry-over item (`studentOffer`), and the five review findings are resolved (four in code, one as a verified replacement for a file with no M1 owner; see "Review resolution"). Every test in a file MKT-1A owns is green (18 files, 863 tests). Both typechecks and `npm run check` pass for the whole repository. The full suite has the same 33 failures in 7 files as before the review, all outside my owns and all caused by the catalog rule this bundle was asked to build: 32 in MKT-1B's web test files (expected to be resolved by MKT-1B's own rewritten fixtures; not measured on a merged tree) and 1 in a file with no M1 owner (exact replacement given and verified again after the review changes).

Read first:
- **What a deploy of this code does.** A RoboApply deployment with a usable Stripe key AND a single webhook secret sells every plan at the catalog amounts ($9.99 / $24.99 / $54.99, pass $9.99, packs $9.99 / $24.99) with no price variable. The first checkout of each plan creates its Product and Price in that Stripe account (ids `ra_pro`, `ra_pro_student`, `ra_pro_week_pass`, `ra_practice_pack`; lookup keys `ra_<planKey>_<currency>_<amount>_incl`). A restricted key needs write access to Products and Prices.
- **A deployment that has a key and no webhook secret stops selling.** `pay.stripe` is off, plans list with their amounts and `payments_disabled`, and one warning line says why. Before this bundle it would have taken money and never fulfilled. Check the Vercel project for `STRIPE_WEBHOOK_SECRET` (or `ROBOAPPLY_STRIPE_WEBHOOK_SECRET`) before the deploy.
- **A comma-separated list of webhook secrets keeps the rail CLOSED in this phase** (changed after the review). The webhook route still verifies with the one string it reads, so a list would take money and reject every event. The rail opens on a list only after the route tries every secret: a two-part change, exact text under Requests (Orchestrator), verified in memory. This deviates from `MARKET_TASK_PLAN.md` §5, row M1 / MKT-1A ("a comma-separated list is accepted") and follows `MARKET_STRATEGY.md` M-25 ("a rail is available only when it can both charge and fulfil"); the strategy is decisive.
- **The live key in the clone `.env` is inert.** `getStripe()` returns null for a live key unless `VERCEL_ENV=production` or `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true`. On the dev stack RoboApply shows prices and cannot open a payment until the owner supplies a `sk_test_` key and a `stripe listen` secret.
- **Every key that does not start with `sk_test_` or `rk_test_` counts as a live key** (changed after the review). A key in a format the code does not know is refused outside production, never taken for a test key.
- **`VERCEL_ENV` is the only production signal.** A RoboApply production that does not run on Vercel must set `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true` (`NODE_ENV=production` is deliberately not enough: a local `next start` is production too).
- **Existing deployments that set the old pair keep their prices.** `STRIPE_PRICE_<KEY>` + `STRIPE_PRICE_<KEY>_CENTS` is read as a pin plus its amount, exactly as before. New after the review: if `PRICE_<KEY>_USD_CENTS` is ALSO set to a different amount, the pin is ignored (logged once) and the buyer is charged the amount shown, on a synced price.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-1A.md` (same text as this message).

## Review resolution

1. **[medium] A pin honoured next to an amount it was not declared with: fixed.** Verified first: `{ PRICE_PRO_MONTHLY_USD_CENTS: '1999', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499', STRIPE_PRICE_PRO_MONTHLY: 'price_old_2499' }` did give `amountMinor 1999` with `stripePriceId 'price_old_2499'`. `planCatalog.ts` now has one rule in one function, `readOverrideWithPin`, used for the USD and the Taiwan variables alike: a pin stands only when the amount in force is the amount it was set with. It is ignored and logged once (variable names only, never the price id) when there is no valid amount variable (as before) and, new, when both amount variables are valid and differ. The catalog sync then resolves the price for the amount in force. Two amounts that agree, or one valid amount next to an invalid one, keep the pin. An ignored pin maps to no plan in `planKeyForStripePrice`. Tests: `planCatalog.test.ts` (the three-variable env, the agreeing pair, the invalid alias, the Taiwan triple), `rails/stripe.checkout.test.ts` (end to end: the session opens on the price under `ra_pro_monthly_usd_1999_incl`, the pin appears nowhere in the session, the text above the pay button says $19.99).
   - **The optional stronger fix (retrieve a pinned price and check it) was not built**, on purpose: item 3 ACCEPT says a pin makes no Stripe call; a restricted key that may create Checkout Sessions but not read Prices would stop selling; and no deployment sets a pin today (strategy §5.1). What remains is the trust the old pair always had: an operator who sets a pin next to ONE wrong amount is still believed. The right home for the check is the endpoint health check of MKT-2B (`stripeHealth.ts`): see Requests.
2. **[low] The live-key guard classified by a live prefix list: fixed.** Verified first: `sk_org_live_abc`, `SK_LIVE_abc` and `xx_sk_live_abc` answered mode `test`, usable. `stripeEnv.ts` `stripeKeyMode` is inverted: `test` only for `sk_test_` / `rk_test_`; every other non-empty key is `live` and needs `VERCEL_ENV=production` or the override. The refusal line in `getStripe` now says the key "is not a test key (sk_test_ or rk_test_), so it is treated as a live key". Tests: `stripeEnv.test.ts` (the three strings of the review plus `SK_TEST_abc`, `xx_sk_test_abc`, `pk_test_abc`, `sk_testabc`, `changeme`: live, refused in four runtimes, usable in production or with the override), `stripeClient.test.ts` (nothing constructed, one error line, no key material), `planCatalog.test.ts`, `rails/registry.test.ts`, `flags.test.ts`. I searched the repository for Stripe key literals first: every test uses `sk_test_…` or `sk_live_…`, so nothing else moved.
3. **[low] A comma-separated webhook secret opened the rail while the webhook rejected every event: closed in code inside my owns, and the route change is a Request.** Verified first: `stripeRailReady` answered true for `whsec_a,whsec_b` and `routes/stripeWebhook.ts:30` passes the whole string to `constructEvent`. The route has no M1 owner, so I could not make it loop. What I did instead, in `stripeEnv.ts`: `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` (false in this phase), `stripeWebhookCanVerify(env)` (at least one secret, and while the constant is false the one string the route reads is a single secret: no comma, not blank), `stripeRailBlocker(env)` (the first reason the rail is closed, or null) and `stripeRailReady` = no blocker. So a list (or a whitespace-only RoboApply variable in front of a real secret, which the route would also read) keeps `pay.stripe` off and plans `payments_disabled`; `planCatalog.ts` says why once (`Stripe payments are closed: …`, variable names only), and also for a key with no secret at all. `stripeWebhookSecrets` still splits lists, as the contract says. Tests: `stripeEnv.test.ts` (five shapes of "not one secret"), `planCatalog.test.ts`, `registry.test.ts`, `flags.test.ts`. Every one of those assertions follows the constant, and I ran the billing suites with the constant set to true in memory: exactly one test fails, the pin `'the route does not try every secret yet'`. The route change itself is written out and verified under Requests (Orchestrator).
4. **[low] GoApply's public plans response published `refund-v1-2026-10-pending-counsel`: fixed.** Verified first in `features/credits/service.ts`. `refunds.ts` is not mine, so the public label is made in the service: `publicRefundPolicyVersion(version)` cuts everything from `-pending` on, and `plans()` sends that. Both brands now answer `refund-v1-2026-10`; stored refund decisions keep the full value (`computeRefund` is untouched). `contract.ts` documents `version` as the public label. Tests in `credits.test.ts`: the version of either brand matches `^refund-v\d+-\d{4}-\d{2}$`, contains neither "pending" nor "counsel", is the start of the stored version, and the whole JSON of `GET /billing/plans` on either host does not contain "pending". The earlier assertion that the two brands' versions differ is gone (it pinned the leak).
5. **[low] One test with no M1 owner stays red: not mine to edit, replacement verified again.** `server/src/platform/credits/EntitlementService.test.ts` is outside my owns. The replacement under "Red tests for other bundles" was applied in memory again after the review changes (a scratch Vitest config that rewrites the file's text on load; the file on disk is untouched): 15 of 15 pass. The reviewer is right that its `PAY_ENV` list must also blank the two webhook-secret names, `VERCEL_ENV` and the override; the replacement does that.

No unowned edits were found by the review and none exist: `git status` lists 35 paths, all inside MKT-1A's owns.

## Items

### 1. [P0] Live-key guard inside getStripe, one client factory, rail needs key AND webhook secret (ST-0): done

- New `server/src/platform/billing/stripeEnv.ts` (pure: no SDK, no logger, no import of `flags.ts`): `stripeSecretKey`, `stripeKeyMode` (`none | test | live`; `test` = `sk_test_` or `rk_test_`, every other key is `live`), `liveKeyAllowed`, `stripeKeyUsable` → `{ usable, reason: 'missing' | 'live_key_outside_production' | null }`, `stripeWebhookSecrets` (both variables, the RoboApply one first, comma-split, trimmed, empties and repeats dropped), `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` (false), `stripeWebhookCanVerify`, `stripeRailBlocker` → `'missing' | 'live_key_outside_production' | 'webhook_secret_missing' | 'webhook_secret_unverifiable' | null`, `stripeRailReady` (= no blocker).
- `stripeClient.ts` `getStripe`: test seam first; null when the key is not usable; the refusal is logged once per process at error level, names `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION`, and carries no part of the key; the client is built with `maxNetworkRetries: 2` and `appInfo { name: 'RoboApply', url: 'https://www.roboapply.io' }`. New `resetStripeClientForTests()`.
- `RAAdminOperationsService.ts`: the second `new Stripe(...)` is gone. The payments report asks `getStripe()` and passes `{ timeout: 6000, maxNetworkRetries: 0 }` as per-request options of `invoices.list`; coverage stays `not_configured` when the factory answers null.
- `rails/stripe.ts` `isConfigured` and `flags.ts` case `pay.stripe` use `stripeRailReady(env)` (in `flags.ts`: one import and one line, nothing else).
- Fixtures that name a Stripe key and expect the rail on got `STRIPE_WEBHOOK_SECRET: 'whsec_test'` (the files the item lists).

ACCEPT, all tested: a live key outside production makes `getStripe` return null and constructs nothing; the override and `VERCEL_ENV=production` restore it; a test key works in any runtime; a key without a webhook secret lists plans with amounts and `payments_disabled`; `GET /api/v1/public/brand` reports `pay.stripe` false until both are set; no file under `server/src`, `api/` or `scripts/` other than `stripeClient.ts` contains `new Stripe(` or imports the SDK as a value.

Tests: `stripeEnv.test.ts` (new, 34), `stripeClient.test.ts` (new, 12), `stripeSingleClient.test.ts` (new, 3: source scan), `rails/registry.test.ts`, `flags.test.ts`, `features/brand/routes.test.ts`, `RAAdminOperationsService.test.ts` (5 new cases).

### 2. [P0] RoboApply catalog defaults in USD, overrides with the old names as aliases, sellable without a price id (PC-1): done

`planCatalog.ts`:
- `ROBOAPPLY_DEFAULT_PRICE_USD_CENTS` (exported): 999, 2499, 5499, 999, 999, 2499, 1749, 3799.
- Amount = `PRICE_<KEY>_USD_CENTS` (positive integer) → `STRIPE_PRICE_<KEY>_CENTS` (alias) → default. An invalid non-blank value is ignored and logged once.
- `STRIPE_PRICE_<KEY>` is a pin, honoured only next to the amount it was set with (`readOverrideWithPin`): one valid amount variable, or two that agree. A pin alone, or next to two amounts that differ, is ignored and logged once per key (variable names only, never the price id).
- Sellable = `stripeRailReady(env)`, else `payments_disabled`. `price_unset` is no longer answered for any plan of the §4.3 matrix (the union member stays). A key whose webhook secret is missing or is not a single secret is reported once (`Stripe payments are closed: …`).
- Taiwan: `PRICE_<KEY>_TWD_CENTS` → `STRIPE_PRICE_<KEY>_TWD_CENTS` (alias); not a multiple of 100 → ignored and logged; `LocalPrice.stripePriceId` is `string | null` (the optional pin `STRIPE_PRICE_<KEY>_TWD`, under the same pin rule); `twdPrice` exists whenever the TWD amount is valid.
- `priceEnvNames('roboapply', key)` → `[PRICE_<KEY>_USD_CENTS, STRIPE_PRICE_<KEY>_CENTS, STRIPE_PRICE_<KEY>]`; `twdPriceEnvNames(key)` → `[PRICE_<KEY>_TWD_CENTS, STRIPE_PRICE_<KEY>_TWD_CENTS, STRIPE_PRICE_<KEY>_TWD]`.
- `planKeyForStripePrice` resolves pins that stand, only. New test-only export `resetPlanCatalogReportsForTests()`. Header comment rewritten.
- **PAR-6 verified, nothing corrected:** GoApply defaults are 1200 / 3900 / 9900 / 2900 / 7900 / 2900 / 6900 fen; `pro_weekly` is not defined for GoApply; `CN_PRICE_PRO_MONTHLY_FEN=3990` is ignored and logged; `CN_PAYMENTS_ENABLED` is a kill switch. All match §4.2.

`features/credits/service.ts` `plans()` and `contract.ts`: `checkout.collectingEntity` (GoApply's `CN_PAYMENT_COLLECTING_ENTITY`, trimmed; null when unset and always null on RoboApply) and `refundPolicy` (the seven fields, from the constants of `refunds.ts`; `version` is the public label of the brand's version, see Review resolution 4). `paymentsOpen` keeps its rule.

ACCEPT, all tested: the two-brand matrix test walks `PLAN_DEFINITIONS[brand]` against the §4.3 table; quarterly prints 26 and 15; student 30 / 30 and 25 / 30; weekly equivalent 4329; `PRICE_PRO_MONTHLY_USD_CENTS=2999` beats `STRIPE_PRICE_PRO_MONTHLY_CENTS`, which beats the default; key + webhook secret and no price variable → every plan sellable with `stripePriceId: null`; key alone → amounts with `payments_disabled`; pin without amount ignored and logged; `74950` ignored and logged, `74900` gives `{ currency: 'TWD', amountMinor: 74900, stripePriceId: null }`; `GET /billing/plans` carries both new fields on either host.

Tests: `planCatalog.test.ts` (rewritten, 69), `money.test.ts`, `accountV2.test.ts`, `features/credits/credits.test.ts` (11 new cases; 63 in the file).

### 3. [P0] Stripe Products and Prices synced from the catalog by lookup key (ST-1): done

New `server/src/platform/billing/stripeCatalog.ts`, exported from `index.ts`:
- `stripeLookupKey` / `parseStripeLookupKey`, `STRIPE_PRODUCT_FOR_PLAN`, `stripeRecurringFor` (quarter = month × 3; none for the pass and packs).
- `resolveStripePriceId(stripe, plan, currency)`: refuses a plan that is not RoboApply's or not priced in USD with `plan_not_sellable` before any Stripe call (rule A11); a pin is returned with no call; one in-flight promise per lookup key and Stripe client (a rejected one is removed); `prices.list({ lookup_keys, active: true, limit })`; a found price must match amount, currency and recurrence or the call fails with `payment_provider_error` (`details.reason: 'price_mismatch'`), logged, and the key is never moved; `prices.create` with `tax_behavior: 'inclusive'`, the lookup key, `metadata { product, planKey }` and idempotency key `catalog:<lookup_key>`; products with `catalog:product:<id>`, `resource_already_exists` is success.
- **The lost race:** on any failed create the code lists once more and uses what it finds. I did not key this on a Stripe error code for "lookup key taken" because I could not confirm one (D3); listing again is correct for every failure cause.
- `planKeyForPrice(price | id, env)`: `metadata.planKey` (unless the price names another `product`) → lookup key → env pins → null. Never calls Stripe.
- `syncStripeCatalog(stripe, env)`: optional warm-up; lists at most 10 keys per call, creates only what is missing, includes configured TWD prices.

ACCEPT, each line is a test in `stripeCatalog.test.ts` (new, 34), including: every MVP plan at its default amount; second resolve makes no call; two concurrent resolves create one price; a pin skips the sync; a changed amount gives a new key and leaves the old price untouched; a GoApply plan makes zero calls; a Stripe failure is a 502, is not remembered, and `getPlanCatalog` still answers.

### 4. [P0] Checkout through the catalog: idempotency keys, locale, Adaptive Pricing off, custom text (ST-2 server half): done

- `rails/types.ts` `CheckoutOrder`: `attemptKey`, `locale`.
- `rails/stripe.ts`: refuses, before a customer or price exists, an order whose brand does not list `stripe` (checked first), a plan that is not sellable or has no amount, and an unverified student order. Then `resolveStripePriceId`. `customers.create` under `customer:<seekerProfileId>`. The session gains `adaptive_pricing: { enabled: false }`, `locale` (en, zh, zh-TW, ja, ko, es, fr, de, pt → pt-BR, else `auto`), `customer_update`, `subscription_data.description` (brand name + plan label) and `custom_text.submit.message`, built in English from the plan and the amount charged (at most 1,200 characters). Idempotency key `checkout:<userId>:<planKey>:<currency>:<attempt>`; `<attempt>` is `order.attemptKey` when it matches `/^[A-Za-z0-9_-]{8,64}$/`, else `b<floor(now / 60 s)>` (`now` added to `StripeRailDeps`). A Stripe idempotency error answers `payment_provider_error` with `details.reason: 'idempotency_conflict'`. A failed `customers.create` is now a 502 as well (it was an unhandled 500).
- `RoboApplyBillingService.ts` `CheckoutInput` and `routes/billing.ts`: `attemptKey` from the `Idempotency-Key` header (trimmed, same pattern, else undefined), `locale` from `X-Robo-Locale`.
- Untouched: acknowledgement before Stripe opens, pass refused while a plan renews, subscription refused while a plan is live, student gate, payment mode with an invoice, metadata.

ACCEPT, all tested: monthly with no price variable opens on the price under `ra_pro_monthly_usd_2499_incl`; the same header twice gives the same Stripe key, another header another key; without it two calls in one minute share a key and one a minute later does not; a Taiwan buyer on a configured TWD amount is charged `..._twd_..._incl`; a GoApply order handed to the rail is refused with `plan_not_sellable` and the fake records zero calls of any kind; the two A11 tests the parity wave wrote pass unedited; `git diff` shows no hunk inside the Alipay callback route or `handleAlipayCallback`.

Tests: `rails/stripe.checkout.test.ts` (new, 24), `rails/rails.test.ts` (ENV line and the `StripeRail` block only), `integration/RoboApplyBillingService.stripe.test.ts` (10 new route-level cases; two older cases that pinned "unpriced" were rewritten).

### 5. [P1] Plan switch and webhook plan lookup without price pins (ST-1 consequence): done

- `subscriptions.ts`: `assertSwitchable` no longer needs a price id; `switchPrice` became async `switchPriceFor(stripe, stripeSub, target)` → `{ priceId, amountMinor, currency }` (TWD subscription → the target's TWD price or `switch_not_available`); `quoteSwitch` and `confirmSwitch` await it; export renamed in `index.ts`.
- `RoboApplyBillingService.ts` `resolvePlanFromStripe`: metadata first (unchanged order), then `planKeyForPrice(price object)`. The charged currency and amount come from the price fields first, then from the lookup key (either currency), then from a pinned TWD id.

ACCEPT, all tested: a monthly subscriber is quoted and switched to quarterly on the synced price (one list and one create for quote + confirm together); a TWD subscriber switches only to a plan with a TWD amount; `subscription.updated` with empty metadata and a synced price records plan key, interval and amount, and the paid invoice grants that plan's allowance; every earlier switch and webhook test passes with pins.

Tests: `subscriptions.test.ts` (4 new), `integration/RoboApplyBillingService.stripe.test.ts` (5 new).

### 6. [P1] Seams for the later phases: event registry, shared claim, error codes: done, no behaviour change

New `server/src/platform/billing/stripeEvents.ts`: `claimBillingEvent`, `billingEventClaimKey`, `invoiceSubscriptionId`, `StripeEventResult`, `findBillingOwnerByCustomer`, `registerStripeEventHandler`, `stripeEventHandler`, `unregisterStripeEventHandlerForTests`, types `StripeEventContext`, `StripeEventDb`, `StripeEventHandler`, `BillingOwner`. The service's `claimOnce` delegates; it re-exports `invoiceSubscriptionId` and `StripeEventResult`; the default branch of `handleRoboApplyStripeEvent` asks the registry inside the existing try / catch. `errors.ts`: `nothing_to_resume`, `refund_not_available`, `withdrawal_not_available` (409). `index.ts` exports `stripeEnv`, `stripeCatalog`, `stripeEvents` and the checkout helpers of `rails/stripe.ts`.

Three shapes the later bundles should know:
- `claimBillingEvent(db, userId, key, refType, now?)`: `now` is optional (default `new Date()`), because the items of MKT-2D and MKT-4B call it with four arguments.
- `ctx.now` is a function, `() => Date`, the service clock.
- `findBillingOwnerByCustomer` accepts the id or the expanded customer object and returns `subscription.brand`, so the "a `goapply` row is never Stripe's" rule of MKT-2B can read it.

**Rule for the billing bundles of M2 and M4:** only one bundle per phase owns `platform/billing/index.ts` (M2: MKT-2D; M4: nobody). Every other bundle imports its new module by file path.

ACCEPT, all tested: a registered type is dispatched with the service's Stripe client, database and clock and its result returned; an unregistered type answers `{ handled: false }` (HTTP 200); a throwing handler answers 500; a type the service handles itself never reaches the registry; a claim is true once and false afterwards.

Tests: `stripeEvents.test.ts` (new, 12), `integration/RoboApplyBillingService.stripe.test.ts` (5 new, one over HTTP through the webhook router).

### Carry-over (wavePAR-carryover, "Market waves", payments 8 to 12)

- **9, published student rule: server half done** (the entry lives in `features/credits/service.ts` and `contract.ts`, mine in M1; MKT-1B asked for it in its handoff and built the page). `GET /billing/plans` carries `studentOffer: Array<{ key: 'student_monthly' | 'student_quarterly', amountMinor, studentDiscountPercent }> | null`: the brand's student prices while the `student` capability is on, for a caller who is NOT sent the student plans themselves; null otherwise. So a GoApply visitor or unverified user gets ¥29 / 25% and ¥69 / 30%; a verified GoApply student and every RoboApply caller get null (the plans are in the list). Tested in `credits.test.ts`.
- **8** left: AL-3 / AL-4 are MKT-2A (`alipayWorker.ts`, `origins.ts`); the Stripe webhook brand rule is MKT-2B item 1.
- **10** left: a web return page, MKT-2E.
- **11, 12** left: `RABillingRefund` retention and the consent archive index are MKT-4A.

### Where the item and the plan documents differ

- The strategy and the task plan write `resolveStripePriceId(planKey, currency)`; the item writes `(stripe, plan, currency)`. Built as the item says: the function needs the client and the resolved plan, and both callers hold them. Same behaviour, lookup key and products as the documents.
- The task plan lists two additive fields on `GET /billing/plans`. There are three now (`studentOffer`, carry-over 9).
- The three new fields are **optional members of `PlansResponse`** and required in the new `PlansResponseSent`, which is what `plans()` returns. The server always sends them. Required members would have broken `npm run typecheck:web` in files I do not own (`components/features/credits/__tests__/*`, `components/features/billing-cn/__tests__/billingCn.test.tsx`), and the task plan asks consumers to read a contract field with a safe default.
- The task plan (§3.1 and §5, row M1 / MKT-1A) says `stripeRailReady` = usable key and at least one webhook secret, and that M1 accepts a comma-separated list. Built stricter: the secret must also be one the webhook route can verify with, so a list keeps the rail closed until the route tries each secret (strategy M-25 wins; Review resolution 3). The item and the task plan say a live key is `sk_live_` / `rk_live_`; built as "not a test key" (Review resolution 2). `stripeEnv.ts` exports three names the contract row does not list: `STRIPE_WEBHOOK_TRIES_EVERY_SECRET`, `stripeWebhookCanVerify`, `stripeRailBlocker`.

## Files changed

35 files, all inside MKT-1A's owns (the same 35 as before the review; the review work touched 13 of them). Paths under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1A/`.

New (9):
- `server/src/platform/billing/stripeEnv.ts`, `stripeEnv.test.ts`
- `server/src/platform/billing/stripeClient.test.ts`, `stripeSingleClient.test.ts`
- `server/src/platform/billing/stripeCatalog.ts`, `stripeCatalog.test.ts`
- `server/src/platform/billing/stripeEvents.ts`, `stripeEvents.test.ts`
- `server/src/platform/billing/rails/stripe.checkout.test.ts`

Modified code (14):
- `server/src/platform/billing/stripeClient.ts`, `planCatalog.ts`, `planViews.ts` (comments), `errors.ts`, `index.ts`, `subscriptions.ts`
- `server/src/platform/billing/rails/stripe.ts`, `rails/types.ts`
- `server/src/platform/flags.ts`
- `server/src/roboapply/services/RoboApplyBillingService.ts`, `server/src/roboapply/routes/billing.ts`
- `server/src/roboapply/v2/services/RAAdminOperationsService.ts`
- `server/src/features/credits/service.ts`, `contract.ts`

Modified tests (12):
- `server/src/platform/billing/planCatalog.test.ts`, `money.test.ts`, `accountV2.test.ts`, `subscriptions.test.ts`
- `server/src/platform/billing/rails/rails.test.ts`, `rails/registry.test.ts`
- `server/src/platform/billing/integration/RoboApplyBillingService.stripe.test.ts`
- `server/src/platform/flags.test.ts`, `server/src/features/brand/routes.test.ts`, `server/src/features/features.test.ts`
- `server/src/features/credits/credits.test.ts`
- `server/src/roboapply/v2/services/RAAdminOperationsService.test.ts`

Touched for the review: `stripeEnv.ts`, `stripeEnv.test.ts`, `stripeClient.ts`, `stripeClient.test.ts`, `planCatalog.ts`, `planCatalog.test.ts`, `index.ts`, `rails/stripe.checkout.test.ts`, `rails/registry.test.ts`, `flags.test.ts`, `features/credits/service.ts`, `contract.ts`, `credits.test.ts`.

Not touched: `fulfilPass.ts`, `rails/alipayWorker.ts`, the Alipay callback route, `handleAlipayCallback`, `routes/stripeWebhook.ts`, `refunds.ts`, any `*.prisma`, `i18n/`, `.env*`.

## Tests run

All in the worktree, after the last change.

| Command | Result |
|---|---|
| The 18 test files MKT-1A owns | 18 files, 863 passed, 1 todo |
| `npx vitest run -t "A[0-9]+ " server/src` (the Alipay contract tests and every other test named `A<n> …`) | 9 files, 55 passed; `git diff` has no added or removed line inside a test named `A<n> …` |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 651 files: 644 passed, 7 failed. 14,496 tests: 14,452 passed, 33 failed, 1 skipped, 10 todo |
| In memory, constant `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` set to true (59 billing, credits, flags, brand and roboapply test files) | 1 failed (the pin that must be flipped), 1,495 passed |
| In memory, the webhook route patch of Requests plus the constant set to true: a scratch test with two secrets, `stripeWebhook.route.test.ts`, the Stripe integration test | 3 files, 62 passed |
| In memory, the replacement for `EntitlementService.test.ts` | 15 passed |

"In memory" means a Vitest config in the session scratchpad that rewrites one file's text as it is loaded; no file outside my owns was written.

Not run, by the rules: `next build`, a dev server, a browser, the extension and interview-agent suites (neither was touched).

## Red tests for other bundles

All 33 follow from one rule the item and strategy §4.3 state: a RoboApply plan always has an amount and is sellable only while the Stripe rail is ready. The review changes added none (same 33 tests before and after).

### MKT-1B: 32 tests in 6 files it owns and rewrote in parallel

`components/features/credits/__tests__/billing.test.tsx` (18), `accountV2.test.tsx` (5), `pure.test.ts` (4), `credits.test.tsx` (1), `integration.test.tsx` (1), `components/features/marketing/__tests__/pages.test.tsx` (3).

Cause: the base version of `fixtures.tsx` builds RoboApply plans with the server's `buildPlanViews` from an env that has price variables and no Stripe key or webhook secret, so every plan is now `payments_disabled`.

Measured before the review without editing those files (a scratch Vitest config that adds the two values in memory): with `STRIPE_SECRET_KEY: 'sk_test_x'` and `STRIPE_WEBHOOK_SECRET: 'whsec_test'` in `RA_ENV`, 28 of the 32 pass. The other 4 pin "a RoboApply plan with no configured price", which no longer exists:
- `pure.test.ts` "visiblePlans hides free, unpriced and V2 student plans": with an empty env the six MVP plans are returned with amounts; assert that.
- `pure.test.ts` "monthlyPlan finds the priced monthly plan": with an empty env it is found (2499), not null.
- `billing.test.tsx` "no priced plans → an honest empty line": with an empty env the sheet lists the plans, closed; assert the closed state.
- `pages.test.tsx` "a plan without a configured price says so": "Price not set yet" is never shown; assert the amount with no buy link while payments are closed.

MKT-1B's handoff says its rewritten fixtures carry the key and the webhook secret and that it reworked the unpriced cases. I did not read or run its test files, so "all 32 green on the merged tree" is expected, not measured. Two things its fixtures must respect after the review: the key must start with `sk_test_` or `rk_test_`, and the webhook secret must be a single value (no comma).

### Orchestrator (no M1 owner): 1 test

`server/src/platform/credits/EntitlementService.test.ts` › "RoboApply with a configured price and a Stripe key is unchanged (upgradable); without a price or without the key it is not". It asserts that price variables alone make a Pro plan sellable and that a key without a webhook secret is enough for "Get Pro".

Replacement, verified green against this worktree after the review changes (applied in memory, file not edited). Add `'STRIPE_WEBHOOK_SECRET'`, `'ROBOAPPLY_STRIPE_WEBHOOK_SECRET'`, `'VERCEL_ENV'`, `'STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION'` to the `PAY_ENV` list (after `'STRIPE_SECRET_KEY'`), and replace the test with:

```ts
it('RoboApply: "Get Pro" needs the Stripe rail ready (a usable key and a webhook secret); no price variable is needed', async () => {
  const READY = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  expect(hasSellableProPlan('roboapply', READY)).toBe(true);
  expect(hasSellableProPlan('roboapply', {})).toBe(false);
  expect(await upgradableOn('roboapply', READY)).toBe(true);
  expect(await upgradableOn('roboapply', { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(false);
  expect(await upgradableOn('roboapply', { STRIPE_WEBHOOK_SECRET: 'whsec_test' })).toBe(false);
  expect(await upgradableOn('roboapply', { ...READY, STRIPE_SECRET_KEY: 'sk_live_example' })).toBe(false);
  expect(await upgradableOn('roboapply', { ALIPAY_CALLBACK_SECRET: 'cb-secret' })).toBe(false);
});
```

## Pre-existing failures

None in files MKT-1A owns.

`server/src/features/jobs/import/directFetch.test.ts` › "a 2 MB page of "<li " is read, and its draft built, in milliseconds" failed in two of three full runs before the review (231 ms against a 200 ms limit) and passed in both full runs after it and when run alone. It is a wall-clock limit, the machine was running several suites at once, and nothing in this bundle touches that code. Not counted in the 33.

## Requests

### Orchestrator

1. **Make the webhook route try every secret, and open the rail for lists, in one change** (Review finding 3; this is MKT-2B item 1's first sentence pulled forward, or leave it to MKT-2B and do part (b) with it). Until both parts land, a list value keeps Stripe payments closed, which is safe; do not do one part without the other.

   (a) `server/src/roboapply/routes/stripeWebhook.ts`: add `import { stripeWebhookSecrets } from '../../platform/billing/stripeEnv.js';`, replace the `secretOf` line with

   ```ts
   // Every configured secret, in the order to try them (rotation: the CLI secret and the Dashboard one).
   const secretsOf = (): string[] => {
     if (!deps.secret) return stripeWebhookSecrets(process.env);
     const one = deps.secret();
     return one ? [one] : [];
   };
   ```

   and replace the block from `const secret = secretOf();` to the end of the signature `catch` with

   ```ts
   const secrets = secretsOf();
   if (secrets.length === 0) {
     logger.error('ROBOAPPLY_STRIPE', 'No STRIPE_WEBHOOK_SECRET configured');
     return res.status(500).json({ error: 'webhook_secret_missing' });
   }
   // The first secret that verifies wins; 400 only when none does.
   let event: Stripe.Event | null = null;
   let lastError: unknown = null;
   for (const secret of secrets) {
     try {
       event = stripe.webhooks.constructEvent(req.body as Buffer, req.headers['stripe-signature'] as string, secret);
       break;
     } catch (err) {
       lastError = err;
     }
   }
   if (!event) {
     logger.warn('ROBOAPPLY_STRIPE', 'Signature verification failed', { error: lastError instanceof Error ? lastError.message : String(lastError), secretsTried: secrets.length });
     return res.status(400).json({ error: 'invalid_signature' });
   }
   const verified: Stripe.Event = event;
   ```

   then use `verified` where the handler block reads `event` (`handle(verified, stripe)` and `type: verified.type`).

   (b) `server/src/platform/billing/stripeEnv.ts`: `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` → `true`; `stripeEnv.test.ts`: the one assertion in `'the route does not try every secret yet …'` → `toBe(true)`. Nothing else changes: every other test follows the constant (measured).

   Behaviour was verified in memory (two secrets: either verifies, a third answers 400, none answers 500; the existing route tests pass). It was not type-checked, because the file is not mine to write; it uses only names already in the file.
2. Replace the one test in `EntitlementService.test.ts` (text under "Red tests").
3. `MARKET_TASK_PLAN.md` §3.1: the row "`GET /billing/plans` additive fields" should name `studentOffer` too and say `version` is the public label; the catalog row can say `resolveStripePriceId(stripe, plan, currency)`; the `stripeEnv.ts` row should say `test` = `sk_test_` / `rk_test_` and every other key is `live`, name the three added exports, and define `stripeRailReady` as "usable key AND a webhook secret the webhook can verify with". §5 row M1 / MKT-1A for the webhook secret should say a list is accepted once the route tries each secret.

### MKT-1B (and the orchestrator at the M1 merge)
- Run the web credit and marketing tests on the merged tree (see "Red tests"). The fixture env must carry a `sk_test_` key and a single webhook secret for RoboApply plans to be `sellable`.
- `studentOffer` is built with the semantics you asked for (null when the caller is sent the student plans; so always null on RoboApply). Field names of `refundPolicy` and `checkout.collectingEntity` are exactly yours; the six numbers are positive integers.
- `refundPolicy.version` is now the public label (`refund-v1-2026-10` on both brands). Writing it as `data-refund-policy-version` is fine. If a test of yours pins the GoApply value with `-pending-counsel`, it should assert the label without it.

### MKT-1G
- The env names and defaults below are as built. Changes to what your `.env.example` text may say: (1) every key that does not start with `sk_test_` or `rk_test_` is treated as a live key; (2) the webhook secret must be ONE value in this phase; a comma-separated list keeps Stripe payments closed until the webhook route tries each secret (Orchestrator request 1 or MKT-2B item 1), so do not document the list form as usable yet; (3) a non-Vercel RoboApply production needs `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true`; (4) an invalid `PRICE_<KEY>_USD_CENTS` is ignored and logged, like the CN override; (5) a pin next to two amount variables that differ is ignored and logged.

### MKT-2B
- If Orchestrator request 1 was not applied at the M1 merge, your item 1 is where the route starts to loop over `stripeWebhookSecrets()`. `stripeEnv.ts` and its test are not in your owns: ask the orchestrator for part (b) in the same merge, or lists stay refused (safe, and one warning line names the cause).
- `planKeyForPrice(price)` is ready for price-first resolution (your item 2): swap the two operands in `resolvePlanFromStripe`. The test "subscription metadata still wins over the price" in the Stripe integration test pins today's order and is the one to flip.
- A cached price id is kept for the life of the process. If you add the endpoint health check, a price archived in the Dashboard is worth a line there (see Known gaps).
- Pins are trusted, not checked (Review finding 1, optional part). `stripeHealth.ts` is the place to retrieve each pinned price once and compare amount, currency and recurrence with the catalog; `getPlanCatalog('roboapply', env)` gives `stripePriceId` and `twdPrice.stripePriceId` for the pins that stand.
- An ignored pin maps to no plan in `planKeyForStripePrice`. A subscriber on a price whose pin is now ignored is still resolved by subscription metadata; keep metadata as the second source when you move the price first.

### MKT-2C
- `switchPriceFor(stripe, stripeSub, target)` is async and returns `currency`; your idempotency key `switch:<subId>:<planKey>:<prorationDate>` and `pending_if_incomplete` go on the `subscriptions.update` call in `confirmSwitch`, unchanged by this bundle.

### MKT-2D, MKT-4B
- `claimBillingEvent(db, userId, key, refType, now?)`, `ctx.now()` is a function, `findBillingOwnerByCustomer` returns `subscription.brand`. Import by file path unless you own `index.ts` in your phase.
- MKT-4B / whoever stores or prints a refund decision: `REFUND_POLICY_VERSION` (full value) is for stored records; anything a buyer can read uses `publicRefundPolicyVersion` from `features/credits/service.ts`.

### MKT-2E or MKT-4C (whoever next owns the web credit fixtures)
- Once every `PlansResponse` literal in the web tests carries `collectingEntity`, `refundPolicy` and `studentOffer`, the three members can become required in `features/credits/contract.ts` and `PlansResponseSent` can go.

### Owner
- A `sk_test_` key and a `stripe listen` secret for the clone `.env` (strategy §7 item 2). Until then RoboApply on the dev stack shows prices and cannot open a payment.
- Before the first production deploy of this code: confirm ONE webhook secret is set next to the key (not a list, until the route change above is in); say whether production runs on Vercel (if not, set the override); if the key is restricted, give it write access to Products and Prices.
- When counsel clears the GoApply refund rules, the stored version loses its `-pending-counsel` suffix in `refunds.ts`; the public label does not change.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION` | new: `true` lets a live key work when `VERCEL_ENV` is not `production`. Needed by a RoboApply production that does not run on Vercel | unset = a live key outside production is refused, Stripe is off, one error line per process |
| `STRIPE_SECRET_KEY` | redefined: must be usable. A key starting with `sk_test_` or `rk_test_` is a test key and works anywhere; EVERY other key is treated as a live key and works only in production or with the override | unset = Stripe off |
| `STRIPE_WEBHOOK_SECRET`, `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` | redefined: now REQUIRED for the Stripe rail (`pay.stripe`, `checkout.rails`, sellable plans). The RoboApply name is read first. In this phase it must be ONE secret: a comma-separated list (or a blank RoboApply variable in front of a real one) keeps the rail closed, with one warning line, until the webhook route tries each secret. `stripeWebhookSecrets` already returns the split list for that change | unset = plans listed with amounts, `payments_disabled`, one warning line when a key is set |
| `VERCEL_ENV` | read (not new): `production` allows a live key | set by Vercel |
| `PRICE_<PLANKEY>_USD_CENTS` (`PRO_WEEKLY`, `PRO_MONTHLY`, `PRO_QUARTERLY`, `PRO_WEEK_PASS`, `PRACTICE_PACK_5`, `PRACTICE_PACK_15`, `STUDENT_MONTHLY`, `STUDENT_QUARTERLY`) | new: overrides a RoboApply catalog amount; positive integer cents; anything else is ignored and logged once | catalog: 999 / 2499 / 5499 / 999 / 999 / 2499 / 1749 / 3799 |
| `STRIPE_PRICE_<PLANKEY>_CENTS` | redefined: an alias of the line above (the new name wins) | unset |
| `STRIPE_PRICE_<PLANKEY>` | redefined: an optional pin of a Stripe price id, honoured only next to the amount it was set with: one valid amount variable, or two that agree. Alone, or next to two amounts that differ, it is ignored and logged once | unset = the price is found or created by the catalog sync |
| `PRICE_<PLANKEY>_TWD_CENTS` | new: Taiwan price in TWD minor units, a multiple of 100; anything else is ignored and logged once | unset = Taiwan pays USD with the reference line |
| `STRIPE_PRICE_<PLANKEY>_TWD_CENTS` | redefined: an alias of the line above | unset |
| `STRIPE_PRICE_<PLANKEY>_TWD` | redefined: an optional pin of the Stripe TWD price id, under the same pin rule; no longer needed for a Taiwan price to exist | unset |

## i18n keys added or changed

None. This bundle owns no namespace. The one new buyer-facing text is `custom_text.submit.message` on Stripe's own payment page, built in code and in English in this wave, as the item says.

## Known gaps

- **Nothing was seen against Stripe.** Every parameter (`adaptive_pricing`, `customer_update`, `custom_text`, `locale`, `tax_behavior`, lookup keys, idempotency keys, per-request `timeout`) type-checks against the installed SDK (stripe 23.0.0) and is asserted on a fake. The test-mode scenario pass is MKT-3H's runbook and needs the owner's test key.
- **A pin is trusted, not checked against Stripe.** The code now refuses the one case it can see from the environment (two amounts that differ). A pin set next to a single wrong amount still shows that amount and charges the pinned price, as the old pair always did. No deployment sets a pin today; the check belongs in MKT-2B's health check (Requests).
- **The key test recognises two prefixes.** If Stripe introduces another test-key prefix, such a key is refused outside production until `TEST_KEY_PREFIXES` in `stripeEnv.ts` learns it (or the override is set). That is the intended direction of the error.
- **Webhook-secret lists wait for the route change.** Until Orchestrator request 1 (or MKT-2B item 1 plus the constant) lands, rotation with two live secrets is not possible: set one secret, switch it, redeploy.
- **The model of "what the route can verify" is two checks** (no comma, not blank), matching what `routes/stripeWebhook.ts` reads today. It does not catch a single wrong secret; nothing in the environment can.
- **A resolved price id is remembered for the life of the process.** If someone archives a synced price in the Dashboard, an instance that already resolved it keeps sending the archived id and checkout for that plan fails with 502 until the instance restarts. A cold instance lists active prices only, finds none and tries to create one; I did not verify whether Stripe lets a new price take the lookup key of an archived one, so that path may fail too. Do not archive `ra_…_incl` prices by hand; change the catalog amount instead (a new amount is a new lookup key).
- **The 60-second fallback bucket uses the rail's own clock.** A request with no `Idempotency-Key` that repeats within the same minute with different acknowledgement boxes gets `idempotency_conflict` (502). The web sends a fresh key per attempt (MKT-1B), so this only meets older clients.
- **`customer:<seekerProfileId>` holds only as long as Stripe keeps an idempotency key** (about a day by my reading of its documentation; not verified here). A customer created but not stored (database failure) is reused within that window and created again after it.
- **The Stripe payment page text is English for every locale**; the page chrome follows `X-Robo-Locale`. The localized, recorded acknowledgement is on our own plan sheet.
- **`studentOffer` adds one capability read for a GoApply visitor** on each `GET /billing/plans` (RoboApply already made it).
- **The webhook still resolves metadata before price** and still writes `brand: 'roboapply'` on subscription and invoice events without reading the row (PAR-6 finding 10). Both are ST-3, MKT-2B.
- **`flags.ts` comments** above `pay.stripe` were not updated (the bundle may change one line and one import there); the rule is documented in `stripeEnv.ts`.
- **Both brands now publish the same refund policy label.** The page can no longer tell the two rule sets apart by `version`; today the numbers are identical, so nothing is lost. If the rule sets ever diverge, give them different names in `refunds.ts` before the suffix.
