FIX-9 · Database transactions, credits and billing plumbing — updated handoff after review

Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-9` (branch `wp/FIX-9`). All three original findings are fixed, three of the four review findings are resolved, and all gates are green. The fourth (a busy database still answers a bare 500) needs `server/src/platform/http.ts`, which I do not own; it is under Requests with the exact change. Nothing was committed, pushed or stashed; no schema, DDL or DML was touched; no unowned file is modified. Nothing was run in a browser or against the real database, so the new SQL has not run on Neon.

## Review resolution

1. **[MEDIUM] `credits_busy` is not a registered error code — real, not fixable inside my owns → Request.**
   - Confirmed: `isErrorCode('credits_busy')` is false, so `mapError` answers 500 `internal_error`. All 14 production callers of `withCredit`/`reserve` are in other groups' features and go through `mapError`.
   - I did not smuggle the code through an `HttpError` subclass or reuse `rate_limited` / `ai_unavailable`; both would misreport what happened.
   - On my side the error already carries what `mapError` reads (`code`, plain `message`, `retryAfterSec`).
   - I added a contract test in `CreditService.test.ts` that is skipped today and starts running once the code is registered. It asserts 503, `credits_busy`, `details.retryAfterSec: 5`, and that the database error is not leaked.
2. **[LOW] Commit/release retries could hold a finished request 30–60 s — fixed.**
   - Root cause: retries were bounded by count only, and each attempt inherited the client-wide 10 s `maxWait` / 20 s `timeout`.
   - `CreditStore.transaction(fn, limits?)` now takes per-call limits. The settle step (commit, release, practice-claim settle) uses `SETTLE_TX_LIMITS` (`maxWait` 3 s, `timeout` 5 s).
   - `retryWhenBusy` takes a time budget (`SETTLE_BUDGET_MS`, 6 s): no new attempt starts once the time used plus the next wait reaches it.
   - Resulting waits: about 6.2 s when transactions cannot start (two attempts); one attempt of at most 8 s when one starts and expires; 11.2 s in the worst mixed case. Before: 30–60 s.
   - Reserve keeps the client-wide limits.
   - Tests: `store.test.ts` +3, `CreditService.test.ts` +4, `practice.test.ts` +1.
3. **[LOW] "Nothing used yet." for an account whose only use is a practice interview — fixed at the root.**
   - `history()` now also reads `MockInterviewCreditLedger` rows with reason `debit_interview` and `delta < 0`, merged with the metered ledger newest first.
   - Paging: `limit + 1` from each table, two-way merge, cursor on the last row shown. The cursor gains an optional `|p` marker for a practice row; old cursors still decode. Ids are never compared across tables, so a same-instant tie across a page break neither repeats nor drops a row.
   - **Rejected one detail:** the suggested `ceil(abs(delta))`. Practice credits are pro-rated to hundredths, so a 15-minute session takes 0.75; "1 used" would overstate it and disagree with the "0.25 left" row above. The row shows the real amount.
   - Grants, expiries, admin adjustments, zero debits and other users' rows stay out.
   - Tests: `credits.test.ts` +2 (both failed first), `credits.test.tsx` +1.
4. **[LOW] Two time zones in one card — fixed.**
   - "Recent use" rows are now formatted in the same account zone as the refill labels.
   - Rows wait for the summary, so a timestamp is never shown in one zone and then moved.
   - Test: `credits.test.tsx` +1 (New York account, failed first).

Unowned edits: none to revert.

## Per-finding result (original findings)

### 1. [HIGH] Intermittent 500s from Prisma transaction timeouts — fixed, except the wire code (Request)
- **Root cause:** every client ran with Prisma's defaults (`maxWait` 2 s, `timeout` 5 s). A fresh pooled Neon connection alone takes about 2 s and the pool is small (10 locally, 1 on Vercel). The credit reserve made 5 round trips inside its transaction, and a busy database surfaced as an unlogged 500.
- **Client-wide** (`server/src/lib/prisma.ts`): `transactionOptions` is `maxWait` 10 s, `timeout` 20 s on every client. Env overrides: `PRISMA_TX_MAX_WAIT_MS`, `PRISMA_TX_TIMEOUT_MS`, `PRISMA_POOL_MAX`.
- **Shorter credit transactions** (`store.ts`, `CreditService.ts`, `memoryStore.ts`): the window reserve is one `INSERT … SELECT … ON CONFLICT DO UPDATE … WHERE … RETURNING`; `setLedgerSource` and `settleLedger` are single `UPDATE … RETURNING *`. A window reserve is 3 statements (was 5); commit and release are 2 (was 3).
- **Fail fast and log** (`errors.ts`, `store.ts`): P2028, P2024 and the pool connect timeout become `CreditStoreBusyError` (`credits_busy`, 503, `retryAfterSec: 5`, original error as `cause`). The store logs every non-domain transaction failure with code, message and elapsed time.
- **Behaviour to be aware of:**
  - Reserve is never retried; a busy database fails it and the action does not run.
  - Commit and release retry inside the bounded settle step described above.
  - If the action succeeded but the commit cannot be written, `withCredit` returns the result and logs an error. That use is not charged; `jobs-maintain` releases the reservation.
  - A practice grant whose settle fails after the credit was added reports `granted` and logs.
- **Tests:** `prisma.transactionOptions.test.ts` (4), `store.test.ts`, `CreditService.test.ts`, `practice.test.ts`.

### 2. [MEDIUM] First page load 500 on /billing/plan or /credits — fixed
- **Root cause:** `resolveSeeker` in `server/src/lib/mockCreditService.ts` read "no subscription" and then called `upsert`; two parallel first requests both inserted and the loser threw P2002.
- **Fix:** the free row is created with `createMany({ skipDuplicates: true })` and then read by `seekerProfileId`.
- **Test:** `mockCreditService.race.test.ts` (4; 3 failed before the fix).

### 3. [LOW] Credits panel: grant listed as use; bare weekday for daily reset — fixed
- **Grant under "Recent use":** `RACreditLedger` rows in the `practice` bucket are grant claims, never uses, and are excluded. Real practice interviews are now listed from the practice ledger (review item 3).
- **Bare weekday:** `refillLabel` in `components/features/credits/labels.ts` formats in the account zone: time only for today, the locale's word for tomorrow plus the time, or weekday with date. `OutOfCreditsSheet.tsx` uses the same helper. "Recent use" now uses the same zone (review item 4).

## Files changed
- `server/src/lib/` — `prisma.ts`, `mockCreditService.ts`, `prisma.transactionOptions.test.ts` (new), `mockCreditService.race.test.ts` (new)
- `server/src/platform/credits/` — `store.ts`, `memoryStore.ts`, `CreditService.ts`, `errors.ts`, `practice.ts`, `index.ts`, `store.test.ts`, `CreditService.test.ts`, `practice.test.ts`
- `server/src/features/credits/` — `service.ts`, `contract.ts` (comment), `routes.ts` (comment), `credits.test.ts`
- `components/features/credits/` — `CreditsUsage.tsx`, `OutOfCreditsSheet.tsx`, `labels.ts`, `__tests__/credits.test.tsx`, `__tests__/pure.test.ts`

## Tests run
- Owned suites (`server/src/platform/credits`, `server/src/features/credits`, `server/src/lib`, `components/features/credits`): 26 files, 386 passed, 1 skipped (the `credits_busy` contract test), 1 todo.
- `npx vitest run --exclude ".claude/**"`: 586 files, 11861 passed, 2 skipped, 10 todo, 0 failed.
- `npm run typecheck:server`: clean.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: exit 0 (design, copy, llm-costs, api-boundary, extension, zh-variants).
- Extension gates not run; `extension/` was not touched.

## Requests
- **Owner of `server/src/platform/http.ts` / orchestrator (closes review item 1):**
  - Add `credits_busy: 503` to `ERROR_STATUS`.
  - Add `credits_busy: 'We could not start this right now. Try again in a moment.'` to `DEFAULT_ERROR_MESSAGES`.
  - In `mapError`'s duck-typed branch, change `code === 'rate_limited' ? retryAfterFromDetails(details) : undefined` to also cover `credits_busy`, so `Retry-After: 5` is sent.
  - Add a route-level test for 503 + `credits_busy` + `Retry-After` on a reserve that throws `CreditStoreBusyError`. My skipped contract test then runs by itself.
- **Owner of `lib/api/client.ts` / orchestrator:** `normalizeCode` folds any unknown 5xx code into `server_error`, so the client cannot tell `credits_busy` from a crash. Add a retryable code for it and a localized "busy, try again" message in all nine locales. I staged no string because nothing in my owns would use it; `credits.busy` in the `credits` namespace is the natural key.
- **Orchestrator (`.env.example` / deploy docs):** document `PRISMA_TX_MAX_WAIT_MS` (default 10000), `PRISMA_TX_TIMEOUT_MS` (default 20000) and `PRISMA_POOL_MAX` (default 10, or 1 on Vercel). Consider 3–5 on Vercel: with one connection, an interactive transaction blocks every other query in that instance.
- **Orchestrator (`docs/jobright-clone/ARCHITECTURE.md` §7.3):**
  - Step 3 is now one `INSERT … SELECT … ON CONFLICT DO UPDATE … WHERE` statement, and no window row is created when the units do not fit.
  - Commit/release use `SETTLE_TX_LIMITS` and `SETTLE_BUDGET_MS`.
  - `/credits/history` also lists practice-interview debits.
- **G4:** still needs to log `fixIssue` failures, as the original finding notes. G2, G5 and G3 need no change.

## i18n keys added or changed
None. `i18n/staging/credits.en.json` is unchanged. Practice rows reuse `credits.buckets.practice` and `credits.usage.used`.

## Known gaps
- Until the `http.ts` request lands, a busy reserve still answers 500 `internal_error` on the wire (now logged with its cause), after waiting up to the 10 s `maxWait`.
- Part of the reported latency (10 s `/auth/me`, 5–20 s saves) is the Neon branch itself. The new limits stop it becoming 500s but do not make it faster.
- A practice interview that used part of a credit reads "0.75 used" / "已用 0.75 次". That matches the balance row but is slightly awkward with "次"; a dedicated string would need a staged key.
- English reads "Refills tomorrow 12:00 AM" with no "at", to avoid a new string showing in English in eight locales until translated.