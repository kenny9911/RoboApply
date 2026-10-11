# Payments audit: Alipay (mainland China) and Stripe (international)

**Date:** 2026-10-11. **Branch audited:** `feat/jobright-clone` @ `aee60e6`. **Production baseline:** `main` @ `7cdfecd` (contains `783d5e2 fix(billing): send Alipay callbacks to RoboApply`).
**Method:** code reading only, plus the existing billing test suites (16 files, 281 tests, all pass on this branch) and four Stripe documentation pages. No payment order was created, no key was printed, no code was changed.
**Confidence tags:** `[confirmed]` = read in code or in the cited doc; `[likely]` = strong inference from code; `[inferred]` = needs a live check.

Binding inputs: README D5 (brand parity, GoApply never ships dark), D6 (prices per market with real catalog defaults; Alipay "must keep working exactly as it does", new GoApply plans "mapped onto it additively; the request, callback and verification path is not rewritten"; Stripe implemented fully).

---

## 0. Verdict in one page

1. **The clone branch did rewrite the Alipay path**, against D6. The worker request, the callback verification and the fulfilment moved out of `RoboApplyBillingService.ts` into `platform/billing/rails/alipayWorker.ts` + `platform/billing/fulfilPass.ts`, and five behaviours changed on the way (§A4). The rewrite is well tested and mostly sound, but it is **not** "exactly as it does".
2. **A mainland visitor on roboapply.io can no longer pay with Alipay on this branch.** Production picks the rail from the visitor's country (`CN` → RMB + Alipay). The clone picks it from the brand only: RoboApply's rails are `['stripe']`, so `POST /billing/alipay` on roboapply.io answers 409 `rail_not_allowed`, and the old `{ tier: 'starter' | 'growth' }` body answers 409 `plan_not_sellable`. `[confirmed]`
3. **GoApply cannot take an Alipay payment today either, with the configuration production runs on.** Six gates must all be open, and production needs none of them (§A4, R1–R6): `CN_PAYMENTS_ENABLED=true`, a `CN_PRICE_<KEY>_FEN` per plan, `ALIPAY_API_URL` set explicitly, `ALIPAY_CALLBACK_SECRET` set, `CN_PAYMENT_COLLECTING_ENTITY` set, and (in the UI) WeChat Pay not configured. In the clone `.env` the first five are all empty. `[confirmed]`
4. **The callback now fails closed.** With `ALIPAY_CALLBACK_SECRET` unset, production accepts every callback; the clone answers 503 to every callback, including for orders created by production before the deploy. Whether production has the secret set decides whether this is a silent improvement or an outage for in-flight orders. `[confirmed in code; production env not inspected]`
5. **Stripe is about 70 % built** and of good quality: Checkout (subscription + one-time), webhook with raw body and signature check, replay-safe grants, cancel at period end, plan switch with proration quote, payment-failed dunning mail, portal session, invoice history. **But nothing is purchasable**: a plan is sellable only when both `STRIPE_PRICE_<KEY>` and `STRIPE_PRICE_<KEY>_CENTS` are set, and none are (the clone `.env` has `STRIPE_SECRET_KEY` set, `STRIPE_WEBHOOK_SECRET` empty, zero price variables). `[confirmed]`
6. **Missing on Stripe** (grep-confirmed absent from `server/src`): catalog-driven prices, refunds (`refunds.create`, `charge.refunded`), disputes, resume after cancel, `customer.subscription.created`, `invoice.payment_action_required` (SCA on renewals), `checkout.session.async_payment_failed` / `expired`, Stripe Tax, Stripe idempotency keys on any API call, a portal configuration created by code, and an out-of-order guard on subscription events.
7. **One latent Stripe bug found:** the webhook resolves the plan from `subscription.metadata.planKey` before the price (`RoboApplyBillingService.ts:752-759`). A plan change made in the customer portal changes the price but not our metadata, so the row keeps the old plan key, interval and practice allowance. The plan sheet tells Pro subscribers to change plans in the portal (`PlanPicker.tsx`, `planSheet.manageInPortal`). `[confirmed by reading; not reproduced]`
8. **Recommendation for prices on Stripe:** sync real Products and Prices from the catalog by `lookup_key` (create on first use, idempotent), not Checkout `price_data`. Subscription updates and proration previews require a Product id for inline prices (`node_modules/stripe/esm/resources/Subscriptions.d.ts:1363`, `product: string`), the existing code is price-id-centric everywhere, and the amount shown and the amount charged then come from one number.

---

# Part A — Alipay, mainland China

## A1. What production does today (main @ 7cdfecd)

A visitor in mainland China on **roboapply.io** (there is no GoApply in production):

| Step | What happens | Where (on `main`) |
|---|---|---|
| 1. Market | `resolveBillingRegion()` decides `cn` from, in order: explicit `?region=cn`, the edge country header (`cf-ipcountry`, `x-vercel-ip-country`, `x-country`, `x-geo-country`) `== CN`, `SeekerProfile.market == 'cn'`, locale `zh` / `zh-cn`. Taiwan and Hong Kong are `other`. | `server/src/lib/billingRegion.ts` |
| 2. Prices | Two paid plans, monthly: **Starter ¥19** (10 practice credits), **Growth ¥45** (28 credits). Defaults in code, overridable by env (`RA_MOCK_PLAN_*_CNY_MINOR`) and by `AppConfig['mock_plans.<env>']`. USD twins are $15 / $29. | `server/src/lib/mockInterviewPlans.ts`, mirrored in `lib/pricing.ts` |
| 3. Order | `POST /api/v1/roboapply/billing/alipay { tier, next? }` (auth). Creates the order at the GoHire payment worker, stores an `AlipayOrder` row (`tier = 'ra_<tier>'`, `amount` = whole yuan, `status = 'pending'`), answers `{ url }`. | `routes/billing.ts`, `createAlipayOrder()` |
| 4. Pay | The browser goes to `pay_url` (the Alipay cashier). **Redirect only; there is no QR code and no polling in production.** | `hooks/useAccount.ts` `useAlipayCheckout`, `components/v3/account/billing.tsx` |
| 5. Notify | The worker calls `GET` or `POST /api/v1/roboapply/billing/alipay/callback` with `pay_status` and `out_trade_no` (query or body). Public route. | `routes/billing.ts` `alipayCallback` |
| 6. Verify | Only if `ALIPAY_CALLBACK_SECRET` is set: the worker must echo it (`?cb=`, body `cb`, or header `x-alipay-callback-secret`), constant-time compare, else 403 / 40003. **Unset → no check at all.** There is no Alipay RSA signature check in RoboApply; the worker owns that. | `alipayCallbackSecretOk()` |
| 7. Fulfil | `TRADE_SUCCESS` and order not completed → one transaction: order → `completed`; `SeekerSubscription` upsert (`tier`, `status: active`, `market: cn`, `currency: CNY`, `amountMinor`, `currentPeriodEnd = now + 30 days`). Then `grantForPlan()` (credits reset to the plan allotment) and `syncMissionTier()`. A duplicate notify finds the order completed and does nothing. `TRADE_CLOSED` on a pending order → `closed`. | `handleRoboApplyAlipayCallback()` |
| 8. Return | The cashier sends the buyer to `return_url` = `<app>/account?billing=success` (or `next`). The page refetches the plan. | same |
| 9. Renewal | None automatic: a 30-day pass. A reminder mail goes out 5 days before the end; the user buys again. | `RoboApplyBillingReminderService.ts` |
| 10. Receipt | `GET /billing/history` lists completed `ra_*` orders; `GET /billing/invoices/:id/download` streams a PDF receipt rendered by the app. | `lib/invoiceReceipt.ts` |

