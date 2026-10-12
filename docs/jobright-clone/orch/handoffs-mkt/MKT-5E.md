# MKT-5E

GoHire bank over the syndication endpoint: the validated wire contract, the hardened HTTPS adapter, the mirror read for live cross-bank search, the contract document for the second repository and the owner's probe. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-5E`, branch `wp/MKT-5E`. Nothing committed, pushed, stashed, reset or rebased. No schema change, no new dependency, no dev server, no browser, no database read or write.

**Network:** none to any external host. The syndication endpoint does not exist yet and GoHire was never called. Every test uses an injected fetch or an in-process stub server (`node:http` on `127.0.0.1`).

All four items are done. Every changed file is inside MKT-5E's owns (`git status` lists the eleven owned paths and nothing else). This is the handoff after the independent review: the "Review resolution" list is at the end.

**What the orchestrator should know before merging**

1. **The GoHire bank's cursor sync reads the bank again from the beginning every 7 days** (`INGEST_BANK_RESYNC_DAYS`, new; GoHire only, on both of its cursor transports: the syndication endpoint and the database). Not in the item text. It is what keeps the bank correct next to MKT-5C's "45 days unseen" rule for market `cn`: a change cursor returns a job only when the bank changed it, so an open, untouched GoHire job would keep an old `lastSeenAt` and be archived as `expired` after 45 days although the bank still lists it. **RoboHire's sync is exactly the parity wave's** (review finding 2): no re-read, no pass start in its cursor, no restart at the merge.
2. **The stored GoHire cursor has a fourth part**: `<ISO>|<id>|<mark>|<pass start ISO>`. A GoHire cursor written before this change has no pass start and restarts once, so the first `jobs-ingest` after the merge reads the GoHire bank once from its beginning. RoboHire's cursor stays `<ISO>|<id>|<mark>`. `maintain.ts` `buildRestartBankSyncSql` removes a cursor whole and is unaffected.
3. **`GOHIRE_SYNDICATION_URL` is a transport of its own** (`bankTransport` returns `'syndication'`). It wins over the list reader and over the database, also over `GOHIRE_BANK_TRANSPORT=db` or `api` (one warning names it); only `off` still disables the bank. With the variable unset, the list transport and RoboHire's database transport behave exactly as before; GoHire's database transport differs by points 1 and 2 only.
4. **The assumed contract of the parity wave is replaced** (PAR carry-over 4). The reader no longer accepts `{ data: [...] }` with `deleted: true` rows; it accepts only the page of `syndication.ts`. No deployment sets the URL today, so nothing running changes.
5. **A verified GoHire employer's job is written with `isAgency = false`, not null** (review finding 1), so a row first stored as 代招 changes label when the bank verifies the employer. Side effect to know: the normalizer derives the company record's flag from the same input, so `RACompany.isAgency` of such an employer is written `false` where it was null (only while it is null; every reader tests `=== true` or `IS NOT TRUE`, so nothing reads differently). A staffing firm's name still gives `true` for the job and the company.
6. Three run tallies are new and are in the run result and log only until `status.ts` lists them (Requests, orchestrator 1).

## Items

### 1. [P0] Syndication wire contract, validated before anything is logged or stored: done

New `server/src/features/jobs/ingest/adapters/syndication.ts`:

