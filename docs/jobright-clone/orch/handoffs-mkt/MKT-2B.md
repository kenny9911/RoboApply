# MKT-2B

Stripe webhook lifecycle: new events, re-read, price-first, several secrets, reconcile, portal by code, endpoint check; billing mails (server). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2B`, branch `wp/MKT-2B`. Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser. No command reached Stripe, a database or the network: every Stripe test uses a hand-written fake (`setStripeClientForTests`, `setBillingServiceDepsForTests`).

All eight items are done, all six entries of my carry-over section, and all six review findings are fixed (none rejected; two fixed in a different form than proposed, see "Review resolution"). Every gate is green in this worktree: the whole suite (679 files, 15,958 tests), both typechecks, `npm run check`. No red test outside my owns. `git status` lists 16 paths, all inside MKT-2B's owns; the review found no unowned edit and there is none now.

Read first:
- **Both halves of the webhook-secret change are in.** The route tries every secret of `stripeWebhookSecrets()` AND `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` is `true`. A comma-separated list now opens the Stripe rail, and so does a secret stored with a stray space or newline.
- **A declined first payment switches nothing on (review, high).** A subscription whose first payment is still open (`incomplete`) is attached to no row by any event, and `invoice.payment_failed` no longer makes a row `past_due` on the event's word: it re-reads the subscription and the row follows Stripe.
- **One set of attach rules (`attachRefusal`) for the event, the first invoice and the Checkout Session (review, high and medium).** An old session opened again, a resent event or a second session paid in another tab cannot take a row away from the plan it is on.
- **Three places where I followed the plan documents instead of the item text** (precedence rule): `customer.subscription.created` is re-read too; the first paid invoice can attach a subscription; invoices are "ours" by the row behind the subscription id OR the customer. Details under item 1 and item 2.
- **One new claim the strategy table does not list:** `billing:subcreate:<subscriptionId>`. Whoever wins it (the first paid invoice or the Checkout Session) forces the first period's grant; everyone else is period-guarded.
- **Nothing was seen against Stripe.** Every parameter type-checks against the installed SDK (stripe 23.0.0) and is asserted on a fake. The event orders the review describes (created as `incomplete`, then `invoice.payment_failed` on a decline; `invoice.payment_action_required` for the first invoice) are Stripe's documented behaviour, not observed.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-2B.md` (same text as this message).

## Review resolution