### A2. The wire contract with the GoHire worker (frozen by D6)

Request: `POST ${ALIPAY_API_URL || 'https://worker.gohire.top/payment/payment/create'}`, JSON:

| Field | Production value | Clone value | Same? |
|---|---|---|---|
| `out_trade_no` | `RAORDER_<yyyymmddhhmmss>_<user8>_<8 base36>` | `RAORDER_…` on RoboApply, **`GAORDER_…` on GoApply**, suffix 10 hex | prefix and suffix differ |
| `total_amount` | whole yuan, number (`Math.round(cnyMinor/100)`) | whole yuan, number; a non-whole price is refused (`price_not_whole_yuan`) instead of rounded | same on the wire |
| `subject` | `RoboApply Starter 月度订阅` / `… Growth 月度订阅` | `<brand name> <plan label>`, e.g. `GoApply 会员月卡` | text differs (expected) |
| `body` | not sent | **new field**: subject, plus ` · <collecting entity>` | new |
| `pay_channel` | `'alipay'` | `'alipay'` | same |
| `user_name`, `user_email`, `user_id` | name or email, email, id | same | same |
| `platform` | `ROBOAPPLY_ALIPAY_PLATFORM \|\| 'gohire'` | GoApply: `CN_ALIPAY_PLATFORM \|\| 'gohire'`; RoboApply unchanged | same default |
| `package_data` | `{ package_id: tier, package_name: tier, package_type: '1', package_price: '<yuan>' }` with tier `starter` / `growth` | same shape, **`package_id` / `package_name` = the plan key** (`pro_monthly`, `practice_pack_5`, …) | new values |
| `notify_url` | `${BACKEND_URL \|\| 'https://www.roboapply.io'}/api/v1/roboapply/billing/alipay/callback[?cb=<secret>]` | RoboApply: same. GoApply: `${CN_BACKEND_URL \|\| 'https://www.goapply.top'}/…` | host differs for GoApply |
| `return_url` | `<app>/account?billing=success` | `<brand app>/settings/billing/return?plan=…&billing=success` | path differs (web only) |

Response: `{ code: 0, data: { pay_url } }`; anything else is an error. A non-JSON body is logged with status and the first 300 characters. Same in both.

Callback read by production: `pay_status`, `out_trade_no`, optional `cb`. The clone additionally reads `total_amount` and `trade_no`.

## A3. Where the implementation lives on the clone branch

**Server**

| File | Role |
|---|---|
| `server/src/roboapply/routes/billing.ts` | Routes: `POST /checkout`, `POST /alipay` (checkout with rail forced to `alipay`), `GET+POST /alipay/callback` (public), `/plan`, `/credits`, `/portal`, `/cancel`, `/switch`, `/history`, `/invoices/:id/download`. Mounted at `/api/v1/roboapply/billing` (`app.ts:150`). |
| `server/src/roboapply/services/RoboApplyBillingService.ts` | `createCheckout()` (plan checks, acknowledgements, rail call), `handleAlipayCallback()` (maps verification to HTTP + worker codes 0 / 40001–40005 / 50003), `getBillingHistory()`, `resolveInvoiceDownload()`, `getAlipayOrderForReceipt()`, `alipayCallbackSecretOk()`. |
| `server/src/platform/billing/rails/alipayWorker.ts` | **The worker call and the callback verification.** `createAlipayWorkerRail()`, `newOutTradeNo()`, `collectingEntity()`, `ALIPAY_DEFAULT_WORKER_URL`, `ALIPAY_CALLBACK_PATH`. |
| `server/src/platform/billing/fulfilPass.ts` | **Fulfilment** for every CN rail: amount check, conditional claim `pending → completed`, pass activation / extension, credit grant, replay healing; `closePendingOrder()`. Legacy `ra_starter` / `ra_growth` orders: 30 days, as production. |
| `server/src/platform/billing/rails/registry.ts`, `types.ts`, `index.ts` | `registerRail`, `resolveRail(brand, requested)`, `railAvailable`, `availableRails`; `ensureDefaultRails()` registers Stripe and Alipay on import. |
| `server/src/platform/billing/planCatalog.ts` | `GOAPPLY_PLANS`: `pro_week_pass` 会员周卡 (7 days), `pro_monthly` 会员月卡 (30 days), `pro_quarterly` 会员季卡 (90 days), `practice_pack_5` / `_15` 面试练习包. All `kind: 'pass'` or `'pack'`, none auto-renews. Price from `CN_PRICE_<KEY>_FEN`, sellable only with `CN_PAYMENTS_ENABLED`. |
| `server/src/platform/billing/packs.ts` | `grantPracticePack()` (idempotent per `order:<AlipayOrder.id>`). |
| `server/src/platform/billing/origins.ts` | `appOrigin(brand)`, `callbackOrigin(brand)`, `safeReturnPath()`. |
| `server/src/platform/flags.ts` | `pay.alipay` = brand has the rail **and** `CN_PAYMENTS_ENABLED` **and** `ALIPAY_API_URL` **and** `ALIPAY_CALLBACK_SECRET` (line 331). |
| `server/src/lib/billingRegion.ts` | Reduced to `billingRegionForBrand()` (brand decides) and `countryHeaderFromRequest()`. `resolveBillingRegion()` is gone. |
| `server/src/lib/mockCreditService.ts` | `grantForPlan`, `grantForPlanIfNewPeriod`, `getBalance` (lazy monthly re-grant for `per: 'month'` plans). |
| `server/src/roboapply/lib/invoiceReceipt.ts` | PDF receipt; names brand, payment method and the collecting entity when configured. |
| `server/src/roboapply/services/RoboApplyBillingReminderService.ts` | GoApply 30/90-day passes: reminder 3 days before the end; old RoboApply Alipay passes: 5 days. |
| `server/src/features/billing-cn/**`, `platform/billing/rails/wechatpay.ts` | WeChat Pay v3 (own routes, own notify at `/api/v1/webhooks/wechatpay`, own agreement gate). Fulfils through the same `fulfilPass()`. Does not touch the Alipay rail. |
| `server/src/features/credits/**` | `GET /billing/plans` (`checkout.rails`, `paymentsOpen`), `/credits/cancel`, public cancel. |

**Data** (`server/prisma/schema/legacy.prisma`)

- `AlipayOrder` (line 777): production columns `id, userId, outTradeNo @unique, tier, amount (Float yuan), status, completedAt, createdAt`; clone adds, all nullable or defaulted: `channel` (`alipay` default), `brand`, `planKey`, `purpose`, `amountMinor`, `relatedId`, `wx*`, `tradeType`, `termsVersion`. Additive: old rows read as Alipay / RoboApply.
- `SeekerSubscription` (line 4729): clone adds `brand, planKey, interval, rail, billingCountry` (nullable).
- `RACreditLedger` (idempotency claims), `RACreditGrant` (packs), `SeekerConsentRecord` (acknowledgements).

