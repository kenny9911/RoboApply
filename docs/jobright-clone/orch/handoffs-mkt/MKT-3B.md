# MKT-3B

Planner: adapter cost model, no SEO seeds on per-request providers, demand windows, Taiwan query variants (JI-2, JI-6, JT-3, SM-11). Worktree `wp-MKT-3B`, branch `wp/MKT-3B`. Nothing committed, nothing pushed. No database, network, model or provider call was made; no `.env` was opened; no `*.prisma` file was touched.

**This run: review resolution.** The independent review judged all four items done, found no unowned edit, and raised four findings (one high, one medium, two low). I verified each against the code: all four are real. Three are fixed in my files; the fourth is in MKT-3A's `pipeline.ts`, so it is a Request, with a planner-side repair that limits its effect. See "Review resolution" at the end. All gates were re-run after the last edit.

All four items are done. Where the code differs from the letter of an item it is marked **Differs**; in each case MARKET_STRATEGY or the cross-bundle contract decided.

## Items

### 1. [P0] SEO seed tuples are planned only on sources that cost nothing per request (JI-2) — done

- `planQueries`: a tuple with origin `seo_seed` skips every search adapter whose `adapterCostModel` is `per_request`. Demand tuples are unaffected; a tuple that is both a seed and somebody's demand is demand (the merge already says so) and is planned on JSearch.
- `retireSeedsFor(db, market, providers)`: one statement, `UPDATE "RAIngestQuery" SET "enabled" = false WHERE "market" = $1 AND "origin" = 'seo_seed' AND "enabled" = true AND "provider" = ANY($2::text[])`. `runPlanner` calls it with `perRequestProviders(adapters, market)` (the market's per-request search providers, on or off: such a query is never wanted) and reports the count as `PlannerResult.seedsRetired`. Idempotent: a second run finds nothing enabled.
- `sources/registry.ts`: `JobSourceDescription.costModel` (`adapterCostModel(registered adapter ?? { provider })`), known for a source whose adapter is not registered too. One rule: the registry and the planner both read `adapterCostModel`.
- Header comment rewritten; no test name says "one query per provider" any more.
- **Differs (addition): `retireSuperseded`.** The item says queries created before the change "retire through `retireUnusedDemand` as nobody plans them again". That would leave every old demand row running beside its new twin for 30 days (two calls per tuple on a per-request plan), and old **seed** rows on a per-job source would never retire at all (`retireUnusedDemand` never touches seeds). So, on the search providers planned in the run only, one statement switches off (a) seed rows today's plan did not name (`updatedAt` older than the run's start: the upsert stamps every planned row) and (b) demand rows whose hash was made by the earlier recipe (no `q2:` prefix). Reported as `PlannerResult.superseded`. A provider skipped in the run is not in the list: its rows wait. The stamp never moves backwards (review finding 4), so two overlapping plan runs cannot make today's seeds look unnamed.
- Acceptance: all four lines met (`planner.test.ts` "a plan run": default env and no users plans zero JSearch and zero LinkedIn rows and all 900 seeds on the per-job source; a demand tuple still plans a JSearch row; stored JSearch seeds are off after one run and a second run changes nothing but the "planned today" stamp).

### 2. [P0] A provider that is unsubscribed, out of quota or off for the market is not planned (JI-2) — done

