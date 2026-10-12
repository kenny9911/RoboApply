# MKT-5G

Sponsorship facts with source and date: the USCIS H-1B Employer Data Hub and the UK Register of Licensed Sponsors next to the DOL LCA loader (JI-11). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-5G`, branch `wp/MKT-5G`. Nothing committed, pushed, stashed or reset. No `*.prisma` file edited and nothing run against a database: the two new importers ran only as dry runs (now their default), on the synthetic fixtures, and never with `--apply`. No dev server, no browser, no model, no provider.

This is the handoff **after the independent review**. What the review changed is listed at the end under "Review resolution"; everything above it describes the tree as it is now.

**Network:** eight read-only reads of public government pages on 2026-10-12 (first session), to confirm names, headers and a licence. Nothing was saved to disk and no row was copied: the Home Office register page and its own preview of the CSV (gov.uk), the USCIS hub page, its glossary page and its yearly-files page, the first lines of two yearly files (`h1b_datahubexport-2023.csv`, `-2009.csv`: the header line and the shape of one row with the employer left out), and the Open Government Licence v3.0 text. The review session made no network request.

**Where what I built differs from the item text** (each is explained under its item):

1. The hub has **two column layouts**, not one with "four counts". Both are recognised; only the first was read from a file.
2. Both importers **replace a scope in one transaction** (a fiscal year of the hub; the whole UK register) instead of upserting row by row. Same end state as the items ask for, plus four refusals that protect stored rows.
3. **The importers write only with `--apply`.** The items show `[--dry-run]` as an optional switch, which makes writing the default. The bundles file's note on command-line tools ("the sponsor importers … default to a dry run or refuse without an explicit flag") and `MARKET_TASK_PLAN.md` ("The engineers deliver the CLI with a dry-run default") say the opposite, and they win. `--dry-run` is still accepted and means what the default already is.
4. The two datasets are **not rows of `jobDataAttributions()`**. That list is the datasets that ship in the repository, each with one copy date that `/legal` prints; these files are imported by the owner and have no such date (D3). They are a list of their own, and `/legal` needs a change outside my files (Request O-4).
5. The API answer has four additive fields beyond `MARKET_TASK_PLAN.md` 3.2: `viewerNeedsSponsorship`, `employerName` on the two register facts, `source.dated` and `source.attribution`; and the route takes an optional `?jobId=`.
6. Carry-over 2c: the bank rule is in the service's one predicate, not only in the route, so the list, the count and every other caller agree.
7. The job page shows the **newest fiscal year of each US source** and keeps the earlier years behind one line. The item describes a flat list; with up to eleven facts that list pushed the posting about two phone screens down.

## Items

### 1. [P1] USCIS H-1B Employer Data Hub loader: done

- `server/src/features/jobs/data/uscis.ts` (pure): `resolveUscisLayout(header)`, `parseUscisRow`, `createUscisAggregator` / `aggregateUscis`, `uscisRegisterRows`. `importUscis.ts` (CLI): `importUscisFile`, `parseUscisArgs`, `uscisReportLines`, `runUscisCli`. The LCA loader (`lca.ts`, `importLca.ts`, `lca.test.ts`) is untouched and its 17 tests pass.
- **Headers, read from the official site, recorded in the module header with URL and date:**
  - Yearly files (FY2009 to FY2023, linked from `https://www.uscis.gov/archive/h-1b-employer-data-hub-files`). `h1b_datahubexport-2023.csv`: `"Fiscal Year",Employer,"Initial Approval","Initial Denial","Continuing Approval","Continuing Denial",NAICS,"Tax ID",State,City,ZIP`. `h1b_datahubexport-2009.csv` writes the four counts in the plural (`Initial Approvals` …). Both spellings are accepted. `approvals` = initial + continuing approvals, `denials` likewise.
  - The hub's current fields. The hub itself (FY2009 to FY2026 Q3 on the day I read it) is an interactive page whose export a program cannot fetch, so **no file of this layout was read**. The names are the terms of the glossary on the hub's "Understanding Our H-1B Employer Data Hub" page (reviewed by USCIS 07/07/2025): `Fiscal Year`, `Employer Name`, and an `Approval` and a `Denial` column for each of New Employment, Continuation, Change with Same Employer, New Concurrent, Change of Employer, Amended. `approvals` = the six approval columns added up, `denials` the six denial columns. If a real export spells a column differently the import stops and names it (Known gap 1).
- Any other header fails before a row is read: `RegisterHeaderError` names the missing columns and the columns found, and says nothing was written. A renamed count column is a missing column, never a zero.
- **A count is never made up** (rule in `uscis.ts`, stated in its header):
  - a count cell that is missing or is not a whole number skips the row (`bad_count`);
  - a row whose count cells are all empty states no count and is skipped (`no_counts`); stored as 0 and 0 the page would print "0 H-1B petitions approved and 0 denied";
  - an empty cell beside stated counts is read as 0, and the report says in how many rows that happened ("Counted rows with an empty count cell, read as 0: N"), so the owner sees it before anything is written. Four zeros that the file states are a fact and are kept.
