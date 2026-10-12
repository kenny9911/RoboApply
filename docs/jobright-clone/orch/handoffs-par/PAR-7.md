# PAR-7

GoApply job sources and ingest, after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-7`, branch `wp/PAR-7`. Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser, no database read or write. All eight items are done and all twelve review findings are resolved (list at the end). Every test in files PAR-7 owns is green (29 files, 1,174 tests), both typechecks pass for the whole repository, `npm run check` passes. All 72 changed files are inside PAR-7's owns (checked against `parity-bundles.json`); the review found no unowned edit and this pass made none.

One thing was run against the network in the first pass, because item 4 asks for it: a one-off, read-only script (kept outside the repository, no `.env` loaded, no key sent) read the 27 candidate boards through the connectors' public listing APIs. Result under item 4. Nothing was run against the network in the review pass.

**What the orchestrator should know before merging**

1. With neither `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` nor `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` set, the first `jobs-ingest` after the merge archives every open bank row on both brands as `no_apply_target` (about 70 RoboHire rows on RoboApply in the dev database). This is item 3 as written. They come back on the first sync after a template is set.
2. With a template set, the first bank sync on the database or syndication transport starts from the beginning once (the stored cursor carries no mark, or another one), so every stored row is rewritten with the real posting-page link. One full re-read of the bank, in pages.
3. The first `jobs-ingest` for RoboApply also archives (as `source_removed`) any mainland-China posting an international board had stored in RoboApply's index: such a posting now belongs to market `cn` (item 4).
4. The first `jobs-plan` per brand switches off the ingest queries of providers the brand does not run (every `linkedin` query on RoboApply; any `jsearch` query of market `cn`). The cron result reports them as `retired`.
5. **14 employer boards now belong to market `cn`** (list under item 4). `RACareerSiteSource` is unique on (ats, boardToken), so a RoboApply admin can no longer add them: the API answers 409 with `details.reason = "board_on_other_site"`. RoboApply's own panel still prints "This job board is already in the list." until PAR-8 reads that reason (request below). The 12 measured boards with fewer than 10 mainland postings are NOT registered and stay free for either site.
6. `POST /v2/discover/run` (legacy cross-bank search) now sweeps only the bank of the request brand (RoboApply: RoboHire; GoApply: GoHire) and archives nothing.
7. `__tests__/shell/noDeadEnds.test.tsx` (PAR-8) turns red from my change: the admin "sources" area is now on both brands.
8. GoApply's board ingest starts only after `jobs-plan` has run once for GoApply (it registers the seed boards and creates the standing query).

**Where this bundle deviates from the documents (PRECEDENCE rule), each for the reason given**

- Test postings (item 2): MARKET_STRATEGY §1.4 and the item say "titles containing 测试". Implemented: a title that is nothing but 测试 / test / demo and filler. The documented wording hides real jobs. Owner decision asked.
- Seed boards (item 4): the plan's table lists 27 measured candidates; 26 passed the connector check and 14 are registered (at least 10 mainland postings each). Reason: one reading market per board in this wave.
- Monthly pay threshold (item 5): the plan only requires "1.5-2.5万" to be monthly. A figure with no period is read as monthly only while its top is under 50,000 CNY. Owner decision asked.

## Items

### 1. [P0] Per-brand job source registry: done

- New `server/src/features/jobs/sources/registry.ts`: `sourceProvidersForBrand(brand, env)` (the one list: `brand.jobProviders` plus adapters registered for the market, narrowed by `JOB_PROVIDERS_<BRAND>`), `jobSourcesForBrand(brand, env)` returning `{ brand, market, provider, kind: bank | search | ats | import, transport, sourceBoards, adapter, enabled(), status() }`, `jobSourceKind`, `jobProvidersEnvName`. Re-exported from `sources/index.ts`.
- `ingest/providers.ts`: `ingestProvidersForBrand` = the registry list without `user_import`; `adaptersForBrand` = the registry's adapters; new `sourcesForBrand` for the admin panel. The `cnExternalProviders` branch and `config.ts` `cnExternalProviders` are deleted; `CN_EXTERNAL_PROVIDERS` is ignored with one warning.
- `JOB_PROVIDERS_<BRAND>`: comma list, subset only. A name the brand does not have is ignored with one warning, so JSearch cannot be added to GoApply this way. `user_import` is never narrowed. A value that names nothing valid leaves the brand with no ingest source (fail closed).
- `adapters/rapidApi.ts`: every RapidAPI adapter is `markets: ['intl']` (JSearch used to list `cn`).
- The `linkedin` RapidAPI adapter is no longer registered by ingest, and its default daily budget is removed.
- **Review fix (finding 7).** `planner.ts` `retireUnrunProviders(db, market, adapters)`: each `jobs-plan` run switches off the market's enabled queries whose provider is not among the brand's adapters for that market, whatever their origin (seed queries were never retired before). `ensureBankSyncQueries` switches a standing bank or board query back on, and makes it due, when its provider returns; search queries are switched on again by the plan's own upsert. `PlannerResult.retired` reports the count. So a `linkedin` row no longer stays due for ever and the System panel's due and overdue counts are real.
- `cron/handlers.ts`: confirmed, no change. `jobs-plan`, `jobs-ingest`, `jobs-maintain`, `score-precompute` and `job-alerts` are `brandCronJob`s with no market restriction; `vercel.json` already lists all five.

ACCEPT, tested: `adaptersForBrand(goapply)` is `bank_gohire`, `ats_public`, never `jsearch`, whatever `CN_EXTERNAL_PROVIDERS` says; RoboApply's list is `activejobs`, `bank_robohire`, `jsearch`, `ats_public` in that order; `jobs-ingest` for GoApply answers `no_work` (not `no_providers`) once the bank or the boards are on; `JOB_PROVIDERS_GOAPPLY=bank_gohire` narrows it.

Tests: `ingest/adapters/adapters.test.ts`, `ingest/cron.test.ts`, `ingest/planner.test.ts` (2 new: the retire statement, its values per market, the order inside a plan run, the revive statement), `raJobProviders.test.ts`.

**`linkedin` literal (P7-3): it cannot be dropped from the `JobProvider` union yet.** Code that still names it: `features/jobs/normalize/source.ts` (`PROVIDER_META.linkedin`; existing `sourceBoard = 'linkedin'` rows are read through it), `normalize/adapters.ts`, `sources/registry.ts`, `roboapply/v2/lib/raExternalJobTypes.ts`, `raFantasticJobs.ts`, `raJobProviders.ts` (the legacy live fan-out still holds a LinkedIn provider behind `RA_ONBOARDING_LINKEDIN_JOBS_DISABLED`; removing it is market wave JI-2), and outside PAR-7: `features/jobs/detail/view.ts:159`, `features/jobs/companies/service.ts:311`, `features/seo/scope.ts:27`, `job-search/validation.ts:4`, `job-search/agent.ts:58,68`. The ingest path itself no longer uses it.

### 2. [P0] GoHire bank over HTTPS: done

- `raBankClients.ts`: `bankTransport(bank, env)` = `GOHIRE_BANK_TRANSPORT` (db | api | off) when set, else `db` when the URL satisfies the TLS rule, else `api` when `GOHIRE_API_KEY` is set, else `off`. A requested transport that cannot be honoured is `off`. `bankApiConfig` (HTTPS only), `bankDisabledReason`, `bankReadsMirror`, `getMirrorClient`. `bankTlsSatisfied` is unchanged. `getBankClient` returns null unless the transport is `db`, so no plaintext pool is ever opened.
- `ingest/adapters/bank.ts`, three transports behind one adapter:
  - `db`: the same reader; its cursor now carries a mark (item 3).
  - `api`: `readBankPageViaApi` calls `GET <GOHIRE_API_BASE>/api/v1/jobs?status=open&sortBy=aging&limit=50&page=N` with `X-API-Key`. 20 s timeout per request, `redirect: 'error'`, at most 40 pages per pass. A pass stops at the first row whose `publishedAt` is null. Its cursor is its own: `api|<pass start ISO>|<next page>`.
  - `syndication` (when `GOHIRE_SYNDICATION_URL` is set): the database cursor over HTTPS.
- **Review fix (finding 10).** The pass no longer has only its own 100 s. `SourceFetchContext.budgetMs` (new, `sources/types.ts`) carries what is left of the ingest tick less its reserve; `runIngestTick` sets it per query, `runIngestQuery` hands it to the source. The list pass uses `min(100 s, budgetMs)`, shortens a request's timeout to what is left, and treats a later page that runs out of that time as a pass cut short (rows kept, resumed at that page), not as a failed pass. The employer-board adapter stops before starting another board once the budget is spent.
- Whitelist: `pickBankSyncRow` copies only the `BANK_SYNC_SELECT` fields (which include `education` and `headcount`), type-checked. Errors are short codes (`http_502`, `timeout`, `not_json`, `unexpected_shape`, `network`), never a body, a URL or the key.
- Closure: after a pass that read from page 1 to its end, the adapter returns `listing: { externalIds }` and `pipeline.ts` archives the open public `gohire` rows of market `cn` that are not in it (`bank_closed`). A failed pass writes nothing; a pass cut short returns no listing.
- Skip tallies (`SourceFetchResult.notes`): `bank_synced`, `bank_unpublished`, `bank_no_company`, `bank_test_posting`, `bank_no_public_page`, `bank_closed`, `bank_page_cap`, `bank_pass_cut_short`.
- 代招: a GoHire row is an agency posting (`RAJob.isAgency = true`) unless the bank states the employer is verified. The employer's `RACompany` record is not marked as an agency.
- `raBankProviders.ts`: `searchBank` reads the synced RAJob mirror when the bank is on the api transport. `RACrossBankSearchService` looks the mirrored rows' ids up instead of upserting them.
- **Review fix (finding 2).** `RACrossBankSearchService.run`: `archiveStaleMirrors` and its call are deleted (it archived every bank row older than 45 days on every run, for both markets, with no close reason, so the ingest upsert could never revive it). A run now takes `listEnabledBanks().filter((b) => bankMarket(b) === getCurrentBrandOrDefault().market)`.
- **Review fix (finding 6), and the deviation.** `isBankTestPosting` is inverted: a test posting is a title that contains 测试 / test / demo and, once those words and filler (岗位, 职位, 数据, 内部, 请勿投递, job, position, please ignore, digits, punctuation) are removed, has nothing left. The whitelist of QA role names is gone. 电池测试技术员, 测试技术员, 产品测试, 测试运维工程师, 半导体测试设备工程师, 晶圆测试操作员, 射频测试, QA测试 are jobs; 测试, 测试岗位请勿投递, 内部测试职位, 测试数据-01, "test 123", "Demo 2", "TEST JOB - please ignore" are test postings. An English word is matched whole ("Latest Demo Engineer" is a job).

ACCEPT, tested: with a non-TLS database URL and an API key the adapter is enabled with transport `api` and opens no database pool; a pass reads only the published pages; a row carrying `notes`, `evaluationRules`, `aiInsights`, `clientKey`, `organizationId` never appears in a job, a note or an error; a row missing from a complete pass is archived `bank_closed`; a failed pass archives nothing; a stub syndication server upserts a row and a tombstone archives one; the database path keeps its tests.

Tests: `adapters.test.ts` (whitelist, stop at the first unpublished row, page cap, tallies, timeout, listing rules, tombstone, transports; new: the 8 review titles kept, the caller's budget stops the pass, a budget timeout on a later page is a cut-short pass), `pipeline.test.ts` (listing diff, statuses; new: the tick hands the remaining budget to the source), `raBankProviders.test.ts`, `RACrossBankSearchService.test.ts` (rewritten: a RoboApply run calls `searchBank('robohire')` only, a GoApply run `gohire` only, a brand whose bank is off sweeps nothing, a run on a 400-day-old open row calls no `updateMany` and writes no `archivedAt`).

**The syndication contract I assumed (the endpoint does not exist yet; JC-3, second repository).** `GET <GOHIRE_SYNDICATION_URL>?cursor=<updatedAt ISO>|<id>&limit=<n>` with `X-API-Key: <GOHIRE_API_KEY>`, answering `{ "data": [row…] }` ordered by `(updatedAt, id)`, rows after the cursor. A row is the `BANK_SYNC_SELECT` columns, optionally `company { id, name, logoUrl, website, industry, size, headcount, founded, employerVerified }`, `employerVerified`, `syndicationConsentAt`. A tombstone is a row with `deleted: true`, `tombstone: true` or `deletedAt`. The endpoint is sent the position only, never our cursor mark.

### 3. [P0] A bank row is listed only when its bank has a posting page: done

- `raCrossBankMatch.ts`: `bankPublicJobUrl(bank, id, env)`, `bankPublicJobUrlTemplate`, `bankPublicJobUrlProblems`, `BANK_PUBLIC_JOB_URL_TEMPLATE_ENV`. No default. A template must be https and contain `{id}`. `synthesizeApplyUrl` returns `string | null`. The old `…_PUBLIC_JOB_BASE_URL` variables are ignored, with one warning each.
- Bank adapter: with no template a listable row is not emitted. It is counted (`bank_no_public_page`) and its id is returned in `closures` with the `SourceCloseReason` `'no_apply_target'`. On the database and syndication transports the adapter also reports an empty listing with that reason, so rows stored before this rule leave the feed too.
- **Review fix (finding 5).** The cursor of the database and syndication transports is versioned: `<ISO>|<id>|<mark>`, where the mark is `nopage` or `page:<8 hex of the template's SHA-256>` (`bankPageMark`, `bankCursorMark`). With a template set, only a cursor carrying that template's mark is continued. A cursor with no mark (written before this rule), a `nopage` mark or another template's mark restarts from the beginning once. So rows stored earlier with `https://www.robohire.io/jobs/<id>` are rewritten even when the template is already set at the first sync after the merge, and a changed template rewrites every link too. With no template an unmarked cursor is continued and marked `nopage`.
- `upsert.ts`: the revive list is `source_removed`, `bank_closed`, `no_apply_target`.
- `mapRecruiterJobToRAJobUpsert` returns `null` for a candidate with no apply URL; `RACrossBankSearchService` skips it before scoring.
- One code path for both banks, so RoboApply's RoboHire rows are held as well (the deliberate P7 exception).

