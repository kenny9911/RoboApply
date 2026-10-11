# MKT-4C

Billing UI (web): "Withdraw from contract", the public cancel page with the withdrawal choice, the admin console for refunds, the mainland refund record, practice cost and Stripe health, and the invoice history with paging and the refunded marker. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4C`, branch `wp/MKT-4C`. Nothing committed. No server file, no `*.prisma`, no `i18n/messages/*` touched. No command reached Stripe, a database or the network. Not seen in a browser (rules).

This is the handoff after the independent review. All seven findings were real and are fixed; nothing was judged not done. The list is under "Review resolution" at the end.

**Gate state:** every test in my files is green (15 files, 628 tests); `npm run typecheck:server` and `npx next typegen && npm run typecheck:web` pass; `npm run check` passes; `npm run eval:match -- --enforce M2` exits 0; the full suite is green (732 files, 18,573 passed, 0 failed).

The server halves (MKT-4A, MKT-4B) were built in parallel. Every request and response type is written by hand from the contract text and read through a normaliser with a safe default. I compared my readers with the two sibling handoffs (`MKT-4A.md`, `MKT-4B.md`) and, read only, with the sibling server code the review cites (`wp-MKT-4B/server/src/features/credits/adminBilling.ts`, `adminBillingTypes.ts`, `server/src/platform/billing/stripeRefunds.ts`). The seams agree as listed under Requests.

## Where item and documents disagreed (the documents won)

1. **A withdrawal is per purchase** (`waveM2-carryover.md` MKT-4C.2a, strategy 4.4 "as built"). The item's contract has one `purchase` / `quote` pair. The page lists every open purchase from `purchases: Array<{ purchase, quote }>` (what MKT-4A sends) and falls back to the pair.
2. **An admin refund carries an attempt key** (`waveM2-carryover.md` MKT-4C.2b, strategy 5.1 "as built"). The item's contract has none; the console sends `attemptKey` in the body.
3. **Namespace of the System panel strings.** The item says `admin.system.payments.*`. The System console reads `admin.console.system.*` and `waveM3-carryover.md` MKT-4C.1 says "beside `admin.console.system.providers.*`", so the keys are `admin.console.system.payments.*`.
4. **The owner's rule under the practice cost.** The item's sentence leaves out the target price; strategy 7 item 17 gives it ("reprice the 15-pack to $27.99"), so the copy has it.

## Items

### 1. [P0] "Withdraw from contract" on /settings/billing (ST-9 web): done

- `components/features/credits/WithdrawContract.tsx`, mounted by `BillingView` directly under the current plan card as its own section with its own heading. It is never inside the plan card or the cancel control.
- Who sees it is the server's answer (`GET /credits/withdrawal`): `available: false` renders nothing. GoApply never asks (no request is made). A quote whose `deadline` has passed on the device's clock is not offered. Nothing while the answer is out.
- One row per open purchase, the latest first: plan name, "Paid so far: {amount}. Bought on {date}.", "Refund if you withdraw now: {amount}.", "You can withdraw until {date and time}.", and the entry button. With several rows each button's accessible name adds the plan.
- Two steps. The entry opens the confirmation: "Withdraw from {plan}?", the refund amount, for a pro-rata quote "You asked us to start at once, so the refund covers the {unused} of {periodDays} days you have not used" (numbers from `quote.prorata`), the last day, and what ends at once. The button reads "Withdraw and refund {amount}". Nothing is sent before it is pressed. "Keep this purchase" closes the step.
- **The amount to confirm is never an old one (review finding 5).** A pro-rata refund is one day smaller every day and the server works the refund out when the withdrawal is sent. So:
  - a quote that has been on screen longer than `WITHDRAWAL_STALE_MS` (60 s) is read again when the entry is pressed. The entry waits (disabled, `aria-busy`, "Checking the refund amount…") and the step opens with that answer;
  - if that answer no longer lists the purchase, no step stays open and the page says "This purchase can no longer be withdrawn";
  - if that read fails, no step opens with the old figure: the row says "We couldn't check the refund amount just now. Try again." and the entry asks again;
  - while a step is open the quote is read again every 5 minutes (`WITHDRAWAL_OPEN_STEP_REFRESH_MS`; only while a step is open, never in a hidden tab), and the step shows the new figures;
  - a tab that comes back into view reads a quote older than 60 s again (this one query only; the app default stays off), so the row's amount is today's as well;
  - a quote read again while a step is open that no longer lists the purchase closes the step with "can no longer be withdrawn" and moves focus to the heading, instead of an empty section.
- What ends is worded by the kind of purchase (`withdrawalKind`: the catalog's `kind`, a pack by its key, else a neutral line): a subscription says "Your subscription ends at once and Pro stops right away"; a pass and a pack say what they end; an unknown plan never claims Pro stops.
- After `withdrawn`: the refunded amount from the server's answer, "A confirmation email is on its way", and the plan is read again. Because access ends when Stripe's `customer.subscription.deleted` is processed (MKT-4A request 2), the plan is read again at once and after 3 s and 10 s (`WITHDRAW_REREAD_DELAYS_MS`).
- Refusals: 409 `withdrawal_not_available` (also with `details.reason: 'refund_refused'`) closes the step, says "This purchase can no longer be withdrawn", reads the quote again and does not offer that purchase again on this page. 429, 503 and 502 keep the step open, each with its own sentence; the same button sends again.
- A check that failed is mentioned ("We couldn't check whether you can still withdraw from a recent purchase", with Try again) only when the visitor's country is in the withdrawal list. Elsewhere a failed check shows nothing.
- Focus follows the step: to its title when it opens, back to the entry when it closes, to the section heading once the purchase is gone.
- Hooks in `hooks/credits/useBillingActions.ts`: `useWithdrawalQuote({ enabled?, refreshEveryMs? })`, `useWithdraw`, `WITHDRAWAL_QUERY_KEY`, `WITHDRAWAL_STALE_MS`, `WITHDRAWAL_OPEN_STEP_REFRESH_MS`, `WITHDRAWAL_UNAVAILABLE_CODE`. `useRereadBilling` (exported) also re-reads the quote after every billing action, without any billing answer waiting for it.
- `lib/api/account.ts`: `accountApi.withdrawal()`, `accountApi.withdraw(purchaseId)`, `normaliseWithdrawal`, `normaliseWithdraw`.
- Counsel items in their own keys: `credits.withdraw.label` (heading and entry), `credits.withdraw.confirmButton`.
- Tests: `billing.test.tsx`, describe "BillingView: "Withdraw from contract" for 14 days after an eligible purchase" (37 tests; 7 new in "the amount to confirm is never an old one"): the visibility matrix, position on the page, both steps, the 25 of 30 sentence, the full-price quote, send-once, pending state, the delayed re-reads, 409 with and without a still-listed quote, the three other refusals, two purchases, pack and pass wording, an unknown plan, a TWD refund, focus, and the seven freshness cases above. `useBillingActions.test.tsx` (22), `lib/api/account.test.ts` (33).

### 2. [P0] Withdrawal on the public cancel page, and one country list (ST-9 web): done

- `PublicCancelFlow.tsx`: with a token the page asks `POST /public/cancel/preview` first and shows "Checking your link…" until it answers, so the two choices never appear under a button already pressed. With an open withdrawal it shows two labelled choices of equal weight: "Cancel at the end of the period" (sends exactly `{ token }`) and "Withdraw from contract and refund {amount}" with the last day (sends `{ token, withdraw: true }`). A pro-rata quote adds one sentence without day counts (the preview carries none).
- **The wait for the question is capped (review finding 6).** `usePreviewPublicCancel` gives up after `PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS` (8 s): the request is aborted and the page becomes the ordinary one-button page, as for any other failed question. An answer that arrives later is dropped, so nothing is swapped in under the button. `accountApi.previewPublicCancel(token, { signal })` hands the signal to the request; the body is `{ token }` as before.
- Answers: `withdrawn` shows the refunded amount the server answered; `not_available` (or no `withdrawal` in the answer) says the purchase can no longer be withdrawn and that the plan was cancelled at the end of the period instead.
- **A refused withdrawal is remembered for the page view (review finding 4).** After 409 `withdrawal_not_available` the page shows "This purchase can no longer be withdrawn" and the single "Cancel now" button, and stays that way while that cancel is sent and after it fails: the refusal is component state, no longer derived from the last call.
- Without a withdrawal, with an older server (404), on a rate limit, a network failure or the cap, the page is the single "Cancel now" button it was. A bad link (410 `cancel_token_invalid`) shows the existing expired message on the preview already.
- `hooks/credits/usePublicCancel.ts`: `usePreviewPublicCancel` (asked once per page view, never retried by itself), `PUBLIC_CANCEL_PREVIEW_TIMEOUT_MS`; `useConfirmPublicCancel` takes `{ token, withdraw? }`. The documented wrappers of `lib/api/credits.ts` are untouched.
- `lib/pricing.ts` `WITHDRAWAL_WAIVER_COUNTRIES` gains IS, LI and NO: 32 countries. `__tests__/lib/pricing.test.ts` imports the server's `WITHDRAWAL_COUNTRIES` and `showsWithdrawalWaiver` and fails when the lists differ in either direction.
- Counsel items in their own keys: `credits.cancelPage.withdrawChoiceTitle`, `credits.cancelPage.withdrawButton`.
- Tests: `cancelPage.test.tsx` (34; 4 new: the refusal that is never offered again while the cancel is pending or after it fails, the capped wait with the aborted request, the late answer that changes nothing, the answer inside the limit), `integration.test.tsx` (56), `pricing.test.ts` (23), `lib/api/account.test.ts` (the signal is passed, the body is unchanged).
- Rewritten in the first round because they called the old wrapper or the rule changed on purpose: "token link: one button cancels…", "expired or used token…", the two public-cancel cases of `integration.test.tsx`, the `BILLING_KEYS` list in `useBillingActions.test.tsx`, the TWD assertion of "a quarterly plan reads…" in `billing.test.tsx`. Changed in this round: "asks once with the token…" now expects the token and a signal.

### 3. [P0] Admin console: refund, refunds and disputes, CN refund record (ST-4, AL-7 web): done

- `components/features/credits/AdminBillingPanels.tsx` (`RefundsPanel`, `PracticeCostPanel`, `StripePanel`), rendered by `AdminCreditsConsole.tsx` after the four existing panels. `lib/api/adminBilling.ts` (plain `roboApi`, no import of `./contracts/`; a test pins that). Hooks in `hooks/credits/useAdminCredits.ts`.
- Refunds is keyed by a user id; nothing is asked before one is given, and another id starts every form from nothing. "Show" on the user already on screen reads the facts again and starts no form over.
  - (a) The refund quote as read-only facts: the charge sentence, paid through, billing country, start-now box, actions used, pack interviews used, days used, and the decision (can be refunded or not, rule and blocker codes as data, window end, amount).
  - (b) "Refund through Stripe": the latest charge of the quote when it is a card charge, or a typed `in_…` / `cs_…` id; an optional amount typed in major units and sent as whole minor units (read as text, never a float); a required reason; a confirm step that repeats user, charge, amount and reason. Nothing is sent before "Refund now". On success: the returned amount, "Access changes when Stripe confirms the refund", and whether anything is left on the charge.
  - **Attempt key (carry-over 2b, review finding 1).** One key per movement of money: this user, this charge, this amount (`useRefundAttempts`). It is kept until that movement is completed: across a retry, a reworded reason, and a detour through another amount and back. Only a completed refund ends it, so two equal partial refunds of one payment are still two refunds. The reason is sent but is not part of what the key names. This relies on what MKT-4B built: the same key with another reason is answered with the refund already made.
  - (c) The list: date, kind, amount with full or partial, access taken back or unchanged, reason, by, reference; "Show more" with the cursor. A dispute is flagged in its row and above the table, in words.
  - **The list can answer "check the list" (review finding 2).** A Stripe refund's row is written by Stripe's event after the call answers, so after a refund call settles (success or refusal) the list and the refund check are read again at once, after 3 s and after 10 s (`ADMIN_REFUND_REREAD_DELAYS_MS`); leaving the form with a read still due does it then. The list has its own "Refresh". A refresh that fails keeps the rows and says "What you see may be out of date"; a "Show more" that fails says so and can be pressed again.
  - (d) "Mainland orders": order number, plan, Alipay or WeChat Pay, amount, date. "Record refund" opens a form; the button is disabled until "The money was returned in the merchant console" is ticked and a reason is given; an optional smaller amount in yuan. After recording the row shows the marker and what happened to the access, and has no button. `already_recorded` is an answer, not an error, and shows what the first record did. A 500 never says "nothing changed".
  - **"Check the record" (review finding 7).** A full refund on record with no access taken back keeps an action on its row after the form is closed, the user is switched or the page is loaded again. It sends the same idempotent call with the reason on record and shows the `already_recorded` answer with what the record did. The page knows the state from the refunds list it already loaded (`cnReversalOpen`: kind `manual_cn`, `full`, `entitlementReversed: false`), or from an optional `reversalPending` on the order row (read with a safe default; see Requests). Never for a partial record. The call is offered only for an order that already has a full refund on record (the server's marker, or its own answer on this page), so it can never create a record.
  - Errors show their own sentence: 404, 409 `refund_not_available`, 503, 502 for the refund; 404, 409 `order_not_completed`, 422 for the record.
- The Stripe refund form is rendered on the international brand only (Stripe never serves GoApply). The quote, the list and the mainland orders are on both.
- Tests: `admin.test.tsx` (84; 19 more than before the review: 21 added, 2 replaced), `lib/api/adminBilling.test.ts` (26; 6 new), `hooks/credits/useAdminCredits.test.tsx` (new, 11).

### 4. [P1] Practice cost and Stripe health (PC-5, ST-3 web): done

- "Practice cost": per brand the average in US dollars (up to four decimals), "{n} (the latest {max} at most)" and the date range, or "Not enough sessions yet ({n} of {min})". The two sizes are the server's. A brand the server did not answer for is a dash. An average is shown only when the server gives one and says `enough`. Under it the owner's rule per brand as plain copy, and a line that nothing is converted.
- "Stripe" (international brand only): key mode, usable or not with the reason in plain words, the number of webhook secrets, rail ready or not, the endpoint address, the pinned plans, and the webhook endpoint in one of four states. The normaliser drops any value shaped like a key, a signing secret or a price id.
- **One reading of the endpoint for both panels (review finding 3).** `stripeEndpointState` in `lib/api/adminBilling.ts`: `no_endpoint` (the server's `reason: 'not_found'`, whatever `checked` says; it arrives with `checked: true` and all fourteen events listed), `unchecked`, `complete`, `missing`. "No endpoint" prints "No webhook endpoint in Stripe points at this site. Add one in Stripe." and the events a new endpoint needs, never "add them to the endpoint". An endpoint that could not be read prints the reason only when one is known; a usable key is never described as "no key" (`stripeUncheckedReason`).
- System panel: `components/v3/admin/SystemConsole.tsx` "Payments" after the providers panel, international brand only: one status line (ready, or not ready with the reason: no key, live key outside production, no webhook secret), one line about the endpoint (every event, how many are not sent, no endpoint at all, could not be checked), and a link to `/admin/credits#admin-stripe`. A failed read says "Card payments could not be checked" and the rest of the page is unaffected.
- Tests: `admin.test.tsx` (both panels in each state, with the server's real "no endpoint" shape), `console.test.tsx` (51; 2 new), `lib/api/adminBilling.test.ts` (the four states read from the server's own `checkStripeWebhookEndpoint` run against a fake client).

### 5. [P1] Billing history: paging, channel, refunded marker (ST-10 web): done

- `hooks/useAccount.ts` `useBillingHistory` is an infinite query; `lib/api/account.ts` `history(cursor?)` sends `?cursor=&limit=20` and reads through `normaliseHistory`. `BillingInvoice` gains the optional `channel` and `refunded`; `invoiceChannel` and `invoiceRefunded` read them with the defaults of the contract.
- `components/v3/account/billingHistory.tsx`: "Show more" while there is a next page; the method label from the channel (card, Alipay, WeChat Pay); "Refunded" / "Partly refunded" as its own chip beside the status; status chips for paid, open ("Pending", the existing key) and uncollectible ("Not paid"); any other status gets the neutral chip "Status not known", never "Failed". A next page that fails keeps the rows and says so; a repeated row is listed once. Each row keeps its own currency.
- Existing `settings.billing.history.*` keys are still read (title, empty, loading, error, download, paid, pending, card). New strings are under `credits.history.*`.
- Tests: `components/v3/account/__tests__/billingHistory.test.tsx` (14), `lib/api/account.test.ts`.

### Carry-over

| Entry | What I did |
|---|---|
| M1 MKT-4C.1 (the three members of `PlansResponse`) | Nothing left: every plans fixture carries them, and MKT-4A made them required. No new plans literal in my tests. |
| M2 MKT-4C.1 (mirror `WITHDRAWAL_COUNTRIES`) | Done (item 2). |
| M2 MKT-4C.2 (`/pricing` states the pro-rata rule) | Nothing to add, as the entry says. |
| M2 MKT-4C.2a (one row per open purchase) | Done. The row shows the total paid under the purchase; the contract carries no list of single charges (Known gaps). |
| M2 MKT-4C.2b (attempt key on the admin refund) | Done; after the review the key names the movement of money and is kept until it is completed (item 3). |
| M2 MKT-4C.3 (a TWD charge reads "$749") | Decided and done: an amount in a sentence with no currency note beside it names its currency when it is not the brand's. `formatChargedMoney` in `lib/pricing.ts` (`chargedMoney` in `labels.ts`): "NT$749" in English, the ISO code where the locale's symbol is the same sign ("TWD 749" for a `zh-TW` reader). Used by the checkout sentence, the resume sentence, every amount of the switch quote sheet, the withdrawal sheet, the public cancel page and the admin panels. A US dollar price on RoboApply and a yuan price on GoApply read exactly as before. Invoice rows keep `formatMoney`. |
| M2 MKT-4C.4 (`CheckoutReturn` gate change) | Kept; not touched. |
| M2 MKT-4C.5 (fixture uses the internal policy label) | Done: `refundPolicyFor` carries the public label (`publicPolicyLabel` in `fixtures.tsx`), with a test. |
| M2 MKT-4C.6 (no return after "confirm with your bank") | Left: no item touches it. |
| M2 MKT-4C.7, 8 | Nothing to do. No hand-written reader of a fit in my files. |
| M3 MKT-4C.1 to 5 | Keys added beside `admin.console.system.providers.*`; the limit rule is not restated; the staged `admin` keys of the M3 gate are kept (the staging diffs are additive only). |

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4C/`.

Edited:
- `lib/pricing.ts`, `__tests__/lib/pricing.test.ts`
- `lib/api/account.ts`, `lib/api/account.test.ts`
- `hooks/useAccount.ts`
- `hooks/credits/useBillingActions.ts`, `useBillingActions.test.tsx`, `usePublicCancel.ts`, `useAdminCredits.ts`, `index.ts`
- `components/features/credits/BillingView.tsx`, `PublicCancelFlow.tsx`, `AdminCreditsConsole.tsx`, `PlanPicker.tsx`, `ResumeSubscription.tsx`, `SwitchQuoteSheet.tsx`, `labels.ts`, `index.ts`
- `components/features/credits/__tests__/billing.test.tsx`, `cancelPage.test.tsx`, `admin.test.tsx`, `integration.test.tsx`, `accountV2.test.tsx`, `pure.test.ts`, `fixtures.tsx`
- `components/v3/account/billingHistory.tsx`
- `components/v3/admin/SystemConsole.tsx`, `components/v3/admin/__tests__/console.test.tsx`
- `i18n/staging/credits.en.json`, `credits.zh.json`, `admin.en.json`, `admin.zh.json` (the reviewer judged this last one acceptable: it is a staging file of the `admin` namespace this bundle owns, additions only)

New:
- `components/features/credits/WithdrawContract.tsx`
- `components/features/credits/AdminBillingPanels.tsx`
- `lib/api/adminBilling.ts`, `lib/api/adminBilling.test.ts`
- `components/v3/account/__tests__/billingHistory.test.tsx`
- `hooks/credits/useAdminCredits.test.tsx` (this round)

Touched in this round: `AdminBillingPanels.tsx`, `WithdrawContract.tsx`, `PublicCancelFlow.tsx`, `SystemConsole.tsx`, `hooks/credits/useAdminCredits.ts`, `useBillingActions.ts`, `usePublicCancel.ts`, `index.ts`, `lib/api/adminBilling.ts`, `lib/api/account.ts`, the four staging files except `credits.zh.json`, and the tests `admin.test.tsx`, `billing.test.tsx`, `cancelPage.test.tsx`, `console.test.tsx`, `lib/api/adminBilling.test.ts`, `lib/api/account.test.ts`, `hooks/credits/useAdminCredits.test.tsx`.

Removed from the worktree: `.vitest/` (see Review resolution, unowned edits). Written outside the worktree: this handoff only. No new CSS, no new dependency. `i18n/staging/billingCn.*` is unchanged.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run hooks/credits components/features/credits lib/api/account.test.ts lib/api/adminBilling.test.ts __tests__/lib/pricing.test.ts components/v3/admin components/v3/account` | 15 files, 628 passed (before the review: 14 files, 578; base: 12 files, 398). Per file: `billing.test.tsx` 151, `admin.test.tsx` 84, `integration.test.tsx` 56, `pure.test.ts` 56, `console.test.tsx` 51, `cancelPage.test.tsx` 34, `credits.test.tsx` 34, `account.test.ts` 33, `adminBilling.test.ts` 26, `pricing.test.ts` 23, `useBillingActions.test.tsx` 22, `sources.test.tsx` 17, `accountV2.test.tsx` 16, `billingHistory.test.tsx` 14, `useAdminCredits.test.tsx` 11 |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 732 files passed; 18,573 passed, 1 skipped, 10 todo, 0 failed (base 729 files, 18,343) |
| `npx vitest run --exclude ".claude/**" -t "A[0-9]+ "` | 10 files, 56 passed; no server file is in my diff |
| `node scripts/i18n-merge-staging.mjs --dry-run` | valid, exit 0 |

Mutations in this round, each made in the source and run against the new tests, the file restored afterwards: 31, of which 30 were caught. Caught: the key includes the reason again; the key ignores the amount; one current key instead of one per movement; a completed refund clears every key; a completed refund keeps its key; no delayed re-reads; a due re-read dropped on leaving; "Show" on the same user does nothing; Refresh does nothing; a failed next page is silent; a failed refresh is silent; `not_found` read only when unchecked; a usable key called "no key"; the refusal not remembered on the link; an old quote opens the step at once; a failed re-read opens the step anyway; a fresh quote read again anyway; no cap on the preview wait; the cap does not abort the request; the signal not passed; no "Check the record"; the action also on a partial record; the open-reversal rule ignoring `entitlementReversed`; a made-up reason sent instead of the one on record; a lost step vanishing silently; no read when the tab comes back; no timer while a step is open; a timer without a step. The one that survived was an equivalent duplicate (the entry handler said "gone" itself and the step rule said it again): I removed the duplicate, so one rule is left. The 39 mutations of the first round were not run again; the tests they were run against still pass, except the one test this round replaced on purpose (finding 1).

Not run, by the rules: `next build`, a dev server, a browser, the extension and interview-agent suites (not touched).

## Red tests for other bundles

None.

## Pre-existing failures

None.

## Requests

### MKT-4A (seam; nothing to change if built as its handoff says)
- `GET /credits/withdrawal`: the web reads `available`, then `purchases[].{purchase,quote}` in order, each purchase once, and falls back to `purchase` / `quote`. An entry is kept only with a purchase `id`, whole `amountMinor` / `refundMinor` (0 allowed), three-letter currencies, a parseable `deadline` and one of the two rules. `prorata` is read only as whole days with `usedDays <= periodDays`.
- New in this round, for your information: the page reads that route more often. Besides the page view and every billing action: when the entry is pressed with a quote older than 60 s, when the tab comes back into view with a quote older than 60 s, and every 5 minutes while a confirmation step is open. Each is one invoice list at Stripe for an account with a customer. Say if the route needs a limit that these would meet.
- `POST /credits/withdrawal`: the body is exactly `{ purchaseId, confirm: true }`. Only `status: 'withdrawn'` is called a withdrawal. The four error codes are read from the envelope `code`.
- Public link: preview posts `{ token }`; an ordinary cancel posts exactly `{ token }` (never `withdraw: false`); a withdrawal posts `{ token, withdraw: true }`. The page aborts a preview after 8 s and then offers the ordinary cancel only. If the preview route can bound its own read at the payment provider below that (a short timeout on the invoice list, answering `withdrawal: null`), a slow provider would cost the visitor the withdrawal choice less often.

### MKT-4B (seam; one optional addition)
- `POST /admin/credits/refunds`: `attemptKey` is in the body, a version 4 UUID. One key per user, charge and amount, the same until that refund completes, also when the reason changes in between. This depends on `issueRefund` answering a repeated key with other parameters from `existingRefund` (as built). Please keep that path and its test.
- `amountMinor` is sent only as a positive whole number. `userId` and `reason` are trimmed.
- `GET /admin/credits/refunds`: the console always sends `userId`. A view of every user's disputes (which the route allows) is not built.
- `POST …/cn-orders/:orderId/refund`: the path carries the order's `id`; `refundedAmountMinor` is sent only when less than the order. **"Check the record" sends the same call for an order already recorded in full**, with `{ reason: <the reason on that record>, confirmMoneyReturned: true }` (or the fixed reason "Check of an earlier refund record" when the record's reason is not on the page). It relies on what you built: an existing record is never rewritten, and the reason of such a call goes only to the audit line of a finished reversal.
- **Optional, exact change:** in `adminBilling.ts` `cnOrders`, add `reversalPending: boolean` to each row: true when the order's `manual_cn` row is `full`, `entitlementReversed: false` and its note says the reversal failed (`NOTE_NOT_REVERSED`). Reason: the web then offers "Check the record" only for a record that really stopped half way, and also when that record is not in the first 50 rows of the refunds list. The web already reads the field (`normaliseCnOrders`, true only for the server's own `true`); without it the web uses the refunds list.
- `stripe-health`: the "no endpoint" answer (`checked: true`, `url: null`, all events, `reason: 'not_found'`) is read as its own state. `missingEvents` is read only when `checked` is true.

### Orchestrator
1. **`.vitest/` is not ignored.** `npx vitest run --reporter=json` writes `.vitest/json/output.json` into the repository root, and `.gitignore` does not list it. I moved the two reports my runs left out of the worktree (nothing of it is in the tree now). Please add `.vitest/` to `.gitignore` (not my file).
2. **Ownership:** allow the new files in owned directories (`WithdrawContract.tsx`, `AdminBillingPanels.tsx`, `lib/api/adminBilling.test.ts`, `components/v3/account/__tests__/billingHistory.test.tsx`, `hooks/credits/useAdminCredits.test.tsx`), the colocated tests (`lib/api/account.test.ts`, `hooks/credits/useBillingActions.test.tsx`, the tests and fixtures under `components/features/credits/__tests__/`) and `i18n/staging/admin.zh.json` (16 keys added, none changed; `components/v3/admin/__tests__/sources.test.tsx` fails when a staged English `admin` key has no Chinese twin).
3. **Two changed English strings in `admin.console.refund`** (`sub`, `issueElsewhere`, read by `UserAdminPanels.tsx` `RefundQuotePanel`): they said refunds are issued in the payment provider, which stops being true with this bundle. They now point to Credits and plans. Optional, `components/v3/admin/UserAdminPanels.tsx` has no M4 owner: make that sentence a link to `/admin/credits`.
4. **After the M4 merge, on the merged tree:** the command of the first row of "Tests run", plus `__tests__/contracts`. Then one seam check per route against the real server code: the request bodies listed above, and the answers `{ available, purchase, quote, purchases }`, `{ status: 'withdrawn', refundMinor, currency }`, `{ planKey, accessUntil, withdrawal }`, `CancelResponse & { withdrawal? }`, `{ invoices, nextCursor }`, `{ refundId, amountMinor, currency, full }`, `{ items, cursor }`, `{ items }`, `{ status, orderId, entitlement }`, `{ brands }`, and the seven fields of `stripe-health`. Two seams are already pinned against server code in my tests: the withdrawal country list, and the endpoint check (`lib/api/adminBilling.test.ts` runs `checkStripeWebhookEndpoint` with a fake client).
5. **i18n pass (OT-2):** translate the new keys below. Keep the ICU plurals as they are (in the `admin` namespace every plural branch starts with `#`; `sources.test.tsx` compares placeholders with the Chinese twin). `credits.withdraw.label`, `credits.withdraw.confirmButton`, `credits.cancelPage.withdrawChoiceTitle` and `credits.cancelPage.withdrawButton` are counsel items per locale (Owner 13), the German ones first. `settings.billing.history.failed` is read by nothing now (grep first, then remove it from the nine bundles). Until the merge every non-English locale shows the new strings in English, except the 9 history keys and the 16 admin keys staged in Chinese.
6. **Documents with no owner after M3** (`waveM3-carryover.md`, "At the M4 gate"): `ALIPAY_CUTOVER.md` 4.3 g: the record is at `/admin/credits`, "Refunds", enter the user id, "Mainland orders", "Record refund"; if the record answers an error, the order's row then offers "Check the record", which finishes it. `STRIPE_TEST_RECIPE.md` 5.1 row 10a: same page, "Refund through Stripe" (the list below it refreshes by itself within ten seconds and has a Refresh button); row 11: `/settings/billing`, section "Withdraw from contract", and the cancel link's second choice; section 7: `/admin/credits#admin-stripe` and the "Payments" panel of `/admin/system`.
7. `MARKET_TASK_PLAN.md` 3.1, as built on the web: the System panel keys are `admin.console.system.payments.*`; the admin refund body carries `attemptKey`, one per user, charge and amount until that refund completes.

### Owner
1. Counsel (Owner 13): the four keys named above, and the sentence "You asked us to start at once, so the refund covers the {unused} of {periodDays} days you have not used".
2. Confirm or change: the Stripe pieces (refund form, Stripe panel, the Payments panel of the System view) are not shown on GoApply's admin; a failed withdrawal check is mentioned only to visitors in a withdrawal country; both choices on the cancel link have the same visual weight.
3. Confirm or change: an acknowledgement in another currency than the brand's names it ("NT$749"; "TWD 749" for a `zh-TW` reader). This is display only: the sentence the server stores is unchanged.
4. The owner's rule under the practice cost is copy (`credits.admin.practiceCost.rules.*`). If the limits or the target prices change, those two strings change.
5. Confirm or change the three waits of this round: the cancel link waits 8 s at most for its question before it shows the ordinary button (shorter means the button sooner, and the withdrawal choice lost more often on a slow start); a withdrawal quote counts as current for 60 s; an open confirmation step is refreshed every 5 minutes.
6. Look once at `/settings/billing`, `/cancel?token=…`, `/settings/billing/history`, `/admin/credits` and `/admin/system` on both brands, light and dark, at 375 px and 1280 px.

## Schema requests

None.

## Env variables added or redefined

None.

## i18n keys added or changed

English in `i18n/staging/credits.en.json` (220 new) and `i18n/staging/admin.en.json` (14 new, 2 changed):
- `credits.withdraw.*` (32): `label`, `entryLabel`, `intro`, `unknownPlan`, `paid`, `paidNoDate`, `refund`, `lastDay`, `confirmTitle`, `confirmRefund`, `prorata`, `ends.{subscription,pass,pack,other}`, `confirmButton`, `pending`, `back`, `done`, `doneNoAmount`, `ended.{subscription,pass,pack,other}`, `checkError`, `refreshing`, `refreshError`, `errors.{unavailable,rateLimited,notConfigured,provider,generic}`
- `credits.cancelPage.*` (16 new): `checking`, `choose`, `cancelChoiceTitle`, `cancelChoiceSub`, `cancelChoiceSubNoDate`, `cancelChoiceButton`, `withdrawChoiceTitle`, `withdrawChoiceSub`, `withdrawProrata`, `withdrawButton`, `withdrawing`, `withdrawn`, `withdrawnNoAmount`, `withdrawGone`, `cancelledInstead`, `cancelledInsteadNoDate`
- `credits.history.*` (9): `more`, `loadingMore`, `moreError`, `channel.{alipay,wechatpay}`, `refunded.{full,partial}`, `status.{uncollectible,unknown}`
- `credits.admin.refunds.*` (117): top level, `facts.*`, `stripe.*` (with `errors.*`), `list.*` (with `kinds.*`), `cn.*` (with `channels.*`, `refunded.*`, `entitlement.*`, `errors.*`)
- `credits.admin.practiceCost.*` (15), `credits.admin.stripe.*` (31)
- `admin.console.system.payments.*` (14): `title`, `sub`, `loading`, `ready`, `notReady`, `reason.{missing,live_key_outside_production,no_secret}`, `eventsAll`, `missingEvents`, `noEndpoint`, `notChecked`, `failed`, `link`
- Changed English: `admin.console.refund.sub`, `admin.console.refund.issueElsewhere`

Added in this round (13 in `credits`, 1 in `admin`): `credits.withdraw.refreshing`, `credits.withdraw.refreshError`; `credits.admin.refunds.list.{refresh,refreshLabel,refreshing,refreshError,moreError}`; `credits.admin.refunds.cn.{check,checkLabel,checking,checkHint}`; `credits.admin.stripe.{endpointNone,eventsNeeded}`; `admin.console.system.payments.noEndpoint`. Two keys I had staged in the first round changed name before any merge: `credits.admin.stripe.notCheckedReason.unknown` is now `notCheckedReason.no_key`, and `notCheckedReason.not_found` became `endpointNone` (with "Add one in Stripe."). Neither was ever in `i18n/messages/`.

Chinese: `i18n/staging/credits.zh.json` (the 9 `credits.history.*` keys, for GoApply's receipts) and `i18n/staging/admin.zh.json` (the 16 admin keys). No longer read: `settings.billing.history.failed`. No existing staged key of another bundle was removed or rewritten (the four staging diffs against HEAD are additions only).

## Known gaps

- **Not seen in a browser.** The layouts reuse classes of `credits.module.css` and `console.module.css` with design tokens only; the tables scroll sideways on a phone by design.
- **Contract only.** Until the server halves merge: the withdrawal quote answers 404 and the section stays hidden; the preview answers 404 and the cancel page is the single button; the admin panels show their load errors; the history sends `?limit=20` to a server that ignores it and shows no "Show more".
- **Refund attempt keys live with the mounted form.** Another user id or a reload starts with none, so a retry after that is a new key. The list is read again by then (at once, 3 s, 10 s, Refresh), which is what staff check first. The other side of the same rule: if the payment provider stored a failure for a key, the same amount on the same charge repeats that failure until the form is started over.
- **The amount on the cancel link can be up to 30 minutes old** (the life of the link), so a pro-rata refund asked for across midnight is one day smaller than the button said. The answer states what was really refunded. I left it: asking again there could swap the two choices under the visitor's finger.
- **After the 8 s cap the link's withdrawal choice is not offered on that page view.** The email link is still good and can be opened again; the signed-in page has the section.
- **"Check the record" is found through the refunds list** unless the server sends `reversalPending`: a record that is not in the rows loaded so far (the first 50, more with "Show more") gets no action. It also stays on a full refund where nothing was left to take back; pressing it then answers "No access was changed."
- **A quote older than 60 s costs one read before the step opens** (a short wait with "Checking the refund amount…"), and a failed read there means no step until it works.
- **The withdrawal row shows the total paid under a purchase, not each charge.** A weekly plan on day 10 reads "Paid so far: $19.98"; the contract has no list of charges. If one is wanted, MKT-4A's `purchase` needs it.
- **The cancel link shows no day counts** for a pro-rata refund (the preview carries the amount, the rule and the last day only).
- **A failed withdrawal check is silent** for a visitor whose country is unknown or outside the list (an EU buyer travelling, a VPN). The section appears when the next read works.
- **After a withdrawal the plan card can read Pro for a few seconds.** The page re-reads at once, after 3 s and after 10 s; beyond that it needs a reload.
- **A typed refund target has no known currency**, so the confirm step repeats the amount as typed, "in the currency of the charge". Amounts are two-decimal currencies only (USD, TWD as configured, CNY).
- **The refunds list needs a user id.** A list of every user's disputes is served by the route and not built here.
- **`zh-TW` with a TWD charge reads "TWD 749"**, because that locale prints TWD and USD with the same sign. The owner may prefer another form.
- **Invoice history amounts keep the short symbol** (each row in its own currency, unchanged), so a TWD invoice beside USD ones reads "$749" in English.
- **Timers, the tab coming back into view and the aborted request** are tested with fake timers, the query library's focus switch and a mocked call, not in a real browser.

## Review resolution

Not done items: none were reported.

Findings (all verified against the code first; none rejected):

1. **[medium] Reason-only edit made a new attempt key: fixed, and widened.** Confirmed in `wp-MKT-4B` `stripeRefunds.ts`: the reason is in the refund's metadata, so the same key with another reason is a conflict that `existingRefund` answers with the refund already made. The key now names the movement of money (user, charge, amount) and the reason is sent outside it, as the reviewer asked. While fixing it I found the same hole by another path: try 10.00, try 12.00, go back to 10.00, and the old code gave 10.00 a new key. `useRefundAttempts` keeps one key per movement until that movement completes, so a detour keeps every key. The old test "a retry after the request was changed is another decision too" is replaced by four: reworded reason keeps the key; another amount gets a new one; partial, "everything" and another charge are three decisions; a detour keeps the first key and only a completed refund ends it. Six hook tests for the keys in `useAdminCredits.test.tsx`.
2. **[low] The refunds list never showed the refund just made: fixed.** The list and the refund check are read again at once, after 3 s and after 10 s once the call settles, on success and on error. "Show" on the same user reads the facts again without starting a form over (so a retry keeps its key). The list has a Refresh button. A failed "Show more" and a failed refresh each say so.
3. **[low] The server's "no endpoint" shape was not handled: fixed.** `reason: 'not_found'` is its own state whatever `checked` says, read by one function for the Stripe panel and the System view. "No usable key" is said only when the key is not usable. The fixtures in `admin.test.tsx` and `console.test.tsx` now use the server's real shape, and `lib/api/adminBilling.test.ts` gets that shape from the server's own check.
4. **[low] A refused withdrawal was offered again on the cancel link: fixed.** The refusal is remembered in state. New test: after the 409, a pending and then failed "Cancel now" never shows the two choices.
5. **[low] The amount on "Withdraw and refund {amount}" could be days old: fixed on the signed-in page; left on the link, with the reason.** See item 1. I did not read again on every press: a quote younger than 60 s opens the step at once, an older one is read first. Added beyond the reviewer's fix: the read when the tab comes back, the 5-minute read while a step is open, and the rule that a step whose purchase is gone closes with its reason. The link page is unchanged (Known gaps): its staleness is bounded by 30 minutes and a re-read there risks swapping the choices under a pressed button.
6. **[low] The cancel button waited on a preview with no time limit: fixed.** 8 s cap, the request aborted, a late answer dropped. I chose 8 s rather than "a few" so that a cold start plus one read at the payment provider does not cost a buyer the withdrawal choice; it is one constant (Owner 5).
7. **[low] The "recorded, not reversed" recovery was lost once the form was closed: fixed.** "Check the record" on the order's row, from the refunds list already loaded, plus an optional `reversalPending` flag requested from MKT-4B and already read with a safe default.

Unowned edits:

- `.vitest/json/output.json`: removed from the worktree. I moved it to my scratch directory instead of deleting it. It came back once in this round, from my own `--reporter=json` run, and I moved that one out too; `git status` shows no `.vitest/` now. The cause is under Requests, orchestrator 1.
- `i18n/staging/admin.zh.json`, `lib/api/account.test.ts`, `lib/api/adminBilling.test.ts`: judged acceptable by the reviewer; kept. One Chinese twin was added for the new `noEndpoint` key.
- The handoff file: this one.
- New in this round and inside an owned directory: `hooks/credits/useAdminCredits.test.tsx`.
