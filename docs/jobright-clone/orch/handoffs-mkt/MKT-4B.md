# MKT-4B

Admin billing server: refund action, manual CN refund record, practice-cost readout, Stripe health; invoice history with paging and the refunded marker. Worktree `wp-MKT-4B`, branch `wp/MKT-4B`. Nothing committed. All five items done, plus the carry-over entries listed below. This is the handoff after the independent review: the three findings are fixed, the price check of carry-over M2.1 is now served, and the list at the end ("Review resolution") says what was done about each point.

Where an item and the plan documents disagreed, the documents won. The five places:

1. **Admin refund needs an attempt key.** The item's contract has no `attemptKey`. Strategy 5.1 ("the admin action must send one value per refund it confirms") and carry-over MKT-4B.2a require one. `POST /refunds` refuses a refund without it (422). MKT-4C's handoff says the console sends it.
2. **`purchasedAt` of a CN pass.** Carry-over MKT-4B.3 says `order.paidAt`. `AlipayOrder` has no such column; `completedAt` is the moment `fulfilPass` activated the order, so that is what is passed.
3. **A second CN record call.** The item says "not fresh: already_recorded and nothing else". A second click changes nothing. One exception, on purpose: when the call that recorded the refund could not reverse the entitlement (it failed, or it never came back), a later call finishes the reversal (the billing rule "replay-safe under their claims").
4. **Open invoices.** The history showed `amount_paid` for every invoice, which is 0 for an open one. An open or uncollectible invoice now shows what is due.
5. **The price check.** The item's `stripe-health` contract has seven fields and none for prices. `MARKET_TASK_PLAN.md` 3.1 ("Endpoint check", as built) and carry-over M2.1 name two checks and say neither is wired to a route yet (MKT-4B). Both are served now. The default answer is exactly the seven fields; `?prices=1` adds one optional field.

## Items

### 1. [P0] Admin refund action, audited; list of refunds and disputes (ST-4): done