- **The reader never guesses a cell** (rule in `sponsorRegister.ts` `readRegisterCsv`, so it holds for both importers): a line with more or fewer cells than the header (a line cut short, an unquoted separator inside a name) is counted and left out, because its cells no longer sit under their columns. The report prints the number, and says so when the last line of the file is one of them ("the download may have been cut short").
- **Separator and encoding are read from the file.** The separator is a tab when the header line has more tabs than commas outside quotes, else a comma (`delimiterOf`). A file that starts with a byte-order mark is read in the encoding the mark names (UTF-8 or UTF-16), with no switch. The report prints both ("Columns separated by: tab · read as: utf16le").
- Rows are added up per `normalizeCompanyName(employer)` and fiscal year (one employer with several addresses has several rows). Skipped and counted: a row with no employer (the files have some), no fiscal year, or no usable count. Counts accept `1,234`.
- Written to `RASponsorRegisterEntry`: `source 'uscis_h1b_hub'`, `country 'US'`, `period 'FY<year>'`, `approvals`, `denials`, `employerName` (first spelling seen), `sourceFile` = the file name, `sourceUrl` = the hub page, `asOf` = `--as-of`.
- **CLI:** `npx tsx server/src/features/jobs/data/importUscis.ts <file.csv> --as-of YYYY-MM-DD [--apply] [--allow-shrink] [--encoding latin1]`, streaming with csv-parse.
  - Without `--apply` nothing is written: the file is read, the report printed, and the last line is "Dry run: nothing was written. Run again with --apply to write." This is also the default of the function (`importUscisFile` writes only with `apply: true`), so a caller that forgets the option cannot delete a stored year.
  - With `--apply` the database is resolved first (no database, no read: "--apply needs a database …"), then the report of the file and the line "Writing to database: `<host>/<database name>`" are printed before the first row is written. The connection string, its user, password and options never reach a printed line or an error message.
  - `--as-of` is required, must be a real date and not in the future. `--apply` together with `--dry-run` is refused.
- **Replace, not upsert.** Each fiscal year in the file replaces the stored rows of that year, in one transaction, in chunks of 1,000 (`sponsorRegister.ts` `replaceRegisterRows`). Why: a later file of a year can spell an employer differently ("the most common spelling per tax ID is used", the hub says), and an upsert would leave the old spelling beside the new one; and one round trip per employer, tens of thousands a file, is slow against a remote database (not measured). Importing the same file twice leaves one row per (source, employer, period). Refused, with nothing written: a file with no usable row; a file dated before the stored rows; a file with fewer than half the stored rows unless `--allow-shrink` (a download cut short, or an export filtered by state); and a file whose employer names hold characters that could not be read, until `--encoding` names its encoding (a wrong name matches no company).
- Fixture `__fixtures__/uscis.sample.csv`: the 2023 header and five placeholder rows (`EXAMPLE EMPLOYER LLC` on two rows, `SAMPLE ROBOTICS INC`, `PLACEHOLDER ANALYTICS CORP`, one row with no employer); tax id `0000`, state `ZZ`, ZIP `00000`. `__fixtures__/README.md` says every file there is synthetic and where each header was copied from.
- ACCEPT, all tested: the fixture as a dry run gives three aggregated rows (11 / 2, 35 / 3, 0 / 2) and writes nothing; an unknown header fails with the missing column named and writes nothing; two imports leave one row per (source, employer, period); the LCA tests pass unchanged.
- Tests: `uscis.test.ts` (31).

### 2. [P1] UK Register of Licensed Sponsors (Workers) loader: done

- `ukSponsors.ts` (pure), `importUkSponsors.ts` (CLI: `importUkSponsorsFile`, `parseUkSponsorArgs`, `ukSponsorReportLines`, `runUkSponsorCli`). Same reader, header rule, command line and writer as item 1: a dry run unless `--apply`, the database named before a write, uneven lines left out, separator and byte-order mark read from the file, the same four refusals.
- **Header, read from the gov.uk page's own preview of the file** `SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-10-09.csv` (10.4 MB, attachment of `https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers`): `Organisation Name`, `Town/City`, `County`, `Type & Rating`, `Route`. The four that are read are required; County is not stored (the table has no column for it).
- One entry per normalised organisation name: `routes` = the distinct routes in file order; `rating` = the distinct `Type & Rating` values in file order joined with `; ` (the lines of one organisation can differ: "Worker (A rating)" for one route, "Temporary Worker (A rating)" for another); `town` = the town when every line of the name states the same one, **null when they differ** (two organisations that share a name, or one with several sites: the register does not say which). `period ''`, `approvals` and `denials` null, `country 'GB'`.
- Each import replaces the stored snapshot in one transaction, so an organisation that left the register is gone. A register dated before the stored one is refused; so is one with fewer than half the stored organisations unless `--allow-shrink`.
- The report counts names with characters the encoding could not read. Such a file is never written until `--encoding latin1` (or `utf16le`) reads it.
- The page is under the **Open Government Licence v3.0**, which asks for an acknowledgement wherever the information is used. The licence's own sentence and address are in `sponsorSources.ts` (`UK_SPONSOR_REGISTER_LICENCE`), travel with the fact (`source.attribution`) and are printed with it on the job page.
- ACCEPT, all tested: one organisation on two routes is one row with both; an organisation missing from a newer file is gone; an unknown header fails without writing; a dry run writes nothing.
- Tests: `ukSponsors.test.ts` (18), fixture `__fixtures__/uk-sponsors.sample.csv` (placeholders).

