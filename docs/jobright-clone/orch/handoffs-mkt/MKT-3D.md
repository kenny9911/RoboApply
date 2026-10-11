# MKT-3D

Employer boards: sources for both markets, discovery, bulk import, seeds, sync throughput and its own cron (JI-3, JI-4, JC-4, JT-5). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3D`, branch `wp/MKT-3D`. Nothing committed.

This is the handoff after the independent review. Every finding of the review was checked against the code, found real, and fixed; the list is under "Review resolution" at the end. No edit is outside the bundle's owns.

**Read this first**

1. **One red test in another bundle's file, caused by item 7** (`ingest/cron.test.ts`, MKT-3A). Details under "Red tests for other bundles".
2. **Five red tests my change did not cause.** Four in `components/features/copilot/__tests__/cards.test.tsx` (a fixture's 24-hour expiry passed at 2026-10-11 08:00 UTC; they fail in every worktree from that minute on). One timing assertion in `server/src/features/jobs/import/directFetch.test.ts` that missed its limit by 3 ms while the whole suite ran next to seven sibling worktrees, and passes when run alone (60 of 60). Details under "Pre-existing failures".
3. **Nothing was run against a database, a dev server or a browser.** Three read-only GET requests were made to public job-board endpoints in the first session to confirm response shapes; none in this one.
4. **First deploy:** every existing source row is due at once (it has no `nextSyncAt`), and the seed loader creates about 38 sources on the first `jobs-boards` run. That run and the next ones read all of them. A board read for both markets now writes rows into both feeds.
5. **All 26 boards of `seeds.cn.json` are registered**, not 14. The parity wave held 12 back only because a board could feed one site. Decision for the owner under "Requests".
6. **New since the review, and a judgement of mine beyond what it asked:** a board that answers 401 or 403 counts toward the three-failure switch-off (the review's fix) but is asked again only every 6 hours, so a job-board host that blocks our address for an afternoon cannot switch off every board on it within two hours. Say if 1 hour is wanted instead (`SYNC_REFUSED_RETRY_MS`).

## Items

### 1. [P0] A source carries origin, discoveredFrom, countries and sync state, and is not tied to one market: done

- `contract.ts`: `CareerSourceBodySchema.countries` (ISO alpha-2, at most 60, default `[]`), `PatchCareerSourceBodySchema.countries`, `ListCareerSourcesQuerySchema` gains `origin` and `state`; `market` in a body is optional and ignored. `CareerSourceView` gains `origin`, `discoveredFrom`, `countries`, `failCount`, `lastChangeAt`, `nextSyncAt`, `disabledAt`, `state`.
- `service.ts`: `list` filters by "feeds this market" (`sourceFeedsMarket`: cn = `countries` empty or contains CN; intl = empty or contains any other code), `origin`, `state`, `enabled`. `create` writes `origin 'admin'` and the countries; the `market` column keeps the console that added the row and decides nothing. `update` accepts `countries` and, on switching a source back on, sets `failCount 0`, `disabledAt null`, `nextSyncAt null`, `lastError null`. `find`, `update`, `remove`, `runNow` are not scoped to a market: the row is shared. Switching off or removing archives the board's open rows in both markets.
- `routes.ts`: no market guard; `POST /import`.
- `sync.ts` `CareerSourceRow` and `connectors.ts` `BoardSource` carry `countries`. `sourceCoversCountry(source, iso)` exported.
- `countryCode` is unchanged: a weak hint for an ambiguous city.

ACCEPT, tested: POST with `['TW','CN']` stores them and returns `origin 'admin'`; `market=cn` returns that row and a row with no countries, not a row with `['US']`; both admins see the same shared row; re-enabling clears `failCount` and `disabledAt` and makes it due; both typechecks pass.

Departures, with the reason:
- **The new view fields are optional in the TypeScript type.** The server always sends them. `components/v3/admin/__tests__/sources.test.tsx` (not mine) builds a complete `CareerSourceView` literal, so required fields broke the web typecheck.
- **409 `board_on_other_site` is retired.** A duplicate answers the plain 409. When the existing row does not feed the admin's market the 409 carries `details: { field: 'boardToken', reason: 'board_read_for_other_countries', id, countries, market }` (`countries` and `market` added after the review, so the panel can offer "Read it for this site too").
- **An admin switching a source off also sets `disabledAt`** (and `nextSyncAt null`). `failCount >= 3` tells an admin's switch-off from one by failures.
- **A change of countries makes the board due at once only when the source is on, or is being switched on in the same request** (after the review). On a source that failed reads switched off, `nextSyncAt` holds the time its postings are archived and now stands.
- `list` filters in memory: it scans up to 20,000 rows and answers at most 2,000.

Tests: `routes.test.ts` (35), `atsPublic.test.ts` block "a source is not tied to one market".

### 2. [P0] Board sync engine: done

- `ingest/boards.ts`. `runBoardSync`: kill switch → `{ skipped: 'kill_switch' }`; load seeds; archive rows of sources switched off 48 h ago; validate candidates; then loop until under 20 s are left or nothing is due: lease `2 × concurrency` with one statement, read with `ATS_BOARDS_CONCURRENCY` in flight, write one board at a time. `runJobsBoards(budget)` is the cron step.
- Lease (`buildBoardLeaseSql`): `UPDATE … SET "nextSyncAt" = now() + interval '15 minutes' WHERE "id" IN (SELECT … WHERE "enabled" = true AND ("nextSyncAt" IS NULL OR "nextSyncAt" <= now()) ORDER BY "nextSyncAt" ASC NULLS FIRST, "lastSyncedAt" ASC NULLS FIRST LIMIT n FOR UPDATE SKIP LOCKED) RETURNING <18 named columns>`.
- Stamp rules in `atsPublic/schedule.ts` (pure):
  - success → `lastSyncedAt`, `lastJobCount`, `lastError null`, `failCount 0`, `lastChangeAt` when the run inserted or closed a posting, next read +2 h / +12 h / +24 h (posting texts change that: item 3).
  - hard failure → `failCount + 1`; the third in a row sets `enabled false`, `disabledAt`. Hard is: `board_not_found`, `redirect`, `unexpected_shape`, `not_json`, `unsupported_job_board`, `response_too_large`, and **any 4xx except 408 and 429** (after the review). Retry in 1 h; **401 and 403 in 6 h**.
  - transient (timeout, 5xx, 408, 429, network) → 1 h × attempt, at most 6 h, never disables.
- Size: `BOARDS_PER_FETCH`, `SYNC_INTERVAL_MS`, `MAX_POSTINGS_PER_BOARD` are gone. Greenhouse and Ashby hand on the whole board from one call; Lever pages to the end (safety stop at 100 pages marks the listing incomplete).
- `http.ts`: every request sends `User-Agent: sourceUserAgent(market, env)` next to `Accept`.
- `adapter.ts`: still registered (`markets ['intl','cn']`, `costModel 'free'`, kill switch); `fetch` answers `{ jobs: [], calls: 0, exhausted: true }`.
- `service.ts` `runNow(id, market)`: a listing-only read under 15 s, **of a paged listing its first page and the board's own total** (after the review), then `nextSyncAt null`, `lastJobCount`, answers `queued: true`. It touches no `RAIngestQuery` and queues no work.
- Cron: `PLATFORM_CRON_JOBS` gains `brandCronJob('jobs-boards', '*/5 * * * *', 'MKT-3D', [], [{ name: 'boards', run: (budget) => runJobsBoards(budget) }])`; `vercel.json` gains the entry; `deploy/cn/k8s/cronjobs.yaml` regenerated with `node scripts/gen-cn-cronjobs.mjs`.

ACCEPT, tested: a 728-posting Greenhouse fixture is read from one request, handed on whole, nothing closed; 1,000 boards at 60 per 5-minute run over 26 simulated hours: every board first read within 85 minutes, changed boards every 2 h, quiet boards every 12 h; three 404s disable a source and its rows are archived on the first run 48 h later, not at 47 h; three timeouts, 503s or network errors do not disable it; two overlapping runs read each of 40 boards once; in-flight listings never exceed the setting and writes are one at a time; every request carries the User-Agent; `GET /api/v1/cron/jobs-boards` exists, is in `vercel.json` and in the CronJob file with the same schedule; the kill switch reports skipped. Added after the review: three 403, 410 or 400 answers switch a source off and its postings are archived 48 h later; a 429 or 408 never counts.

Departures, with the reason:
- **The 48 h archive runs once per source, not on every run.** A source switched off by failures carries the time its rows go in `nextSyncAt`; `archiveDisabledSources` archives and clears the mark.
- **User-Agent market (carry-over MKT-3D.2; reworked after the review).** `signingMarket(source, brands)`: a board read for the mainland only (`countries` feeds cn and not intl) is asked as GoApply where the deployment serves GoApply; every other board as RoboApply where it is served; on a mainland-only deployment everything as GoApply. "Check now" signs as the brand of the admin's host. The item's literal `sourceUserAgent('intl', env)` would name RoboApply from a GoApply console; the carry-over ("the market of the request") decides.
- **401 and 403 wait 6 hours between counted failures** (see "Read this first" 6).
- **A board is read at most once per run** (the lease excludes the ids already read).
- **A board read but not written when the budget ends has its lease freed** (`nextSyncAt = now`).
- **A failed "Check now" writes `lastError` only**, not `lastSyncedAt` or `failCount`.
- **Not in the item: the board sync writes the per-market run status** (`jobs.source.status:<market>:ats_public`).

Tests: `ingest/boards.test.ts` (49), `atsPublic.test.ts`, `cron/handlers.platform.test.ts` (32), `__tests__/deploy/cronParity.test.ts` (15), `RoboApplyCronService.test.ts` (4, unchanged).

### 3. [P0] SmartRecruiters: complete listing per country, texts only for ids not stored: done

- `connectors.ts`: the listing pages `limit=100&offset=n` to `totalFound` or a short page (safety stop at 200 pages marks it incomplete); one pass per code of `source.countries` with `&country=<lower case>`, merged by id; one pass without the parameter for an empty list. Texts: one request per posting, postings not among our open rows first, up to `ATS_SR_DETAILS_PER_RUN` (100), 4 in flight; what is left of the budget refreshes the rows saved longest ago.
- After the review the read reports two numbers, not one:
  - `pendingDetails`: new postings whose text was not asked for (the budget was used up, or the run ran out of time);
  - `failedDetails`: new postings whose text was asked for and could not be read.
- `schedule.ts` `nextReadDelayMs`: texts pending and the host answers → the board is due at the next run (5 minutes). A text that failed, with nothing pending → 1 hour. Refused every text it asked for (nothing read, at least one failure) → 1 hour whatever is pending. One failing text among a backlog that is moving does not slow the backlog.
- Once a text request is answered 429, no further text is asked for in that run.
- A posting of a market the deployment does not write is never asked for its text and is not pending.

ACCEPT, tested: a 1,300-posting fixture read for CN is fully ingested over 13 runs, 13 listing pages per run all with `country=cn`, 100 texts per run only for ids not stored, nothing closed; run 14 refreshes the oldest 100; removing one posting closes exactly that row; `['TW','CN']` lists once per country and merges; a failed text request skips that posting and never fails the board. Added: a text that always answers 403 leaves the next read one hour away and the next two cron runs do not touch the board; a 429 on the texts stops the run's text requests after the four in flight and the board waits an hour.

Not literally as written: with `['TW','CN']` the CN pass is listed first, so the Taiwan postings of a large board get their text after the mainland ones (BoschGroup: after about 13 runs, 65 minutes).

Choices of mine inside the review's fix: a stored posting whose refresh fails counts as neither pending nor failed (the row is there; the next regular read asks again); a request cut off by the run's own time limit is pending, not failed.

### 4. [P0] One board read feeds both brands: done

- `atsPublic/market.ts`: `splitPostingByMarket(input) → { intl, cn }` and `routePosting`. Each location is placed by the normalizer's own `marketOfPosting`. Mainland only → cn copy with the plain id; anything else, unknown or remote → intl; both sides → intl keeps the id and the other locations, cn gets `<id>#cn` and the mainland locations. `copySelected` applies `countries`; left-out copies are counted `countryNotSelected`. `routeBoardRead` expands the listing to the externalIds it maps to; the closure diff uses that set.
- `boards.ts`: `processJobs` once per market with postings, as the brand serving that market, inside `runWithBrand`, only when that brand is in `allowedBrands()` and `ingestAllowed`. Otherwise the inputs are dropped and counted (`droppedIntl`, `droppedCn`).

