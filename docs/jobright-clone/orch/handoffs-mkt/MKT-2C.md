# MKT-2C

Subscription changes on the server: switch with `pending_if_incomplete`, resume, idempotency keys, tax switch (ST-5, ST-6, ST-8). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2C`, branch `wp/MKT-2C`. Nothing committed. No command reached Stripe, a database or any provider: every Stripe object in the tests is a hand-written fake.

This is the complete handoff after the independent review. The last section, "Review resolution", says what was done about each finding.

**Precedence.** The three items and the plan documents agree with each other. I departed from them in two places, on purpose; both need the owner's eye:

1. The Stripe idempotency key of cancel and resume carries two more parts than `cancel|resume:<subId>:<periodEnd>` (item 2, "Departure").
2. With `STRIPE_TAX_ENABLED` on, a switch quote asks for automatic tax only when the subscription already carries automatic tax, not for every subscriber as item 3 says literally (item 3, "Departure"). This came out of the review.

Everything else is built as written.

## Items

### 1. [P0] A plan switch changes the plan only if the proration is paid (ST-5): done

`server/src/platform/billing/subscriptions.ts` `confirmSwitch`:

- The `subscriptions.update` call adds `payment_behavior: 'pending_if_incomplete'` and a second argument `{ idempotencyKey: 'switch:<subId>:<planKey>:<prorationDate>' }` (`switchIdempotencyKey`, exported). It keeps `items`, `proration_behavior: 'always_invoice'`, `proration_date`, `cancel_at_period_end: false` and `metadata`. A test pins the whole parameter object with `toEqual`, so a parameter added later fails it.
- The metadata now also carries `cancelSource: ''` (review finding 2). A switch turns renewal back on, and a cancelled, still running plan can be switched, so the switch clears our cancel marker exactly as "Keep my plan" does. Without it a later cancellation in Stripe's portal would get no confirmation mail from MKT-2B, which recognises a portal cancellation by the absence of the marker. Stripe removes a metadata key that is set to an empty string; for a subscription that never had the marker it changes nothing.
- Return type `ConfirmSwitchResult` (exported): `{ planKey, stripeSubscriptionId, requiresAction: boolean, hostedInvoiceUrl?: string | null }`, the field names of the contract. With `pending_update` on the answer: `latest_invoice` id (string or expanded object) → `invoices.retrieve` → `{ requiresAction: true, hostedInvoiceUrl }`. Otherwise `{ requiresAction: false }` with no `hostedInvoiceUrl` key.
- `hostedInvoiceUrl` is `null` (with `requiresAction: true`) when Stripe names no invoice, the invoice has no hosted page, or the read fails. The plan is unchanged in every one of those cases.
- One addition: if the invoice behind a `pending_update` is already `paid`, the answer is `requiresAction: false`. Reason: a repeated confirm of the same quote gets Stripe's stored first answer for that key, which still shows the pending update after the buyer paid. This path is reached only in the short time before the webhook writes the new plan to our row. After that a repeated confirm is refused earlier with 409 `switch_not_available` ("You are already on this plan"), without a Stripe call and without a consent record. A test pins each of the two cases. A page therefore reads the plan again after payment; it does not confirm again (request to MKT-2E, corrected).
- A Stripe failure on the update is now `payment_provider_error` (502) instead of an unwrapped error (500 `switch_failed` on the legacy route); an idempotency conflict carries `details.reason: 'idempotency_conflict'`, as checkout does.
- The acknowledgement is still recorded before Stripe is asked to charge. `confirmSwitch` writes nothing to our row (it never did): the webhook does.

**Parameter list checked against the installed SDK (stripe 23.0.0, API `2026-09-30.endive`), as the item asked.** `SubscriptionUpdateParams.PaymentBehavior` includes `'pending_if_incomplete'`. The types do not encode which parameters a pending update accepts, so I read the object that holds one: `Stripe.Subscription.PendingUpdate` has `billing_cycle_anchor`, `cancel_at_period_end`, `discount`, `discounts`, `expires_at`, `metadata`, `subscription_items`, `trial_end`, `trial_from_plan`. The SDK changelog adds `metadata` to `Subscription.pending_update` in 22.2.0 and `cancel_at_period_end` in 23.0.0. So both parameters we send are supported and are HELD in the pending update. That differs from the item's note for the reader ("Stripe applies metadata at once even while the price is pending"): by the types, metadata waits with the rest. It does not matter for correctness, because MKT-2B resolves the plan from the price first. `automatic_tax` is NOT a field of `PendingUpdate`, so it is not sent on the update (item 3).

Tests (`subscriptions.test.ts`): paid proration (full parameters, key, `requiresAction: false`); declined (answer shape, our row identical before and after, `describePlan` still `pro_monthly`); expanded `latest_invoice`; unreadable invoice, no hosted page, no invoice; repeated confirm after payment before the webhook; repeated confirm after the webhook wrote the plan (409, one Stripe call in total, nothing recorded); a plan cancelled in the app is switched with `cancel_at_period_end: false` and `cancelSource: ''` while the rest of Stripe's metadata is kept; same quote twice sends the same key and the same parameters, a new quote a new key; quote and charge share price id and `proration_date`; a TWD subscription switches only to a TWD price (quote and confirm); a Stripe failure is 502 with the acknowledgement already recorded.

### 2. [P0] Resume: "Keep my plan" (ST-6): done, with one departure

`subscriptions.ts` new `resumeSubscription(account, deps, ack)` and types `ResumeAck`, `ResumeCharge`, `ResumeOutcome`:

- `nothing_to_resume` (409) unless: `describePlan` says live, the row has a `stripeSubscriptionId`, `cancelAtPeriodEnd` is true, and the plan definition renews. So: no plan, a plan that still renews, a period that ended, a subscription Stripe ended, a pass, a legacy subscription (no definition, so no terms to acknowledge) are all refused. Also refused before any Stripe call: an account or a row whose brand does not list `stripe` (rule A11). That guard is needed, not decorative: `planDefinitionFor` falls back to RoboApply's definitions, so a GoApply row with a renewing plan key would otherwise pass.
- Then `auto_renew_ack_required` (422) without the box, then `rail_not_configured` (503) without a client. Nothing is recorded in any refused case.
- `ack.record({ planKey, interval, amountMinor, currency })` runs BEFORE the Stripe call, with `row.amountMinor` / `row.currency`. One addition: when the row has no amount or currency (the webhook leaves them empty on a thin event), the subscription is retrieved and its price is used; if Stripe names none either, the answer is 502 with `details.reason: 'renewal_price_unknown'` and nothing is recorded. A consent that names no price proves nothing, and the catalog amount can differ from an older subscriber's price.
- `stripe.subscriptions.update(id, { cancel_at_period_end: false, metadata: { cancelSource: '' } }, { idempotencyKey })`, then the row gets `cancelAtPeriodEnd: false`. A failed Stripe call leaves the row cancelled and answers 502.
- `cancelSubscription`: its update call now carries an idempotency key. Its parameters are unchanged (a test pins them with `toEqual`).

`features/credits`:

- `contract.ts`: `ResumeSubscriptionBodySchema = z.object({ autoRenewAck: z.literal(true) }).strict()`, `ResumeSubscriptionBody`, `ResumeResponse`, two entries in `CREDITS_ERROR_CODES`.
- `routes.ts`: `POST /resume` on `createCreditsRouter`, and `parseResumeBody`. The schema alone would answer a missing box with 422 `invalid_request`; the contract says 422 `auto_renew_ack_required`. So a body that holds nothing but a missing or non-true `autoRenewAck` gets the billing code, and any other bad body (an unknown field) stays `invalid_request`.
- `service.ts`: `CreditsAreaService.resume(userId, brand, body, { ip, userAgent })` with `loadBillingAccount`, `resumeSubscription` (imported by file path), `recordCheckoutAcknowledgements` and `invalidateEntitlements`. An account of the other site, or one with no profile, gets `nothing_to_resume`. No mail is sent.

Contract as built, identical to `MARKET_TASK_PLAN.md` 3.1: `POST /api/v1/roboapply/credits/resume { autoRenewAck: true }` → `{ status: 'resumed', planKey, renewsAt: string | null }`; 409 `nothing_to_resume`, 422 `auto_renew_ack_required`, 503 `rail_not_configured`, 502 `payment_provider_error`. `renewsAt` is the end of the running period.

**Departure: the cancel / resume idempotency key.** Built as `<cancel|resume>:<subId>:<periodEndUnix>:v<row updatedAt ms>:b<minute>` (`renewalChangeIdempotencyKey`, exported), not the three-part key of strategy 5.1 and the item. The item and the documents agree with each other here, so this departs from both. The reviewer judged it right on the merits and found no case where the longer key merges two requests that must stay separate. It still needs the owner's yes, and the documents need the key as built (requests below).

- Why. Stripe answers a repeated idempotency key with the stored answer of the first request for at least 24 hours, failures included, and does nothing. Cancel and resume flip one setting back and forth, and the three-part key is the same for every cancel in a period. In our code, after a resume `describePlan` says the plan renews again, so a second cancel calls Stripe with the same parameters (`{ cancel_at_period_end: true, metadata: { cancelSource: 'in_app' } }`) and, with the three-part key, the same key. Stripe would replay the first cancel's answer, we would write `cancelAtPeriodEnd: true`, send the cancellation mail, and the plan would still renew and charge. Second effect: a cancel that Stripe answered with a 500 could not be retried for a day, from the app or from the public cancel link.
- What the two parts do. The row version changes on every write of our subscription row, and every cancel and resume writes it, so a later change of the same kind never repeats a key. The one-minute bucket makes a retry after a failure a new request. Two clicks at once read the same row in the same minute and still send one key.
- What I did not verify. The replay behaviour is Stripe's published idempotency rule as I know it; it was not observed here (no Stripe access). If the owner wants the literal key, it is one function; do not go back to it without solving "cancel, keep, cancel".
- Tests: the exact key for cancel and for resume; "cancel, keep, cancel again in one period and one minute" sends three calls and the second cancel has the same parameters and a different key; two clicks at once send one key; a retry a minute after a failure sends a new key.

Tests: `subscriptions.test.ts` (resume rules as a table of nine refusals, GoApply in three shapes with `getStripe` never called, parameters, key, TWD and quarterly sentences, `past_due` still resumable, the missing-price path, cancel key and failure); `credits.test.ts` (route: 200 with the consent row checked field by field and counted from inside the fake Stripe call, the charged price rather than the catalog price, 409 in three shapes, 422 for four bodies plus `invalid_request` for two, 502, 503, twice, a GoApply account, the other site's host).

### 3. [P1] `STRIPE_TAX_ENABLED`, off by default (ST-8): done, with one departure

- `rails/stripe.ts`: `stripeTaxEnabled(env)` is the one rule (`parseBoolEnv`: `true`, `1`, `yes`, `on`). `checkoutTaxParams(env)` gives `{ billing_address_collection: 'auto' }` when off and `{ automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, billing_address_collection: 'required' }` when on. `customer_update` is unchanged and always sent. Rule A11's brand check is still the first line of `createCheckout`.
- `subscriptions.ts` `quoteSwitch`: `invoices.createPreview` gets `automatic_tax: { enabled: true }` when the switch is on AND the running subscription carries automatic tax (`stripeSub.automatic_tax?.enabled === true`; the subscription is already retrieved for the quote). `StripeDeps` gained an optional `env` (default `process.env`), so no caller changes.
- `confirmSwitch` does NOT send `automatic_tax` on the update: finding under item 1. A subscription created by a tax-enabled Checkout already carries automatic tax.
- The quote that Stripe refuses with `customer_tax_location_invalid` is asked again without `automatic_tax`. After the change above this is a safety net only (a subscription with automatic tax whose customer address has since become unusable). Every other error is thrown as before.

**Departure (review finding 3): the quote asks for automatic tax only when the charge will use it.** The item says "with the switch on, `invoices.createPreview` gets `automatic_tax: { enabled: true }`". Built literally, the quote and the charge are computed under different tax settings for anyone who subscribed before the switch was turned on: the preview would have automatic tax, the update cannot (a pending update does not take the parameter), and the subscription has none. They would agree only while every line is on a tax-inclusive price. Lines on a price the catalog sync did not create (an env pin `STRIPE_PRICE_<PLANKEY>`, or the unused-time credit of a legacy `starter` / `growth` price, which is the main use of the switch sheet) have whatever `tax_behavior` their creator gave them. Stripe would then add tax on top in the preview (the quote differs from the charge, against the ACCEPT line "the quote amount still equals the charge") or refuse the preview with a tax error the fallback does not catch (the subscriber could not switch at all). With the rule as built, quote and charge are computed alike by construction. The ACCEPT line "with the switch on the switch quote asks for automatic tax" holds for every subscription created through a tax-enabled Checkout, which is every subscription sold after the owner turns the switch on. If the owner wants the literal text, it is one condition; then the fallback must be widened to every Stripe tax error and the legacy-price case added to the runbook.

Tests: new `rails/stripe.tax.test.ts` (28): the switch's values; both states for a subscription, the pass and a pack; the two sessions differ only in the three settings; the default env sends exactly the parameter names MKT-1A sent (pinned list for both modes); the price stays the inclusive catalog price; a TWD checkout; a GoApply order is still refused before any Stripe call. `subscriptions.test.ts`: the quote's whole parameter object with the switch off (four values); on with a subscription that carries automatic tax (three values); on with a subscription that has no `automatic_tax` field and with one that has it off (one request, identical to the off request); off with a subscription that carries it (no tax field from us); the location fallback; no retry otherwise; no `automatic_tax` on the update.

### Carry-over (`waveM1-carryover.md`, section MKT-2C)

1. `switchPriceFor` is async and returns `currency`; key and `pending_if_incomplete` are on the update call: done (item 1).
2. `PlansResponse` keeps its three optional members and `PlansResponseSent` stays: left as told, because MKT-2E.1 is not done in this worktree. `refundPolicy.version` is untouched (still the public label).

`wavePAR-carryover.md`, "Market waves": no entry names a file in my owns that is still open (9, `studentOffer`, was built in M1).

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2C/`, all inside the bundle's owns (`git status` shows nothing else):