| # | Severity | Finding | Verdict | What was done |
|---|---|---|---|---|
| 1 | high | A declined first payment gives Pro, blocks a new purchase and sends a dunning mail | real, fixed | (a) `attachRefusal` refuses a subscription whose re-read status is `incomplete`; the first paid invoice (by customer) or the Checkout Session attaches it once the money has arrived. (b) `handlePaymentFailed(invoice, stripe)` took the reviewer's "better" form: the first invoice (`billing_reason: subscription_create`) answers `{ handled: true }` with no write, no mail and no Stripe call; every other failure re-reads the subscription, syncs the row from Stripe's copy and mails only when that copy is `past_due`. A subscription Stripe no longer knows changes nothing; any other re-read failure is a failed event (500). (c) `checkout.session.completed` for a subscription that is still `incomplete` answers pending and claims nothing. Tests: block "a declined first payment switches nothing on" (5), block "invoice.payment_failed follows what Stripe holds now" (5), and over HTTP in `RoboApplyBillingService.stripe.test.ts`: after created + failed invoice, `GET /plan` shows no failure and `POST /checkout` for another plan, the same plan and the pass all answer 200. |
| 2 | high | Reconciling one's own old subscription session overwrites the current plan | real, fixed, in a different form than the "simplest form" | `applyCheckoutSession` no longer writes directly. When a row carries the subscription it syncs; when none does it goes through `attachSubscription` and the shared rules: not attached when the subscription has ended, when the row is on another running subscription, or when the row holds a running pass and this is not the session's first fulfilment. A refusal answers `{ handled: true, duplicate: true }` (reconcile: `already_fulfilled`). I did not use "skip whenever the claim is not fresh": a first run that claimed and then crashed would never be healed by the retry. The state rules cover every case the reviewer reproduced and keep the retry working. Tests: block "a row that has moved on is never taken back…": reconcile and a resent `checkout.session.completed` / `async_payment_succeeded` of the old session with the row on another running subscription, on a running pass (old subscription still running, and ended), an old never-fulfilled session whose subscription ended; after each, `customer.subscription.updated` and `invoice.paid` of the current subscription still answer handled true. |
| 3 | medium | The "confirm your payment" mail goes to buyers doing 3-D Secure in Checkout, and can name the plan "Free" | real, fixed | `handlePaymentActionRequired`: after the ownership check, `billing_reason: subscription_create` answers `{ handled: true }` with no claim and no mail. The plan name comes from `planKeyForInvoice`: the row that carries the invoice's subscription, then a price on the invoice lines (both API shapes), then the plan key stamped on the subscription (the invoice carries a copy), then the customer's row; never `free`. When nothing names a paid plan the param is `null` and the template uses a new string without the plan. Tests: 6 in the events file, 1 in the template tests. |
| 4 | medium | `customer.subscription.created` replaces a row that tracks another live subscription | real, fixed | Same rules as finding 2 (`other_subscription`): the row keeps the subscription it tracks, one error line is logged (two paid subscriptions for one buyer is money), the event answers `{ handled: true }`. Applies to `created`, the first paid invoice and the Checkout Session. Once the tracked subscription is over (period ended or row not live), the new one attaches. Tests: sub-block "a second subscription while the row is on a running one" (3). |
| 5 | low | In Stripe's normal order the first period's credits are no longer forced and can be skipped | real, fixed, with one extra condition | `firstPeriodGrant`: the winner of `billing:subcreate:<sub>` gets `'always'`, in both branches of `handleInvoicePaid` and in checkout; later arrivals and replays stay period-guarded. Extra condition (mine): the invoice forces only while the subscription is still in its first period (`inFirstPeriod`: current period start within one hour of `start_date`). Without it an old first invoice resent after a renewal, for a subscription created before this code ran (no claim on record), would force a mid-period top-up. Unknown dates count as "not first period", which is the old period-guarded behaviour. Tests: the reviewer's probe in four orders (force flags `[true, false]`, one grant), and the old-invoice replay (no force, no claim). |
| 6 | low | The endpoint check reports the healthiest matching endpoint | real, fixed | `checkStripeWebhookEndpoint(stripe, { origin? })`. With an origin, the endpoint at that origin is reported (the worse one when two sit there). Without one, or when none matches, the endpoint that misses the MOST events is reported. The return shape is unchanged (the contract of MARKET_TASK_PLAN). Tests: 5 new in `stripeHealth.test.ts`; the old "fewest" test is replaced. |

Also changed while fixing (not asked, same root): in `applyCheckoutSession` and in `handleInvoicePaid` the Stripe read now comes before the claims. A read that fails leaves nothing claimed, so the retry is a first run. Before, a failed read after the `invoice:<id>` claim made the retry a duplicate that never granted a paid switch's credits.

Mutation check of the review fixes: 18 single-line mutations, each caught (no incomplete rule, no other-subscription rule, no pass rule, pass rule ignoring first fulfilment, failed first invoice re-read, mail whatever the status, `past_due` from the event, checkout without the incomplete answer, first invoice never forcing, no first-period condition, first invoice mailed for 3-D Secure, free plan printed, refusal not reported as duplicate, attach without the brand check, checkout writing unguarded as before the review, claims before the read, "fewest" endpoint, origin ignored).

## Items

### 1. [P0] Webhook entry: several secrets, objects of other products ignored, log-only events: done