**Web**

| File | Role |
|---|---|
| `components/features/credits/PlanPicker.tsx` | The plan sheet. `rail = brand.market === 'cn' ? 'alipay' : 'stripe'`; if WeChat Pay is available every GoApply purchase opens the WeChat sheet instead. |
| `hooks/credits/useBillingActions.ts` | `usePlanCheckout()` → `/billing/alipay` or `/billing/checkout`; `checkoutRedirectUrl()` accepts only `kind: 'redirect'` with an http(s) URL. |
| `lib/api/account.ts` | `alipayCheckoutPlan()`, `invoiceDownloadUrl()`; the old `alipayCheckout(tier)` is still exported. |
| `components/features/credits/CheckoutReturn.tsx`, `app/(auth)/settings/billing/return/page.tsx` | Return page: re-reads the credit summary every 3 s, up to 10 times, until the plan is Pro (or the practice balance rose for a pack). |
| `components/v3/account/billingHistory.tsx`, `app/(auth)/settings/billing/history/page.tsx` | Receipts list and download. |
| `lib/pricing.ts`, `lib/serverMarket.ts` | `resolveMarket()` and the `starter` / `growth` table survive but only `resolveVisitorCountry()` is still used by billing pages. |

**Environment**

`ALIPAY_API_URL`, `ALIPAY_CALLBACK_SECRET`, `BACKEND_URL`, `ROBOAPPLY_ALIPAY_PLATFORM`, `NEXT_PUBLIC_ROBOAPPLY_URL` / `ROBOAPPLY_URL` (production); added by the clone: `CN_PAYMENTS_ENABLED`, `CN_PRICE_<PLANKEY>_FEN`, `CN_PAYMENT_COLLECTING_ENTITY`, `CN_ALIPAY_PLATFORM`, `CN_BACKEND_URL`, `CN_CANONICAL_ORIGIN`.

**Tests** (all pass)

`server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts` (15 cases: GoApply order creation, gates, WeChat agreement gate, callback → fulfilPass), `platform/billing/rails/rails.test.ts` (AlipayWorkerRail: 6 cases), `rails/registry.test.ts` (brand lock), `platform/billing/fulfilPass.test.ts` (17 cases: idempotency, concurrency, amount mismatch, extension, packs, legacy `ra_starter`), `integration/RoboApplyBillingReminderService.test.ts`, `roboapply/lib/invoiceReceipt.test.ts`, `components/features/credits/__tests__/*`, `components/features/billing-cn/__tests__/billingCn.test.tsx`.

## A4. What the clone changed, and the regression risk of each change

| # | Change | Production | Clone | Risk |
|---|---|---|---|---|
| R1 | **Who may pay with Alipay** | Any signed-in user whose market resolves to `cn`, on roboapply.io | Only brand GoApply (host `goapply.top`). RoboApply: 409 `rail_not_allowed`. | **Breaks the production cohort** (mainland visitors and existing ¥ subscribers on roboapply.io). They now see USD and a card form. Existing ¥ passes are honoured to expiry; they cannot be bought again. |
| R2 | **What is sold** | Starter ¥19 / Growth ¥45, 30 days | 会员周卡 / 月卡 / 季卡 + 练习包; `tier` body → 409 `plan_not_sellable` | Intended by the plan. Old ¥ subscribers' renewal reminder links to plans they cannot buy in RMB. |
| R3 | **Master switch** | none | `CN_PAYMENTS_ENABLED=true` required twice (catalog `payments_disabled`, flag `pay.alipay`) | Off by default → nothing purchasable. D5 overrides the R-15 gate; code still has it. |
| R4 | **Prices** | defaults in code | `CN_PRICE_<KEY>_FEN` with no default → `price_unset`, plan hidden | D6: "a plan is never price not set". Not met. |
| R5 | **Worker URL** | default URL when `ALIPAY_API_URL` is unset | The rail still has the default (`alipayWorker.ts:30,127`), but `pay.alipay` requires the variable to be set (`flags.ts:331`) | With production's env (variable unset, as in the clone `.env`) the rail reports unavailable. Pure regression, no benefit. |
| R6 | **Callback secret** | optional; unset → accept | required; unset → every callback 503 (`alipayWorker.ts:170-173`), and `pay.alipay` is off | Security improvement (production lets anyone who knows an order number post `TRADE_SUCCESS`; the buyer sees that number). **But** if production runs without the secret, in-flight orders and all legacy callbacks fail after the deploy. |
| R7 | **Collecting entity** | not a concept | `isConfigured` is false for GoApply until `CN_PAYMENT_COLLECTING_ENTITY` is set (`alipayWorker.ts:85`) | Another hard gate with no default. Legal reason is real (no 二清), but under D5 it must not keep the rail dark. Owner decision. |
| R8 | **Amount check** | none | `total_amount` from the callback is compared with the order (`fulfilPass.ts`, `amount_mismatch` → HTTP 400, code 40004) | `[inferred]` The format the worker sends was never read by production. The parser accepts `^\d+(\.\d{1,2})?$` as yuan. If the worker sends fen (`3900`), every paid order is refused and stays pending. Must be checked against a real callback log before go-live. |
| R9 | **`package_id` values** | `starter` / `growth` (also GoHire recruiter tier names) | plan keys | `[inferred]` If the worker validates `package_id`, order creation fails with `payment_provider_error`. Unknown without one order-creation call. |
| R10 | **Order number prefix** | `RAORDER_` | `GAORDER_` for GoApply | `[inferred]` Nothing in this repo depends on `GAORDER`; whether the worker or GoHire's reconciliation keys on the prefix is unknown. Zero benefit, non-zero risk. |
| R11 | **`body` field** | absent | always sent | `[inferred]` Probably ignored; untested. |
| R12 | **Notify host** | `www.roboapply.io` (fixed in `783d5e2` after a 404 outage) | GoApply orders: `www.goapply.top` unless `CN_BACKEND_URL` | `[inferred]` The callback route is brand-agnostic (it finds the order by number). Pointing GoApply's notify at a new, unproven host re-opens the exact failure `783d5e2` fixed. |
| R13 | **Rail choice in the UI** | Alipay | If WeChat Pay is configured, `viaWechat` wins for every plan; Alipay is unreachable from the plan sheet (`PlanPicker.tsx:189`) | The owner's rail for mainland is Alipay. There is no chooser. |
| R14 | **Error codes** | `alipay_failed`, `alipay_unreachable`, `no_price` | `payment_provider_error`, `rail_not_configured`, `plan_not_sellable` | Web deploys with the API, so no live client reads the old codes. Low. |
| R15 | **Legacy fulfilment** | inline | `fulfilPass` legacy branch (`isLegacyPlanKey`) | Equivalent: 30 days, tier from the order, `grantForPlan`, `syncMissionTier`. Covered by "honours old RoboApply Alipay monthly passes". Low. |

Things the rewrite got right and that should stay: the conditional claim (`updateMany … status != completed`) is stronger than production's read-then-write; a crash between claim and grant heals on the next notify; "buy again" extends from the end of the live pass; packs are idempotent per order; `TRADE_CLOSED` handling is unchanged; receipts are brand-aware.