### 3. [P1] Company sponsorship facts API: done; the `/legal` part not built (needs files outside the owns)

- New `server/src/features/jobs/companies/sponsorship/` (`contract.ts`, `service.ts`, `sponsorship.test.ts`) and the route `GET /api/v1/roboapply/companies/:id/sponsorship` next to `/:id/h1b` (`routes.ts`): optional session, flag `h1bHistory`, so GoApply answers 404 `feature_disabled`. The `/h1b` route is unchanged. `companies/contract.ts` re-exports the new contract, so the web reads the types through the existing mirror `lib/api/contracts/jobs/companies`. Web wrapper `lib/api/companyFacts.ts` (`getCompanySponsorship`).
- Answer `{ facts, disclaimer, viewerNeedsSponsorship }`. Fact kinds as in the plan; every fact has `source { name, url, sourceFile, asOf, dated, attribution? }`.
  - `dol_lca`: `fiscalYear`, `certifiedCount`; source name `US Department of Labor, LCA disclosure data`; `dated: 'imported'` because `RAH1bEmployerStat` holds the import time and no publication date (Schema request 1).
  - `uscis_h1b_hub`: `fiscalYear`, `approvals`, `denials`, `employerName`; `dated: 'published'`.
  - `uk_sponsor_register`: `town`, `rating`, `routes`, `employerName`; `dated: 'published'`; `attribution` = the OGL sentence and link.
  - `employerName` is the name as the record prints it, so a reader can see what the company's name matched.
- Rules: exact match of `RACompany.nameNormalized` against the stored key (no prefix, no similarity; a company with no row has an empty list and the disclaimer); at most five fiscal years per US source, newest first; a hub row without both counts is left out, never read as 0; a mainland company has no facts; another market's company is 404.
- `viewerNeedsSponsorship` (additive): true when the signed-in viewer's own answers say they need sponsorship in the country of the job named by `?jobId=` (a job of this company that the viewer may see). It is the feed's badge rule (`feed/items.ts` `needsSponsorshipFor`), restated in `needsSponsorshipIn` because that function is not on the feed's public surface; a test holds the two equal case for case (Request O-3). The viewer's answers come from `matchService.userContext`, loaded only when there is a fact to show; a failure there never fails the facts.
- **`jobDataAttributions()` was not extended, on purpose** (checked again at the review). Evidence: its own comment says "Every dataset the job pipeline ships with"; each entry needs a `YYYY-MM-DD` copy date that `/legal` prints as "Copy dated"; `compliance/disclosures.ts` `dataAttributions()` lists only entries whose licence requires credit and gives an unknown id the purpose "Job role categories"; `compliance.test.ts` requires every listed licence to match `CC BY` and every purpose to be one of three. So an entry for the UK register would have carried an invented date, appeared on `/legal` as "Job role categories" and turned that test red, and the USCIS entry would not have been listed at all. Built instead, in `jobs/data/sponsorSources.ts` (re-exported by `data/index.ts`): `sponsorshipDataSources()`, the three publications with publisher, page, licence, the acknowledgement a licence asks for, table and importer; and in `sponsorship/service.ts`: `sponsorshipSourcesInUse(db)`, the publications this database really holds rows of, each with the date of its newest rows. The facts route takes its source names from the same list. Listing them on `/legal` is Request O-4: it needs `features/compliance/` (no owner in any phase). Until then the UK licence's acknowledgement is printed where the fact is shown, which is what the licence asks for.
- ACCEPT, all tested: a company with LCA and USCIS rows returns facts that each show year, count and source (name, page, file, date); a UK-registered company returns one fact with rating and routes; no rows gives an empty list and the disclaimer; the route is disabled on GoApply and with the flag off; the LCA and `/h1b` tests pass unchanged. **Not met: "/legal lists them with their publishers"** (Request O-4, Known gap 4).
- Tests: `sponsorship.test.ts` (15: assembly per source, year cap, exact-name rule, empty case, missing counts, markets, the viewer rule, sources in use, no claim about a job), `companies.test.ts` (three new route tests: mount and what the service is handed, the flag on both brands, the real service through the route), `data.test.ts` (4 new).

