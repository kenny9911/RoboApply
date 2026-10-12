# MKT-1C

Taiwan pay parser (JT-1) and the contracts the source wave builds on. Worktree `wp-MKT-1C`, branch `wp/MKT-1C`. Nothing committed, nothing pushed. No database, network, model or provider call was made; no `.env` was opened.

All four items are done, and all six review findings plus the item the reviewer judged not done are resolved (see "Review resolution" at the end). No item disagreed with the plan documents. Four places differ from the letter of an item or of a contract row; each is marked **Differs** so the orchestrator can object.

## Items

### 1. [P0] 台灣就業通 no-figure wording is negotiable pay, never NT$40,000 (JT-1) — done

- `normalize/salary.ts`: the Chinese "pay not listed" wording is one exported source string, `CJK_NEGOTIABLE_SOURCE`, and `NEGOTIABLE_RE` is built from it. It gained `依學經歷、證照核薪` (with or without the comma and 證照), `依學經歷`, `核薪`, the Simplified forms, and `按公司規定`. Longest alternatives first, so a description slice is the whole phrase.
- `核薪` is wording of its own only. Not inside `核薪方式` (the open-data field label), `核薪作業` / `核薪人員` (payroll work), or `審核薪資` / `考核薪酬` / `審核薪水` / `稽核薪資` / `複核薪資` (reviewing pay). One guard, `HE_XIN`, the same in the parser and the card hook.
- `parseSalaryText` returns `{ min: null, max: null, currency: null, period: null, months: null, negotiable: true, text: verbatim }` for the acceptance sentence. No fallback turns a clause into a minimum anywhere.
- **Descriptions (changed after review).** A job description is running text, so the two short forms need more than a pay word somewhere on the line (`saysPayNotListed`):
  - the firm phrases (面議, 依公司規定, `依學經歷…核薪`, "competitive salary") count anywhere on a pay line; `依學經歷…核薪` also opens a line that has no other pay word;
  - bare `核薪` counts only on a labelled pay line (`薪資：核薪`, `● 待遇：核薪`, `2. 薪資：核薪`). "負責每月薪資核算、核薪、勞健保加退保" is a payroll duty and stores nothing;
  - bare `依學經歷` counts on a labelled pay line or when its own clause names pay ("本公司薪資依學經歷而定", "月薪依學經歷敘薪"), not in "熟悉薪資作業，依學經歷分派職務".
  In a pay field (the provider's own pay text) both short forms are the wording, as the item asks.
- `sources/atsPublic/hooks.ts`: `isTwNegotiable` and `twCardMeta` use the same list, so the sentence gives `pay.negotiable true`, `pay.disclosed false` and the card text `依學經歷、證照核薪`.
- Tests: `salary.test.ts` (the sentence with half-width and full-width brackets, eight wording alternatives alone, figure plus wording, numeric provider fields win, look-alike words in a pay field, seven duties lines that store nothing in three markets, labelled lines, the 依學經歷 clause rule, a duty and real wording on one line); `atsPublic.test.ts` (card meta for the sentence at two thresholds, the alternatives alone, figure plus wording, look-alike words, a duties-only posting through the normalizer to the card); `normalizeProviderJob.test.ts` (a SYNTHETIC `tw_open_data` row end to end, a duties-only `ats_public` posting in both markets).
- Acceptance: every line met. No existing salary test changed its expectation.

### 2. [P0] The Art. 5 floor clause is recognised at any threshold (JT-1) — done

**The shape.** `TW_FLOOR_CLAUSE_SOURCE` (exported, one string): optional `每月 / 經常性 / 薪資|月薪`, optional `達|達到|為|:`, optional Taiwan-dollar marker (`新台幣 / 台幣 / NT$ / NTD / TWD`), then `[4-9]` or `四五六七八九` + `萬|万`, or `[4-9]0,000` / `[4-9]0000`, then optional `元`, `(含)`, `或`, and `以上`. Half-width and full-width digits, commas and brackets. Both digit look-behinds are kept (`104萬以上`, `140,000以上`, `4.5萬以上`, `45,000以上` stay real figures) and the top of a stated range is never taken for the clause (`4萬~5萬以上`). No constant named after 40,000 remains in either file.

**The rule (rewritten after review; one place, `floorClauses` + `isFloorClause` in `salary.ts`).** A clause-shaped match is the statutory clause, and so never a figure for the job, when:

| The match | It is the clause | Example |
|---|---|---|
| carries the statute's own term (`經常性薪資…`) | always: any market, any country, with or without 面議 beside it. It is itself "pay not listed" | `每月經常性薪資達4萬元以上` |
| carries a Taiwan-dollar marker | next to "pay not listed" wording, in any market | `待遇面議 (月薪NT$40,000以上)` |
| is bare | next to such wording, for a job in Taiwan (either market), or on an international row whose country is unknown | `面議，月薪5萬以上` |
| follows another currency or another pay period | never | `月薪 HK$40,000 以上`, `年薪 USD 60,000 以上`, `時薪 …` |

So: a GoHire row (market cn) for a job in Taipei has no figure; a mainland row of unknown country with the statute's sentence has no figure; "薪资面议，月薪5万以上" on a mainland row is still ¥50,000 a month; "面議，月薪5萬以上" in Hong Kong is HK$50,000; a non-negotiable `月薪 5萬以上` is a disclosed minimum of 50,000 TWD a month.

**Descriptions.** `payFromDescription` reads a description as one posting, in two passes: when any pay line says "pay not listed", the clause is the clause on every other line too, in either order ("待遇：面議" and, a line below, "月薪達5萬元以上"). The statute's wording on its own line or sentence is never a figure. Before: NT$40,000 a month, `salaryAnnualMin` 480,000.

**The card.** `hooks.ts` holds the same shape and the same two guards. `twNegotiableCardText('待遇面議（經常性薪資達5萬元或以上）')` is `待遇面議`; an amount in another currency or for another period stays in the card text; a pay text that is only the statute's clause is `negotiable` with `text: null` (the component shows no pill for it).

**Differs from the item text** (please confirm or reject):
1. **The statute's own clause is "pay not listed" by itself.** The item says the clause is scrubbed "only when the pay text is negotiable". For the bare and Taiwan-dollar forms that is what the code does. For the form with the statute's term I made the clause count wherever it stands, because the item's ACCEPT ("never produced as a job's pay by any path") and JOB_SOURCES_TW §4 ("the employer restating the legal condition. It is not a pay figure") cannot be met otherwise when the clause sits on its own line. The documents win over the item's wording here.
2. **The `40,000` form takes the same optional lead-in as the `萬` form** (as in the first handoff). Cost: on a Taiwan row "面議，月薪 60,000 以上" is stored as not disclosed, words kept. The reviewer called this a defensible reading.
3. **`(含)` before `以上`, and `為` / `:` after the pay word, are part of the shape** ("經常性薪資：4萬元以上").

**One rule, two files, and why.** `server/src/features/boundary.test.ts` lets an area import another area only through its `index.ts`, and `normalize/index.ts` is not mine. So the hook holds character-for-character copies of four strings (`TW_NEGOTIABLE_SOURCE`, `TW_FLOOR_CLAUSE_SOURCE`, `TW_FLOOR_STATUTE_SOURCE`, `TW_FLOOR_OTHER_PAY_BEFORE_SOURCE`); `atsPublic.test.ts` asserts each equals the parser's and that card and parser agree on 18 texts. Editing one file without the other fails that test. Request R3 removes the copies.

- Tests: `salary.test.ts`: 16 thresholds × 4 wordings × 5 clause shapes, each crossed with the non-negotiable reading; both look-behind guards; range tops; "where the job is decides" (3 statute sentences × 6 market and country pairs, Taiwan-dollar and bare forms); the mainland minimum; other currency, other period and other country (16 texts); eight descriptions with the clause on its own line or sentence, in both orders; the statute's clause alone in six contexts and four paths. `atsPublic.test.ts`: 14 thresholds × 5 shapes on the card, other-currency texts stay, the statute alone, the lockstep test. `normalizeProviderJob.test.ts`: `bank_gohire`, `bank_robohire` and `activejobs_feed` rows of market cn for a job in 台北市, the clause in the description only, a mainland row of unknown country, a mainland minimum unchanged.

### 3. [P0] Provider ids, adapter options and input fields (JI-2, JT-2, JT-4, JT-9, JI-9, JI-7) — done (unchanged since the first handoff)

Types and inert defaults only; contract as written in MARKET_TASK_PLAN "Provider ids and adapter options".

1. `normalize/types.ts`: `NormalizeProvider = JobProvider | 'ats_public' | 'tw_open_data' | 'tw_gov_jobs' | 'usajobs' | 'activejobs_feed'` (brand registry untouched). `ProviderJobInput` gained optional `taxonomyId`, `sponsorshipProvider: 'offered' | 'not_offered' | null`, `locationDistrict`, `workShift`. `NormalizeContext` gained optional `companyDomains: ReadonlyMap<string, string>`. Corrected the stale comment on `NormalizedJob.headcount`.
2. `normalize/source.ts` `PROVIDER_META`: `tw_open_data` (12, `tw_open_data`, 台灣就業通, no applicant count), `tw_gov_jobs` (12, `tw_gov_jobs`, 事求人, none), `usajobs` (8, `usajobs`, USAJOBS, none), `activejobs_feed` (10, **`activejobs`**, Active Jobs DB, allowed). Existing priorities unchanged.
   - The only reverse lookup is `providerOfBoard` in `ingest/verifyFeed.ts` (later keys win), so `activejobs_feed` is placed **before** `activejobs`; a test pins `providerOfBoard('activejobs') === 'activejobs'` and that no other two providers share a board. See R4.
   - `NO_APPLICANT_COUNT_PROVIDERS` is derived from `applicantCountAllowed`, so it is now `['linkedin', 'jsearch', 'tw_open_data', 'tw_gov_jobs', 'usajobs']`.
3. `normalize/normalizeProviderJob.ts`: new exported `taxonomyIdsForProviderRole(id)`. A valid role (level 3) id becomes the primary id with its ancestors and `fieldSources.taxonomy = 'provider'`; anything else leaves the title dictionary to decide as before. Nothing reads the other three input fields or `companyDomains`.
4. `sources/types.ts`: `JobSourceAdapter` gained optional `costModel?: SourceCostModel` and `isEnabledFor?(market)`; new exports `SourceCostModel`, `adapterCostModel(adapter)` and `adapterEnabledFor(adapter, market)` (a throw or a non-`true` answer is off). `IngestQueryParams.q` is documented as role text in the query language.
5. `taxonomy/taxonomy.ts`: `TaxonomyNode.zhHant?`, `synonyms.zhHant?`; new exported `taxonomyNodeLabel(node, locale)`; `taxonomyLabel(id, 'zh-TW')` returns `zhHant` when set, else English, never Simplified. `validateTaxonomy` refuses a blank `zhHant`.

- Tests: `normalizeProviderJob.test.ts`, new `sources/types.test.ts`, `taxonomy.test.ts` (as in the first handoff).
- Acceptance: every line met; no normalizer snapshot or fixture expectation changed.

### 4. [P1] Provider quota snapshot contract and the identifying User-Agent (JI-1, JI-4) — done

- `ingest/quotaContract.ts` (types, constants, pure functions): `PROVIDER_QUOTA_CONFIG_KEY = 'jobs.providerQuota.v1'`, `PROVIDER_QUOTA_VERSION`, `PROVIDER_QUOTA_STATES`, `ProviderQuotaState`, `ProviderQuotaSnapshot`, `ProviderQuotaDocument`, `parseProviderQuota(raw)`, `serializeProviderQuota(mapOrList)`, `daysToReset(snapshot, now)`, `usageKey(provider, market)`.
  - Parse is tolerant and never throws. One cleaning rule in both directions (contract fields only, counts are non-negative numbers or `null`, dates are ISO, unknown state is `unknown`, blank plan is `null`).
  - **Changed after review:** for a map, serialize uses the map KEY as the provider, exactly as parse does. Two entries under `activejobs` and `activejobs:cn` stay two entries whatever their `provider` field says; each written entry names the key it is stored under. A list is still keyed by each snapshot's own field (last one wins).
- `sources/userAgent.ts`: `sourceUserAgent(market, env = process.env)` → `RoboApplyJobs/1.0 (+https://www.roboapply.io)` / `GoApplyJobs/1.0 (+https://www.goapply.top)`. Only the first line of the contact is used, non-printable and non-ASCII characters and brackets are removed, the value is capped at 200 characters with its comment still closed.
  - **Changed after review; differs from the contract row.** Each brand reads its own contact variable through `brandOwnEnv`: RoboApply `JOB_SOURCES_CONTACT`, GoApply `CN_JOB_SOURCES_CONTACT`, else the brand's own site. One process runs both brands' ingest, so with the shared read GoApply sent `GoApplyJobs/1.0 (+https://www.roboapply.io/bots)` to mainland boards. The contract row and the M1 env table name one variable; the signature and the return shape are unchanged, so no consumer changes.
- No adapter sends the header yet: wiring is MKT-3D, 3E, 5B and 5D by their own items.
- Tests: `quotaContract.test.ts` (27), `userAgent.test.ts` (12). Pure.

### Carry-over (`wavePAR-carryover.md`, "Market waves")

- **Entry 1 (`'linkedin'` in `JobProvider`; names `normalize/source.ts`) — left.** `PROVIDER_META` is `Record<NormalizeProvider, …>`, so its `linkedin` entry cannot go while the literal is in `platform/brand/registry.ts`, which has no owner in any phase; stored `sourceBoard = 'linkedin'` rows are read through the entry. MARKET_TASK_PLAN assigns the removal to no bundle.
- **Entry 6 (dedupe priority; `source.ts`) — left.** JI-5 is MKT-3C's, and item 3 says existing priorities do not change here.
- Entries 2, 3, 4, 5, 7a, 7b, 7 name no file of mine.

## Files changed

Modified:
- `server/src/features/jobs/normalize/salary.ts`
- `server/src/features/jobs/normalize/salary.test.ts`
- `server/src/features/jobs/normalize/types.ts`
- `server/src/features/jobs/normalize/source.ts`
- `server/src/features/jobs/normalize/normalizeProviderJob.ts`
- `server/src/features/jobs/normalize/normalizeProviderJob.test.ts`
- `server/src/features/jobs/normalize/rules.test.ts` (one assertion; the colocated test of `source.ts`, see Review resolution 8)
- `server/src/features/jobs/sources/atsPublic/hooks.ts`
- `server/src/features/jobs/sources/atsPublic/atsPublic.test.ts`
- `server/src/features/jobs/sources/types.ts`
- `server/src/features/jobs/taxonomy/taxonomy.ts`
- `server/src/features/jobs/taxonomy/taxonomy.test.ts`

New:
- `server/src/features/jobs/sources/types.test.ts`
- `server/src/features/jobs/sources/userAgent.ts`
- `server/src/features/jobs/sources/userAgent.test.ts`
- `server/src/features/jobs/ingest/quotaContract.ts`
- `server/src/features/jobs/ingest/quotaContract.test.ts`

Changed in this pass: `salary.ts`, `salary.test.ts`, `hooks.ts`, `atsPublic.test.ts`, `normalizeProviderJob.test.ts`, `userAgent.ts`, `userAgent.test.ts`, `quotaContract.ts`, `quotaContract.test.ts`.

Outside the worktree: this handoff only (`/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-1C.md`).

## Tests run

All in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1C`, after the last edit.

| Command | Result |
|---|---|
| The eight test files I wrote or touched (`npx vitest run <files>`) | 8 files, **882 passed**, 4 todo (todo existed before). `salary.test.ts` 491, `rules.test.ts` 141, `normalizeProviderJob.test.ts` 121, `atsPublic.test.ts` 60 (+4 todo), `quotaContract.test.ts` 27, `types.test.ts` 19, `userAgent.test.ts` 12, `taxonomy.test.ts` 11 |
| `npx vitest run server/src/features/jobs` | 46 files, 1,908 passed, 6 todo |
| `npx vitest run server/src/features/boundary.test.ts` | passed |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | **648 files passed, 14,754 tests passed**, 1 skipped, 10 todo, 0 failed |

Every reviewer reproduction was run against the code before the fix (all reproduced) and after it.

## Red tests for other bundles

None.

## Pre-existing failures

None in this pass. (The first handoff noted one wall-clock flake in `server/src/features/jobs/import/directFetch.test.ts`, "a 2 MB page … in milliseconds", seen once under a parallel run; it did not recur. The file is not in my diff.)

## Requests

**Orchestrator, at the M1 merge (before M3 starts).** `features/boundary.test.ts` lets an area import another area only through its `index.ts` or `contract.ts`. Three contracts I built sit behind index files that no M1 bundle owns:

- **R1. `server/src/features/jobs/sources/index.ts`** (M3 owner MKT-3B; consumers MKT-3A, MKT-3B, MKT-3D, MKT-5A, MKT-5B). Add:
  ```ts
  export type { SourceCostModel } from './types.js';
  export { adapterCostModel, adapterEnabledFor } from './types.js';
  export { JOB_SOURCES_CONTACT_ENV, SOURCE_USER_AGENT_MAX, sourceUserAgent } from './userAgent.js';
  ```
- **R2. `server/src/features/jobs/ingest/index.ts`** (M3 owner MKT-3A; consumer MKT-3F). Add:
  ```ts
  export { PROVIDER_QUOTA_CONFIG_KEY, PROVIDER_QUOTA_STATES, PROVIDER_QUOTA_VERSION, daysToReset, parseProviderQuota, serializeProviderQuota, usageKey } from './quotaContract.js';
  export type { ProviderQuotaDocument, ProviderQuotaSnapshot, ProviderQuotaState } from './quotaContract.js';
  ```
- **R3. `server/src/features/jobs/normalize/index.ts`** (M3 owner MKT-3C). Add `export { CJK_NEGOTIABLE_SOURCE, TW_FLOOR_CLAUSE_SOURCE, TW_FLOOR_OTHER_PAY_BEFORE_SOURCE, TW_FLOOR_STATUTE_SOURCE } from './salary.js';`. Then, in `sources/atsPublic/hooks.ts` (MKT-3D in M3), import the four from `'../../normalize/index.js'` in place of the copies and drop the four `toBe` lines of the lockstep test. Until then the copies are safe: the test fails when they differ. Not urgent.
- **R4. `server/src/features/jobs/ingest/verifyFeed.ts`** (no owner in any phase). `BOARD_PROVIDER` resolves the board `activejobs` to the search provider only because `activejobs_feed` precedes `activejobs` in `PROVIDER_META` (pinned by a test). To make it explicit: `.filter(([provider]) => provider !== 'activejobs_feed')` where the map is built.
- **R5. `server/src/platform/brand/brandEnv.ts`** (no owner in any phase). Optional: add `'JOB_SOURCES_CONTACT'` to `BRAND_OWN_ENV`, so `brandEnv` and the admin's `brandEnvSource` answer the same way `sourceUserAgent` reads it. Behaviour does not depend on it (`brandOwnEnv` is already the strict read).

**MKT-1G** (`.env.example`, `deploy/cn/cn.env.example`): list `JOB_SOURCES_CONTACT` in `.env.example` and **`CN_JOB_SOURCES_CONTACT`** in `deploy/cn/cn.env.example` (see "Env variables"). The M1 env table in MARKET_TASK_PLAN names only the first.

**MKT-3C** (`normalize/` from M3): 
- (a) **A wrong currency, found while testing, not fixed here (outside my items, and not caused by this bundle).** `currencyFromText` tests `S\$` before `US\$` and `A\$` before `CA\$`, so `US$90,000 - US$110,000 a year` on a US row is stored as **SGD** and `CA$90,000` as **AUD**. Fix in `salary.ts`: `['SGD', /(?<![A-Za-z])S\$|\bSGD\b/i]`, `['AUD', /(?<![A-Za-z])A\$|AU\$|\bAUD\b/i]`, `['BRL', /(?<![A-Za-z])R\$|\bBRL\b/i]`, with a test for `US$`, `CA$`, `AU$`, `S$`. A provider currency field wins over the text, so only rows whose pay comes from text are affected.
- (b) `NO_DATE_EXPIRY_PROVIDERS` in `identity.ts` does not list the new providers, so a row without `expiresAt` expires 45 days after `postedAt`. JI-10 says an age cut-off never drops open-data rows: decide per source.
- (c) `sponsorshipProvider`, `locationDistrict`, `workShift` and `companyDomains` are on the input types and read by nothing.
- (d) `NormalizedJob.headcount` is carried and still not written by the upsert.

**MKT-3B** (`sources/registry.ts`): `KIND` has no entry for `tw_open_data`, `tw_gov_jobs`, `usajobs`, `activejobs_feed`, so `jobSourceKind` answers `'search'` and the default transport `'rapidapi'` for them. Add entries in the change that registers the adapters.

**MKT-3E** (`taxonomy/`): `synonyms.zhHant` is read by nothing (`match.ts` builds its phrases from `en` and `zh` only; the collision test does not include `zhHant`). `taxonomyNodeLabel` is exported from `taxonomy.ts` but not from `taxonomy/index.ts`.

**MKT-3A, MKT-3B, MKT-3F, MKT-5A** (quota): the snapshot key is a free string and, for a map, the key is what is written. Counts must be numbers: a header value left as a string parses back as `null`.

**MKT-3D, 3E, 5B, 5D** (User-Agent consumers): call `sourceUserAgent(market, env)` with the market of the request; do not read `JOB_SOURCES_CONTACT` yourselves.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `JOB_SOURCES_CONTACT` | RoboApply's contact URL or `mailto:` printed in the User-Agent of every job-board and open-data request (`RoboApplyJobs/1.0 (+<contact>)`). Only the first line is used; non-ASCII characters and brackets are removed; the header is capped at 200 characters. Never read for GoApply. | unset → `https://www.roboapply.io` |
| `CN_JOB_SOURCES_CONTACT` | The same for GoApply (`GoApplyJobs/1.0 (+<contact>)`). Not in the M1 env table: added after review so RoboApply's contact is never sent to mainland boards. | unset → `https://www.goapply.top` |

Read by `sources/userAgent.ts` only; no adapter sends the header until M3.

## i18n keys added or changed

None (the bundle owns no namespace and adds no copy).

## Known gaps

- **Nothing was checked against real data.** The patterns were written from the research note's quoted sentence and from the wording in the tests. MKT-3E should count `salaryDisclosed` against `NT_L` / `NT_U` on its first real sweep.
- **Conservative losses, by design.** On a Taiwan row, or an international row of unknown country, a negotiable posting's real round monthly minimum written like the clause ("面議，月薪 60,000 以上") is stored as not disclosed, words kept. The same holds across the lines of one description ("待遇：面議" on one line, "月薪5萬以上" on another).
- **A foreign-currency clause-shaped amount is recognised only by what stands directly before the amount** (`HK$`, `USD`, `美金`, `年薪`, …). A currency written after it ("5萬港元以上") never matched the shape, so it was always a figure.
- **`statesAmount` still answers true for a pay text that carries the clause** (an existing test pins this, and `feed/items.ts` and `jobs/detail/view.ts`, not mine, use it). On a Taiwan card the hook's text without the clause is shown; on the job page the clause is visible as the posting's own words, as before this bundle. JT-6 and JT-8 own that wording.
- **Short forms in descriptions.** A line with only `核薪`, or `依學經歷敘薪` with no other pay word, is not read (the line gate needs a pay word or the full `依學經歷…核薪` phrase). `依公司規定` on a pay line keeps its pre-existing behaviour ("薪資優渥，休假依公司規定" reads as pay wording); not changed here.
- **The clause in English** ("regular monthly wage of NT$40,000 or above") is not recognised, as before.
- **Chinese-numeral amounts are recognised in the clause but still not parsed as figures** ("月薪四萬以上" alone stores nothing), as before.
- **A bare `$` in front of the clause stays in the card text** ("面議，月薪 $40,000 以上" → "面議，月薪 $"), as before this bundle.
- **The new provider ids are inert**: no adapter is registered for them, `twOpenData.ts` is still the guarded stub, and nothing writes or reads the quota row.
- **`adapterEnabledFor` trusts the adapter**: it does not check `adapter.markets` (the contract does not ask for it).
- R1 and R2 are needed for M3 to compile across areas; I could not apply them (files outside my owns).

## Review resolution

1. **Item 2 judged not done ("never produced as a job's pay by any path") — fixed.** (a) The market-keyed guard is gone; see 2. (b) The clause on its own line of a description is no longer a figure; see 4. Both reproductions now give no figure: `parseSalaryText('待遇面議（經常性薪資達4萬元或以上）', { country: 'TW', market: 'cn' })` and `{ country: null, market: 'cn' }` → `negotiable: true, min: null`; `normalizeProviderJob(…台北市…, 'bank_gohire')` → `salaryDisclosed false, salaryMin null`; both description texts → `salaryDisclosed false, salaryAnnualMin null`.
2. **High: the mainland guard brought NT$40,000 back for cn-market rows in Taiwan — fixed, as proposed, with one reading of my own.** The decision is by the job's country and the clause's own words (`isFloorClause`), with a walk over the matches in place of the single `replace`. Tests added for every case the reviewer listed. **My reading:** the fix text says both "scrub in any market or country when the clause carries the statutory term or a TWD marker" and "never scrub when country === 'CN'". I applied the second to the bare form only. A clause with the statute's term or a Taiwan-dollar marker is scrubbed on a `CN` row too: Taiwanese employers post mainland jobs with that sentence, and no mainland posting uses the term. Reject if the stricter reading was meant: it is one line in `isFloorClause`.
3. **Medium: bare 核薪 turned a duties line into "pay as posted: 核薪" — fixed.** `HE_XIN` tightened in both files as proposed (`(?<![審审考稽查複复覆])核薪(?!方式|資|资|酬|水|作業|作业|人員|人员)`); bare 核薪 left the description line gate; a description line whose only wording is bare 核薪 is read only when it starts with a pay label (bullets and list numbers allowed in front). The five sentences are in `salary.test.ts` as null (plus two more, in three markets), with a `twCardMeta` case for a duties-only description and an end-to-end `ats_public` posting. **Two differences from the proposed fix:** (i) the gate gained the full phrase `依學經歷…核薪`, not bare `依學經歷`: with the bare form in the gate, "依學經歷分派職務" on a line with no pay word would open a pay line; (ii) I found the same fault for bare `依學經歷` on a line that has a pay word about something else ("熟悉薪資作業，依學經歷分派職務" stored `依學經歷`) and closed it: the form counts on a labelled line or when its own clause names pay.
4. **Medium: the clause on its own line or sentence of a description was stored as NT$40,000 a month — fixed at the root.** (1) The statute's own clause is "pay not listed" inside `parseSalaryText`, so no caller needs a special case and a clause-only line is never a pay clause. (2) `payFromDescription` reads in two passes, so the clause is stripped from the other lines whichever comes first (the proposal covered "following lines"; the reverse order is covered too). The three texts, and five more, are in the "never stores the clause" test. See "Differs" 1 under item 2.
5. **Medium: the widened digit form dropped a real minimum in another currency, per year, or on a non-Taiwan row — fixed as proposed.** A match that follows another currency or a non-monthly period is not the clause (`TW_FLOOR_OTHER_PAY_BEFORE_SOURCE`, mirrored in the hook so the card keeps those words); the bare form is the clause only on Taiwan rows and unknown-country international rows. The three texts keep their figures (HK$40,000 a month; USD 60,000 a year; HK$50,000), with ten more that keep theirs and three that are still the clause. `台幣 / 臺幣 / TWD` joined the Taiwan-dollar markers so "月薪台幣5萬以上" is read as marked, not bare.
6. **Low: GoApply's User-Agent carried the shared contact — fixed.** `brandOwnEnv(brand, 'JOB_SOURCES_CONTACT', env)`: GoApply reads `CN_JOB_SOURCES_CONTACT` only, RoboApply `JOB_SOURCES_CONTACT` only, each falls back to its own site. I chose the strict read over "`brandEnv`, then prefer the own origin": the result is the same and it is one call. One existing test line changed its expectation on purpose (`sourceUserAgent('cn', { JOB_SOURCES_CONTACT })` no longer carries that value); a new test covers both directions, blank values and header cleaning. MKT-1G is asked to list the variable; R5 offers the registry line.
7. **Low: `serializeProviderQuota` keyed a map by the snapshot's field — fixed as proposed.** The map key is the provider; a test with `activejobs` and `activejobs:cn` holding the same `provider` field expects two entries and a stable round trip.
8. **Unowned edit, `normalize/rules.test.ts` (one assertion) — kept, not reverted.** The bundles file's ownership note says "tests colocated with owned files are yours"; this is the colocated test of `source.ts`, which I own, no M1 bundle owns it, and the reviewer judged it acceptable. The new value follows directly from item 3's `applicantCountAllowed: false` entries. Reverting it would leave the full suite red with nobody in M1 to fix it. If the orchestrator reads the rule differently: `git checkout -- server/src/features/jobs/normalize/rules.test.ts`, and the test "never allows applicant counts from linkedin or jsearch" must then expect `['linkedin', 'jsearch', 'tw_open_data', 'tw_gov_jobs', 'usajobs']`.
9. **Found during this pass, not in the review, not fixed:** `currencyFromText` reads `US$` as SGD and `CA$` as AUD (pre-existing; my diff does not touch the function). Exact fix under Requests, MKT-3C (a).