## A5. The DO NOT BREAK contract

These must hold after any further change. Each has, or needs, a test.

1. **Route and methods.** `GET` and `POST /api/v1/roboapply/billing/alipay/callback` stay public (no auth middleware, no CSRF, not behind a capability flag), read parameters from query **and** JSON body, and stay mounted after `express.json` (they are not raw-body routes).
2. **Callback answers.** HTTP 200 `{ code: 0, message }` for success, closed, no-action **and replays**; 400 with 40001 (missing params) / 40002 (unknown order); 403 / 40003 for a wrong secret; 500 / 50001 on an exception. Never answer non-200 to a replay of a paid order (the worker would retry forever).
3. **Order identity.** `AlipayOrder.outTradeNo` is unique and is the only key the callback uses. `tier` keeps the `ra_` prefix: recruiter (GoHire-side) orders share the table and must never match (`fulfilPass` returns `not_found` for a tier without `ra_`).
4. **Idempotency.** One order activates once and grants once, under replay and under two concurrent notifies.
5. **Worker request.** Same endpoint default, `pay_channel: 'alipay'`, `platform: 'gohire'` unless overridden, whole-yuan numeric `total_amount`, `package_data` with the four string fields, `notify_url` on a host that serves the callback route, `?cb=` URL-encoded when a secret is set.
6. **Secret semantics.** A callback whose `cb` does not match a configured secret is refused before any database write. Comparison is constant-time.
7. **Legacy orders.** A pending `ra_starter` / `ra_growth` order created before the deploy still fulfils: 30 days, plan credits, CNY, `market: 'cn'`.
8. **Never widen `AlipayOrder` destructively.** Columns `tier`, `amount`, `status`, `completedAt` keep their meaning; new facts go in nullable columns (already the case).
9. **CN rails sell one-time products only.** No auto-debit, no stored agreement. `fulfilPass` refuses a subscription-kind plan (`unknown_plan`).
10. **Receipts.** Every completed `ra_*` order remains listed in `/billing/history` and downloadable by its owner only.
11. **Stripe never serves GoApply; the Stripe webhook never activates anything for a `goapply` session** (`RoboApplyBillingService.ts:991-995`). Symmetric guard for the new Stripe work.
12. **WeChat Pay work must not change the Alipay rail** (`rails/index.ts` registration, `fulfilPass` signature `{ outTradeNo, channel, paidAmountMinor, transactionId }`).

## A6. Selling GoApply's plans through the same Alipay path: minimal, additive changes

Goal: a GoApply visitor can buy 会员周卡 / 月卡 / 季卡 and a 练习包 with the configuration production already runs on, and the bytes sent to the worker differ from production only where the product differs (subject, amount, package name).

