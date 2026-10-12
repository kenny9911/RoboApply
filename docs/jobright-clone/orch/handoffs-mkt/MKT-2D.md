# MKT-2D

Refund engine (server): `issueRefund`, the `charge.refunded` and `charge.dispute.created` webhook handlers, the pro-rata withdrawal rule, `withdrawalQuote` / `withdrawPurchase`, and the two refund mails. Requirements ST-4 and ST-9 (engine half). Worktree `wp-MKT-2D`, branch `wp/MKT-2D`. Nothing was committed. No command reached Stripe, a database or the network: every test uses the in-memory Prisma and a fake Stripe client.

All six items are done. The independent review found four things; three were real defects in my code and are fixed with tests, the fourth is the test outside my owns that is red on purpose (see "Review resolution" and "Red tests for other bundles").

## Review resolution

1. **Pro-rata withdrawal used the subscription's current period (medium): confirmed and fixed.** Stripe moves a subscription to its next period when it drafts the renewal invoice, before it collects, so a weekly buyer at day 7 plus 2 hours (or for days, when the renewal card fails) was quoted 6/7 of a week they had used up. Two changes:
   - `stripeRefunds.ts` `openWithdrawal` now takes the bounds from the invoice the withdrawal is about: new `invoicePaidPeriod(invoice)` reads the period of the invoice's subscription line (current API: `parent.subscription_item_details`; old API: `type: 'subscription'`; never a proration line, never a one-off item). The Stripe subscription is read only for an invoice that carries no such line.
   - `refunds.ts` rule 1b now requires the bounds to be those of the period the charge paid for: `periodStart <= chargedAt + 1 hour` and `chargedAt < periodEnd`. Bounds of a later period mean the paid one is over, so rule 1b does not apply and the older rules decide (for a weekly plan: no refund, no withdrawal quote). I chose "does not apply" over "eligible with amount 0" so the answer is the same whichever way the bounds were found: with the invoice's own bounds `now < periodEnd` is already false at that moment.
   - Tests: `refunds.test.ts` "bounds of a later period are not the paid period" (day 7 + 2h, days 8 to 14, the one-hour edge both ways, a charge after the period); `stripeRefunds.test.ts` "the period is the one the invoice paid for, not the subscription's current one" (the subscription is not even read; proration and one-off lines skipped; old line shape), "a weekly plan at day 7 plus two hours, the subscription on period two and the renewal unpaid: no quote" (with lines, and through the fallback without lines), and "a first week that is used up cannot be withdrawn from once Stripe has rolled the period" (`withdrawPurchase` refused at day 7 + 2h, day 10 and day 14; no cancel, no refund, no claim, no mail).