### 4. [P1] The job page shows the company's sponsorship facts: done

- New `components/features/job/SponsorshipFacts.tsx`, mounted in `JobOverview.tsx` on RoboApply after the job's own work-authorization lines, as a section of its own. `JobOverview` has no company section (the Company tab is another component, not mine), so the block sits where the page already talks about sponsorship, visibly apart from the lines quoted from the posting.
- One line per fact, built only from the answer: "1,240 H-1B labor condition applications certified in fiscal year 2025", "11 H-1B petitions approved and 2 denied in fiscal year 2023", "Licensed sponsor on the UK register" with "Type and rating: … · Routes: … · Town: …". Under each: "Listed as {name} · Source: {publication as a link} · File: {file} · as of {date}" ("file imported {date}" for the LCA table). The UK fact also prints the licence's sentence, linked to the licence. Then one note on what the US counts are and the disclaimer. Dates are shown as the calendar day given at import, in every time zone.
- **A long record stays short** (`splitFacts`): the block shows the newest fiscal year of each US source and the UK entry, three lines at most, and keeps the earlier fiscal years behind one line ("8 records from earlier fiscal years"). Nothing is dropped: every earlier line is there with its own source, file and date, in the order of the answer. Which year is newest is read from the facts, not from their order. The note and the disclaimer stay outside that line. Estimated from `job.module.css` at 375px, not seen in a browser: about 650 to 800px for the fullest record, where the flat list was about 1,500 to 1,750px.
- Open for a viewer the server says needs sponsorship in the job's country; one line (`<details>`) for everyone else, with the same facts behind it. No facts, a failed request, or a pending one: nothing is rendered, and there is no "no records" sentence about the employer. GoApply never asks and never renders (flag `h1bHistory`, and `JobOverview` mounts it for the international market only).
- Design tokens only, both themes through the token layer. The block reuses `job.module.css` (`section`, `subTitle`, `list`, `body`, `muted`, `hint`, `linkBtn`) because that stylesheet is not mine. One thing found on the way: the global `a` rule (inherit colour, no underline) is unlayered and beats Tailwind utilities, so a link needs a module class; the block uses `.linkBtn` for links. The few utilities it uses (`flex flex-col gap-1`, `break-words`, the summaries' `py-3 text-action underline`) were compiled offline against `tailwind.config.ts` to confirm they resolve to tokens. A 61-character file name wraps at 375px (`break-words`).
- Strings: namespace `companyFacts`, 16 keys, staged in `i18n/staging/companyFacts.en.json`; `i18n/staging/index.ts` regenerated with `node scripts/i18n-merge-staging.mjs --index` (one import, one namespace, one entry).
- ACCEPT, all tested: year, count and source for each fact and the disclaimer; nothing rendered with no facts; no sentence says the job sponsors (the copy test reads every staged string and the rendered text; the only sentence that names the job is the disclaimer, and it is a denial); GoApply never renders it; `npm run check` passes.
- Tests: `components/features/job/sponsorshipFacts.test.tsx` (24).
- **Not seen in a browser** (the rules of the wave forbid one). Known gap 6.

### Carry-over, `waveM4-carryover.md` section MKT-5G

The carry-over files of M1, M2 and M3 have no MKT-5G section.

- **1. Done.** `JobSkillsDetailSchema`: kept as the gate left it (I added to `contract.ts` around it).
- **2c. Done.** A recruiter-bank row whose bank has no posting page is no longer listed or counted for a company. The rule is in `liveJobWhere` (`bankListableWhere` of the feed), the one predicate behind the list and the open-job count, so `GET /companies/:id/jobs`, the profile's count, the job page's "N open jobs" and the Assistant's company card all agree. The route passes its own environment (`CompanyReadViewer.env`); other callers read the process's. Tests in `companies.test.ts`: both banks, each bank alone, a GoApply route case. The control case of `modeOff.routes.test.ts` is red as the carry-over predicted; the carry-over asks me to give it the bank page settings, but the file is outside my owns, so the two-line change is under Red tests (verified on a copy).
- **2d. Not finished: the server half is done, the hold stays.** `CompanyReadViewer.printsCreditLine`: for a caller whose surface prints the line, rows that owe one are listed and counted and each item carries `cardMeta.tw_sources.attribution { text, url }` exactly as a feed card does (only that set; the other hook sets read columns this list does not select). Tested with the registered hook. The route does **not** turn it on, because the only reader, `components/features/company/CompanyTab.tsx` (no owner in M5), prints a title and a place: lifting the hold now would show a 台灣就業通 row with no credit line, which the rules of the domain forbid. So 台灣就業通 and 事求人 rows are still neither listed nor counted for a company. What is left is one line in `routes.ts` plus the tab: Request O-2, Known gap 5.

## Files changed

New:
- `server/src/features/jobs/data/sponsorSources.ts`, `sponsorRegister.ts`, `uscis.ts`, `importUscis.ts`, `ukSponsors.ts`, `importUkSponsors.ts`, `uscis.test.ts`, `ukSponsors.test.ts`
- `server/src/features/jobs/data/__fixtures__/uscis.sample.csv`, `uk-sponsors.sample.csv`, `README.md`
- `server/src/features/jobs/companies/sponsorship/contract.ts`, `service.ts`, `sponsorship.test.ts`
- `lib/api/companyFacts.ts`
- `components/features/job/SponsorshipFacts.tsx`, `sponsorshipFacts.test.tsx`
- `i18n/staging/companyFacts.en.json`

Changed:
- `server/src/features/jobs/data/index.ts` (re-exports `sponsorSources.ts`; a header note), `data.test.ts`
- `server/src/features/jobs/companies/service.ts` (`liveJobWhere`: the bank rule and `printsCreditLine`; `toCompanyJobItem(row, cardMeta?)`, `creditLineMeta`; `findCompanyRow` exported; `DOL_LCA_URL` now defined in `jobs/data` and re-exported), `routes.ts`, `contract.ts`, `index.ts`, `companies.test.ts`
- `components/features/job/JobOverview.tsx` (one import, one line)
- `i18n/staging/index.ts` (generated)

Changed at the review (all inside the list above): `sponsorRegister.ts`, `uscis.ts`, `importUscis.ts`, `importUkSponsors.ts`, `uscis.test.ts`, `ukSponsors.test.ts`, `data.test.ts`, `SponsorshipFacts.tsx`, `sponsorshipFacts.test.tsx`, `companyFacts.en.json`.

Not touched: `lca.ts`, `importLca.ts`, `lca.test.ts`, `staffing-agencies.json`, `industryMap.ts`, every `*.prisma` file, every file outside the owns. `git status` lists 25 paths, all inside the owns. Two temporary files existed for one command each and are deleted: a copy of the red test in my own folder (`companies/zzProbeModeOff.test.ts`, to verify its fix) and a type-check config (`server/tsconfig.mkt5g-probe.json`; that one sat in `server/`, outside the owns, for the length of one `tsc` run).

## Tests run

All on the final tree: no file changed after the first of these commands started.

- `npx vitest run server/src/features/jobs/data server/src/features/jobs/companies components/features/job`: 9 files, 223 tests passed. The seven test files I own hold 143 of them: `uscis.test.ts` 31, `ukSponsors.test.ts` 18, `data.test.ts` 6, `lca.test.ts` 17 (unchanged), `sponsorship.test.ts` 15, `companies.test.ts` 32, `sponsorshipFacts.test.tsx` 24. The other two the filter matches are untouched and green: MKT-5C's `job.test.tsx` (53) and `jobimport/JobImport.test.tsx` (27).
- `npm run typecheck:server`: clean. It excludes `*.test.ts`, so the test files of the two owned server folders were type-checked once with a temporary config: clean.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: all six gates pass (design, copy with 75 staging bundles, LLM costs, API boundary, extension, zh variants). `node scripts/i18n-merge-staging.mjs --dry-run` accepts the namespace.
- `npm run eval:match -- --enforce M4`: exit 0.
- `npx vitest run --exclude ".claude/**"`: **762 files, 761 passed, 1 failed; 19,747 tests: 19,735 passed, 1 failed, 1 skipped, 10 todo** (47 s, at a load average of about 25). The one failure is the expected one below.
- Both importers from the command line, as dry runs, on the fixtures: the printed reports are right and end with the dry-run line (exit 0); the USCIS importer on the UK fixture exits 1 with the missing columns; no arguments prints the usage line; `--apply --dry-run` is refused. Neither was run with `--apply`. What `--apply` prints, in which order, and that it refuses without a database is tested through `runUscisCli` / `runUkSponsorCli` with a fake database.

## Red tests for other bundles

- `server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts` › "jobs.companies on GoApply (signed-in viewer)" › "control: with postings allowed, the fixture posting is listed and counted" (`expected 0 to be 1`). **No bundle owns the file in M5: orchestrator, at merge.** Cause: carry-over 2c. Its fixture is a GoHire bank row and its environment sets no posting page, so the row is now held. The carry-over names the fix: give the control case the bank page settings.
  - line 65: `import { BANK_PAGES_ENV, FakeFeedRepo, feedRow } from '../../../feed/testkit.js';`
  - line 824: `const h = await companiesHarness({ ...MODE_ON, ...BANK_PAGES_ENV });`
  - The assertions stay (1 counted, 1 listed) and the mode-off case needs no change. **Verified:** a temporary copy of the file with exactly these two lines changed passes both cases of that describe; the file as it is fails the one case and passes its other 34.

## Pre-existing failures

None in the final run. For the gate: six files hold wall-clock limits that fail when the machine is loaded (seen in the first session at a load average of 150 to 220, none in a file I touched, none in the final run): `jobs/import/directFetch.test.ts` (200 ms), `cn/jobs/__tests__/text.test.ts` (250 ms), `jobs/import/html.test.ts`, `match/eval/run.test.ts` and `jobs/sources/atsPublic/atsPublic.test.ts` (5 s test timeout), `roboapply/v2/routes/index.unmounted.test.ts` (10 s hook timeout). Run the suite with nothing else on the machine.

## Requests

**Orchestrator**

- **O-1.** The red test above (two lines, verified).
- **O-2. Finish carry-over 2d (the company tab prints the credit line).** (a) `components/features/company/CompanyTab.tsx`, inside `others.map`, after `</Link>`: read `readTwSourcesMeta(j.cardMeta)?.attribution` (`components/features/market/tw/meta.ts`) and, when present, print it under the row as `JobMetaTw` does (`<p lang="zh-Hant">` with the sentence as a link to `attribution.url`, plain text when it has no address). The link needs a class of `company.module.css` with a colour and an underline: the global `a` rule removes both and beats utilities. (b) `server/src/features/jobs/companies/routes.ts`, `viewer()`: add `printsCreditLine: true` and delete the comment above it. (c) `feed/sourceLine.ts`: drop the company-list bullet from the `creditLineHeld` comment. No existing assertion changes: the route fixtures hold no such row; the service cases are already in `companies.test.ts`. Do (a) and (b) in one change, never (b) alone.
- **O-3.** `server/src/features/feed/index.ts`: `export { needsSponsorshipFor } from './items.js';`. Then `companies/sponsorship/service.ts` can import it and `needsSponsorshipIn` can go. Until then `sponsorship.test.ts` imports `feed/items.js` directly to hold the two equal: if MKT-5C renamed or changed that function in this phase, that test is the seam.
- **O-4. `/legal` lists the sponsorship publications** (the compliance area has no owner). `features/compliance/contract.ts`: add `'sponsorship_facts'` to `DATA_ATTRIBUTION_PURPOSES`. `disclosures.ts`: besides the shipped datasets, one row per entry of `sponsorshipSourcesInUse(prisma)` (exported from `jobs/companies/index.ts`; async, three small reads, cache it): `{ id: kind, purpose: 'sponsorship_facts', name, publisher, url, license, asOf: asOf.slice(0, 10) }`, and print `attribution.text` for the UK row. `compliance.test.ts` (`expect(a.license).toMatch(/CC BY/)` and the list of three purposes in "data attributions: every dataset whose licence requires credit") then has to accept `Open Government Licence` and the new purpose. Web: `legal.attributions.purpose.sponsorship_facts` = "Company sponsorship records". The section is titled "Data we credit … under a licence that asks for credit": only the UK register is that; the two US publications are public records with no licence stated, so list them only if the owner wants every source shown.
- **O-5. `docs/jobright-clone/market/MARKET_TASK_PLAN.md`** (no M5 bundle owns the file).
  - 3.2, row "Company sponsorship facts (JI-11)", as built: the answer also carries `viewerNeedsSponsorship`; the two register facts carry `employerName`; `source` carries `dated: 'published' | 'imported'` and, for the UK register, `attribution { text, url }`; the route takes `?jobId=`; `rating` can hold several values joined with `; `; `town` is null when the register lists the name in several towns.
  - The owner list, line "JI-11: download the USCIS H-1B Employer Data Hub files and the UK Register …": add "Each of the two new importers is a dry run until it is given `--apply`: run it, read the report, run it again with `--apply` (it prints the database's host and name before it writes). The LCA importer is older and writes unless `--dry-run` is given."
- **O-6 (OT-2).** Translate `companyFacts` (16 keys) into the other eight locales (it renders on RoboApply in every locale; GoApply never renders it). Keep the `<link>…</link>` tag and the ICU plurals (`fact.dolLca`, `fact.uscis`, `fact.ukRoutes`, `earlier`); "H-1B" and "fiscal year" (the US federal year, October to September) are terms; the source names, the register's own values (type and rating, routes, town) and the UK licence sentence are server data in English and are not translated. zh-TW: 財政年度 for "fiscal year"; do not translate "H-1B".

**MKT-5H**

- `ARCHITECTURE.md`, API table after `GET /companies/:id/h1b`: `GET /companies/:id/sponsorship?jobId=` | S/P | → `{ facts: SponsorshipFact[], disclaimer, viewerNeedsSponsorship }` (RoboApply, `flags.h1bHistory`; DOL LCA, USCIS H-1B Employer Data Hub, UK sponsor register; every fact with source name, page, file and date; never a statement about a job).
- Owner list (JI-11): the commands of Known gap 2. No new env variable: the importers read the existing `DATABASE_URL`.

**MKT-5D (optional)**

- `docs/job-search/SOURCE_REGISTER.md`, if the register also lists non-job data: three rows from `sponsorshipDataSources()` (plan: free public file; quota: none; surfaces: the employer block of the signed-in job page (the route itself also answers without a session); attribution: none for the two US publications, the OGL v3.0 sentence for the UK register; retention: replaced at each import; read 2026-10-12).

**MKT-5C and MKT-5F (for information: seams to look at when the phase merges)**

- MKT-5C: `job.test.tsx` renders `JobOverview` with every flag off, so the new block asks for nothing there. A test that turns `h1bHistory` on must mock `lib/api/companyFacts`. `sponsorship.test.ts` imports `needsSponsorshipFor` from `feed/items.js` (Request O-3).
- MKT-5F: `companies.test.ts` reads the credit sentence through `twSourcesHooks` and `TW_OGDL_LICENCE_URL` of `jobs/sources/twHooks.ts` and pins the 台灣就業通 sentence for 2026. A change to that sentence or to the hook's id shows up there.

## Schema requests

1. Optional, additive, `server/prisma/schema/ra-jobs.prisma`, model `RAH1bEmployerStat`:

   ```prisma
   /// Publication date of the DOL file the row was read from (the importer's --as-of); null for rows imported before the column existed.
   asOf DateTime?
   ```

   With it `importLca.ts` can take `--as-of` and the LCA fact can say "as of {date}" like the other two; today it says "file imported {date}".

Nothing else. `RASponsorRegisterEntry` is used as MKT-0 delivered it.

## Env variables added or redefined

None. With `--apply` the two importers name the database of the existing `DATABASE_URL` (the address `lib/prisma.ts` opens its pool on: pooled, else `DIRECT_DATABASE_URL`) by host and database name.

## i18n keys added or changed

New namespace `companyFacts` (`i18n/staging/companyFacts.en.json`, registered in `i18n/staging/index.ts`), 16 keys, all under `companyFacts.sponsorship`: `title`, `intro`, `fact.dolLca`, `fact.uscis`, `fact.uk`, `fact.ukRating`, `fact.ukRoutes`, `fact.ukTown`, `earlier` (added at the review: "{count} records from earlier fiscal years", a plural), `listedAs`, `source`, `file`, `dated.published`, `dated.imported`, `usNote`, `disclaimer`. No key of another bundle touched; no zh file (GoApply never renders the block). `disclaimer` is the same sentence as the server's `SPONSORSHIP_DISCLAIMER` (a test holds them equal).

## Known gaps

Last phase: each entry says the next step and who acts.

1. **The hub's current column layout was not read from a file** (FY2024 and later exist only as the hub's interactive export). *Owner:* export one fiscal year from the hub as CSV and run `importUscis.ts <file> --as-of <date>` (a dry run). Read three things in the report: whether it stops with missing column names (then add the real spelling to `HUB_FIELDS` in `uscis.ts`, one line per column with the date it was read, and a row to the test); the line "Columns separated by: … · read as: …" (comma and tab are handled, and a UTF-16 file with a byte-order mark needs no switch; a UTF-16 file without one needs `--encoding utf16le`; any other separator, a semicolon for one, is not handled and shows as missing columns); and "Lines with more or fewer cells than the header". Until then the facts stop at FY2023, which the yearly files cover today.
2. **No real file was imported and nothing ran against a database.** *Owner,* per database, after the M0 push:
   - `npx tsx server/src/features/jobs/data/importUscis.ts <h1b_datahubexport-YYYY.csv> --as-of <the date its page states>`: read the report, then the same command with `--apply`;
   - `npx tsx server/src/features/jobs/data/importUkSponsors.ts <SP_-_Worker_and_Temporary_Worker_Web_Register_-_YYYY-MM-DD.csv> --as-of YYYY-MM-DD`: read the report, then again with `--apply`.
   Check the line "Writing to database: host/name" the first time. Repeat when new files are published. The UK import is one transaction of about a hundred INSERTs (timeout 10 minutes); its real duration on Neon is unmeasured. The yearly-files page gives one "last reviewed" date (07/01/2025) for all files and no date per file: that is the date to give.
