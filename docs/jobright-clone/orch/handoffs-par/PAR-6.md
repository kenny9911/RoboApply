# PAR-6

Payments for the D5 parity wave, after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-6`, branch `wp/PAR-6`, base `3fa104e` (PAR-1 merged). Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser, no call to a real provider (every HTTP client in the tests is a stub).

All six items are done and all nine review points are resolved (list at the end). Every test in a file PAR-6 owns is green (35 files, 766 tests). Both typechecks and `npm run check` pass for the whole repository. The full suite has 95 failures in 43 files, all in other bundles' files and all named in PAR-1's red list; PAR-6 turned none red.

Read first:
- **GoApply cannot take a payment until `ALIPAY_CALLBACK_SECRET` is in its environment** (plan §8 item 1). Without it the plans list with their CNY prices, `paymentsOpen` is false, the plan sheet shows one "not open yet" note and no credit wall offers "Get Pro". That is the designed state, not a defect.
- **Two rules now apply to RoboApply as well, because each is one rule for both brands. Both need the owner to know:**
  1. `GET /billing/plans` lists the student plans only for a signed-in, verified student. A visitor and an unverified user no longer receive them, so RoboApply's public `/pricing` page stops showing the two student plans to them. The plan sheet already behaved this way on both brands. This follows the item's ACCEPT line and plan §7 step 6. To go back, replace the call in `features/credits/service.ts` `plans()` with the capability alone (one line).
  2. `upgradable` (the "Get Pro" link on every credit wall) is true only when Pro can be paid for now: a Pro plan is on sale and a rail can charge. A RoboApply deployment with prices but no `STRIPE_SECRET_KEY` (a developer machine) no longer shows "Get Pro". With the key set nothing changes.
- **One new file is outside the literal `owns` list:** `server/src/roboapply/routes/billing.test.ts`. It is the route test the first item and MARKET_STRATEGY AL-1 ask for, colocated with the owned `routes/billing.ts`. The ownership check of `wave_commit.py` has to allow it.
- **One test setup is conditional until PAR-3 merges** (item 4). It is green before and after that merge.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-par/PAR-6.md` (same text as this message).

## Items

### 1. [P0] Freeze the Alipay contract with characterisation tests: done

Tests only. Each is named `A<n> …`, so `npx vitest run -t "A[0-9]+ "` selects exactly the contract: 43 tests in five files.

**Before and after, measured.** The five final test files were copied onto an extract of the untouched base `3fa104e` (in the scratchpad) and run there: **43 passed**. The same command on the PAR-6 tree: **43 passed**. The review found two that failed on the base (A11 and A12 in `RoboApplyBillingService.alipay.test.ts`); they relied on the file's "callback secret alone" environment. Their `describe` now sets every former gate explicitly (`CN_PAYMENTS_ENABLED=true`, the 月卡 price, a collecting entity), as `routes/billing.test.ts` already did, so no contract test moves when a gate default moves.

| Rule | Where | What is pinned |
|---|---|---|
| A1 | `roboapply/routes/billing.test.ts` | GET and POST answer with no session, no CSRF token and no brand host; parameters from the JSON body and from query + body mixed; still answers on either host with `CN_PAYMENTS_ENABLED=false`; `app.ts` mounts the router after `express.json` with no raw parser in front |
| A2 | same | 200 `{code:0}` for success, closed, no-action and three replays; 400/40001; 400/40002 (unknown order, tier without `ra_`); 400/40004 (order stays pending); 400/40005; 403/40003; 503/50003 (no secret, and rail not registered); 500/50001 |
| A3 | same + `fulfilPass.test.ts` | tier `ra_<planKey>` under a unique `outTradeNo`; other parameters never pick the order or the buyer; a recruiter row is `not_found` |
| A4 | same + `fulfilPass.test.ts` | one activation and one grant under four replays, under two concurrent notifies (HTTP) and five (unit); a pack is granted under one key per order |
| A5 | `rails/rails.test.ts` | default endpoint, `ALIPAY_API_URL` override, the exact key set of the body, `pay_channel`, `platform` and its override, numeric whole-yuan `total_amount`, the four `package_data` strings, `notify_url` with the URL-encoded `cb`, non-whole-yuan refused |
| A6 | `rails/rails.test.ts` + route test | wrong, missing and near-miss `cb` refused as `bad_secret` with no database access (every table method spied at the route); `cb` accepted from query, body or header; the comparison goes through `crypto.timingSafeEqual` |
| A7 | `fulfilPass.test.ts` | pending `ra_starter` and `ra_growth`: 30 days, the plan's own credits, CNY, `market: 'cn'` |
| A8 | route test + `fulfilPass.test.ts` | fulfilment changes only `status` and `completedAt`; `tier` and `amount` (yuan) keep their meaning; a closed order never gets a completion time |
| A9 | `fulfilPass.test.ts` | no GoApply plan renews or is a subscription; every subscription key is refused (`unknown_plan`) |
| A10 | route test | `/history` lists the caller's completed `ra_` orders only; the receipt is `not_found` for anyone else, for recruiter orders and without a session |
| A11 | route test, `rails.test.ts`, `RoboApplyBillingService.alipay.test.ts`, `integration/RoboApplyBillingService.stripe.test.ts` (existing test renamed `A11 …`) | GoApply checkout asking for Stripe is refused; the Stripe rail has nothing to charge for a GoApply plan; the webhook ignores a GoApply-branded session |
| A12 | `RoboApplyBillingService.alipay.test.ts`, `fulfilPass.test.ts` | registering WeChat Pay leaves the Alipay rail object, the registry order and the default rail alone; the `fulfilPass(orderRef, deps?)` shape both rails call |