- `server/src/platform/billing/subscriptions.ts`
- `server/src/platform/billing/subscriptions.test.ts`
- `server/src/platform/billing/rails/stripe.ts`
- `server/src/platform/billing/rails/stripe.tax.test.ts` (new)
- `server/src/features/credits/contract.ts`
- `server/src/features/credits/routes.ts`
- `server/src/features/credits/service.ts`
- `server/src/features/credits/credits.test.ts`

Additive type changes others can see: `SubscriptionRow.updatedAt?: Date | null` (selected by `loadBillingAccount`), `StripeDeps.env?`, and `rails/stripe.ts` exports `isStripeIdempotencyConflict` (was a private function), `stripeTaxEnabled`, `checkoutTaxParams`, `STRIPE_TAX_ENV`.

## Tests run

After the review changes, in the worktree:

| Command | Result |
|---|---|
| `npx vitest run server/src/platform/billing/subscriptions.test.ts` | 60 passed |
| `npx vitest run server/src/platform/billing/rails/stripe.tax.test.ts` | 28 passed |
| `npx vitest run server/src/features/credits/credits.test.ts` | 72 passed, 1 todo (the todo was there) |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | all six checks clean |
| `npx vitest run --exclude ".claude/**"` | 676 files: 675 passed, 1 failed. 15,783 passed, 3 failed, 1 skipped, 10 todo. The 3 are listed below. |
| `npx vitest run -t "A[0-9]+ " --exclude ".claude/**"` | 56 passed in 10 files; no such test edited |

