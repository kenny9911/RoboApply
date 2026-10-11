# MKT-4S

Validated employer-board seeds: a stocked default feed for the international market, Taiwan and mainland China (JI-3, JC-4, JT-5). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4S`, branch `wp/MKT-4S`. Nothing committed. No edit outside the bundle's owns. This is the handoff after the independent review; what the review changed is under "Review resolution".

**Read this first**

1. **All four targets are met, measured on 2026-10-11.** International: 505 boards, 47,651 postings (targets 400 and 20,000). Mainland China: 52 boards with a mainland posting (target 50, a margin of 2). Taiwan: 41 boards with a Taiwan posting (target 30). Merged, the three files are 512 sources (38 before).
2. **A deployment now loads the seed files of the markets it serves** (review finding 1). Both brands, or RoboApply alone: 512 sources. The mainland stack (GoApply alone, its own database and cron): the 52 boards of `seeds.cn.json` and no other. Before this change it would have created all 512 sources and read 460 boards a day only to drop everything they list.
3. **The lists are thin where the numbers do not show it.** Bosch Group lists 1,321 of the 1,996 mainland postings; the other 51 boards hold 675, 25 of the 52 list fewer than 5, and 19 list one or two. In Taiwan SGS, Coupang and Ubiquiti hold 552 of 806. Industry was not measured; the candidates are mostly technology, finance and games employers.
4. **Two boards changed their standing in the review.** `ashby/openai` (815 postings) is in no file any more: its single answer is 90% of the limit whose breach switches a source off. `lever/octoenergy` stays, but under its board id as its name: nothing confirms the employer the candidates file guesses. Both are owner decisions (Requests).
5. **Network use: 1,958 read-only GET requests** to the five documented public hosts (Greenhouse, Lever, Lever EU, Ashby, SmartRecruiters), under the limits of the item (2 in flight per host, 300 ms pause, one retry after a network error, no retry of a 404, a cap per run). 1,940 by the validator, recorded in the report (22 of them in the review round); 18 while building and checking it. No RapidAPI, no keyed endpoint, no career-site HTML, no site of strategy 1.6. No database, no dev server, no browser, no model call.
6. **One rule of the M3 seed test is changed on purpose** (item 2, "Departures"): a SmartRecruiters board in the international file is read whole (`countries: []`), not per named country. The routing code is untouched.
7. **The mainland and Taiwan counts are a floor, and now for every entry of the two files.** The validator's reading of "mainland China / Taiwan" is deliberately narrower than the server's (0 of 77,140 generated lines placed there that the server would not; 0 of 128,575 cases with a stated country). The 21 SmartRecruiters entries, which the first pass had counted by the API's stated country, were asked again under the final rule: all 21 still list a posting there.

## Items

### 1. [P0] A read-only validator for employer-board seeds: done

`scripts/board-seeds/validate.mjs` (plain Node, no dependency, no import from the server) and `scripts/board-seeds/places.mjs` (which country a posting's location fields name).

- Input: `--candidates <file.jsonl>` (`{ ats, token, employer, aliases?, aliasSource?, countries? }`), `--date YYYY-MM-DD` (required; the clock is never read for a stored value), `--out <report.json>`. `--help` documents inputs, options, politeness and exit codes.
- One listing read per candidate on the endpoint the connector uses: Greenhouse `/v1/boards/{id}/jobs` (the connector's list-only URL), Lever `?mode=json&skip&limit` (also on `api.eu.lever.co` as `lever_eu`), Ashby `posting-api/job-board/{id}`, SmartRecruiters `/v1/companies/{id}/postings` (with the API's `country` filter when a candidate names countries). Any other host is refused before a request is made. The User-Agent is the server's own text for the international brand.
- Politeness, each tested on a fake clock: at most 2 in flight per host; 300 ms from every earlier start and end on that host (`--pause` can only raise it); one retry after a network error through the same queue; a 404 is asked once; a 429 leaves the host alone for the rest of the run; `--max` (default 800) is a hard cap that counts retries.
- Valid: 200 with at least one posting AND the name check. Where the answer states the company (Greenhouse `company_name`, SmartRecruiters `company.name`): equal to the employer or a listed alias once case, accents, punctuation, a leading "the" and legal forms at the end are set aside. Where it states none (Lever, Ashby): the board id equals the employer's name set the same way (`board_id_is_name`).
- **A board id listed for an employer needs its evidence** (review finding 3). An alias equal to the board id is the candidates file speaking, not the board. It gives the employer's name only with `aliasSource`, a document of this repository that confirms it (`board_id_alias`; the source is written into the report as `nameSource` and into the seed's note). Without one the board is reported as `board_id_only`: a live board, seeded under its board id, never under the guessed name.
- Report: per candidate valid or the reason; for a board that answered, the company name as stated, postings, postings per ISO country from location fields only, and how many are in mainland China, in Taiwan, elsewhere. A test holds every key of every result to a list of 18 allowed keys, on the fake run and on the committed report. No title or text is stored.
- Beyond the item, because the work needed it: resume (a second run with the same `--out` asks only what has no final answer); `--only`; `--pages`; `--redo-incomplete` and `--redo <keys>`; `--rejudge` (asks nothing: applies the candidates file's names and sources to stored answers). A failure in passing never replaces a final answer.

ACCEPT: `node scripts/board-seeds/validate.mjs --help` prints the usage and exits 0 (tested by spawning it). `scripts/board-seeds/validate.test.ts` (55 tests) runs every system against a fake fetch: valid, 404, name mismatch, zero postings, network error (retried once), plus timeout, wrong shape, not JSON, redirect not followed; per-host concurrency and pause proven on recorded start and end times; the report of a run holds no posting title or text and no clock time.

Not literally as written:
- **"ONE list-only read" is one listing read, not always one request.** Lever and SmartRecruiters page. A SmartRecruiters listing longer than `--pages` can reach is not paged at all (one request, the board's own total, marked incomplete), and a country-filtered pass stops after its first page when every row of it is in that country.
- **The Lever EU host is validated and reported, never seeded**: no connector reads it (JI-8 is MKT-5B's), and `PUBLIC_ATS` has no such system.
- **A board whose employer nothing confirms is valid as a board** (`board_id_only`) and is seeded under its board id. The item's rule ("the board token must equal the employer's normalised name or a documented alias") would refuse it; the reviewer allowed either. One board today, disclosed below.

### 2. [P0] Validated seed lists for all three markets: done

`scripts/board-seeds/candidates.jsonl` (1,431 lines, 1,409 boards), `scripts/board-seeds/report-2026-10-11.json` (counts only), and `scripts/board-seeds/build-seeds.mjs`, which writes the three seed files from the report and from nothing else. `seeds.test.ts` re-runs the builder on the committed report and fails if a file differs by one character.

| | Greenhouse | Lever | Ashby | SmartRecruiters | Lever EU | All |
|---|---:|---:|---:|---:|---:|---:|
| Candidates tried (boards) | 695 | 229 | 288 | 123 | 74 | 1,409 |
| Valid boards | 315 | 36 | 129 | 40 | 0 | 520 |
| Not found / no postings / name not matching | 350 / 18 / 12 | 190 / 3 / 0 | 149 / 10 / 0 | 0 / 83 / 0 | 74 / 0 / 0 | 763 / 114 / 12 |
| Postings on valid boards | 34,667 | 3,728 | 7,188 | 60,474 | 0 | 106,057 |
| `seeds.intl.json`: boards / postings | 313 / 28,889 | 35 / 3,598 | 128 / 6,325 | 29 / 8,839 | | 505 / 47,651 |
| `seeds.tw.json`: boards / postings | 22 / 360 | 8 / 63 | 4 / 14 | 7 / 369 | | 41 / 806 |
| `seeds.cn.json`: boards / postings | 28 / 202 | 8 / 90 | 2 / 39 | 14 / 1,665 | | 52 / 1,996 |

The candidates were tried once for all three markets, so "tried" is per system. `postings` in a file is the board's count for that file's place. The report's own `summary` counts candidate lines (1,431 lines, 540 valid), because a SmartRecruiters board has one line per country it is asked for; the table above counts boards.

- Entry: the existing shape plus `postings`, `postingCountries`, `verifiedOn`, `verifiedBy: 'live board API'`. `seeds.ts` parses them (all four or none), `mergeSeedFiles` adds the counts and unites the countries; the loader writes none of them and they are not in the hash, so a refresh of counts loads nothing on a deployment.
- **All 42 existing entries answered again and are kept** (26 mainland, 14 Taiwan, 2 international), each with the note of its first confirmation and a re-read clause. None failed, so none is reported as dropped. `scopely` needed a rule fix to count: its board writes "CH - Shanghai, China".
- Names of the 512 sources: 327 state their company and it equals the guess; 21 state it under another spelling listed as an alias; 160 are Lever or Ashby boards whose id is the employer's name; 3 are Lever or Ashby boards a document confirms for the employer (`shopback-2`, `crypto`, `kraken.com`: `JOB_SOURCES_TW.md` 3.5, named in each entry's note); 1 is listed under its board id (`lever/octoenergy`, 151 postings, 2 of them in mainland China: the file guesses Octopus Energy, the id does not spell it and no document confirms it).
- 30 boards answered with another name. I looked at each: 17 got an alias, one matched once "PBC" joined the legal forms, 12 stay invalid (another company, a product name, or a board label such as "Rubrik Job Board"; listed in `BOARD_SEEDS.md` 3.4).
- 8 of the 520 valid boards are in no file: SpaceX, Anduril and OpenAI (size, below) and five long SmartRecruiters boards without a mainland or Taiwan posting.

Targets: all met (see "Read this first"). Thin: Lever (36 of 229, 16%); the Lever EU host (0 of 74); SmartRecruiters by name (40 of 123); mainland China and Taiwan beyond three employers each.

Departures, with the reason (the documents and the code as built win over the item text):
- **`countries` keeps its as-built meaning ("what the board is read for"; empty = the whole board).** The item asked for "countries (ISO codes with a posting)" in the entry; storing measured codes there would make the loader read a Greenhouse board for those countries only. The measured codes are `postingCountries`.
- **A SmartRecruiters board in the international file is read whole.** M3's seed test said every SmartRecruiters seed names its countries; that held while every such seed was a mainland or Taiwan read. For a board wanted everywhere, naming 50 to 63 codes means one listing pass per code, misses a country the board adds later, and passes the 60-code limit of the admin body. `countries: []` is the contract's "every country" (`MARKET_TASK_PLAN.md` 3.2). In the mainland and Taiwan files a SmartRecruiters board still names CN / TW, and BoschGroup is still one row read for exactly CN and TW where both brands are served (strategy JT-5). One assertion of `seeds.test.ts` and the header of `seeds.ts` say the new rule; no routing code changed.
- **Not every valid board is seeded.** (a) A Greenhouse or Ashby board comes in one answer and the connector refuses one over 15,728,640 characters; the third refusal switches the source off. The builder leaves out a Greenhouse board over 1,000 postings and an Ashby board over 650, which leaves more than a quarter of the limit free at the densest answer measured (SpaceX 31,155,380 characters for 2,725 postings; OpenAI 14,219,219 for 815). Out: `greenhouse/spacex`, `greenhouse/andurilindustries`, `ashby/openai`. (b) SmartRecruiters boards longer than 1,000 postings are not read whole from a seed list: AbbVie, Eurofins, TurnerTownsend, HMGroup and SGS are seeded for CN and TW where they list postings there; AccorHotel, SopraSteria1, Securitas, Alten and Dominos are not seeded. All limits are builder options.
- **Candidates: 1,409, by "probing by name" (`JOB_SOURCES_INTL.md` 4.5), not from Common Crawl or the open-apply slug lists** (M3 Operations 24, still open).

Tests: `seeds.test.ts` (43): shape, facts on every entry, only allowed keys, hosts, the 14 Taiwan and 26 parity boards still present, the four bars, the countries rule per file, merge, hash; which files a deployment loads; the files equal the builder's output for the committed report; every seeded board is valid in the report under the name the report holds; no name without a confirmation; every SmartRecruiters entry of the two country files was asked with the country filter; the size caps against the connector's limit; the loader. `scripts/board-seeds/build-seeds.test.ts` (12).

### 3. [P1] How the seeds reach a fresh deployment, and a launch criterion: done

`docs/jobright-clone/market/BOARD_SEEDS.md`: method, counts per market and system, what is left out and why, how the seeds load, what the lists cannot cover, how to run it again, and a proposed launch criterion per market.

- **No manual step.** `jobs-boards` (every 5 minutes) starts with `loadCareerSeeds`; a database that never saw the list gets the sources, switched on and due at once. `jobs-plan` calls the same loader daily.
- **Which files: those of the markets the deployment serves** (`seedFilesFor` in `seeds.ts`; brands from `BRAND_LOCK`, else `ALLOWED_BRANDS`, else both). Both brands: all three files, 512 sources. RoboApply alone: the international and the Taiwan file, 512 sources, no SmartRecruiters board asked for CN. GoApply alone (the mainland stack): `seeds.cn.json`, 52 sources, a SmartRecruiters board asked for CN alone.
- **A run has no fixed number of boards.** 240 seconds, stops starting work at 20 left; leases 12 due boards at a time (twice `ATS_BOARDS_CONCURRENCY`, default 6), reads 6 listings in flight, writes one board at a time in batched statements.
- **First full read: hours, not days. An estimate, not a measurement**: nothing in this wave ran against a database. At 3 s a listing and 2 s a write, about 85 boards a run and 35 minutes for all 512; at 10 s a write a little over 2 hours. SmartRecruiters texts take longest: about 10,900 postings at 100 per board and run, BoschGroup at least 14 runs. The mainland stack: its 52 listings in one or two runs, BoschGroup's texts in at least 14. No Request for the board sync follows.
- **Proposed criteria** (owner): international 400 boards read without error in 48 hours and 20,000 open board postings; Taiwan 30 boards and 500 postings plus one finished open-data sweep; mainland the strategy's 50 boards and, new, 500 mainland postings outside the largest employer (675 today).

**After the first day**, if the seeds are the only source and the boards list what they listed on 2026-10-11: RoboApply holds about 48,000 open postings from 512 employer boards in more than 100 countries, half of them in the United States, each opening the employer's own posting; with the default enrichment budget (8,000 jobs a day per market) about 8,000 carry the model's fields and the rest their rule-based ones for about a week. Inside it, Taiwan has 806 board postings from 41 boards besides the open-data sweep. GoApply holds at least 1,996 mainland postings, 1,321 of them Bosch Group's: on the mainland stack from the 52 boards of the mainland file, which list 8,792 postings a pass (the 38 Greenhouse, Lever and Ashby boards have no country filter, so 6,796 postings of other countries are read with them and dropped). Fewer may be listed: a posting without a usable apply link is not written and a twin is listed once.

### Carry-over

`waveM1-carryover.md`, `waveM2-carryover.md` and `waveM3-carryover.md` have no section for MKT-4S. Of the M3 Owner and Operations entries the items name: Owner 20 gets its measured feed and a proposed criterion; Operations 18 is met by the seed with a margin of 2, and its "names to correct by hand" (`ramp`, `veeva`, `airwallex`, `weride`) are now corrected by the loader; Operations 24 (a candidate list from slug lists) is not done.

## Review resolution

All five findings were verified and are real. None was rejected. `undone` and `unownedEdits` were empty.

1. **(medium) The mainland stack loaded and read all boards: fixed, in `seeds.ts`.** Verified: `loadCareerSeeds` took no market, the lease takes every enabled due board, and the sync drops the postings of a market the deployment does not serve. Now a deployment loads the files of the markets it serves (`seedFilesFor`, `servedSeedMarkets`, `careerSeedBoards(markets)`; `loadCareerSeeds(db, { markets?, env? })` defaults to the brands of `process.env`). I went one step past the reviewer's wording: instead of filtering the merged list by `files.includes('cn')`, the loader merges only the served files. The difference is the `countries` of SmartRecruiters boards: on the mainland stack Ubisoft2, Canva and four more are asked for CN alone, as M3 read them, where a filter on the merged list would have made them whole-board reads there; and a RoboApply-only deployment no longer asks BoschGroup, AbbVie, TurnerTownsend, Eurofins and HMGroup for their mainland listing. Hash and `offered` are those of the list the deployment loads. Tests: mainland-only gives exactly the boards of `seeds.cn.json` (52, each feeding `cn`, SmartRecruiters `['CN']`, state and hash of that list, up to date on the second run); both brands give 512; RoboApply alone gives the international and the Taiwan file; a value of `ALLOWED_BRANDS` that names no brand resolves to RoboApply, never to the mainland list; the day a deployment adds the mainland market no board is added twice and BoschGroup goes from `['TW']` to `['CN','TW']`. `BOARD_SEEDS.md` section 4 states the rule, its reason and the cost it removes. One consequence for the owner is under Requests (Owner 7).
2. **(low) The floor was unproven for the SmartRecruiters entries: proven by reading them again.** I took the reviewer's first option, in its cheap form: one candidate line per board and country with the API's country filter, which is the listing the server reads for that file. 21 listings (14 for CN, 7 for TW, the two BoschGroup lines asked again), 22 requests, under the final rule. **All 21 still list a posting there**, the three smallest included (Believe 1, NBCUniversal 1, Primark 2), so the mainland bar stands at 52. Three counts fell by 19 postings in all (AbbVie 149 to 148, NielsenIQ 20 to 9, Wabtec 16 to 9): rows the API states as CN whose location line holds a word the rule reads as a place elsewhere. Mainland postings: 2,015 to 1,996. The builder now takes the filtered answer for the mainland and the Taiwan file where the report has one (a filtered listing that came back empty counts as zero), and a test fails for a SmartRecruiters entry of those files without one. What is still by the API's stated country, and said in `BOARD_SEEDS.md` section 1: the tail of two listings longer than a page (BoschGroup CN: 100 rows read, 1,221 from the API's count; SGS TW: 100 read, 214 from the API's count), and the international counts of SmartRecruiters boards.
3. **(low) An alias equal to the board id validated anything: fixed, in `validate.mjs`.** Verified with the reviewer's own example. `board_id_alias` now needs `aliasSource`, a document of this repository (parsed and refused when it is no `docs/….md` reference, when the line has no alias, or on a system that states its company); the report carries it as `nameSource` and the entry's note repeats it. The three sourced boards name `JOB_SOURCES_TW.md` 3.5, and two tests check that the document exists and names the board id and the employer. Without a source the answer is `board_id_only` and the builder writes the board id as the name (it also treats a `board_id_alias` without a source that way, so an older or hand-edited report cannot bring a guessed name in). For `octoenergy` I took the reviewer's second option: no document confirms Octopus Energy, so the board is seeded as `octoenergy`, the server's placeholder, and "Octopus Energy" is in no seed file (tested). The six self-aliases still waiting (`blockchain`, `mistral`, `1komma5grad`, `legalontech`, `xiaopeng`, `ziphq`) can no longer be seeded under a guessed name. `README.md` is corrected: it no longer says the id spells the employer.
4. **(low) `ashby/openai` at 90% of the limit, caps with 5% headroom: fixed, in `build-seeds.mjs`.** Defaults are now `greenhouseMax` 1000 and `ashbyMax` 650, the reviewer's numbers, and a test ties them to the server's `MAX_RESPONSE_BYTES`: at the densest answer measured per system (`MEASURED_CHARS_PER_POSTING`) a cap may use at most 75% of the limit (73% and 72% today), and no seeded one-answer board is above its cap. `ashby/openai` is out and reported as `one_answer_over_the_connector_limit`; the international file is 505 boards and 47,651 postings, as the reviewer computed. One thing the fix needed that the finding did not name: the builder kept every existing entry "as it was", so the entry it had written for OpenAI survived the new cap. An existing entry of a board over a size cap is now taken out of every file and named in the output (`takenOut`; tested). `BOARD_SEEDS.md` 3.1 says what happens when a seeded board outgrows the limit. Re-adding OpenAI is with MKT-5B (Requests) or the owner by hand.
5. **(low) Four boards kept their board id as the name on a database with the M3 seeds: fixed, in `seeds.ts`.** The loader now selects `companyName` and, for a row the seed owns, replaces a name that is just the board id (`hasPlaceholderName`) with the list's name when the list has one. A name an admin gave stays, a placeholder the list cannot name stays, and a board an admin switched off stays off. Tests: the extended admin test, a new one with all three cases, the parity-wave rows (`airwallex`), and the committed list on rows seeded under `ramp`, `veeva`, `airwallex`, `weride` (they become Ramp, Veeva, Airwallex, WeRide). Not claimed: postings already written under the board id keep that company until the board sync writes them again; I did not read the upsert to see whether it rewrites the company of an existing row.

How the review round was run: `validate.mjs … --only smartrecruiters --redo smartrecruiters:BoschGroup@CN,smartrecruiters:BoschGroup@TW --max 30` (21 candidates, 22 requests, exit 0), then `--rejudge` (asked nothing; four answers changed: the three sourced aliases and `octoenergy`), then `build-seeds.mjs --write`. To describe what the new loader does on M3 rows I ran it once on the in-memory database with the M3 seed files (read with `git show HEAD:…` into the scratchpad) from a throwaway test file in `scripts/board-seeds/`, which is deleted.

## Files changed

New, `scripts/board-seeds/`: `validate.mjs`, `places.mjs`, `build-seeds.mjs`, `validate.test.ts`, `build-seeds.test.ts`, `candidates.jsonl`, `report-2026-10-11.json`, `README.md`.

New: `docs/jobright-clone/market/BOARD_SEEDS.md`.

Changed, `server/src/features/jobs/sources/atsPublic/`: `seeds.intl.json` (2 to 505 boards), `seeds.tw.json` (14 to 41), `seeds.cn.json` (26 to 52), `seeds.ts` (four optional fields, their parsing and merge; which files a deployment loads; a placeholder name replaced; the header), `seeds.test.ts`.

Changed in the review round: `seeds.ts`, `seeds.test.ts`, the three seed files, `validate.mjs`, `build-seeds.mjs`, both script tests, `candidates.jsonl` (three `aliasSource`, 19 country lines, the header), `report-2026-10-11.json` (one more run, `nameSource`, `board_id_only`), `README.md`, `BOARD_SEEDS.md`. `places.mjs` is unchanged.

## Tests run

All on the final state.

| Command | Result |
|---|---|
| `npx vitest run scripts/board-seeds/validate.test.ts` | 55 passed |
| `npx vitest run scripts/board-seeds/build-seeds.test.ts` | 12 passed |
| `npx vitest run server/src/features/jobs/sources/atsPublic/seeds.test.ts` | 43 passed (also with `ALLOWED_BRANDS=goapply` in the shell) |
| `npx vitest run scripts/board-seeds server/src/features/jobs/sources/atsPublic server/src/features/jobs/ingest/boards.test.ts server/src/features/jobs/ingest/cron.test.ts server/src/features/jobs/m3Seams.test.ts` | 8 files, 334 passed, 5 todo |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | all six checks clean |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 731 files passed; 18,436 tests passed, 1 skipped, 10 todo |

The full suite was run three times in the review round, all green.

## Red tests for other bundles

None.

## Pre-existing failures

None in the review round. The round before it saw `server/src/features/jobs/import/directFetch.test.ts` miss two wall-clock limits (206 ms and 210 ms against 200 ms) in one of three full runs under a load average of 69; the file passes alone and imports nothing of mine. Already listed in `waveM3-carryover.md`, Orchestrator 11.

## Requests

**MKT-5B** (owns `sources/atsPublic/` and `ingest/boards.ts` in M5)
1. `shared.ts` `MAX_RESPONSE_BYTES` is 15 MB and a Greenhouse or Ashby board comes in one answer. Measured on 2026-10-11 with the connector's own URLs: `greenhouse/spacex` 31,155,380 characters for 2,725 postings; `ashby/openai` 14,219,219 for 815. Three valid boards wait for a larger limit: SpaceX, Anduril (2,491 postings, not measured) and OpenAI. Raise the limit (for example `export const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;`, weighed against six answers in flight in one function), set `MAX_RESPONSE_CHARS` in `scripts/board-seeds/validate.mjs` to the same value (a test compares the two), and rebuild with `--greenhouse-max` and `--ashby-max`. The seed test keeps a cap at 75% of the limit at the densest answer measured.
2. The three seed files are generated. Change them through `scripts/board-seeds/` (README there), or `seeds.test.ts` fails on the difference from the report.
3. No Lever EU board is on hand for JI-8: 0 of the 74 tried answered.
4. Optional, `ingest/boards.ts` `runBoardSync`: it calls `loadCareerSeeds(store)`, which reads the deployment's brands from `process.env`, while the sync itself uses `deps.brands ?? allowedBrands(deps.env ?? process.env)`. The two agree in production. One reading for both: `loadCareerSeeds(store, { markets: [...new Set(brands.map((id) => getBrand(id).market))] })`. `sources/atsPublic/index.ts` does not export `seedFilesFor` and `servedSeedMarkets` (the file is not mine); add them if a caller needs them.
5. A source switched off by three refused answers shows in the log and the sources console only. A line in the daily health e-mail for a seeded source that was switched off would make a board that outgrows the limit visible.

**MKT-5A**: the seed holds 313 Greenhouse boards, over the 200 of JI-7's `exclude_source` rule; Ashby 128, Lever 36 and SmartRecruiters 35 are under it. On the mainland stack the seed holds 28 Greenhouse boards.

**Orchestrator**
1. `MARKET_TASK_PLAN.md` still says the base of a fresh RoboApply deployment is 30 boards (section 3.2, the "Refresh interval by country" row) and that the seed files hold only the boards the research notes confirm (the JC-4 / JI-3 owner line); the note of `market-bundles.json` that starts "D3, D1 and the forbidden list hold in every bundle" says the same. Now: 512 sources, see `BOARD_SEEDS.md`. The "Career-site source state" row could add two as-built facts: the seed loader offers a deployment the files of the markets it serves, and a seed-owned row whose name is its board id takes the list's name.
2. At the gate, on a database that has the M3 seeds and serves both brands (simulated on the in-memory database): the first `jobs-boards` run adds 474 sources, makes six SmartRecruiters boards whole-board reads (WesternDigital, Continental, NielsenIQ, Wabtec, Ubisoft2, Canva), adds TW to AbbVie and Eurofins, and names `ramp`, `veeva`, `airwallex` and `weride`.
3. `deploy/cn/README.md` could say that the mainland stack loads `seeds.cn.json` only.
4. Geo, no owner in M4: `geo/cities.json` lists "Canton" as another name of Guangzhou, so `parseLocation('Canton')` answers mainland China and a posting whose whole location line is "Canton" lands in GoApply's index. With a state ("Canton, MA", "110 Albany Turnpike, Canton, CT 06019") the server answers US. Drop the alias or ask for a country beside it.

**Owner**
1. Accept or change the three launch criteria (`BOARD_SEEDS.md` 7).
2. Read the long SmartRecruiters boards whole? (AbbVie 1,888, Eurofins 2,578, TurnerTownsend 3,372, HMGroup 1,910, SGS 4,641, SopraSteria1 2,069, Securitas 1,255, Alten 1,183, AccorHotel 6,434, Dominos 24,844.)
3. Add by hand the nine live boards that state a label or a product instead of the employer (`BOARD_SEEDS.md` 3.4: rubrik, intercom, tide, cognite, xai, chicagotrading, fiveringsllc, rga, consensys)?
4. Set `JOB_SOURCES_CONTACT` before the first production run.
5. OpenAI: wait for the larger limit (MKT-5B 1), or add `ashby/openai` in the sources console now and watch it. About 87 more postings of today's size and its reads are refused; the third refusal switches it off.
6. `lever/octoenergy`: name it in the sources console, or write the document that confirms the employer and add it as `aliasSource` (the loader then names it on every deployment), or switch it off. Until then its 151 postings show the company "octoenergy".
7. The mainland stack watches the 52 boards of the mainland file and no other. A mainland posting that one of the other 460 boards opens later reaches GoApply there only after a refresh of the lists puts the board into the mainland file, or after an admin adds the board in GoApply's console. Watching every board from the mainland costs 460 more boards read at least once a day and about 38,000 postings read and dropped a pass (the review counted about 43,000 on the list that still held OpenAI). I chose the 52. Say so if the mainland stack should watch all of them.

## Schema requests

None.

## Env variables added or redefined

None added. `ALLOWED_BRANDS` and `BRAND_LOCK` keep their meaning; the seed loader now reads them too, to decide which seed files a deployment loads (unset: all three). `scripts/board-seeds/validate.mjs` reads `JOB_SOURCES_CONTACT` (existing) for its User-Agent, as the board sync does.

## i18n keys added or changed

None. The bundle has no namespace.

## Known gaps

- **Nothing was run against a database.** The loader is tested on the in-memory fake with all 512 boards and with the M3 rows; the time of the first full read is an estimate.
- **A mainland database that already loaded the M3 list keeps ten boards its new list does not name** (`stripe`, `ramp`, `ubiquiti`, `binance`, `asteralabs`, `piccollage`, `crypto`, `okx`, `dcard`, `kraken.com`). The loader never switches a source off, so they are read as before; an admin can switch them off. The same holds for any board a later refresh takes out of the lists.
- **Two differently scoped deployments on one database would rewrite each other's list state** at every run (the hash differs). The residency rules give the mainland stack its own database, so this is a configuration nobody should have.
- **Where the floor rests on the API's word.** BoschGroup's mainland count beyond its first 100 rows (1,221) and SGS's Taiwan count beyond its first 100 (214) are the API's own totals for that country. The international counts of SmartRecruiters boards are by the stated country. 43 of the 44 Greenhouse boards with a mainland or Taiwan posting were last read one step before the final rule, which only adds lines.
- **19 mainland postings the API states as CN are not counted** (AbbVie 1, NielsenIQ 11, Wabtec 7). The rule declines a line such as "Guangzhou, GD, China" because it cannot tell a province code from a country code; whether these rows look like that is not known, since no location line is stored. The server may route them to GoApply.
- **The per-country breakdown outside mainland China and Taiwan is a statistic**, counted for most boards with the first rule of the day. It routes nothing.
- **The size caps are posting counts.** They rest on one measured answer per system. A board with unusually long postings could pass the limit under its cap; the board sync then switches it off as described.
- **The first seven runs named `https://roboapply.io` in the User-Agent, the server's text names `https://www.roboapply.io`.** A parity test found it; fixed. The report's `userAgent` field shows the last run's value.
- **A count is a listing count.** The validator reads no posting text, so it does not know which postings lack an apply link or twin another source.
- **`postings` can exceed the distinct postings by one** on a long SmartRecruiters listing that changed while it was paged (DeliveryHero: 946 rows, 945 distinct).
- **A refresh asks the 763 board ids that do not exist again** unless they are taken out of `candidates.jsonl` first (README).
- **A board id that is a common word on Lever or Ashby** (`light`, `unit`, `column`) is seeded under that word: true for whoever holds the id, and no more is claimed.
- **Industry spread is unknown.**
- **Size:** `seeds.intl.json` is 210 KB in the server bundle and is parsed at the start of each board sync; `report-2026-10-11.json` (250 KB) and `candidates.jsonl` (89 KB) are in `scripts/`.
