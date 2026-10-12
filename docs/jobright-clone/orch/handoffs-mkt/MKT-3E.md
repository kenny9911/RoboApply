# MKT-3E

Taiwan: 台灣就業通 open-data adapter with a resumable sweep and attribution, zh-Hant role labels, 通俗職業 map, import denylist. Worktree `wp-MKT-3E`, branch `wp/MKT-3E`. Nothing committed, nothing pushed. No database, model, embedding, payment or RapidAPI call was made; no `.env` was opened.

This is the handoff after the independent review. All seven items are done. Nine review findings were raised: eight are resolved (one of them in part, the rest of it is a schema request), one is rejected with evidence from the cited source. See "Review resolution" at the end. No edit is outside the bundle's owns.

No item conflicted with MARKET_STRATEGY.md. Eleven places differ from the letter of an item; each is marked **Differs** so the orchestrator can object.

**Read-only GET requests.** Seven in the first session (five to the open-data endpoint, one to 中華郵政's published list, one to the data.gov.tw metadata of dataset 5949). Two more in this one, to verify review findings before acting on them: `CITY=01&zipno=103` on the open-data endpoint, and the postal list `https://www.post.gov.tw/post/download/County_h_10906.xml` again. All with the User-Agent `RoboApplyJobs/1.0 (+https://www.roboapply.io)`. The answers were kept outside the repository and reduced to counts; no posting text, employer or link is in the diff.

## Items

### 1. [P0] Taiwan district table — done

- `geo/twDistricts.json`: 22 counties with the `CITY` codes of the interface document, in its order, and 367 districts by 3-digit postal code. Source block filled: 中華郵政「縣市鄉鎮中英對照檔」, data.gov.tw dataset 5949, 政府資料開放授權條款-第1版, retrieved 2026-10-11.
- Compared again in this session with the published XML, row for row: 371 rows, 368 distinct codes; 367 are districts here and `290 釣魚台`, which names none of the 22 counties, is under `omitted`. No mismatch. The two codes a whole city shares (300 新竹市, 600 嘉義市) are one row with every name in `districts`.
- 817 and 819 stay districts of 高雄市: the list's Chinese name column writes them `高雄市東沙群島` and `高雄市南沙群島` (only the English column reads "Nanhai Islands"). The source notes of the file now say so and a test pins it (review finding 7, rejected).
- `geo/twDistricts.ts`: `TW_COUNTIES`, `TW_DISTRICTS`, `twCounty`, `districtsOfCounty`, `districtByZip`, `findTwDistrict` (台 and 臺 are one character), `validateTwDistricts`. Exported from `geo/index.ts`. `parseLocation` and the city table are untouched.
- Tests: `geo/twDistricts.test.ts`, 23 tests.
- Acceptance: every line met.

### 2. [P0] 台灣就業通 adapter: request, mapping, pay only from the numeric fields — done

- `sources/twOpenData.ts` replaces the guarded stub. Provider `tw_open_data`, kind `cursor`, markets `['intl']`, boards `['tw_open_data']`, cost model `free`, Taiwan only, not metered, transport `api`. On unless `TW_OPEN_DATA_JOBS_ENABLED` is `false` / `0` / `off` / `no`.
- Request: `GET <base>?CITY=<code>[&zipno=…][&jobno=…]&COUNT=1000&T=CSV`, https only, `redirect: 'error'` (a 3xx answer is refused too), 20 s timeout, 8 MB cap, `User-Agent = sourceUserAgent('intl', env)`. Never throws: a failure is `{ ok: false, error }` with a short code.
- CSV through `csv-parse/sync`; a column is matched on the ASCII part before the bracket. An empty body is an empty listing; a body that is not the dataset's CSV is `not_csv`.
- Mapping as the item lists it. Pay: figures only from numeric `NT_L` / `NT_U`; with no figure `SALARYCD` is passed verbatim as `salaryText`.
- **Differs 1 (skip counters).** A row without both ids is counted as `no_external_id`, a cell that is not a taiwanjobs.gov.tw link as `no_apply_url`, not as `no_stable_id`: both names already exist in `SOURCE_STATUS_NOTES`.
- **Differs 2 (endpoint override).** `TW_OPEN_DATA_JOBS_URL` is accepted only when it is https, without credentials, on `taiwanjobs.gov.tw` or a subdomain. Anything else disables the adapter (`url_invalid`).
- **Differs 3 (three more fields, all from the dataset).** `headcount` from `JOB_PERSON`, `workShift` from `WKTIME`, `locationDistrict` from `findTwDistrict(CITYNAME)`. `EXPERIENCE` also reads `N年內`.
- Fixtures: `sources/__fixtures__/tw/joblist.synthetic.csv` (eight invented rows under the live header line) and a README marked SYNTHETIC. The README's statement about `zipno` is corrected (finding 1).
- Tests: `sources/twOpenData.test.ts`, 74 tests in all (items 2, 3 and 6).
- Acceptance: every line met.

### 3. [P0] Resumable sweep cursor, one sweep a day, closure after two complete sweeps — done, reworked after the review

- The cursor is JSON text in the standing query's `params.cursor`: the item's fields plus `errors`, `partial`, `lastCompletePartial`, `close`, `second`, `pending` and three more counts (**Differs 4**, additions only; an unknown or foreign cursor starts a fresh sweep).
- Split: county → districts (`zipno`) → 大類 (`jobno`); a capped leaf keeps its rows, sets `incomplete` and counts `tw_capped_leaf`. With no district table a capped county is walked by 大類. Capped answers are never discarded.
- One fetch makes at most `TW_OPEN_DATA_REQUESTS_PER_FETCH` requests, strictly one after another, then answers `exhausted: false`. After the last county the adapter answers `{ jobs: [], calls: 0, exhausted: true }` until `TW_OPEN_DATA_SWEEP_HOURS` after the sweep's start.
- Registration: `sources/register.ts` (idempotent) ← `sources/twHooks.ts` ← `marketHooks.ts`. RoboApply has the adapter; GoApply never does, whatever `JOB_PROVIDERS_GOAPPLY` says.
- **Differs 5 (a failed request is not an ingest error).** `runIngestQuery` writes no cursor for a result with `error`, so the strike count would be lost. A failed request ends the fetch, keeps the rows read so far, leaves the position with `errors + 1`, logs a warning and counts `notes.tw_request_errors`; the third strike marks the sweep incomplete and moves on.
- **Differs 6 (the closure is its own step, and it is paged).** The fetch that reads the last county schedules the closure and answers `exhausted: false`; the next lease does the database read with no request and no posting, at most 5,000 rows in id order per step.
- **Differs 7 (closure by absence, rewritten: finding 1).** What the filters are: `CITY` and `zipno` do NOT select on the place a row displays. I measured `CITY=01&zipno=103` (大同區): 127 rows, 125 display 台北市大同區, 1 displays 台北市中正區, 1 displays 台北市不限. The reviewer measured more (a county answer with rows that display another county; a district answer that leaves out rows the county answer displays in that district). So the place name never tells which request returns a row, and my earlier rule (close a row when its place names a district of the table) was wrong. The rule now: absence proves a posting gone only when the county it displays was read whole, by its own answer under the cap, in BOTH sweeps. Rows of a county that hit the cap in either sweep are never closed by absence, whatever district they display; they are counted (`tw_absence_unproven`) and end on `STOP_DATE` or the age rule. A county walked by 大類 because the table has no districts is a capped county too. The file header and the fixture README say this now.
  - What this rule still cannot do, and why it needs a column: a row that displays a county read whole but is returned under a capped one is judged by the county it displays (the reviewer saw 6 such rows in 1,000). Closing by the request that last returned the row needs that request stored with the row. See Schema requests.
- **Differs 10 (the gap of the split is measured, and a county that misses enough is read again: finding 2).** While a capped county is walked, the cursor keeps the ids of the county's own answer (`pending`, at most 1,000 short strings, dropped when the county is done) and takes off each id a narrower request returns. What is left after the districts is counted: `notes.tw_county_only` and `counts.countyOnly`. When that is `TW_OPEN_DATA_COUNTY_WALK_MIN` rows or more (default 50, which is 5% of the sample; 0 turns it off) the county is read a second time, 大類 by 大類 (`CITY=<code>&jobno=01..22`, `second: true` in the cursor). A (county, 大類) answer still at the cap is counted (`tw_capped_county_major`) and does not make the sweep incomplete: the walk is extra coverage, not part of the split, and it changes nothing in the closure rule. What is left after that walk is `tw_county_unreached`. Neither strategy 1.3 nor the item asks for a second walk; I built it adaptive and with an off switch because the review's own figures (150 of Taipei's first 1,000 rows display 台北市不限) say the gap may be material, and nobody may run a sweep to find out. Cost when it runs: 22 requests for each county that crosses the threshold, and those rows are upserted a second time that day.
- The counter `tw_sweep_complete` is now `tw_sweep_finished`: it says the split was read to its end under the cap, not that every open vacancy was read. Each sweep's end also writes one log line with all counts.
- **Differs 11 (the pause also holds across two fetches: finding 4).** The adapter remembers when its last request ended and waits out the rest of `TW_OPEN_DATA_PAUSE_MS` before the first request of the next fetch. A fetch whose budget cannot hold that wait makes no request and answers the unchanged cursor with `exhausted: true`. A first request that owes no pause still runs whatever the budget. Another process knows of no earlier request and owes nothing (its gap is the cron interval).
- Tests (same file): the pure steps (walk, split, fallback, strikes, finish, the id list, the second walk and its capped answer, a position given up inside it); through the adapter with a scripted endpoint and a harness clock: the JT-2 split on the real tables, the capped leaf, the fallback, resume from the stored JSON in a second adapter instance (also inside the second walk), the measured gap with the second walk on, off and under the threshold on a fake listing in which requests share rows, sequential requests with the pause, the pause across two fetches, the time budget, an aborted run, the daily cadence, errors and strikes, skip counts, another market. Closure with a fake of the one read: closed at the end of sweep 3, not closed when sweep 3 was incomplete, a row that comes back, the candidate filter, the county rule, **a row its district request does not return while it is still listed is not closed** (the test the review asked for), a county capped in only one of the two sweeps, paging, a failed read. Registration: once, RoboApply yes, GoApply no.
- Acceptance: every line met.

### 4. [P0] OGDL attribution on every open-data row — done

- `sources/twHooks.ts`: hook set `tw_sources`, third in `MARKET_HOOK_SETS`. `TW_OPEN_DATA_ATTRIBUTIONS` keyed by `sourceBoard` holds the two sentences exactly as the item gives them. `cardMeta` returns `{ attribution: { text, url: 'https://data.gov.tw/license' } }` with the Taipei-time year of `lastSeenAt`; `afterNormalize` sets `sourceName` and clears `originalSourceName`.
- Web: `market/tw/meta.ts` `readTwSourcesMeta`; `JobMetaTw.tsx` renders the sentence as a link to the licence text on the card and on the job page. Existing token classes only; no image.
- One reading of my own: when the sentence is there but the link is not a safe http(s) URL, the sentence is shown as plain text instead of nothing.
- No new i18n string.
- Tests: `sources/twHooks.test.ts` (13), `market/tw/__tests__/jobMetaTw.attribution.test.tsx` (12).
- Acceptance: every line met; `npm run check` passes.
- **Not covered by this item (finding 9):** the attribution travels in `cardMeta` and is rendered by `JobMetaTw` only. The similar-jobs list, tracker rows, assistant job cards, alert emails and the public visitor list show a row without it. None of those files is mine: Requests, MKT-5C, orchestrator and Owner 1.

### 5. [P1] Traditional Chinese labels and synonyms — done, corrected after the review

- `taxonomy.v1.json`: all 307 nodes have `zhHant`; all 230 roles have `synonyms.zhHant` (983 Taiwan titles). File level: `zhHantReview: { status: 'draft', reviewedBy: null, reviewedOn: null }`. Ids, English and Simplified labels and synonyms, `soc` and `generic` are byte-identical to the base: a test pins their sha256.
- **The 77 category and group labels are the ones `i18n/messages/zh-TW.json` already ships** (finding 8). 44 of my drafts differed from the shipped wording and are replaced by it; a new test fails if the data file and the bundle ever disagree on a category or group. The 230 role labels and the 983 titles are my translations in Taiwan usage and remain a draft.
- Two Taiwan titles named a different role than the same title in Simplified and are removed (finding 6): `工程經理` from the engineering manager (its mainland reading 工程经理 is the construction manager) and `客戶關係經理` from the account manager (客户关系经理 is the financial advisor). A new test reads every Taiwan phrase in its mainland form (`foldTwToCn`, the reading ingest takes) and fails when that names another role: 1,213 phrases checked, none clashes.
- Three Taiwan titles added to the restaurant role: `餐廳服務員`, `餐飲服務員`, `外場服務員` (they were found only through the suffix rule that finding 3 retires).
- `taxonomy.ts`: `zhHant` required on `TaxonomyNode`; `validateTaxonomy` fails for a node without a Taiwan label, a role without its list, a blank synonym; `TAXONOMY_ZH_HANT_REVIEW`; `exportTaxonomyLabels(locale)`.
- `match.ts`:
  - The Taiwan label and titles are indexed beside the Simplified ones; the level words, head words, filler and class year know both scripts.
  - **服务员 names restaurant staff only as the whole title** (finding 3): it is in `ALONE_ONLY_PHRASES`. Before, the synthetic care-worker row of the fixture went through the normalizer as `server` (the reviewer's reproduction, which I repeated: 照顧服務員 0.8, 居家照顧服務員 0.714, 加油站服務員 0.75). Now 照顧服務員, 居家照顧服務員, 長照服務員, 加油站服務員, 停車場服務員, 客房服務員 and 門市服務員 match no role in either reading; 餐廳服務生, 服務生, 餐厅服务员, 餐廳服務員 are restaurant staff; the bare word is its role at 0.85. This also changes the mainland side on purpose: 客房服务员 and 加油站服务员 are no longer restaurant staff, and a title such as 酒店服务员 or 火锅店服务员 now waits for enrichment instead of being filed by the last word. `npm run eval:match -- --enforce M2` still exits 0.
  - **Each phrase carries its vocabulary** (`en`, `zh`, `zhHant`), and the typeahead for locale `zh` leaves the Taiwan phrases out (finding 5). I compared `searchTaxonomy(q, { locale: 'zh' })` with the base for 14,613 queries (every 1, 2 and 3 character piece of every Chinese phrase, every English word): zero differences. zh-TW and every other locale search all three vocabularies. Title matching still reads all of them for every market.
- `queryLabels.ts` (**Differs 8**): a Taiwan label that joins two names is not a title a provider can find, so `providerQueryLabels` sends the role's first Taiwan title instead.
- **I did not edit `i18n/messages/*.json`.** See Requests, Orchestrator 3.
- Tests: `taxonomy.test.ts` (19), `match.test.ts` (320), `queryLabels.test.ts` (10), plus the untouched `idsFrozen.test.ts` and `precision.test.ts`.
- Acceptance: every line met. `taxonomyLabel('software_engineer', 'zh-TW')` is 軟體工程師; `資深軟體工程師` maps to the software engineer; `npm run check:zh-variants` passes.

### 6. [P1] 通俗職業 code → role map — done

- `taxonomy/twJobno.json`: the 22 大類, each with the closest Explore category or null; 63 小類 with a role. `twJobno.ts`: `twRoleForJobno`, `twCategoryForMajor`, `validateTwJobno`.
- 62 of the 63 pairs were read in live responses; the 63rd, `050313 網頁設計師`, is one the research note names. **Differs 9:** the map holds more than the four named 小類, each marked with where it was read.
- Left out on purpose: a 小類 that spans two of our roles, and occupations the tree does not have (照顧服務員, 保全人員). An unmapped row is classified by its title, and since finding 3 a care worker's title names no role (the adapter test checks it through the normalizer).
- `scripts/tw-jobno-catalog.mjs`: reads saved CSV responses, prints the distinct pairs with counts, exits 2 when a response and the map disagree on a name. Local files only.
- Tests: `taxonomy/twJobno.test.ts` (13); the adapter test for the mapped and the unmapped code.
- Acceptance: every line met.

### 7. [P2] Import denylist — done

- `import/contract.ts`: `518.com.tw`, `yes123.com.tw`, `meet.jobs` added; the comment says why `taiwanjobs.gov.tw` is not listed.
- Tests: `import/urlPolicy.test.ts` (65).
- Acceptance: met.

### What was verified against the live sources

| Fact | How |
|---|---|
| CSV shape: BOM, CRLF, 19 quoted columns, headers with full-width brackets | 6 answers |
| `STOP_DATE` is `YYYYMMDD` or `額滿為止` | measured |
| `NT_U` can be `-` beside a numeric `NT_L`; `SALARYCD` takes six values | measured |
| `CITY` combines with `zipno` and with `jobno` | measured |
| `zipno` does not select on the district a row displays (125 / 1 / 1 of 127 for `zipno=103`) | measured in this session |
| A county answer holds rows that display another county; a district answer omits rows the county answer displays there | the reviewer's measurements, not repeated |
| District table equals the published postal list, 817 and 819 included | compared row for row, twice |
| 62 小類 code and name pairs | `scripts/tw-jobno-catalog.mjs` on the answers |

The statement of the first handoff "a `<county>不限` row is under no `zipno`" was wrong (one county, one request); it is gone from the code, the README and this file.

### Carry-over

`waveM1-carryover.md`, section MKT-3E:

1. **Done.** `synonyms.zhHant` is read by `match.ts`; the collision tests include it; `taxonomyNodeLabel` is exported.
2. **Done in part.** `業務代表` names the account executive. `フルスタックエンジニア` is still unplaced (no Japanese phrases; no item adds them). `seniorityFromTitle('行銷經理')` is `level.ts`, MKT-3C's.
3. **Decided: an official code does not outrank enrichment, and no column is requested for it.**
4. **Left.** 管培生 waits for the owner.
5. **Done.** The raw `matchTitle` reads Traditional Chinese.
6. **Done as far as an engineer may.** No ingest may be run, so there is no sweep.
7. **Done.** `sourceUserAgent('intl', env)`.

`waveM2-carryover.md` has no MKT-3E section. `wavePAR-carryover.md`, job-source entries 1 to 7b: none names a file inside my owns.

## Files changed

Modified:
- `server/src/features/jobs/sources/twOpenData.ts` (rewritten)
- `server/src/features/jobs/marketHooks.ts`
- `server/src/features/jobs/geo/index.ts`
- `server/src/features/jobs/import/contract.ts`
- `server/src/features/jobs/import/urlPolicy.test.ts`
- `server/src/features/jobs/taxonomy/taxonomy.v1.json`
- `server/src/features/jobs/taxonomy/taxonomy.ts`
- `server/src/features/jobs/taxonomy/match.ts`
- `server/src/features/jobs/taxonomy/queryLabels.ts`
- `server/src/features/jobs/taxonomy/index.ts`
- `server/src/features/jobs/taxonomy/taxonomy.test.ts`
- `server/src/features/jobs/taxonomy/match.test.ts`
- `server/src/features/jobs/taxonomy/queryLabels.test.ts`
- `components/features/market/tw/meta.ts`
- `components/features/market/tw/JobMetaTw.tsx`

New:
- `server/src/features/jobs/sources/twOpenData.test.ts`
- `server/src/features/jobs/sources/twHooks.ts`
- `server/src/features/jobs/sources/twHooks.test.ts`
- `server/src/features/jobs/sources/register.ts`
- `server/src/features/jobs/sources/__fixtures__/tw/joblist.synthetic.csv`
- `server/src/features/jobs/sources/__fixtures__/tw/README.md`
- `server/src/features/jobs/geo/twDistricts.json`
- `server/src/features/jobs/geo/twDistricts.ts`
- `server/src/features/jobs/geo/twDistricts.test.ts`
- `server/src/features/jobs/taxonomy/twJobno.json`
- `server/src/features/jobs/taxonomy/twJobno.ts`
- `server/src/features/jobs/taxonomy/twJobno.test.ts`
- `components/features/market/tw/__tests__/jobMetaTw.attribution.test.tsx`
- `scripts/tw-jobno-catalog.mjs`

Touched in the review round: `twOpenData.ts`, `twOpenData.test.ts`, the fixture README, `match.ts`, `match.test.ts`, `taxonomy.v1.json`, `taxonomy.test.ts`, `twDistricts.json` (a sentence in the source notes), `twDistricts.test.ts`. Every path is inside the bundle's owns; there was no unowned edit to revert.

Removed exports of `twOpenData.ts`: `TW_OPEN_DATA_LICENCE_CONFIRMED`, `TW_OPEN_DATA_ATTRIBUTION`. `twOpenDataStatus` and `twOpenDataEnabled` remain with the new meaning. New in the review round: `TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT`, `TwSweepStep`, the optional fourth argument of `advanceTwSweep` and third of `failTwSweep`.

Outside the worktree: this handoff only (`/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-3E.md`).

## Tests run

All in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3E`, after the last code change.

| Command | Result |
|---|---|
| The 11 test files I wrote or touched (twOpenData 74, twHooks 13, twDistricts 23, taxonomy 19, match 320, queryLabels 10, twJobno 13, idsFrozen 5, precision 18, urlPolicy 65, jobMetaTw.attribution 12) | 11 files, **572 passed** |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 719 files: 712 passed, 7 failed. **17,264 tests passed, 13 failed**, 1 skipped, 10 todo |

The 13 failures are the same 13 as before the review round: 9 are caused by this bundle in files outside my owns (next section), 4 are older than this bundle. Every test in a file I own is green. One comment-only edit to `match.ts` came after the full run; the server type-check and the taxonomy and adapter tests were run again after it.

## Red tests for other bundles

Nine tests in six files. Each follows directly from an item; none could be avoided inside my owns.

1. **`server/src/features/boundary.test.ts`** (no owner in any phase: orchestrator). "cross-area imports go through index.ts or contract.ts only" reports `jobs/marketHooks.ts → jobs/sources/twHooks.ts`. Fix: `const HOOK_MODULES = new Set(['cn/jobs/hooks.ts', 'jobs/sources/atsPublic/hooks.ts', 'jobs/sources/twHooks.ts']);`
2. **`server/src/features/seams.test.ts`** (no owner: orchestrator). "statically registers the cn and ats_public hook modules" should expect `['cn', 'ats_public', 'tw_sources']`.
3. **`server/src/features/jobs/sources/atsPublic/atsPublic.test.ts`** (MKT-3D), two tests.
   - "stays registered second in MARKET_HOOK_SETS": expect `['cn', 'ats_public', 'tw_sources']`, or assert index 1 only.
   - "TW open data: stays off until the licence spike is confirmed": delete the block (the adapter has its own test file) or assert the new default: `twOpenDataStatus({})` is `{ enabled: true }` and `getSourceAdapter('tw_open_data')` is not null. Drop `TW_OPEN_DATA_ATTRIBUTION` from the import: the export is gone.
4. **`server/src/features/onboarding/zhFold.test.ts`** (no owner in M3: orchestrator), two tests. They assert that a Traditional query in zh-TW returns exactly what its Simplified reading returns. The zh-TW typeahead now also finds the Taiwan phrases directly, so the lists differ (more results, Taiwan matches first). They should assert containment: `ids('後端')` contains `backend_engineer`; `ids('軟體工程師')[0]` is `software_engineer`; `ids('產品經理')[0]` is `product_manager`. The header comment of `onboarding/defaults.ts` `suggestTitles` ("The taxonomy's Chinese phrases are Simplified") is out of date too.
5. **`server/src/features/retrieval/searchDoc.test.ts`** (MKT-2H's area, no owner in M3: orchestrator). `jobText.ts` already reads `node.zhHant`; the role-label line is now `'Backend engineer / 后端开发工程师 / 後端工程師'`.
6. **`server/src/features/jobs/enrich/titleEvidence.test.ts`** (no owner in M3; MKT-4D in M4: orchestrator), two tests that pinned "the raw matcher cannot read Traditional text".
   - Drop `expect(bestTaxonomyMatch('資深後端工程師')).toBeNull()`; it is now `{ id: 'backend_engineer', score: 1 }`.
   - `bestTaxonomyMatch('前端工程師')` is now score `1`, not `0.7`. The `titleEvidence` assertions of both tests still hold.

## Pre-existing failures

- **`components/features/copilot/__tests__/cards.test.tsx`, four tests.** A clock problem, not this bundle: the cards are built with the fixed test clock `NOW = 2026-10-10T08:00:00Z` and a 24-hour proposal lifetime, and the web component compares the expiry with the real clock. Since 2026-10-11T08:00Z they render "This suggestion expired" in every worktree. My diff touches no copilot file. Fix for its owner: build the wire cards with a far-future expiry, or freeze the clock in the test.
- `server/src/features/jobs/import/directFetch.test.ts` "a 2 MB page … in milliseconds" is a wall-clock test that failed once under a parallel run in the first session and passes in the full runs. Already noted by MKT-1C.

## Requests

**Orchestrator**

1. The five unowned test files above (boundary, seams, zhFold, searchDoc, titleEvidence): the exact assertions are listed.
2. After the M3 merge, the cross-bundle line "MKT-3E returns exhausted false during a sweep and MKT-3A caps a cursor source's share of a tick": the adapter answers `exhausted: false` after every fetch of a running sweep, so without that cap one tick spends its whole budget on it.
3. zh-TW taxonomy labels. `taxonomy.categories` and `taxonomy.groups` of `i18n/messages/zh-TW.json` need NO change: the data file now carries exactly those 77 labels and `taxonomy.test.ts` fails when the two disagree (so a later rewording of one in the bundle must change `taxonomy.v1.json` in the same commit, or the reverse). Fill only `taxonomy.roles` (230 entries, which the bundle does not have yet) from `exportTaxonomyLabels('zh-TW').roles`, not from a translation: `npx tsx -e "import('./server/src/features/jobs/taxonomy/index.ts').then((m) => console.log(JSON.stringify(m.exportTaxonomyLabels('zh-TW').roles, null, 2)))"`. The role labels are a draft (Owner 3).
4. Embeddings: `retrieval/jobText.ts` puts the Taiwan role label into the card text, so the card hash of every job with a role changes with this merge and the retrieval sweep re-embeds those rows once.
5. Closure by request scope (the rest of finding 1): the schema request below, then MKT-3C's two lines, then about 40 lines in `twOpenData.ts` for whichever bundle owns it next: set `sourceScope` on each input, keep the scopes that hit the cap in the cursor, select `sourceScope` in the closure read and close a row only when its stored scope was read to its end in both sweeps.
6. The attribution outside the card and the job page (finding 9), for the surfaces no M3 or M5 bundle owns: tracker rows, alert emails (`server/src/features/alerts/`) and assistant job cards (`server/src/features/copilot/`, `components/features/copilot/cards/`; MKT-4H in M4). Either carry `cardMeta.tw_sources` on those items and render the same sentence, or show for a `tw_open_data` row a short source line that links to the job page, where the full sentence is.

**MKT-3A** (`ingest/pipeline.ts`, status notes)

- The adapter's counters are `tw_request_errors`, `tw_skipped_position`, `tw_capped_leaf`, `tw_county_only`, `tw_county_unreached`, `tw_capped_county_major`, `tw_sweep_finished`, `tw_sweep_incomplete`, `tw_absence_unproven`. None is in `SOURCE_STATUS_NOTES`, so they reach the log tally and not the admin panel. `tw_county_only` is the one that matters most: it is the measured number of rows per sweep that the split by district does not reach (among each capped county's first 1,000). `tw_sweep_complete` no longer exists.
- Optional, and it would let the adapter report a failed request as an error: let `runIngestQuery` store a cursor that an error result carries. See Differs 5.

**MKT-3B** (`sources/registry.ts`): `KIND` has no entry for `tw_open_data`, so `jobSourceKind` answers `'search'`. Add the entry (MKT-1C asked for the same).

**MKT-3C** (`normalize/`, `ingest/upsert.ts`, `ingest/maintain.ts`)

- **Do NOT add `tw_open_data` to `NO_DATE_EXPIRY_PROVIDERS` now.** I asked for the opposite in the first handoff and withdraw it. With the corrected closure rule, a row of a county that hits the cap (13 counties, most of the inventory) is never closed by absence, and a share of rows has no deadline (`額滿為止`: 139 of 376 in the county I measured, 13% in the reviewer's sample). Exempt from the age rule, those rows would stay open for ever. Keep the present rule until the request scope is stored with the row (Orchestrator 5). This is in tension with the domain line "open-data rows are never dropped for posting age"; the research note keeps the 45-day rule for this source on purpose, and without a sound closure it is the only end such a row has.
- For Orchestrator 5: `ProviderJobInput.sourceScope?: string | null`, passed through by the normalizer, and written by the upsert on every sighting (insert and update, so the latest request wins).
- The adapter fills `headcount`, `locationDistrict` and `workShift`; the upsert writes none of them yet.
- `seniorityFromTitle('行銷經理')` still answers `lead_staff` (`level.ts`).

**MKT-3D** (`sources/atsPublic/atsPublic.test.ts`): the two tests above.

**MKT-3F** (admin console, namespace `admin`): the sources panel has no name for `tw_open_data` and no sentence for the reason `url_invalid`. Add a name and a description for the source, the reason, and sentences for the counters MKT-3A adds, `tw_county_only` first ("vacancies the daily read did not reach by district").

**MKT-5C** (`components/features/job/`, `server/src/features/feed/items.ts`): `SimilarJobs.tsx` prints title, company, place and pay with no market slot, so a `tw_open_data` row is shown there without the attribution the licence asks for wherever the row is shown (finding 9). Carry `cardMeta.tw_sources` on those items and render `JobMetaTw`'s attribution, or show a short source line that links to the job page. The server side is ready: `twHooks.ts` `cardMeta`.

**MKT-5D** (事求人): the attribution sentence and the source name for `tw_gov_jobs` are already in `twHooks.ts`; the adapter only has to write `sourceBoard = 'tw_gov_jobs'`.

**MKT-5F** or whoever owns `server/src/features/feed/sourceLine.ts`: `NO_AGE_FLOOR_BOARDS` does not list `tw_open_data`, so the feed hides an open-data row whose update date is older than 120 days. Leave it so for now, for the same reason as MKT-3C's first line.

**MKT-5H** (`.env.example`): replace the line "# Taiwan open data (licence pending verification; WP-42 stub stays off)" and list the six variables of the table below. `TW_OPEN_DATA_JOBS_ENABLED=` (empty) now means ON.

**Owner**

1. **Do not add `tw_open_data` to `PUBLIC_DISPLAY_PROVIDERS` yet.** `FeedQueryService.publicList` builds visitor items without `cardMeta`, so a public list would show open-data rows without the attribution. The signed-in feed and the job page carry it.
2. The first sweep inserts every open vacancy (the note's floor is 17,275) and each new row queues one enrichment. To hold it back, set `TW_OPEN_DATA_JOBS_ENABLED=false` until you are ready.
3. A Taiwan-native reviewer for the 230 role labels and 983 titles; then set `zhHantReview` in `taxonomy.v1.json`. The 77 category and group labels are the ones the zh-TW bundle already ships.
4. A courtesy notice to the dataset's contact (02-8995-6030, research note open question 3): a daily sweep is several hundred requests, one at a time with a 1.5 s pause.
5. The second walk (Differs 10) is on by default with a threshold of 50 rows. `TW_OPEN_DATA_COUNTY_WALK_MIN=0` turns it off; the gap is still measured and reported then. Read `tw_county_only` after the first real sweep and decide.
6. Mainland effect of finding 3: a title that ends in 服务员 and is not the role's own name (酒店服务员, 火锅店服务员) is no longer filed under restaurant staff by its last word; enrichment decides. If GoApply should keep such titles on the deterministic path, the way is more Simplified titles on the role (餐饮服务员, 传菜员 …), which changes the pinned Simplified data and is your call.

## Schema requests

One, additive, for the orchestrator (it finishes finding 1; nothing in this bundle needs it to pass its gates):

```prisma
model RAJob {
  // … existing fields …

  /// The request of a split source that last returned the row, written on every sighting.
  /// tw_open_data: '<CITY>' (the county's own answer), '<CITY>:<zipno>', '<CITY>:<zipno>:<jobno>',
  /// '<CITY>::<jobno>' (a county read by 大類). Null for every other source.
  sourceScope String?
}
```

No index: the closure read is by `sourceBoard` and `lastSeenAt`, as today. With it, a row is closed by absence only when the request that last returned it was read to its end (under the cap) in both sweeps, whatever place the row displays; a row last reached only through a capped county answer is never closed by absence. That removes the known limit of Differs 7 and lets rows of capped counties close when their district answer was complete.

(The optional `RAJob.taxonomySource` of the M1 carry-over is not requested.)

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `TW_OPEN_DATA_JOBS_ENABLED` | **Redefined.** `false`, `0`, `off` or `no` turns the 台灣就業通 adapter off. Unset, empty or any other value: on. | on |
| `TW_OPEN_DATA_JOBS_URL` | **Redefined.** The open-data endpoint. Must be https on `taiwanjobs.gov.tw` or a subdomain, without credentials; anything else disables the adapter (`url_invalid`). | `https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx` |
| `TW_OPEN_DATA_REQUESTS_PER_FETCH` | Sequential requests per adapter fetch (1 to 50). | 5 |
| `TW_OPEN_DATA_PAUSE_MS` | Pause between two requests, inside a fetch and from one fetch to the next (0 to 60000). | 1500 |
| `TW_OPEN_DATA_SWEEP_HOURS` | Hours between two sweep starts (1 to 336). | 24 |
| `TW_OPEN_DATA_COUNTY_WALK_MIN` | **New (review round), not in the bundle's env list.** Rows of a capped county's own answer (its first 1,000) that no district request returned, at or above which the county is read a second time by 大類. 0 = never. 0 to 1000. | 50 |

Also read, unchanged: `JOB_SOURCES_CONTACT` (the User-Agent).

## i18n keys added or changed

None. The bundle owns no namespace. The attribution sentences, source names, district names and 大類 names are server data. The role labels reach the web bundle through `exportTaxonomyLabels` (Requests, Orchestrator 3).

## Known gaps

- **No sweep has run.** Everything is proven on scripted endpoints and on a few real answers reduced to counts. The true size of the inventory, the number of capped districts, the measured gap (`tw_county_only`) and the real request count of a sweep are unknown until the first run.
- **Rows of capped counties are not closed by absence.** In the 13 counties that hit the cap, a posting ends on `STOP_DATE` or the age rule only. This is the price of not inferring coverage from a place name; the schema request removes it.
- **A row that displays a county read whole but is returned under a capped one** is judged by the county it displays and can be closed while still listed, then revived (a few per thousand rows in the reviewer's sample; it needs the row to drop out of every answer for two sweeps). Same fix.
- **The second walk assumes the 22 大類 cover a county's rows.** That is why it adds coverage only and decides nothing about closure; `tw_county_unreached` measures the assumption.
- **The gap is measured on a sample**: the county's first 1,000 rows. A row that leaves the source between the county's answer and its district answers counts as "not returned"; that noise is small beside the threshold of 50.
- **The service's tolerance for a daily sweep is unknown.** The defaults are gentle and every number is an env variable.
- **A source outage is quiet.** Each failed request costs one lease; a position is given up after three; the sweep ends incomplete and closes nothing. The panel shows "ok" with zero rows until MKT-3A and MKT-3F surface the counters (Differs 5).
- **An empty answer is read as "no vacancies".** An empty body and a header-only body both give zero rows, anything else is `not_csv` and a strike.
- **The 230 role labels and 983 titles are a draft** written without a native reviewer.
- **The Simplified matcher is otherwise unchanged**, including its known false match of 电工 inside 光电工程师.
- **Japanese titles** still match no role.
- **The 小類 map covers 63 codes** of the 292 the note counted. `scripts/tw-jobno-catalog.mjs --unmapped` lists the rest from saved responses.
- **The attribution is missing on similar jobs, tracker rows, assistant cards, alert emails and the public list** (Requests).
- **UI:** the attribution was not looked at in a browser (not allowed in this run).

## Review resolution

1. **High: closure by absence inferred coverage from CITYNAME. Real; resolved in owned code, the rest is a schema request.** Verified first with one live request: `CITY=01&zipno=103` returned 127 rows of which one displays 台北市中正區 and one 台北市不限. Done: `twAbsenceProven` is true only when the county a row displays was read whole in both sweeps (the "district of a partial county" branch is gone; a county split by 大類 counts as capped too); the rest is counted as `tw_absence_unproven`; the test the review asked for is there (a district answer that omits a row its county answer displays in that district: not closed while still listed, and a real removal in a whole county is closed in the same step); the header, the fixture README and this handoff no longer say "不限 rows are under no zipno"; MKT-3C is told not to add the source to `NO_DATE_EXPIRY_PROVIDERS`. Not done here because it needs a column, `ProviderJobInput` and the upsert, none of them mine: closure by the request that last returned the row (Schema requests; Requests, Orchestrator 5 and MKT-3C).
2. **Medium: a sweep was called complete while county-only rows went unmeasured. Real; resolved.** The cursor keeps the ids of a capped county's own answer, takes off what narrower requests return and counts the rest (`tw_county_only`, `counts.countyOnly`). `tw_sweep_complete` is now `tw_sweep_finished`, and the sweep's end logs all counts. The second walk by 大類 is built too, adaptive: it runs for a county only when its measured remainder reaches `TW_OPEN_DATA_COUNTY_WALK_MIN` (default 50, 0 = off), and a capped (county, 大類) answer is counted as partial coverage without making the sweep incomplete. Requests to MKT-3A and MKT-3F to show the counter.
3. **Medium: care-worker postings filed as restaurant "Server". Real; resolved** with the reviewer's first option: `服务员` is in `ALONE_ONLY_PHRASES`. Tests through both readings and through the normalizer. Three Taiwan titles ending in 服務員 added to the role so real restaurant titles keep matching. `eval:match --enforce M2` exits 0. The mainland side effect is stated under Owner 6.
4. **Low: no pause between two fetches. Real; resolved** as proposed (`lastRequestEndedAt` in the adapter's closure; a fetch that cannot hold the owed wait makes no request). Test with the harness clock: every gap between ten requests over two fetches is at least 1,500 ms.
5. **Low: Taiwan phrases reordered GoApply's typeahead. Real; resolved.** Phrases carry their vocabulary; locale `zh` skips the Taiwan ones. Checked against the base for 14,613 queries: no difference. Tests pin 主管, 助理, 房 for `zh` and 主管秘書 for zh-TW and the other locales. One thing the fix needed beyond the proposal: phrases are indexed English and Simplified first, so a text both vocabularies share (研究助理) stays Simplified.
6. **Low: two Taiwan synonyms named another role than their Simplified reading. Real; resolved.** `工程經理` and `客戶關係經理` removed; a test reads all 1,213 Taiwan phrases through `foldTwToCn` and fails on a clash. I used the fold ingest uses instead of the glossary: the glossary holds banned terms and a reference table, no character map.
7. **Low: postal codes 817 and 819 filed under 高雄市 "by hand". Rejected.** The cited source files them there itself: the list's Chinese name column reads `高雄市東沙群島` and `高雄市南沙群島` (fetched and read again in this session; only the English column says "Nanhai Islands"), and the whole table equals the list row for row. Moving them to `omitted` would be the hand edit. Done instead, as the finding's last sentence asks: the source notes of the file say where the county is confirmed, and a test pins the two rows, 367 districts and 40 for 高雄市. Cost: two requests a day when 高雄市 is at the cap.
8. **Low: 44 of 77 category and group labels differed from the shipped zh-TW bundle. Real; resolved.** The 77 labels are now the bundle's; a test compares `exportTaxonomyLabels('zh-TW')` with `zh-TW.json`. Two of the bundle's labels are also a role's own phrase (行政, 法務); the collision test now checks category and group labels apart and pins exactly these two. The request to the orchestrator is narrowed to the 230 role labels.
9. **Low: open-data rows shown without the attribution outside the card and the job page. Real; no owned file is involved.** Moved to Requests: MKT-5C (similar jobs, `feed/items.ts`), orchestrator (tracker rows, alert emails, assistant cards), and the standing warning about `PUBLIC_DISPLAY_PROVIDERS` (Owner 1).

Not done items named by the review: none. Unowned edits named by the review: none.