- `routes/stripeWebhook.ts`: `constructEvent` is tried with each secret in order, the first that verifies wins; none verifies → 400 `invalid_signature` (one warning with `secretsTried`, never a secret); empty list → 500 `webhook_secret_missing`; no client → 503. Processing failures still answer 500. `deps.secret` stays the single-secret test seam; I added `deps.secrets` (a list) next to it.
- `stripeEnv.ts`: the constant is `true`. `stripeEnv.test.ts`: exactly the one assertion flipped. **Beyond the one line:** I rewrote the comment above the constant and two other comments in `stripeEnv.ts`, because they said "FALSE in this phase" directly above `= true`. No behaviour in that file changed besides the constant.
- `RoboApplyBillingService.ts`, one rule per object kind:
  - Sessions: `metadata.product !== 'roboapply'` → `{ handled: false }`. A session that names another brand → error log, `{ handled: true }`, nothing read from Stripe (the A11 test passes unedited; the same answer now also covers `async_payment_failed` and `expired`).
  - Subscriptions: ours when a row carries the id, or the metadata says `product: roboapply`. Metadata naming another brand, or a stored row of another brand → `{ handled: false }` and one error line, before any Stripe call.
  - Invoices: see the deviation below.
  - One function decides what Stripe may change, `stripeMayChange(row)`: brand `roboapply` or no brand (old rows). It guards the one place a subscription is written (`upsertFromSubscription`), the attach path, the pass and pack fulfilment, `invoice.paid`, `invoice.payment_failed` and `invoice.payment_action_required`. PAR-6 finding 10 is closed.
  - `checkout.session.async_payment_failed` and `.expired`: one info log, `{ handled: true }`, nothing else, even if the session claims to be paid.
  - The default branch (registry dispatch) is unchanged. `charge.refunded` and `charge.dispute.created` have no case in the switch.
- **Deviation (documents win over the item):** the item says invoices are ours "only when `findBillingOwnerByCustomer` finds a row". As built, `invoice.paid` and `invoice.payment_failed` stay ours when a row carries the invoice's subscription id (today's rule, and a subscription id is unique on the account), and the customer lookup decides only where no row carries it. `invoice.payment_action_required` is decided by the customer alone, as the item says. Strategy 5.1 asks for foreign objects to be ignored; both forms do that, and the stricter one would drop a renewal for a row that has the subscription id but an older or missing customer id.
- Tests: `integration/stripeWebhook.route.test.ts` (two secrets, a third → 400, both variable names, trimming, a blank first variable, no secret, the rail is open on exactly the secrets the route verifies with). `integration/stripeWebhook.events.test.ts`: every one of the fourteen types with another product's object → handled false, no row changed, no Stripe call, no mail (directly and over HTTP, 200); goapply-branded sessions for all four session types; a goapply row under every subscription and invoice type; the two log-only events.

### 2. [P0] Subscription events: created attaches, every event re-reads, price first, pending updates: done (attach rules reworked after the review)

- `resolvePlanFromStripe`: `planKeyForPrice(price)` first, metadata second, the legacy map last. The pinned test "subscription metadata still wins over the price" is rewritten to the new truth.
- `customer.subscription.created`: only for our subscriptions. The row is found by `metadata.seekerProfileId`, then by the customer; id, customer and state are written, credits none.
- `updated`, `deleted`, `pending_update_applied`, `pending_update_expired`: `stripe.subscriptions.retrieve(id)` first, then the sync with credit mode `none`. A re-read failure is a failed event (500).
- `checkout.session.completed` keeps its claim; its body is `applyCheckoutSession(session, stripe)`, shared with item 3.
- **The attach rules (`attachRefusal`, one function, used by `created`, the first paid invoice and the Checkout Session).** A subscription that no row carries is put on a row unless: it has ended; its first payment is still open (`incomplete`); the row is on another subscription that is still running (tier not free, status active / trialing / past_due, period end in the future); or the row holds a running pass and this is not the first fulfilment of a Checkout Session. A refusal changes nothing, claims nothing for credits and answers `{ handled: true }`. A row of another brand is refused before these rules, with `{ handled: false }`.
- **Deviation 1 (strategy 5.1 "on every subscription event, re-read"):** `created` is re-read too. A late `created` after an update would otherwise roll the row back.
- **Deviation 2:** a `deleted` event whose subscription Stripe no longer knows (`resource_missing`) is ended from the event's own snapshot. Deleted is final, so there is nothing newer to miss; every other re-read failure answers 500.
- **Addition 1, needed for "the three events in any order grant once":** the first paid invoice (`billing_reason: subscription_create`) of a subscription on no row attaches it, when the invoice's customer is ours. It is also what activates a subscription whose `created` event was refused as `incomplete`.
- **Addition 2, same acceptance line:** claim `billing:subcreate:<subscriptionId>` (see review finding 5 for who forces).
- Only `created` (and the first invoice, and the Checkout Session) attaches. Any other event of a subscription on no row answers `{ handled: false }` without asking Stripe, so a `deleted` of a replaced subscription cannot end a pass.
- `invoice.payment_failed` re-reads too (review finding 1). The item left it on the event's word; that was the hole.
- Tests (`stripeWebhook.events.test.ts`, 129 tests in all): created + `invoice.paid` activates once without `checkout.session.completed`; all six orders of the three events; a stale update does not roll back; a portal price change records plan key, interval, amount and price; `pending_update_applied` and `_expired`; deleted → free; re-read failure for all five types, also over HTTP (500); plus the review blocks listed above. `RoboApplyBillingService.stripe.test.ts` (64): existing cases adapted through one helper (`subscriptionEvent`), which sets Stripe's current copy on the fake; "a failed renewal marks past_due and emails once" now sets Stripe's copy to `past_due`.

