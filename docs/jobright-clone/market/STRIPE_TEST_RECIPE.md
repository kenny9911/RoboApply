# Stripe test-mode recipe and scenario pass (RoboApply)

**Written:** 2026-10-11, market wave phase M3 (bundle MKT-3H). **Requirements:** ST-0 and the gate "Stripe test-mode scenario pass" (`MARKET_STRATEGY.md` section 6; section 5.1 "Local test recipe"; `PAYMENTS_AUDIT.md` B6). **Code state:** `feat/jobright-clone` as merged at the M2 gate.

**For:** the owner (two steps touch the Stripe account) and whoever runs the scenarios with the owner's test key.

**Read this first: nothing in this document was run against Stripe.** No test key existed when it was written, and the automated tests use a hand-written fake client. Every "Expected" below is what the merged code does on that fake, or what the strategy specifies. The purpose of the pass is to see each one against a real test-mode account for the first time. Where an expectation rests on the Stripe SDK's typings alone, the row says "typings only". Tick a row only when you saw it.

This document names no key, no secret and no real customer. Use test accounts made for the pass.

---

## 1. Safety

- **The clone worktree's `.env` holds a live Stripe key** (`MARKET_STRATEGY.md` section 5.1 "Safety first": prefix and presence were checked, the value was never read).
- **A live key does nothing outside production.** `getStripe` (`server/src/platform/billing/stripeClient.ts`) is the only place that builds a Stripe client. It returns null unless the key starts with `sk_test_` or `rk_test_`, or the runtime is production (`VERCEL_ENV=production`). Every other key, including a format the code does not know, is treated as a live key. With a refused key no Stripe call of any kind is made: checkout, catalog sync, cancel, switch, portal, refund, webhook and the admin report all get null. The plans still list with their amounts, marked `payments_disabled`, and the log says once: `Stripe is off: STRIPE_SECRET_KEY is not a test key …`.
- **Do not set `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION` on a development machine.** It is the one way to make a live key work outside production, and it exists for a staging deployment the owner has decided to run on live data.
- The rail needs a usable key **and** a webhook secret. With a key and no secret the plans list with amounts and `payments_disabled`, and the log says `Stripe payments are closed: a Stripe key is set without a webhook secret …`. A paid checkout that could never be fulfilled cannot be opened.
- Stripe never serves GoApply (rule A11). Run every scenario on the RoboApply host. A GoApply host answers the Stripe routes without making a Stripe call.

Check the key mode without printing the key (prints `1` for a test key, `0` otherwise):

```bash
grep -cE '^STRIPE_SECRET_KEY=(sk|rk)_test_' .env
```

---

## 2. The two owner steps

These are the only steps that touch the Stripe account.

**Step 1. Put a test key in the clone `.env`.**

`STRIPE_SECRET_KEY=sk_test_…` (a restricted test key `rk_test_…` works too; it needs the permissions of section 6.3).

**Step 2. Log the Stripe CLI in and forward events to the local API.**

```bash
stripe login
stripe listen --forward-to localhost:4621/api/v1/roboapply/stripe/webhook
```

`stripe listen` prints a signing secret (`whsec_…`). Paste it into the clone `.env` as `STRIPE_WEBHOOK_SECRET`, then restart the stack:

```bash
./scripts/dev-clone.sh
```

Ports of `scripts/dev-clone.sh`: API 4621, web 3621. Keep `stripe listen` running in its own terminal for the whole pass, except where a scenario says to stop it.

Notes that follow from the code:

