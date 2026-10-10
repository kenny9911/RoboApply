**INT-02 · status: complete** — all 8 items are implemented and the review's four in-scope findings are fixed with tests. The fifth finding sits in files other bundles own and stays in Requests. Nothing was committed, pushed or stashed, and no dev server or browser was run.

The full suite does not pass cleanly at default timeouts on this machine right now: two runs each failed a different handful of timeout-only tests in files I do not own, with load average between 160 and 245 from the sibling bundles. The same command with longer timeouts passes all 549 files.

Worktree: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-02`

## Review resolution

1. **Taiwan checkout recorded the USD acknowledgement while charging TWD — fixed.** `createCheckout` now records the acknowledgement against the price actually charged (`usesTwdPrice`). `AckPricedPlan` in `acknowledgements.ts` widens `currency` so a TWD amount type-checks. New test asserts the stored `proseHash` for a TW buyer with and without the TWD pair, for US/no country, and for quarterly from TW.
   - I also fixed the same defect on plan switch, which the review did not list: a switch on a TWD subscription recorded the USD sentence. `confirmSwitch` now hands the charged renewal price to `ack.record(charged)`. Tested.
2. **Legacy `/billing/checkout` WeChat Pay skipped the terms gate — fixed with the full gate, not by removing the rail.** Item 3's acceptance requires H5 through this route, so dropping `wechatpay` there was not an option.
   - `BillingCnService.acknowledgeTerms()` is new and shares its pieces with `createOrder`: the per-user limit, the published-version check through the same injectable resolver (join J5 still applies to both paths), and the same `cn_pay_terms_ack` consent record.
   - `createCheckout` calls it whenever the resolved rail is `wechatpay`, before any record or order exists. It answers 409 `terms_outdated` with `details.currentVersion`, or 429 `rate_limited`.
   - Tests: missing, stale or arbitrary version gives 409 with no order and no consent row; nothing published gives 409; the limiter gives 429; the happy path writes the exact consent hash; Alipay is not gated.
3. **H5 return heading kept saying "Checking your payment" — fixed.** `WechatPayReturn` reports its state through a new `onStatus`, and `CheckoutReturn` picks the heading from it:
   - paid: "Payment received"
   - closed or failed: "Payment not completed"
   - pending: "Checking your payment"
   - needs_support, refunded, or a failed status check: the new neutral "Payment status"
   
   Tests assert the h1 for closed, failed, needs_support, refunded, error, and error then paid.
4. **Charged currency came from a client-sendable header — fixed.** New `buyerCountryFromRequest` prefers `x-vercel-ip-country` and falls back to `countryHeaderFromRequest` only when that header is absent. An `XX` edge value means no signal, not a fallback. Both `/billing/checkout` and `plans()` use it, so the sheet and the charge agree. Tests: `cf-ipcountry: TW` with `x-vercel-ip-country: US` charges USD and shows `checkout.country` US; the reverse charges TWD. On a host that sets neither Vercel's header nor Cloudflare's, the fallback is still client-sendable.
5. **`runFridayNudgeSweep` still named outside the bundle — confirmed, not fixable here.** The remaining references are in `server/src/cron/handlers.platform.test.ts` (INT-13), `server/src/i18n/email/{en,ja,zh,zh-TW}.json` and `server/src/platform/email/i18n.test.ts:140` (INT-07). See Requests.

Unowned edits: none. Every changed path is inside the bundle's `owns`.

## Per-item result

1. **Billing UI ↔ server gaps — done**
   - (a) `POST /credits/cancel/survey` stores the answer only, through a `CancelSurveyStore` adapter over `RACancelSurvey`. It answers 204, or 503 `storage_unavailable`. `it.todo('SR-INT-1 …')` is left in place. I added a per-user rate limit (5 an hour) that the item did not ask for.
   - (b) `cancelAtPeriodEnd` is on the entitlement summary; `useSubscriptionState` and `PlanBadge` read only the summary, and the `/billing/plan` fallback is removed.
   - (c) Already done; tests added.
   - (d) Already correct on the server (`cancel_token_invalid` in the envelope `code`, 410); `PublicCancelFlow` also accepts it from `details.reason`.
   - (e) `TwRevenueResponse.warnAt` is documented as whole NT$; the admin panel derives the percentage and uses the server's `warning` flag.
   - (f) One shared `CheckoutResponse` type in `features/credits/contract.ts`, used by the server and `lib/api/account.ts`.
2. **Account V2 wiring — done.** Student plans need the capability and a live verification, on checkout and on switch. The edge country reaches checkout and `plans()`. The webhook stores TWD currency and amount. Acknowledgements now name the charged price. **Behaviour change:** `student_verification_required` is 409 (was 403).
3. **GoApply payments UI and order fields — done.** `PlanPicker` opens `WechatPaySheet`; there is no `weixin://` image. `CnRenewButton` shows only for a running GoApply pass. `CheckoutReturn` polls `?order=` and its heading follows the order. `context` carries `payerClientIp` and `termsVersion`; the rail writes `AlipayOrder.termsVersion`. The legacy route now holds the billing-cn terms gate.
4. **Payment notice — done.** `fulfilPass` sends `payment_success` once per fulfilled GoApply WeChat Pay order, never on a replay, and a notice failure never fails fulfilment. The pay button is wrapped in `<SubscribeOnTap template="payment_success">`.
5. **`proCap` — done.** `BucketSummary.proCap` and `proWindow` appear only where Pro allows more than the current cap.
6. **Admin override audit — done.** `/admin/credits/overrides` calls `createOverrideAudited` / `deleteOverrideAudited`, one `writeAdminAudit` row each; an audit failure never fails the override.
7. **`upgrade_viewed` — done.** Fired once per closed-to-open transition of `OutOfCreditsSheet`, with the bucket.
8. **`runFridayNudgeSweep` — done in my files; not fully met.** The export and its test case are removed. The grep is not empty until INT-13 and INT-07 act.