2. **A refund or dispute of an old, finished pass charge shortened or ended a newer pass (medium): confirmed and fixed.** `reversePassPeriod` takes a new optional `purchasedAt` and reads the row's `startedAt` (fulfilment sets it when a run starts and keeps it across stacked passes: `fulfilStripePayment`, and `fulfilPass.ts` for Alipay). A pass bought more than 5 minutes before the run that is live now started is over: outcome `none`, the row is untouched, `entitlementReversed` stays false, and the mail says nothing about paid time being gone. For Stripe, `purchasedAt` is the moment the pass was activated (the claim `billing:checkout:<session>` that the billing service writes in the same transaction as the activation), and the charge time only when there is no such claim. I went one step past the reviewer's "use `charge.created`" because a webhook that arrives hours late would otherwise make a just-bought pass look older than its own run, and its refund would then reverse nothing. A row without `startedAt` (legacy) is reversed as before.
   - Tests in `integration/stripeRefunds.webhook.test.ts`: "a refund or a dispute of an old pass that ended before the running pass began leaves the running pass alone" (full refund of a charge 20 days old, dispute of one 40 days old, each replayed, then the running pass's own refund still ends it); "a pass whose fulfilment came late is judged by when it was activated"; "a second pass stacked on a running one is part of the same run … a row that has no start date is reversed as before". The fixtures now carry what real data carries: `created` on a pass charge, `startedAt` on a pass row.
3. **The mail for the refund that completes a series of partial refunds said "That is the full amount you paid" (low): confirmed and fixed.** `RefundIssuedParams` has a new required field `completesEarlierRefunds`; the handler sends `full && row.amountMinor < charge.amount`. The template uses the new string `billingRefunds.refundIssued.bodyRest` ("We refunded {amount} for {plan}. With the earlier refunds, your payment is now refunded in full.") for that case, `bodyFull` only for a refund that is the whole charge by itself, `bodyPartial` otherwise. The access sentence is still driven by `full` and `accessEnded`.
   - Tests: `templates/billing/refunds.test.ts` "the refund that completes a series of partial refunds never calls its own amount the full amount paid" (subject, text, HTML, preheader, both access outcomes, the flag ignored on a partial refund); the webhook test of three partial refunds now pins the exact params of the third mail (`amountMinor: 699, full: true, completesEarlierRefunds: true`).
4. **One test outside the owns is red by design; the plan's contract row is out of date (low): confirmed, nothing to change in my files.** Both are Requests to the orchestrator (the seam test line and `MARKET_TASK_PLAN.md` line 154). No runtime effect.

Not done by the reviewer's count: none. Unowned edits: none (`git status` shows only paths in my owns).

Each fix was checked by breaking it again (six mutations: the `startedAt` check off; the engine reading only the subscription period; the rule-1b guard off; the activation claim ignored; the handler never setting the flag; the template ignoring it). Every one made at least one of the new tests fail.

## Items

### 1. [P0] issueRefund: done

New `server/src/platform/billing/stripeRefunds.ts`.

`issueRefund({ userId, target: { invoiceId } | { checkoutSessionId }, amountMinor?, reason, actor, kind? }, deps?)` returns `{ refundId, paymentIntentId, chargeId, amountMinor, currency, full }`.

- Order: validate the amount (positive safe integer) → load the billing account → a GoApply account (user brand or row brand) is refused with `refund_not_available` **before a Stripe client is asked for** → no client: `rail_not_configured` → no `stripeCustomerId`: `refund_not_available`.
- Ownership: the invoice or session is retrieved and its `customer` must equal the account's `stripeCustomerId`, else `refund_not_available` (`details.reason: 'not_yours'`) before the payment is looked up. An id Stripe does not know answers the same code (`not_found`).
- Payment intent: invoice → `invoicePayments.list({ invoice, limit: 10 })`, the payment with `status: 'paid'`; falls back to a top-level `payment_intent` (old API versions). Session → `session.payment_intent`; a subscription-mode session (no payment intent) is refunded through `session.invoice`.
- Amount: must not be above what is still refundable = what was paid minus what our `RABillingRefund` rows (kinds refund and withdrawal) already hold for that payment intent. The whole amount given as a number is sent as "everything" (no `amount`, key `…:full`).
- One Stripe write: `refunds.create({ payment_intent, amount when partial, reason: 'requested_by_customer', metadata: { product: 'roboapply', userId, actor, kind, planKey, reason } }, { idempotencyKey: 'refund:<pi>:<amount|full>' })`.
- No database write, no mail, no invalidation: access changes only in the `charge.refunded` webhook.
- Errors: Stripe refusing the request (already refunded, amount too large) → `refund_not_available`; Stripe failing → `payment_provider_error`; a repeated key with different parameters (another actor a moment ago) → the refund that was made is returned if it can be found, else `payment_provider_error` with `reason: 'idempotency_conflict'`.
- Deps (`StripeRefundDeps`: `db`, `getStripe`, `now`, `sendEmail`, `invalidate`, `adjustCredits`, `grantForPlan`, `allocatePacks`) are injectable per call and through `setStripeRefundDepsForTests`; the defaults are imported on first use (once, memoised), so importing the module opens no database client.
- `server/src/platform/billing/index.ts` exports the engine and its types; that import registers the two event handlers at boot.

Tests: `stripeRefunds.test.ts` (40 tests in the file; 18 for `issueRefund`): every ACCEPT line, plus refusal paths, the recorded-refund arithmetic, the old-API fallback, the subscription session, the idempotency conflict, and "nothing in the database changes" (table snapshot before and after).

### 2. [P0] charge.refunded: done

Handler registered through `registerStripeEventHandler('charge.refunded', …)`.

1. Owner by `charge.customer` (`findBillingOwnerByCustomer`); none → `{ handled: false }`. A row whose brand is not `roboapply` → logged, `{ handled: true }`, nothing changed (rule A11).
2. Claim `refund:<charge.id>:<amount_refunded>` (ledger key `billing:refund:…`, as the strategy's event table names it).
3. What was bought: `invoicePayments.list({ payment: { type: 'payment_intent', payment_intent }, limit: 1, expand: ['data.invoice'] })` → an invoice with a subscription is a subscription charge; otherwise the plan key from the charge, invoice or session metadata (checkout writes it on all three), the payment intent's metadata as the last source, and `checkout.sessions.list({ payment_intent, limit: 1 })` for the session id.
4. One `RABillingRefund` row, unique on `(rail, externalRef '<charge.id>:<amount_refunded>')`: kind `refund`, or `withdrawal` when the refund's metadata says so; `actor` and `reason` from the refund's metadata (a Dashboard refund: `actor 'stripe'`); `amountMinor` is the amount of **this** refund (the refund whose running total equals `amount_refunded`), so several partial refunds of one charge are several rows.
5. Only when `amount_refunded >= amount`:
   - pack → `reversePackGrant`: what is left of that pack (`allocatePackRemaining` over the live packs) leaves the practice balance through `adjustCredits` (reason `refund`), grant row to 0. Whoever wins the conditional update of the grant row does it.
   - running pass → `reversePassPeriod`: one pass length off `currentPeriodEnd`; not after now → tier free, planKey free, status canceled, `currentPeriodEnd` now, practice balance re-granted at the Free allotment (`grantForPlan`, tier free). The claim `reversal:<charge>` and the row change are one transaction. Only a running pass of that plan that belongs to the run that is live now is touched: not an expired pass, not a subscription the person bought later, and (review finding 2) not a newer pass when the refunded one was bought and over before that newer run began.
   - subscription invoice → `subscriptions.cancel(subId, {}, { idempotencyKey: 'refundcancel:<subId>:<charge.id>' })`; an already cancelled subscription is success; the period's practice credits go to the Free allotment once per charge. The plan row is left to `customer.subscription.deleted`.
6. Invalidate entitlements; `billing.refund_issued` once (its own claim `refundmail:<charge>:<amount_refunded>`). A withdrawal refund sends no refund mail (it has its own confirmation).

Tests: `integration/stripeRefunds.webhook.test.ts` (31 tests; events go through `handleRoboApplyStripeEvent`, the practice-credit functions are the **real** ones on the in-memory database). Every ACCEPT line, each replayed: pack with 2 of 5 used loses 3 and nothing goes negative; pack used up; pack on a Pro plan keeps the plan's credits; two packs; pass ended; stacked pass shortened by one length; expired pass and later subscription left alone; an old finished pass against a newer running pass; a late-fulfilled pass; a legacy row; subscription cancelled with the key; already cancelled subscription; partial refund (no access change), second partial refund = new row, the completing refund reverses and its mail is flagged; withdrawal partial; unknown customer → handled false and HTTP 200; another brand's row untouched; unknown purchase recorded only; two failure-then-retry cases; two concurrent deliveries (pass and pack); a failing mail.

### 3. [P0] charge.dispute.created: done

Handler: the charge is taken from the event when expanded, else `charges.retrieve`; owner by the charge's customer, none → `{ handled: false }`; claim `dispute:<dispute.id>`; the same reversal as item 2 step 5 (with the same "is this pass part of the live run" rule); one row with kind `dispute`, externalRef `dispute:<dispute.id>`, the dispute's amount and currency, actor `stripe`, reason = `dispute.reason`, `full: true`; one error-level log line for staff (user id, dispute id, charge id, amount, currency, reason, outcome; no card data, no address); no mail.

Tests (same file): pass, pack, subscription, each replayed; unknown customer; a failed delivery finished by the next; **one charge is reversed once whether the refund or the dispute comes first** (both orders); a dispute of an old pass charge while a newer pass runs.

### 4. [P0] Withdrawal rule: done

`refunds.ts` `computeRefund`:

- `RefundInput` gains `periodStart?` / `periodEnd?`; `RefundRule` gains `withdrawal_14d_prorata`; `RefundDecision` gains `prorata: { usedDays, periodDays } | null` and `endsAccess: boolean` (true for both withdrawal rules).
- Rule 1 unchanged. New rule 1b as the item states (region, waiver ticked, first purchase, auto-renewing RoboApply plan, within 14 days of the charge and before the period end, both bounds present): `periodDays = round((end − start) / day)`, `usedDays = min(periodDays, ceil((now − start) / day))`, `amountMinor = floor(amount × (periodDays − usedDays) / periodDays)`. `deadline` is the earlier of charge + 14 days and the period end.
- Added after review: the bounds must contain the charge (`start <= chargedAt + 1 hour`, `chargedAt < end`). Bounds of a later period are treated like missing bounds.
- `REFUND_POLICY_VERSION.roboapply` is `refund-v2-2026-10`; GoApply's string is unchanged (its plans are one-time passes and never reach rule 1b: the rule checks the brand, and a test holds `PRORATA_WITHDRAWAL_PLANS` equal to the auto-renewing plans of the catalog).
- New exports: `isWithdrawalRule`, `WithdrawalRule`, `PRORATA_WITHDRAWAL_PLANS`.
- `acknowledgements.ts`: `WITHDRAWAL_COUNTRIES` (EU 27 + IS, LI, NO + GB + TW, 32 entries) and type `WithdrawalCountry`. `withdrawalRegion`, the waiver sentence and its prose version are unchanged.

Tests: `refunds.test.ts` (30 tests, 13 new: day 5 of 30 → 2082 of 2499; without the waiver 2499; the purchase instant; day 14 and one millisecond after; day 15; weekly plan and its period end; bounds of a later period; NO, IS, LI, GB, TW, FR; US and unknown country; renewal; pass and pack with the waiver; missing or inverted bounds; never more than charged, always whole minor units; the version strings). `acknowledgements.test.ts` (new, 4 tests).

### 5. [P0] withdrawPurchase: done

- `withdrawalQuote(userId, deps?)` → `{ purchase: { source: 'stripe', id, planKey, chargedAt, amountMinor, currency }, decision } | null`. Latest paid invoice of the customer (`subscription_cycle` = renewal), the waiver consent from a day before the charge to an hour after it, the billing country on the row, the period **that invoice paid for** (its subscription line; the Stripe subscription's period only when the invoice has no such line). Returned only for rule `withdrawal_14d` or `withdrawal_14d_prorata`. Null for a GoApply account (no client is asked for), without a client, without a customer.
- `withdrawPurchase({ userId, purchaseId, actor }, deps?)` → `{ status: 'withdrawn', refundMinor, currency, accessEnded: true, rule }`. Re-computes the quote (`purchaseId` must match, else `withdrawal_not_available`); a subscription is cancelled **first** (`subscriptions.cancel(subId, {}, { idempotencyKey: 'withdraw:<subId>' })`); then `issueRefund` with kind `withdrawal` for the quoted amount (a pass or a pack: full; entitlements reverse on `charge.refunded`); then the claim `withdraw:<purchaseId>` and one `billing.withdrawal_confirmed` mail.
- GoApply accounts: null / `withdrawal_not_available`, before `getStripe` is called.

Tests: `stripeRefunds.test.ts` (8 quote tests, 14 withdraw tests): order of the two Stripe calls, both keys, amounts, the mail, refusal paths (day 15, stale id, renewal, US, a rolled period), two calls at the same moment, a call that failed at the refund and is finished by the next one, a completed withdrawal refused, an already cancelled subscription, a cancel that really failed (no refund), pass without the waiver, amount netted against earlier refunds, a staff full refund or a dispute closing the withdrawal, the zero-refund last day, no client, a failing mail.

### 6. [P1] Refund and withdrawal mails: done

New `server/src/platform/email/templates/billing/refunds.ts`, imported by `stripeRefunds.ts`: `billing.refund_issued { planKey, amountMinor, currency, full, completesEarlierRefunds, accessEnded }` and `billing.withdrawal_confirmed { planKey, amountMinor, currency, withdrawnAt }`. Both transactional, no unsubscribe list; `formatPrice`, `formatDateTime` and `planName` are imported from `templates/billing/index.ts` (not edited). A refund that is the whole charge says so; the last of several partial refunds says the payment is now refunded in full (and names only its own amount); a partial one says plan and credits stay as they are; a full refund with nothing left to reverse says nothing about access. The withdrawal mail fits a subscription, a pass, a pack and a zero refund. No sentence promises when the money arrives.

Tests: `templates/billing/refunds.test.ts` (new, 20 tests): both brands, all nine locales (English until translated), every wording branch, amounts from minor units (USD and TWD), and a scan of the staged copy (no competitor, no day count, no em dash).

### Carry-over (`waveM1-carryover.md`, section MKT-2D)

1. Done: the handlers use `claimBillingEvent(db, userId, key, refType, now)`, `ctx.now()` and `findBillingOwnerByCustomer`; `platform/billing/index.ts` is edited by this bundle only.
2. Done: the two rule sets now differ, so they have different names before the suffix (`refund-v2-2026-10` and `refund-v1-2026-10-pending-counsel`). A stored decision keeps the full value; nothing in this bundle prints a version to a buyer (the two mails carry none).

`wavePAR-carryover.md`, "Market waves": no entry names a file in my owns. Entry 11 (keep or purge `RABillingRefund` rows on account deletion) is an owner decision about files I do not own; left.

## Where the item text and the code disagreed (what I did and why)

1. **Mail strings are under `billingRefunds.*`, not `billing.*`.** The item asked for `{ "billing": { "refundIssued": …, "withdrawalConfirmed": … } }` in `billingRefunds.en.json`. `scripts/i18n-merge-staging.mjs` requires a staging file to hold exactly the namespace it is named after, and `__tests__/scripts/i18nMergeStaging.test.ts` ("every staging file is valid and index.ts is current") fails otherwise. The file is `{ "billingRefunds": { … } }`; the templates read `billingRefunds.refundIssued.*` and `billingRefunds.withdrawalConfirmed.*`, and the shared `billing.footer` and `billing.planNames.*`.
2. **"Not fresh → duplicate" is refined.** The item says the claim comes first and a replay returns `duplicate`, and also that "a failure answers 500 so Stripe retries". Taken literally the retry would find the claim and do nothing, so a refund whose reversal failed half way would never be reversed. A replay returns early only when the refund row exists and its reversal is done (or was never due); otherwise it finishes the work and still answers `duplicate: true`. Every step is single-winner on its own (row unique key, conditional update of the pack grant, `reversal:<charge>` claim in the pass transaction, Stripe idempotency key, mail claim).
3. **Refund metadata carries `reason` too** (cut to 300 characters), so the row the webhook writes can show the staff reason. The item listed `{ product, userId, actor, kind, planKey }`.
4. **A withdrawal is closed once it completed.** The item's ACCEPT says "calling twice sends the same two idempotency keys and refunds once"; MKT-4A's says "a second POST answers 409 (already withdrawn)". Both hold: two calls at the same moment, or a retry after a failure, repeat the same two keys; after the completion claim `withdraw:<purchaseId>` exists the quote is null and the call is refused. A purchase staff refunded in full, or one under dispute, has no withdrawal either.
5. **The withdrawal refund is netted** against what our rows already hold for that invoice (an earlier partial refund by staff, or the withdrawal's own refund when the call died before its last step), so the buyer never gets more than the quote in total.
6. **`billing.refund_issued` is not sent for a withdrawal refund** (the withdrawal has its own confirmation; two mails about one refund would contradict each other on the amount in the pro-rata case).
7. **"Still refundable" is computed without a Stripe read**: paid amount minus our recorded rows. The item's fake-client list has no `paymentIntents.retrieve`, and Stripe itself refuses an amount above what is left (mapped to `refund_not_available`).
8. **The webhook handlers use the database of the service that dispatched the event** (`ctx.db`, cast to the wider table set; it is the whole Prisma client), unless a test replaced it. One database per event.
9. **`reversePackGrant` and `reversePassPeriod` are exported** (also from the index), so MKT-4B's manual CN refund can call the same rule instead of writing it again.
10. **Rule 1b can quote 0** on the last started day of a short period (weekly plan, day 7): the formula of the item gives it. The decision stays eligible (the contract can still be ended), `withdrawPurchase` then cancels without a refund and the mail says no refund is due.
11. **The period bounds come from the invoice, not from the subscription** (review finding 1). The item says "the period bounds from the Stripe subscription (stripePeriod)"; that object shows the next period before the renewal is paid. `stripePeriod` is now the fallback only.
12. **"The running pass" means a pass of the run that is live now** (review finding 2). The item says "the running pass -> subtract the pass length"; a charge whose pass ended before the current run began is not that pass.

## Files changed

New:
- `server/src/platform/billing/stripeRefunds.ts`
- `server/src/platform/billing/stripeRefunds.test.ts`
- `server/src/platform/billing/integration/stripeRefunds.webhook.test.ts`
- `server/src/platform/billing/acknowledgements.test.ts`
- `server/src/platform/email/templates/billing/refunds.ts`
- `server/src/platform/email/templates/billing/refunds.test.ts`
- `server/src/i18n/email/staging/billingRefunds.en.json`

Edited:
- `server/src/platform/billing/refunds.ts` (rule 1b and its paid-period guard, the two decision fields, the version, three exports)
- `server/src/platform/billing/refunds.test.ts`
- `server/src/platform/billing/acknowledgements.ts` (`WITHDRAWAL_COUNTRIES`, `WithdrawalCountry`)
- `server/src/platform/billing/index.ts` (exports; the import that registers the handlers)

Touched in the review round: `stripeRefunds.ts`, `refunds.ts`, `templates/billing/refunds.ts`, `billingRefunds.en.json` and the four test files next to them. `index.ts` and `acknowledgements.ts` did not change in this round.

Not touched: `fulfilPass.ts`, `rails/alipayWorker.ts`, the Alipay callback route, `handleAlipayCallback`, `stripeEvents.ts`, `RoboApplyBillingService.ts`, any `*.prisma`, `i18n/messages`, `.env*`. No dependency added.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-2D.md` (same text as this message).

## Tests run

All in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2D`, after the review fixes.

| Command | Result |
|---|---|
| `npx vitest run` on the five owned test files | 5 files, 125 tests passed (refunds 30, acknowledgements 4, stripeRefunds 40, webhook 31, mail templates 20) |
| `npx vitest run server/src -t '\bA\d+ '` (the frozen Alipay tests) | 54 passed, none edited |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | exit 0, all six checks clean |
| `node scripts/i18n-merge-staging.mjs --dry-run` | valid; 20 new email keys under `billingRefunds` |
| `npx vitest run --exclude ".claude/**"` (final run) | 679 files: 678 passed, 1 failed; 15,821 tests: 15,809 passed, 1 failed, 1 skipped, 10 todo |

The one failure of the final run is the seam test below. The run before it (same tree) showed a second failure that did not repeat; see "Pre-existing failures".

## Red tests for other bundles

- `__tests__/contracts/billingPlans.seam.test.ts` › "RoboApply: the refund rules are stated (six positive whole numbers and the public version), no entity, no separate student list". No bundle owns the file in M2: **orchestrator**. Caused by the version bump item 4 orders. Line 48 should now assert `version: 'refund-v2-2026-10'` for RoboApply (GoApply's public label stays `refund-v1-2026-10`; the GoApply test in the same file matches by pattern and is green).

## Pre-existing failures

- `server/src/features/jobs/import/directFetch.test.ts` › "a 2 MB page of "<li " is read, and its draft built, in milliseconds" failed once in the first of my two full runs (`read text: expected 210.87 to be less than 200`) and passed in the second full run and three times alone. It is a wall-clock limit that a loaded machine can miss (679 workers); this bundle changes nothing under `features/jobs`. Owner of the file: not in my owns; no change asked for, but a wider limit would stop it from showing up in a gate run.

## Requests

**Orchestrator**
1. The seam test above (one string, line 48).
2. `docs/jobright-clone/market/MARKET_TASK_PLAN.md` line 154, the as-built note of the `GET /billing/plans` row: it says the public version is `refund-v1-2026-10` on both brands. After this bundle RoboApply publishes `refund-v2-2026-10` and GoApply `refund-v1-2026-10`.
3. Email translate pass: the new namespace `billingRefunds` (20 strings) in `server/src/i18n/email/`. Until then every locale renders these two mails in English.
4. After the M2 merge, run `integration/stripeRefunds.webhook.test.ts` and `integration/RoboApplyBillingService.stripe.test.ts` once more on the merged tree: my handlers reach `customer.subscription.deleted` only through Stripe, but both files drive `handleRoboApplyStripeEvent`, which MKT-2B rewrites in this phase. My HTTP test uses `createStripeWebhookRouter({ getStripe, secret })` (the single-secret test seam MKT-2B keeps).

**MKT-2B**
1. `charge.refunded` and `charge.dispute.created` now have real handlers from boot. Your registry tests in `RoboApplyBillingService.stripe.test.ts` use `charge.refunded` as "a type nobody handles": they stay green (verified on my tree: your first test replaces and unregisters the handler, and with no row holding `cus_1` my handler answers `{ handled: false }` anyway), but a type such as `payout.paid` states the intent better.
2. `stripeHealth.ts`: the endpoint must send both types. `STRIPE_REFUND_EVENT_TYPES` is exported from the billing index.
3. A withdrawal and a full refund of a subscription invoice end access through your `customer.subscription.deleted` handling; I do not touch the plan row for a subscription. A pro-rata withdrawal leaves the period's practice credits as they are (see Known gaps 4); if you reset practice credits when a subscription is deleted, that gap closes.
4. Two things of yours that my code now reads, please keep them: the pass path of `fulfilStripePayment` writes the claim `checkout:<session.id>` in the same transaction as the activation, and sets `startedAt` to now for a fresh run while keeping it across stacked passes. `reversePassPeriod` uses both to tell a pass of the live run from an older one.

**MKT-4A** (withdrawal endpoints)
1. `withdrawalQuote` and `withdrawPurchase` are exported from the billing index. Map the quote as `{ rule: decision.rule, refundMinor: decision.amountMinor, currency: decision.currency, deadline: decision.deadline, prorata: decision.prorata, endsAccess: true, region: decision.withdrawalRegion }`.
2. `withdrawalQuote` throws `BillingError('payment_provider_error')` when Stripe cannot be read (it does not answer null for that). `withdrawPurchase` throws `withdrawal_not_available` (409), `rail_not_configured` (503) or `payment_provider_error` (502). Pass `actor: 'self'` or `'public_link'`.
3. Your acceptance "a second POST answers 409" holds without anything on your side (the completion claim). The fake Stripe your tests need: `invoices.list` (give the invoice its `lines.data[0].period` and `parent.subscription_item_details`, as Stripe does), `invoices.retrieve`, `invoicePayments.list`, `subscriptions.cancel`, `refunds.create`; `subscriptions.retrieve` only for an invoice without lines or on a cancel error, `refunds.list` only on an idempotency conflict.
4. The admin refund quote: pass `periodStart` / `periodEnd` to `computeRefund` as your item says, and take them from the invoice's subscription line, not from the subscription (Stripe shows the next period before the renewal is paid; `computeRefund` now ignores bounds the charge does not lie in, so wrong bounds give the older rules, never a wrong pro-rata amount). `RefundDecision` has two new required fields (`prorata`, `endsAccess`); `computeRefund` is the only place that builds one.

**MKT-4B** (admin billing)
1. `issueRefund` is exported from the billing index; `reason` is stored on the Stripe refund and, through the webhook, on the row.
2. For the manual CN record use `reversePackGrant({ userId, seekerProfileId, grantId: packGrantId(userId, 'order:<id>'), ref, source })` and `reversePassPeriod({ userId, seekerProfileId, planKey, passDays, claimKey, claimRefType, source, purchasedAt })`: they return `'pack_zeroed' | 'pass_ended' | 'pass_shortened' | 'none'`, which are your `entitlement` values. `reversePassPeriod` takes its own claim inside the transaction; give it a key of your own (not `refund:cn:<orderId>`, which you claim first). Pass `purchasedAt: order.paidAt` (the time `fulfilPass` activated it): an order whose pass ended before the run that is live now began then answers `'none'` and leaves the newer pass alone. Without `purchasedAt` any running pass of that plan loses one length.
3. History marker: Stripe rows carry `invoiceId` for subscription charges and for one-time payments alike (Checkout creates an invoice for both), `checkoutSessionId` for one-time payments, `full` per refund (the last partial refund that completes a charge is `full: true`), and a dispute row is always `full: true`.
4. If you send `billing.refund_issued` yourself, the params have a new required field `completesEarlierRefunds` (true only for the last of several refunds of one payment).

**MKT-4C / MKT-2E** (web)
1. `WITHDRAWAL_COUNTRIES` is the list to mirror in `lib/pricing.ts`.
2. `/pricing` prints the four refund lines; none of them states the pro-rata rule for a buyer who ticked the waiver. Copy for it is yours (and the owner's, with counsel: owner list item 13).

**Owner**
1. The Stripe webhook endpoint must be subscribed to `charge.refunded` and `charge.dispute.created`, or no refund reverses anything.
2. Decide Known gap 2 (pro-rata before the 7-day rule) with counsel.

## Schema requests

None. `RABillingRefund` (MKT-0) is used as delivered. In tests the composite unique `(rail, externalRef)` is stood in for by a unique `externalRef` on the in-memory Prisma.

## Env variables added or redefined

None.

## i18n keys added or changed

Server email strings only, English, in `server/src/i18n/email/staging/billingRefunds.en.json` (namespace `billingRefunds`, 20 keys):

- `billingRefunds.refundIssued.`: `subject`, `heading`, `bodyFull`, `bodyPartial`, `bodyRest` (new in the review round), `method`, `accessEndedPlan`, `accessEndedPack`, `accessUnchanged`, `cta`
- `billingRefunds.withdrawalConfirmed.`: `subject`, `heading`, `body`, `received`, `refund`, `refundNone`, `endedSubscription`, `endedPass`, `endedPack`, `cta`

Placeholders: `{amount}`, `{plan}`, `{at}`; `%BRAND%` in the two subjects. No web namespace is owned by this bundle; `i18n/messages` and `i18n/staging` are untouched.

## Known gaps

1. **Not checked against Stripe.** Nothing ran against a real or test-mode account. Four things rest on the SDK's typings (stripe 23.0.0) and on my reading of the API: the `invoicePayments.list` filter `payment: { type: 'payment_intent', payment_intent }` with `expand: ['data.invoice']`; that a refunded charge carries `amount_refunded` as the running total; that `invoices.list` returns each invoice with its lines and that the subscription line's `period` is the period the invoice paid for; and what Stripe answers when an already cancelled subscription is cancelled (I do not rely on its shape: on any cancel error the subscription's status is read and `canceled` is success). MKT-3H's test-mode pass should include one refund, one partial refund, one dispute and one withdrawal, and should look at one first invoice's `lines.data[0]`.
2. **Rule 1b is decided before the 7-day first-purchase rule**, as the item and its acceptance line require. A subscriber in the EU, UK or Taiwan who ticked the waiver and has used fewer than 5 paid credits is therefore quoted the pro-rata amount in the first 7 days, where the published standard rule would return the whole price. Staff can still refund the whole amount (`issueRefund` takes the amount they choose). Owner and counsel decision.
3. **Only the latest paid invoice is quotable, and only while the period it paid for runs.** A buyer who bought a subscription and then a pack can withdraw from the pack only. A weekly subscriber who ticked the waiver has no withdrawal quote from the end of the first week (day 7), although the 14 days of the statute are not over: before the renewal is paid because the paid week is used up, after it because the latest invoice is a renewal. They can still cancel in the ordinary way. The same buyer WITHOUT the waiver keeps the full refund of rule 1 until day 14 as long as the first invoice is the latest paid one (rule 1 is unchanged by this bundle).
4. **A pro-rata withdrawal does not reset practice credits.** The item says a partial refund runs no reversal; the subscription is cancelled, and the credits of the period stay until the plan row ends and the next monthly grant, exactly as after an ordinary cancellation.
5. **The Free re-grant sets the balance** to the Free allotment plus unspent packs (`grantForPlan`, ledger reason `grant_renewal` with `metadata.cause: 'refund'`; the function accepts no other reason). A person who had already spent that month's free credit gets it back once.
6. **Pack reversal is two writes** (grant row, then balance through `adjustCredits`, as the item asks). If `adjustCredits` fails the grant row is restored and the event fails, so the retry finishes; if the process dies between the two writes the user keeps those credits.
7. **Two deliberate partial refunds of the same amount on one payment inside 24 hours** share the idempotency key `refund:<pi>:<amount>` (the strategy's key format): Stripe makes one.
8. **Not handled:** a refund that fails later (`refund.failed` / `charge.refund.updated`) does not restore what was reversed; a dispute the merchant wins (`charge.dispute.closed`) does not either. Both need a staff action.
9. **TWD:** the pro-rata amount is floored to the minor unit, so it can be a fraction of a New Taiwan dollar although prices are whole dollars.
10. **Public policy label:** RoboApply now publishes `refund-v2-2026-10` and GoApply `refund-v1-2026-10` on `GET /billing/plans`; the six numbers they print are unchanged.
11. **Test-runner note for the consumers:** two concurrent `import()` calls of a `vi.mock`-ed module can hand one caller the real module. The engine memoises its lazy imports, so this does not show with the default deps; a test that wants to be independent of it passes `db` explicitly.
12. **Inside one continuous run, a pass is not told apart from its neighbours.** Pass A on day 0, pass B stacked on day 6, A refunded or disputed on day 10: one pass length comes off the run (it ends now, because 7 paid days remain and 10 were used). That is the stacking rule of the item. Only a pass from an EARLIER run, one that ended before the live run began, is left out (review finding 2). The test for "earlier run" is the row's `startedAt` against the pass's activation time with 5 minutes of slack; a legacy row without `startedAt` cannot be told apart and loses one length as before.
13. **A full refund of ANY invoice of a running subscription cancels it**, an old invoice too (the item says so, and for a dispute it is what is wanted). Staff who want to return money for a past month and keep the subscription should refund a partial amount, which changes no access.
