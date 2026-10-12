# MKT-5D

New public sources: USAJobs and 事求人, and the source register document (JI-9, JT-9, JI-12). Worktree `wp-MKT-5D`, branch `wp/MKT-5D`. Nothing committed, nothing pushed. No database, no model, no provider with a key and no `.env` was touched.

This is the handoff **after the independent review**. Everything above "Review resolution" describes the tree as it is now; that list at the end says what the review changed.

**Read this first**

1. **A correction to my first handoff: a 事求人 record has 26 elements, not 27.** Counted again on the live file (26 on each of the 2,054 records, one element order). The first handoff's Request 5 asked for "27" to be written into `JOB_SOURCES_TW.md`; it is corrected below and has not reached any document.
2. All three items are done. One carry-over entry is left as a Request because its files have no owner in M5 (the admin console's names for the two new sources).
3. The source register now describes the tree of the M5 merge: the status cells and the switch table hold what MKT-5A, MKT-5B and MKT-5E built, and a test holds the switch table to the code. If one of those bundles renames a variable after 2026-10-12 02:30, that test fails at the gate and names the variable (Request 4).
4. No item contradicted the plan documents. Where an item's wording met a fact of the live source, a documented page or a missing seam, the **Differs** list under the item says what was built instead.

## Items

### 1. [P1] USAJobs adapter: done

New `server/src/features/jobs/sources/usaJobs.ts`, registered in `sources/register.ts` next to `tw_open_data`.

- **Adapter.** Provider `usajobs`, kind `cursor`, markets `['intl']`, boards `['usajobs']`, cost model `free`, transport `api`, United States only, not metered. `usaJobsStatus(env)` answers `{ enabled: true }` or `{ enabled: false, reason: 'no_key' | 'disabled' }`: on only when `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT_EMAIL` are both set and `USAJOBS_DISABLED` is not true. Without a key it builds no request at all (`requestUsaJobs` refuses too). A value that could break out of its header (a line break, non-ASCII) is not a credential. The key is never logged and never part of an error text.
- **Header names confirmed** on `https://developer.usajobs.gov/guides/authentication`, read 2026-10-12 (cited in the file header): `Host` (always `data.usajobs.gov`), `User-Agent` (the e-mail address the key was requested with) and `Authorization-Key`. The research note had the User-Agent point as "likely"; it is confirmed. The API itself was not called.
- **Request.** `GET https://data.usajobs.gov/api/Search?DatePosted=<n>&ResultsPerPage=500&Page=<p>`, those three parameters and nothing else, https, `redirect: 'error'`, 30 s timeout, 32 MB cap.
- **Cursor** `{ v: 1, day, page, firstRunDone, doneDay }` in the standing query. One page per fetch; `exhausted: false` while a full page (500 items) came back; then nothing until the next UTC day. The first run asks for 7 days, every later one for 1. A failed request is an ingest error (no cursor is stored, the same page is asked again).
- **Mapping** from the documented fields: `usajobs:<control number>`; title; company = `OrganizationName`, else `DepartmentName`; apply link = the first `ApplyURI` on usajobs.gov, else `PositionURI`; locations as listed, with the country and state the first location states; pay minimum, maximum and period in USD; `postedAt` = `PublicationStartDate`; `expiresAt` = `ApplicationCloseDate`; employment type from `PositionSchedule`; description = summary, duties, qualifications, education and requirements under their headings. No applicant count. `HowToApply` and every contact field are never read.
- **Who may apply.** The hiring path is the tag `usajobs_hiring_path` with the item's own wording as its quote. The same words close the posting text ("This job is open to …") and the key requirements are listed under "Requirements". The adapter sets no citizenship flag (Differs 8).

**Differs** from the item text:

1. **The fixture.** The item says "the documented sample trimmed to two items". The reference prints ONE item. `__fixtures__/usajobs/search.json` is that item (its long texts are `...` on the page and are SYNTHETIC lines here) plus one SYNTHETIC item in the same shape (agency employees only, hourly pay, two places). `__fixtures__/usajobs/README.md` says which value comes from which page.
2. **Close date.** The reference calls `ApplicationCloseDate` the last date applications are accepted, and its sample writes it as midnight UTC. Read as an instant, the row would close a day early. It is handed over as a calendar day, so the row is open through that day (ended in UTC, which is 4 to 5 hours before the end of that day in U.S. Eastern Time: never listed after its close date). An item with no close date falls back to `PositionEndDate`; with neither it is skipped and counted (`usajobs_no_close_date`), because this source has no other closure signal and the row could never be closed.
3. **Pay period.** The reference documents one interval pair (`PA`, "Per Year") and the code list page one more (`BW`, "Bi-weekly"). So: `PA` is a year; any other interval is read from the item's own `Description` when it is exactly "Per Hour", "Per Day", "Per Week" or "Per Month"; anything else gives no figure at all, counted `usajobs_pay_interval_unmapped` (nothing is converted; "Bi-weekly" is not a week). `payFromFieldsOnly` is set, so a figure in the announcement text is never read as this job's pay.
4. **Cents.** `RAJob.salaryMin` and `salaryMax` are whole numbers, so "$21.50 to $27.95 an hour" is stored as 22 to 28 (the normalizer's existing rule). For a range with cents the adapter also hands over the exact words as `salaryText` ("$21.50 - $27.95 Per Hour"), which the job page prints as stated.
5. **A missed day and the row limit** (additions). The cursor's extra field `doneDay` lets a run after a missed day ask for the days since the last finished run (up to the API's 60) instead of losing them. A run stops at page 20: the developer site states 10,000 rows a query (`usajobs_row_cap`).
6. **`HiringPath`.** The documented field for who may apply is `UserArea.Details.WhoMayApply.Name`. The adapter also reads a `HiringPath` code list from the same object when an answer carries one, each code by its documented name (the 17 codes of the reference's HiringPath table). That list is NOT in the documented sample; its test builds the item inline and says so.
7. **Storing the tag.** `ProviderJobInput` has no field for a source's own market tags. The adapter carries the tag beside the input (`UsaJobsInput.marketTags`) and writes the same words into the description. MKT-5F built the normalizer's half of my request in this phase (it reads `marketTags` from the input by structure and stores `usajobs_hiring_path` and `tw_gov_person_kind`), so after the M5 merge the tag is in `RAJob.marketTags`. What is left is the type field (Request 1).
8. **Citizenship: the adapter sets nothing.** The item says "`citizenshipRequired` is set true only when the item itself states a citizenship requirement, never by assumption". No ingest seam exists for that column: `RAJob.citizenshipRequired` has one writer, the enrichment with its quote check. The first version of this adapter carried a pattern-read flag beside the input; nothing read it, and the review showed that the pattern took either/or statements ("U.S. citizenship or permanent residency", "citizens, nationals or those who owe allegiance") for a requirement. It is removed. What holds now: nothing is assumed because the employer is federal, and the item's own statement is in the posting text word for word, where enrichment reads it when the row's turn comes (Known gaps 6).

ACCEPT: no key → disabled, reason `no_key`, nothing fetched: met. Pay range (min, max, period, USD) and close date into `expiresAt`: met. First run 7 days, later runs 1: met. A 500-item page answers `exhausted: false` and the next fetch asks for page 2: met. A federal-employees-only posting carries the hiring-path tag with its quote: met on the adapter's output and in the posting text; in `RAJob.marketTags` once MKT-5F's normalizer is merged.

Tests: `usaJobs.test.ts`, 40 tests (status and switches, request parameters and header names, error codes that hold no credential, size cap, timeout and abort, mapping of both fixture items through the normalizer, close-date shapes, period table, unmapped interval, description and the contact-field scan, link rules, who may apply, no citizenship field whatever the item says, cursor, paging, daily cadence, missed day, row cap, skip counts, budget, other market, registration and brand lists, public display).

### 2. [P1] 事求人 adapter without any contact field: done

New `server/src/features/jobs/sources/twGovJobs.ts`, registered in `sources/register.ts`.

- **Adapter.** Provider `tw_gov_jobs`, kind `cursor`, markets `['intl']`, boards `['tw_gov_jobs']`, cost model `free`, Taiwan only. On unless `TW_GOV_JOBS_ENABLED` is false (`kill_switch`); `TW_GOV_JOBS_URL` overrides the address and must be https on `dgpa.gov.tw` (`url_invalid` otherwise). https only, `redirect: 'error'`, 30 s timeout, 20 MB cap, `User-Agent: sourceUserAgent('intl', env)`.
- **Reader.** A small element reader for flat records, no dependency. It takes only the eleven elements of `TW_GOV_READ_FIELDS` out of a `<ROW>`; `VITAE_EMAIL` and `CONTACT_METHOD` (and every element the file does not know) never reach a record object, and nothing logs a record. Element names in any case, whitespace, attributes, CDATA and numeric references are accepted. The document is taken whole or not at all: without its closing `</ROOT>`, with an unclosed or oversized record, or with no record, the answer is an error and closes nothing.
- **Mapping.** `dgpa:<work_id>` from `VIEW_URL` (else the first 16 hex characters of sha1(VIEW_URL)); a record without `VIEW_URL` is skipped and counted `no_stable_id`; title, organisation, apply link = source link = `VIEW_URL`; place from `WORK_PLACE_TYPE` and `WORK_ADDRESS`, country TW, district from the address; description = 人員區分, 工作項目 and 資格條件 under the dataset's own field names; `postedAt` = `DATE_FROM`, `expiresAt` = `DATE_TO` (Republic-of-China dates, handed over as calendar days: 1151231 is stored as 2026-12-31T15:59:59.999Z, the end of that day in Taipei); headcount from `NUMBER_OF`. No pay field is ever produced; `payFromFieldsOnly` is not set, so the normal pay-text reader decides about amounts in 資格條件.
- **One read a day** (cursor `{ v: 1, day, rows, listed }`, the Taipei calendar day). Every later lease of the day answers without a request.
- **Credit line.** The row's board is `tw_gov_jobs`, so `twHooks.ts` names 事求人 as the source and `cardMeta` carries the 人事行政總處 sentence; `CREDIT_LINE_BOARDS` already holds the board out of every surface that cannot print it.

**Differs** from the item text:

1. **Closure through `listing`, not `closedExternalIds`.** The pipeline already has the rule for a complete listing (`SourceFetchResult.listing`, `archiveUnlistedJobs`, the one the employer boards use). The adapter reports the ids it ingested with reason `source_removed` and ingest archives the open rows of the board that are not among them. Same effect, no database read in the adapter, one rule in one place. A test runs the real `archiveUnlistedJobs` on the adapter's result: a row missing from the next file is closed, and listed again it comes back.
2. **Three guards on that closure** (additions). What closes rows is the list of ids that came out of the file, so the guards count those ids and not only the records. (a) A file that is not whole, or holds no record, is an error. (b) A whole file out of which no vacancy could be listed (every record skipped: a reworded 人員區分, a moved page address, a changed layout) is the error `tw_gov_jobs:nothing_listed`: no cursor is stored, nothing is closed, ingest asks again and the admin status shows the error with its skip counts. (c) A file with fewer than half of the records of the last read, or out of which fewer than half of the vacancies of the last read could be listed, is ingested but closes nothing that day (`tw_gov_listing_shrank`); the next day's read decides.
3. **`WORK_PLACE_TYPE` is not `10-臺北市`.** In the live file it starts with a comma and may list several counties (`,60-嘉義市,61-嘉義縣`; 39 records). All are kept as `locations`; `99-跨縣市` is not a place.
4. **`PERSON_KIND` has seventeen values, not five.** The research note confirms three as open to the public (約僱人員, 聘用人員, 其他人員: ingested) and one as transfers (一般人員: skipped, `tw_gov_internal_transfer`). The other thirteen (工友 79, 教育人員 77, 駕駛 70, 主計人員 51, 人事人員 45, 技工 38, 會計人員（非主辦） 4, 代理教師 2, 審計人員 2, 駐衛警 1, 代課教師 1, 司法人員 1, 清潔隊員 1) are in no note. Nothing confirms that a member of the public may apply, so they are skipped and counted apart (`tw_gov_kind_unconfirmed`), never assumed open (D3). `TW_GOV_JOBS_INCLUDE_TRANSFERS=true` ingests both groups, each row tagged `tw_gov_person_kind` with its PERSON_KIND text as the quote. On the file of 2026-10-12: 1,090 of 2,054 records are listed by default, 592 are transfers, 372 are unconfirmed.
5. **Contact details are also inside the text fields.** On that file an "@" sits in 5 `WORK_ITEM`, 5 `WORK_QUALITY` and 3 `WORK_ADDRESS` values and a phone number in about 40. JT-9 says no e-mail or phone is stored, so `withoutContactDetails` leaves out every sentence of those fields that holds: an e-mail address; a phone number with its area code, mobile prefix or country code; a number announced by a word (電話, 專線, 請撥, 致電, 洽詢 …); a local number without its area code (5550-0100, 555-0100, also with a hyphenated extension); a number of seven or eight digits after a word of contact; an extension (分機 1234; 轉 12 beside a word of contact); a contact label with its colon (聯絡人：, 承辦人：, 聯絡方式： …); or a named person to contact. Counted `tw_gov_contact_text_removed`. **Measured on the file of 2026-10-12** (read into memory outside the repository, all 2,054 records with the transfers included): 58 sentences are taken out of 53 records. A detector that shares no pattern with the scrub (every "@", every run of seven or more digits once separators are removed, every 分機 or 轉 number, every contact label with a colon, in the description and the place of every record) found **no e-mail address, phone number, extension or contact label left**. The 33 digit runs that stayed are 4 dates, 2 clock ranges, 16 document, selection and position numbers, 1 amount and 10 parts of page addresses.
6. **The tag** has the same seam as item 1 (Request 1). The description of every row opens with its 人員區分 line.
7. **Numbers.** The item says about 2,100 rows and 6.4 MB; on 2026-10-12 the file held 2,054 records in 6,307,787 bytes, 26 elements on each. The dataset record says it is updated every 12 hours.
8. **A postal code before the address** (addition). 129 of the 2,043 filled `WORK_ADDRESS` values start with a postal code of 3, 5 or 6 digits, and a county follows on 121. The code is left out when a county follows it, so the county is not shown twice and the district is read: 939 records have a district now, about 115 more than before. Digits that no county follows stay part of the address.

ACCEPT: rows link to `VIEW_URL` and no e-mail address or phone number is stored (the test scans every produced input, the normalized rows and the fixture): met. `DATE_TO` 1151231 becomes 2026-12-31, Taipei end of day: met. A 一般人員 row is skipped and counted by default: met. A row missing from the next file is closed: met. The card of such a row shows the 人事行政總處 attribution sentence: met (`cardMeta.tw_sources.attribution`).

Tests: `twGovJobs.test.ts`, 43 tests (switches, address rule, request, error codes, size cap, timeout, the reader and what it never reads, layout and attribute tolerance, whole-or-nothing, field mapping, dates, places, the postal code, ids, headcount, no pay figure, PERSON_KIND rule, the privacy scan, the scrub with its "taken out" and "left alone" lists, one read a day, closure with the real listing diff, failed and cut-off reads, the file out of which nothing can be listed, both shrink guards, skip counts, cursor, budget, other market, credit line, public display, registration).

### 3. [P1] Source register: done

New `docs/job-search/SOURCE_REGISTER.md` and `server/src/features/jobs/sources/sourceRegister.test.ts`.

- **Section 1**: one row per provider id of `PROVIDER_META` (eleven ids, eighteen rows: `ats_public` has one row per board system: Greenhouse, Lever incl. EU, Ashby, SmartRecruiters, Workable, Recruitee, Personio, 北森). Columns: what it is and who publishes it, status, plan and quota on the date read, permitted surfaces with their basis (signed-in, public, partner API), required attribution, retention on termination, primary URL of the terms, date read, owner decision pending. Every figure and licence statement names its place in a research note. Where a note says nothing the cell says "not stated"; where a question is open it says "unresolved".
- **Status is what the code does with nothing set, as of the M5 merge.** Workable, Recruitee, Personio and Lever EU are `on` (no board of theirs is seeded; a Workable board that discovery recorded is read from the first deploy, and the cell names `ATS_WORKABLE_DISABLED=true`); 北森 is `off until counsel signs off`; the licensed feed is `off until the plan's monthly job quota is at least 20,000`. The register says that `on` is not a statement about rights: an unresolved permission stays "unresolved" in its own cell.
- **Section 2**: the forbidden sources of strategy 1.6, each with its reason and its place in a note. **Section 3**: the switch of each source, with the variables MKT-5A, MKT-5B and MKT-5E add. **Section 4**: `PUBLIC_DISPLAY_PROVIDERS`: `tw_open_data` and `usajobs` are the recommended first entries, `tw_gov_jobs` is a candidate under the same licence, the default stays empty until the owner decides, and what the list really does today (Known gaps 10).
- **The test** reads the Markdown from disk. It fails when a provider id has no row, when a row has no date read or an empty required cell, when a status is not one of the three words, when a row names a provider id the code does not have, and when a site the strategy forbids appears in a provider row (the import denylist of `features/jobs/import` plus the sites of 1.6 it does not carry). The checks are pure functions, and the test proves each failure on a deliberately broken copy. It also holds the document to the code: the two OGDL sentences are the ones `twHooks.ts` prints, the dropped LinkedIn feed is "not a source" and no brand has it, the providers the code never marks public are "Never" in section 4, the code's default for the list is empty, **every variable section 3 names is one the server's source reads**, and no cell of sections 1 and 3 speaks of a merge or a phase still to come.

**Differs** from the item text:

1. Three rows cite a page read for this register on 2026-10-12, not a research note, and say so. `usajobs`: the notes only say "clean licence" and "official API"; the API's terms of service (`https://developer.usajobs.gov/guides/terms-of-service`) state that the search data is public data under an open licence (store, publish, redistribute, commercial use, no approval), that attribution is encouraged and not required, that nobody may imply that OPM runs or endorses the product, and that losing the key does not forbid reuse of data already obtained. `tw_gov_jobs`: the dataset record on data.gov.tw (licence, free, updated every 12 hours). `activejobs`: what a direct plan counts (jobs and API requests, the request limit, the price of further jobs, 600 requests a minute), from the vendor's page "Plans, Limits & Upgrades" (MKT-5A asked for it in its handoff; I read the page myself before writing it).
2. The variables of the three sibling bundles are not in this worktree's code. The test therefore allows the names of one bundle to be unread only all together (a tree without that bundle) and fails when a bundle is read in part (a renamed or dropped variable). After the merge every name must be read.

ACCEPT: one row per provider with plan, quota, permitted surfaces, attribution, retention and date read: met. The test passes and fails when a provider id is added without a row: met. No forbidden source is named as usable and no number is invented: met.

Tests: `sourceRegister.test.ts`, 14 tests.

### Carry-over (`requests/waveM3-carryover.md`, section MKT-5D)

1. **Done.** The adapter writes `sourceBoard = 'tw_gov_jobs'`; the attribution and the source name come from `twHooks.ts` (tested through `afterNormalize` and `cardMeta`).
2. **Left, as Request 2.** `KNOWN_SOURCES` in `components/v3/admin/SourcesConsole.tsx` and the `admin` namespace have no owner in M5 and are not in my files. Nothing is broken meanwhile: the console falls back to the raw ids `tw_gov_jobs` and `usajobs` and to "Off (no_key)". Next step: the orchestrator applies Request 2.
3. **Done.** Both adapters pass a deadline as `'YYYY-MM-DD'`; the 事求人 dates are read in Taipei time by `naiveOffsetMinutesFor`.

`waveM1-`, `waveM2-` and `waveM4-carryover.md` have no MKT-5D section. `waveM3-carryover.md` MKT-5F.4 asks whether `payFromFieldsOnly` should be set for 事求人: no. The file has no pay field, and the item leaves the amounts in 資格條件 to the normal pay-text reader.

### Requests other M5 bundles addressed to MKT-5D

- **MKT-5A, request 6** (facts for the Active Jobs DB row): applied to the plan cell, after reading the vendor's page. Not added: the two sentences on how the expired feed rechecks postings (not a plan, a quota or a term, and I did not read that page).
- **MKT-5G, optional** (rows for the three sponsorship publications): not added as rows. The register is one row per provider id that writes a job row, and its test refuses any other id in that table. A note under the table says that those publications are not job sources and that each fact shown names its publication, file and date (JI-11).
- **MKT-5H, Request 9** (written to the orchestrator about my file): applied here, with one correction from MKT-5E's handoff after its review: `INGEST_BANK_RESYNC_DAYS` belongs to the GoHire bank only, so the `bank_robohire` row does not name it.

### What was read on the network

Read-only GET requests, nothing stored in the repository.

First pass:

- `developer.usajobs.gov`: fourteen documentation pages (search reference, authentication, rate limiting, terms of service, hiring paths, the search tutorial, the code-list index and four code-list references, three index pages). `data.usajobs.gov` was never called.
- `web3.dgpa.gov.tw`: the dataset file once, with the identifying User-Agent, analysed outside the repository and deleted.
- `data.gov.tw`: the dataset record of dataset 7229 once.
- A loopback-only check that Node's fetch sends an explicit `Host` header.

Review pass:

- `web3.dgpa.gov.tw`: the dataset file four times, with the identifying User-Agent, each time read into memory by a scratch script outside the repository. Nothing was written to disk. Only counts and snippets with the digits masked were printed. The script is deleted.
- `developer.fantastic.jobs`: three requests (one guessed address that answered 404, the index `llms.txt`, and the page `/documentation/credit-usage.md`).
- **Other worktrees, read only:** a text search for the eighteen variable names of section 3 in the server sources of `wp-MKT-5A`, `wp-MKT-5B` and `wp-MKT-5E`, one look at the tag rule in `wp-MKT-5F`'s normalizer, and in `wp-MKT-5H` one at the six lines of its `.env.example` and a search of its documents for the wrong element count. Nothing was changed there.

No RapidAPI, 北森, GoHire, RoboHire, forbidden site, payment, model or embedding provider was called.

## Files changed

New:

- `server/src/features/jobs/sources/usaJobs.ts`
- `server/src/features/jobs/sources/usaJobs.test.ts`
- `server/src/features/jobs/sources/twGovJobs.ts`
- `server/src/features/jobs/sources/twGovJobs.test.ts`
- `server/src/features/jobs/sources/sourceRegister.test.ts`
- `server/src/features/jobs/sources/__fixtures__/usajobs/search.json`
- `server/src/features/jobs/sources/__fixtures__/usajobs/README.md`
- `server/src/features/jobs/sources/__fixtures__/twgov/sample.xml`
- `server/src/features/jobs/sources/__fixtures__/twgov/README.md`
- `docs/job-search/SOURCE_REGISTER.md`

Modified:

- `server/src/features/jobs/sources/register.ts` (registers the two adapters; `ensureTwGovJobsAdapter`, `ensureUsaJobsAdapter`, `ensureSourceAdapters`; `ensureTwOpenDataAdapter` and `twOpenDataAdapter` unchanged)

`git status` lists these eleven paths and nothing else. Outside the worktree: this handoff only (`/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-5D.md`).

## Tests run

All in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-5D`, after the last code change of the review pass.

| Command | Result |
|---|---|
| `npx vitest run server/src/features/jobs/sources/usaJobs.test.ts server/src/features/jobs/sources/twGovJobs.test.ts server/src/features/jobs/sources/sourceRegister.test.ts` | 3 files, **97 passed** (40, 43, 14). Run again after the last edit of the register: 97 passed |
| `npx vitest run server/src/features/jobs/sources` | 11 files, 414 passed, 4 todo |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M4` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | **761 files passed, 19,734 tests passed**, 1 skipped, 10 todo, 0 failed (the base's 758 files and 19,637 tests plus my 3 files and 97 tests) |

## Red tests for other bundles

None. Registering two more adapters for the international market broke no test outside my files.

## Pre-existing failures

None. The full run of the review pass was green on the first attempt (load average about 25).

## Requests

**1. Orchestrator (`server/src/features/jobs/normalize/types.ts`, no owner in M5): the type half of "a source hands over its own market tags".** MKT-5F built the normalizer's half in this phase (its handoff, "MKT-5D, request 1, my half"): `normalizeProviderJob` reads `marketTags` from the input by structure and stores `usajobs_hiring_path` and `tw_gov_person_kind` (a quote is required; one per tag; 300 characters). So after the merge both tags are stored. Left:

```ts
// normalize/types.ts, in ProviderJobInput
  /**
   * Statements the source itself makes about the posting (who may apply, a hiring path, a staff category),
   * each with the source's own words. Stored in `RAJob.marketTags` and merged by tag on re-ingest. A tag
   * another module owns (enrichment's requirement tags, an employer tag) is not accepted here.
   */
  marketTags?: readonly { tag: string; evidenceQuote: string; evidenceUrl?: string | null }[] | null;
```

Afterwards the two local types `UsaJobsInput` and `TwGovJobsInput` can become plain `ProviderJobInput`, and MKT-5F's cast in the normalizer can go (no behaviour change).

**2. Orchestrator (no owner in M5): the admin sources console for the two new sources** (carry-over 2).

- `components/v3/admin/SourcesConsole.tsx`: add `'tw_gov_jobs'` and `'usajobs'` to `KNOWN_SOURCES`; add `'no_key'` to `KNOWN_REASONS`.
- `i18n/staging/admin.en.json`, under `admin.console.sources`:
  - `name.tw_gov_jobs`: "Taiwan public-sector vacancies"
  - `about.tw_gov_jobs`: "Vacancies of government agencies and schools from Taiwan's open data. Each one shows the credit line its licence asks for. No contact details of officials are kept."
  - `name.usajobs`: "USAJOBS"
  - `about.usajobs`: "United States federal vacancies from the government's own job site. Each one links to the official announcement."
  - `reason.no_key`: "No key is set for it."
- `i18n/staging/admin.zh.json`, same keys: "台湾公部门职缺"; "来自台湾开放数据的机关与学校职缺，每条都显示其授权条款要求的来源说明，不保留承办人员的联系方式。"; "USAJOBS"; "来自美国政府官方求职网站的联邦职位，每个职位都链接到官方公告。"; "尚未设置密钥。"
- Optional, so the console can show what the two sources left out: add to `SOURCE_STATUS_NOTES` (`server/src/features/jobs/ingest/status.ts`) and to `TALLY_ORDER` (`SourcesConsole.tsx`; `components/v3/admin/__tests__/sources.test.tsx` holds the two lists together) the keys below, each with a line under `admin.console.sources.skips`. Without it they are in the run's log tally only.
  - `no_stable_id`: "No page address from the source: {count}"
  - `tw_gov_internal_transfer`: "Transfer posts for serving civil servants, left out: {count}"
  - `tw_gov_kind_unconfirmed`: "Posts of a staff category not confirmed as open to the public, left out: {count}"
  - `tw_gov_contact_text_removed`: "Postings with a sentence of contact details taken out: {count}"
  - `tw_gov_listing_shrank`: "Daily reads that closed nothing because the list had shrunk by more than half: {count}"
  - `usajobs_no_close_date`: "No closing date, left out: {count}"
  - `usajobs_pay_interval_unmapped`: "Pay stated for a period we do not show, kept without a figure: {count}"
  - `usajobs_row_cap`: "Daily reads that stopped at the source's limit of 10,000 rows: {count}"
- Nothing to add for the new error `tw_gov_jobs:nothing_listed`: it is the query's error text, which the console already prints as it is.

**3. Orchestrator, after the owner decides `PUBLIC_DISPLAY_PROVIDERS` (`server/src/features/seo/scope.ts`, no owner in M5).** `PROVIDER_BOARDS` knows `activejobs` and `ats_public` only, so naming `usajobs`, `tw_open_data` or `tw_gov_jobs` in the list publishes nothing. For USAJOBS it is one line, `usajobs: ['usajobs']`. The two Taiwan boards may be added only together with the credit line on the visitor list (`waveM3-carryover.md`, Owner 6).

**4. Orchestrator, at the M5 gate: the register against the merged code.** The status cells and section 3 of `docs/job-search/SOURCE_REGISTER.md` were written from the handoffs of MKT-5A, MKT-5B and MKT-5E and checked against their worktrees on 2026-10-12 at about 02:30 (every one of the eighteen names is read there). MKT-5E's handoff was already the one after its review; MKT-5A's and MKT-5B's were still the first versions. `sourceRegister.test.ts` runs in the full suite:

- "`<NAME>` is not read by the code" or "MKT-5x is in the tree but the code does not read `<NAME>`": a bundle renamed or dropped a variable after I read it. Correct the cell in section 3 and the name in `ARRIVING_WITH` at the top of the test.
- Once the three bundles are merged and the test is green, `ARRIVING_WITH` and the two loops over it in `switchProblems` can be deleted; the first loop then checks every name by itself.
- If MKT-5B's review turned a connector off by default, correct its status cell in section 1 (the test requires `on` for Workable, Recruitee, Personio and Lever, and "off until counsel signs off" for 北森).

MKT-5H's Request 9 about this file needs nothing more: it is applied (see "Requests other M5 bundles addressed to MKT-5D").

**5. Orchestrator (plan documents; MKT-5H passed my first list on as part of its own requests).** Use these, not the first handoff's:

- `JOB_SOURCES_TW.md` 3.2: 2,054 records on 2026-10-12; **26 elements per record** (the note lists 24; `URL_LINK` and `Work_Type` are the other two); `WORK_PLACE_TYPE` starts with a comma and may list several counties; `PERSON_KIND` has seventeen values; the dataset is updated every 12 hours; contact details also sit inside `WORK_ITEM`, `WORK_QUALITY` and `WORK_ADDRESS`; 129 of 2,043 addresses start with a postal code.
- `JOB_SOURCES_INTL.md` 4.2: the e-mail in the User-Agent header is confirmed, and the terms of service are an open licence (register row `usajobs`).
- `MARKET_STRATEGY.md` 1.3: the 事求人 row says "Later"; it is built and on by default.
- `MARKET_TASK_PLAN.md` 3.2 can take an "as built" line: both sources are cursor adapters read by the ingest tick; 事求人 closes by the listing diff (never on a file out of which nothing could be listed, and not on a day the list fell below half), USAJOBS by its stated close date; neither adapter writes `citizenshipRequired`.

**6. Owner.**

- Request the free USAJOBS key (strategy 7 item 3) and set `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT_EMAIL`. On the first run with it, please have Known gaps 1 checked.
- Decide `PUBLIC_DISPLAY_PROVIDERS` after reading the register (strategy 7 item 15). If USAJOBS rows go on public pages, decide whether to print the sentence the terms encourage (that the product is not run or endorsed by OPM).
- A Taiwan reviewer: which of the thirteen unconfirmed 人員區分 kinds may a member of the public apply for? Each confirmed kind is one string in `TW_GOV_PUBLIC_KINDS`.
- With this merge RoboApply reads the 事求人 file once a day by default, in every environment that runs the ingest cron (`TW_GOV_JOBS_ENABLED=false` turns it off).

## Schema requests

None.

For information, no request: `RAJob.salaryMin` and `salaryMax` are `Int`, so an hourly rate with cents is stored rounded for every source (Differs 4 of item 1).

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `USAJOBS_API_KEY` | The free key from developer.usajobs.gov, sent as the `Authorization-Key` header. Without it the adapter is off (`no_key`). | unset |
| `USAJOBS_USER_AGENT_EMAIL` | The contact e-mail address the key was issued to, sent as the `User-Agent` header as the API requires. Must be an e-mail address; without it the adapter is off (`no_key`). | unset |
| `USAJOBS_DISABLED` | `true` (or `1`, `on`, `yes`) turns the adapter off even with a key (`disabled`). | false |
| `TW_GOV_JOBS_ENABLED` | `false` (or `0`, `off`, `no`) turns the 事求人 adapter off (`kill_switch`). | on |
| `TW_GOV_JOBS_URL` | Overrides the dataset address. https only, a host of `dgpa.gov.tw`; anything else turns the adapter off (`url_invalid`). | `https://web3.dgpa.gov.tw/WANT03FRONT/AP/WANTF00003.aspx?GETJOB=Y` |
| `TW_GOV_JOBS_INCLUDE_TRANSFERS` | `true` also ingests the posts outside the three public kinds (一般人員 transfers and the unconfirmed kinds), each tagged with its 人員區分. | false |

All six are as the plan lists them; the review pass added and changed none. MKT-5H's `.env.example` already describes them with the two formats. `JOB_SOURCES_CONTACT` (existing) is the contact in the 事求人 request's User-Agent.

## i18n keys added or changed

None. The bundle owns no namespace and adds no UI copy. The strings the admin console needs are written out in Request 2. The attribution sentences, the source names and the description labels (人員區分, 工作項目, 資格條件; "Duties", "Qualifications", "Education", "Requirements", "This job is open to") are server data, not bundle copy.

## Known gaps

Last phase: each gap has its next step and who must act.

1. **USAJOBS was never called.** Everything beyond the documented sample is unverified: whether a live answer carries `HiringPath`, whether `MajorDuties` is a list, how dates are written, which `Description` wordings exist, the default sort order (pages could shift between two fetches), and whether `DatePosted=1` at a day boundary can miss a posting. Next step, owner then engineer: with the key, read one page and compare it with `__fixtures__/usajobs/README.md`; add wordings to `PERIOD_BY_DESCRIPTION`; if pages shift, add the documented `SortField=opendate&SortDirection=desc` in `usaJobsSearchUrl` (one line and one test line).
2. **The close date ends in UTC**, 4 to 5 hours before the end of that day in U.S. Eastern Time. Next step, engineer: confirm the closing hour on USAJOBS' own help pages, then convert in `usaJobsItemToInput`.
3. **A cancelled or extended announcement is not seen again.** Each posting is read once, when it is posted, and nothing re-reads it: one cancelled early stays listed until its stated close date, one extended closes on its first date. Next step, engineer with the key: a weekly re-read of the open `usajobs` rows (the API's terms name two more endpoints, Historic JOA and Announcement Text, which were not read for this bundle), or a wider daily window.
4. **The first run can hit the 10,000-row limit** (`usajobs_row_cap`): the rest of the 7-day window is then not read. Daily runs are far below it. Next step: none unless the counter shows; then split the first run by a documented filter.
5. **A pay interval other than year, month, week, day or hour gives no figure**, and cents are rounded in the pay columns (the exact words are kept as pay text). Next step for the first: Known gap 1. For the second: a schema decision (owner), not requested here.
6. **A USAJOBS row has no citizenship flag until enrichment reads it** (bounded by `ENRICH_DAILY_JOBS`), so a filter on that column does not see a new federal row at once. The statement itself is in the posting text from the first moment. Next step, only if the owner wants the flag at ingest: an input field in `normalize/types.ts`, the pass-through in the normalizer and a rule in `ingest/upsert.ts` that writes it only while enrichment has not ruled (three files without an owner in M5), fed by `WhoMayApply.Name` and the key requirements with a reader that does not take an either/or statement for a requirement.
7. **The two tags are stored after the merge with MKT-5F, and no surface prints them as a badge**: the bundle owns no component and no namespace. Next step, orchestrator: Request 1 (types only); then a UI item with two strings, if the owner wants a badge beside the posting text.
8. **事求人: 372 records a day of thirteen staff categories are not listed** because nobody confirmed them as open to the public (item 2, Differs 4). Next step, owner: the Taiwan reviewer of Request 6. `IS_TRANSFER`, `Work_Type` and `URL_LINK` are in the file with no documented meaning and are not read.
9. **The contact scrub is by pattern and leans toward taking a sentence out.**
   - Not recognised: a bare name with no number, label or honorific; a local number of six digits or fewer written without any word of contact. Titles are not scrubbed (six titles of the real file carry a position or announcement number).
   - Taken out although it is no contact detail (seen with synthetic probes, none on the file of 2026-10-12 except the last): a clock range that starts between 20:00 and 23:59 and has no unit after it ("2200-0600"); a range of two four-digit amounts with no unit ("3000-5000"); "ISO 9001-2015"; a two-part code such as a student number; and a "聯絡方式：" line that names no person (3 on that file, one of them an address line, whose record then shows its county only).
   - Turning `TW_GOV_JOBS_INCLUDE_TRANSFERS` off again closes the rows it had added with the reason `source_removed`, or holds the closure for one day when that halves the list.
   - Next step: none planned; the counter `tw_gov_contact_text_removed` shows the volume (53 of 2,054 records on 2026-10-12), and the posting's own page always has the full text. If shift hours turn out to be lost, exempt a pair of clock times that follows 班 or 時間 in a sentence with no word of contact (`LOCAL_NUMBER` in `twGovJobs.ts`).
10. **`PUBLIC_DISPLAY_PROVIDERS` is weaker than its name**: the flag is set when a row is ingested (a USAJOBS row is read once), and the public pages do not know the three boards (Request 3). Next step, owner then orchestrator: decide, then Request 3.
11. **The admin console prints raw ids** for the two sources and "Off (no_key)" until Request 2 (orchestrator).
12. **The register's cells about the connectors of MKT-5A, MKT-5B and MKT-5E come from their handoffs and a text search of their worktrees, not from running their code**, and two of the three handoffs were still first versions. The variable names are held by the test; the status words are not (only their form, and `on` or `off until` per row). Next step, orchestrator: Request 4.
13. **The closure guard believes a change that lasts two days.** A day on which the list falls below half closes nothing; the day after, the smaller list is the truth and the missing rows close. A file out of which nothing at all can be listed never closes anything and stays an error until someone looks. Next step: none; if the source really empties (it holds about 2,000 vacancies), the error is the signal to read the file by hand.
14. **Two vacancies of one agency with the same title in the same place share one card** (the fuzzy dedupe key, as for every source; common in public-sector listings). Next step: none here; the owner decision on exact twins is open in `waveM3-carryover.md` (Owner 2).
15. **The first 事求人 read queues about 1,100 postings for enrichment** (bounded by `ENRICH_DAILY_JOBS`), and one fetch hands all of them to the pipeline in one page. Next step: none unless the first run is slow; then page the hand-over in the adapter.

## Review resolution

Every finding was checked against the code before it was changed. All six are real; none was rejected. No unowned edit existed, so nothing was reverted.

1. **事求人: a file whose records are all skipped closes every open row (medium): real, fixed.** Confirmed in the code as it was: the guard compared the number of records only, the parser's `empty_listing` fired only for a file without a `<ROW>`, and every result without an error carried `listing`, so ten records that were all skipped (a reworded 人員區分, links on another host, no `VIEW_URL`) gave an empty listing and no error. Now (`twGovJobs.ts`, `fetch`): a whole file with no listable vacancy returns `{ jobs: [], calls: 1, error: 'tw_gov_jobs:nothing_listed', notes }` with no cursor and no listing; the cursor keeps the count of listed vacancies (`{ v: 1, day, rows, listed }`; a cursor without it reads as 0 and guards by the records only) and the listing is withheld when fewer than half of the last read's vacancies are listed. Tests: "a whole file out of which no vacancy can be listed is an error" (the three cases, after a cursor of 10 and on a first read, plus the real `archiveUnlistedJobs` showing what an empty listing would have closed) and "a file that kept its records but lists fewer than half of the vacancies it listed closes nothing that day". Also done because the review named it as a way to get there: the reader now passes over attributes on a record and on its elements, so an attribute added by the source no longer makes every record `no_stable_id`.
2. **事求人: the free-text scrub leaves local numbers and named officials (medium): real, fixed.** The nine sentences of the review, which it measured as unchanged, are all taken out now (checked with the review's own wording in a scratch probe; the test holds them with made-up digits and the name 假名). Changes in `twGovJobs.ts`: more words that announce a number (專線, 請電, 請撥, 致電, 撥打, 洽詢, 聯絡方式, 連絡方式); a local-number rule (not a pair of years, not a range a unit follows, not part of a longer hyphenated code; a hyphenated extension is accepted); a run of seven or eight digits after 洽, 聯絡, 連絡 or 聯繫; extensions; contact labels with their colon; the country code without a plus sign. A Republic-of-China date written as one number is never read as a phone number. The nine sentences and ten more forms are in the test's "taken out" lists, and its "left alone" list grew by fifteen (clock times, date ranges, a pair of years, amounts and points with their unit, a document number, a date after 洽詢, an amount after 洽, longer hyphenated codes). **The whole-file check was repeated** on the file of 2026-10-12 with a detector that shares no pattern with the scrub: residue of contact details **0** (no "@", no phone number, no extension, no contact label in the description or the place of any of the 2,054 records); 33 digit runs of seven or more digits stayed and each was classified, and every one that was not a plain date was looked at with its digits masked (4 dates, 2 clock ranges, 16 document, selection and position numbers, 1 amount, 10 parts of page addresses). 58 sentences are taken out of 53 records; the rules of this review account for 4 of them, all by the label rule, so none of the nine forms occurs in that day's file. What the rules cost is in Known gaps 9.
3. **USAJOBS: an either/or statement is read as a citizenship requirement, and the two fields are read by nothing (low): real, fixed by the first option.** `citizenshipRequired`, `citizenshipEvidence` and `usaJobsCitizenshipStatement` are removed from `usaJobs.ts`, with their test. Reason for removing instead of tightening: the column has one writer with a quote check, no seam leads from an adapter to it, and a second pattern reader here would stay a second rule that nothing uses. The new test asserts that no item, whatever it states, gets a citizenship field and that the statement is in the posting text word for word. Item 1, Differs 8, and Known gaps 6 say what this means for the item's sentence.
4. **事求人: an address that starts with a postal code repeats the county and loses its district (low): real, fixed.** `addressOf` leaves out a leading postal code (3 digits, or 3 with 2 or 3 more; bare, spaced, in brackets, full-width) when a county follows it. The unknown the review named is measured: 129 of 2,043 addresses, 121 with a county after the code; districts read on 939 records, about 115 more than before. Seven coded forms and two "digits that are not a postal code" cases are in the test.
5. **"27 elements per record" in four places (low): real, fixed.** The live file has 26 on every record. Corrected in `__fixtures__/twgov/README.md`, the header of `twGovJobs.ts`, the comment in `twGovJobs.test.ts` and Request 5 of this handoff. The wrong count had not reached a plan document (checked in MKT-5H's worktree and handoff).
6. **The register describes six rows as waiting for a merge that happens together with it (low): real, fixed in my file instead of left to the gate.** The six status cells are rewritten for the merged tree, the "M5 (MKT-5x)" markers and the sentence above the section 3 table are gone, and section 3 holds the variables of MKT-5A, MKT-5B and MKT-5E as their handoffs and worktrees have them (MKT-5H's Request 9 list, with the `INGEST_BANK_RESYNC_DAYS` correction). Because the test only checked the form of a status, two tests were added: every variable of section 3 is read by the server's source (with the all-or-nothing rule per sibling bundle for a tree that does not hold it yet), and no cell of sections 1 and 3 speaks of a merge, a phase or a plan. What remains for the gate is Request 4.

**Judged not done by the review: carry-over waveM3 MKT-5D.2** (`KNOWN_SOURCES` and the admin strings). Still not done, for the reason the review accepted: `components/v3/admin/SourcesConsole.tsx` and the `admin` namespace are outside my owns and have no owner in M5. It is Request 2, with the exact ids, the reason and the five strings in English and Chinese. Who acts: the orchestrator.

**Unowned edits:** none found by the review and none made in this pass.