- `SyndicatedJobSchema` (zod): exactly the keys of `BANK_SYNC_SELECT` (which already holds `education` and `headcount` since the parity wave) plus `employerVerified: boolean`, `syndicationConsentAt`, `validFrom`, `validUntil`. `SyndicatedCompanySchema`: the eight company columns. `SyndicationTombstoneSchema`: `{ id, updatedAt, reason? }`. `SyndicationPageSchema`: `{ items, tombstones, nextCursor, hasMore }`. `SYNDICATION_FIELDS` exports the key lists (the document and the probe are tested against them).
- Unknown keys are stripped at every level (job, company, tombstone, page). `locations` is free-form JSON at the bank: only `[{ city, country }]` is picked, never an error.
- Ten keys must be present on a job (`id`, `status`, `publishedAt`, `updatedAt`, `title`, `companyName`, `employerVerified`, `syndicationConsentAt`, `validFrom`, `validUntil`): the ones that decide whether a row is listed and what it may claim. The descriptive columns may be absent (read as null). A misspelt `employerVerified` therefore fails the page instead of silently turning every job into 代招.
- Times: ISO 8601 only (`readIsoTime` is strict: words, `10/05/2026`, epoch numbers, `2026-02-30`, `24:00` are refused; the runtime's own parser would guess or roll over). A time without a zone is read as UTC+8 and counted. A validity may be a calendar day (UTC+8; `validUntil` runs through the end of that day).
- `parseSyndicationPage(raw)` answers `{ ok: true, page, timesWithoutZone }` or `{ ok: false, problems }`. A problem is `{ field, code, count }`: the field is a path of schema key names with list positions collapsed (`items[].updatedAt`), the code is `missing | wrong_type | not_iso | bad_id | not_cursor`. Zod's own messages are never used, so no value and no key of the payload can appear. One bad job rejects the whole page.
- `toBankSyncRow(job)`: the wire job as a `BankSyncRow` (times as instants; the four new fields as optional members of `BankSyncRow`), so `inputFromBankSyncRow`, `isSyncableBankJob`, `classifyBankRow` and the parity tallies are the same code for every transport.

ACCEPT, tested: a page with `notes`, `evaluationRules`, `aiInsights`, `clientKey`, a company `internalNotes`, a tombstone `closedBy` and page-level extras parses, the result holds the contract's keys only, and validation writes no log line (logger spy; the end-to-end test of item 2 also scans every log call, statement and row); a page missing `items` and a page with a non-ISO `updatedAt` are each one error; `toBankSyncRow` output passes `isSyncableBankJob` and gives a deep-equal `inputFromBankSyncRow` result and a deep-equal normalized job compared with a database row of the same values.

Tests: `syndication.test.ts`, "the syndication wire contract" (7 acceptance rows, 27 rejection rows, key stripping, no payload in a problem, the ISO reader, row equivalence, validity and signals).

### 2. [P0] HTTP variant of the bank adapter: done

`syndication.ts` (reader), `bank.ts` (wiring and gates), `raBankClients.ts` (transport).

- **Transport.** `BankTransport` gains `'syndication'`. `bankTransport`: `off` first; then the syndication URL (needs `GOHIRE_SYNDICATION_KEY`, else `GOHIRE_API_KEY`; with the URL and no key the bank is `off` with reason `no_api_key`, never silently the database); then the parity rule unchanged. `bankSyndicationConfig(bank, env)` is new; `bankApiConfig` is the list reader's only (its `syndicationUrl` member is gone). `isBankEnabled` needs no database URL on this transport; the kill switches and the cross-tenant guard are unchanged. `bankTlsSatisfied` is untouched.
- **Request.** `GET <url>?cursor=<updatedAt ISO>|<id>&limit=<n>`; the cursor is the position only (never our mark or pass start); no cursor parameter when none is stored, so the endpoint answers from the beginning (M3 carry-over 2). `limit` is `INGEST_BANK_PAGE`, never above 200. Header `X-API-Key` (the header `GoHireResumeParseService` sends). `redirect: 'error'`. 20 s for headers and body together, shortened to what the ingest tick can still give (floor 2 s). 5 MB cap: a declared length over it is refused unread, a streamed body is cut at the cap.
- **A request cut short is not a failed sync (review finding 3).** When the time limit was shortened below the full 20 s and the request ran out of it, the result is `{ jobs: [], calls: 1, cursor: <the stored one>, exhausted: false, notes: { bank_pass_cut_short: 1 } }`: no `lastError`, the cursor as it was, the query due at once (the list transport's rule for a later page). A timeout at the full 20 s, and every other failure of a shortened request (network, 429, 5xx, a bad page), is still an error. `bank_pass_cut_short` is already a listed status note ("Checks that ran out of time").
- **TLS only.** https, or http on `localhost` / `127.0.0.1` / `::1`. Anything else: the adapter answers `{ jobs: [], calls: 0, error: 'syndication_url_not_https' }` and makes no request; the reader refuses it a second time on its own. The transport stays `syndication`, so the operator sees the error instead of another transport taking over.
- **Errors** are short codes: `http_401 key_refused`, `http_403 key_lacks_scope`, `http_404 route_not_found`, `http_429 rate_limited`, `http_5xx server_error`, `redirect`, `timeout`, `network`, `not_json`, `response_too_large`, `invalid_page (<field>: <code>; …)`, `page_over_limit`, `cursor_regressed`, `cursor_stalled`. Never the URL, its query, the key, a body excerpt or the runtime's error text. Never thrown: the fetch result carries the text.
- **Result.** Items go through `toBankSyncRow` and the shared `sortRows`. Tombstones are `closedExternalIds` with the default reason `bank_closed` (revived by the upsert). `cursor` is the page's `nextCursor` (canonical UTC spelling) plus our mark and pass start; `exhausted = !hasMore`. With no posting-page template the rows are held like any other bank row.
- **Cursor checks.** `nextCursor` before the cursor sent (by time, then by id as a plain string): `cursor_regressed`. The same position with `hasMore: true`: `cursor_stalled` (the next request would be the same one for ever; not named in the item). A page with more entries than asked for: `page_over_limit`. An id sent both as an item and as a tombstone: the later `updatedAt` decides, a tie closes it. A null `nextCursor` on a page with entries: the last entry is the position.
- **Fields.** `employerVerified: true` is the only thing that clears 代招 on a GoHire row, and 企业直招 still also needs the employer not to be a staffing firm (unchanged `isDirectFromEmployer`). **The verified case is stated, not left unknown (review finding 1):** `inputFromBankSyncRow` sets `isAgency = false` for a verified GoHire employer, because the upsert keeps a stored `isAgency` when the incoming one is null (`COALESCE(EXCLUDED."isAgency", "RAJob"."isAgency")`) and a row first stored as 代招 would otherwise stay 代招 for ever. The label now follows the bank in both directions. `syndicationConsentAt` non-null gives `publicDisplay`. `validUntil` becomes `ProviderJobInput.expiresAt` (stored as `RAJob.expiresAt`); a `validUntil` that has already passed closes the row (`classifyBankRow` verdict `validity_ended`, tally `bank_validity_ended`). `validFrom` is validated and carried, and does not hold a row (holding would lose it: the cursor has moved on). Rows are market `cn`, `sourceBoard` `gohire`, priority 3, apply URL from the template; `headcount` reaches the upsert row.
- **Test postings on every transport.** The gate was already shared (`classifyBankRow` in `sortRows`, used by the database, list and syndication paths): verified, not moved. One addition: 「测试简历匹配」, the test posting the CN note records in the GoHire bank, was not caught. 简历 and 匹配 are now filler words, so a title that is only 测试 + 简历匹配 names no job; 阻抗匹配测试工程师 and 人岗匹配算法工程师 stay jobs.
- **Seen again (beyond the item; GoHire only after review finding 2).** `bankRereads(bank)` is `bankMarket(bank) === 'cn'`. For such a bank `fetchByCursor` restarts from the beginning when the stored cursor's pass began `INGEST_BANK_RESYNC_DAYS` (7; 1 to 30) or more ago, or has no pass start. Every job the bank still lists is upserted again (`lastSeenAt` moves; nothing is re-enriched because the content hash is unchanged), every tombstone is applied again, and a row archived while still listed is reopened by the existing revive rule. Tally `bank_reread_started`. RoboHire's cursor is never dated and never restarted for its age. The list transport is unchanged (each pass reads the whole listing).

ACCEPT, tested end to end (`syndication.test.ts`, "a cursor sync against a stub syndication server"): with `GOHIRE_SYNDICATION_URL` pointing at the stub, the adapter is built as production builds it (`createBankAdapter('gohire')`, configuration from the environment, no database URL) and run through `runIngestQuery` with the ingest fake. Two pages: three rows written into market `cn` (`sourceBoard` gohire, priority 3, the template's apply URL, headcount), the first request without a cursor and the second with page one's own `nextCursor`, the key in the header only; a tombstone archives a stored row as `bank_closed` and leaves the other stored row alone. `employerVerified: true` with a normal employer is written `isAgency: false` and may carry 企业直招; an unverified one and a verified staffing firm may not. **The same job synced unverified, then verified, then unverified again** is written `true`, `false`, `true`, and the label is checked after the statement's own rule (the fake does not play `ON CONFLICT`, so the rule is restated and the executed statement's clause is checked to read the incoming value first). No `syndicationConsentAt` gives `publicDisplay: false`; `validUntil: '2026-12-31'` becomes `expiresAt` 2026-12-31T15:59:59.999Z. An empty company and 测试岗位请勿投递 are not written and are counted, while 软件测试工程师 is written. A plain-http public URL is refused with no request; a regressed cursor, a 401, a 6 MB body (streamed and declared), a redirect and an invalid page each give an error result, write nothing and leave the stored cursor alone. **A request cut short** (5 s left of the tick) gives status `ok`, no stored error, the same cursor, due now; the same request with its full 20 s is the error `timeout`, due in an hour. Nothing recruiter-internal, no key and no endpoint address is in any row, SQL statement, result or log call. `getBankClient('gohire')` stays null throughout.

The ACCEPT line "with the variable unset the parity wave's transports behave exactly as before (their tests are unchanged)" holds for the list transport and for RoboHire's database transport (a new describe pins the parity form: three-part cursor, an unmarked cursor continued and marked `nopage`, no restart for age whatever `INGEST_BANK_RESYNC_DAYS` says). It does **not** hold for GoHire's database transport, on purpose: see Precedence.

Tests: `syndication.test.ts` sections 2 and 3; `adapters.test.ts` (the syndication describe, the transport table, the URL-only enablement, validity, the 7-day re-read for GoHire, RoboHire's parity, the agency flag, the test-posting additions).

**Tests of mine I rewrote because the change deliberately alters what they pinned** (all in `adapters.test.ts`, all GoHire): "GoHire syndication endpoint (cursor + tombstones)" (the old `{ data }` shape); "the API is HTTPS only; the syndication URL is optional" (now two configs); "the first sync after the template is set starts from the beginning" (the GoHire cursor literal gained the pass start); "a changed template restarts once too; with no template an unmarked cursor is continued and marked nopage" (an undated GoHire cursor now restarts once, so the test uses a dated one; the original assertion is kept word for word for RoboHire in the new describe); "GoHire rows are agency postings (代招) unless the bank says the employer is verified" (the verified row is now `isAgency: false`). No list-transport assertion and no RoboHire assertion changed.

### 3. [P1] Live cross-bank search reads the mirror whenever the GoHire bank is reached over HTTP: done

- `raBankClients.bankReadsMirror(bank, env?)`: true for transport `api` or `syndication`.
- `raBankProviders.searchBank`: asks the transport first. On an HTTPS transport it calls `searchBankMirror` and never calls `getBankClient`; on `db` it queries the bank as before.
- `buildMirrorJobWhere(bank, intent, now)`: `market`, `sourceBoard`, `visibility: 'public'`, `archivedAt: null`, **`isCanonical: true`** (new), the same title / description / skills OR and the same freshness bound on the posting date as the live bank query, plus `expiresAt` null or in the future (a validity that passed is out at once; the feed hides such a row the same way).
- `bankMirrorSyncAge(bank, now, client)`: `{ newestSeenAt, ageMs, lastSyncAt, lastSyncFailed }`. `newestSeenAt` is the newest `lastSeenAt` of the bank's rows in its market (the item's definition). `lastSyncAt` / `lastSyncFailed` come from the bank's standing `bank_sync` query, because on a quiet bank a cursor sync writes nothing and `newestSeenAt` alone would look stale while the sync is healthy. Never throws.
- `RACrossBankSearchService.run`: reads the age beside the sweep for each bank searched in the mirror and puts `mirrorSyncAge: { gohire: {...} }` on the closing log line (`cross-bank round complete`). A failed or empty age read changes nothing.

ACCEPT, tested: with transport `syndication` (and no database URL, a TLS one, or a plaintext one) a GoHire search returns mirror rows with `job.id = RAJob.externalId`, makes zero calls to `getBankClient` (the module is mocked with `{ spy: true }`, so the count is real), opens no pool, queries no bank database and makes no HTTP call (`fetch` spy); with transport `db` it queries the bank and not the mirror; an empty mirror is `[]`, not null; the service's cards keep `applyUrl` from the recruiter job id and `id` from the mirrored row.

Tests: `raBankProviders.test.ts` ("live cross-bank search by transport", 8 tests; the mirror WHERE), `RACrossBankSearchService.test.ts` ("search telemetry").

### 4. [P1] The endpoint contract for the GoHire backend, and the owner's probe: done

- `docs/jobright-clone/market/GOHIRE_SYNDICATION.md` (new, 15 sections): route, TLS, the scoped service key, request, the four field tables, what an item and a tombstone are, order / cursor / `hasMore`, `updatedAt` as the syndication change time, why this side re-reads every 7 days, the field rules (verified employer and the six-month re-verification of the five-ministry notice, consent in three states, validity, times, test postings), what must never be sent, the error shape, rate and volume, the facts the bank's schema needs, the acceptance list for the route, what this repository does with the answer, the settings here, the fallback until the route exists, the owner steps of strategy 7 items 9 and 10 in order, and a synthetic example page.
- **Corrected after review finding 4.** Sections 5.3, 8 and 9 now state the cadence as built: the ingest job runs every 10 minutes; a completed sync is due again after 30 minutes (`REFRESH.bankSyncMs`), a failed one after 60 (`REFRESH.errorRetryMs`); pages of one sync are asked back to back with no pause, one request in flight at a time; `Retry-After` is not read; a request cut short by the run's remaining time is not an error. The rate advice follows from that: 60 requests a minute is not safe for a read of more than about 60 pages, and this side's own rate has not been measured. Section 6.1 says what `true` states (the named company is the verified employer and posts the job for itself) and that the label follows the value at every sync. Section 14 step 6 names `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true`.
- Four tests tie the document to the code: its field tables equal `SYNDICATION_FIELDS` and its "key must be present" column equals what the schema really requires; its header, limits, settings and error codes are the code's constants; **its cadence sentences carry the planner's own numbers (`REFRESH`), the reader's 20 s and the 2 s floor, and step 6 names all four settings**; its example page parses with the schema.
- `scripts/gohire-syndication-probe.mjs` (new; plain Node, no dependency, no server import): one GET with the configured URL and key, https only, no redirect, 20 s, 5 MB. Prints the endpoint without its query, which variable gave the key, the status, counts (items, tombstones, verified, with consent, with a validity end, times without a zone), more pages, the cursor in canonical spelling, and schema problems by field name. Exit 0 / 1 / 2. It holds a small copy of the contract; a test changes every field of the contract in 17 ways (748 cases) and requires the script's verdict and problem list to equal the schema's.

ACCEPT, tested: against the stub the probe prints the exact 15 lines and exits 0, with no job text, company name, job id (other than the cursor's), key or URL query in the output; a bad page prints the problems by field and exits 1; a 401, a page over the limit and an HTML answer are FAIL with exit 1 and no body; missing settings, a plain-http public URL and bad arguments exit 2 before any request (also as a child process).

**Where the document goes further than the item text (say if unwanted):** a tombstone is defined as "this job is not listable now", with the minimum (every job that was once an item) and the recommended form (every job of the bank is an item or a tombstone, so a read from the beginning repairs this side); the route should not return entries newer than about five seconds (a late commit could land behind a cursor already handed out); `updatedAt` must move when verification, consent, company facts or validity change.

### Carry-over

- **waveM1 MKT-5E.1 / PAR carry-over 4** (the syndication endpoint and the assumed contract): done; it is this bundle. The contract changed (items 1 and 2). The 2,000-row cap of the interim list reader is unchanged and stays a known gap of that reader.
- **waveM3 MKT-5E.1** (`mapRecruiterJobToRAJobUpsert` writes the bank's own priority): kept; `raCrossBankMatch.ts` is not touched.
- **waveM3 MKT-5E.2** (read from the beginning with no cursor): done and tested.
- **waveM2 MKT-5E.1 / waveM4 MKT-5E.1** ("`RACrossBankSearchService.ts` writes `RAResumeVariant.matchScoreCached` near line 518; remove the write"): **rejected, nothing to remove.** Line 518 is `matchScoreCached: llmScore` inside `toCard`, a field of the response type `DiscoverJobCard` (`types/crossBank.ts:215`, required, not my file). The service has no `rAResumeVariant.update` / `upsert` / `create` and never had one (`git log -S"rAResumeVariant.update"` on the file is empty; the only `matchScoreCached` hit since the first commit is that card field). Its writes are `rAJob.upsert`, `rAJobMatchScore.upsert` and the deduction log. If the card field itself should go, that is a change to `DiscoverJobCard` and its web consumers (no owner in M5).

### Precedence

- **The ACCEPT line "parity transports behave exactly as before" against strategy 1.5 "Closure" (mainland: "else 45 days unseen").** For GoHire's database transport the strategy wins: without the weekly re-read, MKT-5C's unseen rule (market `cn`, every board) would archive an open job the bank still lists and has not edited for 45 days. So GoHire's cursor carries a pass start and is read again every 7 days on the database transport too. For RoboHire the ACCEPT line and strategy 1.2 ("`bank_robohire` … (unchanged)") agree and both hold: nothing changed.
- **"Every 10 min" (strategy 1.2, and "cursor sync every 10 minutes" in item 4) against the code.** The ingest job runs every 10 minutes, but a completed bank sync has been due again after 30 minutes since WP-16b (`REFRESH.bankSyncMs` in `planner.ts`, MKT-5A's file in M5), and an error waits 60. The document for the second repository states what is built (D3) and a test ties it to `REFRESH`. Whether the strategy means the 10-minute job or a 10-minute sync is a Request (orchestrator 6).
- Strategy 1.4 and the item say "titles containing 测试". The code keeps the parity wave's narrower gate (a title that names no job), as the item also asks ("reuse the parity wave's gate"), because the literal rule hides 软件测试工程师 and every other testing job. Owner decision 22 of `wavePAR-carryover.md` is still open; the document for the second repository says the same.
- `MARKET_TASK_PLAN.md`'s contract row for the wire matches what was built.

## Files changed

New:
- `server/src/features/jobs/ingest/adapters/syndication.ts`
- `server/src/features/jobs/ingest/adapters/syndication.test.ts`
- `docs/jobright-clone/market/GOHIRE_SYNDICATION.md`
- `scripts/gohire-syndication-probe.mjs`

Changed:
- `server/src/features/jobs/ingest/adapters/bank.ts`
- `server/src/features/jobs/ingest/adapters/adapters.test.ts`
- `server/src/roboapply/v2/lib/raBankClients.ts`
- `server/src/roboapply/v2/lib/raBankProviders.ts`
- `server/src/roboapply/v2/lib/raBankProviders.test.ts`
- `server/src/roboapply/v2/services/RACrossBankSearchService.ts`
- `server/src/roboapply/v2/services/RACrossBankSearchService.test.ts`

Touched in the review pass: `bank.ts`, `adapters.test.ts`, `syndication.test.ts`, `GOHIRE_SYNDICATION.md`. Nothing outside the owns was edited, so nothing was reverted.

Exports that changed shape (no importer outside my files): `bank.ts` `createSyndicationReader` moved to `syndication.ts`; `pickBankSyncRow` lost its `syndication` option; `BankPageReader` may answer a `BankCursorPage`; `classifyBankRow(row, now?)`; `BankRowVerdict` gains `validity_ended`; `BankSyncRow` gains four optional members; new `bankCursorPassStart`, `bankRereads`, `bankResyncDays`, `BANK_RESYNC_DAYS`, `BANK_RESYNC_MAX_DAYS`, `BankFetchResponse`. `raBankClients.ts`: `BankTransport` gains `'syndication'`; `BankApiConfig.syndicationUrl` removed; new `bankSyndicationConfig`, `BankSyndicationConfig`; `bankReadsMirror(bank, env?)`. `raBankProviders.ts`: new `bankMirrorSyncAge`, `BankMirrorSyncAge`; `buildMirrorJobWhere(bank, intent, now?)`.

## Tests run

All in the worktree, on the final tree.

| Command | Result |
|---|---|
| `npx vitest run server/src/features/jobs/ingest/adapters server/src/roboapply/v2/lib/raBankProviders.test.ts server/src/roboapply/v2/services/RACrossBankSearchService.test.ts` | 4 files, 175 passed, 1 todo (adapters.test.ts 65 + 1 todo; syndication.test.ts 80; raBankProviders.test.ts 18; RACrossBankSearchService.test.ts 12) |
| `npx vitest run server/src/features/jobs/ingest server/src/roboapply/v2` | 41 files, 1,066 passed, 2 todo |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M4` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | **759 files passed, 19,741 tests passed, 1 skipped, 10 todo, exit 0** (base: 758 files, 19,637 tests; this bundle adds 1 file and 104 tests) |

The full suite was run twice after the review changes; both runs were fully green.

## Red tests for other bundles

None.

## Pre-existing failures

None in the code, and none in the two final runs. Four tests outside this bundle have a wall-clock or 5 s limit and failed in earlier runs only while the machine was overloaded by the sibling suites (load average 140 to 220); none imports a module this bundle changed, and all pass at normal load:

- `server/src/features/jobs/import/directFetch.test.ts` › "a 2 MB page of … is read, and its draft built, in milliseconds".
- `server/src/features/cn/jobs/__tests__/text.test.ts` › "unclosed tags (500 KB) is read in milliseconds".
- `server/src/features/jobs/import/html.test.ts` › "gives what the two patterns gave, on every arrangement of brackets".
- `server/src/features/match/eval/run.test.ts` › "ranking and language measure NDCG through the seam once it exists".

If they show up at the merge gate while other suites are running, rerun them alone before reading them as a regression.

## Requests

**Orchestrator**

1. **Three new run tallies are not on the admin Sources panel.** `server/src/features/jobs/ingest/status.ts` `SOURCE_STATUS_NOTES` (no owner in M5) keeps only listed codes, and `run.ts` drops the rest from the status document. Add after `'bank_pass_cut_short'`: `'bank_validity_ended'`, `'bank_time_without_zone'`, `'bank_reread_started'`. Add the same three to `TALLY_ORDER` in `components/v3/admin/SourcesConsole.tsx`, and to `admin.console.sources.skips` in `i18n/staging/admin.en.json` (and `admin.zh.json`). Proposed English: `bank_validity_ended` "Past the end date the recruiter set: {count}"; `bank_time_without_zone` "Times sent without a time zone, read as China time: {count}"; `bank_reread_started` "Full re-reads of the source started: {count}". Until then the three are in the cron result and log only. Tombstones are counted under the existing `bank_closed`; a request cut short under the existing `bank_pass_cut_short`.
2. `server/src/features/jobs/ingest/index.ts`, comment above `bankClients` ("A bank read over HTTPS (`bankTransport` 'api') has no client"): now `'api'` or `'syndication'`. Comment only.
3. `docs/jobright-clone/market/MARKET_TASK_PLAN.md` (no owner in M5): the contract row "GoHire syndication wire" can be marked as built with: ten mandatory keys; `page_over_limit` and `cursor_stalled` beside `cursor_regressed`; `limit` never above 200; the weekly re-read (GoHire only); a verified employer written as `isAgency = false`; a shortened request that times out is `bank_pass_cut_short`, not an error. Section 5 needs the row `INGEST_BANK_RESYNC_DAYS`. The stored cursor format recorded in `handoffs-par/PAR-7.md` gained a fourth part for the GoHire bank on its database and syndication transports; RoboHire's is unchanged.
4. **Merge-time check with MKT-5C** (its handoff already answers the first part). Its `unseenMainland` step archives market `cn` rows not seen for 45 days. A GoHire row on a cursor transport is re-seen at least every `INGEST_BANK_RESYNC_DAYS` (at most 30), so the step cannot close a job the bank lists. On the merged tree confirm that (a) `CN_UNSEEN_DAYS` is 45 and not below 31; (b) `UNSEEN_MARKET` in `maintain.ts` and `bankRereads` in `bank.ts` name the same market (`cn`): a second market with an unseen rule needs its bank added to `bankRereads`; (c) a row closed as `expired` by that step is reopened by the upsert when the bank lists it again (`REVIVE_ON_RELIST_SQL`: `expired` with `EXCLUDED."expiresAt" IS NULL` on a board outside `AGE_EXPIRY_BOARDS`).
5. `.env.example` (MKT-5H's file; its worktree already lists the variables): the sentence above `INGEST_BANK_RESYNC_DAYS` says "a recruiter bank that is read by cursor (its database, or the GoHire syndication endpoint)". After the review it is the GoHire bank only: "the GoHire bank, when it is read by cursor (the syndication endpoint or its database) … RoboHire's sync is never re-read for its age." `deploy/cn/cn.env.example` in that worktree already says "the GoHire bank" and is right.
6. **Strategy 1.2, row `bank_robohire`: "Every 10 min (unchanged)".** As built since WP-16b the ingest job runs every 10 minutes and a completed bank sync is due again after 30 (`REFRESH.bankSyncMs`, `planner.ts`). Decide which the strategy means. If a 10-minute sync is wanted, it is one constant in MKT-5A's `planner.ts`, and then `GOHIRE_SYNDICATION.md` sections 5.3 and 9 take the new number (the test "states the cadence as built" fails until they do). If the 10-minute job is meant, amend the row to "checked every 10 min; a completed sync runs again after 30".
7. Optional, not needed for correctness: `server/src/features/jobs/ingest/upsert.ts` has no owner in M5. The agency label is now right because the bank mapping sends an explicit `false`. If the owner prefers that a bank row's flag is always taken from the bank whatever the mapping sends, the statement's clause can become `"isAgency" = CASE WHEN EXCLUDED."fromRecruiterBank" THEN EXCLUDED."isAgency" ELSE COALESCE(EXCLUDED."isAgency", "RAJob"."isAgency") END`. If the company record should stay null for a verified employer (see "What the orchestrator should know" 5), the place is `normalizeProviderJob.ts` (MKT-5F's file in M5): derive the job's flag from `agencyPosting === false` and leave `companyIsAgency` to the name rule; `bank.ts` would then stop setting `input.isAgency`.

**MKT-5A** (for information): `syndication.test.ts` reads `REFRESH.bankSyncMs` and `REFRESH.errorRetryMs` and requires `GOHIRE_SYNDICATION.md` to state them (30 and 60 minutes today; unchanged in your worktree). If either number changes, the document's sections 5.3, 8 and 9 change with it.

**MKT-5C** (for information; nothing to change): see orchestrator 4. If the unseen window ever becomes configurable, `BANK_RESYNC_MAX_DAYS` (30) in `bank.ts` must stay below it.

**MKT-5H:** the env table below, and orchestrator 5.

**Owner**

1. Strategy 7 items 9 and 10, in the order of `GOHIRE_SYNDICATION.md` section 14: approve the work package for the RoboHire / GoHire backend (the route, the three schema facts, the candidate-facing posting page), issue the scoped service key, confirm GoHire's licence and supply `CN_HR_LICENCE_HOLDER` / `CN_HR_LICENCE_NUMBER`, run the probe, then set `GOHIRE_SYNDICATION_URL`, `GOHIRE_SYNDICATION_KEY`, `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` and `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true`.
2. Decide whether a GoHire job with no recorded consent may be shown to signed-in GoApply users (document section 6.2, middle row). Today's rule, unchanged: yes for signed-in users, never on a public page.
3. Decision 22 of `wavePAR-carryover.md` (the 测试 rule) is still open; this bundle kept the narrow rule and added 「测试简历匹配」.
4. Agree a rate limit for the service key with the bank before it is issued (document section 9): this side sends the pages of one sync back to back and does not read `Retry-After`.

**Second repository (RoboHire / GoHire backend):** build `GET /api/v1/syndication/jobs` to `docs/jobright-clone/market/GOHIRE_SYNDICATION.md`; the acceptance list is its section 11. The posting page (section 12.2) is as necessary as the route: without `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` every synced job is held. Send `employerVerified: true` only for the employer's own verified record (section 6.1), and move a job's `updatedAt` when its employer's verification changes (section 5.4).

## Schema requests

None in this repository. The facts the bank's own schema needs (a verified-employer record, the employer's consent to syndication, a validity period) are described for the second repository in `GOHIRE_SYNDICATION.md` section 10; the column names there are suggestions, the wire names are fixed.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `GOHIRE_SYNDICATION_URL` | **Redefined.** The GoHire syndication endpoint. When set it is the bank's transport: it wins over the list endpoint and the database (also over `GOHIRE_BANK_TRANSPORT=db` or `api`), and needs no database URL. Must be https (http only for `localhost` / `127.0.0.1`); otherwise every sync answers `syndication_url_not_https` and no request is made. | unset: the parity wave's transports |
| `GOHIRE_SYNDICATION_KEY` | **New.** The scoped service key for that endpoint, sent as `X-API-Key`. | unset: `GOHIRE_API_KEY` is used; with neither, the bank is off (`no_api_key`) while the URL is set |
| `GOHIRE_BANK_TRANSPORT` | **Redefined.** `db` \| `api` \| `off`. Chooses between the database and the list endpoint only. With `GOHIRE_SYNDICATION_URL` set, `db` and `api` are ignored (one warning); `off` still switches the bank off. | unset |
| `INGEST_BANK_RESYNC_DAYS` | **New.** Days after which the GoHire bank's cursor sync (syndication or database) reads the bank again from the beginning. A whole number from 1 to 30; anything else is 7. No effect on RoboHire or on the list transport. | 7 |
| `INGEST_BANK_PAGE` | Unchanged; on the syndication transport the value asked for is never above 200. | 200 |

`RAIngestQuery.params.cursor`: GoHire on the database and syndication transports `<ISO>|<id>|<nopage or page:8 hex>|<pass start ISO>`; RoboHire `<ISO>|<id>|<nopage or page:8 hex>` (unchanged); the list transport `api|<pass start>|<next page>` (unchanged).

## i18n keys added or changed

None (the bundle owns no namespace). Three proposed admin strings are under Requests, orchestrator 1.

## Known gaps

1. **The route does not exist.** Everything here is tested against a stub and fixtures. First contact with the real endpoint is the owner's probe run. Next step: owner item 1; who: owner and the second repository.
2. **No candidate-facing GoHire posting page**, so even with the route live every job is held until `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` is set (unchanged rule, C18). Who: second repository, owner.
3. **Closure on this transport is by tombstone, by `validUntil`, or by the 45-day unseen rule; there is no listing diff.** A job hard-deleted at the bank without a tombstone stays open until the unseen rule archives it (it stops being re-seen at the next weekly re-read, so about 45 to 52 days). The document requires a tombstone for a deleted job. Next step if the route cannot give one: collect the ids of a whole pass and report a listing on its last page; that needs a place to keep the ids between fetches (`AppConfig`, no schema change). Who: a later bundle in this repository.
4. **`validFrom` does not delay listing.** A job sent as an item before its validity starts is listed. The document tells the route not to send it. Who: second repository.
5. **`bank_validity_ended`, `bank_time_without_zone` and `bank_reread_started` are not on the admin panel** (Requests, orchestrator 1).
6. **The legacy cross-bank search keeps its 45-day posting-age bound on both transports** (`FRESHNESS_DAYS` in `raCrossBankMatch.ts`, no owner; the item asked for "the same freshness bound"). A GoHire job older than 45 days is in the feed and not in `/v2/discover` results. Next step: decide whether that search should follow M-22; who: owner, then whoever owns `raCrossBankMatch.ts`.
7. **Pages of one sync are asked back to back and `Retry-After` is not read.** A read from the beginning is `entries / 200` requests in a row inside the cursor source's share of a tick; a 429 is an error and the sync goes on an hour later from its cursor. The document now says so and sizes the rate advice from it; this side's rate against a live route is unmeasured. Next step if the bank insists on a low limit: a pause between pages in the syndication reader (`syndication.ts`) and reading `Retry-After` into the next run time, which needs a field on the fetch result that `pipeline.ts` honours. Who: a later bundle; owner item 4 first.
8. **A verification change reaches a job only when the bank moves that job's `updatedAt`** (document 5.4), or at the next weekly re-read. Until then the stored label is the previous one, in either direction, for at most about 7 days. Who: second repository.
9. **A dead endpoint on a tick that never has 20 s for the bank would read "ran out of time", not an error.** Each brand gets its own slice of the cron budget and a cursor source 40% of it, so the first request of a tick normally has its full 20 s and a dead endpoint is an error on that request; only an operator who sets `INGEST_CURSOR_TICK_SHARE` or the cron budget very low would see `bank_pass_cut_short` instead. No change proposed.
10. **`mirrorSyncAge.newestSeenAt` can be up to about 7 days old on a healthy, quiet bank**; `lastSyncAt` and `lastSyncFailed` are beside it for that reason. No alert threshold is set: the values are logged, not judged.
11. **`DiscoverJobCard.matchScoreCached` is still sent** by the legacy discover route (see Carry-over): it is a card field, not the resume-variant column.
12. **A wrong `GOHIRE_SYNDICATION_URL` is seen only when a sync runs** (the Sources panel's last error). There is no boot line for it; `platform/startup.ts` has no owner in M5. Next step: one boot warning from `syndicationUrlProblem(bankSyndicationConfig('gohire')?.url)`; who: orchestrator.
13. **The GoHire bank is read once from its beginning at the first `jobs-ingest` after the merge** (its stored cursor has no pass start). Expected, harmless (rows are held until the posting page exists), and it does not happen for RoboHire.

## Review resolution

- **Item 2 judged not done, part (a)** (企业直招 only for a row inserted as verified): **real, fixed.** Verified in the code: a verified normal employer normalised to `isAgency: null` and `upsert.ts` keeps the stored value on null. `inputFromBankSyncRow` now sets `isAgency = false` for a verified GoHire employer (one rule, in the one mapping every transport uses). Tests: the s1 assertion is `isAgency: false`; a new pipeline test syncs the same id unverified, verified, unverified and checks the written values (`true`, `false`, `true`) and the label after the statement's own rule, and that the executed statement's clause reads the incoming value first; `adapters.test.ts` covers the verified staffing firm (still `true`) and RoboHire (no statement either way).
- **Item 2 judged not done, part (b)** (parity transports changed): **real for RoboHire, fixed; kept on purpose for GoHire's database transport.** RoboHire's sync is byte for byte the parity wave's again (no re-read, three-part cursor, an undated cursor continued), pinned by a new describe that holds the original assertions. GoHire's database transport keeps the weekly re-read because MKT-5C's unseen rule covers every `cn` board; the reviewer's own fix keeps it too. Recorded under Precedence.
- **Finding 1 (medium), 代招 can never become 企业直招:** accepted, fixed as proposed (above). The alternative named for "the upsert owner (MKT-5C)" is not raised as a required change: the bundles file gives `upsert.ts` no owner in M5 (MKT-5C owns `maintain.ts` and `tracking.ts`), and the mapping fix is enough. It is listed as optional (orchestrator 7), with the one side effect of the chosen fix (the company record's flag).
- **Finding 2 (low), the weekly re-read also changed RoboHire:** accepted, fixed. `bankRereads(bank)` is `bankMarket(bank) === 'cn'`. One step further than proposed: RoboHire's cursor is also written in its parity form (no fourth part), so nothing about the live brand's sync changes, not even the stored string. The previous owner request 4 ("say if it should be mainland-only") is withdrawn: it is mainland-only.
- **Finding 3 (low), a request cut short reads as a failed sync:** accepted, fixed as proposed. A timeout of a request whose limit was shortened below the full 20 s returns the non-error result with `bank_pass_cut_short`; a timeout at the full limit and any other failure stay errors. Tests: the fake-timer test beside the old one (30 ms, 0, 5 s, 19,999 ms cut short; no budget, 20 s, 96 s an error; a first sync stores no cursor), "only a timeout is ever cut short" (network, 429, an answered page), and a pipeline test (status `ok`, no `lastError`, same cursor, due now; then the full-limit error due in an hour).
- **Finding 4 (low), the document's 10-minute sync:** accepted, the document is corrected to the built numbers and a test reads them from `REFRESH`, so the document cannot drift again. `Retry-After`, back-to-back pages and the rate advice are stated; step 6 names `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true`. The suggested "state the pages per minute this side can send" is answered honestly instead: it is not capped and has not been measured, so no figure is given as fact. The strategy's own "Every 10 min" goes to the orchestrator (Request 6) because `planner.ts` is MKT-5A's.
- **Unowned edits:** none reported, none found (`git status`: the eleven owned paths only). Nothing reverted.
- **Gates re-run on the final tree:** owned tests, both typechecks, `npm run check`, `eval:match --enforce M4`, and the whole suite twice (759 files, 19,741 passed).