- `planQueries` and `ensureBankSyncQueries` ask `a.markets.includes(market) && adapterEnabledFor(a, market)` (MKT-1C's helper does not check `markets`, by its own handoff). An adapter that is off, throws while answering, or is off for this market only gets no new and no refreshed query.
- `plannableAdapters(adapters, market, quota, now)` splits a brand's adapters for one run into `open` and `skipped`; `runPlanner` plans `open` and returns `skippedProviders`.
- **The quota snapshot is read by the planner too.** `readQuotaSnapshots(db)` reads AppConfig `jobs.providerQuota.v1` through MKT-1C's `parseProviderQuota` (the contract table names the planner as a reader). A metered search adapter is skipped while `quotaClosed`: state `exhausted`, `not_subscribed` or `unauthorized` with a reset time still ahead, under the market's own key (`usageKey`: `<provider>:cn` for mainland) or the provider's. This makes "a 429 with remaining 0 stops planning for that provider until reset" (JI-1) hold in the planner whether or not the adapter's own `isEnabled` already reflects MKT-3A's gate. Nothing stored, an unreadable value or a failed read is "nothing known": the adapters' own answers decide. A reading with no reset time closes nothing (we would not know until when).
- **A skipped source's queries are untouched**: no upsert, not zeroed, not widened and not disabled by `retireUnusedDemand` (optional fourth argument, the skipped providers), not superseded, not retired by `retireUnrunProviders` (which takes the full adapter list: off is not "not run"). The one exception is item 1's rule for seeds on a per-request source.
- `providers.ts`: `adaptersForBrand` unchanged (registry order). New `listEnabledAdaptersFor(brand, env)`: the brand's adapters that are on for its market. The planner keeps taking `adaptersForBrand` because it must know what is off. Wiring the new list into cron and the targeted ingest is in MKT-3A's files: Request 2.
- The line `if (t.market === 'cn' && country !== 'CN')` **stays**. It is not the old "GoApply testing provider" special case (the parity wave removed that): it is the general rule that a market-cn search asks for mainland postings only, since any other row is dropped as `wrong_market`. No search adapter serves market cn today, so it plans nothing.
- `roboapply/v2/lib/raJobProviders.ts`: `externalProviders` is `[activeJobsDbProvider, jsearchProvider]`; the LinkedIn provider object is no longer imported. `isDroppedProvider(id)` (exported) names `linkedin`; `enabledExternalProviders()` never returns such a provider and `searchAllProviders` filters it out of a caller-chosen `opts.providers` too, so it is not searched and not reported. The per-provider kill-switch map is keyed by string and no longer has a LinkedIn entry (`RA_ONBOARDING_LINKEDIN_JOBS_DISABLED` is read by nothing in this file now). Header and registry comments rewritten for two providers.
  - Effect outside the file, checked: `job-search/service.ts` builds its default list from `externalProviders[0]` and `.slice(1)`, so it becomes Active Jobs DB, hiring index, JSearch. Its 192 tests pass unchanged; a website search never included LinkedIn by default (`JOB_SEARCH_PROVIDERS` defaults to `jsearch,activejobs`).
- `sources/registry.ts`: `DROPPED_PROVIDERS` (`linkedin`, plain strings): never a source of a brand, whatever a brand list names, an adapter registers or `JOB_PROVIDERS_<BRAND>` says.
- Acceptance: all lines met (`planner.test.ts`: Active Jobs DB off writes no `activejobs` row, is in `skippedProviders`, its stored rows are byte-identical after the run, and the next run with it on plans it; `registry.test.ts`: GoApply never has JSearch on either list; `raJobProviders.test.ts`: a LinkedIn provider handed to the fan-out is never called).

### 3. [P1] Demand queries ask for a window that matches their refresh interval (JI-6) — done

- One table, `SCHEDULE`, holds interval and window per class; `baseRefreshMs`, `datePostedFor` and `nextRunDelayMs` all read it:

  | Class | Interval | `datePosted` the demand calls for |
  |---|---|---|
  | hot demand (score >= 5) | 6 h | `3days` |
  | other demand (1 to 4) | 24 h | `week` |
  | Taiwan demand (score >= 1, country `TW`) | 12 h | `month` |
  | seed, or demand at score 0 | 24 h | `week` |
  | bank sync | 30 min | `all` |

- **The window STORED on a query is the one its source really applies** (review finding 1). New optional `JobSourceAdapter.dateWindows` and `adapterDateWindow(adapter, wanted)` in `sources/types.ts`: the wanted value when the adapter applies it (or states no list), else the adapter's own window (the first of its list). Default by provider id: `activejobs` and `activejobs_feed` are `['week']`, because the Active Jobs DB client sends one fixed `time_frame` whatever `datePosted` says (`raFantasticJobs.ts` `windowSuffix`, seven days by default); every other provider applies the value it is given. `planQueries` writes `adapterDateWindow(adapter, …)` per source, so one tuple gives `month` (or `3days`) on JSearch and `week` on Active Jobs DB. The missed-refresh rule (`ingest/tracking.ts`) reads the stored value to know which postings a query could still have returned; a stored `month` on a seven-day source closed live postings after about eight days.
- `REFRESH` gains `coldDemandMs` (24 h), `twDemandMs` (12 h) and `hotDemandFrom` (5). **`REFRESH.demandMs` is removed** (nothing in the repository read it).
- Contract, exactly as written: `RefreshInput = { origin, demandScore, consecutiveEmpty, country?: string | null }`. `'TW'` (any case, trimmed) selects the Taiwan interval; absent, null or anything else keeps the hot / cold rule. A caller with no country compiles and behaves as before for hot and seed.
- **Differs (addition): back-off is capped at the query's own window as well as at 7 days.** "Never plan a JSearch query whose window is shorter than its refresh interval" would otherwise break at the seventh empty run of a hot query (96 h against a 3-day window). A hot query is now asked at least every 3 days. A test walks every origin, score, country and 0 to 40 empty runs.
- Identity: `queryHash(tuple, language)` = `q2:` + sha1 of `{ market, role (taxonomy id, or the typed text in lower case), language, country, city, remote }`. `datePosted` is not in it. `upsertPlannedQueries` rewrites `params` in place on conflict and keeps a stored cursor: `"params" = EXCLUDED."params" || jsonb_strip_nulls(jsonb_build_object('cursor', "RAIngestQuery"."params"->'cursor'))` (manual and bank rows keep their params, as they keep origin and priority). `paramsHash(market, params)` stays, for standing queries only (their stored hash, and so their cursor, is unchanged).
- **A rewrite that makes a query return other postings restarts its counted runs** (review finding 2). In the same upsert, for a non-standing row: `"runCount" = 0` when the new window is wider than the stored one or the text (`q`) differs; otherwise the count is kept. `runCount` is the clock of the missed-refresh rule ("two later counted runs of the query did not return the posting"). After a restart a posting stamped under the old window or text needs at least two counted runs of the query as it is now without being returned before it can be archived as removed; until then it is left to `expiresAt` and the 45-day rule. A narrower window keeps the count: the rule's own window guard already protects what dropped out of it.
- A targeted (onboarding) upsert keeps the stored params and does not touch `runCount`: a hot row's 3-day window is not replaced by the week of a one-user tuple; the next plan recounts.
- `retireUnusedDemand` is three statements now: zero the demand nobody asked for today (stamps `updatedAt`); widen every score-0 demand row that still has the hot `3days` window to `week` and set its `runCount` to 0 (no stamp: the 30-day clock is not its business); disable after 30 unused days. The widening looks at every score-0 demand row, not only the ones zeroed in the run, so a row whose old window was written back by an ingest run in flight (review finding 3) is put right by the next plan. Returns `{ zeroed, disabled, widened }`.
- `"updatedAt" = GREATEST("RAIngestQuery"."updatedAt", EXCLUDED."updatedAt")` in the upsert (review finding 4).
- Remote tuples keep `remote: true`.
- Acceptance: all lines met (`planner.test.ts`: the interval table, window by score, a tuple going from 2 to 6 users keeps its one row id and gets `3days`, then widens again when nobody asks; Taiwan 12 h at either score; seed and bank unchanged).

### 4. [P1] Taiwan demand is planned twice: Traditional Chinese and English, both over a month (JT-3, SM-11) — done

- `queryVariants(tuple, labels = providerQueryLabels)`: a typed title once, as typed, language null; a taxonomy role in market intl the first `en` text; for Taiwan the `zh-TW` text (only when `providerQueryLabels` returns one, so never the Simplified label and never a conversion) and the first `en` text; market cn the first `zh-CN` text. The planner reads no node label itself.
- "Taiwan" is `searchCountry(tuple)`: the tuple's country, or `TW` when its city is a Taiwanese city and no city of that name lies in the stated country. `params.country` carries that value, so MKT-3A's `nextRunDelayMs(…country: query.params.country)` and `rapidApiSearchParams` see `TW`.
- The city stays the city table's English name in `params.city`.
- Both JSearch rows carry `datePosted: 'month'`. The English row on Active Jobs DB carries `week`: that source asks seven days whatever it is told (item 3, review finding 1). JT-3's line ("both `date_posted=month`") is about the two JSearch queries and holds.
- **Differs: which adapter gets which text.** The item says "per-request search adapters that take free text (jsearch)". I made it a property of the adapter: optional `JobSourceAdapter.queryLanguages` and `adapterQueryLanguages(adapter)` in `sources/types.ts` (declared list, else by provider id: `jsearch` reads `en` and `zh-TW`, every other provider `en`). Same result for the acceptance lines (Active Jobs DB gets the English variant only), and a mainland source (MKT-5A) states `zh-CN` in one place instead of adding a planner branch. A typed title goes to every search adapter whatever this says.
- **Differs: the identity holds the query's language, not its text**, for a taxonomy role. The two Taiwan variants are still two rows (the item's point). The text is rewritten in place, so when MKT-3E's Traditional labels land, or a label is corrected, the row keeps its id and schedule instead of leaving an orphan that keeps calling JSearch for 30 days (its counted runs restart: item 3).
- Market cn: with today's adapters nothing is planned (no adapter serves market cn as a search source and none reads `zh-CN`).
- Acceptance: all lines met with a SYNTHETIC label fixture in the shape of `providerQueryLabels` (`planner.test.ts`: one zh-Hant and one English JSearch row, both `month`, at 2 and at 6 users; without a Traditional label the English one only; a US tuple one English row with item 3's window; Active Jobs DB English only). One test runs the real `providerQueryLabels`. The Traditional labels themselves are MKT-3E's: after the merge the orchestrator's JT-3 check sees the zh-Hant row only for roles that have one.

### Carry-over

- **waveM1 `### MKT-3B` 1** (`KIND` has no entry for the new provider ids): done. `KIND` lists `activejobs_feed`, `usajobs`, `tw_open_data`, `tw_gov_jobs` as `search` (the web contract has four kinds); exported `jobSourceTransport(provider)` answers `api` for the three government sources instead of `rapidapi`. An adapter's own `transport()` still wins.
- **waveM1 2** (`providerQueryLabels` is ready): used as the only source of role texts.
- **waveM1 3 / wavePAR job-source entry 1** (`'linkedin'` in the `JobProvider` union): done for my files. `sources/registry.ts`, `sources/types.ts` and `raJobProviders.ts` no longer reference the union member (they name the id only as a plain string in the dropped sets). The literal itself is in `platform/brand/registry.ts` (no owner): Request 7 lists what still names it.
- **waveM1 4** (`adapterEnabledFor` does not check `markets`): the planner and the registry check `markets` themselves, in the same expression.
- **waveM2**: no section for MKT-3B.
- **wavePAR job-source entries 2, 3, 4, 5, 6, 7a, 7b, 7**: none names a file of mine. Left.

## Files changed

Modified:
- `server/src/features/jobs/ingest/planner.ts`
- `server/src/features/jobs/ingest/planner.test.ts` (rewritten)
- `server/src/features/jobs/ingest/providers.ts`
- `server/src/features/jobs/sources/types.ts`
- `server/src/features/jobs/sources/types.test.ts` (colocated test of `types.ts`; MKT-1C's file from M1, no M3 owner: one row removed, three blocks added)
- `server/src/features/jobs/sources/index.ts`
- `server/src/features/jobs/sources/registry.ts`
- `server/src/roboapply/v2/lib/raJobProviders.ts`
- `server/src/roboapply/v2/lib/raJobProviders.test.ts`

New:
- `server/src/features/jobs/sources/registry.test.ts`

Outside the worktree: this handoff only (`/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-3B.md`).

Changed in this review run: `planner.ts`, `planner.test.ts`, `sources/types.ts`, `sources/types.test.ts`, `sources/index.ts`.

New exports. `planner.ts`: `datePostedFor`, `windowMs`, `DateWindow`, `searchCountry`, `queryVariants`, `QueryVariant`, `QueryLabelSource`, `queryHash`, `QUERY_HASH_PREFIX`, `PlanOptions`, `quotaClosed`, `plannableAdapters`, `PlannableAdapters`, `perRequestProviders`, `readQuotaSnapshots`, `retireSeedsFor`, `retireSuperseded`; `PlannedQuery.language`; `PlannerResult.{seedsRetired, superseded, skippedProviders}`; `planQueries(tuples, adapters, options?)`; `paramsForTuple(tuple, variant?)`; `retireUnusedDemand(db, market, runStartedAt, skippedProviders?)` returning `{ zeroed, disabled, widened }`; `runPlanner` option `queryLabels`. `providers.ts`: `listEnabledAdaptersFor`. `sources/types.ts` and `sources/index.ts`: `JobSourceAdapter.dateWindows`, `adapterDateWindow`, `JobSourceAdapter.queryLanguages`, `adapterQueryLanguages`, `SourceQueryLanguage`, `jobSourceTransport`. `raJobProviders.ts`: `isDroppedProvider`.

## Tests run

All in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3B`, after the last edit.

| Command | Result |
|---|---|
| `npx vitest run` on the four test files I wrote or touched | 4 files, **130 passed**: `planner.test.ts` 81, `types.test.ts` 24, `registry.test.ts` 13, `raJobProviders.test.ts` 12 |
| `npx vitest run server/src/features/jobs server/src/roboapply/v2/lib server/src/job-search server/src/features/admin server/src/features/boundary.test.ts` | 76 files, 2,848 passed, 6 todo, **2 failed** (both in `cron.test.ts`, see Red tests) |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 715 files: 713 passed, 2 failed. 17,180 tests: **17,163 passed**, 6 failed, 1 skipped, 10 todo. The 6: 2 in `cron.test.ts` (Red tests) and 4 in `components/features/copilot/__tests__/cards.test.tsx` (Pre-existing failures: a fixture that expired by the wall clock) |

Both proposed replacements for the two red tests were verified again in a temporary copy of `cron.test.ts` (20 tests: 19 passed, 1 todo), then the copy and its snapshot file were deleted (`git status` shows the ten paths above and nothing else).

## Red tests for other bundles

Both in `server/src/features/jobs/ingest/cron.test.ts`, owner **MKT-3A**. Each pins behaviour an item of this bundle changes on purpose. Neither is affected by the review fixes.

1. `crons > jobs-plan writes queries without calling providers`. It expects `{ seedTuples: 2, planned: 4, bankQueries: 1 }` with the comment "2 seeds × 2 search adapters … planned even while a key is missing". Now JSearch gets no seed (item 1) and a source that is off gets no query, standing ones included (item 2). In this fixture Active Jobs DB and the RoboHire bank are disabled stubs. It should assert:
   ```ts
   // JSearch is billed per request: no seed query. Active Jobs DB and the bank are off here: skipped, not planned.
   expect(res).toMatchObject({ seedTuples: 2, planned: 0, bankQueries: 0, skippedProviders: ['activejobs', 'bank_robohire'] });
   ```
2. `targeted ingest for onboarding (ingestForProfile) > plans the profile, runs due queries within the budget and queues the rest`. It seeds the stored row under `paramsHash('intl', planned)`, the earlier recipe; a planned search query is now identified by `queryHash` (item 3). Seed it with (the `planned` constant and the `paramsHash` import are then unused in the file):
   ```ts
   import { queryHash } from './planner.js';
   …paramsHash: queryHash({ market: 'intl', taxonomyId: 'backend_engineer', q: 'Backend engineer', country: 'US' }, 'en'),
   ```
   Every other assertion of the test holds as it is.

## Pre-existing failures

`components/features/copilot/__tests__/cards.test.tsx`, 4 tests (`filter_diff` two, `memory_add` one, `WP-50 producers ↔ WP-51 cards` one). Not caused by this bundle: no file under `components/` or `features/copilot/` is in my diff. Cause: `components/features/copilot/__tests__/wireCards.ts` line 199 builds the proposal with `expiresAt: new Date(NOW.getTime() + 86_400_000)` and `NOW` is `2026-10-10T08:00:00Z` (`features/copilot/__tests__/areaFakes.ts`), so the cards expired at 2026-10-11 08:00 UTC by the wall clock and render "This suggestion expired". The base was green before that instant; it fails in every worktree since. Fix (one line, as line 271 of the same file already does): `expiresAt: new Date('2099-01-01T00:00:00.000Z')`. See Request 8.

## Requests

**MKT-3A**

1. `ingest/cron.test.ts`: the two assertions under "Red tests".
2. `listEnabledAdaptersFor(brand, env)` (in `ingest/providers.ts`) is the list for whoever is about to call a source. To apply one rule in cron and in the targeted ingest: export it from `ingest/index.ts` next to `adaptersForBrand`; in `ingest/cron.ts` `runJobsIngest`, replace `adapters.some((a) => a.isEnabled())` with `listEnabledAdaptersFor(ctx.brand, env()).length > 0`; in `ingest/run.ts`, `runIngestTick` (`options.adapters.filter((a) => a.isEnabled())`) and `ingestForProfileWith` (`a.kind === 'search' && a.isEnabled()`) should use `adapterEnabledFor(a, brand.market)`. Behaviour is the same today (no adapter has `isEnabledFor` yet); it matters once one does. `runJobsPlan` must keep `adaptersForBrand`.
3. **`ingest/pipeline.ts` `finishQuery` must not write the leased params back for a search query** (review finding 3). Params used to be a query's identity and never changed; the planner now rewrites `datePosted` and `q` in place, and `jobs-plan` (`0 2 * * *`) and `jobs-ingest` (`*/10 * * * *`) both start at 02:00 with no lock. A query leased before the plan's statement and finished after it puts yesterday's params back. Write only the cursor of a cursor adapter:
   ```sql
   "params" = CASE WHEN ${cursor}::text IS NULL THEN "params" ELSE jsonb_set("params", '{cursor}', to_jsonb(${cursor}::text)) END
   ```
   passing `isCursor && fetched.cursor ? fetched.cursor : null` (both call sites, the error path passes null). Test: params changed between lease and finish survive the finish. What the planner does until then: a re-planned row is rewritten again by the next daily plan; a score-0 row that got its `3days` back is widened again (and its counted runs restarted) by the next plan's `retireUnusedDemand`. So the damage is bounded to one day; with the pipeline change it is zero.
4. Optional: `createRapidApiAdapter` may declare on the adapter what `sources/types.ts` now derives from the provider id. `jsearch`: `costModel: 'per_request'`, `queryLanguages: ['en', 'zh-TW']`. `activejobs`: `costModel: 'per_job'`, `queryLanguages: ['en']`, and **`dateWindows` from `windowSuffix()`** (`'7d'` gives `['week']`, `'24h'` gives `['today']`), so a deployment that sets `RA_ONBOARDING_FANTASTIC_WINDOW=24h` stores the day it really asks for. Today the default says `['week']` whatever that variable says (as every row did before this bundle).

**MKT-3F** (`features/admin/system.ts`, `contract.ts`, `SystemConsole.tsx`)

5. `JobSourceDescription.costModel` (`'free' | 'per_job' | 'per_request'`) is on every source `sourcesForBrand` returns. `jobSourcesHealth` can pass it through as `costModel: source.costModel ?? 'free'` so the sources console shows it. The plan cron's result now carries `skippedProviders: string[]`, `seedsRetired` and `superseded` (logged with `jobs-plan`).

**MKT-5C** (owner of `ingest/tracking.ts`, `maintain.ts` in M5)

6. For information, no change needed: `RAIngestQuery.runCount` is no longer only ever increasing. The planner sets it to 0 when it widens a query's window or changes its text (item 3). `buildMissedSql` and `isMissedTwice` stay correct as they are (a stamp from before the restart needs `runCount >= lastSeenRun + 2` counted runs of the query as it is now). Anything new that reads `runCount` as "total runs ever" would be wrong. The window the rule reads (`params->>'datePosted'`) is now the one the adapter applies (`adapterDateWindow`): keep reading the stored value, do not derive it from the demand score.

**Orchestrator**

7. `'linkedin'` in the `JobProvider` union (`platform/brand/registry.ts`, then `npm run gen:brand`; wavePAR entry 1). My three files no longer block it. Still using the literal as a provider or board type, to change first: `features/jobs/normalize/source.ts` (`PROVIDER_META.linkedin`), `normalize/adapters.ts` (`inputFromFantasticJob(…, board: 'activejobs' | 'linkedin', …)`), `roboapply/v2/lib/raExternalJobTypes.ts` (`ExternalSourceBoard`, `EXTERNAL_SOURCE_BOARDS`), `raFantasticJobs.ts` (the `linkedin` board config and `linkedInJobsProvider`, which nothing imports any more), `features/seo/scope.ts`. Plain strings that may stay: `job-search/validation.ts` (`KNOWN_PROVIDER_IDS`), `job-search/agent.ts`, `features/jobs/detail/view.ts` and `companies/service.ts` (they label stored rows). Comments only: `normalize/types.ts`, `ingest/upsert.ts`. Tests that pass `'linkedin'` as a provider id: `ingest/pipeline.test.ts`, `ingest/upsert.test.ts`, `ingest/adapters/adapters.test.ts`.
8. The four `cards.test.tsx` failures (Pre-existing failures): one line in `components/features/copilot/__tests__/wireCards.ts`, which no M3 bundle owns. They will show in every sibling's full run.
9. After the merge, the JT-3 line ("a TW tuple plans one zh-Hant query with `language=zh-TW` and one English query, both `date_posted=month`") needs a role that has a Traditional label from MKT-3E, and is about the JSearch rows (the Active Jobs DB row says `week`: that is what the source is asked). Quick check: `queryVariants({ market: 'intl', taxonomyId: '<role>', q: '', country: 'TW' })` returns two variants for it.
10. A document that still states the old rule: `docs/jobright-clone/ARCHITECTURE.md` line 2077 ("Upsert `RAIngestQuery` per provider that supports the country. Refresh interval = 6 h when `demandScore ≥ 5`, 12 h when ≥1, 24 h for seeds … up to 7 days"). Now: no seed on a per-request provider, 24 h for cold demand, 12 h for Taiwan, back-off capped at the window, the stored window is the adapter's. Not in my owns.
11. A cron lock for `jobs-plan` would be the complete answer to overlapping runs. The planner is now safe against the one harmful effect found (finding 4); two overlapping runs still do every statement twice.

**MKT-5A** (owner of `planner.ts`, `providers.ts` in M5)

12. A mainland search source: declare `queryLanguages` (for example `['zh-CN']`), `isEnabledFor(market)` and, when it asks a fixed frame, `dateWindows` on the adapter; the planner then plans the `zh-CN` text for market cn without a new branch. A `dateWindows` list that holds `3days` must hold `week` too (the idle widening writes `week`). The licensed feed as a cursor adapter gets its standing query from `ensureBankSyncQueries` once `adapterEnabledFor(adapter, market)` is true. `plannableAdapters` applies the stored quota snapshot to metered **search** adapters only: a cursor feed's quota gate is the adapter's own answer.

## Schema requests

None. (`RAIngestQuery.runCount`, which the planner's SQL now names, is in `server/prisma/schema/ra-jobs.prisma` since SCHEMA-2 and is asserted by `server/prisma/__tests__/marketSchema.test.ts`.)

## Env variables added or redefined

None. (`INGEST_SEED_ROLES`, `INGEST_SEED_CITIES_PER_COUNTRY` and `INGEST_SEED_COUNTRIES` keep their meaning: with the default adapter list their tuples are now planned on Active Jobs DB only, never on JSearch. `RA_ONBOARDING_LINKEDIN_JOBS_DISABLED` is no longer read by `raJobProviders.ts`; `job-search/service.ts` and `raFantasticJobs.ts` still name it.)

## i18n keys added or changed

None (the bundle owns no namespace and adds no copy).

## Known gaps

- **Nothing ran against Postgres.** The SQL (`jsonb ||`, `jsonb_strip_nulls`, `jsonb_set`, `NOT LIKE`, `NOT ("provider" = ANY($n::text[]))` with an empty array, `IS DISTINCT FROM`, the `CASE … WHEN 'week' THEN 7 …` window comparison, `GREATEST` on timestamps) is checked as text and values, and through a small JavaScript model of the `RAIngestQuery` table in `planner.test.ts`. That model was written from the same statements, so it proves the order and the values, not Postgres semantics.
- **The planner's SQL names `"runCount"` directly.** `tracking.ts` still probes for that column before using it (from the time it did not exist). On a database without it the plan's upsert would fail; the column is in the Prisma schema and the dev database, so I did not add a probe.
- **After a restart of the counted runs, postings stamped before it are outside the missed-refresh rule until the query returns them again** (or until enough runs of the query as it is now have missed them). They close by `expiresAt` or the 45-day rule instead. This is the safe direction. A tuple that flips between 4 and 5 users daily restarts on each widening, so the rule mostly works on its hot days.
- **The first plan run after deploy replaces every stored demand and seed row of the planned search providers** (new identity hash): the old rows are switched off, new ones are created and are due at once. `consecutiveEmpty` and run history start again, and postings stamped with an old query id are no longer subject to the "missed twice" rule until a new query sees them. Between deploy and that first run a targeted (onboarding) ingest creates the new row beside the old one: at most one extra call per tuple.
- **`RA_ONBOARDING_FANTASTIC_WINDOW=24h` is not reflected** in the stored window of Active Jobs DB rows until MKT-3A declares `dateWindows` on the adapter (Request 4). The rows say `week`, as they always did.
- **Until Request 3 lands**, an ingest run in flight during the plan can put a query's previous window or text back for up to a day (see the request).
- **One English text per role.** INTL note 6.5 speaks of the label and up to two synonyms OR-ed; the item asks for the first English text, and JSearch's query builder has no OR form. `providerQueryLabels` returns the synonyms; the planner uses the first.
- **A cursor source that turns on mid-day** gets its standing query at the next plan (up to 24 h) or the next targeted ingest, because a source that is off no longer gets one (the item's rule). An existing standing query of a source that is off stays enabled and due; no tick leases it.
- **`quotaClosed` needs a reset time.** A 403 "not subscribed" reading without one closes nothing in the planner; the adapter's own answer (its breaker) decides.
- **`searchCountry` moves a tuple to `TW` only.** MKT-3A's `rapidApiCountry` moves a city to its one country whatever it is. Tuples from profiles and seeds always carry the city's own country, so the two agree on everything the planner produces.
- **Taiwan seeds are not searched on JSearch** (no seed is). Taiwan gets JSearch postings only for roles a signed-in user asked for, as strategy M-3 says.
- **A demand row that returns to score 0 on JSearch** still runs at the seed interval for 30 days before it is disabled (existing rule, not changed).
- `adapterQueryLanguages` for `jsearch` and `adapterDateWindow` for `activejobs` are defaults by provider id; no adapter declares `queryLanguages` or `dateWindows` yet.
- The 4 copilot card tests fail by the wall clock in every worktree until Request 8 is applied.

## Review resolution

Reviewer's verdict: no item undone, no unowned edit, four findings. Each was checked against the code before acting.

1. **[high] Taiwan `month` (and hot `3days`) stored on Active Jobs DB rows although that client always asks seven days: fixed.** Verified: `raFantasticJobs.ts` never reads `datePosted` (line 493 sends `time_frame = windowSuffix()`), `planQueries` handed one params object to every taker, and `buildMissedSql` trusts `params->>'datePosted'`. Fix as proposed: `JobSourceAdapter.dateWindows` and `adapterDateWindow(adapter, wanted)` in `sources/types.ts` (default by provider id: `activejobs`, `activejobs_feed` are `['week']`), exported from `sources/index.ts`; `planQueries` builds the params per taker. Tests: `types.test.ts` `adapterDateWindow` (three tests); `planner.test.ts` "the stored window is the one the source really asks for" (Taiwan, 6-user, 2-user and seed tuples on `[activejobs, jsearch]`; declared lists) and "a live Active Jobs DB posting reached through Taiwan demand is not 'missed'" (`isMissedTwice` with the planned row: ten days old is not missed; with `month` it would be; inside seven days the rule still fires). Four existing expectations changed from `month` / `3days` to `week` for the Active Jobs DB row. The optional request (declare `dateWindows` from `windowSuffix()`) is Request 4.
2. **[medium] Widening a window in place lets the missed-twice archive close postings that only aged out of the old window: fixed, with the reviewer's planner-only alternative.** Verified with the real functions as the review describes. I did not add a `windowRun` marker to params: it would do nothing until `tracking.ts` changes (owner MKT-5C, phase M5, no M3 owner), `IngestQueryParamsSchema` in `companies/contract.ts` is strict, and the write-back of finding 3 would erase it. Instead the two statements that change what a query returns set `"runCount" = 0`: the daily upsert, when the new window is wider than the stored one or `q` differs (non-standing rows, never a targeted upsert); and `retireUnusedDemand`'s widening of a score-0 row. A stamp from before the restart can then be judged only after at least two counted runs of the query as it is now (`runCount >= lastSeenRun + 2` with `lastSeenRun >= 1`), which is the rule's own meaning. No change to `tracking.ts` is needed (Request 6 is for information). Tests: SQL text of both statements; five model runs under "a rewrite in place and the missed-refresh rule" (hot to cold, hot to nobody, narrower or same window keeps the count, a corrected label restarts it, a targeted upsert never does), each asserting through `isMissedTwice`.
3. **[low] The ingest pipeline writes the leased params back: Request 3 to MKT-3A, plus a planner-side repair.** Verified (`pipeline.ts` `finishQuery` writes `"params" = <params read at lease time>`). The file is MKT-3A's; the exact change and test are in Request 3. In my files: the widening statement of `retireUnusedDemand` now covers every score-0 demand row with the hot window, not only rows zeroed in the run, so the one case the review calls permanent (a zeroed row that got `3days` back) is repaired by the next daily plan, without restarting its 30-day clock. Test: "a score-0 row whose three-day window was written back by an ingest run in flight is put right by the next plan". Since finding 2 is solved without a marker in params, the write-back cannot undo it.
4. **[low] Two overlapping plan runs can switch off every seed query for a day: fixed.** `"updatedAt" = GREATEST("RAIngestQuery"."updatedAt", EXCLUDED."updatedAt")` in the upsert's conflict clause, as proposed. Tests: the SQL text (daily and targeted), and a model run "two plan runs that overlap": upsert at T2, upsert at T1, `retireSuperseded(T2)` and `retireSuperseded(T1)` disable nothing, and a seed the plan really stopped naming is still switched off. A cron lock would be the complete answer (Request 11).

Rejected: none. Unowned edits to revert: none (the reviewer listed none; `git status` shows only the ten paths under "Files changed").