- `STRIPE_WEBHOOK_SECRET` and `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` each accept a comma-separated list. The webhook tries every secret in order (the RoboApply name first) and the first that verifies wins. So the CLI secret and a Dashboard endpoint secret can both be set.
- A secret with whitespace inside it never verifies and keeps the rail closed.
- **One more variable decides where Stripe sends the buyer back.** The success and cancel URLs of Checkout and the return URL of the portal are built from `NEXT_PUBLIC_ROBOAPPLY_URL` (then `ROBOAPPLY_URL`, then the brand's public origin). For this stack it must be `http://localhost:3621`. With the main checkout's value (`http://localhost:3611`, the value in `.env.example`) or with none, Stripe returns the buyer to another stack or to the production site, and the return page of this stack never runs. Check:

```bash
grep -n '^NEXT_PUBLIC_ROBOAPPLY_URL=' .env
```

- Events forwarded by `stripe listen` arrive in the test account's default API version. The Stripe SDK in this repository sends API version `2026-09-30.endive` (`node_modules/stripe/esm/apiVersion.js`, stripe 23.0.0). If a handler misses a field, note the API version of the event (it is in the event JSON) with the result. *Assumed, not checked: `stripe listen --latest` asks for the latest version.*

---

## 3. What appears with no further setup

Open `http://localhost:3621/settings/billing`, signed in to a RoboApply test account.

| Plan key | Shown as | Price | Kind |
|---|---|---|---|
| `pro_weekly` | Pro, billed weekly | $9.99 a week | subscription |
| `pro_monthly` | Pro Monthly | $24.99 a month | subscription |
| `pro_quarterly` | Pro Quarterly | $54.99 every 3 months | subscription |
| `pro_week_pass` | 7-day pass | $9.99 once | one-time |
| `practice_pack_5` | Practice pack (5) | $9.99 once | one-time |
| `practice_pack_15` | Practice pack (15) | $24.99 once | one-time |

These are the catalog defaults of `server/src/platform/billing/planCatalog.ts` (cents: 999, 2499, 5499, 999, 999, 2499). No price variable is needed. The student plans ($17.49 and $37.99) exist behind the `student` flag and are not part of this pass.

Created by code, on first use, in the test account:

- **Products**, with fixed ids, at the first checkout of a plan that needs them: `ra_pro` (weekly, monthly, quarterly), `ra_pro_student`, `ra_pro_week_pass`, `ra_practice_pack`.
- **Prices**, found or created under a lookup key `ra_<planKey>_<currency>_<amount>_incl`, tax-inclusive: `ra_pro_weekly_usd_999_incl`, `ra_pro_monthly_usd_2499_incl`, `ra_pro_quarterly_usd_5499_incl`, `ra_pro_week_pass_usd_999_incl`, `ra_practice_pack_5_usd_999_incl`, `ra_practice_pack_15_usd_2499_incl`.
- **The customer portal configuration**, at the first portal session ("Manage payment"). It is our own (marked `metadata.product = roboapply`): invoices, payment method, customer details and cancel at period end are on; changing the plan is off. The account's default configuration is never read or changed.

Rules for whoever looks at the Dashboard during the pass:

- **Never archive an `ra_…_incl` price by hand.** An instance that already resolved it keeps sending it and checkout answers 502 until that instance restarts. To change a price, change the catalog amount (or `PRICE_<PLANKEY>_USD_CENTS`): a new amount is a new lookup key and a new price, and existing subscribers keep theirs.
- Do not create products or prices by hand. `STRIPE_PRICE_<PLANKEY>` is an optional pin and is honoured only together with an amount variable.

---

## 4. Test cards

Any future expiry date, any CVC.

| Card | Behaviour |
|---|---|
| `4242 4242 4242 4242` | Succeeds. |
| `4000 0027 6000 3184` | 3-D Secure on every payment. |
| `4000 0000 0000 9995` | Declined: insufficient funds. |
| `4000 0000 0000 0341` | Attaching it to a customer succeeds; the next charge fails. It cannot pay a first Checkout. To use it, buy with `4242 …` first and then replace the card through "Manage payment" (the portal). |

Source: `PAYMENTS_AUDIT.md` B6, read from Stripe's testing page on 2026-10-11.

---

## 5. The scenario pass

How to read the answer of the webhook: `stripe listen` prints the HTTP status of each forwarded event. The body (`{ received, handled, duplicate? }`) is not printed there; the state of the account and the API log are what you check. Useful log texts are listed in section 7.

Use a fresh test account for each numbered group unless the row says to continue. "Row" means the account's plan as `GET /api/v1/roboapply/billing/plan` and the billing page show it.

### 5.1 The base pass (strategy section 5.1 and item list)

| # | Scenario | How | Expected | Seen |
|---|---|---|---|---|
| 1 | Monthly purchase | Buy Pro Monthly with `4242 …`. | Checkout shows $24.99 and, above the pay button, "Renews every month at $24.99 until you cancel. …". The return page turns Pro within one poll. Row: `pro_monthly`, active, renews. 3 practice credits. In the Dashboard: product `ra_pro`, price `ra_pro_monthly_usd_2499_incl`, one customer. | ☐ |
| 2 | Cancel | On the billing page, cancel. | The subscription has `cancel_at_period_end: true` in Stripe. Row: cancelled, access until the period end. One mail `billing.cancel_confirmed`. | ☐ |
| 3 | Resume | "Keep my plan", tick the box. | `cancel_at_period_end: false` in Stripe. Row: renews again. The acknowledgement is recorded with the price the subscription is charged. | ☐ |
| 4 | Switch to quarterly: the quote equals the charge | From monthly, choose Pro Quarterly, read the quote, confirm. | The amount of the quote is the amount of the invoice Stripe creates. The answer is `switched: true` and one read of the plan shows `pro_quarterly`. Practice credits do not change (both plans allow 3 a month). | ☐ |
| 5 | Switch with the 3-D Secure card: plan unchanged until confirmed | Buy weekly with `4000 0027 6000 3184` (authenticate once at Checkout). Switch to monthly and confirm. | The answer is `switched: false`, `requiresAction: true`, with a hosted invoice link. Row: still `pro_weekly`. Log: `plan switch waits for payment; plan unchanged`. Pay on the hosted invoice page: the row becomes `pro_monthly` and the balance rises by 2 (weekly allows 1, monthly 3). Note whether a mail `billing.payment_action_required` arrives for this invoice. *Typings only: that Stripe accepts `metadata` (with an empty `cancelSource`) and `cancel_at_period_end` together with `payment_behavior: 'pending_if_incomplete'`, and returns `pending_update` with an open `latest_invoice`. If Stripe refuses the combination every confirm answers 502, nobody is charged and no plan changes: record Stripe's message.* | ☐ |
| 6 | 7-day pass after cancelling | Continue from an account whose subscription is cancelled and still in its paid period. Buy the 7-day pass. | Before the cancel the pass is refused: 409 `already_subscribed`. After it: Checkout says "One payment of $9.99. It does not renew.". Row: `pro_week_pass`, ends at the paid period's end plus 7 days. The cancelled subscription is ended at Stripe at once. No error line in the log. | ☐ |
| 7 | Pack purchase with the webhook stopped: the return page reconciles | Stop `stripe listen`. Buy Practice pack (5) with `4242 …`. | The return page calls `POST /api/v1/roboapply/billing/checkout/reconcile` with the session id of the return URL and answers `fulfilled`: the practice balance rises by 5. Log: `checkout reconciled`. Start `stripe listen` again and resend the `checkout.session.completed` event of that session (section 5.3): the balance does not change. | ☐ |
| 8 | A renewal failure with a test clock | With `STRIPE_TEST_CLOCK_ID` set and a NEW test account (honoured since the M3 gate): see 5.2. | See 5.2, step 3. | ☐ |
| 9 | `payment_action_required` mail | See 5.2: it needs a charge made without the buyer present on the 3-D Secure card. | One mail `billing.payment_action_required` with the hosted invoice link, once per invoice. Never for the first invoice of a subscription (Checkout runs 3-D Secure itself). | ☐ |
| 10 | Refund from the Dashboard | Refund the payment of a pack in full in the Dashboard, or `stripe refunds create --payment-intent <pi_…>`. | `charge.refunded` arrives. The pack's remaining credits leave the balance (never below 0). One row in the refund records, one mail `billing.refund_issued`. Log: `stripe refund recorded`. Resend the event: nothing changes twice. | ☐ |
| 10a | The same from the admin console | `/admin/credits`, section "Refunds": enter the user id, "Show", then "Refund through Stripe" (the latest charge, or a pasted `in_…` / `cs_…` id; an amount, or everything; a reason), review, "Refund now". The call is `POST /api/v1/roboapply/admin/credits/refunds { userId, target, amountMinor?, reason, attemptKey }`: `attemptKey` names this one refund (the console keeps one per user, charge and amount until that refund completes), and a request without one is refused with 422. | The same result as row 10, because access changes only on `charge.refunded`. The list "Refunds, withdrawals and disputes" below shows the new row within ten seconds by itself (it is read again at once, after 3 s and after 10 s) and has a "Refresh" button. One audit row `billing.refund_issued`. Send the same confirmation twice (double click, or again after a lost answer): one refund at Stripe, one audit row, and the answer still says whether anything is left on the charge. A second refund of the same amount is a new refund only from a new confirmation. | ☐ |
| 11 | Withdrawal by an account whose billing country is DE | Buy monthly and choose Germany as the country at Checkout. Then `/settings/billing`, section "Withdraw from contract" (its own section under the plan card): the entry, then the confirmation "Withdraw and refund {amount}". The calls are `GET` and `POST /api/v1/roboapply/credits/withdrawal` (`{ purchaseId, confirm: true }`). The same choice is on the cancel link: request a link on `/cancel`, open it, and the page offers "Cancel at the end of the period" and "Withdraw from contract" (`POST /api/v1/public/cancel/preview { token }`, then `/confirm { token, withdraw: true }`). | Within 14 days the page offers the withdrawal, one row per open purchase (a pack bought beside the plan is its own row). Without the waiver box: the whole price goes back. With it: the unused days of the period (day 5 of 30 is 25/30 of the price). The subscription is cancelled at once, Pro ends, one mail `billing.withdrawal_confirmed`. A second request answers 409 `withdrawal_not_available`. On the link: `accessUntil: null` and `withdrawal.status: "withdrawn"`; the ordinary cancel right after it answers `already_cancelled`. The plan card can read Pro for a few seconds: access ends when `customer.subscription.deleted` is processed. | ☐ |
| 12 | Replay | `stripe events resend <evt_id>` for the `checkout.session.completed` event of a fulfilled purchase. | HTTP 200. The answer carries `duplicate: true` and nothing changes twice: one plan, one grant. | ☐ |
| 13 | A foreign object | `stripe trigger invoice.payment_failed` | Every event of the fixture answers HTTP 200 with `handled: false`: the objects are not ours (the invoice belongs to no subscription and no customer we know). No row changes, no mail. | ☐ |

### 5.2 Renewals, dunning and 3-D Secure on a renewal

**The test clock.** A Stripe test clock can only hold a customer that was created under it, and this code creates the customer itself at the first checkout (`ensureCustomer` in `server/src/platform/billing/rails/stripe.ts`). Since the M3 gate that call reads `STRIPE_TEST_CLOCK_ID` (planned in `PAYMENTS_AUDIT.md` B6): with a test key (`sk_test_` / `rk_test_`) and the variable set, a NEW customer is created under that clock. It is ignored with a live key, and it never moves a customer that already exists: use a new test account, because an account that has opened Checkout before already has its customer. Asserted on a fake client only (`rails/stripe.checkout.test.ts`); not seen against Stripe. If Stripe refuses the customer (a wrong or deleted clock id), the checkout answers 502 `payment_provider_error`: unset the variable or create a new clock.

*Not checked: the Dashboard offers "Run simulation" on a test subscription. Whether it keeps the customer and subscription ids our row holds is not known; if it creates copies, their events are not ours and answer `handled: false`.*

**With `STRIPE_TEST_CLOCK_ID`** (expected steps; the CLI commands are from Stripe's testing page and were not run here):

1. Create a clock: `stripe test_helpers test_clocks create --frozen-time <unix seconds, now>`. Put its id in `.env` as `STRIPE_TEST_CLOCK_ID` and restart.
2. With a new test account buy Pro Monthly with `4242 …`. The customer is created under the clock.
3. Row 8: open "Manage payment", add `4000 0000 0000 0341` and make it the default. Advance the clock past the period end: `stripe test_helpers test_clocks advance <clock_id> --frozen-time <period end + 1 hour>`.
   Expected: `invoice.payment_failed` arrives; the handler reads the subscription again and follows what Stripe holds. When Stripe holds it `past_due`: row `past_due`, Pro stays on while Stripe retries, one mail `billing.payment_failed` per invoice, the failed-payment banner shows and its button opens the portal on "update your payment method". Log: `subscription marked past_due`. Put `4242 …` back and let the retry pay: the banner clears, the period's credits are granted once.
4. Row 9: the same with `4000 0027 6000 3184` as the default card. Expected: `invoice.payment_action_required` arrives and one mail `billing.payment_action_required` goes out with the hosted invoice link. Log: `payment action required: buyer mailed`.
5. A paid renewal: with `4242 …` as the default, advance past the period end. Expected: `invoice.paid` with `billing_reason: subscription_cycle` grants the period's credits once; a resend grants nothing.

**A stand-in that works today, with limits.** It forces an invoice now instead of waiting for the period to end:

```bash
stripe subscriptions update <sub_…> -d billing_cycle_anchor=now -d proration_behavior=none
```

Do it after replacing the card as in step 3 or 4. What it can show: the failed-payment path and the action-required mail, if Stripe marks the subscription `past_due` (or asks for authentication) for that invoice. What it cannot show: a real renewal. The invoice it creates is not expected to carry `billing_reason: subscription_cycle`, so a paid one is handled as a plan change (a top-up, never a refill), not as a renewal. *Assumed, not seen: the command's effect, the billing reason, and the resulting status.* If the log says `payment failed, but the subscription is not past due now`, Stripe did not mark it past due and nothing else happens: that is the code working as written, and row 8 stays unticked.

### 5.3 How to replay an event

```bash
stripe events resend <evt_…>
```

Find the id in the output of `stripe listen` (each forwarded event is printed with its id) or in the Dashboard under the test account's events. `duplicate: true` is answered for a repeated fulfilment claim: a Checkout Session that was already fulfilled, a plan-switch invoice, a failed-payment or action-required mail, a refund. A resent subscription event or renewal invoice answers `handled: true` without the flag and still changes nothing (the sync writes Stripe's current state, and the grant is guarded by the period).

### 5.4 Scenarios added by the M2 handoffs and the cross-review

None of these was seen against Stripe. Each names what is pinned by a test on the fake and what rests on typings.

| # | Scenario | How | Expected | Seen |
|---|---|---|---|---|
| a | Switch with a card that declines | Buy monthly with `4242 …`, replace the card with `4000 0000 0000 0341` in the portal, switch to quarterly and confirm. Then repeat row 5 of 5.1 if not done. | The plan stays `pro_monthly` and `active` in our row. No payment-failed mail goes out (pinned by a test: the handler reads the subscription again and it is not past due). The answer is `requiresAction: true`; the link may be null, the sheet then offers "Manage payment". Write down which events arrive, with their `billing_reason`. *Typings only: as row 5.* | ☐ |
| b | Cancel, "Keep my plan", cancel again within a minute | In that order, quickly. | The subscription ends with `cancel_at_period_end: true` in Stripe. This is why the idempotency key of cancel and resume has five parts (`cancel\|resume:<sub>:<periodEnd>:v<row version>:b<minute>`). With a three-part key Stripe would replay the first cancel. *Not seen against Stripe; an owner decision is pending (`waveM2-carryover.md`, Owner 5).* | ☐ |
| c | Tax switch | Only with Stripe Tax activated and a registration in the test account: set `STRIPE_TAX_ENABLED=true`, restart. | Checkout shows tax and requires the address. A subscriber created that way gets a switch quote with tax that equals the charge. A subscriber created before the switch was turned on, including one on a legacy price, still gets a quote and it equals the charge (a switch never turns automatic tax on for an older subscription). Turn the variable off again afterwards. | ☐ |
| d | Cancel in the app, switch plan, then cancel in Stripe's portal | In that order. | The portal cancellation sends `billing.cancel_confirmed` once (the switch cleared our cancel marker). Log: `cancellation from outside the app confirmed by mail`. | ☐ |
| e | Refunds in every shape | One full refund of a subscription invoice, one partial refund (`stripe refunds create --payment-intent <pi_…> --amount 500`), one dispute (pay with Stripe's dispute test card), one withdrawal (row 11). Also look at the first invoice of a subscription: `lines.data[0].period` is what the pro-rata rule reads. | Full refund of a subscription invoice: the subscription is cancelled now, access ends through `customer.subscription.deleted`, the period's practice credits go back to the Free allotment. Partial refund: recorded, no access changes. Dispute: reversed like a full refund and the account is flagged (log: `payment disputed: entitlement reversed, account flagged`). *Typings only (handoff MKT-2D, Known gaps 1): the `invoicePayments.list` filter by payment intent, that a refunded charge carries the running total in `amount_refunded`, and the shape of the invoice line period.* | ☐ |
| f | The first payment of a subscription is declined | Buy monthly with `4000 0000 0000 9995`. | Checkout shows the decline. No Pro, no dunning mail, the row is unchanged, a new purchase is still possible. Then pay with `4242 …`: one activation, one grant. | ☐ |
| g | A pass paid while a subscription still renews | Buy monthly. In a second tab opened before that purchase, buy the 7-day pass. | The subscription is cancelled at Stripe at once (idempotency key `passover:<sub>:<session>`). Row: the pass, ending at the paid month's end plus 7 days. No later renewal is charged. Log, at error level: `pass paid over a subscription that still renewed: the subscription is ended at Stripe` (someone should look; nothing is owed by hand). Write down what Stripe answers when an already cancelled subscription is cancelled again: the code accepts `resource_missing` and a `canceled` status. | ☐ |
| h | Practice credits across switches | Monthly → weekly → monthly with all practice credits used. Then, on another account, weekly → monthly. | First: the balance stays 0 (a switch between two Pro plans tops up, it never refills). Second: +2. Confirm that `invoice.paid` with `billing_reason: subscription_update` arrives for a zero-amount invoice too. | ☐ |
| i | A weekly plan in a withdrawal region, renewed once | With a test clock (5.2): buy weekly with a German address, advance past day 7, look at the quote on day 10 (`/settings/billing`, "Withdraw from contract"). | Without the waiver the quote is both invoices ("Paid so far" is the sum) and the withdrawal makes two refunds. With it, the unused days of the second week. | ☐ |
| j | A withdrawal whose refund fails after the cancel, sent again | Hard to force against Stripe: the closest is to confirm a withdrawal, and when the answer is 502 (`payment_provider_error`) send the same confirmation again. Not seen against Stripe; every step is asserted on a fake client (handoff MKT-4A, Known gaps 7). | The first request keeps its moment for 14 days: the page keeps listing the purchase at the amount first quoted, with a deadline 14 days after that request (also past the purchase's own 14th day), and the request sent again returns that amount under the same idempotency keys. Retries are counted apart (10 an hour; over it 429 with `Retry-After`). The public link behaves the same, and once it has expired the signed-in page finishes it. Since the M4 cross-review the same holds when Stripe REFUSES the refund request for any reason other than "already refunded" (log `withdrawal: the refund was refused after the subscription was ended`, with Stripe's code in `details.providerCode`): 502, the moment kept. Only `charge_already_refunded` and our own "nothing left to refund" answer 409 `refund_refused`. The 502 body is `details: { provider: "stripe" }` and nothing else: the provider's text is in the log, never in the answer. | ☐ |
| k | The waiver is the box of that purchase (M4 cross-review) | (1) Open Checkout for the monthly plan with the waiver box ticked and close the Stripe page without paying. Within the day, buy the monthly plan with the box NOT ticked, German address. Look at the quote. (2) Buy the monthly plan with the box ticked, and within the hour a practice pack without it. Look at the quotes. In Stripe, the first invoice of the subscription carries `parent.subscription_details.metadata.withdrawalWaiver` (`yes` or `no`) and the pack's invoice carries it in its own `metadata`. | (1) The quote is the whole price (`withdrawal_14d`), not the unused days: the box of the abandoned checkout does not count. (2) Two rows: the plan at the unused days (`withdrawal_14d_prorata`), the pack in full. If either invoice shows no `withdrawalWaiver` stamp, say so: the engine then falls back to the consent record of that day, which cannot tell two checkouts apart. | ☐ |
| l | A purchase whose payment cannot be resolved is not ended (M4 cross-review) | Not forceable against Stripe by hand; asserted on a fake client (`stripeRefunds.test.ts`, `withdrawal.test.ts`). If a withdrawal ever answers 409 `withdrawal_not_available` for a purchase the page listed a moment before, read the log. | Log `withdrawal refused before anything was ended: a refund it owes cannot be made`, with the invoice and the reason (`nothing_paid`, `not_found`, `not_yours`, `no_customer`, `already_refunded`, `amount_above_refundable`). The subscription is still running in Stripe and nothing was refunded. | ☐ |

Two log lines to watch for during the whole pass, both at error level:

- `stripe subscription not attached: the row is on another running subscription`: one buyer paid for two subscriptions. The second has to be cancelled and refunded by hand in the Dashboard.
- `pass paid over a subscription that still renewed: the subscription is ended at Stripe`: see row g.

---

## 6. Going live

### 6.1 The webhook endpoint

Create one endpoint in the live Dashboard:

```
https://www.roboapply.io/api/v1/roboapply/stripe/webhook
```

Use exactly this origin. The endpoint check compares scheme, host and port: an endpoint registered on the apex host does not match `www`.

Subscribe it to these fourteen event types and no fewer. A missing type is silent: Stripe never sends it, and without the two `charge.*` types a refund made in the Dashboard reverses nothing.

<!-- The list below is copied from EXPECTED_STRIPE_EVENTS in server/src/platform/billing/stripeHealth.ts. When that constant changes, change this list. -->

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.pending_update_applied
customer.subscription.pending_update_expired
invoice.paid
invoice.payment_failed
invoice.payment_action_required
charge.refunded
charge.dispute.created
```

The list is copied from `EXPECTED_STRIPE_EVENTS` in `server/src/platform/billing/stripeHealth.ts`. Eight of the fourteen are new since phase M2: `customer.subscription.created`, `customer.subscription.pending_update_applied`, `customer.subscription.pending_update_expired`, `invoice.payment_action_required`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`.

Choose API version `2026-09-30.endive` for the endpoint if the Dashboard asks: it is the version the SDK in this repository uses, so event payloads have the shape the handlers were written for.

### 6.2 The variables

| Variable | Value in production |
|---|---|
| `STRIPE_SECRET_KEY` | The live key. It works because the production runtime has `VERCEL_ENV=production`. A production runtime elsewhere would need `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true`. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the endpoint of 6.1. A comma-separated list during a rotation. |
| `STRIPE_TAX_ENABLED` | Unset. Set it to `true` only after Stripe Tax is activated and the registrations exist in the Dashboard (owner and tax adviser, strategy section 7 item 12). |
| `PRICE_<PLANKEY>_USD_CENTS` | Unset: the catalog defaults of section 3 apply. |

The rail stays closed until both the key and a webhook secret are set. The Stripe account may be shared with other products: every handler answers HTTP 200 with `handled: false` to an object that is not ours, and the products we create carry the `ra_` prefix.

### 6.3 A restricted key

If a restricted key is used, it must allow the calls the code makes. The list of calls is read from the code; the names of the permissions in the Dashboard were not checked.

| Calls the code makes | Needs |
|---|---|
| `products.create`; `prices.list`, `prices.create`, `prices.retrieve` | Products and Prices: write (the first checkout of each plan creates the product and the price) |
| `checkout.sessions.create`, `.retrieve`, `.list` | Checkout Sessions: write |
| `customers.create` | Customers: write |
| `subscriptions.retrieve`, `.update`, `.cancel` | Subscriptions: write |
| `invoices.list`, `.retrieve`, `.createPreview`; `invoicePayments.list` | Invoices: write (the switch quote is a preview) |
| `refunds.create`, `refunds.list` | Refunds: write |
| `paymentIntents.retrieve`; `charges.retrieve`, `charges.list` | Payment Intents and Charges: read |
| `billingPortal.configurations.list`, `.create`; `billingPortal.sessions.create` | Customer portal configurations and sessions: write (the first portal session creates the configuration) |
| `webhookEndpoints.list` | Webhook Endpoints: read (the endpoint check; without it the check reports `restricted_key` and nothing else is affected) |

### 6.4 Dashboard settings the code does not control

- **The retry schedule for failed renewals** (Billing, Revenue recovery). The code is correct for either end state: the subscription is deleted, or it becomes unpaid.
- **Stripe Tax** and its registrations, before `STRIPE_TAX_ENABLED`.
- The code never edits the webhook endpoint, the account's default portal configuration, or a product it did not create.

---

## 7. Where to look when something is wrong

**The admin console (built in phase M4; RoboApply's admin only, Stripe never serves GoApply).** The credits console has a "Stripe" panel (`/admin/credits#admin-stripe`) and the System view a "Payments" panel (`/admin/system`, with a link to the first), both served by `GET /api/v1/roboapply/admin/credits/stripe-health` (bundles MKT-4B and MKT-4C): key mode, whether the key is usable and why not (no key; a live key outside production), the number of webhook secrets, whether the rail is ready, the pinned plans by plan key, and the webhook endpoint in one of four states: every event sent, some events not sent (listed), no endpoint in Stripe points at this site (it then lists the events a new endpoint needs), or could not be checked. The endpoint is shown by its address only (origin and path: credentials, query and fragment of a registered URL are dropped). It never shows a key, a secret or a price id, and with no usable key it asks Stripe nothing.

The same route with `?prices=1` adds a price check (`prices: { checked, pinsChecked, lookupKeysChecked, issues }`): every pinned price against the catalog and every synced price that was archived or differs, by plan key and amount. It reads one price per pin and one list per ten lookup keys, so it is asked for on purpose; the console does not show it yet (`waveM4-carryover.md`).

**The API log.** Search for these texts.

| Text | Tag | Meaning |
|---|---|---|
| `Stripe is off: STRIPE_SECRET_KEY is not a test key` | `RA_BILLING` | A live or unknown key outside production. No Stripe call is made. |
| `Stripe payments are closed: a Stripe key is set without a webhook secret` | `RA_BILLING` | Set `STRIPE_WEBHOOK_SECRET` and restart. |
| `No STRIPE_WEBHOOK_SECRET configured` | `ROBOAPPLY_STRIPE` | An event arrived and no secret is set: the webhook answered 500. |
| `Signature verification failed` | `ROBOAPPLY_STRIPE` | No configured secret verifies the event: the webhook answered 400. The secret in `.env` is not the one `stripe listen` printed, or the endpoint's. |
| `webhook handling failed`, `Event handler threw` | `RA_BILLING`, `ROBOAPPLY_STRIPE` | A handler failed: the webhook answered 500 and Stripe retries. Every step is safe to replay. |
| `checkout created` | `RA_BILLING` | A Checkout Session was opened. |
| `checkout reconciled` | `RA_BILLING` | The return page fulfilled a session. |
| `stripe pass activated` | `RA_BILLING` | A 7-day pass was activated. |
| `cancel at period end`, `renewal resumed` | `RA_BILLING` | Cancel and resume. |
| `plan switched`, `plan switch waits for payment; plan unchanged` | `RA_BILLING` | The two outcomes of a confirmed switch. |
| `subscription marked past_due`, `payment failed, but the subscription is not past due now` | `RA_BILLING` | The two outcomes of `invoice.payment_failed`. |
| `payment action required: buyer mailed` | `RA_BILLING` | The 3-D Secure mail went out. |
| `stripe refund recorded`, `payment disputed: entitlement reversed, account flagged` | `RA_BILLING` | Refund and dispute. |
| `withdrawal refused before anything was ended: a refund it owes cannot be made` | `RA_BILLING` | The payment of an invoice the withdrawal owes money on could not be resolved, or our rows say nothing is left of it. Nothing was cancelled or refunded (scenario l). |
| `withdrawal: the refund was refused after the subscription was ended` | `CREDITS` | Stripe refused the refund after the cancel. With `providerCode: charge_already_refunded` the buyer got 409; any other refusal got 502 and the declaration row `billing:withdraw-declared:<invoice>` (scenario j): finish it with the buyer's retry or an admin refund. |
| `closing an account: auto-renewal could not be turned off now; the account purge ends the subscription` | `RA_ACCOUNT` | `POST /account/delete` could not cancel at the provider (an error, or no answer within 8 s: `code: timeout`). The account is closed all the same; the purge ends the subscription. |
| `stripe catalog: the price under our lookup key does not match the catalog; refusing to sell on it` | `RA_BILLING` | A price under one of our lookup keys was changed or created by hand. Checkout refuses it. |

Answers of the webhook route: 200 `{ received: true, handled, duplicate? }`; 400 `invalid_signature`; 500 `webhook_secret_missing` or a handler failure; 503 `stripe_not_configured` (no usable key).

---

## 8. What was checked and what was not

**Checked in the merged code** (read, not run against Stripe): the guard and its variable names, the webhook path and its answers, the ports of `scripts/dev-clone.sh`, the catalog amounts, the product ids and lookup keys, the fourteen event types, every log text of section 7, every Stripe call of section 6.3, the mail template keys, and that nothing reads `STRIPE_TEST_CLOCK_ID`.

**Not checked:** anything against a Stripe account, test or live. The Stripe CLI commands are written from Stripe's documentation as quoted in `PAYMENTS_AUDIT.md` B6 and from general knowledge of the CLI; none was run here. The exact effect of `billing_cycle_anchor=now`, the test-clock helper commands, the "Run simulation" behaviour, the Dashboard's permission names and the API version of forwarded events are assumptions and are marked where they appear.

**Not built yet, so not testable in this pass:** the admin refund action and the admin Stripe readout (MKT-4B, MKT-4C), the withdrawal routes (MKT-4A). (The test clock for this application's customers was built at the M3 gate: 5.2.)

When the pass is done, attach this file with the boxes ticked, the test account's id, the date, and for every row that failed: the event id, the answer of the webhook and the log lines.