## Red tests for other bundles

All three are in `server/src/platform/billing/integration/RoboApplyBillingService.stripe.test.ts` (MKT-2B), as that file stands on the base. Cause: `subscriptions.update` is now called with a third argument (the idempotency key the item requires), and `toHaveBeenCalledWith('sub_old', expect.objectContaining(…))` compares the whole argument list. The behaviour under test is unchanged.

1. "a verified student gets the quote and the switch at the student price" (base line 469).
2. "charges on confirm with the quoted proration date, after recording auto_renew_ack for the new terms" (base line 641).
3. "a switch on a Taiwan (TWD) subscription records the TWD renewal price it will charge" (base line 662).

**State of MKT-2B's worktree when I finished (read, not run):** its copy of the file no longer uses those three assertions. It has a helper `switchUpdate()` (line 101) that returns the first two arguments of the one update call, and the three tests compare that with `['sub_old', expect.objectContaining({...})]` (lines 501, 673, 694). That form ignores the third argument, and none of the three pins `metadata`, so the added `cancelSource: ''` does not touch them either. If that version merges, the three are green without further change. If the base form comes back, each assertion needs the third argument: `{ idempotencyKey: \`switch:sub_old:student_monthly:${NOW_S}\` }` for 1 and `{ idempotencyKey: \`switch:sub_old:pro_monthly:${NOW_S}\` }` for 2 and 3.