3. **`importLca.ts` still writes unless `--dry-run` is given.** It is older than this wave and item 1 says it "stays as it is" with its tests unchanged, so I did not touch it; the owner now has two importers that need `--apply` and one that writes by default. *Owner or orchestrator, if the three should agree:* in `parseLcaArgs` return `dryRun: !argv.includes('--apply')` and keep accepting `--dry-run`; `lca.test.ts` line 223 (`parseLcaArgs(['LCA_FY2026_Q3.xlsx'])`) then expects `dryRun: true`, and `importLcaFile` itself still writes unless it is handed `dryRun`.
4. **`/legal` does not list the three publications** (Request O-4; `features/compliance/` has no owner). The licence duty of the UK register is met where the fact is shown. *Orchestrator or a fix package.*
5. **The Company tab's job list still holds rows that owe a credit line**, so 台灣就業通 and 事求人 rows are not listed or counted for a company (carry-over 2d, Request O-2; `CompanyTab.tsx` has no owner). *Orchestrator or a fix package:* the tab and the one line in `routes.ts`, in one change.
6. **The block has not been seen in a browser.** *Orchestrator, at the browser pass:* RoboApply, light and dark, 375px and 1280px, a company with all three kinds and five years of each US source; open (a viewer who needs sponsorship) and behind its line; the "earlier fiscal years" line closed and open; the height above the job description at 375px; and GoApply (nothing shown).
7. **An empty count cell beside stated counts is read as 0.** The two yearly files I looked at state every count, so this is a rule for a file I have not seen, and the report counts the rows it touched. *Owner:* if a dry run prints "Counted rows with an empty count cell, read as 0" with a number above 0, look at one such row before applying. Also: a line cut inside its last cell has the right number of cells and is not caught; for the hub that cell is the ZIP, which is not stored, and for the UK register it is the route.
8. The DOL LCA fact is dated by import, not publication (Schema request 1).
9. **Exact-name matching, both ways.** A subsidiary, a trading name or a differently named legal entity does not match and shows nothing. Rows that normalise to one name are added together (several tax ids in the hub; several towns in the UK register, where the town is then left out). Each register fact prints the name the record uses ("Listed as …") so the reader can judge. No alias table exists; *owner:* if one is wanted it is a reviewed list, never a similarity match.
10. *Counsel,* low: the UK register can list sole traders under their own names, and the Open Government Licence does not cover personal data in the information. A register fact is shown only for an employer whose job we list, by exact name.
11. `viewerNeedsSponsorship` loads the whole match user to read two fields. It is asked only when there is a fact to show and the web keeps the answer for 30 minutes; a lighter read would need an export from the match or profile area.

