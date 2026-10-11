# MKT-4A

Self-service withdrawal endpoints (signed in and on the public cancel link) and consent retention after account deletion (server). Worktree `wp-MKT-4A`, branch `wp/MKT-4A`. Nothing committed. No schema change, no env variable, no new dependency, no Stripe or database call outside the fakes. This is the handoff after the independent review: the "Review resolution" list at the end says what changed since the first handoff.

**Gate state:** every test in my files is green (218 passed); `npm run typecheck:server` and `npx next typegen && npm run typecheck:web` pass; `npm run check` passes; `npm run eval:match -- --enforce M2` exits 0. The full suite has **2 red tests outside my owns that item 3 makes unavoidable** (a web test requires a label in `i18n/messages` for every retention rule id; see "Red tests for other bundles"). No test named `A<n> …` was touched and all 43 are green. No path outside my owns is edited.

**Three behaviours added by the review round, each in a file I own (say if one should not ship):**
1. A withdrawal the buyer confirmed that fails at the payment provider keeps its instant for 14 days: sent again, it is decided as of that instant (same eligibility, same amount, same Stripe keys), and the signed-in page keeps listing it.
2. An ordinary cancellation of a plan that a completed withdrawal already ended answers "nothing left to cancel" in the seconds before the plan row says so (before: a doomed Stripe update, 502).
3. The account purge ends a subscription that still runs at Stripe before it deletes the plan row, and holds the account when it cannot.

## Items

### 1. [P0] Signed-in withdrawal: quote, then confirm — done

- `GET /api/v1/roboapply/credits/withdrawal` and `POST` on the same path (seeker auth, `billingRoute`). `CreditsAreaService.withdrawalQuote(userId, brand)` and `withdraw(userId, brand, body)` call `withdrawalQuotes` and `withdrawPurchase` of the refund engine (imported from the billing index), with actor `'self'`. The engine runs on the service's own database, clock, Stripe client (`getStripe`), mailer and entitlement cache (`refundEngine()`), so nothing in the credits area decides who may withdraw or how much goes back.
- GoApply: both routes answer without a database read or a Stripe call when the request's brand does not list the Stripe rail (`available: false` / 409). The engine refuses a GoApply account a second time.
- `POST` is limited to 3 an hour per user (`WITHDRAWAL_LIMIT`, key `rl:<brand>:withdrawal:user:<id>`, 429 with `Retry-After`). A body that fails validation does not use the allowance. Entitlements are invalidated when the withdrawal completes and also when it fails after the subscription may already be cancelled at Stripe.
- Wire shape as the contract says, plus one additive member (see "Where item and documents disagreed", 1): `purchases: Array<{ purchase, quote }>`, every open purchase, the latest first. `purchase` and `quote` are its first entry. The sibling's reader (`wp-MKT-4C/lib/api/account.ts`, read only) reads `purchases` with exactly this shape and falls back to the pair.
- **A withdrawal that failed at the payment provider (review finding 2).** The buyer exercises the right when they confirm. When Stripe then fails (the purchase cannot be read, the subscription cannot be ended, or it is ended and the refund does not go through; 502), `runWithdrawal` writes one claim `billing:withdraw-declared:<purchase>` (`claimBillingEvent`, `refType: 'stripe_withdrawal_declared'`, `settledAt` = the instant). While it holds, 14 days (`WITHDRAWAL_DECLARATION_DAYS`):
  - `POST` for that purchase runs the engine with its clock set to that instant, so the 14-day rule and the pro-rata days are those of the first request, the refund key is the same (`refund:<pi>:<amount>:withdrawal`), and the mail and the completion claim are dated at the declaration;
  - it is counted under its own limit, `WITHDRAWAL_RETRY_LIMIT` (10 an hour, key `rl:<brand>:withdrawal:retry:user:<id>`), so three provider failures in a row do not lock the buyer out, and a loop is still bounded (every attempt reads Stripe);
  - `GET` lists the purchase at the amount quoted then, also after its own 14th day, with `quote.deadline` = declaration + 14 days (the last moment it can be sent again). MKT-4C's pages hide an entry whose deadline has passed (`WithdrawContract.tsx`, `PublicCancelFlow.tsx`), so with this value they keep showing it and need no change.
  - A refusal is never kept (409 stale id, past the 14 days, 503 no card payments, 409 `refund_refused`). Another account's claim under the same key is not read. A completed or staff-refunded purchase drops out (the engine's own checks).