The request, callback and verification code is unchanged (`verifyCallback` and the payload are not in the diff). The one addition in front of the rail is the per-user order limit described under "Review resolution" 7.

**Findings for the market wave (AL-3, AL-4).** Current behaviour matches every rule A1–A12. It differs from the §5.3 targets as follows; nothing was changed:
1. Order numbers are `GAORDER_…` for GoApply (G7 wants `RAORDER_` for both brands).
2. `body` is always sent (equal to the subject when no entity is set); production sends none (G6).
3. The amount is read as yuan only. `total_amount=3900` (fen) is read as ¥3,900 and answers 40004 (G9).
4. A replay of an already paid order that states a different amount answers 400/40004, because the amount check runs before the claim. A true replay (same amount, or none) answers 200.
5. A callback without `cb` is always refused (403 with a secret set, 503 without); there is no `ALIPAY_SECRETLESS_UNTIL` window (G4).
6. The secret is checked before the parameters, so a callback with a wrong `cb` and missing parameters answers 403, not 400.
7. The notify origin is `CN_BACKEND_URL`, else GoApply's canonical origin; there is no `CN_ALIPAY_NOTIFY_ORIGIN` and the host is not logged at startup (G8).
8. `package_id` is always the plan key (G10).
9. `/billing/history` lists the latest 50 completed orders, not every one (A10 says "every").
10. The Stripe webhook checks `metadata.brand` on `checkout.session.*` only; subscription and invoice events find their row by `stripeSubscriptionId` and write `brand: 'roboapply'` without reading the row's brand. Not reachable today (GoApply never creates a Stripe object); belongs to ST-3.

### 2. [P0] GoApply plans carry real CNY amounts and are on sale by default: done

