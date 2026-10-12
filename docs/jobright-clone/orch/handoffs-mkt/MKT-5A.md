# MKT-5A

Licensed feed (Active Jobs DB): hourly window sync with the expired feed behind the quota gate; Active Jobs DB for the mainland (JI-7, JC-6). Worktree `wp-MKT-5A`, branch `wp/MKT-5A`, nothing committed. Only paths of my owns were edited (`git status` lists 12 modified and 6 new files, all in the owns). Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-5A.md`.

This is the handoff after the independent review. The review had eight findings and one item judged not done. I checked each against the code: all nine are real, none was rejected. Eight are fixed in my files with tests. Finding 7 lies entirely in a file I do not own (Request 5). Findings 1 and 5 also need a line outside my owns each (Requests 1, 4 and 8); their owned half is done and tested. The list is under "Review resolution".

Nothing was run against a database, RapidAPI, the vendor's API with a key, a model or a payment provider. What I read on 2026-10-12, all public and keyless: the vendor's documentation pages on `developer.fantastic.jobs` (authentication, new-jobs, expired-jobs, credit-usage, supported-ats-sources, enrichments, recommended-strategy, time-fields, nuances-of-location-search, field-changes-old-to-new, count-endpoints, ats-vs-jb-fields, your-first-api-call) and its OpenAPI document `https://data.fantastic.jobs/openapi`. In the review round I read four of them again (new-jobs, expired-jobs, recommended-strategy, time-fields) to settle finding 8. No response of the API was ever seen: every row in the fixtures is SYNTHETIC, built from the documented field list.

With today's free plan (25 requests, 250 postings a month) the feed and GoApply's Active Jobs DB are gated: nothing is planned, leased or fetched for them, and the admin System panel shows them as `gated`. Two things change for RoboApply on any plan: the search asks quoted phrases (item 7), and Active Jobs DB no longer writes a mainland China posting for RoboApply (one posting, one market: review finding 2).

## Review resolution

