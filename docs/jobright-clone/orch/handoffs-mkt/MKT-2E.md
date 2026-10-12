# MKT-2E

Billing UI for the subscription lifecycle (web): reconcile on return, in-app switch, resume, payment update, GoApply link for mainland visitors. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2E`, branch `wp/MKT-2E`. Nothing committed. No server file, no `*.prisma`, no `i18n/messages/*` touched. No command reached Stripe, a database or the network. Not seen in a browser (rules).

This is the handoff after the independent review. The three findings are fixed (all in "Keep my plan"); the two items the reviewer listed as not done stay as Requests because the files are outside my owns. See "Review resolution" at the end.

## Items

### 1. [P0] Types by hand from the contracts: done
- `lib/api/account.ts`: `reconcileCheckout(sessionId)`, `resumeSubscription()`, `portal(body?)`, `switchConfirm` with the new union, all in the `roboApi` style with hand-written types copied from MARKET_TASK_PLAN §3.1. Every answer goes through a normaliser with a safe default (`normaliseReconcile`, `normaliseResume`, `fromServerSwitch`), so the file works before and after MKT-2B / MKT-2C merge. Nothing added to `lib/api/credits.ts` or to `lib/api/contracts/credits.ts`.
- Error codes are read with `apiErrorCode` (plus the HTTP status for the reconcile refusals).
- No amount, date or plan name in the new copy (a test scans the new strings).
- ACCEPT met: `npm run typecheck:web`, the owned tests and `npm run check` pass in this worktree without the server bundles.

### 2. [P0] Return page reconciles the Checkout Session (ST-3 web): done
- `app/(auth)/settings/billing/return/page.tsx` reads `session_id` through `checkoutSessionId` (`/^cs_[A-Za-z0-9_]{8,200}$/`) and passes `sessionId`.
- `CheckoutReturn.tsx`: on outcome `success`, with a session id, on the international brand: one call when the page opens, again on every third re-read while still waiting (`RETURN_RECONCILE_EVERY = 3`; with 10 re-reads that is at most 4 calls). After any answer the credit summary is invalidated. The page turns to done only from the summary (Pro) or the practice balance (pack). `fulfilled` / `already_fulfilled` end the calls; `pending` keeps them. GoApply never calls it; no call without a session id, on cancel, or with no outcome.
- Beyond the item text, two choices:
  - Final refusals are 403, 404, **422** and **503 `stripe_not_configured`** (the item names 403 and 404). Asking again cannot change those. 429, 502 and network errors are asked again on the schedule. One rule: `reconcileRefusalIsFinal`.
  - A pack bought with no `practiceBefore` (nothing to compare) is waited for only while the server answers `pending`; when it settles the page shows the neutral "added as soon as the payment clears" line, never "You have N now".
- Tests: `billing.test.tsx` "CheckoutReturn: the Checkout Session is reconciled on return" (19 cases, fake timers: call count per state, the route's `session_id` parsing, no claim from the answer alone, final and passing refusals, GoApply, cancel); `integration.test.tsx` (GoApply with and without WeChat Pay); `pure.test.ts` (refusal rule, constants); `lib/api/account.test.ts` (wire).

### 3. [P0] Every Pro to Pro switch in the plan sheet (ST-5 web): done
- `PlanPicker.tsx`: a Pro subscriber whose plan renews and is not cancelled is offered every subscription of the brand (weekly, monthly, quarterly; student plans under the existing student gate). Their own plan is listed as "Your plan" and disabled; the others are switches through `SwitchQuoteSheet`. Passes: only after cancelling or by link, as before. A cancelled subscriber sees the passes only, as before. One rule: `offeredProPlans`.
- The portal sentence: new key `credits.planSheet.portalScope` ("Manage payment is for your payment method, invoices and billing details. To change your plan, choose another one here."). `manageInPortal` is read by nothing now. A new key and not new English under the old one, because staged English does not replace the eight translated bundles at runtime (the lesson of the M1 gate).
- `SwitchQuoteSheet.tsx`: `requires_action` shows "Your bank needs you to confirm this payment. Your plan has not changed yet." with a link button to `hostedInvoiceUrl` (same tab, `rel="noopener"`); with no URL, Manage payment (plain portal). No done state; the quote and Confirm go away so the payment is not asked for twice. The plan sheet still shows the old plan (the summary is read again after the answer).
- Design choices, flagged:
  - **The renewal box of a switch is on the quote sheet, not the plan sheet**, and names the quote's renewal price and the new period. Reason: the server records the acknowledgement with the charged amount of the switch (`RoboApplyBillingService.switchPlan`, whose own comment calls it "the unticked box on the quote sheet"), and the catalog price on the plan sheet can differ from it (a subscription charged in another currency). The item's ACCEPT ("must tick the acknowledgement for the new terms, and Confirm stays disabled until then") holds. This also applies to the legacy practice plan to Pro switch; its test is rewritten.
  - **Nothing is preselected for a subscriber** unless they asked for a plan by link (weekly is never preselected in any case). A switch is the subscriber's own choice; preselecting Monthly for a quarterly subscriber would suggest a dearer plan.
  - The selection is now derived (own pick, else the link, else the server default) from the options that can be chosen. This closes carry-over MKT-2E.5 (b): a link to a plan the buyer is not offered falls back to the default instead of a dead Continue.
  - Continue waits until the plan the buyer is on is known (`sub.status !== 'loading'`): before, a subscriber could start a second checkout in the moment before the summary arrived.
- `lib/api/account.ts` `switchConfirm`: `{ switched: true }` → `switched`; `{ requiresAction: true }` → `requires_action` (only an http(s) `hostedInvoiceUrl` is kept); any other shape throws, so the sheet says "The switch didn't go through".
- Tests: `billing.test.tsx` "a Pro subscriber changes plans here…" (offered options for a weekly, monthly and quarterly subscriber, quote numbers, the box, weekly, requiresAction with and without a URL, failure, student gate, link fallback, the wait), `integration.test.tsx` (the card keeps the old plan after requiresAction; shows the new one after a switch), `accountV2.test.tsx` (one test updated), `pure.test.ts`, `lib/api/account.test.ts`, `useBillingActions.test.tsx`.
- Rewritten tests (they pinned the old rule on purpose): "a renewing subscriber asking for weekly gets no selection", "a server default the sheet does not show" (text only), "legacy practice plan: switching…", "monthly Pro: … no plan cards for the same interval", "the requested pass is shown even while the plan still reads as renewing", and in `accountV2.test.tsx` "offers a monthly subscriber the quarterly plan by link".

### 4. [P0] "Keep my plan" (ST-6 web): done (reworked after the review)
- New `components/features/credits/ResumeSubscription.tsx`, mounted by `CurrentPlanCard` under the "Cancelled. Pro stays on until {date}." line.
- **When it is offered** (`canResumeSubscription`): a plan that renews by itself, cancelled, period end in the future, on the international brand. Never for a pass, after the period ended, on GoApply, **or for a grandfathered practice plan** (`sub.legacy`). The server half (MKT-2C `resumeSubscription`) refuses every legacy plan with 409 because it keeps no renewal terms for one; that subscriber keeps Manage payment and the switch to Pro.
- **The price in the box** (`resumeTerms`): the period of the summary's `interval` and the price the subscription is charged, `GET /billing/plan` `current.amountMinor` / `currency` (`SubscriptionState.chargedAmountMinor` / `chargedCurrency`). That is the subscription row's amount, the same figure the server stores with the acknowledgement. **The catalog price is no longer a fallback**: it is not what the server records (with no row amount the server asks Stripe) and it can differ from the charge (a Taiwan subscriber on the TWD price, an older subscriber on an earlier price). With no charged price (the billing plan has not answered, its read failed, or it states none) the control is not offered; the legal sentence is never printed with a guess (D3). This goes one step further than the review's minimum (`billing.isSuccess`), on the reviewer's own second option.
- The box is unticked; "Keep my plan" is enabled only while it is ticked. Success: the hook invalidates what cancel invalidates; the card reads "Renews on {date}" from the refetched summary; until then it says only "Renewal is back on.". If the user had cancelled on this page, the "cancelled" confirmation is removed (`CancelSubscription` is remounted by key).
- **409 `nothing_to_resume` is worded from the plan read after the refusal, never from the code alone** (the server uses the code for "the plan ended" and for "the plan still renews"):
  - the plan read again is over (free, a pass, or a cancelled plan past its period end; `subscriptionIsOver`): "This plan has already ended. Choose a plan below.";
  - it renews again (kept in another tab, or a double click): nothing; the card already says "Renews on {date}" and the plan sheet says "Your plan";
  - it still reads as cancelled and running: "We couldn't turn renewal back on. Try again." (never "already ended").
  - To make that possible `useResumeSubscription` keeps a `nothing_to_resume` refusal pending until the billing state has been read again (at most `RESUME_REREAD_WAIT_MS` = 5 s; a failed read does not hold it). Other refusals answer at once, as before. The refusal is read from the call's own state, so it reaches the screen together with the fresh plan.
  - The control starts over (unticked box, no old answer) each time the plan becomes "cancelled and running" again and each time it renews again, so a refusal is never carried into a later cancellation.
- 422 / 503 / 502: "We couldn't turn renewal back on. Try again."
- `hooks/credits/useBillingActions.ts`: `useResumeSubscription`, `RESUME_NOTHING_CODE`, `RESUME_REREAD_WAIT_MS`; `lib/api/account.ts` `resumeSubscription()` (`POST /api/v1/roboapply/credits/resume { autoRenewAck: true }`).
- `CancelSubscription.tsx`: comment only (the control lives on the card; no logic there needed changing).
- ACCEPT: "a 409 shows the ended message" now holds for the case the message is true (the plan has ended). For the other meanings of the same code the page shows what is true instead. This narrows the item text on purpose; the review asked for it.
- Tests: `billing.test.tsx` (visibility matrix of 10 states including the legacy row, disabled state, charged price over catalog price, a TWD charge, no charged price → not offered, billing read failed → not offered, success, the gap before the refetch, cancel then keep, 409 with the plan over / renewing again / still cancelled, a refusal not carried into a later cancellation, three other errors), `pure.test.ts` (`canResumeSubscription` with the legacy case as the page derives it, `resumeTerms` without a catalog, `subscriptionIsOver`), `useBillingActions.test.tsx` (the wait: held until the summary answers, not held by a failed read, capped, not applied to other codes), `lib/api/account.test.ts`.

### 5. [P1] Failed-payment banner opens the payment-method flow (ST-7 web): done
- `PaymentFailedBanner.tsx` calls the portal with `{ flow: 'payment_method_update' }`; `usePaymentPortal` takes an optional `{ flow }`; "Manage payment" on `BillingView` posts no flow (and no body). `lib/api/account.ts` `portal(body?)`.
- Tests: banner posts the flow and navigates; Manage payment calls `portal()` with nothing; 409 / 503 / 502 show the existing error line; the banner shows for `past_due` / `unpaid` / `incomplete` and clears on refetch; wire test (no body on the plain call).

### 6. [P1] Mainland visitor line (AL-6 web): done
- `PlanPicker.tsx`: when `brand.market` is `intl` and the resolved visitor country is exactly `CN`, one muted line above the options with one link to `brand.otherBrand.canonicalOrigin + '/pricing'` (`cnVisitorPricingUrl`; https origins only). `rel="noopener"`, opened by the user, nothing navigates on render, the card plans stay usable.
- Copy `credits.planSheet.cnVisitor`: "In mainland China? <link>You can pay in RMB with Alipay on %OTHER_BRAND%.</link>" and in `credits.zh.json` 在中国大陆？<link>可在 %OTHER_BRAND% 用支付宝以人民币付款。</link>. The brand name is the `%OTHER_BRAND%` token (the copy gate refuses a literal product name), which renders "GoApply" on RoboApply.
- Tests: country matrix (CN shows; TW, HK, MO, US, SG, null do not), the country from the plans response and from the edge lookup, link target and `rel`, no `navigate` and no `location.assign` on render, Continue still opens the card checkout, GoApply never renders it, the staged strings.

### Carry-over (waveM1-carryover "### MKT-2E", wavePAR-carryover "Market waves")
- **MKT-2E.1 (three members of `PlansResponse`): done for my files.** `plansView` in `components/features/credits/__tests__/fixtures.tsx` now carries `studentOffer: null` next to `refundPolicy` and `checkout.collectingEntity`; every helper builds on it. See Requests (MKT-2C / MKT-4A).
- **MKT-2E.2 = PAR payments 10 (in-flight WeChat Pay order under the kill switch): left, with a finding.** The carry-over says it needs a server fact the web lacks. It does not: `GET /billing-cn/wechatpay/orders/:id` stays open under the kill switch whenever WeChat Pay is set up and answers 404 `feature_disabled` when it is not (`server/src/features/billing-cn/routes.ts` `whenSetUp`). The blocker is in `components/features/billing-cn/WechatPayReturn.tsx` (not in my owns; no M2 bundle owns `components/features/billing-cn/`), which asks nothing unless the `pay.wechatpay` capability is on. Exact change under Requests. The reviewer accepted this under the ownership rule.
- **MKT-2E.3 (attempt key on a page restored from the back-forward cache): done.** `useCheckoutAttempt` renews the key on `pageshow` with `persisted`. The switch and resume calls need no attempt key (the server builds their idempotency keys from the subscription).
- **MKT-2E.4 (closed-state rule): kept as built.** Owner 5.
- **MKT-2E.5 (student plan dead end on RoboApply `/pricing`): half done.** (b) is fixed in the plan sheet (item 3). (a) is `components/features/marketing/PricingPage.tsx`, owned by MKT-1B in M1 and by no M2 bundle: Request.
- **MKT-2E.6 (no "Save N%" on a student plan): kept**; a test still asserts it.

## Files changed
All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2E/`.
- `lib/api/account.ts`, `lib/api/account.test.ts`
- `app/(auth)/settings/billing/return/page.tsx`
- `hooks/credits/useBillingActions.ts`, `useBillingActions.test.tsx`, `useSubscriptionState.ts`, `index.ts`
- `components/features/credits/CheckoutReturn.tsx`, `PlanPicker.tsx`, `SwitchQuoteSheet.tsx`, `BillingView.tsx`, `PaymentFailedBanner.tsx`, `CancelSubscription.tsx` (comment), `index.ts`, new `ResumeSubscription.tsx`
- `components/features/credits/__tests__/billing.test.tsx`, `integration.test.tsx`, `pure.test.ts`, `accountV2.test.tsx`, `fixtures.tsx`
- `i18n/staging/credits.en.json`, `i18n/staging/credits.zh.json`

Changed in the review round: `ResumeSubscription.tsx`, `hooks/credits/useBillingActions.ts`, `useBillingActions.test.tsx`, `__tests__/billing.test.tsx`, `__tests__/pure.test.ts`. No unowned path is in the diff (22 paths, all listed above).

No new CSS: the new blocks reuse classes of `credits.module.css`. No new dependency.

## Tests run
After the review round, in the worktree:

| Command | Result |
|---|---|
| `npx vitest run components/features/credits hooks/credits lib/api/account.test.ts __tests__/lib/accountSwitch.test.ts` | 10 files, 329 passed |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` | 675 files passed; 15,812 passed, 1 skipped, 10 todo, 0 failed (base 15,702) |
| `npx vitest run --exclude ".claude/**" -t "A[0-9]+ "` | 9 files, 55 passed; no billing server file is in my diff |
| `node scripts/i18n-merge-staging.mjs --dry-run` | valid; my 9 keys listed as new |

Mutations of the review fixes, each caught by the new tests: the legacy guard removed (2 tests red); the wait of the refused resume removed (2 red); the "renews again" restart and the `subscriptionIsOver` check removed together (1 red). The eight mutations of the first round still hold. Not run, by the rules: `next build`, a dev server, a browser, the extension and interview-agent suites (not touched).

## Red tests for other bundles
None.

## Pre-existing failures
None.

## Requests

### MKT-2B (seam, nothing to change if built as the contract says)
- `POST /billing/portal`: the plain call sends **no body** (not `{}`); the banner sends `{ "flow": "payment_method_update" }`. The route must accept a missing body.
- `POST /billing/checkout/reconcile`: the web sends `{ sessionId }` only from a RoboApply page, reads `status` and treats any other shape as `pending`. It stops on 403, 404, 422 and 503 `stripe_not_configured`; it asks again (every third re-read, at most 4 calls per page view) on 429, 502 and `pending`. A page refresh asks once more; the claim makes that a no-op.
- `POST /billing/switch` with `confirm`: the web calls it a switch only for `switched === true`, and "confirm with your bank" only for `requiresAction === true`; any other answer shows "The switch didn't go through". A `hostedInvoiceUrl` that is not http(s) is treated as null (the sheet then offers Manage payment).

### MKT-2C
- `POST /credits/resume`: `nothing_to_resume` must be the envelope `code` (read with `apiErrorCode`). The web no longer depends on what the code means: it reads the plan again and words the refusal from it.
- **Renewal price, one source.** The web shows the acknowledgement only with `GET /billing/plan` `current.amountMinor` / `currency`, which is the subscription row's amount, the first source of your `renewalPrice`. When the row has no amount you ask Stripe; the web then has no charged price and does not offer "Keep my plan" (it will not print the catalog price, which can differ). To offer it to those subscribers too, either let `GET /billing/plan` `current.amountMinor` / `currency` carry the price you will record (asked from Stripe when the row has none), or write the row's amount when the subscription is synced. No web change is needed for either.
- The legacy request of the first handoff is dropped: the web no longer offers "Keep my plan" for a legacy practice plan, which matches your refusal.
- After a switch the web shows "You're on {plan}." without a date (the contract has no renewal date in the confirm answer). If you add `nextRenewalAt` to it, `fromServerSwitch` is the one place to read it.

### MKT-2C / MKT-4A (carry-over MKT-2E.1)
- Every plans response built by the web credit fixtures now carries `checkout.collectingEntity`, `refundPolicy` and `studentOffer`. Remaining literal without them: `components/features/billing-cn/__tests__/billingCn.test.tsx` local `plansView` (about line 65; no M2 owner). It is cast through `unknown`, so it does not stop the type-check; add `collectingEntity: null`, `refundPolicy` and `studentOffer: null` there for a truthful fixture. `withoutBillingFacts` removes the three on purpose (a response from an older server) through a cast. With that, the three members can become required in `features/credits/contract.ts` and `PlansResponseSent` can go.

### MKT-4C (owner of `lib/pricing.ts` in M4)
- `formatMoney` uses the narrow currency symbol, so a subscription charged in TWD reads "$749" in an English UI, in the resume sentence as in the checkout sentence. On the plan sheet a note beside the price names the currency; the acknowledgement sentence has none. Decide whether the acknowledgement should name the currency when it is not the brand's default (for example "NT$749"); the change belongs in `lib/pricing.ts` or in one helper used by both sentences.

### Orchestrator
- **`components/features/marketing/PricingPage.tsx` (carry-over MKT-2E.5 a; no M2 owner):** in `PlanCard`, for `plan.requiresFlag === 'student'`, print `credits.pricing.studentOffer.how` and show the checkout link only to a verified student (`useStudentStatus`, enabled only when signed in), otherwise a link to `/settings/billing`. The plan-sheet half is done: a link to a student plan now lands on the default plan for an unverified buyer.
- **WeChat Pay order in flight under the kill switch (PAR payments 10; `components/features/billing-cn/` has no owner):** in `WechatPayReturn.tsx` ask for the order whenever the brand's market is `cn` and `?order=` is an order number (`useWechatPayOrder(id)` without the `available` condition), and treat a 404 `feature_disabled` answer as "WeChat Pay is not set up here" (render nothing and report it through `onStatus`). Then in `CheckoutReturn.tsx` (MKT-4C owns it in M4) drop `wechatPay.available` from `cnOrder` and fall back to the ordinary page on that report. The test "with WeChat Pay off the ordinary return page shows and no order is looked up" in `components/features/credits/__tests__/integration.test.tsx` then asserts one lookup and the ordinary page after the 404.
- **Ownership check:** allow `lib/api/account.test.ts` and `hooks/credits/useBillingActions.test.tsx` (colocated with owned files, as in M1) and the new `components/features/credits/ResumeSubscription.tsx`.
- **After the M2 merge, on the merged tree:** `npx vitest run components/features/credits hooks/credits lib/api/account.test.ts __tests__/lib/accountSwitch.test.ts __tests__/contracts`. Then one seam check per route against the real server code: the four request bodies above, and the answers `{ switched, requiresAction, hostedInvoiceUrl, planKey }`, `{ status, mode, planKey }`, `{ status: 'resumed', planKey, renewsAt }`. For resume also check that `GET /billing/plan` `current.amountMinor` equals the amount `renewalPrice` records for a subscription row that has one.
- **i18n pass (OT-2):** translate the 9 new keys below. Keep the `<link>…</link>` tags and the `%OTHER_BRAND%` token in `credits.planSheet.cnVisitor` in every locale (the zh source is staged). After the merge remove `credits.planSheet.manageInPortal` from all nine bundles (read by nothing; grep first). Until the merge every non-English locale shows the new strings in English, including the mainland line for a zh reader on RoboApply.

### Owner
- Confirm or change: nothing is preselected on the plan sheet for a current subscriber; a cancelled subscriber is offered the passes and "Keep my plan", not another subscription, while the cancelled one still runs.
- Confirm or change: "Keep my plan" is offered only when the charged price is known from billing, and never for a legacy practice plan.
- M-18 (strategy §7 item 8): the mainland line is built as the default says. It links to `https://www.goapply.top/pricing`; it is useful only once goapply.top serves this flow.
- Counsel: the resume acknowledgement reuses the checkout sentence word for word, with the charged price.

## Schema requests
None.

## Env variables added or redefined
None.

## i18n keys added or changed
All new, none changed or removed. English in `i18n/staging/credits.en.json`. The review round added no key and changed no string.
- `credits.planSheet.portalScope`
- `credits.planSheet.cnVisitor` (rich text: `<link>` and `%OTHER_BRAND%`; zh also staged in `credits.zh.json`)
- `credits.quote.requiresAction`, `credits.quote.requiresActionCta`
- `credits.resume.button`, `.pending`, `.done`, `.ended`, `.error`

No longer read: `credits.planSheet.manageInPortal`. The return page needed no new string (the item lists the file; the existing waiting and "taking longer" copy is kept). `billingCn.*`: nothing added (no item changes GoApply copy).

## Known gaps
- **Not seen in a browser.** Both brands, light and dark, 375 px and 1280 px still need the eye, in particular: the mainland line (its link is the sheet's 44 px inline link, so at 375 px the sentence inside the link wraps as one block), the box and button under the cancelled line on the card, and the box inside the quote sheet.
- **Contract only.** The server halves (MKT-2B, MKT-2C) are not in this worktree. Until they merge: reconcile answers 404 and the page behaves as before; resume answers 404 and shows the generic line; the portal ignores `flow`; a switch answers `{ switched: true }` as today. The legacy refusal and the meanings of `nothing_to_resume` were read in the sibling worktree `wp-MKT-2C` (read only) and may still change before the merge; the web no longer depends on either.
- **"Keep my plan" is not offered without a charged price on the billing plan**: a subscription row with no amount, a billing plan that failed to load, or a legacy practice plan. Such a subscriber can still turn renewal back on in the payment portal. The Stripe sync writes the amount on every subscription event (a cancellation fires one), so a row without it should be rare; see the Request to MKT-2C.
- **A refused resume can stay "pending" for up to 5 seconds** while the billing state is read again (only for 409 `nothing_to_resume`). If that read fails or takes longer, the page shows the retry line first and corrects itself when the plan arrives.
- **A TWD charge reads "$749" in an English UI** in the acknowledgement (the shared `formatMoney`, not mine): Request to MKT-4C.
- **After "confirm with your bank"** the buyer finishes on the payment provider's page and is not brought back by us; the plan changes when the server hears of it. The sheet says the plan has not changed yet; it does not poll.
- **Already Pro when the return page opens** (a second pass): the page says "Pro is on." at once, as before this bundle; the reconcile call still runs once for the new purchase.
- **The back-forward cache rule** is tested with a synthetic `pageshow` event, not in a real browser.
- **A subscriber who asks for a pass by link** still gets the pass as a checkout, as before; the server refuses a pass while a plan renews and the sheet shows its normal error line.

## Review resolution
1. **Finding (medium): a cancelled legacy practice plan was offered "Keep my plan", then told "already ended". Fixed.** Verified: `deriveSubscriptionState` gives a legacy Stripe plan `autoRenews`, the sync writes interval `month` and the charged amount, and `wp-MKT-2C` `resumeSubscription` refuses it (`!definition?.autoRenews`). `canResumeSubscription` now takes `legacy` and returns false for it. New matrix row "a cancelled legacy practice plan, period still running → shown: false" in `billing.test.tsx` and a case in `pure.test.ts` built through `deriveSubscriptionState`. The matching Request to MKT-2C is dropped.
2. **Finding (medium): 409 `nothing_to_resume` always read "already ended". Fixed.** Verified: the server uses the code for a plan that still renews too, and the component latched the line before looking at the plan. The latch is gone. The line shows only when the plan read after the refusal is over (`subscriptionIsOver`); a plan that renews again shows nothing; a plan still cancelled and running shows the retry line. `useResumeSubscription` holds that refusal until the state has been read again (5 s cap), so the first thing shown is already the right one. The old test "…also after the card reads the plan again" is replaced by four: plan over, renews again (the reviewer's case: no ended line under "Renews on", and the plan sheet says "Your plan"), still cancelled, and a refusal not carried into a later cancellation; plus four hook tests for the wait.
3. **Finding (medium): the catalog price was printed when the billing plan read failed. Fixed, and taken one step further.** Verified: `!billing.isLoading` is true after a failed read, and `renewalPrice` records the row's amount or asks Stripe, never the catalog. The catalog fallback is removed entirely (the reviewer's second option), so a failed, missing or amount-less billing plan offers no control and the sentence can only carry the figure the server records. New tests: `account.plan` rejects → no control; no charged amount although the catalog lists the plan → no control; a TWD charge is named instead of the catalog's USD price. The Request to MKT-2C now states the one source and how the server can widen it.
4. **Not done: carry-over MKT-2E.2 / PAR payments 10 (WeChat Pay order in flight under the kill switch). Still not done, by the ownership rule.** The change is in `components/features/billing-cn/WechatPayReturn.tsx`, which is outside my owns. The exact change stays under Requests (orchestrator). The reviewer judged this acceptable.
5. **Not done: carry-over MKT-2E.5 (a) (student plan on `/pricing`). Still not done, by the ownership rule.** `components/features/marketing/PricingPage.tsx` is outside my owns (MKT-1B in M1, no M2 owner). Half (b) is done and tested. The exact change stays under Requests (orchestrator).
6. **Unowned edits: none** (the reviewer found none; `git status` shows 22 paths, all inside the owns or test files colocated with owned files).
7. **Gates re-run after the fixes:** all green, numbers under "Tests run".