- New `AdminBillingService` (`adminBilling.ts`) with injectable `db`, `getStripe`, `now`, `env`, `audit`, `invalidate`, the three engine functions, `checkWebhookEndpoint`, `checkPrices` and `practiceCostRows`. Shapes and zod schemas in `adminBillingTypes.ts`.
- `POST /api/v1/roboapply/admin/credits/refunds { userId, target: { invoiceId } | { checkoutSessionId }, amountMinor?, reason, attemptKey }` → `{ refundId, amountMinor, currency, full }`. It calls `issueRefund` with `actor` = the admin's user id and `kind: 'refund'`, then writes one audit row `billing.refund_issued` (`adminId`, `subjectUserId`, payload `{ refundId, target, amountMinor, currency, full, reason }`). No entitlement is changed: `charge.refunded` does that.
- **`attemptKey`**: body field, else a well-formed `Idempotency-Key` header; 8 to 64 of `A-Z a-z 0-9 _ -` (a UUID fits). Missing or malformed: 422 `invalid_request` before anything is read. Stripe key: `refund:<pi>:<amount|full>:<attemptKey>`.
- **One audit row per refund, and never a spent claim without its row.** A retry of the same dialog gets the same refund back from Stripe; the claim `billing:adminrefund:<refundId>` keeps the audit to one row. The claim and the row are ONE transaction (`auditRefundOnce`; the default audit writer is given the transaction client, so the row is inserted through it). A row that could not be stored (`writeAdminAudit` answers `log_only`) throws inside the transaction, so nothing is claimed and the next request for that refund writes the row. A process that stops between the two leaves nothing either. A transaction that cannot be opened at all never hides the row: the row is then written without a claim. The refund itself still answers 200: an audit row that cannot be written never fails the action.
- **A refused retry audits what an earlier request left unaudited** (`auditRefundsMadeEarlier`). When the first request reached Stripe and stopped before its audit row, and the retry arrives after `charge.refunded` recorded the money, the engine refuses the retry (409, reason `already_refunded` for a full refund, `amount_above_refundable` for a partial one). On those two reasons, and only when our rows say this admin refunded this payment, the refunds of the payment are read from Stripe (`refunds.list` through `getStripe`; a refund names who made it in `metadata.actor`), and each refund of this admin is audited under the same per-refund claim with `auditedLate: true` in the payload. A refund that has its row is never audited twice, another admin's or a Dashboard refund is never audited in this admin's name, and the answer stays the 409. A failed Stripe read is logged and the next retry tries again.
- Errors: 404 `not_found` (no such user), 409 `refund_not_available` (another customer's payment, a GoApply account with no Stripe call, nothing left), 422, 503 `rail_not_configured`, 502 `payment_provider_error`. A refusal writes no audit row for the request it refuses.
- `GET …/refunds?userId=&cursor=` → `{ items, cursor }`, newest first, 50 a page, the fifteen fields of the contract. `userId` is optional (without it: every user, so staff see all disputes). Cursor `<createdAt ISO>|<id>`; an unreadable one is 422.
- Tests (`adminBilling.test.ts`): one Stripe call with the key and one audit row; nothing but the claim written; partial amount; same dialog retried; second dialog of the same amount; concurrent pair; **an audit row that could not be stored leaves no claim and the same dialog sent again writes it; the row is written through the transaction that holds the claim; a claim that cannot be written never hides the row; the refused retry after the real `charge.refunded` handler recorded the refund (full, then partial with another admin's refund on the same payment); an audited refund gets no second row from a later refused attempt; no Stripe read when this admin refunded nothing on the payment; a failed Stripe read**; no key and header key; session target; another customer's invoice (409, no audit); 404 / GoApply 409 / 503 / 502; eight malformed bodies; non-admin 403 and anonymous 401 on all six routes; the list shows a dispute row written by the real `charge.dispute.created` handler; 62 rows page with none repeated or skipped.

### 2. [P0] Manual refund record for CN orders (AL-7): done

- `GET …/cn-orders?userId=` → `{ items: [{ id, outTradeNo, planKey, channel, amountMinor, completedAt, refunded }] }`: completed `ra_` orders, newest first.
- `POST …/cn-orders/:orderId/refund { reason, confirmMoneyReturned: true, refundedAmountMinor? }` → `{ status, orderId, entitlement }`.
  - 404 `not_found` (unknown, or a tier without `ra_`), 409 `order_not_completed`, 422 (no confirmation, empty reason, amount above the order).
  - One transaction claims `billing:refund:cn:<orderId>` and writes the `RABillingRefund` row: `rail` = the order's channel, `kind 'manual_cn'`, `externalRef 'order:<id>'`, `alipayOrderId`, amount, `full`, `actor` = admin id, `createdAt` = the service clock.
  - A full amount reverses with the engine's own functions: a pack through `reversePackGrant` (grant id `packGrantId(userId, 'order:<id>')`), a pass through `reversePassPeriod` (plan `passDays`, 30 for `ra_starter` / `ra_growth`, own claim `billing:reversal:cn:<orderId>`, `purchasedAt = completedAt`). The outcome is stored on the row (`entitlementReversed`, `note`), so a second call answers `already_recorded` with the same `entitlement`.
  - **Who reverses.** The call that recorded the order does. Another call runs the reversal only when that one failed (the row then says `entitlement: not_reversed`, so the next click finishes it at once) or has not come back for 30 seconds (`CN_REVERSAL_HANDOVER_MS`, measured on the service clock against the row's `createdAt`). A second call that arrives while the first is still at work is a double click: it answers `already_recorded` with `entitlement: 'none'`, changes nothing and writes no audit row.
  - Then entitlements are invalidated and one audit row `billing.cn_refund_recorded` is written: by the call that recorded the order, and by a later call only when it finished a reversal (`completesEarlierRecord: true`).
- **`AlipayOrder` is never written** (rule A8) and `fulfilPass.ts`, the rails and the callback are untouched: `git diff` shows no change there, and the A-tests pass unedited.
- `order_not_completed` is not in the shared billing error table (not my file): `AdminBillingError` in `adminBillingTypes.ts` carries it and the admin router maps it.
- Tests, with orders paid through the real `fulfilPass` and `grantPracticePack` and the real practice-credit service on the in-memory database: pass ended (plan Free, practice balance at the Free allotment, order row byte-identical); second click; stacked pass shortened by one length, then ended by the second refund; a pass from an earlier run takes nothing off the newer one; pack with 2 of 5 used (balance 3 → 0, grant 0); legacy `ra_starter`; partial amount (no access change); two concurrent requests (one record, one length off, one audit row); **a double click while the first request is held just before its reversal (the second answers `already_recorded` / `none` and touches nothing; the first then reverses and writes the one audit row); a request that never came back (nothing before 30 seconds, finished at 30 seconds with one audit row)**; failed reversal marked on the row and finished by the next call, both audited; WeChat Pay rail; recruiter order 404; pending and closed 409; eight bad bodies; the list with markers; the recorded order in the buyer's own `/billing/history` with the marker, still downloadable.

### 3. [P1] Average cost of the last 50 practice sessions per brand (PC-5): done

- `GET …/practice-cost` → `{ brands: { roboapply, goapply } }`, `PracticeCost` exactly as the contract. USD, four decimals. Under 10 sessions: `averageUsd: null`, `enough: false`. Read-only.
- **What I found at the writer** (`interview-engine/billing/sessionCost.ts` `writeMockInterviewLedger`): SKU `mock_interview`, exactly one row per finished session (it checks for an existing row first), `relatedEntityType 'interview_session'`, `relatedEntityId` = the session id, `platformCostUsd = round6(session.costUsd ?? 0)`, and in `metadata` the session's `sessionSource` plus `creditExempt: true` for a staff session. There is no session id in metadata; the reader still accepts `metadata.sessionId` as the item asks.
- Three reading rules follow from that, all mine (Owner 2):
  - a session whose cost sums to 0 is skipped, because the writer turns "no cost recorded" into 0;
  - a row whose `sessionSource` is not `roboapply` is skipped (recruiter and partner interviews use the same SKU; `roboapply` is candidate practice on both brands);
  - a `creditExempt` row is skipped (staff).
- Default reader: `usageDeductionLog.findMany` with `sku`, `platformCostUsd not null`, `user: { brand }`, newest first (`createdAt`, then `id`), 200 a page, at most five pages. **Pages are read by position, not by a number of rows to skip**: the next page is "the rows older than the last row read", so a session written between two reads cannot move the window. A usage row is also added once whatever a page hands back (a set of row ids).
- Tests: 60 sessions average the newest 50; 9 give no average and 10 do; null cost, zero cost, recruiter and staff rows not counted; rows of one session are one session; each brand from its own rows; reads past a first page with no metered session (the second read starts after the 200th row); **a session written while the readout is paging does not make an older row count twice; a row handed back twice is added once**; the default reader's query for both pages, never with `skip`; nothing written.

### 4. [P1] Stripe health for staff (ST-3): done

- `GET …/stripe-health` → the contract's seven fields. `keyMode`, `usable`, `refusedReason` from `stripeEnv.ts`; `webhookSecrets` is a count; `railReady = stripeRailReady(env)`; `endpoint` from `checkStripeWebhookEndpoint(stripe, { origin: RoboApply's canonical origin })`; `pinnedPlans` = plan keys with a USD or TWD pin that stands.
- **`GET …/stripe-health?prices=1`** adds `prices: { checked, pinsChecked, lookupKeysChecked, issues, reason? }` from `checkStripePrices(stripe, env)`: every pinned price against the catalog (`pin_not_found`, `pin_mismatch`, `pin_archived`) and every synced price that was archived or differs (`synced_archived`, `synced_mismatch`). An issue is `{ planKey, currency, problem, expected: { amountMinor, currency, recurring }, found: { amountMinor, currency, recurring, active } | null }`: plan and amounts, never the price id (the check knows it; the route copies field by field). It is opt-in because it reads one price per pin and one list per ten lookup keys; without the flag the answer has no `prices` key and no price is read. `prices=0`, `false` or nothing: off; another value: 422.
- With no usable key (none, or a live key outside production) no client is asked for and no call is made: `endpoint: { checked: false, url: null, missingEvents: [] }`, and with the flag `prices: { checked: false, pinsChecked: 0, lookupKeysChecked: 0, issues: [] }`.
- `endpoint.url` is the address only (origin and path): credentials, query and fragment of a registered URL are dropped.
- `server/src/features/admin` is not edited.
- Tests: test key and one secret (lists the two missing events); live key outside production (refused, zero Stripe calls), in production, with the override; no key; key without a secret; a rotation list counted; a restricted key; pinned plans by key, with a pin that does not stand left out; no `sk_`, `rk_`, `whsec_` or `price_` value in any body; only `webhookEndpoints.list` exists on the fake; **prices: not read unless asked for and 422 for a bad flag; a pin next to another amount and an archived synced price reported by plan and amount; a pin Stripe does not know, and no issue for healthy prices; a key that may not read prices, and no call without a usable key; only `prices.retrieve` and `prices.list` exist on the fake**.

### 5. [P1] Invoice history: paging, channel, refunded marker (ST-10): done

- `getBillingHistory(userId, { cursor?, limit? })` → `{ invoices, nextCursor }`; `GET /billing/history?cursor=&limit=` (1 to 50, default 20; outside that or an unreadable cursor: 422).
- Stripe invoices are read page by page (`starting_after`, up to five calls a request); `draft` and `void` are dropped; an invoice that names another customer is dropped whatever the list returns. CN orders are paged by `completedAt` then `id`.
- Cursor: base64url JSON `{ s, sDone, c, cDone }` as the item says. Each cursor moves only past the rows the page used.
- `channel` is sent only for a WeChat Pay order; `refunded` only on a refunded row, from one `RABillingRefund` query a page (`refundedMarkOf` in `adminBillingTypes.ts`, shared with the admin order list; a dispute or any `full` row is `full`). Both keys are omitted otherwise, never null.
- **The two A10 tests pass unedited**; an unrefunded Alipay row has exactly its eight keys.
- A Stripe list failure still returns the CN orders, and the next page asks Stripe again. If Stripe stays down the list ends (possibly with one empty last page) instead of offering "more" for ever.
- If the refund rows cannot be read, the history is served without markers and a warning is logged.
- Tests (`RoboApplyBillingService.history.test.ts`): statuses; row shapes; another customer; GoApply never asks Stripe; WeChat channel; markers (full, partial, dispute, last partial completes); the AL-7 marker; one marker query a page; 45 + 30 rows in pages of 20, 20, 20, 15; seven page sizes with drafts and voids in between; orders paid in the same instant; `starting_after` and no call once Stripe's side is done; Stripe down, down then up, down for good; the route's defaults and refusals. A mutation of the cursor rule fails ten of them.

### Carry-over (binding)

| Entry | Result |
|---|---|
| M1 MKT-4B.1 | Used as given (`claimBillingEvent`, with a transaction client too). No refund decision is stored or shown to a buyer here. |
| M2 .1 | **Done, both checks.** The endpoint check with the canonical origin (the seven fields), and `checkStripePrices` behind `?prices=1` (item 4). |
| M2 .2, .2a | Done (item 1). I send no mail; the webhook does. |
| M2 .3 | Done (item 2), with `completedAt` for `paidAt`. |
| M2 .4 | Done (item 5). |
| M2 .5 | Left by choice. The entry is optional ("if you want") and nothing in M4 needs the reconcile limit overridable. It needs a named entry in `platform/ratelimit/defaults.ts`, which has no owner: the exact two changes are under Requests, Orchestrator 7, to take or leave. |
| M2 .6, .7a | Kept; none of that code is touched. |
| M2 .7 | **Chosen: reset, narrowly.** A Stripe subscription that ends more than an hour before the end of its paid period (`ended_at` against the period end) puts the practice balance back on the Free allotment, unspent packs kept, once (claim `billing:subend:<sub>`; new dep `resetPracticeToFree`). That closes the withdrawal gap. A subscription that runs to its period end, or whose `ended_at` Stripe does not state, is unchanged. Tests: `RoboApplyBillingService.subscriptionEnd.test.ts` (8). Owner 1. |
| M2 .8 | Left. Every synced row has carried its amount since before the clone (`main` writes it too) and a cancellation fires a sync, so a live cancelled subscription without an amount needs a price with no unit amount, which we never create. The fix would add a Stripe call to `GET /billing/plan`. |

## Files changed

Modified:
- `server/src/features/credits/adminRoutes.ts`
- `server/src/roboapply/services/RoboApplyBillingService.ts` (history block; `BillingServiceDb` gains `rABillingRefund`; `resetPracticeToFree` dep and `resetPracticeWhenCutShort`; `handleAlipayCallback` untouched)
- `server/src/roboapply/routes/billing.ts` (`HistoryQuerySchema`, the `/history` handler, the header comment; the callback route untouched)

New:
- `server/src/features/credits/adminBilling.ts`
- `server/src/features/credits/adminBillingTypes.ts`
- `server/src/features/credits/adminBilling.test.ts`
- `server/src/platform/billing/integration/RoboApplyBillingService.history.test.ts`
- `server/src/roboapply/services/RoboApplyBillingService.subscriptionEnd.test.ts` (colocated with the owned service)

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4B/`. Changed in the review round: `adminBilling.ts`, `adminBillingTypes.ts`, `adminRoutes.ts` (the `prices` query flag) and `adminBilling.test.ts`. No path outside the owns list is touched (`git status` shows these eight files only). This handoff is at `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-4B.md`.

## Tests run

All in the worktree, after the last edit, one after the other.

| Command | Result |
|---|---|
| `npx vitest run server/src/features/credits/adminBilling.test.ts` | 55 passed (40 before the review round) |
| `npx vitest run server/src/platform/billing/integration/RoboApplyBillingService.history.test.ts` | 28 passed |
| `npx vitest run server/src/roboapply/services/RoboApplyBillingService.subscriptionEnd.test.ts` | 8 passed |
| `npx vitest run server/src/roboapply/routes/billing.test.ts` (the A-tests, unedited) | 21 passed |
| `npx vitest run server/src/platform/billing server/src/roboapply/routes server/src/roboapply/services server/src/features/credits server/src/features/features.test.ts server/src/features/admin` | 43 files, 1,758 passed, 1 todo |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 732 files passed; 18,434 passed, 1 skipped, 10 todo (base 729 / 18,343 plus my 3 files / 91 tests) |

The three new test files were also type-checked with a temporary tsconfig (the server typecheck excludes tests; the file is removed again): clean.

Mutations of the review-round code, each caught by the new tests: the reversal run by any call; the failure not marked on the row; no handover time; the audit failure not thrown inside the transaction; the audit row written outside the transaction; the refused retry not looked at; the late audit under a claim of its own; any actor's refund audited; no set of counted rows; no cursor between pages; `prices` always sent; the price id copied into an issue.

## Red tests for other bundles

None.

## Pre-existing failures

None in this round's full run. (In the first round `server/src/features/jobs/import/directFetch.test.ts`, a wall-clock assertion, failed once while a typecheck ran beside the suite; it passes alone and passed in every run since. Not caused by this bundle.)

## Requests

**MKT-4C**
1. `POST /admin/credits/refunds` must carry `attemptKey` in the body (or the `Idempotency-Key` header): one value per refund dialog, the same on a retry, 8 to 64 of `A-Z a-z 0-9 _ -`. Without it the answer is 422 `invalid_request` with `details.issues[0].path = ['attemptKey']`. Unknown body fields are ignored. (Your handoff says the console sends a UUID and keeps it across a retry: that is what the late audit above relies on.)
2. `GET /admin/credits/refunds`: `userId` is optional; an unreadable `cursor` is 422.
3. `already_recorded` carries the `entitlement` of the first record. A 500 on the first record call means "recorded, not reversed": calling again finishes it at once and answers `already_recorded` with what it did. New in the review round: a second call that arrives while the first is still at work answers `already_recorded` with `entitlement: 'none'`; the first call's own answer carries the outcome, so keep the button disabled while a record is pending (or read the order list again).
4. `stripe-health`: `endpoint.reason` is absent when the check was skipped for an unusable key (read `usable` / `refusedReason`); `pinnedPlans` are plan keys.
5. History: a page can be empty with `nextCursor: null` (Stripe down at the end). `limit` defaults to 20.
6. Optional, nothing breaks without it: `GET /admin/credits/stripe-health?prices=1` adds `prices` (item 4). A line "Prices: n checked, m problems" with the plan key and the problem code would make the price check visible to staff. Read `issues` only when `checked` is true.

**Orchestrator**
1. Seam check at the gate: the web sends `attemptKey`. Add `attemptKey` to the "Admin refunds" row of `MARKET_TASK_PLAN.md` 3.1 and to `STRIPE_TEST_RECIPE.md` 5.1 row 10a.
2. `ALIPAY_CUTOVER.md` 4.3 g and `STRIPE_TEST_RECIPE.md` section 7 match what is built; the "available after phase M4" marks can go. Section 7 could add that the endpoint is shown by address only.
3. `MARKET_TASK_PLAN.md` 3.1: the "Endpoint check" row can say both checks are wired (`stripe-health`, and `stripe-health?prices=1` for `checkStripePrices`), and the "Practice cost and Stripe health" row can add the optional field `prices?: { checked, pinsChecked, lookupKeysChecked, issues: Array<{ planKey, currency, problem, expected, found }>, reason? }`, sent only with `?prices=1`, never a price id.
4. `stripe-health` shows no reason when the rail is closed by a webhook secret that cannot verify (`stripeRailBlocker` knows it). An optional `railBlocker` field would say it.
5. `platform/billing/errors.ts` has no owner in M4: `order_not_completed` could move into `BILLING_ERROR_STATUS` later, and `AdminBillingError` could go.
6. `platform/billing/stripeRefunds.ts` `issueRefund` (no owner in M4), found while testing the retry paths and confirmed with a throwaway test: when a dialog is sent again after `charge.refunded` has recorded its refund, and the amount still fits what is left, Stripe replays the same refund and the engine answers `full: refundedBefore + amountMinor >= paidMinor` with that refund counted twice. Paid 2,000, refund 1,000, retry after the row landed: one refund at Stripe, and the answer says `full: true`. Here that reaches the retry's HTTP answer only (the audit row of the first request is right). Fix in the engine: leave out of `refundedBefore` what the answered refund already accounts for (a refund whose `created` is older than the request is a replay), or decide `full` from the charge.
7. Only if an operator wants it (carry-over M2.5): add `billingReconcile: [{ limit: 10, windowSec: MINUTE }]` to `RATE_LIMITS` in `platform/ratelimit/defaults.ts`, and in `RoboApplyBillingService.ts` (`reconcileCheckoutSession`) replace `CHECKOUT_RECONCILE_WINDOWS` with `rateLimitWindows('billingReconcile')`. Nothing in M4 needs it.

**Owner**
1. Confirm the cut-short rule (carry-over .7): a withdrawn or immediately cancelled subscription loses the period's practice credits and gets the Free allotment. It also applies when Stripe gives up on an unpaid renewal.
2. Confirm the three reading rules of the practice cost (item 3). Counting unmetered sessions as $0 would lower the average.
3. A partial CN refund record closes the order's record: a later full refund of the same order cannot be recorded (one claim per order).

## Schema requests

None needed. `RABillingRefund` (MKT-0) is used as delivered: `note` holds the outcome of a manual CN record (`entitlement: pass_ended`, or `entitlement: not_reversed` after a reversal that failed), and `createdAt` of a manual CN row is set from the service clock.

Optional, both additive:

```prisma
model RABillingRefund {
  // …
  /// The Stripe refund (re_…) a row of kind 'refund' or 'withdrawal' records. Written by charge.refunded.
  stripeRefundId String?
  @@index([createdAt(sort: Desc)])
}
```

- `stripeRefundId` (with `charge.refunded` in `stripeRefunds.ts` writing it) would let the late audit of item 1 work from our own rows with no Stripe read, and would link a refund row to its audit row.
- The index only if the all-users refund list ever gets slow (it sorts the table by `createdAt` with no `userId`).

## Env variables added or redefined

None.

## i18n keys added or changed

None (no namespace). The new refusals carry English fallback messages; the web shows its own text by `code`.

## Known gaps

1. **Not checked against Stripe.** These rest on the SDK's types and the API reference: `invoices.list` paging with `starting_after` and `has_more`; `ended_at` on a cancelled subscription and the item's `current_period_end` staying the period end after cancellation; `webhookEndpoints.list`; `refunds.list` by `payment_intent` returning `metadata` and `created`; `prices.retrieve` / `prices.list` by `lookup_keys` (the last two inside `checkStripePrices`, MKT-2B's code).
2. **The transaction of the refund audit is not run against Postgres here.** The in-memory database has no rollback, so the test "no claim is left" wraps it and restores the claim ledger when the transaction throws; on Postgres that is the database's own rollback.
3. **An audit row that cannot be stored, and nobody sends the dialog again.** The answer is still 200 (the refund happened), so nothing prompts a retry. The refund is then in the server log, on the Stripe refund (`metadata.actor`) and, after the webhook, in `RABillingRefund` (`actor`), but not in `RAAdminAuditLog` until someone sends that dialog again or tries the payment again.
4. **Late audit, where it does not reach.** A target given as the Checkout Session of a SUBSCRIPTION checkout: the refund row carries the invoice id only, so the refused retry finds no row and writes nothing (an invoice target, and the session of a one-time payment, are found). A refund whose `charge.refunded` row carries `actor: 'stripe'` because the event's refund list could not be matched. `full` on a late row is derived from our rows (nothing left of the payment means the newest refund took the rest).
5. **CN handover after 30 seconds when the first request is alive but slower than that.** Both then try; the engine's own claims keep the reversal to once, and there can be two audit rows (the first one saying `none`).
6. **Mixed stacked passes on a CN account.** `reversePassPeriod` touches a running pass only when its plan key is the refunded order's. A refunded 周卡 under a later 月卡 answers `entitlement: 'none'` and the buyer keeps those 7 days. It is the engine's rule (and the item's); there is no staff tool to shorten a pass by hand.
7. **Inside one run a pass is not told apart from its neighbours** (MKT-2D Known gap 12): refunding either of two stacked passes of one plan takes one length off the end.
8. **Free re-grant** (MKT-2D Known gap 5) applies to the CN record and to the cut-short reset: the balance is set to the Free allotment plus unspent packs, so a person who had spent that month's free credit gets one back. And the engine ends a pass first and grants second: if the grant throws, the row says `entitlement: not_reversed` although the pass did end, and a later call answers `none`.
9. **Practice cost** reads at most 1,000 rows a brand. That is far more than 50 sessions today (one row a session); if most rows were unmetered the sample could come up short and would say so through `sampleSize`.
10. **The price check is not cached** and is made on every request that asks for it (one read per pinned price, one list per ten lookup keys).
11. **History order when Stripe was down for one page**: its invoices appear on the next page, after CN orders that are older. Nothing is lost or repeated.
12. **History, a CN order with no `completedAt`** (none is written by this code): paged correctly on Postgres (nulls first), dated by `createdAt`, so it can sit out of date order.
13. **The claim helper stamps `fromSource: 'stripe'`** on every claim row, the three CN and admin claims included (`stripeEvents.ts`, not my file). Cosmetic.
14. **Cut-short slack is one hour**, a constant (`CUT_SHORT_SLACK_MS`). The reset claims first and resets second, like the refund engine: if the process dies in between, the credits stay.
15. **MKT-4A's request 3 to this bundle** (show `withdrawalQuotes(userId)` next to the admin refund quote) is not built: `refundQuote` is in `service.ts` (MKT-4A's file), the console reads no such field, and it would be a contract for both bundles. Left for a later phase.

## Review resolution

Findings (all three verified in the code before changing anything; all three were real):

1. **Practice cost can add one usage row twice when it reads a second page (low): fixed.** `practiceCostOf` paged with `skip` / `take` and added every row it was handed. It now pages by position (`before: { createdAt, id }` of the last row read; the default reader's `where` gets the matching `OR`), which is the reviewer's "better" fix, and also keeps a set of row ids, the reviewer's first fix, so the rule "a usage row is added once" does not depend on the reader. The dependency `practiceCostRows(brand, { before, take })` replaces `{ skip, take }`. Tests: a session written between two reads (the 200th row is a $3 session and is counted once); a reader that repeats its last row; the default reader's second-page query; no `skip` in any call.

2. **An admin refund can stay out of the admin audit table for good (low): fixed, both windows, with two changes to the proposed fix.**
   - *First window (the audit insert fails, the claim is already spent).* Proposed: return the audit result and delete the claim row on `log_only`. Done instead: the claim and the audit row are one transaction, and `log_only` throws inside it. Reason: the same change also covers a process that stops between the claim and the row (which a delete after the fact cannot), and it leaves no moment in which a second request sees a claim that is about to be deleted and skips its own audit. `audit()` now returns whether the row was stored, as proposed.
   - *Second window (the process stops after Stripe answered; the retry arrives after `charge.refunded` and is refused).* Proposed: find the admin's `RABillingRefund` row for the target and audit it under a claim on that row's id. Not done that way, because it would write a second audit row for every refund that already has one: the row does not exist yet when the first audit row is written, so the first claim (on the refund id) and a row-id claim cannot see each other, and the first later attempt on a refunded payment would find the row "unclaimed". Done instead: on the refusal, the payment's refunds are read from Stripe and each refund of this admin is audited under the SAME claim as the normal path (`billing:adminrefund:<refundId>`). Our rows decide whether Stripe is asked at all (only when this admin has a refund row on the target). The partial-refund form of the same window (`amount_above_refundable`) is covered too; the finding named only `already_refunded`.
   - Tests: listed under item 1. The test "a refund that has its audit row never gets a second one from a later refused attempt" is the case the row-id claim would have failed.

3. **Two record requests for one CN order at the same moment can leave two audit rows, the first saying nothing was reversed (low): fixed as proposed, plus one addition.** A call that did not create the row runs the reversal only when the row is 30 seconds old (`createdAt` is now written from the service clock and selected). Addition: a reversal that threw is marked on the row (`entitlement: not_reversed`), so the click after a 500 finishes it at once instead of answering "already recorded, nothing changed" for 30 seconds. The earlier handoff's "one audit row" claim rested on the in-memory ordering, as the reviewer said; the new test holds the first request just before its reversal and sends the second one through a service that would reverse at once, which fails on the old code with two audit rows.

Items judged not done:

4. **Carry-over M2.1, `checkStripePrices` served by a route: done.** The reviewer was right that it stayed unreachable: the plan's as-built row assigns both checks to this bundle. Served as `GET /stripe-health?prices=1` (item 4). The default answer is unchanged, so MKT-4C's reader and tests are not affected; the plan row to update is Orchestrator 3.
5. **Carry-over M2.5, reconcile limit overridable: left, as before.** The entry is optional and the reviewer judged leaving it acceptable. The one thing missing was a request: it is now Orchestrator 7, with the exact two changes, for whoever wants it.
6. **Carry-over M2.8, "Keep my plan" for a row without an amount: left, as before.** The reviewer checked the reason against the code (`RoboApplyBillingService.ts`, every sync writes `amountMinor` from the price) and judged it acceptable. No change.

Unowned edits: none (the reviewer found none; `git status` in the worktree lists only the eight files above).

Found while resolving, not part of the review: the `full` flag of `issueRefund` on a replayed half refund (Orchestrator 6), and the optional `stripeRefundId` column (Schema requests).
