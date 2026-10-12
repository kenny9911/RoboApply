# MKT-1B

Pricing page and plan sheet from the plans API, refund lines, free autofill 20 a day, checkout attempt key (web). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1B`, branch `wp/MKT-1B`, base `54fa08d`. Nothing committed, pushed, stashed or reset. No schema change, no new dependency, no dev server, no browser, no call to Stripe or any other provider (every test stubs `fetch` or mocks `lib/api`).

All five items are done, plus the web half of carry-over item 9. Every gate is green: the tests I wrote or touched (13 files, 334 tests), both typechecks, `npm run check`, and the whole suite (648 files, 14,365 passed, 0 failed).

Read first:
- **In this worktree alone `/pricing` prints no refund lines.** Their numbers come from `refundPolicy` on `GET /billing/plans`, which MKT-1A adds in parallel; the page hides the refund column while the field is absent (as the item says) and shows it once the server sends it. Check it on the merged tree.
- **RoboApply's USD defaults are MKT-1A's code.** My fixtures state the §4.1 amounts through the override variables (`STRIPE_PRICE_<KEY>_CENTS`, with a pin, a test key and a webhook secret), so they mean "these amounts, on sale" before and after MKT-1A merges.
- **One deliberate change to a PAR-6 rule** (item 4, below): a plan row that is off sale now always says "Not available yet", also when payments are closed altogether. That adds the tag to GoApply's rows under the kill switch. I rewrote the one test that pinned the opposite.
- **Three new test files; two are outside the literal `owns` list but inside the rule** ("new files inside owned directories and tests colocated with owned files"): `hooks/credits/useBillingActions.test.tsx` and `lib/api/account.test.ts`.

## Items

### 1. [P1] Free autofill 20 a day on both brands (PC-3): done
- `server/src/platform/credits/catalog.ts`: `autofill` Free cap `day(5)` → `day(20)`. One default serves both brands (PAR-6 did not split the table). Pro stays 100. Nothing else changed; GoApply free tailor is still 3, RoboApply 2.
- Tests (`catalog.test.ts`, 22): the §6.2 table row is `[20, 100, 'day']`; a case per brand; every other free cap of strategy §3 unchanged; an override of `autofill` to 5 wins for that brand only (parsed override, and through the `credits.catalog.v1` loader).
- `/pricing` shows "20 a day" / "Up to 100 a day" in the Form fills row on both brands with no change in the page, and prints an overridden cap (`pricingPage.test.tsx`).
- Copy search: no string in `i18n/staging/*.json`, `i18n/messages/en.json` or `extension/src/i18n` prints a 5 next to autofill. One other literal, not mine: `__tests__/fixtures/credits/index.ts:34` (`autofill: day(5, 0)`, a shared fixture; no test depends on it). See Requests.

### 2. [P0] /pricing shows every amount and label from GET /billing/plans (PC-4): done
- `PricingPage.tsx` `PlanCard`: the `notSet` branch is gone; a plan with no amount is not rendered. Price, "Save N%", the weekly monthly-equivalent and the student percentage come from `displayPrice(plan, monthly)`, the function the plan sheet uses, so both read "About $43 a month" (the server's 4,329 cents is never printed). A real TWD price prints with "Charged in New Taiwan dollars." and no reference line, as on the sheet.
- Same-price line under the 7-day pass, computed by the new `samePriceAsWeeklyBilling` in `lib/pricing.ts` (equal amount and currency, as shown to this buyer); shared with the plan sheet.
- GoApply cards: `billingCn.pricing.passNote` with `{days}` from `passDays` (zh: `{days} 天会员。一次性付款 · 到期不自动续费`), and `billingCn.pricing.practicePerMonth` when `practice.per === 'month'` (季卡).
- "Not open yet" still follows `paymentsOpen` only.
- `lib/pricing.ts`: `PLAN_PRICES_MINOR`, `planPriceMinor` and `PlanKey` removed; header rewritten.
- Beyond the item, same rule: `displayPrice` rounds a Taiwan price's monthly equivalent to a whole amount too; the pack note prints only when the API states `validMonths` (the `?? 12` fallback is gone, here and on the sheet); the pass note needs a stated `passDays` (no "0 days").
- Tests: new `pricingPage.test.tsx` (27): both brands at the §4 amounts and labels, labels follow changed amounts, same-price line on and off, student rows 30 / 30 and 25 / 30, a plan without an amount left out, "Price not set yet" nowhere, closed state per brand, Taiwan line fresh / stale / other country / real TWD price, and a scan that no staged pricing string holds a digit, a currency symbol, a percent sign or a brand name. `pages.test.tsx`: only the pricing cases with old copy. `__tests__/lib/pricing.test.ts` (16): table cases dropped, a source scan that no price table comes back, `$43` for 999 a week, 26 / 19 / 15, the same-price rule, a RoboApply §4.1 block.
- ACCEPT grep (currency symbol + digit in `components/ app/ lib/ hooks/`, tests excluded): only comments, regex replacements (`'$1'`) and stub job postings in `lib/fixtures` / `lib/mockInterview`. No plan amount.

### 3. [P0] Refund and renewal rules on /pricing (PC-4): done
- New `RefundRules` in `PricingPage.tsx`. RoboApply: four lines `credits.pricing.refund.{first,renewal,packs,withdrawal}`; line 4 names the EU, the EEA, the UK and Taiwan. GoApply: `billingCn.pricing.refund.{first,packs,oneTime,entity}`; `oneTime` lists the day counts of the passes the API sends; `entity` renders only when `checkout.collectingEntity` is a non-empty string. Every number is an ICU argument.
- The facts are read by `plansBillingFacts(view)` in `lib/api/account.ts` (types by hand from the contract). A missing or malformed `refundPolicy` (any of the six numbers not a positive integer) is "not stated": the column is hidden, never half-filled.
- Renewal column unchanged (`renew1`, `renew2`, cancel link; `cnPasses` on GoApply). No competitor named.
- Tests: lines per brand, numbers changed in the fixture change the page, singular forms, hidden without the field, six malformed shapes, entity present / null / blank / key missing, zh source text has the same arguments as English and carries 一次性付款 · 到期不自动续费 and 收款主体：{entity}.

### 4. [P1] Plan sheet and billing view (PC-4): done
- `PlanPicker.tsx`: GoApply pass line from `billingCn.pricing.passNote`; the same-price line; closed state.
- **Closed state, the one judgement call.** The item says every option shows "Not available yet" when RoboApply's rail is not ready; PAR-6 showed the tag only while other plans could still be bought. I made it one rule for both brands: a row that is off sale says so; the sheet-level note still appears once. GoApply without its credential is unchanged (its rows stay on sale: note only). GoApply under the kill switch now shows the tag on each row as well. The plan documents do not settle this; if the owner prefers PAR-6's "said once", it is one condition (`&& paymentsOpen`) in `renderOption`.
- `OutOfCreditsSheet.tsx`, `labels.ts`: no branch treated a RoboApply plan as unpriced; comments only. The one such branch was in `hooks/credits/usePlans.ts` `visiblePlans` (`unsellableReason === 'price_unset'`), now removed: a plan with no amount is left out, on any brand.
- `fixtures.tsx`: defaults are the §4 catalog (999 / 2499 / 5499 / 999 / 999 / 2499, student 1749 / 3799; GoApply from the server defaults). The default response also carries `refundPolicy` (the server's own constants from `refunds.ts`) and `checkout.collectingEntity: null`, built through `checkoutOf(...)` and a cast so the file type-checks whether MKT-1A makes the fields required or optional. New helpers: `unpricedPlansView`, `railNotReadyPlansView`, `studentPlansView`, `withBillingFacts`, `withoutBillingFacts`. Free autofill in `creditsResponse` is 20.
- Tests: `billing.test.tsx` (42), `integration.test.tsx` (50), `pure.test.ts` (39), `credits.test.tsx` (34), `accountV2.test.tsx` (15): §4 amounts per brand, monthly preselected and weekly never, RoboApply rail not ready, no "price not set" wording, out-of-credits sheet in the closed state, Taiwan line on the sheet (fresh with source and date, stale, outside Taiwan, real TWD price).

### 5. [P0] One checkout attempt = one Idempotency-Key (ST-2 web half): done
- `lib/api/account.ts`: `checkoutPlan(body, opts)` and `alipayCheckoutPlan(body, opts)` send `Idempotency-Key` when `opts.attemptKey` matches `/^[A-Za-z0-9_-]{8,64}$/` (otherwise no header, so the server uses its bucket).
- `hooks/credits/useBillingActions.ts`: `PlanCheckoutVars.attemptKey: string`; `newAttemptKey()` (`crypto.randomUUID`, with a `getRandomValues` fallback because `randomUUID` is absent outside a secure context); `useCheckoutAttempt()`.
- `PlanPicker.tsx`: key made at mount; renewed when the plan, either box or the chosen rail changes, and after a failed call; `keyFor(request)` also gives a new key if the request content differs from the last one sent (the return path carries the practice balance).
- Contract as written in MARKET_TASK_PLAN §3.1; nothing differs.
- Tests: `integration.test.tsx` (double click → one key; same request again → same key; remount → new; plan change → new, also back to the first plan; box → new; failure and the 502 `idempotency_conflict` answer → normal error line and a new key; Alipay carries it), `useBillingActions.test.tsx` (9), `account.test.ts` (9, header on the wire).

### Carry-over (wavePAR-carryover, Market waves, payments 8-12)
- **9, published student rule on GoApply /pricing: web half done.** `PricingPage` prints a "Student price" block from `studentOffer` when the response carries it and lists no student plan. The server field does not exist; see Requests (MKT-1A).
- **10, in-flight WeChat Pay order under the kill switch: left.** The fix is in `CheckoutReturn.tsx`, which MKT-2E reworks in M2 (ST-3 reconcile on return), and needs a server fact the web does not have (WeChat Pay set up but closed for new orders).
- 8, 11, 12: server and schema; not in my owns.

## Files changed
All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1B/`.
- Server: `server/src/platform/credits/catalog.ts`, `catalog.test.ts`
- Web: `components/features/marketing/PricingPage.tsx`; `components/features/credits/PlanPicker.tsx`, `OutOfCreditsSheet.tsx` (comment), `labels.ts` (comment); `hooks/credits/useBillingActions.ts`, `usePlans.ts`, `index.ts`; `lib/api/account.ts`; `lib/pricing.ts`
- Tests: new `components/features/marketing/__tests__/pricingPage.test.tsx`, new `hooks/credits/useBillingActions.test.tsx`, new `lib/api/account.test.ts`; `components/features/marketing/__tests__/pages.test.tsx`; `components/features/credits/__tests__/{fixtures.tsx,billing.test.tsx,integration.test.tsx,pure.test.ts,credits.test.tsx,accountV2.test.tsx}`; `__tests__/lib/pricing.test.ts`
- i18n staging: `i18n/staging/credits.en.json`, `credits.zh.json`, `billingCn.en.json`, `billingCn.zh.json`

## Tests run
| Command | Result |
|---|---|
| Owned tests: `npx vitest run server/src/platform/credits/catalog.test.ts __tests__/lib/pricing.test.ts components/features/credits components/features/marketing/__tests__/pricingPage.test.tsx components/features/marketing/__tests__/pages.test.tsx hooks/credits lib/api/account.test.ts` | 13 files, 334 passed |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` | 648 files passed; 14,365 passed, 1 skipped, 10 todo, 0 failed |
| `npx vitest run --exclude ".claude/**" -t "A[0-9]+ "` | 9 files, 55 passed; no billing server file is in my diff |
| `node scripts/i18n-merge-staging.mjs --dry-run` | valid; 685 new keys (671 before, 14 mine), 9 changed |

Not run, by the rules: `next build`, a dev server, a browser, the extension and interview-agent suites (not touched).

## Red tests for other bundles
None.

## Pre-existing failures
None.

## Requests

### MKT-1A
- **`studentOffer` on `GET /billing/plans`** (carry-over 9; `features/credits/service.ts` `plans()`, `contract.ts`). `studentOffer: Array<{ key: 'student_monthly' | 'student_quarterly'; amountMinor: number; studentDiscountPercent: number | null }> | null`: the brand's student plans with their catalog amounts while the `student` capability is on, sent when the caller is NOT sent the student plans themselves; `null` otherwise. The page already reads it and ignores it when absent. If it does not fit M1, MKT-2C owns those files in M2.
- **Seam check.** The web reads `refundPolicy.{firstPurchaseDays, shortPlanHours, paidOnlyCreditLimit, accidentalRenewalDays, withdrawalDays, packValidMonths, version}` and `checkout.collectingEntity`, exactly those names; each of the six numbers must be a positive integer or the refund column stays hidden.
- If you add the two fields as required members of `PlansResponse`, `components/features/billing-cn/__tests__/billingCn.test.tsx:72` (no M1 owner) builds a `checkout` literal without `collectingEntity` and will not type-check. My files are safe either way.

### Orchestrator
- Ownership check: allow `hooks/credits/useBillingActions.test.tsx` and `lib/api/account.test.ts`.
- After the M1 merge, on the merged tree: `npm run typecheck:web` and `npx vitest run components/features/marketing components/features/credits hooks/credits lib/api/account.test.ts __tests__/lib/pricing.test.ts`. Two things can only be seen there: RoboApply plans built from `RA_ENV` are `sellable` under MKT-1A's rail-ready rule (the fixture carries `STRIPE_SECRET_KEY: 'sk_test_x'` and `STRIPE_WEBHOOK_SECRET: 'whsec_test'` for that), and the mirrored `PlansResponse` type with the new fields.
- `components/features/marketing/Sections.tsx` (`PricingSummary`, no M1 owner) still prints `notSet` ("Price not set yet") on the home page for a plan with no amount, and `home.test.tsx` (about line 520) asserts it. For "appears nowhere" across the site: drop that branch and its assertion.
- `__tests__/fixtures/credits/index.ts:34`: `autofill: day(5, 0)` → `day(20, 0)`.
- Keys no component reads any more (remove from all nine bundles after the merge; grep first): `landing.pricingPage.refund1` to `refund4`, `landing.pricingPage.passRefund1`, `passRefund2`, `landing.pricingPage.notSet` (the home summary uses `landing.home.pricing.notSet` / `landing.cnHome.pricing.notSet`), besides `cnRefund` already on the list.
- Translation notes: the refund strings use ICU plurals on `{days}`, `{hours}`, `{months}`; `billingCn.pricing.refund.oneTime` takes `{days}` as an already formatted list ("7, 30, and 90"); keep 一次性付款 · 到期不自动续费 and 收款主体：{entity} verbatim in zh; no string may gain a digit, a percent sign or a currency symbol (a test scans the staging files).

### MKT-2E
- Carry-over 10 (above), when you rework `CheckoutReturn.tsx`.
- `useCheckoutAttempt` / `newAttemptKey` are exported from `hooks/credits` if the switch or resume calls need an attempt key.

### Owner / counsel
- The GoApply refund lines on `/pricing` are now printed (they were on the counsel list of the carry-over file); wording in `i18n/staging/billingCn.zh.json` under `pricing.refund`.
- The closed-state tag rule of item 4.

## Schema requests
None.

## Env variables added or redefined
None.

## i18n keys added or changed
All new; none changed or removed. English in `<ns>.en.json`.
- `credits.pricing.samePriceAsWeekly`
- `credits.pricing.refund.first`, `.renewal`, `.packs`, `.withdrawal`
- `credits.pricing.studentOffer.title`, `.row`, `.how` (zh also staged in `credits.zh.json`, since GoApply shows them)
- `billingCn.pricing.passNote`, `billingCn.pricing.practicePerMonth`
- `billingCn.pricing.refund.first`, `.packs`, `.oneTime`, `.entity` (all `billingCn.pricing.*` staged in zh too)

## Known gaps
- **Not seen in a browser.** Both brands, light and dark, 375 px and 1280 px still need the eye. No new CSS: the new lines reuse existing classes of `marketing.module.css` and `credits.module.css`. When the refund column is hidden, the renewal column sits alone in the two-column grid.
- **The student price block has no producer** until the `studentOffer` request is built; until then GoApply's public page states no student price.
- **A page restored from the back-forward cache keeps its attempt key.** A buyer who pays, presses Back and clicks Continue again on the restored sheet repeats the key, and Stripe answers the first session. A normal return or reload remounts the sheet and makes a new key.
- **The words "weekly billing and the week pass" in the first refund line are copy**, not derived from the plan list; the hours and days beside them are from the API.
- GoApply shows the new English until the staging merge (the runtime merges staged English only).