ACCEPT, tested through the real `processJobs`: 上海 lands in market cn and not intl; Singapore in intl; Shanghai + Singapore gives `globalco:3` (intl) and `globalco:3#cn` (cn); when the board later lists only Singapore the `#cn` row is archived `source_removed` and the intl row stays; one listing request; with `CN_RECRUITMENT_INFO_MODE=off` no cn write and `droppedCn: 2`.

### 5. [P0] Discovery: done (the review judged it not done in three cases; all three are fixed)

- Collect, `atsPublic/discovery.ts`: `noteDiscoveredBoard(job, ctx)` reads `job.atsPostingKey` (`<ats>:<tenant>:<postingId>`; absent or malformed → no-op), ignores `ats_public`, accepts the four readable systems plus `workable` and `lever_eu`, inserts `{ market, ats, boardToken, companyName, origin 'discovered', discoveredFrom, enabled false, countries [] }`. For an import `discoveredFrom` is exactly `user_import`. LRU of 5,000 boards; a database error is swallowed, counted and pauses collecting for 60 s.
- **A board an admin removed is not proposed again** (new file `atsPublic/removed.ts`). `remove` writes `<ats>:<board id in lower case>` into AppConfig `jobs.careerSources.removed.v1` before it deletes the row; discovery answers `known` for a key in that list; an admin add or an import takes the key off. The list holds board ids only, at most 5,000 (oldest forgotten first). The seed loader reads the same list, so a later seed file cannot bring back a board removed before any seed named it.
- `hooks.ts`: `appliesTo` also accepts stage `ingest` and `import` for any market and provider; `afterNormalize` offers the job to discovery. It cannot throw and waits at most 1.5 s.
- Validate, `boards.ts` `validateCandidates(db, limit)`: `enabled false`, origin `discovered` or `import`, `lastSyncedAt null`, `disabledAt null`, a readable system, `nextSyncAt` null or past, oldest first. One list-only read, **of a paged listing its first page** (one request for a SmartRecruiters candidate, however large the board). `judgeCandidate`:
  - at least one posting, AND
  - where the board states its company (Greenhouse, SmartRecruiters): the names match **on whole words** (equal once normalised, or the shorter name's words are a run of consecutive whole words of the longer one). "Bosch" matches "Bosch Group"; "Arc" does not match "Search Party", "Box" not "Dropbox", "Meta" not "Metabase". A discovered source then **takes the name the board states**;
  - where it states none (Lever, Ashby): the board id equals the company name as one word, or the first label of `RACompany.domain`. **A candidate registered without a name (its name is the board id) is `name_unconfirmed` unless the domain confirms it.**
- Pass → `enabled true`, `nextSyncAt null`. Verdict or hard failure → `lastError 'validation:<reason>'`, `lastSyncedAt now`: final. **A read that failed in passing (timeout, 5xx, 429) is retried 1 h, then 2 h later, and the third such failure is final** (`candidateRetry`; `failCount` counts the attempts). No candidate is asked without end.

ACCEPT, tested: a JSearch row with `greenhouse:acme:1` creates a disabled candidate with `discoveredFrom 'jsearch:abc123'`; the name `Acme` enables it and the sync reads it; `Other Corp` leaves `validation:name_mismatch`; an empty Lever board is not enabled; an Ashby import gives `user_import` and the stored row holds no user id, link or text; 1,000 sightings make one insert; the limit of 20 per run holds. Added: `{ boardToken: 'shopback-2', companyName: 'shopback-2' }` is `name_unconfirmed`; a removed board is `known` to a fresh process and no row is created; a busy candidate is asked at T, T+1 h and T+3 h and never again.

Still open, and not mine to close: **the cross-bundle line (MKT-3C writes the key, discovery reads it) is untested here.** No code in this worktree writes `atsPostingKey`. The orchestrator's M3 merge check covers it.

Other departures: before the insert there is one `findFirst` by `(ats, boardToken)` ignoring letter case. Names in a script written without spaces (Han, kana, hangul) are compared as text: the shorter, at least three characters, inside the longer.

### 6. [P1] Bulk import: done

- `contract.ts`: `ImportCareerSourcesBodySchema` (`format`, `rows` ≤ 5,000 or `csv` ≤ 1,000,000 characters, `enable` default false), `ImportCareerSourcesResult { total, created, merged, invalid (first 100), invalidCount }`.
- `routes.ts` `POST /import`; `service.ts` `importMany`: CSV through `csv-parse/sync` (header `ats,boardToken,companyName,countries`, the last two optional, countries separated by `|`, any column order, BOM accepted); per-row checks; `createMany` in chunks of 500 with `origin 'import'`, `enabled = body.enable`; an existing board has only its countries merged (empty wins).
- **A JSON row is accepted in any shape and judged by itself** (after the review): the row schema is `z.unknown()`, `jsonImportRow` turns each entry into a row, and a row without `boardToken`, with a numeric `ats`, with a name that is not text, or that is not an object at all is reported with its number (`invalid_board_id`, `unknown_job_board`, `unreadable_row`). The other rows are added. `ImportCareerSourceRow` documents the shape a client should send.
- Web: `lib/api/careerSources.ts` `adminImportCareerSources`; `CareerSourcesPanel.tsx` gains "Add many boards", a countries field on the add form, columns "Added by", "Countries read", "State", and an optional `market` prop.

ACCEPT, tested: three JSON rows answer `created 1, merged 1, invalid [{ line: 3, reason: 'invalid_board_id' }]`; 5,001 rows → 422 `invalid_request` (JSON and CSV); the new row is a disabled candidate with origin `import`; with `enable true` it is on and due; the panel shows the summary and columns; `npm run check` passes.

Notes:
- `invalidCount` is an addition to the result.
- Reasons: `unknown_job_board`, `invalid_board_id`, `invalid_country`, `too_many_countries`, `company_name_too_long`, `duplicate_in_file`, `unreadable_row`.
- Import accepts the four readable systems only.
- The panel asks for no market by default (the server uses the brand's).
- **The panel now offers "Read it for this site too"** on the 409 for a board read only for the other site's countries: one PATCH that widens the board's countries by the ones in the form (empty means every country; if that still leaves this site out, the mainland site adds CN and the international site reads every country). The old sentence sent the admin to a screen that does not exist.
- A candidate whose check failed in passing shows "Waiting for its first check", not "Not confirmed", until its retries are used up.
- The textarea reuses the `.input` class: `tw.module.css` is not in my owns.
- Not looked at in a browser, in either theme or width.

### 7. [P1] Seed files: done

- `seeds.tw.json` (14 boards, JOB_SOURCES_TW.md 3.5), `seeds.intl.json` (greenhouse `stripe`, ashby `ramp`, JOB_SOURCES_INTL.md 3.2), `seeds.cn.json` (the 26 boards PAR-7 verified, reshaped). Entry: `{ ats, boardToken, companyName, countries, note, confirmedOn }`. Nothing was added from memory.
- `seeds.ts`: `parseSeedFile`, `mergeSeedFiles` (by `(ats, boardToken)`, union of countries, empty wins), `seedHash`, `loadCareerSeeds(db)`. It runs at the start of a board sync and does work only when the hash differs from AppConfig `jobs.careerSeeds.v1`.
- Rules, each tested: a second run writes nothing; a seeded board an admin switched off or renamed stays so; a seeded board an admin removed is not added again; **a board an admin removed before any seed named it is not added either** (the removed list); a board added by hand is untouched; a candidate that discovery or an import had only proposed is taken over.
- `ensureSeedCareerSources(db, market)` is kept for `jobs-plan` (`ingest/cron.ts`, MKT-3A).

ACCEPT, tested: the 14 Taiwan boards exist and cover TW; BoschGroup is one row with exactly `['CN','TW']`; the test fails on an entry without a note, a duplicate, an unknown system, a bad board id or a non-ISO country; the Taiwan token set is pinned.

Departures:
- **Ubisoft2 keeps the name "Ubisoft"**, which PAR-7 read from the board's own metadata.
- **The loader migrates the parity loader's rows once** (`createdBy 'seed:…'`): `origin 'seed'`, the merged countries, `countryCode` cleared. It reads the old key `jobs.atsPublic.seed:cn` once.
- **Not in the item: on the first load a SmartRecruiters source an admin had added on the mainland console with no countries gets `['CN']`.**
- Seeded Lever and Ashby boards carry the board id as their name where no note states one (`ramp`, `veeva`, `airwallex`, `weride`).

### Carry-over

- waveM1 MKT-3D.1: done. `hooks.ts` imports the four pay-wording strings from `normalize/index.js`; the copies are deleted.
- waveM1 MKT-3D.2: **done after the review.** The board sync signs per board (`signingMarket`); "Check now" signs as the brand of the admin's host (`routes.ts` passes `market()`, `service.ts` hands it to the connector). Tested on both hosts.
- waveM1 MKT-3D.3 and wavePAR 2: done (items 1 and 4).
- waveM2: no MKT-3D section.
- wavePAR 1, 3, 4, 6, 7, 7a, 7b: not mine (no file in my owns; 6, 7a, 7b are MKT-3C's by the M1 carry-over). wavePAR 5 names `docs/jobright-clone/market/JOB_SOURCES_CN.md`, outside my owns.

## Files changed

Server, employer boards (`server/src/features/jobs/sources/atsPublic/`):
- rewritten: `adapter.ts`, `service.ts`, `routes.ts`, `seeds.ts`, `index.ts`, `routes.test.ts`
- changed: `hooks.ts`, `connectors.ts`, `contract.ts`, `http.ts`, `shared.ts`, `sync.ts`, `seeds.cn.json`, `atsPublic.test.ts`
- new: `market.ts`, `discovery.ts`, `schedule.ts`, `removed.ts`, `seeds.tw.json`, `seeds.intl.json`, `seeds.test.ts`

Server, ingest and cron:
- new: `server/src/features/jobs/ingest/boards.ts`, `boards.test.ts`
- changed: `server/src/cron/handlers.ts`, `server/src/cron/handlers.platform.test.ts`, `vercel.json`, `deploy/cn/k8s/cronjobs.yaml`, `__tests__/deploy/cronParity.test.ts`

Web:
- changed: `lib/api/careerSources.ts`, `components/features/market/tw/CareerSourcesPanel.tsx`, `components/features/market/tw/__tests__/tw.test.tsx`, `i18n/staging/jobsTw.en.json`
- new: `components/features/market/tw/__tests__/careerSourcesPanel.test.tsx`

Touched in the review round: `schedule.ts`, `shared.ts`, `connectors.ts`, `discovery.ts`, `removed.ts` (new), `service.ts`, `routes.ts`, `contract.ts`, `seeds.ts`, `index.ts`, `ingest/boards.ts`, `CareerSourcesPanel.tsx`, `jobsTw.en.json`, and the six test files of these.

Removed from `atsPublic.test.ts` in the first session: the tests of the old adapter loop, the backlog cursor and the seed threshold (replaced), and the block "TW open data: stays off until the licence spike is confirmed" (it pinned MKT-3E's stub, which MKT-3E replaces in this phase).

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/jobs/sources/atsPublic/atsPublic.test.ts` | 103 passed, 4 todo |
| `… atsPublic/routes.test.ts` | 35 passed |
| `… atsPublic/seeds.test.ts` | 17 passed |
| `… server/src/features/jobs/ingest/boards.test.ts` | 49 passed |
| `… server/src/cron/handlers.platform.test.ts` | 32 passed |
| `… __tests__/deploy/cronParity.test.ts` | 15 passed |
| `… server/src/roboapply/schedulers/RoboApplyCronService.test.ts` | 4 passed |
| `… components/features/market/tw/__tests__/tw.test.tsx` | 18 passed |
| `… components/features/market/tw/__tests__/careerSourcesPanel.test.tsx` | 18 passed |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | all six checks clean |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 717 files: 714 passed, 3 failed. 17,231 tests: 17,214 passed, 6 failed, 1 skipped, 10 todo |

The 6 failures are the one under "Red tests for other bundles" and the five under "Pre-existing failures".

No network request was made in this session. No RapidAPI, bank, payment, model or embedding call in either session.

## Red tests for other bundles

- `server/src/features/jobs/ingest/cron.test.ts` › "GoApply jobs-plan registers the verified seed boards once, plans no search query and calls no provider" (MKT-3A). It asserts every seeded row has `market === 'cn'`, `countryCode === 'CN'` and `createdBy` starting with `seed:`, and at the end that every source row has `market === 'cn'`. A seeded board is now one source for both sites. It should assert `sources.every((r) => r.origin === 'seed' && r.enabled === true && r.createdBy === 'seed')`, and drop the last line (`seedBoardsAdded: 0` for the RoboApply plan already covers it). Its other assertions hold.

## Pre-existing failures

- `components/features/copilot/__tests__/cards.test.tsx`, four tests ("the propose_filter_change tool's own card: CountView counts…", "the server's real 409 (proposals.ts)…", "the remember tool's own card on GoApply carries consentRequired…", "propose_filter_change: the card previews the ops and offers Apply changes"). The wire cards are built with `NOW = 2026-10-10T08:00:00Z` plus a 24 h expiry and the card compares it with the real clock, so they render "This suggestion expired" since 2026-10-11 08:00 UTC. No file of mine is involved. Fix for the owner of that test: build the fixtures with a clock in the far future or freeze the component's clock.
- `server/src/features/jobs/import/directFetch.test.ts` › "a 2 MB page of "<li " is read, and its draft built, in milliseconds". It asserts a wall-clock limit (`read` under 200 ms) and measured 203 ms during the full run, with seven sibling worktrees running their suites on the same machine. Run alone it passes (60 of 60). No file of mine is imported by it.

## Requests

**MKT-3A** (`ingest/cron.test.ts`): the assertion change above. Optional: `runJobsPlan` can stop calling `ensureSeedCareerSources`; the board sync loads the seeds itself.

**MKT-3B** (`ingest/planner.ts`): `ensureBankSyncQueries` still creates and re-enables a standing `ats_public` query per market. It reads nothing, but each lease writes an empty "last run" into `jobs.source.status:<market>:ats_public`, over the board sync's own, so the admin console's "last run" of the boards flips to empty every 10 minutes. Skip `ats_public` there and switch its existing standing queries off.

**MKT-3F** (`features/admin/system.ts`): the three `rACareerSiteSource.count({ where: { market } })` calls count by the display column. Count by coverage instead (`sourceFeedsMarket`, exported from `sources/atsPublic/index.js`), or the board counts of both brands are wrong for shared rows.

**Orchestrator**
- Hold the M3 gate on the three seams above (the review confirmed all three).
- `components/v3/admin/SourcesConsole.tsx` `CareerBoardsPanel` (GoApply's board manager, no owner in M3): replace it with `<CareerSourcesPanel market="cn" />`. Until then it works but lacks import, countries, state and the "Read it for this site too" action, and line 262 still tests for the retired reason `board_on_other_site`, so on GoApply the 409 for a board read only for other countries prints "already in the list" for a board its list does not show. If the panel is not replaced, map `details.reason === 'board_read_for_other_countries'` there.
- `components/features/market/tw/tw.module.css`: a `.textarea` class (vertical padding) for the import box.
- `components/v3/admin/__tests__/sources.test.tsx`: its `board()` literal can add the new view fields; then the eight fields in `CareerSourceView` can become required again.
- zh-TW pass: the `jobsTw.admin.*` strings below are admin copy for RoboApply; the panel is not Taiwan-specific.
- M3 merge checks from the plan: `jobs-boards` is in `vercel.json`, `cron/handlers.ts` and the regenerated CronJob file with `*/5 * * * *` (asserted by two tests here); MKT-3C's `atsPostingKey` reaches the hook object (item 5).

**Owner**
- Vercel plan: `jobs-boards` is the 16th cron entry.
- All 26 measured mainland boards are registered and switched on, including the 12 with fewer than 10 mainland postings (scopely, Canva, mongodb, agoda, adyen, moloco, applovin, airbnb, databricks, epicgames, weride, appier). They also feed RoboApply now. Say if any should be left out.
- The 50 mainland-hiring boards before GoApply's production launch are an operations task through import and discovery; the seed holds 26.
- `JOB_SOURCES_CONTACT` and `CN_JOB_SOURCES_CONTACT` should be set before the first production run, so the User-Agent names a mailbox and not only the site.
- Names to correct by hand on the boards that state none: `ramp`, `veeva`, `airwallex`, `weride`.
- 401 and 403 are retried every 6 hours before they switch a board off (12 hours in all). Say if the 1 hour of other hard failures is wanted.

## Schema requests

None. The M0 columns are enough. Two comments are out of date: `RACareerSiteSource.disabledAt` is now set when a source is switched off by an admin as well as by three failures; `failCount` and `nextSyncAt` on a candidate (off, never read) count and schedule its list-only read attempts.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `ATS_BOARDS_CONCURRENCY` | board listings read in flight by the board sync, clamped to 4-8 | 6 |
| `ATS_SR_DETAILS_PER_RUN` | SmartRecruiters posting texts read per board and run, 1-1000 | 100 |
| `ATS_DISCOVERY_VALIDATIONS_PER_RUN` | candidate sources validated per board-sync run, 0-200 (0 = none) | 20 |
| `ATS_PUBLIC_SOURCES_DISABLED` | existing kill switch; now also stops the board sync, "Check now", validation and discovery | false |

Read, not new: `JOB_SOURCES_CONTACT`, `CN_JOB_SOURCES_CONTACT` (through `sourceUserAgent`), `CN_RECRUITMENT_INFO_MODE` (through `ingestAllowed`), `ALLOWED_BRANDS`.

AppConfig keys: `jobs.careerSeeds.v1` (new: `{ hash, offered[] }`), `jobs.careerSources.removed.v1` (new after the review: `{ boards[] }`, board ids an admin removed), `jobs.atsPublic.seed:cn` (read once, never written), `jobs.source.status:<market>:ats_public` (now written by the board sync).

## i18n keys added or changed

`i18n/staging/jobsTw.en.json`, all under `jobsTw.admin`.

Changed:
- `subtitle`, `run.queued`, `run.waiting` (the old sentences named a 6-hour interval and an immediate import)
- `offNote` (after the review: adds that a removed board is not picked up again from a posting's link)

Added:
- `add.countries`, `add.countriesHint`
- `list.all`, `list.columns.origin`, `list.columns.countries`, `list.columns.country` (now "City hint"), `list.columns.state`
- `origin.admin`, `origin.seed`, `origin.import`, `origin.discovered`
- `state.on`, `state.waiting`, `state.notConfirmed`, `state.off`, `state.offAfterFailures`
- `errors.otherCountries` (reworded after the review), `errors.otherCountriesAction`, `errors.otherCountriesDone` (takes `{company}`)
- `problem.sources_off`, `problem.empty_board`, `problem.name_mismatch`, `problem.name_unconfirmed`
- `import.title`, `import.intro` (takes `{header}`), `import.paste`, `import.file`, `import.enable`, `import.enableHint`, `import.submit`, `import.importing`, `import.summary`, `import.invalidTitle`, `import.invalidRow`, `import.invalidMore`
- `import.errors.empty|json|tooLarge|invalid|file`
- `import.reason.unknown_job_board|invalid_board_id|invalid_country|too_many_countries|company_name_too_long|duplicate_in_file|unreadable_row`

No longer read by this panel: `jobsTw.admin.list.columns.status`, `jobsTw.admin.status.on`, `jobsTw.admin.status.off`. No `zh` staging file: nothing here is GoApply-only.

## Known gaps

- **Not run against a database or a browser.** The lease statement is tested as text and through a fake that plays it; `FOR UPDATE SKIP LOCKED` itself is Postgres's. The new panel action was not looked at in either theme or width.
- **A posting stored by the parity wave under a plain id in market cn, located in both markets**, is now the intl copy's id: the upsert moves that row to intl and writes a new `#cn` row. One-time, on the first sync of such a board.
- **The first runs after deploy read every source.** About 38 seeded boards plus what exists; BoschGroup's 1,322 mainland postings take about 14 runs (70 minutes) at 100 texts per run.
- **Discovery waits for MKT-3C's `atsPostingKey`.** Until that merges no candidate is created.
- **The status "last run" of the boards flaps** until MKT-3B's change (Requests).
- **`country_not_selected` is in the cron result only**: `ingest/status.ts` (no owner) has no such reason.
- **Read-ahead is discarded at the end of the budget**: up to 12 boards can be read and not written in the last round; they are due first at the next run.
- **`list` answers at most 2,000 rows** with no paging.
- **Removing or switching off a board is global.** A GoApply admin can remove a board that also feeds RoboApply; there is no confirmation that names the other site.
- **A new posting whose text can never be read brings its board back every hour, for as long as the board lists it.** That is the review's rule (1 hour instead of 5 minutes); there is no per-posting give-up. For BoschGroup that is 15 listing requests and up to 100 text requests an hour.
- **A candidate on Lever or Ashby imported without a company name is never confirmed automatically** unless a company of that name with a matching domain exists; it stays "Not confirmed" (`name_unconfirmed`) until an admin switches it on. This sentence was wrong in the previous handoff: the code then returned `ok`. It is true now, and tested.
- **The removed list is written by read-modify-write.** Two admins removing boards in the same instant can lose one entry; that board may be proposed again as a candidate (off until its check passes or an admin switches it on).
- **A board larger than 15 MB in one answer** (`response_too_large`) is now a hard failure: three such reads switch the source off. Before the review it was retried for ever.
- **"Check now" on a Lever board still pages the whole listing** (Lever states no total). Only SmartRecruiters is read by its first page.
- **A host that answers 403 to block our address** switches its boards off after three refusals 6 hours apart (12 hours). An admin switches them back on; nothing does it automatically.

## Review resolution

Each finding was checked against the code before it was touched. All eleven were real; none was rejected. Nothing outside the owns was edited, so there was nothing to revert.

Items the review judged not done:

1. **Item 5, discovery** — fixed in the three cases it named (findings 3, 4 and 5b below). The cross-bundle line with MKT-3C stays untested here: no code in this worktree writes `atsPostingKey`; it is an orchestrator merge check.
2. **Carry-over waveM1 MKT-3D.2, User-Agent with the market of the request** — fixed (finding 1).

Findings:

1. **(medium) "Check now" signed as RoboApply on GoApply** — fixed. `routes.ts` passes `market()`; `service.ts` `runNow(id, market)` hands it to the connector. In `boards.ts`, `signingMarket` signs a board that feeds only cn as GoApply where GoApply is served. Tests: `routes.test.ts` "says who is asking as the brand of the admin's site" (the fake fetch saw `GoApplyJobs/…` on the GoApply host, and never "roboapply" even with no contact set); `boards.test.ts` "a board read for the mainland only is asked as GoApply".
2. **(medium) SmartRecruiters: a failing text made the board due every 5 minutes** — fixed. `BoardRead.failedDetails` apart from `pendingDetails`; `nextReadDelayMs` in `schedule.ts`. Beyond the suggested fix: a run refused every text waits an hour even with a backlog pending, and a 429 stops the run's text requests, because the suggested rule alone still answered a rate limit on a large board by returning in 5 minutes. Tests: `boards.test.ts` "a posting whose text request always answers 403 …", "a rate limit on the texts (429) …", "one text that keeps failing does not hold up a backlog"; `atsPublic.test.ts` "posting texts: not asked for yet -> at once …".
3. **(medium) A removed board was found again by discovery and switched on** — fixed with the AppConfig list (`removed.ts`), not a soft delete. `remove` records it; discovery and the seed loader honour it; an admin add or an import clears it. Tests: `routes.test.ts` "a removed board stays removed", "adding a removed board again … the removal is forgotten"; `atsPublic.test.ts` two tests on the list; `seeds.test.ts` one.
4. **(medium) Lever and Ashby candidates without a company name passed with no name check** — fixed in `judgeCandidate`: a placeholder name is `name_unconfirmed` unless the domain's first label matches. Tests: `atsPublic.test.ts` "a candidate registered without a company name …" (the review's two reproductions are its first two lines); `boards.test.ts` Lever and Ashby cases. The wrong sentence in Known gaps is corrected.
5. **(medium) A read failing with a non-404 error never ended** — fixed. (a) `classifyBoardError`: every 4xx except 408 and 429 is hard, and so is `response_too_large`. (b) Candidates: `candidateRetry`, selection by `nextSyncAt`, final at the third attempt. My addition: 401 and 403 are retried every 6 hours, not 1 (see "Read this first" 6). Tests: `boards.test.ts` "a board that answers 403 or 410 for good …", "a 429 or a 408 never counts", "a board that is not there, or that refuses us, is final; … a bounded number of times"; `atsPublic.test.ts` three schedule tests.
6. **(low) "Check now" and validation paged a SmartRecruiters listing to its end** — fixed with `ReadOptions.firstPage` and `BoardRead.listedCount`. One request per country pass; the count is the board's `totalFound`. Tests: `atsPublic.test.ts` "firstPage …" (1,322 + 31 postings: two requests, `listedCount` 1,353); `routes.test.ts` "a large board is checked from its first page per country"; `boards.test.ts` "a candidate is checked from ONE request".
7. **(low) The company-name match was a substring test, and a matched board kept the aggregator's name** — fixed. `companyNamesMatch` compares whole words; a discovered source takes the board's stated name. Tests: `atsPublic.test.ts` "companyNamesMatch compares whole words" (the review's three pairs are in it); `boards.test.ts` "a name is matched on whole words …".
8. **(low) Changing the countries of a source switched off by failures cancelled its 48-hour archive** — fixed with the suggested guard in `update()`. Test: `routes.test.ts` "changing the countries of a source that failed reads switched off …".
9. **(low) The "read for other countries" message asked for something no screen offers** — fixed in my panel: the 409 carries `countries` and `market`, the sentence is reworded, and the panel offers "Read it for this site too". Tests: `careerSourcesPanel.test.tsx` four tests; `routes.test.ts` asserts the details and that the widened board then shows in the list. The `SourcesConsole.tsx` half is not mine: Request to the orchestrator.
10. **(low) JSON import: one bad row refused the whole file** — fixed. Tolerant row schema, `jsonImportRow`, per-row reasons. Tests: `routes.test.ts` "a JSON list with rows that lack a field …" (eight rows, six reported, two added); `atsPublic.test.ts` "a JSON list may hold anything".
11. **(low) Seams with sibling bundles** — confirmed, and unchanged by design: all three need an edit in a file another bundle owns. They are under "Red tests for other bundles" and "Requests" (MKT-3A, MKT-3B, MKT-3F), with a line asking the orchestrator to hold the M3 gate on them.