## Pre-existing failures

None.

## Requests

**MKT-2B**

- **New, from the review (medium): a declined switch must not mark the plan `past_due` or send the payment-failed mail.** With `pending_if_incomplete` a declined proration leaves the Stripe subscription `active` with a pending update, but Stripe still attempts the proration invoice and sends `invoice.payment_failed` for it. `handlePaymentFailed` in `server/src/roboapply/services/RoboApplyBillingService.ts` (base lines 981 to 1013; line 1127 in `wp-MKT-2B` when I read it) finds the row by subscription id, writes `status: 'past_due'` whatever the invoice is for, and sends `billing.payment_failed` with the proration amount. I read both copies: neither looks at `invoice.billing_reason`. Effect after a declined switch: `describePlan` reports `paymentFailed` ("Stripe is retrying a failed renewal") and the buyer gets a dunning mail, although nothing is being retried and the renewal is healthy; the row stays `past_due` until a later subscription event syncs it (the pending update expires after about 23 hours). Before this bundle the default payment behaviour really did put the subscription `past_due`, so the handler was right then. Change: in `handlePaymentFailed`, when `invoice.billing_reason === 'subscription_update'`, do not write `past_due` and do not send `billing.payment_failed` (the switch answer and `invoice.payment_action_required` already carry the hosted invoice link); or re-read the subscription and write its real status in place of the fixed `'past_due'`. Test to add: `invoice.payment_failed` with `billing_reason: 'subscription_update'` on an active subscription leaves `status: 'active'` and sends no dunning mail. If MKT-2B cannot take it before the merge, the orchestrator fixes it at the gate in that file. Not observed against Stripe: it is Stripe's normal event for any invoice whose charge fails.
- The three assertions under "Red tests", if the base form is still there at merge.
- `confirmSwitch` now sends `cancelSource: ''` in the switch metadata. A test that pins the whole metadata object of a switch needs that key (none of the three above does).
- `switchPlan`: `confirmSwitch` returns `requiresAction` (always present) and `hostedInvoiceUrl` (present only with `requiresAction: true`, and it can be `null`). Answer `{ switched: false, requiresAction: true, hostedInvoiceUrl: res.hostedInvoiceUrl ?? null, planKey }` in that case (the copy in `wp-MKT-2B` already does). Calling `deps.invalidate` either way is harmless.
- A Stripe failure on the switch update now reaches the route as `payment_provider_error` (502), not as an unwrapped error.
- Both ways renewal comes back, resume and switch, clear our cancel marker with `cancelSource: ''`, so afterwards the subscription has no `cancelSource` key and a later portal cancellation is one without it.
- By the SDK types the metadata of a pending switch is held in `pending_update.metadata` until the invoice is paid. Keep price-first resolution either way.