| # | Finding | Verdict | What was done |
|---|---|---|---|
| 1 | high: the gate is asked before the stored quota reading is loaded | Real. `cron.ts` lists the adapters at lines 64 and 88 and loads the reading at 67 and 90; `runJobsMaintain` never loads it. | Owned half done. (a) A source behind a plan is still a source of the brand while its gate is closed: `providers.ts` `knownIngestProvidersForBrand`; `runPlanner` hands the ones missing from its list to `retireUnrunProviders(…, waiting)` and to `retireUnusedDemand`, so the feed's standing query stays switched on with its cursor and GoApply's Active Jobs DB demand keeps its score. A provider narrowed away by `JOB_PROVIDERS_<BRAND>` is not in that list and is still retired. This removes old Known gap 8. (b) One step more than the review asked, because the same short list had a second effect the review did not name: with the feed missing from the list `feedCoversBoard` answered "no feed", so a plan run on a new instance planned the SEO seeds on the search adapter again and they would have been bought per posting for a day. `runPlanner` now asks the brand's sources behind a plan whether they are on at plan time (`planAdaptersOnNow`; cron has loaded the reading by then) and completes its list. (c) The tick and maintenance cannot be put right from my files: Request 1, exact diff. Tests: `planner.test.ts` (4 new or rewritten whole-run tests), `fantasticFeed.test.ts` ("the gate reads the reading THIS process holds"). |
| 2 | medium: one vendor posting written by RoboApply's search and by GoApply's sync | Real. | `rapidApi.ts`: Active Jobs DB rows are routed by their own location in both markets (`rowsOfMarket(inputs, query.market)`); a mainland row of an international query is counted `wrong_market`. So that RoboApply does not pay for rows it then drops: the planner plans no international query for mainland China on a source that serves both markets, and a stored one answers `other_market_location` without a call. JSearch is not rerouted (its rows are RoboApply's alone). Tests: `rapidApi.cn.test.ts` block "one posting, one market, in both directions" (5 tests, one through `runIngestQuery` on a stored cn row), `planner.test.ts` "one posting, one market". |
| 3 | medium: a failing monthly expired call stops the hourly and daily calls for good | Real: `dueExpiredFrames` returned `['1m']` alone and no clock moved. | `fantasticFeed.ts`: a monthly call that was made and failed stamps `lastExpiredMonthlyTriedAt` and the loop goes on with the hourly and daily call of the same cycle; it is tried again after 24 hours (`FEED_MONTHLY_RETRY_MS`). The outage is counted from the last answer of any frame (`expiredOutage`). One field more than the review named: `expiredGap`. Without it the hourly answer that follows the failed monthly call would end the outage, and the two days before it would never be reconciled; the gap is remembered until a monthly call is answered. Tests: three failing weeks (21 monthly attempts, 504 hourly answers, the hourly clock moves every hour), the remembered gap, a call that was never made. |
| 4 | medium: a 401 / 403 on a feed route opens the shared breaker and drops the plan's stated size | Real. | `raFantasticJobs.ts`: `getUpstream` takes the route. A 401 / 403 on `expired` answers `refused` and nothing else: no breaker, no report to the quota listener. `fantasticFeed.ts`: the refusal sets `expiredRefusedAt`, the route is not asked again on that UTC day, note `feed_expired_refused`. A 404 on that route (a renamed path) is treated the same, so a wrong path costs one request a day and not one every cycle. Tests: the client test the review asked for (a 403, then a search and a new-jobs call that are served; a 401; the log line), a wired test with the real quota module (the gate stays open, `jobsLimit` kept), the adapter tests. |
| 5 | medium: on a deployment that serves only GoApply the gate never opens from headers | Real. | `config.ts`: the gate has a reason of its own, `plan_unknown`, when nothing states the plan's size. `quota.ts` `hydrateProviderQuota` warns once per process when the key is there, no international brand is served and the reason is `plan_unknown` (it names `FANTASTIC_MONTHLY_JOBS`). The registry code the admin panels read stays `plan_too_small` for both, and that is deliberate: I first emitted `plan_unknown` there and two tests of the admin area went red (`routes.test.ts` "GET /system lists every provider", `services.test.ts` "daily health email"). `admin/system.ts` knows one code for a plan gate; with any other code a row whose reading is used up read as `exhausted` and raised `provider_quota` alerts for sources that never ran (two more in the System status of the first test, three more in the daily health e-mail of the second). I took that back (`FEED_GATE_REASON_CODE`, one table in `config.ts` for both adapters) and pinned it in `rapidApi.cn.test.ts`. The panel's own line is Request 4; the env text is the MKT-5H request; old Request 10 is corrected (Owner 4 below). |
| 6 | medium: the feed's day equals the whole plan; people's own searches are not counted | Real. | `config.ts`: `feedJobsReserve` (the share ingest leaves of the plan's requests, taken of its postings, at least one search page of 20), `feedJobsLeft`, `feedQuotaDailyJobs` = `floor((jobsRemaining − reserve) / max(1, daysToReset))`, and `feedDailyJobs` / `feedDailyJobsFor` take the smaller of that and the month / 31 day, split between the markets as before. The adapter never cuts into the reserve, with or without a reset time. The provider's remaining count holds what people's searches were billed for, so they are no longer on top. Tests: 10 days and 10,000 left give 950 a day on a 10,000 plan and 500 on a 100,000 plan; no stated remaining count leaves the old rule; the split; the real reading. |
| 7 | low: `job-search/service.ts` still tests `RAPID_API_KEY` on the direct transport | Real (lines 148 and 256). The file is outside my owns. | Request 5, exact change. |
| 8 | low: the hourly window is taken on trust | Real, and the vendor's pages do contradict each other (the table says "Rolling 1-hour window", the example says 07:00 to 08:00 at 09:15). | The first option of the review: the sync never asks `time_frame=1h`. Every hour it asks the slice it means by explicit bounds (`time_frame=7d`, `date_created_gte` the edge the last slice ended at, `date_created_lt` the newest full UTC hour that is an hour old), which is the vendor's own recovery recipe. A gap is simply part of the next slice. And before a page moves the cursor its rows are compared with the slice (`rowsOutsideSlice`): when more than half were indexed outside it, the run is an error (`window_not_applied`), nothing is written and the cursor stays. `FANTASTIC_FEED_SLICE_CHECK_DISABLED=true` is the operator's way out should the check misjudge real responses. Tests: block "a page that is not the slice that was asked never moves the cursor" (5 tests), the rewritten hourly block. |
| 9 | not done: carry-over M3.1, a reserve on postings | Real: the day's budget was not a reserve. | Done with finding 6. |

No unowned edit existed and none was made.

## Where the plan documents and the vendor's documentation overrule the item text

The item says to use the feed the way the vendor documents it. Reading that documentation changed these points. Each is tested and named in the file headers.

1. **An hour is asked by explicit bounds, never as `time_frame=1h`** (changed in the review round; see finding 8). The item says "request time_frame=1h" and, after an outage, "date_created_gte=highWater". The sync asks `time_frame=7d` with both `date_created` bounds every time, and the lower bound is the edge the last slice ended at, not the newest posting seen (that row was already bought). The cursor keeps `window` (always `7d`) and `highWater` (for the record only).
2. **Fresh first: the hourly slices do not wait for the backfill.** A backfill that blocks them leaves a week of hours behind it, and a day's budget sized to the plan can never absorb that. The backfill and the hours are two page runs with their own offsets; an hour that is due is read before the next backfill page. The backfill still runs once and never again.
3. **`include_basic_organization_details` is not sent, and industry / size / head count are not mapped.** The vendor's OpenAPI document says the flag returns the LinkedIn company profile plus two Crunchbase fields. LinkedIn organisation fields are never mapped (H9, strategy 1.6), and no note confirms a right to show Crunchbase data. `companyFacts` gets `domain_derived` and the website, with source `provider:activejobs`.
4. **`ai_visa_sponsorship: false` is not stored as "not offered".** The field means "the description mentions sponsorship". `false` is most postings; labelling them "the provider says no sponsorship" would be a false statement (D3). `true` gives `sponsorshipProvider 'offered'`; `false` and an absent flag give null.
5. **The direct key's header is documented, so it has a default.** `Authorization: Bearer <key>`, host `data.fantastic.jobs`, routes `/v1/active-ats` and `/v1/expired-ats`. `FANTASTIC_API_KEY_HEADER` is an override of the header name; `no_key` means the key of the chosen transport is missing.
6. **`FANTASTIC_TRANSPORT` is the transport of the whole client, search included.** One transport, one plan, one quota reading.
7. **The direct API states its quota in other headers** (`x-api-jobs-limit`, `x-api-jobs-remaining`, `x-api-requests-limit`, `x-api-requests-remaining`, `x-api-next-billing-date`). `quotaObservationFrom` reads both families.
8. **The vendor's taxonomy labels are 33 fields of work, not roles.** The table maps a label to a category (level 1) where the names coincide and to null otherwise. The normalizer still decides the role from the title (Request, MKT-5F).
9. **Feed requests are counted under `activejobs_feed` / `activejobs_feed:cn`, billed postings under `activejobs` / `activejobs:cn`.** The pipeline counts every adapter under its own id, and the search adapter's daily call limit is enforced on the `activejobs:cn` row: the feed's requests would use up the 20 mainland search calls by mid-morning. The postings the plan was billed for are what the budget needs, and they are under the plan's row.
10. **The mainland's posting budget is part of the day, not on top of it.** 20% of the day for the mainland, the rest for the international sync.
11. **The gate names the plan before the key, and has a sixth reason.** The item lists five reasons; `plan_unknown` (nothing states the plan's size) is the sixth (finding 5). A deployment with no key and no plan is waiting for a plan; the System panel shows `gated`, not a second "exhausted" alarm for a source that never ran.
12. **One posting, one market, also for RoboApply** (changed in the review round; finding 2). The item routes rows by location for market cn only. Rows of this provider are keyed by the vendor's id whatever market asked and the upsert writes the asking market onto the row, so on a database that serves both brands the rule has to hold in both directions. It is the rule JC-4 already sets for the employer boards ("a posting in 上海 lands in the GoApply index and not in RoboApply's"). A RoboApply user who searches mainland China still gets JSearch rows.

Two smaller ones: the unverified marketplace route `/expired-ats` (Known gaps), and unknown query parameters are answered with HTTP 400 by the v1 API, so every request is built from an allow-list of documented names.

## Items

### 1. [P0] Quota gate and transports: done

- `ingest/config.ts`: the knobs and the pure rules. `FEED_MIN_MONTHLY_JOBS` 20,000, `feedMonthlyJobs` (the larger of the stated `jobsLimit` and `FANTASTIC_MONTHLY_JOBS`), `feedGateFor` (reasons in order: `disabled`, `plan_unknown`, `plan_too_small`, `no_key`, `exhausted`, `ok`), `FEED_GATE_REASON_CODE` (the registry codes), `feedDailyJobs` (`INGEST_FEED_DAILY_JOBS`, else `floor(monthly / 31)`, never more than `feedQuotaDailyJobs`), `feedDailyJobsFor(market)`, `feedJobsReserve`, `feedJobsLeft`, `feedCountries`, `feedTaxonomies`, `mainlandActiveJobsEnabled`, `servesMarket`, `feedSliceCheckDisabled`.
- `ingest/quota.ts`: `feedGate(env, now)` supplies the facts (the snapshot's `jobsLimit`, kept across a reset; the key of the chosen transport; the provider's kill switches; whether the plan's quota stops ingest now). `feedGateForMarket('cn')` adds `CN_ACTIVEJOBS_ENABLED`. `providerJobsToday` reads the day's `jobsReturned`. `hydrateProviderQuota` says once when a mainland-only deployment can never read the plan's size.
- `roboapply/v2/lib/raFantasticJobs.ts`: `feedRequest(route, params, opts)` next to the search, on one shared `getUpstream` (25 s timeout, breaker, call gate asked as ingest, quota listener, one retry of a burst 429). Transports `rapidapi` (default) and `direct`. Route overrides `FANTASTIC_FEED_PATH` / `FANTASTIC_EXPIRED_PATH` (a plain path only; the host is fixed). A 401 / 403 on the expired route opens no breaker and reports nothing. Never throws; errors are short codes; an answer whose stated length is over 96 MB is not read.
- ACCEPT, tested: the free plan's snapshot (`jobsLimit` 250) closes the gate with `plan_too_small` and the adapter builds no request; `jobsLimit` 100,000, or `FANTASTIC_MONTHLY_JOBS=100000` with a key, opens it and the day is 3,225; `FANTASTIC_FEED_DISABLED=true` closes it; the direct transport without its key reports `no_key`; no key value is in a result, a log line or an error text.
- Tests: `quota.test.ts` (72: gate table, order of reasons, budget arithmetic, the reserve, the mainland bound, the mainland-only hint, the refused expired route with the real quota module), `raFantasticJobs.test.ts` (102).

### 2. [P0] Window-sync adapter: done

- `ingest/adapters/fantasticFeed.ts`: provider `activejobs_feed`, kind `cursor`, markets `['intl','cn']`, `per_job`, board `activejobs`, `dailyCallLimit` null, `isEnabledFor(market)` = the gate. Cursor `{ v: 1, phase, window, offset, since, until, highWater, lastHourlyAt, backfillOffset, backfillUntil, lastExpiredHourlyAt, lastExpiredDailyAt, lastExpiredMonthlyAt, lastExpiredMonthlyTriedAt, expiredGap, expiredRefusedAt }`. One fetch makes at most one new-jobs request; a full page answers `exhausted: false` and stores the next offset.
- The backfill is the seven-day window up to the hour edge of its first request (`date_created_lt`); the hourly slices continue exactly where it ends, each `[the last edge, the newest full hour that is an hour old)`.
- A page whose rows were mostly indexed outside the slice that was asked is an error and moves nothing (finding 8).
- The day's posting budget is hard: the page's `limit` is cut to what is left of it and to what the plan has left above the reserve, and nothing is asked once the day is reached. A sync that is six hours or more behind while its day is spent logs a warning with the numbers.
- `ingest/providers.ts`: the adapter is registered in `ensureBuiltinAdapters`. `sourcesForBrand` always lists it; `adaptersForBrand` and `ingestProvidersForBrand` contain it, directly after `activejobs`, only while it is on for the brand's market; `knownIngestProvidersForBrand` names it on or off; `planAdaptersOnNow` is what the planner asks at plan time.
- `ingest/planner.ts`: `feedCoversBoard` (no SEO seeds on a metered search source while a cursor source that is on writes its board); the run completes its adapter list and retires nothing of a source that is waiting for its gate (finding 1).
- ACCEPT, tested: two pages of 1,000 and 240 rows give two requests with offsets 0 and 1000, the first answering `exhausted: false`; an interrupted run resumes at offset 1000 from the serialised cursor alone; a second fetch within the hour makes no request; the backfill never runs again after the phase switched (30 further hours, and a damaged cursor); with the gate closed the adapter is off, `adapterRunsInTick` is false, `runIngestQuery` answers `disabled` and no request is built.
- Tests: `fantasticFeed.test.ts` (82, injected transport, fake clock, fake database), `planner.test.ts` (94, five of them whole plan runs with the feed).

### 3. [P0] The expired feed closes our rows by id: done

- After the new-jobs side has nothing more to read in a fetch, the due expired calls run: `1m` once in 30 days and after an outage (first, because an answered monthly call covers the two others), `1h` when an hour has passed, `1d` once per UTC day after 01:00. Ids become `activejobs:<id>` in `closedExternalIds` with `closeReason 'source_removed'`.
- A list longer than 10,000 ids is first cut down to the rows we hold open, read in pages of 5,000 by id.
- A failed expired call is a counted note (`feed_expired_error`), never an error result: the rows of the same fetch are written, its clock is not moved, the next cycle asks again. A failed monthly call does not hold the others back and is tried again a day later. A route that refuses the key or is not there is asked once a day (`feed_expired_refused`).
- ACCEPT, tested end to end through `runIngestQuery`: the fixture's id of a stored open row archives that row as `source_removed`; a row with another id, the same id on another board and a private row are untouched; each clock runs at most once per period; a transport error keeps the new rows and is retried.
- Fixture: `normalize/__fixtures__/fantastic-expired.json` (ids only).

### 4. [P1] Filters: done

- `location`: full country names in double quotes joined by OR. Default `US,CA,GB,IE,DE,FR,NL,ES,IT,SE,AU,SG,TW`; the mainland query names `"China"` only. An unknown code is skipped and logged once. `CN` in `INGEST_FEED_COUNTRIES` is left to the mainland sync. No country left means no request.
- `exclude_source`: one grouped statement over `RACareerSiteSource` (enabled rows per `ats`), reused for ten minutes; an ATS is excluded from 200 enabled boards. Name map `greenhouse`, `lever.co`, `ashby`, `smartrecruiters`, `workable`, `recruitee`, `personio`, each confirmed on the vendor's "Supported ATS Sources" page. A failed count excludes nothing.
- Agencies are not excluded; `organization_agency` is never sent.
- `INGEST_FEED_TAXONOMIES`: the names the vendor documents become `ai_taxonomies_a`; an undocumented name is skipped and logged; if every name is unknown no request is made.
- ACCEPT, tested: 180 Greenhouse and 210 Lever boards exclude `lever.co` and not `greenhouse`; the threshold at 199 / 200; no boards, nothing excluded; country names for intl, China only for cn; an unknown code is never sent.

### 5. [P1] The feed's own fields first: done, with corrections 3 and 4 above

- `normalize/adapters.ts` `inputFromFantasticJob`: `companyFacts.domain` from `domain_derived`; `expiresAt` from `date_valid_through` (the v1 name) with the older names still read; `sponsorshipProvider`; `taxonomyId` from the primary `ai_taxonomies_a` label through `FANTASTIC_TAXONOMY_CATEGORY`. The signature is unchanged (carry-over M3.10).
- The search path carries the same reading (`ExternalJobNormalized.sponsorshipProvider`).
- ACCEPT, tested: a fixture row gives seniority from the provider's level, a provider work model, skills, `companyFacts.domain`, `sponsorshipProvider 'offered'` and the expiry; a row without the flag gives null; an unmapped label leaves `taxonomyId` unset; no LinkedIn, Crunchbase, recruiter or hiring-manager field is on the input; the `fantastic.json` tests still pass.
- Fixtures: `fantastic-feed.json` (new, SYNTHETIC, v1 names), `fantastic.json` unchanged, README updated.

### 6. [P1] Active Jobs DB for GoApply: done

- `ingest/adapters/rapidApi.ts`: `activejobs` serves `['intl','cn']`; `jsearch` stays `['intl']` and refuses a mainland query (`market_not_served`). `isEnabledFor('cn')` = the client is usable, the plan gate is open for the mainland, and the mainland call bound is above 0.
- A mainland request is built by `mainlandSearchParams` from the taxonomy alone: the role's Simplified Chinese label and its English label as two phrases, `China` or a mainland city of our city table. The stored query text is not used. A query without a taxonomy role asks nothing. The planner never plans a typed title on a metered provider for market cn.
- One posting, one market, in both directions (finding 2): the mainland keeps mainland China only, the international market keeps everything else, in the search adapter and in the feed.
- `INGEST_ACTIVEJOBS_CN_DAILY_CALLS`: 0 while the gate is closed, 20 while it is open, the operator's number when set. The 20 are ingest's: a person's own mainland search is still let through only under a bound the operator set.
- `providers.ts`: the K7 rule. A built-in adapter registered for the brand's market joins the brand without the brand registry naming it, except `jsearch` and `linkedin` for market cn. `platform/brand/registry.ts` is not edited and not imported.
- ACCEPT, tested: with the gate open the adapter serves both markets, a mainland feed fetch asks `location="China"` and adds its billed postings to `activejobs:cn`; the request URL holds only `title`, `location`, `time_frame`, `description_format`, `limit` and no user-derived value; with the free plan nothing is planned or fetched for cn and the System panel's rows `activejobs:cn` and `activejobs_feed:cn` read `gated`; a Hong Kong row is not written to market cn; `adaptersForBrand(goapply)` never contains `jsearch`, contains `activejobs` and `activejobs_feed` while the gate is open and neither while it is closed.
- Tests: `rapidApi.cn.test.ts` (30), `fantasticFeed.test.ts` (the mainland block), `planner.test.ts`.

### 7. [P2] Quoted phrases: done

- `titleFilterFrom(role, synonyms)`: the role and up to two synonyms as quoted phrases joined by OR, lower case, every kind of double quote, the backslash and control characters removed, 60 characters at most. `ExternalSearchParams.titleSynonyms`. The ingest adapter fills it from the role's English names, not for a typed title. `RESULT_LIMIT` stays 20.
- ACCEPT, tested: `'Senior Product Manager'` gives `'"senior product manager"'`; with synonyms the OR of the phrases; a role with a double quote is cleaned; the cache key holds the whole expression.

## Carry-over

| Entry | State |
|---|---|
| M3.1 `isEnabledFor`, mainland counting, a reserve on postings | Done, all three. The reserve: `feedJobsReserve` (finding 6). |
| M3.2 `queryLanguages`, `isEnabledFor`, `dateWindows` on a mainland source | Done: `activejobs` declares `['en','zh-CN']`; no planner branch. |
| M3.3 `createRapidApiAdapter` declares cost model, languages, windows | Done. `dateWindows` is read live from `RA_ONBOARDING_FANTASTIC_WINDOW`. |
| M3.4 admin panel | (a) and (b) done: `plan_too_small` is the adapters' code and the registry lists the source for cn. (c) is Request 3: `ingest/index.ts` and `admin/limits.ts` are not mine. |
| M3.5 `ownRun` | Not declared: the feed is read through the ingest tick. |
| M3.6 a cursor on an error result | Not done (`pipeline.ts` has no owner). Not needed: an expired failure is a note, and a failed page changes nothing. |
| M3.7 `complete: false` | Done for a full Active Jobs DB page (20 rows). The feed is a cursor source and is never counted. |
| M3.8 the three shares | Untouched. The feed is not demand. |
| M3.9 `quotaClosed` | Untouched. |
| M3.10 `inputFromFantasticJob` signature | Unchanged. |
| M4.1 Greenhouse is over 200 | Covered: the rule excludes `greenhouse` with the merged seed, and nothing with the mainland stack's 28 boards. |

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-5A/`.

Modified: `server/src/features/jobs/ingest/{config,quota,planner,providers}.ts`, `ingest/adapters/rapidApi.ts`, `ingest/{quota,planner}.test.ts`, `server/src/features/jobs/normalize/adapters.ts`, `normalize/__fixtures__/README.md`, `server/src/roboapply/v2/lib/{raFantasticJobs,raExternalJobTypes}.ts`, `raFantasticJobs.test.ts`.

New: `ingest/adapters/fantasticFeed.ts`, `ingest/adapters/fantasticFeed.test.ts`, `ingest/adapters/rapidApi.cn.test.ts`, `normalize/adapters.fantastic.test.ts`, `normalize/__fixtures__/fantastic-feed.json`, `normalize/__fixtures__/fantastic-expired.json`.

12 files modified (2,804 lines added, 251 removed), 6 new (3,339 lines).

## Tests run

| Command | Result |
|---|---|
| The six test files I own | 399 passed: `fantasticFeed.test.ts` 82, `rapidApi.cn.test.ts` 30, `adapters.fantastic.test.ts` 19, `quota.test.ts` 72, `planner.test.ts` 94, `raFantasticJobs.test.ts` 102 |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | clean (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M4` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 761 files: 757 passed, 4 failed. 19,854 tests: 19,837 passed, 6 failed, 1 skipped, 10 todo. The six failures are the ones listed below and nothing else. Three full runs in the review round, the last after the final edit. The first of them had two more failures in the admin area, caused by my first version of finding 5 and gone with the version described above. |

## Red tests for other bundles

All six assert the state before this bundle, in files I do not own. None can be avoided without dropping an ACCEPT line (the source is listed as gated; `activejobs` serves cn; the feed is registered in `ensureBuiltinAdapters`). The list is the one of the first handoff: the review round added none.

**MKT-5E** (`server/src/features/jobs/ingest/adapters/adapters.test.ts`)

1. "no RapidAPI adapter serves market cn". Now: `createRapidApiAdapter('jsearch').markets` is `['intl']`, `createRapidApiAdapter('activejobs').markets` is `['intl','cn']`, and `adapterEnabledFor(createRapidApiAdapter('activejobs'), 'cn')` is false without a paid plan.
2. "jobSourcesForBrand describes each source". `sourcesForBrand(goapply)` is now `bank_gohire` (bank), `activejobs` (search), `activejobs_feed` (search), `ats_public` (ats), `user_import` (import), all market cn. `sourcesForBrand(roboapply)` is `activejobs`, `activejobs_feed`, `bank_robohire`, `jsearch`, `ats_public`, `user_import`, kinds `search, search, bank, search, ats, import`.

**Orchestrator** (no owner in M5)

3. `server/src/features/jobs/sources/registry.test.ts`, "is reported for every registered source of both brands". RoboApply: add `['activejobs_feed', 'per_job']` after `activejobs`. GoApply: `[['bank_gohire','free'],['activejobs','per_job'],['activejobs_feed','per_job'],['ats_public','free'],['user_import','free']]`. The last line (`goSources` has no metered source) becomes: every metered GoApply source is off without a paid plan, `goSources.filter((s) => s.costModel !== 'free').map((s) => [s.provider, s.status().enabled])` equals `[['activejobs', false], ['activejobs_feed', false]]`.
4. `server/src/features/jobs/sources/types.test.ts`, "the same through the registry ingest reads". The registered list is `['activejobs', 'activejobs_feed', 'ats_public', 'bank_gohire', 'bank_robohire', 'jsearch']`.
5. Same file, "JSearch reads English and Traditional Chinese role labels; every other provider English only". `adapterQueryLanguages(createRapidApiAdapter('activejobs'))` is `['en', 'zh-CN']`; the closing loop holds for `jsearch` only.
6. `server/src/features/admin/__tests__/services.test.ts`, "each brand gets its own sources from the registry … GoApply never lists a search API". GoApply still never lists `jsearch`, `linkedin` or `bank_robohire`; it now lists `activejobs` and `activejobs_feed`, each `enabled: false` with reason `plan_too_small` until a paid plan exists (the same code with or without a stored reading).

## Pre-existing failures

None in the three full runs of the review round. `waveM3-carryover.md` (Orchestrator 11) lists the two timing tests of `server/src/features/jobs/import/directFetch.test.ts` as load-sensitive; they passed in all three.

## Requests

**Orchestrator**

1. **`server/src/features/jobs/ingest/cron.ts`: load the stored quota reading before the adapters are listed** (review finding 1; apply before a plan is bought). The gate of a source behind a plan reads the reading this process holds; a new function instance holds none until `hydrateProviderQuota` ran.
   - `runJobsPlan`: move `await hydrateProviderQuota(db());` from line 67 to directly above `const adapters = adaptersForBrand(ctx.brand, env());` (line 64).
   - `runJobsIngest`: swap lines 88 and 90, so that `await hydrateProviderQuota(db());` comes before `const adapters = adaptersForBrand(ctx.brand, env());`.
   - `runJobsMaintain`: add `await hydrateProviderQuota(db());` as its first line.
   - What happens until then, on a paid plan: `jobs-plan` is already safe (the planner completes its list and retires nothing, see finding 1). A `jobs-ingest` tick on an instance that has not loaded the reading yet does not lease the feed's query for RoboApply (the first brand of the loop): RoboApply's feed then runs only on ticks that land on an instance which loaded it earlier. `jobs-maintain` on such an instance skips the missed-refresh step for GoApply's Active Jobs DB search rows. Nothing is lost or switched off, but the feed is late, possibly by hours. `fantasticFeed.test.ts` "the gate reads the reading THIS process holds" shows both orders.
2. The six red tests above.
3. `server/src/features/jobs/ingest/index.ts`: export `feedGate`, `feedGateForMarket`, `FEED_PLAN_PROVIDER`, `providerJobsToday` from `./quota.js`, `FEED_MIN_MONTHLY_JOBS`, `feedDailyJobs`, `feedDailyJobsFor`, `feedQuotaDailyJobs`, `feedJobsReserve` from `./config.js` and `knownIngestProvidersForBrand` from `./providers.js`. Then `server/src/features/admin/limits.ts` line 43: replace the local constant by `export { FEED_MIN_MONTHLY_JOBS } from '../jobs/ingest/index.js';` (carry-over M3.4 c; `services.test.ts:390` stays true).
4. **The admin panels and the plan gate's two reasons** (review finding 5).
   - `server/src/features/admin/system.ts` line 290: `const PLAN_GATE_REASONS: ReadonlySet<string> = new Set(['plan_too_small', 'plan_unknown']);` and at line 471 `PLAN_GATE_REASONS.has(source.reason ?? '')` in place of `source.reason === PLAN_GATE_REASON`.
   - `components/v3/admin/SourcesConsole.tsx` line 54: add `plan_too_small` and `plan_unknown` to `KNOWN_REASONS`; line 53: add `activejobs_feed` to `KNOWN_SOURCES`. Strings for `i18n/staging/admin.en.json` (and `admin.zh.json`): `admin.console.sources.reason.plan_too_small` "Off until the plan allows at least 20,000 postings a month.", `admin.console.sources.reason.plan_unknown` "Off. The size of the plan is not known yet: set FANTASTIC_MONTHLY_JOBS, or wait for the provider's first answer.", `admin.console.sources.name.activejobs_feed` "Active Jobs DB feed", `admin.console.sources.about.activejobs_feed` "New postings from employer career sites, read every hour. Runs by itself once a paid plan exists."
   - Only after the first point: in `server/src/features/jobs/ingest/config.ts`, `FEED_GATE_REASON_CODE.plan_unknown` becomes `'plan_unknown'` (one word), and the assertions that pin today's code follow (`fantasticFeed.test.ts` "each closed reason reads as the code", "the real gate", "closed (today's plan)"; `rapidApi.cn.test.ts` "today's free plan"). `rapidApi.cn.test.ts` "a used-up plan that never stated its postings" must stay green: it is the check that no false alert comes back. Doing the third point without the first raises false `provider_quota` alerts (see the review resolution).
5. **`server/src/job-search/service.ts`: follow the chosen transport** (review finding 7). Line 148: `if (!(adapter.id === 'activejobs' ? fantasticKeyPresent(config) : config.RAPID_API_KEY?.trim())) return { ...base, enabled: false, reason: 'missing_credentials' };` with `import { fantasticKeyPresent } from '../roboapply/v2/lib/raFantasticJobs.js';`. Line 256: hash `[env().RAPID_API_KEY ?? '', env().FANTASTIC_TRANSPORT ?? '', env().FANTASTIC_API_KEY ?? ''].join('\u0000')` in place of the marketplace key alone, so a changed direct key or transport changes the cache version. Until then a deployment that holds only the direct key reads Active Jobs DB as `missing_credentials` in the job-search API (ingest and the feed already follow the transport).
6. Optional, `server/src/features/jobs/ingest/status.ts` `SOURCE_STATUS_NOTES`: the feed's notes stay in the tick's log tally only. To show them on the sources panel add `feed_out_of_window`, `feed_expired_refused`, `feed_expired_error`, `feed_budget_reached`, `other_market_location` (each needs its `admin.console.sources.skips.*` line in every locale).
7. After the M5 merge, the plan documents (`MARKET_TASK_PLAN.md` "Quota snapshot" row and the M5 env table) should say what was built: see "Env variables" and the twelve points above.

**MKT-5H** (env examples)

8. The table under "Env variables". Two sentences that must be in `.env.example` and `deploy/cn/cn.env.example` (review finding 5): `FANTASTIC_MONTHLY_JOBS` is REQUIRED on a deployment that serves only GoApply (nothing there calls the provider before the gate is open, so no response ever states the plan's size); after buying a plan in the middle of a period, set `INGEST_QUOTA_RECHECK_HOURS` (for example 1) until the first response of the new plan was read, then unset it.

**MKT-5F** (owns `normalize/normalizeProviderJob.ts`)

9. Optional. `ProviderJobInput.taxonomyId` is honoured only for a role (level 3) id, so the category the feed row carries changes nothing today. To use it: when the title names no role and `taxonomyId` is a category of the tree, set `taxonomyIds` to that one id and leave `primaryTaxonomyId` null. `adapters.fantastic.test.ts` ("a category is not a role") pins today's behaviour.

**MKT-5D** (source register)

10. For the Active Jobs DB row, as read on 2026-10-12: plans count Jobs (one credit per posting returned by `active-ats`) and API Requests (one per call, a hard limit, about half the Jobs number); expired, modified and count calls cost a request and no Jobs; 600 requests a minute; the expired feed rechecks every posting daily and expires it at six months; plan examples in the documentation: Starter-20k $95 (20,000 Jobs, 10,000 requests), Pro 50k $175, Pro-100k $250 with $0.0025 per further job. Attribution and retention are not stated in the pages I read; the written answer on public pages is still open (strategy 7, item 15).

**Owner**

1. Before buying: measure the month with the vendor's count endpoint, with the filters the sync will send. One call costs one request and no Jobs: `GET /v1/active-ats-count?time_frame=1m&location="United States" OR "Canada" OR …&exclude_source=greenhouse`. The default thirteen countries without a taxonomy filter are very likely far above a 100,000 plan. Trim `INGEST_FEED_COUNTRIES` and set `INGEST_FEED_TAXONOMIES` until the count fits. If it does not fit, the sync does not overspend: it stops at the day's budget, falls behind and says so in the log ("licensed feed is behind").
2. The first week costs more than a normal week: the backfill reads the last seven days with whatever the day's budget leaves after the hourly slices. Accept a partial backfill or raise `INGEST_FEED_DAILY_JOBS` for the first days (the day is still held to what the plan has left).
3. A direct Fantastic.jobs key: set `FANTASTIC_TRANSPORT=direct` and `FANTASTIC_API_KEY`. The marketplace subscription of Active Jobs DB is then not used by ingest (JSearch still needs `RAPID_API_KEY`; the job-search API needs Request 5).
4. After buying a plan in the middle of a period (corrected): a stored reading that says "used up" blocks every call until the old reset time, and `FANTASTIC_MONTHLY_JOBS` does not lift that. Set `INGEST_QUOTA_RECHECK_HOURS=1`; RoboApply's next search reads the new plan and the gate opens by itself. On a deployment that serves only GoApply set `FANTASTIC_MONTHLY_JOBS` as well: nothing there ever reads the plan.
5. Apply Request 1 before the plan is bought.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `FANTASTIC_MONTHLY_JOBS` | Postings a month of the Active Jobs DB plan the owner bought. The gate uses the larger of this and the `jobsLimit` the provider's responses state. Required on a deployment that serves only GoApply. | unset |
| `FANTASTIC_FEED_DISABLED` | `true` stops the licensed feed sync in both markets (and with it the mainland search, which stands behind the same gate). | false |
| `FANTASTIC_FEED_SLICE_CHECK_DISABLED` | `true` lets the feed read a page whose postings were mostly indexed outside the slice it asked for (the mismatch is still counted and logged). Only for the case that the provider's date bounds turn out to work on another timestamp than the `date_created` it returns. | false |
| `FANTASTIC_TRANSPORT` | `rapidapi` or `direct`. The transport of the whole Active Jobs DB client: search and feed. | `rapidapi` |
| `FANTASTIC_API_KEY` | Key of a direct Fantastic.jobs plan (`Authorization: Bearer`). Read per call, never logged. | unset |
| `FANTASTIC_API_KEY_HEADER` | Another header NAME for the direct key (the raw key is then its value). | `Authorization` |
| `FANTASTIC_FEED_PATH` | Path of the new-jobs route on the chosen host (the search uses it too). | `/active-ats` on the marketplace, `/v1/active-ats` direct |
| `FANTASTIC_EXPIRED_PATH` | Path of the expired route on the chosen host. | `/expired-ats`, `/v1/expired-ats` direct |
| `INGEST_FEED_DAILY_JOBS` | Hard daily budget of postings for the feed sync, both markets together. The ingest search adapter's postings of the day count toward it. Never more than what the plan has left above the reserve, spread over the days to its reset. | plan month / 31 |
| `INGEST_FEED_CN_DAILY_JOBS` | The mainland sync's part of that day; the international sync has the rest. | 20% of the day |
| `INGEST_FEED_COUNTRIES` | ISO codes the international sync asks for (sent as full country names; `CN` is ignored here). | `US,CA,GB,IE,DE,FR,NL,ES,IT,SE,AU,SG,TW` |
| `INGEST_FEED_TAXONOMIES` | Vendor taxonomy names the feed is narrowed to (for example `Software,Data & Analytics`). | unset |
| `CN_ACTIVEJOBS_ENABLED` | `false` keeps Active Jobs DB off for GoApply even with a paid plan. | on |
| `INGEST_QUOTA_RESERVE_SHARE` (redefined) | Also the share of the plan's monthly postings the feed leaves for people's own searches (at least 20 postings). | 0.05 |
| `INGEST_QUOTA_RECHECK_HOURS` (unchanged, new use) | The variable to set after buying a plan in the middle of a period. | 0 |
| `INGEST_ACTIVEJOBS_CN_DAILY_CALLS` (redefined) | Mainland calls a day. Unset: 0 while the plan gate is closed, 20 while it is open (ingest calls only). A person's own mainland search still needs this set above 0. `0` keeps the mainland search off while the feed runs. | 0 / 20 |
| `RA_ONBOARDING_ACTIVEJOBS_DISABLED`, `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED` (redefined) | Now also stop the licensed feed. | unchanged |
| `RAPID_API_KEY` (redefined) | Not used by Active Jobs DB when `FANTASTIC_TRANSPORT=direct`. | unchanged |
| `RA_ONBOARDING_FANTASTIC_WINDOW` (redefined) | Also decides the window stored on Active Jobs DB search queries (`week`, or `today` for `24h`). | unchanged |

## i18n keys added or changed

None (the bundle owns no namespace). Request 4 names four admin strings.

## Known gaps

Each with the next step and who acts.

1. **No response was ever recorded.** The free plan was used up and RapidAPI may not be called. The mapper follows the vendor's OpenAPI document and reads the older field names too. Next step (owner, the day a plan exists): watch the first ticks' tally for `feed_unmapped`, `feed_out_of_window`, `feed_expired_error` and `feed_expired_refused` and the query's last error for `window_not_applied`, then record one page as `normalize/__fixtures__/README.md` describes.
2. **Until Request 1 is applied RoboApply's feed runs only on a function instance that already loaded the stored quota reading** (orchestrator; see the Request for what exactly happens). The plan run is already safe.
3. **The marketplace's expired route is unverified.** `/expired-ats` is what the research note and the v1 naming say. If it answers 401, 403 or 404 the tally shows `feed_expired_refused` once a day and no row is closed by id (rows still end by `date_valid_through` or after 45 days); nothing else is affected. Fix without a deploy: `FANTASTIC_EXPIRED_PATH` (owner), effective from the next UTC day.
4. **The monthly expired answer is not measured.** The vendor calls it very large; the client refuses an answer whose stated length is over 96 MB and the 25 s timeout applies. If it cannot be read it is tried once a day, the hourly and daily calls go on, and the gap of an outage stays marked in the cursor (`expiredGap`). Next step if `feed_expired_error` shows once a day for weeks: owner reports it, then a larger limit or a paged read in `raFantasticJobs.ts` / `fantasticFeed.ts`.
5. **Whether the date bounds work as documented on the marketplace transport is not verified.** Every hourly request depends on them. If they are not applied the sync stops with `window_not_applied` (it does not mark hours as read and does not buy the week again every hour); the bill is at most one page an hour, inside the day's budget. Owner: report it; `FANTASTIC_FEED_SLICE_CHECK_DISABLED=true` only if the rows are right and the check is wrong.
6. **The admin panels cannot yet tell "no plan size known" from "plan too small"** (both read `gated` / `plan_too_small`). The gate and the log can. Orchestrator: Request 4.
7. **The job-search API on a direct key only** reads Active Jobs DB as `missing_credentials`. Orchestrator: Request 5.
8. **How the direct API answers a used-up quota is not documented.** A 429 is read as a monthly stop when its body says "quota" or "monthly" or its headers say 0 requests left, and a served call whose headers say 0 Jobs left closes the gate. Plans that allow overage are therefore never used past their quota. Owner, with the first direct plan.
9. **When the provider states no remaining count** (a response without that header; the time between a reset and the first response after it) the feed's day is month / 31 alone and people's own searches are on top of it, as before the review. Both transports document the header, so this is the exception. Owner: `INGEST_FEED_DAILY_JOBS` if it ever shows.
10. **Sizing** (Owner 1): with the default countries and no taxonomy filter a 100,000 plan is very likely far too small (not measured: the count endpoint needs a key); the sync then runs permanently behind.
11. **The vendor's category is carried but not used** (Request 9, MKT-5F).
12. **Agencies are labelled by our own list only.** The vendor's agency flag is one of the LinkedIn-derived organisation fields and is not read.
13. **`complete: false` for a full search page counts normalised rows**, and the day's `jobsReturned` of the search adapter counts the rows it handed on, not the rows dropped as `wrong_market`. The search seam returns rows, not the raw count; the provider's own remaining count (finding 6) is what the budget relies on. No action.
14. **The mainland stack must reach the provider's host.** Whether `active-jobs-db.p.rapidapi.com` or `data.fantastic.jobs` answers from the mainland deployment is not known; the request carries no user data either way. Owner, on the day the mainland stack gets a plan.
15. **Mainland postings RoboApply's search wrote before this change keep market `intl`** until they age out (45 days) or the mainland sync reads them (the upsert then moves them to `cn`, once, and nothing moves them back). No action.