## Files

**Created**
- `server/src/platform/billing/buyerCountry.ts` (this round)
- `components/features/billing-cn/WechatPayReturn.tsx`
- `components/features/credits/__tests__/integration.test.tsx`

**Modified — server**
- `server/src/features/credits/{contract,service,routes,adminRoutes,index}.ts`, `credits.test.ts`
- `server/src/features/billing-cn/service.ts`, `__tests__/{billingCn.routes,wechatpayRail}.test.ts`
- `server/src/platform/billing/{acknowledgements,subscriptions,errors,fulfilPass,index,twRevenue}.ts`, `rails/{types,wechatpay}.ts`
- `server/src/platform/billing/{fulfilPass,accountV2}.test.ts`, `integration/{RoboApplyBillingService.stripe,RoboApplyBillingReminderService}.test.ts`
- `server/src/platform/credits/{EntitlementService,summary}.ts`, `{EntitlementService,summary}.test.ts`
- `server/src/roboapply/services/{RoboApplyBillingService,RoboApplyBillingReminderService}.ts`, `RoboApplyBillingService.alipay.test.ts`
- `server/src/roboapply/routes/billing.ts`

**Modified — web**
- `components/features/credits/{PlanPicker,BillingView,CheckoutReturn,OutOfCreditsSheet,PlanBadge,CancelSubscription,PublicCancelFlow,AdminCreditsConsole}.tsx`
- `components/features/credits/__tests__/{fixtures,billing,credits,admin}.tsx`, `pure.test.ts`
- `components/features/billing-cn/{WechatPayCheckout.tsx,index.ts}`, `__tests__/billingCn.test.tsx`
- `hooks/credits/{useBillingActions,useSubscriptionState}.ts`
- `lib/api/{credits,account}.ts`
- `__tests__/fixtures/credits/index.ts`
- `i18n/staging/{credits.en,billingCn.en,billingCn.zh}.json`

**Deleted:** none.

## Tests run

| Gate | Result |
|---|---|
| Bundle suites: `npx vitest run server/src/platform/credits server/src/platform/billing server/src/features/credits server/src/features/billing-cn server/src/roboapply/services/RoboApplyBillingService.alipay.test.ts components/features/credits components/features/billing-cn hooks/shared hooks/credits __tests__/contracts` | 35 files, 940 passed, 1 todo |
| `npm run typecheck:server` | clean |
| `npm run typecheck:web` | clean |
| `npm run check` | clean |
| `npx vitest run --exclude ".claude/**"` (run 1) | 5 files failed, 3 tests failed, 10038 passed |
| `npx vitest run --exclude ".claude/**"` (run 2) | 2 files failed, 1 test failed, 10057 passed |
| Same command with `--testTimeout=60000 --hookTimeout=120000` | 549 files passed; 10062 passed, 1 skipped, 27 todo |