| # | Change | File | Why |
|---|---|---|---|
| G1 | Catalog defaults in CNY: ¥12 week, ¥39 month, ¥99 quarter, ¥29 / ¥79 packs (owner ruling 2026-10-10; all whole yuan). `CN_PRICE_<KEY>_FEN` stays as an override. | `platform/billing/planCatalog.ts` (`priceFor`) | D6. Removes `price_unset` (R4). |
| G2 | `CN_PAYMENTS_ENABLED` becomes a kill switch: on unless explicitly `false`. | `planCatalog.ts`, `flags.ts` `cnPaymentsEnabled` | D5 overrides R-15 (R3). |
| G3 | Drop `ALIPAY_API_URL` from the `pay.alipay` requirement; the rail's default URL already exists. | `flags.ts:331` | R5. |
| G4 | Keep the secret mandatory for new orders, but make the deploy safe: set `ALIPAY_CALLBACK_SECRET` in production **on `main` first**, wait out the cashier's order lifetime, then deploy the clone. If the owner prefers no sequencing, accept a secret-less callback only for orders created before a cut-over timestamp (`ALIPAY_SECRETLESS_UNTIL`), never for new ones. | ops + `alipayWorker.ts` `verifyCallback` | R6 without re-opening the forgery hole. |
| G5 | Collecting entity: do not gate the rail on it; when set, print it on subject, body and receipt; when unset, log one startup warning. A strict mode (`CN_PAYMENT_REQUIRE_ENTITY=true`) restores today's gate. | `alipayWorker.ts` `isConfigured`, `createCheckout` | R7 under D5. Needs the owner's and counsel's yes: with platform `gohire`, GoHire's merchant collects the money. |
| G6 | Send `body` only when an entity is configured; otherwise omit the field as production does. | `alipayWorker.ts` | R11. |
| G7 | Order number: `RAORDER_` for both brands (the brand is in `AlipayOrder.brand`). | `alipayWorker.ts` `newOutTradeNo` | R10. |
| G8 | GoApply notify host defaults to the proven callback origin (`BACKEND_URL \|\| https://www.roboapply.io`) unless `CN_ALIPAY_NOTIFY_ORIGIN` is set. `return_url` stays on the GoApply app origin. | `platform/billing/origins.ts` (new helper), `alipayWorker.ts` | R12. The route finds the order by number, whatever host receives it. |
| G9 | Amount check: keep it, but treat an unparseable or implausible `total_amount` as "not stated" and log it, and when the value is exactly 100 × the expected yuan accept it as fen. Confirm the real format from one production callback log, then tighten. | `alipayWorker.ts` `verifyCallback` | R8. |
| G10 | Rail chooser on the GoApply plan sheet: Alipay first (default), WeChat Pay second when available. Today WeChat silently replaces Alipay. | `components/features/credits/PlanPicker.tsx` | R13; owner directive "mainland pays with Alipay". |
| G11 | Mainland visitor on roboapply.io: decide (see open question 1). Smallest honest option: on the RoboApply plan sheet, when the edge country is `CN`, one line "在中国大陆？可在 GoApply 用支付宝以人民币付款" linking to goapply.top; existing ¥ pass holders get the same link in the renewal reminder. No cross-brand redirect (TW-01 forbids it). | `PlanPicker.tsx`, email template `billing.renewal_reminder` (`bodyManualLegacy`) | R1, R2. |
| G12 | `package_id`: keep the plan key (GoHire's reports then show what was sold), **after** one supervised order-creation call proves the worker accepts it. If it does not: send `package_id: 'starter'` for passes and keep the real key in `package_name`. | `alipayWorker.ts` | R9. |

Nothing in G1–G12 changes `fulfilPass`, the callback route, the claim, or the table.

Tests to add or change: `rails.test.ts` (default prices sellable with an empty env; `body` omitted without an entity; `RAORDER_` for GoApply; notify host default; rail available with `ALIPAY_API_URL` unset), `registry.test.ts` (kill switch semantics), `RoboApplyBillingService.alipay.test.ts` (secret-less legacy order before the cut-over; fen-format `total_amount`), `planCatalog.test.ts` (CNY defaults, override wins, non-whole-yuan override refused), `components/features/credits/__tests__/billing.test.tsx` (rail chooser; the CN line on RoboApply).

## A7. How to verify without risking production

1. Unit: `npx vitest run server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts server/src/platform/billing` (1.3 s).
2. Local callback, no worker involved: create an order row through the test harness or the dev stack with `ALIPAY_API_URL` pointed at a local stub that answers `{ code: 0, data: { pay_url } }`, then `curl 'http://localhost:4621/api/v1/roboapply/billing/alipay/callback?pay_status=TRADE_SUCCESS&out_trade_no=<no>&total_amount=39.00&cb=<secret>'`; repeat it and confirm one activation.
3. Supervised live check (owner present, real money, smallest plan): one 会员周卡 order on a preview deployment, pay ¥12, capture the worker's raw callback (method, query, body), confirm activation, download the receipt, refund in the Alipay merchant console. This one run settles R8, R9, R10, R11 and R12.

---

# Part B — Stripe, international

## B1. What exists

| Area | State | Where |
|---|---|---|
| SDK | `stripe` ^23.0.0, pinned API `2026-09-30.endive`; one client factory, test seam `setStripeClientForTests`. No `maxNetworkRetries`, no `appInfo`. | `platform/billing/stripeClient.ts` |
| Checkout | `checkout.sessions.create`: `mode` subscription or payment; existing or new Customer (stored on `SeekerSubscription.stripeCustomerId`); one line item by **price id**; metadata on session, subscription and payment intent (`product`, `brand`, `planKey`, `userId`, `seekerProfileId`, `autoRenewAck`, `withdrawalWaiver`, `ackVersion`, `currency`); `invoice_creation` on one-time payments; `billing_address_collection: 'auto'`; promotion codes behind `STRIPE_PROMOTION_CODES`. | `platform/billing/rails/stripe.ts` |
| Prices | `STRIPE_PRICE_<PLANKEY>` + `STRIPE_PRICE_<PLANKEY>_CENTS` (display). Optional Taiwan pair `…_TWD` + `…_TWD_CENTS`. Unset → `price_unset`, not sellable. | `platform/billing/planCatalog.ts` |
| Plans | `pro_weekly` (week), `pro_monthly`, `pro_quarterly` (subscriptions); `pro_week_pass` (7 days, one-time); `practice_pack_5` / `_15` (one-time, 12 months); `student_*` (V2, flag). | same |
| Checkout rules | plan known and sellable; auto-renew box required and recorded (`auto_renew_ack`, optional `withdrawal_waiver`) before Stripe opens; pass refused while a plan renews; subscription refused while any plan is live; student gate. | `RoboApplyBillingService.createCheckout` |
| Webhook route | `POST /api/v1/roboapply/stripe/webhook`; `express.raw({ type: 'application/json' })` mounted **before** `express.json` (`app.ts:107`, router at `:141`); `constructEvent` with `ROBOAPPLY_STRIPE_WEBHOOK_SECRET \|\| STRIPE_WEBHOOK_SECRET`; 400 bad signature, 503 no key, 500 no secret or handler failure (Stripe retries), 200 with `duplicate: true` on replays. Works on Vercel because `api/index.ts` hands the raw request to Express. | `roboapply/routes/stripeWebhook.ts` |
| Events handled | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. | `handleRoboApplyStripeEvent` |
| Replay protection | Per effect, not per event: `claimOnce()` writes a zero-amount `RACreditLedger` row (`bucket: 'billing_event'`) under a unique key: `billing:checkout:<session>`, `billing:invoice:<invoice>`, `billing:payfail:<invoice>`. Credit grants are guarded by period start or by a pack key. Pass activation claims and writes in one transaction; a crashed grant heals on replay. | `RoboApplyBillingService.ts:718-736, 836-930` |
| Renewals | Credits only from `invoice.paid` (`subscription_cycle` / `_update` / `_create`), never from `subscription.updated`, never while `past_due`. | `:1026-1050` |
| Payment failed | Row → `past_due` (Pro stays on while Stripe retries), one `billing.payment_failed` mail per invoice. Web banner `PaymentFailedBanner.tsx`. | `handlePaymentFailed` |
| Cancel | `POST /credits/cancel` and legacy `POST /billing/cancel`: `cancel_at_period_end: true`, optional feedback to Stripe, confirmation mail; public cancel by emailed single-use link (`/api/v1/public/cancel`). | `platform/billing/subscriptions.ts`, `features/credits` |
| Switch | `POST /billing/switch`: quote (`invoices.createPreview`, `always_invoice`, `proration_date`) then confirm (same date, 1 h validity, new acknowledgement recorded before the charge). TWD subscriptions switch only to TWD prices. | `subscriptions.ts` |
| Portal | `POST /billing/portal` → `billingPortal.sessions.create({ customer, return_url })`, no `configuration`. `STRIPE_BILLING_PORTAL_URL` is in `.env` but read nowhere. | `createPortalSession` |
| Invoices page | `/settings/billing/history`: `stripe.invoices.list({ customer, limit: 50 })` merged with CN receipts; download = 302 to `invoice_pdf` after an ownership check. | `getBillingHistory`, `resolveInvoiceDownload` |
| Refund policy | `computeRefund()` is a pure calculator (14-day withdrawal, 7-day first purchase, 48 h for weekly / pass, 3-day accidental renewal, unused pack). **No code issues a refund.** | `platform/billing/refunds.ts` |
| Reminders | Daily cron: 5 days before monthly / quarterly renewal, 2 before weekly, annual reminder; hourly winback producer. | `RoboApplyBillingReminderService.ts`, `platform/billing/winback.ts`, `cron/handlers.ts`, `vercel.json` |
| Model | `SeekerSubscription`: `tier, status, market, currency, amountMinor, stripeCustomerId, stripeSubscriptionId @unique, stripePriceId, trialEnd, startedAt, currentPeriodEnd, cancelAtPeriodEnd, canceledAt, mockCredits*, brand, planKey, interval, rail, billingCountry`. | `server/prisma/schema/legacy.prisma:4729` |
| Tests | `integration/RoboApplyBillingService.stripe.test.ts` (37 cases), `integration/stripeWebhook.route.test.ts` (4), `rails/rails.test.ts` (StripeRail: 4), `subscriptions.test.ts` (9), `refunds.test.ts`, `planCatalog.test.ts`, `packs.test.ts`, `accountV2.test.ts`, `money.test.ts`. | |

## B2. Gaps

| # | Gap | Evidence |
|---|---|---|
| S1 | Nothing is purchasable without creating prices in the Dashboard and pasting 12+ env variables. | `planCatalog.ts:200-205`; `.env` has no `STRIPE_PRICE_*` |
| S2 | `STRIPE_WEBHOOK_SECRET` is empty locally → webhook answers 500. | `.env` (name only read) |
| S3 | No refund execution, no `charge.refunded`, no dispute handling; admin report states `refundsIncluded: false`. | grep; `RAAdminOperationsService.ts:122` |
| S4 | Plan resolved from subscription metadata before the price → portal plan changes are recorded as the old plan. | `RoboApplyBillingService.ts:752-759` |
| S5 | Portal plan changes bypass the auto-renew acknowledgement the product requires for new terms (H24). | `PlanPicker.tsx` "manageInPortal" |
| S6 | No resume after "cancel at period end" in the app. | grep: `cancel_at_period_end: false` appears only in `confirmSwitch` |
| S7 | `customer.subscription.created` not handled: if `checkout.session.completed` is lost, `invoice.paid` finds no row (`owned` lookup by `stripeSubscriptionId`) and nothing activates. | `:1030-1031` |
| S8 | Subscription events are applied from the event snapshot; a late older event overwrites newer state. | `:1014-1024` |
| S9 | No `invoice.payment_action_required` (3-D Secure on a renewal or a switch): the user is never told to authenticate. | grep |
| S10 | `confirmSwitch` applies the new plan even if the proration payment fails (default `payment_behavior`). | `subscriptions.ts:382-388` |
| S11 | No Stripe idempotency key on `customers.create`, `checkout.sessions.create`, `subscriptions.update`: a double click makes two customers or two sessions. | `rails/stripe.ts` |
| S12 | Portal session relies on a default configuration saved in the Dashboard; none is created by code. | `createPortalSession` |
| S13 | No tax handling (`automatic_tax`, tax id collection). | grep |
| S14 | `checkout.session.async_payment_failed` and `checkout.session.expired` ignored (only matters if delayed methods are enabled). | grep |
| S15 | Portal-initiated cancellation sends no confirmation mail (only `cancelPlan()` sends it). | `cancelPlan` |
| S16 | Invoice list shows drafts and voids, caps at 50, does not show refunds. | `getBillingHistory` |
| S17 | Adaptive Pricing is not switched off; on one-time payments Stripe may present a local currency, while the pass row stores `session.currency` / `amount_total`. | `rails/stripe.ts`; `Checkout/Sessions.d.ts:2141` |

## B3. Prices: synced Products and Prices by `lookup_key` (recommended) versus Checkout `price_data`

| | `price_data` inline | Catalog sync by `lookup_key` |
|---|---|---|
| Works with only the secret key | yes | yes (first use creates the objects) |
| Fits existing code | No: `rails/stripe.ts`, `switchPrice`, `quoteSwitch`, `confirmSwitch`, `planKeyForStripePrice`, `SeekerSubscription.stripePriceId` and the Taiwan price all carry a price id | Yes: a price id still flows everywhere |
| Plan switch and proration preview | Needs a Product id anyway: `subscriptions.update` and `invoices.createPreview` accept `price_data` only with `product: string` (`Subscriptions.d.ts:1363, 1538`) | Works as today |
| Customer portal | Cannot list ad-hoc prices | Can |
| Dashboard hygiene, reporting, Stripe Tax product codes | One throw-away price per session | Three products, a handful of prices |
| Shown amount = charged amount | Yes | Yes: the price is created from the catalog amount |
| Price change | Immediate for new buyers | New lookup key → new Price; old subscribers keep the old one (grandfathered) |

**Decision: catalog sync.** Design:

- **Amounts live in the catalog** with defaults (owner ruling 2026-10-10): `pro_weekly` 999, `pro_monthly` 2499, `pro_quarterly` 5999, `pro_week_pass` 699, `practice_pack_5` 999, `practice_pack_15` 2499 (USD cents). Override per plan with `PRICE_<PLANKEY>_USD_CENTS`; the existing `STRIPE_PRICE_<PLANKEY>_CENTS` is read as an alias. Optional `PRICE_<PLANKEY>_TWD_CENTS` (two-decimal minor units; Stripe charges TWD with two decimals, payouts must be whole dollars — <https://docs.stripe.com/currencies> `[confirmed]`). The market pricing document may change the numbers; the mechanism does not care.
- **RoboApply sellable** = the plan has an amount (always, by default) and `STRIPE_SECRET_KEY` is set. `STRIPE_PRICE_<PLANKEY>` remains an optional pin: when set it is used as is and no sync happens for that plan (keeps every existing test valid).
- **New module `platform/billing/stripeCatalog.ts`:**
  - Products with fixed ids: `ra_pro` (weekly, monthly, quarterly prices), `ra_pro_student`, `ra_pro_week_pass`, `ra_practice_pack`. `products.create({ id, name, metadata: { product: 'roboapply' } })`; `resource_already_exists` is success.
  - Lookup key `ra_<planKey>_<currency>_<amountMinor>`, e.g. `ra_pro_monthly_usd_2499`.
  - `resolveStripePriceId(planKey, currency)`: memory cache → `prices.list({ lookup_keys, active: true })` (at most 10 keys per call, `Prices.d.ts:683`) → `prices.create({ product, currency, unit_amount, lookup_key, recurring: { interval: 'week' | 'month', interval_count: 1 | 3 }, metadata: { product: 'roboapply', planKey } }, { idempotencyKey: 'catalog:<lookup_key>' })`. One in-flight promise per key; cache for the process lifetime.
  - `planKeyForPrice(price)`: `price.metadata.planKey` → parse `price.lookup_key` → env pins → legacy `priceIdToMockPlanKey`. Webhook payloads carry the price object, so this works on a cold instance.
  - `syncStripeCatalog()` for an optional warm-up (startup log line, admin button); never required.
- `getPlanCatalog()` stays synchronous (it never calls Stripe). The price id is resolved inside the rail at checkout, and inside `quoteSwitch` / `confirmSwitch`.
- The restricted key, if one is used, needs write access to Products and Prices.

## B4. The complete implementation, topic by topic

**Subscriptions (weekly / monthly / quarterly).** Keep Checkout `mode: 'subscription'`. Add to the session: `adaptive_pricing: { enabled: false }`, `locale` from the app locale, `customer_update: { address: 'auto', name: 'auto' }` (required with tax, harmless without), `subscription_data.description`, and an idempotency key (below). Quarterly = `interval: 'month', interval_count: 3`.

**One-time 7-day pass and practice packs.** Keep `mode: 'payment'` with `invoice_creation` (gives every purchase an invoice for the history page) and metadata on the payment intent. `fulfilStripePayment()` already activates the pass (extending a live period) and grants packs idempotently. Add `checkout.session.async_payment_failed` → no-op with a log line, so a delayed method never looks like a hang.

**Plan switch and proration.** Keep quote → confirm. Change `confirmSwitch` to `payment_behavior: 'pending_if_incomplete'` so the plan changes only if the proration is paid; `metadata` and `cancel_at_period_end` are allowed with pending updates (<https://docs.stripe.com/billing/subscriptions/pending-updates-reference> `[confirmed]`). If the returned subscription has `pending_update`, answer `{ requiresAction: true, hostedInvoiceUrl }` and let the user finish on Stripe's hosted invoice page; handle `customer.subscription.pending_update_applied` / `_expired`. Offer every Pro ↔ Pro switch in the plan sheet through the existing `SwitchQuoteSheet` (the server already allows it), so the acknowledgement for the new terms is always recorded. **Resolve the plan from the price first, metadata second** (fixes S4).

**Cancel at period end.** Exists. Add: when a `customer.subscription.updated` shows `cancel_at_period_end` turning true and the change did not come from our own call (`metadata.cancelSource` absent or stale), send `billing.cancel_confirmed` once, claimed by `cancel:<subId>:<periodEnd>` (fixes S15).

**Resume.** New `POST /api/v1/roboapply/credits/resume`: allowed when the plan is live and `cancelAtPeriodEnd` is true; records `auto_renew_ack` for the unchanged terms; `subscriptions.update(id, { cancel_at_period_end: false })`; updates the row; invalidates entitlements. After the period ended there is nothing to resume: the plan sheet sells a new subscription. Web: a "Keep my plan" button where the cancelled state is shown (`BillingView.tsx`, `CancelSubscription.tsx`).

**Payment failed and dunning.** Exists (past_due keeps Pro; one mail per failed invoice). Add: `invoice.payment_action_required` → mail with `hosted_invoice_url` (claim `payaction:<invoice>`); the banner's button opens a portal session with `flow_data: { type: 'payment_method_update' }`; when the status returns to `active` the banner clears through the normal sync; when retries are exhausted Stripe sends `customer.subscription.deleted` (or status `unpaid`, which the code already treats as not live) and the row goes Free. The retry schedule is a Dashboard setting (Billing → Revenue recovery); the code is correct for either end state.

**Refunds.** New `platform/billing/stripeRefunds.ts`:
- `issueRefund({ userId, invoiceId | checkoutSessionId, amountMinor?, reason, actor })`: checks ownership through `stripeCustomerId`; finds the payment intent (one-time: `checkout.sessions.retrieve`; invoice: `invoicePayments.list({ invoice })`, since current invoices carry payments separately — `InvoicePayments.d.ts`); `refunds.create({ payment_intent, amount?, reason: 'requested_by_customer', metadata }, { idempotencyKey: 'refund:<pi>:<amount|full>' })`.
- Callers: an admin action (`features/credits/adminRoutes.ts`, audit-logged) and, optionally, a self-service "withdraw" button when `computeRefund()` says a full refund is due.
- **Entitlements change only in the webhook** (`charge.refunded`), so Dashboard refunds behave the same. Claim `refund:<chargeId>:<amount_refunded>`. Find the owner by `charge.customer`. Full refund of: a pack → zero what is left of that pack's `RACreditGrant` and lower the balance by the same amount; the running pass → end access now; a subscription invoice → `subscriptions.cancel(subId)` now, and reset the period's practice credits to the Free allotment. Partial refund → record only. Send `billing.refund_issued` (new template).
- `charge.dispute.created`: treat as a full refund, flag the account for staff.

**Customer portal.** Create the configuration in code (`billingPortal.configurations.create`, found again through `configurations.list` + `metadata.catalogHash`, id cached), pass `configuration` to every session: invoice history on, payment method update on, customer update (email, address, tax id) on, cancellation at period end with reasons on, **subscription update off** (plan changes stay in the app, S5). This removes the Dashboard step (S12). Listen to `customer.subscription.updated` / `.deleted` as Stripe's portal guide says (<https://docs.stripe.com/customer-management/integrate-customer-portal> `[confirmed]`). Whether a session without any saved default configuration is refused in a fresh sandbox is `[likely]`, not verified.

**Tax.** Off by default. `STRIPE_TAX_ENABLED=true` adds `automatic_tax: { enabled: true }`, `tax_id_collection: { enabled: true }` and `billing_address_collection: 'required'` to Checkout, and `automatic_tax` to switches. It needs Stripe Tax activated and registrations added in the Dashboard (owner). Prices are created without `tax_behavior` so the account's default (inclusive or exclusive by currency) governs. The Taiwan revenue monitor (`platform/billing/twRevenue.ts`) keeps working either way.

**Currency.** USD for every RoboApply buyer. TWD later through the same catalog (`PRICE_<KEY>_TWD_CENTS` → lookup key `…_twd_…`); `usesTwdPrice()`, `switchPrice()` and the webhook's TWD handling already exist and are tested. Adaptive Pricing off (S17).

**SCA.** First payment: Stripe Checkout runs 3-D Secure. Renewals and switches: `invoice.payment_action_required` and `pending_if_incomplete`, as above.

**Idempotency keys (Stripe API).** `customers.create`: `customer:<seekerProfileId>`. `checkout.sessions.create`: `checkout:<userId>:<planKey>:<currency>:<client key>` where the client key is the `Idempotency-Key` header the web already sends on other writes, falling back to a 10-minute time bucket. `subscriptions.update` (switch): `switch:<subId>:<planKey>:<prorationDate>`. Cancel / resume: `cancel:<subId>:<periodEnd>` / `resume:<subId>:<periodEnd>`. Refund: above. Catalog: above. *As built (M2, MKT-2C; owner confirmation pending):* cancel and resume send `cancel|resume:<subId>:<periodEnd>:v<row updatedAt ms>:b<minute>`; the reason is in `MARKET_STRATEGY.md` 5.1, row "Idempotency keys". *As built (M2 gate):* a refund key takes an optional last part, `refund:<pi>:<amount|full>:<attempt>` (one refund decision; a withdrawal sends `withdrawal`), and a pass paid over a subscription ends it with `passover:<subId>:<sessionId>`.

**Webhook.** Events to subscribe (one endpoint, `https://www.roboapply.io/api/v1/roboapply/stripe/webhook`):

| Event | Action | Claim / guard |
|---|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | subscription: sync row + grant; payment: pass or pack | `billing:checkout:<session>` (exists) |
| `checkout.session.async_payment_failed`, `checkout.session.expired` | log only | none |
| `customer.subscription.created` | attach `stripeSubscriptionId` to the row found by `metadata.seekerProfileId` (only when `metadata.product == 'roboapply'` and `brand != 'goapply'`); state only, no credits | unique `stripeSubscriptionId` |
| `customer.subscription.updated`, `.deleted`, `.pending_update_applied`, `.pending_update_expired` | **re-read the subscription from Stripe**, then sync state (fixes S8); cancel mail when it turned cancelled outside the app | `cancel:<sub>:<periodEnd>` |
| `invoice.paid` | period credits (cycle / create), switch credits (update) | period guard; `billing:invoice:<invoice>` (exists) |
| `invoice.payment_failed` | `past_due` + mail | `billing:payfail:<invoice>` (exists) |
| `invoice.payment_action_required` | mail with the hosted invoice link | `billing:payaction:<invoice>` |
| `charge.refunded` | reverse entitlements, mail | `billing:refund:<charge>:<amount_refunded>` |
| `charge.dispute.created` | reverse + flag | `billing:dispute:<dispute>` |

Keep per-effect claims (they also cover Stripe sending the same fact as two events); no event table is needed. Accept a comma-separated list in `STRIPE_WEBHOOK_SECRET` so the CLI secret and the Dashboard endpoint secret can both be live during rotation. Keep answering 500 on failure: every step is replay-safe.

**Entitlements and credits.** Unchanged: `SeekerSubscription` is the record; `EntitlementService` reads `planKey` / `tier` / `status` / `currentPeriodEnd`; practice credits through `grantForPlanIfNewPeriod` and `grantPracticePack`; `entitlementService.invalidate(userId)` after every change.

**Receipts and invoices page.** Keep `/settings/billing/history`. Filter Stripe invoices to `paid`, `open`, `uncollectible`; page beyond 50; show a refunded marker (from the claim rows); label CN orders by `channel`.

## B5. Files to change and tests to write

**New**

| File | Content |
|---|---|
| `server/src/platform/billing/stripeCatalog.ts` + `.test.ts` | lookup-key sync, price resolution, reverse map |
| `server/src/platform/billing/stripeRefunds.ts` + `.test.ts` | `issueRefund`, `applyRefundToEntitlements` |
| `server/src/platform/billing/stripePortal.ts` + `.test.ts` | configuration create / find / cache |
| `server/src/platform/billing/integration/stripeWebhook.events.test.ts` | the new events end to end on the fake Prisma |

**Changed**

| File | Change |
|---|---|
| `server/src/platform/billing/planCatalog.ts` | default amounts both brands; `PRICE_<KEY>_<CUR>_CENTS`; RoboApply sellable without a price id; `planKeyForStripePrice` delegates to the catalog module |
| `server/src/platform/billing/rails/stripe.ts` | resolve the price id through the catalog; idempotency keys; `adaptive_pricing`, `locale`, tax options, `customer_update` |
| `server/src/platform/billing/subscriptions.ts` | `resumeSubscription`; `pending_if_incomplete`; async price resolution in `switchPrice` callers |
| `server/src/platform/billing/stripeClient.ts` | `maxNetworkRetries: 2`, `appInfo` |
| `server/src/platform/billing/index.ts` | exports |
| `server/src/platform/billing/errors.ts` | `payment_action_required`, `refund_not_available`, `nothing_to_resume` |
| `server/src/platform/flags.ts` | `pay.alipay` requirement (Part A, G2–G3); nothing for Stripe |
| `server/src/roboapply/services/RoboApplyBillingService.ts` | new event cases; price-first plan resolution; re-read on subscription events; portal session with configuration and `flow_data`; history filter |
| `server/src/roboapply/routes/stripeWebhook.ts` | several secrets |
| `server/src/roboapply/routes/billing.ts` | `POST /portal` body `{ flow?: 'payment_method_update' }` |
| `server/src/features/credits/routes.ts`, `service.ts`, `contract.ts` | `POST /credits/resume`; `requiresAction` on the switch response |
| `server/src/features/credits/adminRoutes.ts` | admin refund action |
| `server/src/platform/email/templates/billing/index.ts` | `billing.refund_issued`, `billing.payment_action_required` |
| `server/src/roboapply/v2/services/RAAdminOperationsService.ts` | include refunds in the payments report |
| `components/features/credits/PlanPicker.tsx`, `SwitchQuoteSheet.tsx`, `BillingView.tsx`, `CancelSubscription.tsx`, `PaymentFailedBanner.tsx` | in-app Pro ↔ Pro switch; resume button; "authenticate payment" link; portal for payment method only |
| `hooks/credits/useBillingActions.ts`, `lib/api/account.ts`, `lib/api/credits.ts`, `lib/api/contracts/credits.ts` | `useResumeSubscription`, switch `requiresAction`, portal flow |
| `components/v3/account/billingHistory.tsx` | refunded marker |
| `i18n/staging/*.en.json` → all locales | new strings (use the `i18n-locale-sync` skill; run `npm run check`) |
| `.env.example` | document `PRICE_*`, `STRIPE_TAX_ENABLED`, multi-secret webhook, `STRIPE_TEST_CLOCK_ID` (test keys only) |

No schema change is required.

**Tests to write** (names describe the behaviour to prove)

1. Catalog: with only a secret key and an empty env, every MVP plan is sellable at the default amount; a second resolve makes no Stripe call; two concurrent resolves create one price; a changed amount creates a new lookup key and leaves the old price alone; an env price pin skips the sync; a Stripe failure makes checkout answer 502 and leaves the plan list readable.
2. Checkout: session uses the synced price id; the same request twice sends the same idempotency key; a GoApply request never reaches Stripe.
3. Webhook: `subscription.created` then `invoice.paid` activates and grants once when `checkout.session.completed` never arrives; all three in any order grant once; a stale `subscription.updated` after a newer one does not roll state back; a portal price change records the new plan key, interval and allowance; `payment_action_required` mails once; `charge.refunded` full refund of a pack / pass / subscription reverses the right thing once, replay is a no-op, a partial refund changes no access; a `goapply` object is ignored for every new event.
4. Switch: declined proration leaves the plan unchanged and reports `requiresAction`; `pending_update_applied` records the new plan.
5. Resume: turns renewal back on, records the acknowledgement, refuses after the period ended, refuses a pass.
6. Portal: the configuration is created once and reused; `flow: 'payment_method_update'` is passed through.
7. Route: two webhook secrets, either verifies.
8. Web: the plan sheet shows default prices with no env; the resume button appears only for a cancelled live subscription; the switch sheet shows the authenticate link.

## B6. Local test recipe

The owner runs the two steps that authenticate or touch the Stripe account; everything else is local.

1. Put a **test** secret key (`sk_test_…`) in the clone worktree `.env` as `STRIPE_SECRET_KEY` (already set; confirm it is a test key).
2. `stripe login`, then:
   `stripe listen --forward-to localhost:4621/api/v1/roboapply/stripe/webhook`
   Copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` and restart the API (`./scripts/dev-clone.sh`; API 4621, web 3621).
3. Open `http://localhost:3621/settings/billing`. With the catalog sync in place the plans show $9.99 / $24.99 / $59.99, pass $6.99, packs $9.99 / $24.99 with no further setup.
4. Cards (<https://docs.stripe.com/testing> `[confirmed]`): success `4242 4242 4242 4242`; 3-D Secure every time `4000 0027 6000 3184`; 3-D Secure until set up `4000 0025 0000 3155`; insufficient funds `4000 0000 0000 9995`; generic decline `4000 0000 0000 0002`; attaches, then fails on the next charge `4000 0000 0000 0341` (use it to produce a failed renewal).
5. Scenarios: buy monthly → return page turns Pro within one poll; cancel → mail, `cancelAtPeriodEnd`; resume; switch to quarterly → quote equals the charge; buy the 7-day pass after cancelling; buy a pack → practice balance rises; replay any event with `stripe events resend <evt_id>` → response carries `duplicate: true`, nothing changes twice.
6. Renewals and dunning: create a test clock, attach the test customer to it (`STRIPE_TEST_CLOCK_ID`, honoured only with a test key), advance it past the period end; with card `…0341` the row goes `past_due`, the mail is sent once, the banner shows.
7. Refund: `stripe refunds create --payment-intent <pi_…>` → `charge.refunded` reverses the entitlement once.
8. Signature path only: `stripe trigger invoice.payment_failed` (fixture objects are not ours: expect `handled: false`, HTTP 200).

---

## C. Open questions for the owner

1. **Mainland visitors on roboapply.io.** Production serves them Alipay in RMB; the clone serves them Stripe in USD. Send them to GoApply with a link (recommended), or keep an Alipay path on RoboApply for accounts that already hold a ¥ pass?
2. **Is `ALIPAY_CALLBACK_SECRET` set in production today, and does the GoHire worker echo `cb`?** This decides the deploy order (A6 G4).
3. **Collecting entity.** What is the legal name of the Alipay merchant behind worker platform `gohire`, and may GoApply sell through it? Until answered the code either stays dark (today) or sells without naming the entity (G5).
4. **Worker contract.** What does the callback send as `total_amount` (yuan with decimals, or fen), and does the worker validate `package_id` or the order-number prefix? One supervised ¥12 order answers all three.
5. **Does `www.goapply.top` already serve `/api/v1/*`?** If not, GoApply's notify must go to `www.roboapply.io` (G8).
6. **Stripe account:** test key present; a live key, the webhook endpoint and its secret, and (optional) Stripe Tax registrations are owner steps.
7. **Portal plan changes:** confirm they stay in the app so the renewal acknowledgement is always captured.