**MKT-2D** (owner of `platform/billing/index.ts` in M2; optional)

- Export from `./subscriptions.js`: `resumeSubscription`, `renewalChangeIdempotencyKey`, `switchIdempotencyKey`, and the types `ConfirmSwitchResult`, `ResumeAck`, `ResumeCharge`, `ResumeOutcome`. `features/credits/service.ts` imports `resumeSubscription` by file path and can then use the index.

**MKT-2E**

- **Corrected (review finding 4).** The earlier handoff said that confirming the same quote again after paying answers `switched: true`. In the usual case it does not: the webhook writes the new plan within seconds, and a confirm after that answers 409 `switch_not_available` ("You are already on this plan"). So: when the buyer comes back from the hosted invoice page, read the plan again (`GET /credits` or `/billing/plans`); do not confirm again. If the page ever does re-confirm after a `requiresAction` answer, treat 409 `switch_not_available` as "done". As read in `wp-MKT-2E`, `SwitchQuoteSheet.tsx` links to the invoice page and has no re-confirm, so nothing needs to change there.
- Switch: `hostedInvoiceUrl` can be `null` with `requiresAction: true`; show the "finish the payment" state with a fallback (the billing portal) in place of a dead link.
- Resume: a missing or unticked box is 422 `auto_renew_ack_required`; an unknown body field is 422 `invalid_request`. A GoApply account always gets 409 `nothing_to_resume`, so the button belongs to RoboApply's cancelled, still running subscription only. A legacy plan (`starter`, `growth`) also gets 409.