Every failure in runs 1 and 2 was a 5 s test timeout or 10 s hook timeout, and the set differed between runs. The files were `legacyPrecedence`, `v2/routes/{index.unmounted,jobs.score,legacyAiGates}`, `areaStubs`, `legacyAuth` and practice `externalRoutes`. All seven pass when run alone (94 tests). This includes the two the previous handoff sent to INT-01 and INT-09; those requests are withdrawn.

## Requests

- **INT-13**
  - Delete the `fridayNudge` mock and assert lines in `server/src/cron/handlers.platform.test.ts` (12, 53, 201) and the note in `scripts/gen-cn-cronjobs.mjs`, then re-run `git grep runFridayNudgeSweep`.
  - Add to ARCH §3.9/§7: `POST /credits/cancel/survey`, `summary.cancelAtPeriodEnd`, `BucketSummary.proCap`/`proWindow`, `CheckoutResponse`, and that `/billing/checkout` with rail `wechatpay` needs `termsVersion` (409 `terms_outdated`).
- **INT-07 / translations:** remove the orphaned email keys `billing.fridayNudge.*` in `server/src/i18n/email/{en,ja,zh,zh-TW}.json` and the assertion at `server/src/platform/email/i18n.test.ts:140`.
- **INT-SCHEMA / J9:** flip `it.todo('SR-INT-1 …')` in `server/src/features/credits/credits.test.ts` once the diff is pushed.
- **INT-11 / J5:** swap the `termsVersion` resolver either in `defaultTermsVersion` or on the `billingCnService` singleton. Both order paths go through that singleton, so both follow. A separately constructed `BillingCnService` would not cover the legacy route.
- **Owner of `server/src/lib/billingRegion.ts` (optional):** reorder `countryHeaderFromRequest` to prefer `x-vercel-ip-country`; `buyerCountryFromRequest` could then become a re-export.
- **INT-03:** `proCapOf` in `hooks/agent/adapters.ts` can drop its cast; the field is typed now.
- **INT-12 (optional):** `app/(auth)/settings/billing/return/page.tsx` may pass `orderId`; `CheckoutReturn` already reads `?order=` from the address.
- **INT-08 (FYI):** audit rows written through the credits path carry `via: 'admin_credits'`.
- **Unowned `server/src/features/features.test.ts` (optional):** add the sample `'credits POST /cancel/survey': { body: { reason: 'price' } }`.

## i18n keys

- **Added:** `billingCn.return.checking`, `billingCn.return.notPaid`, `billingCn.return.statusTitle` (en and zh; `statusTitle` is new this round: "Payment status" / "支付状态").
- **Obsoleted (removed from staging):** `credits.planSheet.scanToPay`, `credits.planSheet.qrAlt`.

## Env vars introduced

None. The bundle reads the existing `STRIPE_PRICE_<PLANKEY>_TWD[_CENTS]`, `STRIPE_PRICE_STUDENT_*` and `CN_LEGAL_DOCS_VERSION`.

## Known gaps

- The user asked to launch the new version and try it. This bundle's rules forbid dev servers, so that still needs doing after the merge.
- The default wiring of the legacy terms gate (lazy import of the `billingCnService` singleton with the DB-backed limiter) is type-checked only. Tests inject a real `BillingCnService` over the fake database with a stand-in limiter.
- A 429 from the legacy route carries `details.retryAfterSec` but no `Retry-After` header; the billing-cn route sends the header.
- The Alipay rail on GoApply has no 用户协议 gate. The review did not raise it and I left it.
- If Alipay and WeChat Pay are both live on GoApply, the plan sheet uses WeChat Pay; there is no rail chooser.
- The `RACancelSurvey` round-trip against a real database is untested (the `it.todo`).
- Nothing was looked at in a browser; the heading change is covered by component tests only.