### 3. [P0] Lost-event recovery for one-time payments: done

- `POST /billing/checkout/reconcile` (`requireAuth`), body `{ sessionId }` matching `/^cs_[A-Za-z0-9_]{8,200}$/`, zod strict, 422 otherwise.
- `reconcileCheckoutSession(userId, brand, sessionId)`, in this order: brand without the Stripe rail → 403 with no Stripe call and no rate-limit hit; rate limit; no client → 503; account of another brand → 403 with no Stripe call; `checkout.sessions.retrieve` (`resource_missing` → 404, other failure → 502); ownership → 403 with no detail; not paid → `pending`, no side effect; else `applyCheckoutSession` under `billing:checkout:<session>`.
- Ownership as the item says: `metadata.product`, brand roboapply or absent, `metadata.userId === userId` (strict, `client_reference_id` does not count), mode payment or subscription, and the account's Stripe customer when it has one.
- Contract as written: `{ status: 'fulfilled' | 'already_fulfilled' | 'pending', mode, planKey }`; errors 403, 404, 422, 429, 503, 502. The answer has exactly three fields.
- **After the review:** an old subscription session of the caller's own (its subscription ended, or the row has moved on to another subscription or a pass) answers `already_fulfilled` and changes no row. A subscription session whose first payment is still open answers `pending`.
- Rate limit: 10 a minute per user, key `rl:<brand>:billingReconcile:user:<id>`, `Retry-After` header on 429. It fails open, like the Alipay order limit: a limiter that cannot answer must not block the recovery of a paid order.
- A paid session that cannot be fulfilled (unknown plan key, no row for a subscription) answers `pending` with a warning, never `fulfilled`.
- Tests: `routes/billing.stripe.test.ts` (42 tests: pass, pack in both orders, subscription, unpaid, seven refusal shapes, 404, 502, 503, ten invalid bodies, the limit, no session object in the answer); `stripeWebhook.events.test.ts` (reconcile then webhook, webhook then reconcile, both at the same moment, old sessions).
- `routes/billing.test.ts` is not edited.

### 4. [P1] Mails the webhook owes: done (first-invoice rule and plan name reworked after the review)