`server/src/platform/billing/planCatalog.ts`:
- `GOAPPLY_DEFAULT_PRICE_FEN` (exported): 1200, 3900, 9900, 2900, 7900, 2900, 6900.
- `priceFor` for GoApply: `CN_PRICE_<KEY>_FEN` when it is a positive multiple of 100, else the default. Any other value (3990, 39, 0, a negative, a decimal, text) is ignored and logged once per variable and value (`RA_BILLING`, variable name and the first 20 characters of the value), not on every catalog read. Unsellable `payments_disabled` only under `cnPaymentsKilled(env)` (PAR-1's export; Request P6-1). A GoApply plan is never `price_unset`.
- `priceEnvNames('goapply', key)` returns the price variable only.
- Header comment rewritten (R-15 superseded by D5 and D6). RoboApply pricing code is untouched.

`planViews.ts` and `features/credits/contract.ts`: comments. `features/credits/service.ts`: `paymentsOpen = rails.length > 0 && plans.some(sellable)` already gave the contract of plan §5; the only change in that file is the student listing rule of item 5.

ACCEPT, all tested: empty env → every paid plan sellable at its default; `4900` overrides one plan; `3990` ignored and logged; `CN_PAYMENTS_ENABLED=false|0|off|no` marks all unsellable with prices still listed; `GET /billing/plans` on GoApply answers `paymentsOpen: true` with `pay.alipay` on, with `pay.wechatpay` alone on, and `false` with no rail or under the kill switch.

Tests: `planCatalog.test.ts` (rewritten), `money.test.ts`, `features/credits/credits.test.ts`, `__tests__/lib/pricing.test.ts`. On the last one: the item says to rewrite its payments-disabled-by-default and price-unset cases, but the file had none; four GoApply cases were added instead (prices to show with an empty env, computed labels, `payments_disabled` only under the kill switch, no quarterly suggestion for a pass).

PAR-10's request P6-A is confirmed: the seven keys are `CN_PRICE_PRO_WEEK_PASS_FEN`, `CN_PRICE_PRO_MONTHLY_FEN`, `CN_PRICE_PRO_QUARTERLY_FEN`, `CN_PRICE_PRACTICE_PACK_5_FEN`, `CN_PRICE_PRACTICE_PACK_15_FEN`, `CN_PRICE_STUDENT_MONTHLY_FEN`, `CN_PRICE_STUDENT_QUARTERLY_FEN`, with defaults ¥12, ¥39, ¥99, ¥29, ¥79, ¥29, ¥69.

### 3. [P0] The existing Alipay rail opens with the callback secret alone: done

`rails/alipayWorker.ts`:
- `isConfigured` is true for both brands, except under the opt-in hard gate with no entity.
- The collecting entity is printed when `CN_PAYMENT_COLLECTING_ENTITY` is set and is otherwise absent. `CN_PAYMENT_REQUIRE_ENTITY=true` restores `rail_not_configured`, before the worker is called.
- The request payload, the notify URL, `verifyCallback` and fulfilment are untouched (the A5 and A6 tests pass unchanged).
- **The missing-entity warning** (`alipayEntityNotice(env)`, `warnIfAlipayEntityUnset()`, both exported) is logged once per process, **the first time the running deployment asks whether GoApply can charge** (the first plans read or checkout), and only when GoApply is served, the rail can charge, no entity is set and the hard gate is off. It is no longer logged at module import: `server/src/app.ts` imports the billing router statically and calls `dotenv.config` in its body, so at import the secret is not in the environment and the notice was skipped on every host that loads `.env` that way (review finding 4). It is raised only for the process environment, never for an environment a caller passes in.

`rails/registry.ts`: no behaviour change was needed. `resolveRail` already walks `brand.paymentRails` in order (`alipay`, then `wechatpay`). Comments rewritten and the behaviour pinned by tests: Alipay takes a purchase that names no rail whether or not WeChat Pay is ready; WeChat Pay takes it only when Alipay cannot charge; a rail the buyer named is refused when it cannot charge, never swapped.

**Precedence note.** The item says "isConfigured returns true for both brands" and also that `CN_PAYMENT_REQUIRE_ENTITY=true` restores the refusal. Under the hard gate with no entity `isConfigured` is false, so the rail is not listed in `checkout.rails` and the sheet says "not open yet" instead of offering a button that fails. This follows plan §3.8.

ACCEPT, all tested end to end through the legacy routes (`RoboApplyBillingService.alipay.test.ts`, whose base env is the secret alone): a 月卡 checkout creates one `AlipayOrder` at ¥39 on the default worker URL with `cb` on the notify URL; a callback with the secret fulfils it exactly once (30 days; two replays change nothing); callbacks without or with a wrong secret answer 403 and leave it pending; without the secret both checkout routes answer 503 `rail_not_configured`, no order exists and `GET /billing/plan` still lists the five prices.

Tests: `rails.test.ts`, `registry.test.ts`, `fulfilPass.test.ts`, `RoboApplyBillingService.alipay.test.ts`.

### 4. [P1] WeChat Pay stays the additional rail; billing tests drop the master switch: done

- `features/billing-cn/routes.ts`: two gates. **New orders** (`POST /`) need `pay.wechatpay`; under the kill switch a deployment where WeChat Pay is set up answers **503 `payments_disabled`**, and one where it is not set up answers 404 `feature_disabled` as before. **The notify and the order status** stay open whenever `wechatPayReadiness(brand).ready`, kill switch or not (Request P6-2, decided: keep them open, as rule A1 keeps the Alipay callback open). `payments_disabled` is emitted in exactly that one place.
- `contract.ts`, `service.ts`, `rails/wechatpay.ts`: merchant and entity checks kept; comments corrected (no master switch).
- `__tests__/helpers.ts`: `GA_ENV` no longer sets `CN_PAYMENTS_ENABLED` or any `CN_PRICE_*`.
- Reminder mail: `RoboApplyBillingReminderService.ts` reads no payment or mail switch (comment added; no code change).

**The reminder test and PAR-3.** The item says to remove `CN_EMAIL_*` from the "on" setup. On this base `EmailService` (PAR-3's file) still gives GoApply no transport without `CN_EMAIL_TRANSPORT`, so removing it outright would make my own test red until PAR-3 merges. The setup therefore asks the email service: `transportNameFor(goapply, { RESEND_API_KEY })`. Where that already answers `resend` (after PAR-3, which its handoff confirms) no `CN_EMAIL_*` value is set; on the old rule the same transport is named explicitly. One further case injects the mailer and proves the reminder service hands a GoApply pass reminder over with an empty CN environment. `CN_PAYMENTS_ENABLED` was never in that file; a kill-switch case was added (a pass already bought is still reminded, once).

ACCEPT, all tested: with WeChat Pay credentials absent GoApply sells through Alipay; with them present and the entity matching, `checkout.rails` is `['alipay', 'wechatpay']`; a mismatched entity leaves Alipay alone on offer; with `CN_PAYMENTS_ENABLED=false` a new order is refused (no order row, no consent record, no WeChat call) and the notify for an order created earlier fulfils it once (two retries change nothing); the status read also completes a paid order whose notify was lost; a tampered notify is still refused.

Tests: `billingCn.routes.test.ts`, `wechatpayRail.test.ts`, `integration/RoboApplyBillingReminderService.test.ts`.

### 5. [P1] Student passes on GoApply: done

- `planCatalog.ts`: `student_monthly` (pass, 30 days) and `student_quarterly` (pass, 90 days), `requiresFlag: 'student'`, `entitlementProfile: 'pro'`, the practice allowance of the matching pass, `neverPreselected`, labels 学生月卡 / 学生季卡, phase `v2`. `studentDiscountPercent` gives 25 and 30 from the catalog amounts and moves with an override.
- `platform/credits/catalog.ts`: **no change needed.** The catalog is keyed by column (`free` / `pro`), and `entitlementProfileFor` already maps every pass to `pro`. `catalog.test.ts` asserts it for every plan of both brands and that a live student pass gets exactly the Pro caps.
- `platform/billing/studentPlans.ts` (new) holds the one rule, in three forms:
  - `studentVerifiedForPlan`: who may **buy** a student plan (capability on and a live school-email verification). Called by `RoboApplyBillingService.createCheckout` and `BillingCnService.createOrder` before anything is recorded.
  - `studentPlansListedFor`: who is **shown** a student plan. Same two conditions, answered yes or no; a visitor with no session, an unverified user and a lookup that fails all get "no".
  - `assertStudentOrder`: the rail's own check behind the caller's. **All three rails call it now** (Stripe already did, Alipay did, WeChat Pay was importing it without calling it: fixed, with a rail test).
- `features/credits/service.ts` `plans()`: the student plans are in `GET /billing/plans` only for a signed-in, verified student (`studentPlansListedFor`; new dep `isStudentVerified`, default `studentService.isVerified`). So on GoApply the endpoint answers **five paid plans, and seven for a verified student**, exactly as plan §7 step 6 says. One rule for both brands (see "Read first").
- `PlanPicker.tsx`: keeps its own filter (flag on and verified) and, because the server now sends the student plans to nobody else, asks for the list once more when the buyer becomes verified while the sheet is open (once, never in a loop). `labels.ts` and `WechatPayCheckout.tsx` know the two names.
- `BillingCnService.createOrder` no longer refuses a student pass for its phase; without that a verified student could not have paid with WeChat Pay.

ACCEPT, tested: a verified GoApply student sees 学生月卡 ¥29 (25% below) and 学生季卡 ¥69 (30% below) and a paid order for either activates 30 or 90 days through `fulfilPass`, once, on Alipay and on WeChat Pay; an unverified buyer gets 409 `student_verification_required` with nothing sent or stored; **a user who is not verified never sees them: not in the plans API (visitor, unverified user, lookup failure, capability off), not on the plan sheet.**

Tests: `planCatalog.test.ts`, `fulfilPass.test.ts` (new cases only), `platform/credits/catalog.test.ts`, `features/credits/credits.test.ts` (six cases under "student passes are listed only for a verified student"), `RoboApplyBillingService.alipay.test.ts`, `billingCn.routes.test.ts`, `rails.test.ts`, `wechatpayRail.test.ts`, `components/features/credits/__tests__/integration.test.tsx`, `pure.test.ts`.

### 6. [P1] Checkout UI follows the plans API: done

- `PlanPicker.tsx`: the rails come from `plans.checkout.rails` (`offeredRails`, exported), never from the brand. One rail: Continue uses it. Two: a "Pay with" radio group in the server's order, the first selected (Alipay, then WeChat Pay, and WeChat Pay only while its sheet can open here). `paymentsOpen: false` or no rail left: the prices stay, one note is shown, Continue is disabled. The per-row "Not available yet" tag is kept for a single plan that is off sale while others can be bought. A 429 from the order limit shows the existing "Too many payment attempts…" message (`billingCn.errors.tooMany`).
- `BillingView.tsx`: the 续费 button opens the WeChat Pay sheet directly only when WeChat Pay is the **first** rail the server lists (Alipay cannot charge). While Alipay can charge, the plain link to the plan sheet stays and the chooser there offers both, Alipay preselected (review finding 6; M-19, G11). `useWechatPayAvailable` now also returns the server's `rails`.
- `OutOfCreditsSheet.tsx`: the practice-pack link needs `paymentsOpen`, not only a sellable pack.
- `WechatPayCheckout.tsx`, `useWechatPay.ts`, `lib/api/account.ts`, `lib/pricing.ts`: the "off until a switch" assumption removed from comments and error mapping; `student_verification_required` has its own message.
- GoApply rows already say what a pass is through the existing `passNote` ("30 days of Pro. One payment; it doesn't renew.") and "¥39, paid once"; now asserted.
- Styles: the chooser reuses the existing `.fieldset`, `.options`, `.option` classes and tokens of the plan rows. No new CSS, no literal colour.

**Behaviour change on RoboApply, in one state only.** The "not open yet" rule is one rule for both brands. When RoboApply's Stripe rail cannot charge (no key), the sheet shows the note with Continue disabled, where it used to offer a button that failed with an error. With Stripe configured nothing changes (asserted).

ACCEPT, tested at 375 px: GoApply lists the passes with CNY amounts and a working Alipay button when only Alipay can charge; with both rails it offers both and defaults to Alipay; choosing WeChat Pay opens its sheet; with no rail it shows prices and the note; RoboApply is unchanged.

Tests: `integration.test.tsx`, `billing.test.tsx`, `credits.test.tsx`, `pure.test.ts`, `billing-cn/__tests__/billingCn.test.tsx`.

### PAR-1 requests addressed to PAR-6
- **P6-1** done (item 2).
- **P6-2** decided and done (item 4): notify and status stay open under the kill switch.

### waveFIX carry-over (section "PAR-6")
1. `credits.busy` string: **done** (staged in en and zh). Its consumer is the hot-file change in `lib/api/client.ts`, not mine.
2. "0.75 used": **done.** `credits.usage.usedPractice` ("0.75 practice credits used") in `CreditsUsage.tsx`.
3. "Refills tomorrow 12:00 AM" without "at": **rejected for this wave.** The day word comes from `Intl.RelativeTimeFormat`, so adding "at" needs a new pattern string; until it is translated eight locales would show a mixed-language fragment ("明日 at 0:00"), which is worse than today. Do it inside the translation pass.
4. Account deletion reason: **not done.** It waits on an owner decision and needs `routes/account.ts`, which no bundle owns.
5. `Retry-After` on a 429 from legacy `POST /billing/checkout`: **done** (`routes/billing.ts` `handleErr`; asserted, and now also reached by the Alipay order limit).

## Review resolution

Every point was checked against the code first. All were real; none was rejected.

1. **A11 and A12 did not pass on the base (item 1 "not done", finding 1): fixed.** Reproduced the reviewer's result, then added the three explicit gate values to the `beforeEach` of the describe "Alipay contract A11 and A12: the rails stay apart". Re-measured on an extract of base `3fa104e` with the five final test files: 43 passed. On the PAR-6 tree: 43 passed. The earlier handoff sentence that claimed this was wrong for those two tests and is corrected above.
2. **WeChat Pay rail never ran the student check it imported (item 5 (b), finding 2): fixed.** `rails/wechatpay.ts` `createCheckout` calls `assertStudentOrder(order)` after the pass/pack check, before the order row and before any WeChat Pay request. New test in `wechatpayRail.test.ts`: 学生月卡 with `studentVerified` undefined or false is refused with `student_verification_required`, no HTTP call, no `AlipayOrder` row; with `true` the order is created at 2900 fen.
3. **Student passes were listed to every GoApply visitor (item 5 (a), finding 3): fixed with the reviewer's option (a).** The server lists them only for a signed-in, verified student (`studentPlansListedFor`). The item's ACCEPT line and plan §7 step 6 both say so, and by the precedence rule the plan wins over the previous behaviour. It is one rule, so RoboApply's public list changes too; that is called out under "Read first" for the owner, with the one-line way back. The plan sheet refetches once after a verification so a newly verified student sees the passes without a reload. Tests: six server cases (visitor five plans and no lookup, unverified five, verified seven, lookup failure, capability off, RoboApply follows the same rule) and two plan-sheet cases (refetch once, no loop).
4. **The missing-entity warning was evaluated at import, before dotenv (finding 4): fixed inside PAR-6.** The call is gone from `rails/index.ts`; the Alipay rail raises it on first use (`isConfigured` for the cn market against the process environment), with the once-per-process guard. Tests in `rails.test.ts`: nothing is logged at import while the secret is absent; after the secret appears the first `availableRails` logs it once and later reads and `resolveRail` stay silent; never for RoboApply, for a passed-in environment or when the entity is named. The PAR-5 request stays optional (PAR-5's handoff says it did not wire it).
5. **GoApply credit walls offered "Get Pro" while no rail can charge (finding 5): fixed.** New `platform/billing/proPurchase.ts` `canBuyPro(brand, env)` = a Pro plan is on sale and `availableRails` is not empty, the rule behind `paymentsOpen`. `EntitlementService` uses it as the default `proSellable`. Tests in `platform/credits/EntitlementService.test.ts`: GoApply with no secret false, with the secret true, under the kill switch false, under the entity gate false until the entity is named, Stripe credentials never open GoApply; RoboApply with a price and a Stripe key unchanged (true), without the price or without the key false.
6. **The billing page renew button went straight to WeChat Pay with both rails live (finding 6): fixed.** See item 6. Tests in `integration.test.tsx`: both rails listed → the plain link, no Renew button, and the plan sheet on the same page offers Alipay first and selected; Alipay alone → the plain link; WeChat Pay alone → the Renew button as before.
7. **Alipay order creation had no per-user limit (finding 7): fixed.** `RoboApplyBillingService.createCheckout` counts a new Alipay order against `billingCnCreate` (10 a minute, 60 a day per user and brand, the budget WeChat Pay orders already use, so both CN rails share it), before any acknowledgement or order exists. Over the limit: 429 `rate_limited`, `details.retryAfterSec` and a `Retry-After` header; no worker call, no order row. The check sits in front of the rail, so the frozen request and callback path is untouched. **It fails open:** if the limiter itself cannot answer, the payment goes ahead and a warning is logged, because the existing Alipay path must keep working (D6). New injectable dep `consumeRateLimit`. Tests: the eleventh order on both legacy routes; a request refused for another reason and a RoboApply request never reach the limiter; a limiter that throws does not block.
8. **`.vitest/json/output.json` (unowned): deleted.** It was untracked reporter output; nothing in the repository configuration writes it, and it is not recreated by the gate commands.
9. **`server/src/roboapply/routes/billing.test.ts` (unowned by the literal list): kept**, as the reviewer judged acceptable. Request to the orchestrator below.

## Files changed

51 modified, 4 new. All inside PAR-6's owns except the colocated route test. All paths below are under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-6/`.

Server code:
- `server/src/platform/billing/planCatalog.ts`, `planViews.ts` (comments), `origins.ts` (comment), `index.ts`, new `studentPlans.ts`, new `proPurchase.ts`
- `server/src/platform/billing/rails/alipayWorker.ts`, `registry.ts` (comments), `index.ts`, `wechatpay.ts`
- `server/src/platform/credits/EntitlementService.ts`, `summary.ts` (comment)
- `server/src/features/billing-cn/routes.ts`, `service.ts`, `contract.ts`
- `server/src/features/credits/service.ts`, `contract.ts` (comments)
- `server/src/roboapply/services/RoboApplyBillingService.ts`, `RoboApplyBillingReminderService.ts` (comment), `server/src/roboapply/routes/billing.ts`

Server tests:
- new `server/src/roboapply/routes/billing.test.ts`
- `server/src/platform/billing/planCatalog.test.ts`, `money.test.ts`, `fulfilPass.test.ts`, `rails/rails.test.ts`, `rails/registry.test.ts`, `integration/RoboApplyBillingReminderService.test.ts`, `integration/RoboApplyBillingService.stripe.test.ts` (one title)
- `server/src/platform/credits/catalog.test.ts`, `EntitlementService.test.ts`
- `server/src/features/credits/credits.test.ts`
- `server/src/features/billing-cn/__tests__/billingCn.routes.test.ts`, `wechatpayRail.test.ts`, `helpers.ts`
- `server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts`

Web:
- `components/features/credits/PlanPicker.tsx`, `BillingView.tsx`, `OutOfCreditsSheet.tsx`, `CreditsUsage.tsx`, `labels.ts`
- `components/features/billing-cn/WechatPayCheckout.tsx`, `useWechatPay.ts`
- `lib/api/account.ts` (comments), `lib/pricing.ts` (comment)
- tests: `components/features/credits/__tests__/{fixtures.tsx,pure.test.ts,billing.test.tsx,credits.test.tsx,integration.test.tsx}`, `components/features/billing-cn/__tests__/billingCn.test.tsx`, `__tests__/lib/pricing.test.ts`

i18n staging: `i18n/staging/credits.en.json`, new `i18n/staging/credits.zh.json`, `i18n/staging/billingCn.en.json`, `i18n/staging/billingCn.zh.json`.

## Tests run

All after the review fixes, in the worktree.

| Command | Result |
|---|---|
| Contract tests on an extract of the untouched base `3fa104e` with the five final test files: `npx vitest run <five files> -t "A[0-9]+ "` | 5 files, 43 passed |
| The same on the PAR-6 tree | 5 files, 43 passed |
| Every test file PAR-6 owns (`platform/billing`, `platform/credits`, `features/billing-cn`, `features/credits`, the Alipay service test, the route test, `components/features/credits`, `components/features/billing-cn`, `hooks/credits`, `__tests__/lib/pricing.test.ts`) | 35 files, 766 passed, 1 todo |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` | 623 files: 580 passed, 43 failed. 12,993 tests: 12,887 passed, 95 failed, 1 skipped, 10 todo |
| `node docs/jobright-clone/orch/check-bundles.mjs …/parity-bundles.json` | 0 problems |

Not run, by the rules: `next build`, a dev server, a browser, the extension and interview-agent suites (neither was touched).

## Red tests for other bundles

None caused by PAR-6. The 95 failures of the full run are in 43 files, every one of them named in PAR-1's red list, and the totals are the same as before the review fixes (95 in 43). No failure message mentions `upgradable`, a student plan or `rate_limited`, the three behaviours this round changed.

## Pre-existing failures

None in files PAR-6 owns. The 12 failures PAR-1's handoff lists as pre-existing (`__tests__/pages/practice.test.tsx`, `__tests__/pages/settings.test.tsx`, `components/features/onboarding/goapply.test.tsx`, `server/src/features/auth-cn/routes.test.ts`, one in `legacyJobScope.test.ts`) did not fail as such in my full run on this base; I did not investigate why.

## Requests

### PAR-3
- **Student pass names in billing mail.** `server/src/platform/email/templates/billing/index.ts` `planName` applies the `Cn` suffix only to keys that start with `pro_`, so a GoApply student pass reminder would read "学生月付" / "Student Monthly" (subscription names). Change the test to `planKey.startsWith('pro_') || planKey.startsWith('student_')` and add to `server/src/i18n/email/en.json` and `zh.json` (no bundle owns these two files; orchestrator if not PAR-3): `billing.planNames.student_monthlyCn` = "Student 30-day pass" / "学生月卡", `billing.planNames.student_quarterlyCn` = "Student 90-day pass" / "学生季卡".
- **After your merge** the fallback branch in `integration/RoboApplyBillingReminderService.test.ts` (`SHARED_EMAIL_IS_DEFAULT`) is dead and can be deleted. It relies on `transportNameFor(goapply, { RESEND_API_KEY })` answering `'resend'`, which your handoff confirms.

### PAR-9
- `GET /billing/plans` keeps the contract of plan §5 field for field (`paymentsOpen`, `checkout.rails`); `checkout.rails` is ordered, the first is the default. With no `ALIPAY_CALLBACK_SECRET` GoApply answers `paymentsOpen: false` with all prices present and `sellable: true`. Your handoff says the pricing page already follows `paymentsOpen`; nothing more is needed.
- **Changed since the first handoff:** the response carries the student passes only for a signed-in, verified student. A visitor to `/pricing` gets five paid GoApply plans (and RoboApply's regular plans), so the page lists no student card for them; a verified student who is signed in gets seven. No change is needed in `PricingPage.tsx`. Their names are staged as `credits.plans.goapply.student_monthly` / `student_quarterly`.

### PAR-5
- Optional, unchanged. The missing-entity notice is logged by the Alipay rail on first use. If you want it in the startup report as well, call `warnIfAlipayEntityUnset(env)` (exported from `platform/billing/rails`) from `runStartupAssertions`, after the environment is loaded; its guard keeps the two to one line.

### PAR-10
- Document the variables in the table below. `.env.example` and `deploy/cn/cn.env.example` should not ship `CN_PAYMENTS_ENABLED=false` or `CN_PRICE_*` placeholders with a value (an empty `CN_PRICE_*` is fine: blank means unset), and should say that `ALIPAY_CALLBACK_SECRET` alone opens GoApply payments. P6-A confirmed under item 2.
- Verification step 6 of plan §7 is true as written: five paid plans, and two student passes for a verified student.
- Worth one line in the operator notes: a new Alipay order is limited to 10 a minute and 60 a day per user, shared with WeChat Pay (`billingCnCreate`).

### PAR-1
- Low priority. With `CN_PAYMENT_REQUIRE_ENTITY=true` and no entity, the capability `pay.alipay` (and the public brand payload's `paymentRails`) still says Alipay is on while the rail refuses. `GET /billing/plans` and `upgradable` are right (both ask the rail). If the brand payload should agree, `flags.ts` would need the same check.

### Market wave (PC-4, pricing copy)
- MARKET_STRATEGY §4.2 asks for "one public price for every buyer plus a published student rule". With the student passes now sent only to a verified student, a public page that states the student price needs the two amounts for a visitor. Proposed additive field when PC-4 builds it: `studentOffer: Array<{ key, amountMinor, studentDiscountPercent }> | null` on `GET /billing/plans`, filled while the `student` capability is on. Not built here: no page reads it in this wave.

### Orchestrator
- `server/src/roboapply/routes/billing.test.ts` is new and colocated with an owned file; allow it in the ownership check.
- `lib/api/client.ts` (hot file, unowned follow-up 1): `credits.busy` is staged and waits for its consumer.
- i18n pass: the keys below, en and zh staged. `credits.planSheet.emptyCn` is no longer referenced by any component and can be removed in the cleanup.
- After the merge, run the full suite once more for `RoboApplyBillingReminderService.test.ts` (it switches to the no-`CN_EMAIL_*` setup by itself once PAR-3's email fallback is in).

### Owner
- Put `ALIPAY_CALLBACK_SECRET` (the value production uses) in the GoApply environment; until then GoApply shows prices and cannot charge.
- Set `CN_PAYMENT_COLLECTING_ENTITY` to print the collecting entity on Alipay orders and receipts. It is not required for Alipay any more; WeChat Pay still requires it and requires it to match `WECHATPAY_MERCHANT_ENTITY`.
- **Confirm the student listing rule.** Student plans are now sent only to a verified student on both brands, as the plan says. If RoboApply's public pricing page should keep showing its student plans to everyone, say so: it is a one-line change, and the plan's verification step 6 then needs rewording.
- Decide the account-deletion reason field (carry-over 4).

## Schema requests

None. The order limit uses the existing `RARateCounter` table through `platform/ratelimit`.

## Env variables added or redefined

No variable was added in the review round.

| Name | Meaning | Default |
|---|---|---|
| `CN_PRICE_<PLANKEY>_FEN` (`PRO_WEEK_PASS`, `PRO_MONTHLY`, `PRO_QUARTERLY`, `PRACTICE_PACK_5`, `PRACTICE_PACK_15`, `STUDENT_MONTHLY`, `STUDENT_QUARTERLY`) | redefined: an optional override of the catalog amount, in fen. Used only when it is a positive multiple of 100; any other value is ignored and logged once | catalog default: 1200, 3900, 9900, 2900, 7900, 2900, 6900 |
| `CN_PAYMENTS_ENABLED` | redefined in the catalog and the rails: a false value marks every GoApply plan unsellable (`payments_disabled`), closes both CN rails for new orders, makes `POST /billing-cn/wechatpay` answer 503 `payments_disabled` and turns `upgradable` off. The Alipay callback, the WeChat Pay notify and the order status stay open | on (unset) |
| `CN_PAYMENT_REQUIRE_ENTITY` | new: `true` = the Alipay rail refuses to charge (`rail_not_configured`) until `CN_PAYMENT_COLLECTING_ENTITY` is set | off |
| `CN_PAYMENT_COLLECTING_ENTITY` | redefined for Alipay: printed on the order body and the receipt when set; no longer a gate. Unchanged for WeChat Pay (required, must match the merchant). Brand-own: never read from another brand | unset (one warning per process, on the first plans read or checkout, when GoApply can charge) |
| `ALIPAY_CALLBACK_SECRET` | unchanged: the Alipay rail's one required credential. It now also decides `upgradable` on GoApply | unset (rail closed) |
| `ALIPAY_API_URL` | unchanged: optional override of the worker endpoint | `https://worker.gohire.top/payment/payment/create` |
| No longer needed by any payment code | `CN_PAYMENTS_ENABLED=true`; a price variable per plan | |

## i18n keys added or changed

All new; none changed; none added in the review round (the 429 message reuses the existing `billingCn.errors.tooMany`). English in `i18n/staging/<ns>.en.json`, Chinese in `<ns>.zh.json`.

`credits`:
- `credits.busy`
- `credits.plans.goapply.student_monthly`, `credits.plans.goapply.student_quarterly`
- `credits.planSheet.notOpen`, `credits.planSheet.railGroup`
- `credits.planSheet.rails.alipay`, `.wechatpay`, `.stripe`
- `credits.planSheet.railHint.alipay`, `.wechatpay`, `.stripe`
- `credits.usage.usedPractice`

`billingCn`:
- `billingCn.plans.student_monthly`, `billingCn.plans.student_quarterly`
- `billingCn.errors.studentRequired`

## Known gaps

- **Not seen in a browser.** The bundle rules forbid a dev server and a browser. The rail chooser, the note and the renew link were tested in jsdom at 375 px only; light and dark, both brands and 1280 px still need the eye. They reuse the plan rows' existing classes and tokens, so the risk is layout, not colour.
- **Chinese strings show in English until the i18n merge.** The runtime merges only the English staging files; the staged `zh` files are for the merge. One visible effect before the merge: a GoApply student pass reads "Student 30-day pass" on a Chinese page.
- **The public pricing page states no student price.** A consequence of listing student plans only for a verified student. The published student rule of MARKET_STRATEGY §4.2 is the market wave's pricing copy (PC-4); the request above says what it needs from the API.
- **An in-flight WeChat Pay order under the kill switch has no dedicated return page.** The server completes it (notify and status stay open), but the web return page shows its ordinary "checking your plan" state, because `useWechatPayAvailable` follows the capability. The buyer still sees Pro once the notify lands.
- **The order limit fails open and is per user, not per IP.** A limiter outage lets orders through (by design, so Alipay keeps working). An attacker with many accounts is not slowed by it; sign-up limits are the guard there.
- **The missing-entity warning is per process and on first use.** A process that never reads plans or opens a checkout never logs it; on Vercel it is once per cold start, not once per deployment.
- **The legacy `GET /billing/plan`** (old settings client) still builds its catalog without the student capability, so it never lists student passes. Unchanged; the plan sheet reads `GET /billing/plans`.
- Wire parity and callback tolerance (AL-3, AL-4), the mainland-visitor link (AL-6), the refund record (AL-7), the cut-over runbook (AL-8), RoboApply USD defaults and the Stripe catalog sync are the market waves', as the plan says. The ten findings under item 1 are their input.