## Review resolution

Unowned edits: the review found none, and there are none now.

1. **Judged not done: carry-over 2d (carry `cardMeta.tw_sources` on the list and remove the hold).** Verified, and it stays not finished. The server half is built and tested; removing the hold needs `components/features/company/CompanyTab.tsx` to print the line first, and no M5 bundle owns that file (checked against the owns of all eight bundles). Turning the route flag on alone would show a 台灣就業通 row without its credit line. Items now says "not finished"; Request O-2 has the exact change; Known gap 5 says who acts.
2. **Medium: both importers wrote by default, and the write deletes a stored scope.** Real. Fixed at the root, not only on the command line: `importUscisFile` and `importUkSponsorsFile` write only with `apply: true`, and `parseRegisterArgs` returns `apply` only for `--apply` (`--dry-run` is still accepted; both together are refused). A dry run ends with "Dry run: nothing was written. Run again with --apply to write." With `--apply` the database is resolved before the file is opened and printed as host and database name, after the report and before the first row (`runRegisterCli`, one function for both importers, tested with a fake database; the connection string never reaches a line). A file with unreadable names is refused for a write unless `--encoding` was given (`unreadable_names`), and the report says so before any write. Tests, both file headers and Known gap 2 are updated. The JI-11 line of `MARKET_TASK_PLAN.md` is not my file: Request O-5. `importLca.ts` is unchanged by design: Known gap 3.
3. **Medium: the merged tree is red until the modeOff control case gets the bank page settings.** Real, and it is the behaviour carry-over 2c asks for. The file is outside my owns, so it stays under Red tests for the orchestrator. I verified the reviewer's two-line fix on a temporary copy (both cases green) and deleted the copy.
4. **Low: the USCIS importer read a missing or empty count cell as 0.** Real. A missing cell now skips the row (`bad_count`), a row with no count stated is skipped (`no_counts`), and the root is closed in the reader for both importers: a line with more or fewer cells than the header is left out and counted, and the report says when the last line is one of them. An empty cell beside stated counts is still 0, now counted in the report (Known gap 7). Tests: the reviewer's two probes (a line cut after two counts; four empty count cells), a line with too many cells, and the UK equivalents.
5. **Low: the reader accepted comma-separated files only.** Real for a tab-separated export (I could not confirm the hub's format either). The separator is now taken from the header line, a UTF-16 file with a byte-order mark is read without a switch, and the report prints both. Test: a tab-separated UTF-16 file, with and without the mark, and tab-separated UTF-8. Known gap 1 now tells the owner to read that line in the same dry run.
6. **Low: the open block could push the posting about two phone screens down.** Real. I took the second option: the block stays where the page talks about sponsorship, shows the newest fiscal year of each US source and the UK entry, and keeps the earlier years in a `<details>` with the same source lines (one new string, `earlier`). Four new tests. To confirm at 375px in the browser pass (Known gap 6).
7. **Low: two pieces end in requests with no owner.** Both verified again and both need files outside the owns: (a) is point 1 above; (b) `/legal` needs `features/compliance/contract.ts`, `disclosures.ts` and one assertion of `compliance.test.ts`. Item 3 now says plainly that this ACCEPT line is not met; Requests O-2 and O-4 carry the exact changes and Known gaps 4 and 5 name who acts.