- Admin `refundQuote`: the paid period goes into `computeRefund`, so the day-5 buyer with the waiver is quoted 25/30. The period is the invoice's own subscription line (never a proration line); the Stripe subscription is read with `stripePeriod` only for an invoice without a line, and a failed read gives the quote without the period. Also: Stripe is asked only for an account Stripe serves (rule A11 was missing here), and the buyer's country falls back to the invoice's customer address, as in the engine.
- Tests: `withdrawal.test.ts` (57 tests, route harness + `createFakePrisma` + fake Stripe through `setStripeClientForTests`): every ACCEPT line, the order "cancel, then refund" with both idempotency keys, two overlapping POSTs, the pack that does not hide the plan, the weekly plan on day 10, the rate limit, 422 / 503 / 502; and for the declared withdrawal: the refund fails ten minutes before the 14th day ends and the request sent again after it returns the quoted amount under the same keys; the same moment without a first request is refused; a retry on a later day refunds the days first quoted; a failed read keeps the instant too; three failures do not use up the allowance; the retry limit; the 14-day end; no instant after a refusal; a pack listed beside a declared plan. `credits.test.ts`: six admin-quote cases.

### 2. [P0] Withdrawal without signing in: preview and withdraw through the cancel link — done

- `POST /api/v1/public/cancel/preview { token }` validates the link with the same function confirm uses (`usableCancelLink`: kind, brand, not used, not expired) and never claims it. Answer: `{ planKey, accessUntil, withdrawal: { refundMinor, currency, rule, deadline } | null }`; 410 `cancel_token_invalid` otherwise.
- `POST /confirm { token, withdraw?: boolean }`: the link is claimed first, as before. With `withdraw: true` the service runs `withdrawPurchase` (actor `'public_link'`) for the plan's purchase and answers `{ status: 'cancelled', accessUntil: null, alternative: null, withdrawal: { status: 'withdrawn', refundMinor, currency } }`. When no withdrawal is open any more it runs the ordinary cancellation and adds `withdrawal: { status: 'not_available', refundMinor: null, currency: null }`. A provider failure releases the link. Without `withdraw` (or with `false`) the answer has exactly today's three fields.
- The link offers the withdrawal of the **plan** only: the latest open purchase whose plan renews.
- **A failed withdrawal through the link** keeps its instant like the signed-in one (from the moment the plan's purchase is known): the same link finishes it after the purchase's 14th day at the quoted amount, the preview keeps offering it, and once the link has expired the signed-in page lists it and finishes it.
- **A plan withdrawn elsewhere (review finding 5).** After a completed withdrawal the plan row stays active until `customer.subscription.deleted` is processed. `runCancel` (the one place the service runs the ordinary cancellation: the link with and without `withdraw`, and signed-in `POST /credits/cancel`) first asks `endedByWithdrawal`: a completion claim of this user in the last 28 days whose invoice belongs to the subscription the row names. Then the answer is `no_subscription`, which the link turns into `already_cancelled` (with `withdrawal: not_available` when it asked to withdraw) and the signed-in route answers as 409, exactly as both do once the row has ended. Stripe is not asked to change a subscription that is gone. A withdrawn pack does not match; a subscription bought since does not match; one database read when nothing was withdrawn lately and no Stripe read; a failed check never holds a cancellation up.
- Tests: `withdrawal.test.ts` (preview does not use the link up, 410 cases, both choices, `not_available`, Stripe failure, plan not pack; "the plan was withdrawn elsewhere" with the plan row kept active and the cancel dependency failing as Stripe would: 7 cases; the failed withdrawal through the link: 2 cases). The existing public cancel cases of `credits.test.ts` are unchanged and green.

Decisions the item did not state:
1. **A preview never fails because of Stripe.** If the purchase cannot be read, the answer is 200 with `withdrawal: null`, so the cancel page still works (§312k). Confirm with `withdraw` in the same situation answers 502, keeps the link and does **not** cancel at period end in place of the withdrawal the buyer asked for.
2. **One link may ask Stripe for its quote 20 times** in its 30 minutes (`PUBLIC_CANCEL_PREVIEW_LIMIT`); past that the preview answers with the cancellation only.
3. **A refund the provider itself refuses after the cancel** is answered 409 `withdrawal_not_available` with `details.reason: 'refund_refused'` on both routes, instead of the engine's `refund_not_available`, which is not in the contract.
4. **A declaration holds 14 days, for every provider failure.** 14 days is the time a seller has to pay a withdrawal back. It is written for a failure before the subscription was ended too (legally the buyer declared in time), which is why it must end: without an end, a buyer whose subscription was never cancelled at Stripe would keep a withdrawal at an old amount for as long as they liked. After 14 days it is a case for staff. See Owner 4.
5. **A declared purchase is always decided at its declared instant** (GET and POST agree); the live reading is not tried as a second chance.
6. **Retries are limited (10 an hour), not unlimited.** The reviewer proposed skipping the limit; the idempotency keys bound the writes at Stripe, not the reads.

### 3. [P1] The renewal acknowledgement outlives the account — done

- New `server/src/platform/billing/consentArchive.ts`: `billingConsentRetainUntil(consentedAt, subscriptionEndedAt, now)`, the pure mapping `billingConsentArchiveRows`, and `archiveBillingConsents(db, userId, now, options?)`, which writes with `createMany({ skipDuplicates: true })` (the orchestrator's note). It selects only `consentType`, `proseHash`, `proseVersion`, `createdAt` of a record: the IP address and the user agent are never read. The email is stored as sha256 of the trimmed, lower-cased address.
- `SeekerAccountPurgeService.ts`: `purgeUser` calls it after the stored files are confirmed gone and before any row is deleted. If the copy throws, the account is not deleted on that run. The sweep summary and the logs carry `billingConsentsArchived`.
- **The purge ends a subscription that still runs (review finding 3; new step 4).** Closing an account only soft-closes the profile, so a subscriber who never cancelled is still charged, and the plan row is the only pointer to the subscription. Before the proof is copied, `endRunningSubscription` cancels it at once: `stripe.subscriptions.cancel(id, {}, { idempotencyKey: 'purge:<id>' })` through `getStripe` (imported from `platform/billing/stripeClient.js`). Only for a RoboApply account whose plan row is not GoApply's, names a Stripe subscription and does not already say `canceled`. A subscription Stripe reports as cancelled or does not know holds nothing up. When Stripe cannot be asked (`stripe_not_configured`) or does not confirm (`subscription_not_ended`) the account is **kept for the next run**, like a stored file that cannot be deleted. Nothing is refunded (Owner 3). The archive then states `subscriptionEndedAt = now` (new option of `archiveBillingConsents`; a row that already carries its own end keeps it), so "1 year after the subscription ends" has a real end. Summary field `subscriptionsEnded`.
- `retention.ts`: new rule `billing_consent_archive` (compliance-daily, by brand, in batches, `retainUntil < now`), `rABillingConsentArchive` added to `RetentionDb`, English and Chinese notice labels, and the `billing_consent_records` row now says a proof stays after deletion. `BILLING_CONSENT_KEEP` stays 36 months, derived from the archive's 3 years; `BILLING_CONSENT_TYPES` is the archive's list, re-exported.
- Tests: `consentArchive.test.ts` (23), `SeekerAccountPurgeService.consent.test.ts` (20: copy before delete, a failed delete finished by the next run with the rows written once, a blocked purge copies nothing, a failed copy deletes nothing, GoApply, `purgeAccountNow`; and the subscription step with a fake Stripe client: ended before the copy under its key, Stripe down or not set up keeps the account, already cancelled and unknown subscriptions, past due and cancel-at-period-end, a repeated run, a blocking file comes first, GoApply never reaches Stripe), `retention.test.ts` (40).

Two refinements to the item's date rule, both on the side of keeping longer:
1. **A plan that is still paid for at deletion and that the purge did not have to end** (a pass, a plan with no Stripe subscription) has not ended: the year is counted from the end of the paid period, and `subscriptionEndedAt` stays null on the row.
2. **Calendar years in UTC; 29 February lands on 1 March**, a day late rather than a day early.

## Where item and documents disagreed (the documents won)

1. **A withdrawal is per purchase** (`waveM2-carryover.md` MKT-4A.1a, strategy 4.4 "as built"). The item's contract has one `purchase` / `quote` pair; I kept it and added `purchases`.
2. **The admin quote's period** comes from the invoice line, not from the subscription (`waveM2-carryover.md` MKT-4A.4, MARKET_TASK_PLAN "as built"); the item says to read the subscription.
3. **Idempotent archive**: the unique key and `skipDuplicates` (orchestrator note, MKT-0 O-6), not "skip when rows for that userId exist".

## Carry-over

| Entry | What I did |
|---|---|
| M1 MKT-4A.1, M2 MKT-4A.8: PAR payments 11 (`RABillingRefund` retention) | Left as built at the M0 gate: the purge deletes the user's refund rows. Keeping them is an owner decision; no retention rule added. |
| M1 MKT-4A.1, M2 MKT-4A.8: PAR payments 12 (unique key on the archive) | Done: `createMany({ skipDuplicates: true })`; tests emulate the compound key and fail on a plain create. |
| M1 MKT-4A.2, M2 MKT-4A.6: three optional members of `PlansResponse` | Done: `checkout.collectingEntity`, `refundPolicy`, `studentOffer` are required and `PlansResponseSent` is gone. `typecheck:web` is clean. |
| M2 MKT-4A.1, 1a, 2, 3, 9 | Done as described in items 1 and 2. |
| M2 MKT-4A.1b (is a plan switch a purchase?) | Not decided (Owner 21). The endpoints ship the engine's rule as built; two tests in `withdrawal.test.ts` pin it and name the decision: the signed-in quote, and the link (it refunds the switch invoice only and ends the whole subscription). `stripeRefunds.test.ts` is not mine. Owner 1. |
| M2 MKT-4A.4 (admin quote) | Done. |
| M2 MKT-4A.5 (consent withdrawal must delete vectors) | Left: `features/compliance/consents.ts` is in no M4 owns list. Orchestrator 3 has the exact change. |
| M2 MKT-4A.7 (`explainMatch` "Your profile does not show …") | Left: `features/compliance/explainMatch.ts`, its two callers and the `legal` namespace are not mine. Orchestrator 4 has the exact change. |
| M3 | No section for MKT-4A. |

## Files changed

Edited:
- `server/src/features/credits/contract.ts`
- `server/src/features/credits/routes.ts`
- `server/src/features/credits/service.ts`
- `server/src/features/credits/credits.test.ts`
- `server/src/roboapply/services/SeekerAccountPurgeService.ts`
- `server/src/features/compliance/retention.ts`
- `server/src/features/compliance/retention.test.ts`

New:
- `server/src/features/credits/withdrawal.test.ts`
- `server/src/platform/billing/consentArchive.ts`
- `server/src/platform/billing/consentArchive.test.ts`
- `server/src/roboapply/services/SeekerAccountPurgeService.consent.test.ts`

Written outside the worktree: this handoff only (`/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-4A.md`).

## Tests run

| Command | Result |
|---|---|
| `npx vitest run` on my five test files | 218 passed, 1 todo (pre-existing): `withdrawal.test.ts` 57, `credits.test.ts` 78, `consentArchive.test.ts` 23, `SeekerAccountPurgeService.consent.test.ts` 20, `retention.test.ts` 40 |
| `npx vitest run server/src/platform/billing` (inside the full run) | 29 files, 967 passed |
| `npm run typecheck:server` | pass |
| `npx next typegen && npm run typecheck:web` | pass |
| `npm run check` | pass (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` (final run) | 732 files: 731 passed, 1 failed. 18,452 tests passed, 2 failed, 1 skipped, 10 todo. Both failures are listed below. The 43 `A<n> …` tests pass. |

The new tests were checked against the code they hold: with `endedByWithdrawal`, the declaration read, the declaration write, the separate retry limit or the subscription tie switched off in turn, the tests named for that behaviour fail and no other.

## Red tests for other bundles

Both in `components/features/compliance/compliance.test.tsx` (no M4 owner: orchestrator). Cause: the item adds the published rule id `billing_consent_archive`, and this file reads the server's `RETENTION_RULES` and requires a web label for every id. I may not edit `i18n/messages` or a staging namespace I do not own.

1. `RetentionTable: the rows added in WP-93 > renders every rule with a label, and the new rows with their period and how they end`. Green once `legal.retention.rows.billing_consent_archive` exists in `i18n/staging/legal.en.json` (the test helper merges staging over `en.json`). The test itself needs no change.
2. `RetentionTable: the rows added in WP-93 > the en and zh bundles label every rule and every way a row ends`. Reads `i18n/messages/en.json` and `zh.json` directly, so it is green only once the key is in both bundles. The assertion stays as written.

Until the key exists, Settings → Privacy shows the raw key `retention.rows.billing_consent_archive` in that row. The strings are under Orchestrator 1.

## Pre-existing failures

None that repeats. One wall-clock test failed in one of three full runs and passed in the other two and alone (94 of 94): `server/src/features/cn/jobs/__tests__/text.test.ts` > `time: proportional to the length of the posting > unclosed scripts (500 KB) is read in milliseconds` (313 ms against a 250 ms limit while sibling suites ran on the machine). Not my file, not touched, same kind as the timing tests noted in `waveM2-carryover.md`.

## Requests

**Orchestrator**

1. **Add the web label of the new retention row at the M4 gate** (fixes both red tests; review finding 1). `legal.retention.rows.billing_consent_archive`:
   - en: `Proof of those records after you delete your account: your account ID, a hash of your email address, the payment customer ID, what you agreed to and when. No IP address or browser details. Kept for 3 years after you agreed, or until 1 year after your plan ended if that is later`
   - zh: `注销账户后保留的上述记录凭证：账户编号、邮箱地址的哈希值、支付客户编号、你同意的内容及时间；不含 IP 地址和浏览器信息。自同意之日起保存 3 年；若套餐结束后满 1 年的日期更晚，则保存至该日`
   - Both go into `i18n/staging/legal.en.json` / `legal.zh.json` and, for the second test, into `i18n/messages/en.json` and `zh.json` under `legal.retention.rows`. They are the sentences the privacy notices already print (`retention.ts`, `rowsEn` / `rowsZh`).
   - Consider rewording `legal.retention.enforced.minimum` ("Kept at least this long; deleted with your account"): the records still go with the account, but a proof now stays. `compliance.test.tsx` pins the current sentence for `billing_consent_records`.
2. **Cancel the plan when the account is closed (review finding 3, the half outside my owns).** The purge now ends a running subscription, but only when it runs: 30 days after the request. In between a monthly plan renews once and a weekly plan four times. In `server/src/roboapply/routes/account.ts` `POST /delete`, before `seekerAuthService.softDeleteAccount(userId)`: `await cancelPlan(userId, { source: 'in_app' }).catch(...)` (`RoboApplyBillingService`; `no_subscription` and a GoApply account are not errors here; a provider failure should be logged and must not block the deletion, the purge is the backstop). The deletion dialog and the `account deleted` mail should then say the plan will not renew (copy: `account` / mail namespaces, not mine).
3. **Vectors on consent withdrawal** (carry-over M2 MKT-4A.5; review finding 4). `server/src/features/compliance/consents.ts`, `recordConsent`, after the transaction and before the `closing` enqueue:
   ```ts
   if (!input.granted && input.brand.market === 'cn' && (def.type === 'ai_resume_parsing' || def.type === 'personalized_recommendation')) {
     const { deleteUserEmbeddings, deleteJobEmbeddingsOfOwner } = await import('../retrieval/index.js');
     await Promise.all([
       deleteUserEmbeddings(input.userId, 'cn'),
       ...(def.type === 'ai_resume_parsing' ? [deleteJobEmbeddingsOfOwner(input.userId, 'cn')] : []),
     ]).catch((err) => logger.warn('COMPLIANCE', 'consent withdrawn: vectors not deleted now; the retrieval sweep removes them', { userId: input.userId, type: def.type, error: err instanceof Error ? err.message : String(err) }));
   }
   ```
   Best effort: the sweep's consent step stays the backstop. The file does not import `logger` yet (`../../services/LoggerService.js`). Both helpers are mocked in the consent tests (one case per type, one for a grant, one for RoboApply: no call).
4. **`explainMatch`** (carry-over M2 MKT-4A.7). `server/src/features/compliance/explainMatch.ts`: add `missingSide?: Partial<Record<MatchDimensionKey, 'posting' | 'person'>>` to `ExplainMatchInput`; for a `not_stated` part in `NOT_COMPARED_KEYS` emit `legal.explain.notStated.<part>` when the side is `'posting'`, the new `legal.explain.profileMissing.<part>` when it is `'person'`, and `legal.explain.notCompared.<part>` when it is not given (today's line). Callers: `features/feed/defaultService.ts` and `features/jobs/detail/defaultService.ts` pass it from `Fit.confidenceReason` / `postingStates(job)`. Three new keys in `legal` (en and zh staged): `legal.explain.profileMissing.title_level` "Your profile does not show a role to compare.", `.industry` "Your profile does not show an industry to compare.", `.logistics` "Your profile does not show a location, pay or work setup to compare.". Low impact; nothing is false today.
5. **Export engine helpers so the copies can go** (`platform/billing/stripeRefunds.ts` and `subscriptions.ts` have no M4 owner): `invoicePaidPeriod` (copied as `invoiceLinePeriod` in `features/credits/service.ts`); one shared `stripeServesAccount(account)` (now four places: the engine's `isRoboApplyAccount`, `RoboApplyBillingService`, `features/credits/service.ts`, and the inline rule in the purge); `withdrawalClaimKey` and its `refType` (`features/credits/service.ts` repeats the literals `'withdraw:'` and `'stripe_withdrawal'` in `WITHDRAWAL_DONE_KEY` / `WITHDRAWAL_DONE_REF`; `withdrawal.test.ts` breaks if the engine's key changes); `cancelSubscriptionNow` and `isStripeMissing` (the purge has its own short version).
6. **Two root fixes the service works around, if you prefer them in the platform:** (a) `cancelSubscription` (`platform/billing/subscriptions.ts`) could answer `already_cancelled` itself when Stripe refuses the update because the subscription is cancelled; `endedByWithdrawal` could then go. (b) The engine could keep the declaration itself (the reviewer's alternative: persist the instant in `withdrawPurchase`, read it in `openWithdrawalFor`); the service's `declaredAt` / `pendingDeclarations` could then go and the instant could be written only when the cancel really went through.
7. **Documents** (no owner after M3): `STRIPE_TEST_RECIPE.md` 5.1 row 11 and scenario i can drop "Available after phase M4"; add the public route (`POST /api/v1/public/cancel/preview`, and `/confirm` with `withdraw: true`) and one scenario "refund fails after the cancel, send again". MARKET_TASK_PLAN contract rows "Withdrawal (signed in)" and "Withdrawal (public cancel link)": as built, add `purchases: Array<{ purchase, quote }>`, the `refund_refused` reason, `accessUntil: null` after a withdrawal, "preview answers `withdrawal: null` when Stripe cannot be read or after 20 previews of one link", "a 502 keeps the instant for 14 days; `quote.deadline` of that purchase is the declaration plus 14 days; retries are counted apart, 10 an hour", and "a cancel after a completed withdrawal answers `already_cancelled` / 409 `no_subscription`". Runbooks: the account purge now needs a usable Stripe key in the deployment that runs `/api/v1/cron/account-purge` for RoboApply accounts, and reports `subscriptionsEnded`; a held account logs `purge blocked` with `stripe_not_configured` or `subscription_not_ended`.
8. **MKT-0 O-1 text** for `RABillingConsentArchive` in `schemaInvariants` ("compliance-daily deletes it at retainUntil") is true; nothing to change.

**MKT-4C**

1. `PlansResponse` now requires `checkout.collectingEntity`, `refundPolicy` and `studentOffer`. A new `PlansResponse` literal in a web test without them fails `typecheck:web` after the merge (your fixtures already carry all three; `withoutBillingFacts` casts on purpose).
2. `GET /credits/withdrawal` sends `purchases` (your `normaliseWithdrawal` already reads it). After a `POST`, trust `accessEnded: true`: the plan row itself changes when `customer.subscription.deleted` is processed, so a plan read in the same second can still say Pro.
3. Public confirm after a withdrawal answers `accessUntil: null`. A 409 `withdrawal_not_available` can carry `details.reason: 'refund_refused'` on both routes: show the same "can no longer be withdrawn" message and read the plan again.
4. Preview can answer `withdrawal: null` although one is open (Stripe unreadable, or more than 20 previews of one link). The page is then today's page; that is intended.
5. **After a 502 on `POST /credits/withdrawal` or on confirm with `withdraw`: keep the entry and let the buyer send it again.** The server keeps the instant; `GET` and the preview keep listing the purchase at the same amount with a `deadline` up to 14 days after the first request (later than the purchase's own 14th day). Your "deadline in the future" filters already show it; no change is needed. Do not word the deadline as "14 days after you bought" on that entry. A retry over its limit answers 429 with `Retry-After: 3600`.
6. `POST /credits/cancel` right after a withdrawal now answers 409 `no_subscription` (before: 502). The public confirm answers `already_cancelled` in that case, with `withdrawal.status: 'not_available'` when it asked to withdraw: show "already cancelled", not an error.

**MKT-4B**

1. `refundQuote` no longer asks Stripe for an account or a plan row of another brand, and `facts.billingCountry` can come from the invoice. `RefundQuoteResponse` is unchanged in shape.
2. `CreditsDb` gained `$transaction` and `rABillingRefund` (the engine runs on it). The real client has both.
3. The admin quote still describes the **latest charge**. For a weekly subscriber on day 10 that is the renewal, while the buyer's own withdrawal quote covers both weeks. If the console should show what the buyer sees, add `withdrawalQuotes(userId)` next to the quote.
4. **A withdrawal that was declared and not completed is one ledger query**: `RACreditLedger` rows with `refType: 'stripe_withdrawal_declared'` (`refId: 'withdraw-declared:<invoice>'`, `settledAt` = when) that have no row `billing:withdraw:<invoice>`. Worth a line in the console: the buyer's subscription may be ended with nothing refunded yet. A full admin refund of that invoice closes it (the engine stops listing the purchase once the `charge.refunded` row is in).
5. `AccountPurgeSummary` has a new member `subscriptionsEnded`.

**Owner (with counsel)**

1. **Decision 21 (plan switch as a purchase) is unchanged and now reachable by users on both routes.** Its sharpest consequence is on the cancel link: after a switch the link's withdrawal is the switch invoice, so it refunds the proration amount only and ends the whole subscription (pinned by a test that names the decision).
2. GoApply's `cn_pay_terms_ack` is archived for 3 years like the other two types (the item lists it). Confirm against PIPL data minimisation. Removing the type is one entry in `BILLING_CONSENT_TYPES`.
3. **The purge ends a running subscription without refunding the unused paid time.** Decide whether it should be refunded pro rata, and confirm that deleting an account should cancel the plan at the request (Orchestrator 2).
4. **A withdrawal confirmed in time and failed at the provider is honoured for 14 more days at the amount first quoted**, also when the provider failed before the subscription was ended, so the buyer kept access until they sent it again. Confirm the 14 days and that reading (`WITHDRAWAL_DECLARATION_DAYS`; one constant).

## Schema requests

None. `RABillingConsentArchive` (MKT-0) is used as delivered, with its unique key. The declaration of a failed withdrawal is a billing claim in `RACreditLedger` (the existing `claimBillingEvent` rows), read through the existing index `(userId, bucket, createdAt)`.

## Env variables added or redefined

None. One operating fact: the account purge needs `getStripe()` to return a client where it runs for RoboApply accounts with a running subscription; without one those accounts are held (`stripe_not_configured`). On a developer machine with the live key that is the case by design (the client factory refuses the key), so such a test account stays soft-closed there.

## i18n keys added or changed

None by me (no namespace). The privacy-notice labels of the retention table are server text in `retention.ts` (English and Chinese): `billing_consent_archive` is new and `billing_consent_records` was extended. The web label is Orchestrator 1.

## Known gaps

1. **No public link for a buyer whose plan no longer renews.** `requestPublicCancel` issues a link only for a live plan that renews (unchanged). That now includes a buyer whose withdrawal through the link failed after the subscription was ended and whose link expired: they finish signed in. Issuing a link for them needs new mail copy ("Cancel my plan" would be wrong).
2. **The plan row ends with the webhook**, not with the `POST`. The cache is dropped at once and the cancel routes answer correctly in between; other reads of the plan (`GET /billing/plan`) say Pro until the event is processed.
3. **Between the deletion request and the purge the subscription still renews** (Orchestrator 2). The purge stops it for good; it does not give back what was charged in between.
4. **A declaration made when nothing was ended yet** (Stripe failed at the read or at the cancel) lets the buyer keep access until they send it again, up to 14 days, and still get the amount first quoted. On a weekly plan with the waiver, a renewal paid in between changes which charge goes back (the engine refunds the latest paid period: that renewal in full, not the unused days first quoted): bounded by one period's price.
5. **The link's own first read failing** (Stripe unreadable before the plan's purchase is known) keeps no instant: if that straddles the 14th day inside the link's 30 minutes, the link falls back to the period-end cancellation and says `not_available`.
6. **A made-up purchase id sent while Stripe cannot be read** leaves a declaration (at most 3 an hour). It never withdraws anything; it costs one more Stripe read per `GET` for 14 days (the five newest declarations are looked at).
7. **Nothing was seen against Stripe**: every call is asserted on the fake. Assumptions that matter: Stripe refuses to update a cancelled subscription (the cancel paths no longer depend on it); a refund request Stripe answered with a server error is replayed under the same idempotency key for 24 hours, so that withdrawal can be finished the next day (the declaration holds 14); a retry by another actor (the link first, then signed in) sends the same key with other metadata, which Stripe answers with an idempotency error if it stored the first request (the engine then finds the existing refund or answers 502 until the key expires). The last two are the engine's key design (MKT-2D), unchanged. `STRIPE_TEST_RECIPE.md` row 11 and scenario i are the live checks.
8. **The admin quote** does not know about earlier refunds or a completed withdrawal and looks at one charge (MKT-4B 3).
9. **A user deleted by the phone-merge path** (`auth-cn` `bind`) is deleted without the archive step and without the subscription step. Such an account is minutes old and GoApply's; if a purchase is possible there, the merge needs the same calls.
10. **The 3-an-hour limit** counts refused attempts too (a stale id). Retries of a failed withdrawal are counted apart.

## Review resolution

| Review entry | Verdict | What was done |
|---|---|---|
| Finding 1 (medium): the new retention row has no web label; 2 red tests, raw key in Settings | Real; not fixable inside my owns (no i18n namespace; `i18n/messages` is the orchestrator's) | Unchanged in code. Still the only two red tests of the suite. Orchestrator 1 carries both strings and both places. |
| Finding 2 (medium): a withdrawal that stops between cancel and refund strands the buyer | Real; reproduced by a test that fails without the fix | Fixed in `features/credits/service.ts`: the instant of a failed attempt is kept as a claim, and `withdraw()`, the link and the reads decide at that instant for 14 days; retries have their own limit. Three deviations from the proposed fix, each on purpose: the retry limit is 10 an hour, not none (reads at Stripe are not bounded by idempotency keys); the declaration ends after 14 days (a failure before the cancel also writes it); `GET` and the preview list the declared purchase with `deadline` = declaration + 14 days, without which the web would hide the entry after the 14th day and the buyer could not send it again. 12 new tests. |
| Finding 3 (medium, pre-existing): account deletion never ends a running Stripe subscription | Real | The half in my owns is built: the purge ends the subscription at Stripe before it copies the proof and deletes the row, holds the account when it cannot, and archives with `subscriptionEndedAt = now`. 11 new purge tests, 2 archive tests. The request-time cancel is `roboapply/routes/account.ts` (no owner): Orchestrator 2. The refund of unused time: Owner 3. |
| Finding 4 (medium): consent withdrawal on GoApply does not delete the vectors | Real; `features/compliance/consents.ts` is in no M4 owns list | Not built. Orchestrator 3 has the exact code and the tests it needs. |
| Finding 5 (low): the link's fallback after a withdrawal made elsewhere answers 502; the test hid it with a mock | Real | Fixed at the one place the service cancels (`runCancel`), so the link with and without `withdraw` and the signed-in cancel all answer "nothing left to cancel". Deviation from the proposed fix: "any completion claim of this user in 14 days" would also match a withdrawn pack and answer "already cancelled" for a plan that still renews, so the claim's invoice is tied to the plan row's subscription (one `invoices.retrieve`, only when a recent claim exists). The test keeps the plan row active and makes the cancel dependency fail as Stripe would; 7 cases. |
| Undone: carry-over M2 MKT-4A.1b (plan switch, Owner 21) | Agreed: an owner decision | Left as built. Added the pin the reviewer's note calls for: a link test showing the switch-invoice withdrawal (refunds the proration only, ends the subscription). Owner 1. |
| Undone: carry-over M2 MKT-4A.5 (vectors) | Agreed: outside my owns | Orchestrator 3 (same as finding 4). |
| Undone: carry-over M2 MKT-4A.7 (`explainMatch`) | Agreed: outside my owns (the file, two callers, three `legal` keys) | Orchestrator 4 now states the exact change and the strings. |
| Unowned edits | None found by the reviewer; none made | `git status` lists my eleven paths only. A stray `.vitest/` report directory created by one of my test runs was deleted. |