ACCEPT, tested: with neither template set no bank row is written on either brand and the open ones are archived `no_apply_target`; with `GOHIRE_PUBLIC_JOB_URL_TEMPLATE=https://example.test/p/{id}` the row is written with that apply URL; the upsert SQL revives `no_apply_target`; a row with no apply URL is never written in either market. `apply.target gohire` is PAR-11's contract field; PAR-7 provides `fromRecruiterBank = true`, `sourceBoard = 'gohire'`, `sourceName = 'GoHire'` and the apply URL for it.

Tests: `raCrossBankMatch.test.ts`, `adapters.test.ts` (new: an unmarked cursor with a template set restarts once and the two rows come back with the template's link, then the marked cursor is continued; a changed template restarts once; with no template an unmarked cursor is continued; the three mark forms), `pipeline.test.ts`, `legacySeams.test.ts`, `upsert.test.ts`.

### 4. [P0] Employer boards for mainland postings: done

- `normalize/normalizeProviderJob.ts`: for provider `ats_public` the job's market is its own resolved primary location (mainland China → `cn`, anything else → `intl`), whatever market reads the board. Exported as `marketOfPosting(input)`. A board's country tag alone never makes a posting mainland. Every other provider keeps the caller's market.
- **Review fix (finding 3).** Hong Kong, Macau and Taiwan are decided from the resolved place, not only from those three words. A posting is not mainland when: its text or city names one of them (as before); the provider's region field or the resolved region is HK / MO / TW or names one; and, when neither a mainland city nor a mainland province was resolved, the place it names is a Hong Kong, Macau or Taiwan city in the city table (looked up again without the country) or one of their well-known districts and cities (Kowloon, New Territories, Wan Chai, Tsim Sha Tsui, Kwun Tong, Causeway Bay, Sha Tin, Tsuen Wan, Cotai, Taipa, Hsinchu, Zhubei, Taichung, Tainan, Kaohsiung, Taoyuan and their Chinese names). 重庆市九龙坡区 and "Taoyuan, Hunan, China" stay mainland because a mainland city or province was resolved.
- `connectors.ts`: `ReadOptions.market`. Each connector filters the listing with `marketOfPosting` BEFORE `prioritise` and the caps, and reports `wrongMarket` and `pending`. SmartRecruiters adds `country=cn` for a cn source and pages to the end (`MAX_LISTED_PER_BOARD_CN = 3000`); a cn Lever source pages past the 500 input cap too.
- `adapter.ts`: `markets: ['intl', 'cn']`; a run reads the sources of its own market; `notes` carry `wrong_market`, `boards_read`, `board_errors`, `board_backlog`.
- **Review fix (finding 8).** `lastSyncedAt` is always the time of the read (both board managers print it as "Last checked"). The backlog is the adapter's own state: the standing query's cursor holds `backlog:<sourceId>,<sourceId>`; `dueCareerSources(…, { backlogIds })` adds those boards once they were read more than 30 minutes ago, after the never-read and the 6-hour-stale ones. A board leaves the list when a read leaves nothing unread, or when it is removed or switched off. **Market `cn` only.** An international board over the per-run cap is not remembered and keeps the 6-hour interval, so the sentence "international sources keep today's request volume" now holds for the read interval. The earlier handoff's version of that sentence was wrong: the first pass re-read such a board every 30 minutes.
- `sync.ts`: the listing diff compares our open rows of the board in the source's market.
- `service.ts`, `routes.ts`, `contract.ts`: the `intlOnly` gate is gone. Every operation is scoped to the request brand's market: a GoApply admin lists, adds, checks, turns off and removes cn boards; a board of the other brand is never listed and answers 404. `body.market` is optional and may only name the brand's own market.
- **Review fix (finding 11).** A create that hits the unique rule now looks at who has the board. When it is the other site: 409 `conflict`, message "This job board is already read for the other site, so it cannot be added here.", `details: { field: 'boardToken', reason: 'board_on_other_site' }`. When it is this site's own list: the plain duplicate, no reason. GoApply's panel shows a separate sentence for each.
- `hooks.ts`: `sourceName = company + job board` applies to `ats_public` rows of both markets.
- `seeds.cn.json` and `seeds.ts` (`ensureSeedCareerSources`), called from `jobs-plan`: registers boards once per seed version with market `cn` and `countryCode: 'CN'`, leaves a board an admin already has untouched, never re-adds a removed board (state in `AppConfig` key `jobs.atsPublic.seed:cn`).
- **Review fix (finding 11), seed threshold.** `SEED_MIN_MAINLAND_POSTINGS = 10`, `seedBoardsToRegister(file)`. The file keeps all 26 measured boards; only those measured with at least 10 mainland postings are registered. A board below the threshold is not remembered as offered either, so a later seed version can still register it once a board can feed both sites.

**Seed verification (2026-10-11, through the connectors, listing only, market cn).** 26 of the 27 candidates answered 200 with at least one posting that resolves to mainland China: 1,818 postings.

Registered for market `cn` (14 boards, 1,779 postings, 98% of what was measured). **These are the boards RoboApply gives up until `RACareerSiteSource.countries` exists:**

| Board | Mainland | | Board | Mainland |
|---|---|---|---|---|
| smartrecruiters BoschGroup | 1,317 | | smartrecruiters Continental | 24 |
| smartrecruiters AbbVie | 149 | | smartrecruiters NielsenIQ | 20 |
| lever veeva | 54 | | greenhouse payoneer | 19 |
| smartrecruiters WesternDigital | 45 | | smartrecruiters Wabtec | 16 |
| greenhouse riotgames | 39 | | greenhouse coupang | 13 |
| ashby airwallex | 35 | | smartrecruiters Ubisoft2 | 13 |
| greenhouse flexport | 25 | | smartrecruiters Eurofins | 10 |

Measured, kept in the file, NOT registered (12 boards, 39 postings; either site's admin may add them by hand): greenhouse scopely 7, smartrecruiters Canva 6, greenhouse mongodb 5, greenhouse agoda 5, greenhouse adyen 3, greenhouse moloco 2, greenhouse applovin 2, greenhouse airbnb 2, greenhouse databricks 2, greenhouse epicgames 2, lever weride 2, greenhouse appier 1.

- **Failed candidate: lever `animocabrands`, 0.** Its three "China" postings list China, Hong Kong and Singapore together and resolve to Hong Kong as the primary location. Not in the file.
- Differences from the plan's text-match counts: BoschGroup 1,317 (not 1,322: five Hong Kong postings), airwallex 35 (not 37: two postings whose primary location is Singapore).
- Company names: Greenhouse and SmartRecruiters names are the board's own metadata. **Lever and Ashby publish no company name, so `veeva` and `airwallex` are registered with the board token as the name** (`nameSource: board_token`). An admin can correct them with `PATCH /career-sources/:id`; the GoApply console has no rename control yet (Known gaps).

ACCEPT, tested: a Greenhouse 上海 posting from a cn source lands in market cn with the employer's own apply URL; a Singapore posting from the same source is counted `wrong_market`; a 上海 posting read through an intl source is not handed on and the normalizer would mark it `cn` anyway; a fixture board of 800 postings with 5 mainland ones stores all 5 in one run; a SmartRecruiters cn source sends `country=cn` on all 14 listing calls and reports a complete listing of 1,322 with 100 texts read. The "at least 300 rows across 10 boards on the dev stack" line is for the orchestrator after the merge. By the measured counts and the per-run caps (100 posting texts per SmartRecruiters board) the first pass over the 14 boards can store up to about 510 rows; BoschGroup and AbbVie fill in over the following 30-minute runs (BoschGroup in about 7 hours).

Tests: `atsPublic.test.ts` (market rule, filter before the cap, Lever paging, SmartRecruiters country filter; new: `lastSyncedAt` is the read time, the backlog cursor on cn and its absence on intl, the seed threshold and the later-version case), `routes.test.ts` (both brands, isolation by market; new: the two 409 answers), `normalizeProviderJob.test.ts` (new: 16 Hong Kong, Macau and Taiwan places are `intl`, 6 mainland places stay `cn`), `pipeline.test.ts`.

### 5. [P1] Mainland normalisation: done

- `normalize/level.ts`: `educationFromText` returning the level and the quote; `educationFromLabel` for the bank field. 劳务 added to the contract labels.
- **Review fix (finding 1), the text rule.** Three forms, read in this order: a stated minimum ("本科及以上", kept as it was); a labelled level ("学历：本科", "学历要求硕士"); and a bare level ("本科学历", "统招本科", "博士学位"). A bare level counts only where the posting states a requirement: its own clause (up to 。；; or a line end) contains 要求 / 任职 / 资格 / 必须 / 需 / 须 / 具备, or the nearest section label above it, within 400 characters, is a requirement heading ("任职要求：", "【任职资格】", "任职资格" on its own line). A clause that opens with another label ("公司简介：…") is decided by that label. The "毕业" form is removed. The three review sentences return null, and so do "博士学位，机器学习方向" with nothing that says it is required, a level under "福利待遇：" and one under "加分项：".
- **Review fix (finding 1), the write.** `ingest/upsert.ts`: the prefetch reads `("enrichedAt" IS NOT NULL AND "educationLevel" IS NOT NULL) AS "enrichedEducation"`; `toUpsertRow(job, companyId, id, { keepStoredEducation })` sends NULL for a level that comes only from the posting text when the stored row is enriched and holds a level, so the statement's `COALESCE` keeps enrichment's value. A provider's own label (the bank's education field) always replaces it. The text rule still fills a new row and a row enrichment has not reached. One rule, in `processJobs`.
- `normalizeProviderJob.ts`: `educationLevel`, `fieldSources.educationLevel`, `educationEvidence`, `headcount`.
- `bank.ts` / `normalize/adapters.ts`: `education` and `headcount` selected and mapped.
- `salary.ts`, **review fix (finding 4).** `MAINLAND_MONTHLY_BELOW = 50,000`: a mainland K / 千 / 万 figure with no stated period is monthly only while its top is under 50,000 CNY ("1.5-2.5万" → 15,000-25,000 a month; "3-4.9万" a month). "5-8万", "6万-9万", "8-10万", "3-5万", "30-50K" and "30-50万" keep no period and are shown as posted. A stated period always decides ("5-8万/月", "年薪5-8万"). A mainland row's K / 千 / 万 figure that names no currency is CNY with or without Chinese words, so "15-25K" with market `cn` or country CN is 15,000-25,000 CNY a month; a currency the text names wins ("USD 15-25K"). A bare number with no unit, currency or period is never comparable pay.
- Chinese employment labels map through the one function in `level.ts` from `raCrossBankMatch.normalizeEmploymentType` and `raRapidApiJobs.mapEmployment` too.

ACCEPT, tested: 本科, bachelor, associate map; 本科及以上 gives bachelor with its quote; 全职 gives full_time; "1.5-2.5万" gives 15,000-25,000 CNY a month.

Tests: `level.test.ts` (5 new positive forms, 2 rewritten to state the requirement, 8 new negative sentences), `salary.test.ts` (new: 5 figures at or above the boundary, the boundary itself, the stated-period cases, bare "15-25K"), `normalizeProviderJob.test.ts`, `raRapidApiJobs.test.ts`, `adapters.test.ts`, `upsert.test.ts` and `pipeline.test.ts` (new: an enriched row's level is kept, a provider label replaces it, a plain row and a new row are filled, the prefetch column).

### 6. [P1] Bank rows are written to their bank's market: done

The materialiser uses the one rule `bankMarket(bank)` (in `raCrossBankMatch.ts`, re-exported by `raBankClients.ts`) on create and update for both banks. The same function now decides which bank a cross-bank run sweeps (finding 2). Tests in `raCrossBankMatch.test.ts`, `RACrossBankSearchService.test.ts` and `legacySeams.test.ts`. No routing of RoboHire mainland jobs and no data fix.

### 7. [P1] The admin console shows each brand its own sources: done

- Server: `features/admin/contract.ts` `BrandHealth.sources: JobSourceView[]`. `features/admin/system.ts` `jobSourcesHealth` builds it from the registry plus three `SystemStore` reads.
- Counters: `ingest/status.ts`. After each ingest tick one JSON document per (market, provider) is stored in `AppConfig` (`jobs.source.status:<market>:<provider>`): `last` and `counted`. A failed status write never fails ingest.
- **Review fix (finding 9).** The status keeps only the 17 reasons of `SOURCE_STATUS_NOTES` (a source's own counts and the reasons a posting was left out). The normalizer's informational notes (`salary_currency_from_search_country`, `apply_url_linkedin_host`, `linkedin_logo_dropped`, `linkedin_publisher_dropped`, `applicant_count_dropped`) stay in the run's log tally only. A document stored earlier is cleaned on read. The panel has a sentence for each of the 17 (four added: no title or employer name, a user's private row left as it is, could not be read, no posting ID) and prints nothing else; the `{reason}: {count}` line is removed.
- `RAAdminOperationsService.ts`: no change (it holds nothing about job sources).
- Web: `components/v3/admin/SourcesConsole.tsx` (`JobSourcesPanel`, `CareerBoardsPanel`, `SourcesConsole`). `AdminNav` shows "sources" on both brands. `/admin/sources` on GoApply: the sources panel and a board manager. On RoboApply: its existing `CareerSourcesPanel` unchanged, followed by the shared sources panel. The shared panel is also shown per brand in System › Health.
- **Review fix (finding 9).** The board list says "Loading…" while it loads (it said "Not checked yet"). On RoboApply the shared panel is rendered for an admin only, after the sign-in state is known, so a visitor who is not an admin sees one not-authorized block (the panel's own) and one loading line, and the System status is not requested for them.
- Not checked in a browser (the rules forbid it). Built with the console's existing tokens and classes.

ACCEPT, tested by component tests: a GoApply admin sees the GoHire bank with "Read over a secure web connection", "Open but not published by the recruiter: 1,092", the note that its jobs are saved but not shown with `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` named, the boards with their counters, and can add a board (`market: 'cn'`).

Tests: `features/admin/__tests__/services.test.ts`, `components/v3/admin/__tests__/sources.test.tsx` (17 tests; new or rewritten: no raw code is printed and every tally key has copy, the two RoboApply gate cases, the loading line, the two conflict sentences), `console.test.tsx`, `pipeline.test.ts` (new: only the known reasons are stored; an old document is cleaned on read).

### 8. [P0] Proof that GoApply returns real jobs: done (the run is the orchestrator's)

`server/src/features/jobs/ingest/verifyFeed.ts`:

```
npx tsx server/src/features/jobs/ingest/verifyFeed.ts --brand goapply [--json] [--check]
```

Four `SELECT`s over `RAJob` for the brand's market plus a read of the stored source statuses. It calls no provider and writes nothing. It prints rows by provider, source board, visibility, state and last-seen bucket; rows with and without an apply URL; rows without a provider id; open public rows per employer board with the hosts their apply links point at; each source's last run; five samples per source.

**Review fix (finding 12).** The acceptance now checks what the ACCEPT line names. For GoApply: at least 300 open public board rows; at least 10 boards; 0 rows without a provider id; 0 open public rows without an apply URL; **0 open public board rows without a source name** (new counter in the counts query); **0 open public board rows whose apply link has no host** (new query `buildBoardHostsSql`: rows per board and apply host; only the host is read from a link); 0 JSearch rows. A link on a host that is not one of the four job-board systems' is printed per board with "(not a job-board host)" and a total, for a person to confirm it is the employer's own site; it does not fail the check, because the script cannot know an employer's domain. An unknown `--brand` value prints an error and exits 1 (`reportBrand`); it used to become goapply.

Tests: `verifyFeed.test.ts` (15): each query is one `SELECT` scoped to the market that selects no description, owner or contact column; the assembly; the acceptance with the two new checks; the brand argument.

### PAR-1 requests and carry-over

- P7-1, P7-2: followed. P7-3: answered under item 1.
- `waveFIX-carryover.md`, section PAR-7: none of the seven entries is in a file PAR-7 owns after the split (`RAInsightService.ts`, `tracker/contract.ts`, `MatchService`, `jobs/detail/view.ts`, `feed/sql.ts`, `agent/service.ts`, `cn/jobs/`). Nothing done, nothing rejected; they belong to PAR-11 or to fix WPs.

## Files changed

63 modified, 9 new, all inside PAR-7's owns.

- New: `server/src/features/jobs/sources/registry.ts`, `sources/atsPublic/seeds.ts`, `sources/atsPublic/seeds.cn.json`, `ingest/status.ts`, `ingest/verifyFeed.ts`, `ingest/verifyFeed.test.ts`, `components/v3/admin/SourcesConsole.tsx`, `components/v3/admin/__tests__/sources.test.tsx`, `i18n/staging/admin.zh.json`.
- `server/src/features/jobs/sources/`: `types.ts`, `index.ts`, `atsPublic/{adapter,connectors,contract,hooks,index,routes,service,shared,sync}.ts`, `atsPublic/{atsPublic,routes}.test.ts`.
- `server/src/features/jobs/ingest/`: `adapters/{bank,rapidApi}.ts`, `adapters/adapters.test.ts`, `config.ts`, `cron.ts`, `db.ts`, `index.ts`, `pipeline.ts`, `planner.ts`, `planner.test.ts`, `providers.ts`, `run.ts`, `smoke.ts`, `upsert.ts`, tests and the upsert SQL snapshot.
- `server/src/features/jobs/normalize/`: `adapters.ts`, `index.ts`, `level.ts`, `normalizeProviderJob.ts`, `salary.ts`, `types.ts`, tests.
- `server/src/features/admin/`: `contract.ts`, `system.ts`, `__tests__/{fakes,services.test}.ts`.
- `server/src/roboapply/v2/lib/`: `raBankClients.ts`, `raBankProviders.ts`, `raCrossBankMatch.ts`, `raRapidApiJobs.ts`, their tests; `services/RACrossBankSearchService.ts` and its test.
- Web: `components/v3/admin/{AdminNav,SystemConsole,index}.tsx|ts`, `console.module.css`, `__tests__/console.test.tsx`, `app/(auth)/admin/sources/page.tsx`, `lib/api/admin.ts`, `lib/api/careerSources.ts` (comment), `i18n/staging/admin.en.json`.

Touched in the review pass: `normalize/{level,normalizeProviderJob,salary}.ts`, `ingest/{upsert,pipeline,planner,run,status,verifyFeed}.ts`, `ingest/adapters/bank.ts`, `sources/types.ts`, `sources/atsPublic/{adapter,sync,seeds,service}.ts`, `seeds.cn.json` (the method text), `RACrossBankSearchService.ts`, `components/v3/admin/SourcesConsole.tsx`, the two staging files, and the tests of each.

Not changed: `server/src/cron/`, `vercel.json`, `__tests__/deploy/cronParity.test.ts`, `RAAdminOperationsService.ts`, `hooks/useAdmin*.ts`, `lib/api/adminOperations.ts`.

## Tests run

All after the last edit of the review pass.

| Command | Result |
|---|---|
| Owned files (`npx vitest run` over the ingest, normalize, sources, admin, cron directories, the seven `roboapply/v2` test files, `cronParity.test.ts`, `components/v3/admin`) | 29 files, 1,174 passed, 6 todo, 0 failed (1,108 before the review pass) |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `node scripts/i18n-merge-staging.mjs --dry-run` | valid; the `admin.console.sources.*` keys are listed as new |
| `npx vitest run --exclude ".claude/**"` | 624 files, 13,047 tests: 12,945 passed, 91 failed in 42 files, 1 skipped, 10 todo. No failing file is in PAR-7's owns |

## Red tests for other bundles

One, caused by PAR-7:

- **PAR-8**, `__tests__/shell/noDeadEnds.test.tsx` › "each brand's admin sees only its own areas…": `adminAreasFor('goapply')` now includes `sources` after `coaches` (`['overview','system','reports','inviteRewards','credits','announcements','questions','coaches','sources','campus','fraud','invites']`).

The review pass turned no further test red: the full suite fails in the same 42 files with the same 91 tests as before it.

## Pre-existing failures

90 tests in 41 files. Every one of the 41 files is named in PAR-1's "Red tests for other bundles" list (checked by script against that handoff; the only failing file not in it is `noDeadEnds.test.tsx` above). By owning bundle: PAR-11 16 files, PAR-2 10, PAR-3 5, PAR-4 3, PAR-5 3, PAR-8 3, PAR-9 1. I read the failure text of the ones nearest to this bundle (`jobs/enrich/*`, `feed/marketStats`, `feed/seams`, `feed/routes`, `offers/postedRange`, `jobs/detail/detail`, `match/*`, `resume/tailor/store`, `tracker/reminders`): each asserts the old recruitment-info default or the old `brandEnv` behaviour. The five tests that were PAR-7's by file ownership are green. I did not run the full suite before my first edit, so "already red" rests on that match and on the failure texts, not on a before-and-after run.

## Requests

**PAR-8**
- Update `noDeadEnds.test.tsx` as above.
- `components/features/market/tw/CareerSourcesPanel.tsx:85`: a create that answers 409 with `details.reason === 'board_on_other_site'` (`apiErrorReason(err)` from `lib/api/contracts/wire`) should show a sentence like GoApply's `admin.console.sources.boards.errors.otherSite` ("This board is already read for the other site, so it cannot be added here. A board is read for one site at a time.") in place of `errors.duplicate`. Until then a RoboApply admin who adds one of the 14 seeded boards reads "already in the list" about a board that is not in their list.
- The same panel hard-codes `market: 'intl'` in its list call. Give it a `market` prop (default the brand's market) so GoApply can use the same panel, then `CareerBoardsPanel` in `components/v3/admin/SourcesConsole.tsx` can be deleted. Until then there are two board managers.

**PAR-11**
- Board rows of market `cn` are written with `fromRecruiterBank = false`, `sourceBoard` = the job-board system (`greenhouse`, `lever`, `ashby`, `smartrecruiters`), `sourceName` = "`<company> · <system>`", `originalSourceName` null, `sourceUrl` and `applyUrl` on the employer's board, `lastSeenAt`. Use `via: 'ats'` for those boards and `via: 'bank'` for `sourceBoard = 'gohire'`.
- `RAJob.isAgency = true` marks every GoHire row whose employer the bank has not verified (代招). The 企业直招 rule in `cn/jobs/card.ts:77` already reads it correctly. The feed's "exclude agencies" filter (`feed/sql.ts:269`) will therefore hide unverified GoHire rows when a user turns it on. Say if that is not wanted.
- `RAJob.educationLevel` from the normalizer is now set only where the posting states a requirement, and never replaces enrichment's value. The 学历 filter (`feed/sql.ts:287`), `match/preScore.ts:381` and `keywordRows` need no change.
- Pay: a mainland figure with no period and a top of 50,000 CNY or more has `salaryPeriod` null and no annual figure. A card should show `salaryText` as posted for it.

**PAR-5** (optional)
- `bankPublicJobUrlProblems(env)` (from `roboapply/v2/lib/raCrossBankMatch.js`) lists an unusable posting-page template and a legacy `…_PUBLIC_JOB_BASE_URL` that is set. I log each once on first use; add it to `runStartupAssertions` if you want it at boot.

**PAR-10**
- Document the variables below, and that GoApply's bank ingest still needs `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true` on a deployment whose `APP_NAME` is not `gohire` (the legacy cross-tenant guard, unchanged; the clone `.env` has it).
- Add `verifyFeed.ts` to `orch/parity-verify.md` step 5 (`--check` now also fails on a board row with no source name or no apply host, and on an unknown `--brand`).
- Document: one reading market per board; the 14 boards registered for market `cn`; the 409 reason; `POST /v2/discover/run` sweeps the request brand's bank only.

**PAR-1 / orchestrator**
- The `linkedin` literal stays in the `JobProvider` union for now (item 1 lists what still names it).

**Owner**
- Decision: the 测试 rule (item 2). Implemented: only a title that names no job is a test posting. Say if every title containing 测试 should be dropped as the documents say; that would hide real testing jobs.
- Decision: the 50,000 CNY line for "a K or 万 figure with no period is monthly" (item 5). The safer value ships; 100,000 was the first pass's.
- Decision: the seed threshold of 10 mainland postings (item 4), and whether any of the 12 boards held back should be given to GoApply now.
- GoHire / RoboHire repository: the syndication contract I assumed (item 2), and the posting page (plan §8 item 6).
- The two board-token company names (`veeva`, `airwallex`) should be corrected by a person who reads them off the companies' own boards.

## Schema requests

None is needed for this bundle. Two additive columns would complete work that is carried but not stored:

```prisma
model RAJob {
  /// Openings the source states for the posting (recruiter bank 招聘人数). Null = not stated.
  headcount Int?
}

model RACareerSiteSource {
  /// ISO countries this board is read for (MARKET_STRATEGY JC-4). Empty = the source's own market only.
  countries String[] @default([])
}
```

The second is the market wave's part of JC-4 (one board feeding several countries or both brands, and the `#cn` copy of a posting with locations in both markets). It is also what lets the 12 held-back boards, and RoboApply's use of the 14 registered ones, be resolved. I did not approximate it. The review suggested a `nextSyncAt` column for the backlog interval; it is not needed, the adapter's cursor carries that state.

## Env variables added or redefined

No variable was added in the review pass.

| Name | Meaning | Default |
|---|---|---|
| `JOB_PROVIDERS_ROBOAPPLY`, `JOB_PROVIDERS_GOAPPLY` | comma list that narrows a brand's ingest sources (subset only; unknown names ignored with a warning). A provider narrowed away has its queries switched off by the next `jobs-plan` and switched on again when it returns | the registry list |
| `GOHIRE_BANK_TRANSPORT` | `db` \| `api` \| `off` | `db` when the URL satisfies TLS, else `api` when `GOHIRE_API_KEY` is set, else off |
| `GOHIRE_SYNDICATION_URL` | https cursor and tombstone endpoint; used in place of the list endpoint on the api transport | unset |
| `GOHIRE_PUBLIC_JOB_URL_TEMPLATE`, `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` | the bank's candidate-facing posting page, https, containing `{id}`. Unset or unusable = the bank's rows are synced, counted and not listed. Setting or changing it makes the next database or syndication sync start from the beginning once | unset |
| `GOHIRE_API_KEY`, `GOHIRE_API_BASE` | existing; now also used by the bank's HTTPS reader. The base must be https | `https://api.gohire.top` |
| `CN_EXTERNAL_PROVIDERS` | removed: ignored with one warning | |
| `GOHIRE_PUBLIC_JOB_BASE_URL`, `ROBOHIRE_PUBLIC_JOB_BASE_URL` | removed: ignored with one warning | |
| `INGEST_LINKEDIN_DAILY_CALLS` | no longer has a default (the adapter is not registered) | |

`AppConfig` keys written (no schema change): `jobs.source.status:<market>:<provider>`, `jobs.atsPublic.seed:<market>`. `RAIngestQuery.params.cursor` formats: bank database and syndication `<ISO>|<id>|nopage` or `<ISO>|<id>|page:<8 hex>`; bank list `api|<ISO>|<page>`; employer boards (market cn) `backlog:<sourceId>,…`.

## i18n keys added or changed

`i18n/staging/admin.en.json` and `admin.zh.json`, 121 keys each under `admin.console.sources.*`: `eyebrow`, `title`, `sub`, `loading`, `refresh`, `refreshing`, `panelTitle`, `panelTitleBrand`, `panelSub`, `empty`, `name.*`, `about.*`, `state.*`, `transport.*`, `reason.*`, `facts.*`, `lastError`, `notShown.*`, `pageSet`, `skips.*`, `boards.*`. No existing key in `i18n/messages` changed (`admin.console.nav.sources.*` is reused as it is). RoboHire and GoHire are passed as a `{sourceName}` parameter. The board problem sentences reuse the existing `jobsTw.admin.problem.*`.

Changed in the review pass (against the first pass's 117 keys):
- added `skips.missing_title_or_company`, `skips.private_row`, `skips.normalize_failed`, `skips.no_external_id`;
- removed `skips.other` (the `{reason}: {count}` line);
- added `boards.errors.otherSite`; `boards.errors.duplicate` now reads "This board is already in the list." (it said "on this site or the other one").

## Known gaps

- **Nothing was run against a database or a browser.** The pipeline is tested on the in-memory fake; the 300-row acceptance, the feed and `POST /feed/nl-query` are the orchestrator's post-merge steps with `verifyFeed.ts`. The host query in `verifyFeed.ts` uses a Postgres regular expression that no test executes.
- **A pass over a bank with more than 2,000 published rows never reports a listing** (40-page cap), so closures by listing diff stop there; the admin panel shows `bank_page_cap`. The syndication endpoint is the fix.
- **`heldJobs` on the api transport is 0** while no template is set, because held rows are never stored; the held count is the run tally `bank_no_public_page`. On the database transport the tallies are per incremental run, so `lastCounted` is the last run that read rows, not a census.
- **Source status lives in `AppConfig` as JSON** (read-modify-write, last writer wins). Two instances finishing a tick at the same moment can drop one `counted` update; the next tick repairs it.
- **The education text rule is a heuristic and now errs towards "not stated".** A bare level in a list under a heading the rule does not recognise as a requirement heading, or more than 400 characters below it, is not read; enrichment may still fill it. It reads Chinese only: "Bachelor's degree or above" gets no level from the normalizer.
- **A stated minimum is still read anywhere in the text** ("团队成员均为硕士及以上学历" in a company introduction would give master). The review asked to keep that form as it is; I did.
- **The district list for Hong Kong, Macau and Taiwan is a list.** A district that is neither in it nor in the city table, filed under country `cn` with no region, is still classed as mainland.
- **`jobs-plan` is skipped for a brand with no adapter at all** (`JOB_PROVIDERS_<BRAND>` naming nothing valid), so in that misconfiguration its old queries stay enabled and counted as due.
- **"Check now" in the admin does not touch the backlog list**; a mainland board with unread postings is picked up again by the standing query within 30 minutes.
- **GoApply board manager has no rename control**, and duplicates RoboApply's panel (request to PAR-8).
- **A posting with locations in both markets is stored once**, in the market of its primary location (2 airwallex and 3 animocabrands postings today).
- **Dedupe priority is unchanged** (`bank_gohire` 15, `ats_public` 10): MARKET_STRATEGY JC-7's "bank outranks board, priority 3" is JI-5, left to the market wave as plan §9 says.
- The legacy live fan-out (`raJobProviders.externalProviders`) still contains the LinkedIn provider (JI-2).

## Review resolution

The reviewer judged no item undone and found no unowned edit. All twelve findings were checked against the code first (by running the real functions on the reviewer's inputs where the finding gave inputs); all twelve were real and are fixed. None was rejected.

1. **[medium] `educationFromText` reads a company blurb or a benefit as a requirement, and overrides enrichment: fixed.** `level.ts`: labelled and bare forms separated, the bare form needs a requirement clause or a requirement heading, "毕业" removed. `upsert.ts` + `pipeline.ts`: a text-derived level never replaces the level of an enriched row; a provider label does. The three review sentences are negative tests. Beyond the suggested fix: a bare level in the list under a requirement heading is still read, so the common "任职要求：1、… 2、本科学历" layout keeps its level.
2. **[medium] The legacy cross-bank search archives bank rows by posting age and sweeps the other brand's bank: fixed.** `archiveStaleMirrors` deleted; the run takes the request brand's banks only. Tests as the reviewer asked, plus a brand whose bank is off.
3. **[low] Hong Kong, Macau and Taiwan places without those words are classed as mainland: fixed.** Region field, city-table lookup without the country, and the district list, all only when no mainland city or province resolved. All nine review inputs are tests; two mainland look-alikes are tests the other way.
4. **[low] A 3 to 10万 figure with no period is stored as monthly; bare "15-25K" gets no currency or period: fixed.** Threshold 50,000; CNY for a mainland K / 千 / 万 figure without Chinese text. Boundary tested on both sides.
5. **[low] Rows stored before the posting-page rule keep the dead link when the template is set before the first sync: fixed.** Versioned cursor; I used a hash of the template as the mark, not a bare "page", so a changed template is covered by the same rule.
6. **[low] The test-posting rule hides real jobs: fixed by inverting it, as the reviewer proposed.** The eight review titles are kept cases. The owner's ruling on the documented wording is still asked (Requests); I could not obtain it in this pass.
7. **[low] Queries of providers a brand no longer runs stay due: fixed.** `retireUnrunProviders` in `runPlanner`. Beyond the suggested fix: a standing bank or board query is switched on again when its provider returns, so narrowing `JOB_PROVIDERS_<BRAND>` for a while cannot leave a bank permanently unsynced.
8. **[low] A backlog board gets a back-dated `lastSyncedAt`; international boards affected: fixed.** `lastSyncedAt` is the read time; the backlog list lives in the adapter's cursor; market `cn` only. No schema change. The handoff sentence is corrected (item 4).
9. **[low] The sources panel prints raw codes, shows "Not checked yet" while loading, and RoboApply can show two not-authorized blocks: fixed, all three.** Server keeps a known set of 17 reasons and cleans old documents on read; four sentences added in English and Chinese; the catch-all line removed; the loading line; the shared panel on RoboApply only for a signed-in admin.
10. **[low] The HTTPS bank pass ignores the cron's remaining budget: fixed.** `SourceFetchContext.budgetMs` from the tick; the pass and its request timeouts stay inside it. Beyond the suggested fix: the employer-board adapter honours it too.
11. **[low] The seed takes 26 global boards for market cn and RoboApply's panel misleads: fixed where I own the code, requested where I do not.** Only the 14 boards with at least 10 measured mainland postings are registered; the API says when the other site has a board; GoApply's panel says so; the handoff lists the 14 boards RoboApply gives up and tells the orchestrator (point 5 at the top); PAR-8 is asked to show the sentence in RoboApply's panel.
12. **[low] `verifyFeed` does not check the source name or the apply host: fixed.** Two new failing checks (no source name, no apply host), a per-board host breakdown that flags hosts outside the four job-board systems for a person to confirm, and exit 1 on an unknown `--brand`.