- New template `billing.payment_action_required` (`{ planKey: string | null, amountMinor, currency, hostedInvoiceUrl }`), in `BILLING_EMAIL_TEMPLATES`; one button, to the hosted invoice page. With no known paid plan it uses `billing.paymentActionRequired.bodyNoPlan`.
- `invoice.payment_action_required`: owner by customer; the first invoice of a subscription is not mailed; else claim `billing:payaction:<invoice.id>`, one mail, no state change. Without a hosted invoice URL: no mail and **no claim**, so a later event that carries the link still mails.
- Portal cancellation: in the re-read path, when Stripe says `cancel_at_period_end` true, the row said false, the subscription has not ended and `metadata.cancelSource` is empty: claim `billing:cancel:<subId>:<period end unix>`, then `sendCancelConfirmation` once. An empty string counts as empty (MKT-2C's resume writes `''`).
- `billing.payment_failed` (existing mail): now sent only when Stripe's current copy of the subscription is `past_due`, still once per invoice (`billing:payfail:<invoice>`).
- Tests: send counts for the mails, replays, two concurrent deliveries, an unknown customer, the in-app cancel through the real `cancelPlan` (exactly one mail), the webhook overtaking our own row update, a stale "cancelling" event, a send failure not failing the event, the four sources of the plan name.

### 5. [P1] Customer portal configuration by code; payment-method-update flow: done

- New `platform/billing/stripePortal.ts`: `ensurePortalConfiguration(stripe, brand, env)`. Settings as the item lists them; `subscription_update` off; metadata `{ product: 'roboapply', configHash }` (first 16 hex of the SHA-256 of the settings, key order fixed). Lookup: memory per Stripe client → `configurations.list({ active: true, limit: 100 })` (up to 5 pages) → `configurations.create(..., { idempotencyKey: 'portalcfg:<hash>' })`. The default configuration is never read as such or changed.
- `createPortalSession(userId, brand, { flow })` passes `configuration` on every session and `flow_data` when asked. `POST /portal` parses `{ flow?: 'payment_method_update' }` (strict); a missing body is accepted (MKT-2E sends none).
- Added: a Stripe failure now answers 502 `payment_provider_error` (the contract's code; it was an unwrapped 500). A brand without the Stripe rail answers 409 `no_customer` with no Stripe call.
- `STRIPE_BILLING_PORTAL_URL` is read nowhere (grep: the only mention is the env-example test that asserts its absence).
- Tests: `stripePortal.test.ts` (16), `routes/billing.stripe.test.ts` (`POST /portal` with and without flow, 409, 503, 502, four invalid bodies, GoApply).

### 6. [P0] POST /billing/switch passes "payment needs action" through: done

- `quoteSwitch` and `confirmSwitch` are in `BillingServiceDeps` with the platform functions as defaults. `switchPlan` reads `requiresAction` and `hostedInvoiceUrl` through a local structural type and answers `{ switched: false, requiresAction: true, hostedInvoiceUrl: <value or null>, planKey }`, else `{ switched: true, planKey }`. An empty or non-string URL becomes `null`. The route and `SwitchBodySchema` are unchanged.
- Compiles against today's `confirmSwitch` and against MKT-2C's `ConfirmSwitchResult` (the type is an intersection with optional members).
- Tests: `RoboApplyBillingService.stripe.test.ts`, block '"payment needs action" is passed through…' (6 tests).

### 7. [P1] Read-only check of the webhook endpoint: done, plus the two price checks of the carry-over

- New `platform/billing/stripeHealth.ts`: `EXPECTED_STRIPE_EVENTS` (fourteen), `checkStripeWebhookEndpoint(stripe, { origin? })` → `{ checked, url, missingEvents, reason? }` exactly as the contract. With several enabled endpoints on our path: the one at `origin` when given and present, else the one that misses the most events (review finding 6). It never throws and makes no write call.
- The "every type is handled" test asks the webhook instead of reading a list: a type the service handles itself never reaches a registered handler, the two refund types do.
- **Carry-over 3:** `checkStripePrices(stripe, env)` → `{ checked, pinsChecked, lookupKeysChecked, issues, reason? }`. (a) each pinned price is retrieved once and compared with the catalog (amount, currency, recurrence, active): `pin_mismatch`, `pin_archived`, `pin_not_found`. (b) each unpinned plan is listed by lookup key without the `active` filter: `synced_archived` when only an archived price holds the key, `synced_mismatch` when the active one differs. Reports only. MKT-4B can show it next to the endpoint check.
- Tests: `stripeHealth.test.ts` (44).

### 8. [P1] The legacy ¥-pass reminder links to GoApply: done

- `renewalReminderEmail`, manual + legacy branch: one more paragraph and a second button to `getBrand(t.brand.otherBrand).canonicalOrigin + '/pricing'`, only when the recipient's brand is roboapply and the currency is CNY (any case). No host is written in the template.
- **Small deviation:** the staged string says `%OTHER_BRAND%`, not the literal "GoApply" (the copy rule; it renders "GoApply").
- Tests: `billing.test.ts` (the three cases of the item, plus: the first button still goes to the reader's own plan page, no "Pro" or "another pass", seven shapes that must not carry the line).

### Carry-over (waveM1-carryover.md, section MKT-2B)

| # | Entry | State |
|---|---|---|
| 1 | Second half of item 1 (constant + test line; whitespace) | done; a whitespace-around secret verifies, one with whitespace inside still does not (its test untouched) |
| 2 | Price-first, keep metadata second | done |
| 3 | `stripeHealth.ts`: pinned prices, archived synced price | done (`checkStripePrices`) |
| 4 | Brand written without reading the row | done |
| 5 | Seam shapes; import by file path | followed (`stripePortal.js` and `stripeHealth.js` are imported by path) |
| 6 | `STRIPE_BILLING_PORTAL_URL` read nowhere | confirmed |

wavePAR-carryover "Market waves", payments 8: the Stripe webhook brand rule is done here. `/billing/history` capped at 50 is in my file but belongs to ST-10 (MKT-4B): left.

## Files changed

Modified:
- `server/src/roboapply/routes/stripeWebhook.ts`
- `server/src/roboapply/routes/billing.ts`
- `server/src/roboapply/services/RoboApplyBillingService.ts`
- `server/src/platform/billing/stripeEnv.ts`
- `server/src/platform/billing/stripeEnv.test.ts`
- `server/src/platform/email/templates/billing/index.ts`
- `server/src/platform/email/templates/billing/billing.test.ts`
- `server/src/platform/billing/integration/stripeWebhook.route.test.ts`
- `server/src/platform/billing/integration/RoboApplyBillingService.stripe.test.ts`
- `server/src/i18n/email/staging/billing.en.json`

New:
- `server/src/platform/billing/stripePortal.ts`, `stripePortal.test.ts`
- `server/src/platform/billing/stripeHealth.ts`, `stripeHealth.test.ts`
- `server/src/platform/billing/integration/stripeWebhook.events.test.ts`
- `server/src/roboapply/routes/billing.stripe.test.ts`

Touched in the review round: `RoboApplyBillingService.ts`, `stripeHealth.ts`, `stripeHealth.test.ts`, `templates/billing/index.ts`, `templates/billing/billing.test.ts`, `staging/billing.en.json`, `stripeWebhook.events.test.ts`, `RoboApplyBillingService.stripe.test.ts`.

Not edited: `fulfilPass.ts`, `rails/alipayWorker.ts`, the Alipay callback route, `handleAlipayCallback`, `routes/billing.test.ts`, any `A<n> …` test. `holdCnOrderRateLimit` (the limit in front of the Alipay rail, not part of the frozen path) calls a shared `holdRateLimit`; same key, windows, log line and error.

## Tests run

| Command | Result |
|---|---|
| The eight test files I own | 8 files, 366 tests passed |
| `npx vitest run server/src/platform/billing server/src/roboapply -t "A[0-9]+ "` | 53 passed in 7 files; none edited |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 679 files passed; 15,958 passed, 1 skipped, 10 todo; 0 failed |

Mutation checks: 18 single-line mutations of the first round's logic and 18 of the review fixes (listed under "Review resolution"), each caught.

## Red tests for other bundles

None.

MKT-2C listed three assertions of `RoboApplyBillingService.stripe.test.ts` as red on its tree (`subscriptions.update` gets a third argument). I own that file and changed them to compare the first two arguments (`switchUpdate()`), so they hold before and after MKT-2C merges. Not run against MKT-2C's code (another worktree).

## Pre-existing failures

None.

## Requests

**Orchestrator**
1. `stripeEnv.test.ts`: the test is still named "the route does not try every secret yet (flip this with the route change, MKT-2B item 1)" and its `describe` and comment block still describe the interim state, while the assertion is `toBe(true)`. I was allowed one line. Rename it, e.g. "the route tries every secret (MKT-2B item 1)".
2. `MARKET_TASK_PLAN.md` 3.1 (row "Stripe env helpers") and section 5 (the M1 webhook-secret row) lose their interim wording. The event table of `MARKET_STRATEGY.md` 5.1 can name the claim `billing:subcreate:<sub>` and say that `invoice.payment_failed` re-reads the subscription and that the first invoice of a subscription sends neither the failure mail nor the payment-action mail. The contract row of `checkStripeWebhookEndpoint` can name the optional second argument `{ origin }`.
3. At the M2 merge, run `server/src/platform/billing/integration` and `server/src/roboapply/routes/billing.stripe.test.ts` on the merged tree: the switch tests meet MKT-2C's `confirmSwitch`, and the in-app cancel test meets its `cancelSubscription`.

**MKT-2C**
- `confirmSwitch` spreads the subscription's metadata while it sets `cancel_at_period_end: false`, so a `cancelSource` from an earlier in-app cancel survives a switch. A later portal cancellation is then taken for our own and gets no mail. Send `cancelSource: ''` in that update, as resume does.

**MKT-2E**
- Nothing to change. As built: `POST /portal` accepts a missing body; reconcile answers 403 on a GoApply host; `planKey` in a `pending` answer is the session's plan key or null. New: reconcile of an old subscription session answers `already_fulfilled`, and a subscription session whose first payment is still open answers `pending`.

**MKT-4B**
- `checkStripeWebhookEndpoint` and `checkStripePrices` are in `platform/billing/stripeHealth.ts`, imported by path. Both return `checked: false` with a reason and never throw.
- Call `checkStripeWebhookEndpoint(stripe, { origin })` with the public origin Stripe delivers to for this deployment (RoboApply's canonical origin). The comparison is exact on scheme, host and port: an endpoint registered on `www.` does not match the apex origin, and the check then reports the worst endpoint on the path.
- `HANDLED_STRIPE_EVENTS` is exported from the billing service if the panel wants to show it.
- `/billing/history` paging (ST-10) is yours in M4.

**MKT-5H**
- `.env.example`: the interim sentences about one webhook secret can go (carry-over, MKT-5H item 1). A list is accepted now.

**Later owner of `platform/ratelimit/defaults.ts`**
- Optional: a named entry `billingReconcile` (10 per minute). Today the windows are a constant in the service (`CHECKOUT_RECONCILE_WINDOWS`), so `RATE_LIMITS_JSON` cannot override it.

**Owner**
- The Dashboard endpoint must be subscribed to the fourteen event types. Six are new in this bundle: `customer.subscription.created`, `customer.subscription.pending_update_applied`, `customer.subscription.pending_update_expired`, `invoice.payment_action_required`, `checkout.session.async_payment_failed`, `checkout.session.expired` (the two `charge.*` types are MKT-2D's). A missing type is silent: Stripe never sends it.
- A restricted key needs write access to the customer portal configuration (first portal session creates it) and read access to webhook endpoints and prices for the health checks.
- Watch the log line "stripe subscription not attached: the row is on another running subscription" (error level). It means one buyer paid for two subscriptions at once; the second one has to be cancelled and refunded by hand in the Dashboard. Nothing in the app does that.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET`, `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` | redefined: each accepts a comma-separated list. The webhook tries every secret, the RoboApply name first; each value is trimmed. A list no longer keeps the rail closed | unset = plans listed, `payments_disabled` |
| `STRIPE_BILLING_PORTAL_URL` | read nowhere; keep it out of the examples (the portal configuration is created by code) | n/a |

No new variable.

## i18n keys added or changed

`server/src/i18n/email/staging/billing.en.json` (email strings, English):

| Key | English |
|---|---|
| `billing.renewalReminder.goapplyLine` | In mainland China? You can pay in RMB with Alipay on %OTHER_BRAND%. |
| `billing.renewalReminder.ctaGoapply` | See %OTHER_BRAND% prices |
| `billing.paymentActionRequired.subject` | Confirm your %BRAND% payment |
| `billing.paymentActionRequired.heading` | Your bank needs you to confirm this payment |
| `billing.paymentActionRequired.body` | The payment of {price} for {plan} is waiting for your confirmation. Open the payment page to finish it. Nothing is charged until you confirm. |
| `billing.paymentActionRequired.bodyNoPlan` (new in the review round) | A payment of {price} is waiting for your confirmation. Open the payment page to finish it. Nothing is charged until you confirm. |
| `billing.paymentActionRequired.cta` | Confirm payment |

For the locale sync (`server/src/i18n/email/zh.json` is not edited): `goapplyLine` 在中国大陆？可在 %OTHER_BRAND% 用支付宝以人民币付款。 `ctaGoapply` 查看 %OTHER_BRAND% 价格. Until the sync every locale shows the English text.

No web namespace touched.

## Known gaps

- **Nothing was seen against Stripe.** Not verified there: the portal configuration parameters; that `prices.list` without `active` returns archived prices; the shape of a restricted key's permission error (the check accepts type `StripePermissionError`, status 403, code `permission_denied`); the event orders named at the top.
- **The failure mail depends on Stripe's copy being `past_due` when the event is handled.** I expect Stripe to move the subscription and send `invoice.payment_failed` together. If the re-read ever still said `active`, the row would reach `past_due` through the following `customer.subscription.updated`, but the failure mail for that invoice would not be sent. The banner (row state) is not affected.
- **Two running subscriptions for one buyer are only logged.** When a second Checkout Session is paid while the row is on a running subscription, the row keeps the first and the second keeps charging at Stripe until someone cancels it (see the owner request). Before the review the second one took the row and the first kept charging; neither is good, the new one keeps the buyer's access stable.
- **A subscription bought now replaces a running pass.** The reviewer's list said "do nothing when the row holds a running pass"; I kept the pass rule for late events and old sessions only. A session fulfilled for the first time is money that just arrived for a subscription that is live at Stripe; not attaching it would charge the buyer for nothing once the pass ends. The remaining pass days are lost, as before this bundle. Checkout already refuses a subscription while a pass runs, so this needs two sessions open at once.
- **With a pass running and `checkout.session.completed` lost, the first paid invoice does not attach** (the pass rule applies to events). The return-page reconcile attaches it (first fulfilment); without either, the subscription stays off the row.
- **A bare price id on an invoice line names a plan only when it is a pinned id.** A synced price is recognised by its metadata or lookup key, which a thin line does not carry; the plan key stamped on the subscription answers next, then the customer's row.
- **For a plan switch that needs 3-D Secure, the mail names the plan on the row**, which is the plan the buyer is switching from (the row is asked first, as the review specified).
- **Portal cancellations are recognised by `cancel_at_period_end` only.** If the account's API version reports a portal cancellation as `cancel_at` (a timestamp) instead, the row and the mail do not see it. `upsertFromSubscription` reads the same field today.
- **A stale `cancelSource` hides a later portal cancellation.** After an in-app cancel followed by "renew" in the portal, or by a switch (see the MKT-2C request), the marker is still on the subscription and the next portal cancel gets no mail. The claim key also includes the period end, so cancel, resume and cancel again in one period mails once.
- **A mail is claimed before it is sent.** If the send fails after the claim, it is not sent again. The cancel confirmation swallows the failure; the payment-action and payment-failed mails fail the event, and the retry is then a duplicate.
- **Two concurrent deliveries of one subscription checkout can both call the plan grant.** The claim is single and the end state is one; the grant sets the practice balance to the plan's allowance (it does not add), so the second call writes the same balance. The cause is the existing "tier changed" force in `upsertFromSubscription`. A pass and a pack are strictly once (transaction and idempotency key).
- **The first-period test allows one hour** between the subscription's `start_date` and its current period start. A subscription whose first period starts later than that (a custom billing anchor; checkout does not set one) gets the period-guarded grant, as before the review.
- **One portal configuration per distinct origin.** The legal links are built from the app origin, so a preview or local origin gets its own configuration on that Stripe account. Old ones are left active.
- **The health checks are not wired to a route** (MKT-4B). The price check needs `prices` read permission and makes one retrieve per pin and one list per ten lookup keys.
- **The reconcile limit and the checkout text are English-only server strings** (`Too many payment attempts`, `This payment does not belong to you`); the web maps the codes.
- **`HANDLED_STRIPE_EVENTS` is a declared list.** The health test checks the behaviour through the registry for all fourteen types, so a case removed from the switch is caught; a new case added without the list is not.