**MKT-3H** (runbook, with the owner's test key)

- Add to `STRIPE_TEST_RECIPE.md`:
  - (a) Switch with card `4000 0000 0000 0341` and with the 3-D Secure card: confirm Stripe accepts `metadata` (with an empty `cancelSource`) and `cancel_at_period_end` together with `pending_if_incomplete` on API version `2026-09-30.endive`, that `pending_update` and an open `latest_invoice` come back, and that paying the hosted invoice applies the plan. In the declined case also check which events arrive: if `invoice.payment_failed` comes with `billing_reason: 'subscription_update'`, the plan must stay `active` in our row and no payment-failed mail may go out (request to MKT-2B above).
  - (b) Cancel, "Keep my plan", cancel again within a minute: the subscription must end with `cancel_at_period_end: true`.
  - (c) With `STRIPE_TAX_ENABLED=true` and a Stripe Tax registration: Checkout shows tax and requires the address; a subscriber created that way gets a switch quote with tax that equals the charge; a subscriber created before the switch was turned on (no automatic tax), including one on a legacy price, still gets a quote, and it equals the charge.
  - (d) Cancel in the app, switch plan, then cancel in Stripe's portal: the portal cancellation sends the confirmation mail (the marker was cleared by the switch).

**MKT-4A** (owner of `features/credits/{service,contract}.ts` in M4)

- `PlansResponse` still has its three optional members (carry-over MKT-2E.1 was not finished here).

**MKT-5H** (final documents and env examples)

- `.env.example`: `STRIPE_TAX_ENABLED` (text under "Env variables"). Not needed in `deploy/cn/cn.env.example`: GoApply never reaches Stripe.
- Once the owner has confirmed the key (below), write it into the documents if the orchestrator has not: `MARKET_STRATEGY.md` 5.1 row "Idempotency keys" (line 346) and `PAYMENTS_AUDIT.md` paragraph "Idempotency keys (Stripe API)" (line 281). Text: `subscriptions.update` (cancel, resume): `cancel|resume:<subId>:<periodEnd>:v<row updatedAt ms>:b<minute>`; reason in one line: Stripe replays the stored answer of a repeated key, so the three-part key would make "cancel, keep, cancel" in one period a no-op at Stripe and would block the retry of a failed cancel for a day. The webhook claim `cancel:<sub>:<periodEnd>` in the same documents (rows "Cancel and resume" and the events table) is a different thing and is unchanged.
- Strategy 5.1 "Tax": with the switch on, a switch quote asks for automatic tax when the subscription carries it (item 3, "Departure"), and a switch does not turn automatic tax on for an older subscription.

**Orchestrator / owner**

- **Owner decision 1:** confirm the five-part cancel / resume key, or ask for the three-part key back (then "cancel, keep, cancel" is open again and must be solved another way first). The documents describe a key the code does not send until they are updated (MKT-5H above, or the orchestrator now).
- **Owner decision 2:** confirm the tax rule for switch quotes (item 3, "Departure"), or ask for the literal item text.
- Gate: if MKT-2B does not take the `handlePaymentFailed` request, fix it at the gate in MKT-2B's file with the test named there.
- Owner, before turning the tax switch on: Stripe Tax activated and registrations added in the Dashboard.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `STRIPE_TAX_ENABLED` | new: a true value (`true`, `1`, `yes`, `on`) adds `automatic_tax`, `tax_id_collection` and `billing_address_collection: 'required'` to every Stripe Checkout Session (subscriptions and one-time payments), and `automatic_tax` to the switch quote of a subscription that carries automatic tax. Needs Stripe Tax and registrations in the Dashboard. RoboApply only. Prices stay tax-inclusive, so the price shown is the price charged | unset = off: no tax field is sent and the billing address stays optional |

## i18n keys added or changed

None. This bundle owns no namespace and adds no user-facing string to the web (error messages in the envelope are English fallbacks; the web shows its own text by `code`).

## Known gaps

- **Nothing was seen against Stripe.** Every parameter type-checks against stripe 23.0.0 and is asserted on a fake.
- **Until MKT-2B's `handlePaymentFailed` knows about switch invoices, a declined switch shows as a failed renewal** (status `past_due`, dunning mail). The plan key is unchanged and nothing is charged; the status and the mail are wrong. This is the one open seam of the bundle and it is not in my files.
- **`pending_if_incomplete` with `metadata` and `cancel_at_period_end`** rests on the SDK types and on strategy section 10. If Stripe refuses the combination, every confirm answers 502, nobody is charged and no plan changes; the repair is to send those two parameters in a second update once the first is applied. MKT-3H scenario (a) settles it.
- **A switch does not turn automatic tax on.** A subscriber from before the tax switch keeps a subscription without automatic tax after a plan change, because a pending update does not take that parameter; the quote is computed the same way, so it still equals the charge. Turning automatic tax on for existing subscriptions is a separate one-time update, not built.
- **The tax-location fallback** matches Stripe's error code `customer_tax_location_invalid` from memory. If the code is different the fallback never runs and such a quote fails as it would have without it. It is now reachable only for a subscription that already carries automatic tax.
- **A legacy subscription (`starter`, `growth`) cannot be resumed in the app**: it has no plan definition, so there are no terms to acknowledge. Stripe's portal still offers its own renew control.
- **Resume has no rate limit.** After a success the next call answers 409 without a write. While Stripe is failing, each attempt writes one consent record (the box was ticked each time), as an abandoned checkout does.
- **The row-version part of the cancel / resume key needs `updatedAt`.** `loadBillingAccount` selects it, and it is the only production path. A `BillingAccount` built by hand gets `v0`, which leaves the one-minute bucket only.
- **One contrived replay remains for switch**: switch A to B, back to A, then confirm the first A to B quote again within its hour. Stripe would replay the first answer. The web asks for a new quote each time the sheet opens, so it sends a new key.
- **`requiresAction` with `hostedInvoiceUrl: null`** is possible (Stripe gave no invoice or the read failed). The server says so honestly; the page needs its own fallback (MKT-2E has one: "Manage payment").
- **A re-confirm after payment answers 409, not success**, once the webhook has written the plan. Kept on purpose: see Review resolution 4.

## Review resolution

The reviewer listed no undone item and no unowned edit; `git status` in the worktree shows only the eight owned paths. Six findings:

1. **(medium) A declined switch marks the plan `past_due` and sends the payment-failed mail: real; moved into Requests, not fixable in my files.** Verified by reading `handlePaymentFailed` on the base and in `wp-MKT-2B`: neither checks `invoice.billing_reason`, both write `past_due` and send the mail for any failed invoice of the subscription. The handler is MKT-2B's file. Added: the request to MKT-2B with the exact change and the test, the gate fallback for the orchestrator, the event check in runbook scenario (a), and a line under Known gaps.
2. **(low) A switch on a cancelled plan kept the old `cancelSource`: real; fixed.** `confirmSwitch` now sends `cancelSource: ''` after the metadata spread. The pinned parameter object has the key, and a new test switches a subscription whose Stripe metadata holds `cancelSource: 'in_app'` and checks `cancel_at_period_end: false`, the emptied marker and the kept rest. Checked MKT-2B's three switch assertions as they stand: none pins metadata. Runbook scenario (d) added.
3. **(low) With the tax switch on, the quote used automatic tax the charge does not use: real; fixed as proposed.** `withTax = stripeTaxEnabled(env) && stripeSub.automatic_tax?.enabled === true`. Tests: on with a subscription that carries automatic tax (the preview asks for it), on with no `automatic_tax` field and with `enabled: false` (one request, identical to the off request), off with a taxed subscription (no tax field from us). The location fallback stays as a safety net. This departs from the literal item text; recorded under item 3 and as owner decision 2.
4. **(low) The handoff told MKT-2E that a re-confirm after paying answers `switched: true`: real; the request is corrected, and the behaviour is now pinned by a test.** New test: once the webhook has written the new plan, confirming the same quote again is 409 `switch_not_available` with no second Stripe call and no consent record. The existing "paid" test is renamed to say it covers the time before the webhook. I did NOT take the optional server change (answer success in `confirmSwitch` when the account is already on the target plan). Reasons: it would change the answer of a call that two parallel bundles consume after they wrote their code; "confirm" on a plan you already have would report a switch with no charge and no acknowledgement, which is a weaker statement than the refusal; and the page does not need it (`SwitchQuoteSheet.tsx` in `wp-MKT-2E` links to the invoice page and never re-confirms). If the owner prefers the kind answer, it is three lines in `confirmSwitch`.
5. **(low) The cancel / resume key departs from strategy 5.1 and PAYMENTS_AUDIT and the documents are not updated: accepted as stated; no code change.** The reviewer agrees with the key on the merits. I do not own the documents. The handoff now says plainly that this departs from item and documents alike, asks the owner to confirm (owner decision 1), and gives MKT-5H / the orchestrator the exact rows, lines and text. Runbook scenario (b) is kept.
6. **(low) Three MKT-2B tests go red on merge: real on the base; already resolved in MKT-2B's worktree as it stands now.** In my worktree the three still fail, because my copy of MKT-2B's file is the base one (reproduced: 3 failed of 15,797 in the full run). The reviewer saw two-argument `toHaveBeenCalledWith` at lines 490, 662 and 683 of `wp-MKT-2B`; when I read it, the file had moved on to the `switchUpdate()` helper, which compares the first two arguments only. Both forms and the keys are under "Red tests for other bundles". I did not run MKT-2B's tests against my code (that would need its file in my worktree), so this rests on reading the helper.
