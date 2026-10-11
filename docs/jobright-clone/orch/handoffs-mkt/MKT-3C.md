# MKT-3C

Posting identity and lifecycle: the exact posting key, canonical-row priority, JSearch link rules, expiry rules, carry-through fields. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-3C`, branch `wp/MKT-3C`. Nothing committed, pushed, stashed or reset. No schema edit, no database read or write, no new dependency, no dev server, no browser.

This is the handoff after the independent review. The review's seven findings and its one "not done" entry are answered one by one under **Review resolution** at the end; the sections before it describe the bundle as it now stands. Four findings were fixed in this bundle's files (1, 3, 4, 6), three need a file no M3 bundle owns and are exact Requests (2, 5, 7). The reviewer found no unowned edit, and there is none: `git status` shows only paths inside MKT-3C's owns.

All seven items are done. Every test in files I own is green (9 files, 1,495 tests), both typechecks pass for the whole repository, `npm run check` passes, `npm run eval:match -- --enforce M2` exits 0. The full suite has the same six red tests as before the review and no new one: two caused by this bundle in MKT-3A's files, both unavoidable (an item changes the value they pin), and four that fail in every worktree since 08:00 UTC today (a fixture date).

**History of the run.** The first session was interrupted and left source edits without tests; the second kept them, made the exact-twin step place-aware, wrote `maintain.ts`, the mainland pay rule, every test and the first handoff. This third pass is the review resolution.

**Network:** none in this pass. In the second session: six read-only GET requests to documented public board APIs, as the wave allows, with `RoboApplyJobs/1.0 (+https://www.roboapply.io)` and a 2-second pause, to confirm URL shapes (Greenhouse `boards-api.greenhouse.io/v1/boards/stripe/jobs`, Lever `api.lever.co/v0/postings/veeva`, Ashby `api.ashbyhq.com/posting-api/job-board/airwallex`, SmartRecruiters `…/companies/BoschGroup/postings` twice and one posting detail). Only field names and URL shapes were printed; nothing was saved. No RapidAPI, bank, model, payment or forbidden-site call at any time.

## Where this bundle departs from the letter of an item (PRECEDENCE: the documents win)

1. **Exact twins collapse only at the same primary place (item 2).** The item aligns every live row of a posting key onto one dedupe key. As written that hides jobs: the lists show canonical rows only (`feed/sql.ts` `scopePredicates`) and match a row by its PRIMARY location (`locationSql` reads `locationCity` / `geoLat` only), and an aggregator lists a multi-city posting as one row per city, each linking to the same ATS URL. Collapsing the Dallas row onto a canonical row whose primary city is Austin takes the posting out of every Dallas search, where it shows today. So a group is `(atsPostingKey, locationCountry, lower(locationCity))`. The acceptance line of JI-5 holds unchanged (a JSearch row and the board row of the same posting in the same city collapse although their titles differ). To get the literal rule back, delete the two place expressions in `buildPostingKeyAlignSql` and in `twinGroup` (`ingest/upsert.ts`).
2. **A deadline given as a calendar day runs through that day (item 5).** `'2026-10-20'` expires at the end of 20 October in the source's zone, not at its first minute. The item's own acceptance needs it ("a tw_open_data input with STOP_DATE is archived the day after"). A deadline with a time is that instant.
3. **Zone-less times are UTC+8 for the two Taiwan government sources too (item 5),** not only for market `cn`. Rule in one place: `naiveOffsetMinutesFor(provider, market)`.
4. **A skipped LinkedIn-only or Indeed-only row carries two notes (item 4):** `linkedin_only_link` (or `indeed_only_link`) and `no_apply_url`. See Requests (MKT-3F).
5. **The upsert snapshot gains six columns, not one.** Items 1 and 6 add five (`atsPostingKey`, `locationDistrict`, `workShift`, `sponsorship`, `sponsorshipSource`) and the M1 carry-over adds `headcount` (SCHEMA-8). After the review the three lifecycle lines of the statement also carry the reopening rule for 'expired' rows (item 5).
6. **`NO_DATE_EXPIRY_BOARDS` is kept, with its old value.** The expiry statement no longer reads it. `feed/sourceLine.test.ts` holds the feed's age-floor list equal to it and I may not edit that test. See Requests (orchestrator).
7. **Mainland bare-number pay (item 7) changes what PAR-7 built.** PAR-7 stored an ATS's unit-less numeric pair as disclosed amounts. Strategy 1.5 and JOB_SOURCES_CN 7.6 say such numbers are ambiguous and not filterable; the item says `salaryDisclosed false`. Now they are the posting's words only.
8. **Carry-over 7b is wider than my first reading and wider than the reviewer's fix.** See item 2 and "Carry-over".
9. **The domain rule is wider than the item's list of eleven suffixes (item 3).** The item names eleven two-part suffixes. The review showed that a fixed list merges different employers (two NHS trusts, two universities). The rule is now general; see item 3. One line of the first version changed with it: `careers.co.uk` gives null, not `careers.co.uk`.

## Items

### 1. [P0] `atsPostingKey` (JI-5; strategy 1.5 K2): done

- `normalize/ats.ts`: `atsPostingRefFromUrl(url)` → `{ ats, tenant, postingId }` as the URL writes them, `atsPostingKeyOf(ref)`, `atsPostingKeyFromUrl(url)`, `atsPostingKeyFromUrls(applyUrl, sourceUrl)`, all `'<ats>:<tenant>:<postingId>'` in lower case, or null. Patterns: Greenhouse (`boards.` and `job-boards.greenhouse.io/{token}/jobs/{digits}`), Lever (`jobs.lever.co/{site}/{uuid}` → `lever:`, `jobs.eu.lever.co` → `lever_eu:`), Ashby, SmartRecruiters (leading digits of the last segment), Workable (`apply.workable.com/{slug}/j/{shortcode}`), Workday (`{tenant}.wd{n}.myworkdayjobs.com/…/job/…/{slug}_{id}`, also with an `/apply…` tail), iCIMS. A page with only `?gh_jid=` gives null; a tenant that is not a board token gives null; nothing is ever guessed.
- `atsPostingKeyFromBoardRow(sourceBoard, externalId)`: the key of an employer-board row from its own board and `externalId` (`<boardToken>:<postingId>`). The normalizer uses it first for `ats_public` and falls back to the links. **Why it has to be the authority (measured):** Stripe's Greenhouse board sends all 729 of its postings to `https://stripe.com/jobs/search?gh_jid=<id>`, which names no tenant, so a URL parse alone would give the board's own rows no key. A `#cn` suffix (the mainland copy of a posting, JC-4) is not part of the key.
- `ATS_HOSTS` and `AtsType` gain `recruitee`, `personio`, `teamtailor`, `bamboohr`; `source.ts` has their display names.
- `NormalizedJob.atsPostingKey`; `upsert.ts` writes it (`JobUpsertRow`, `UPSERT_COLUMNS`, `toUpsertRow`, VALUES, `"atsPostingKey" = EXCLUDED."atsPostingKey"`).
- Measured shapes: Lever `hostedUrl` `jobs.lever.co/{site}/{uuid}`; Ashby `jobUrl` `jobs.ashbyhq.com/{org}/{uuid}`; SmartRecruiters `postingUrl` `jobs.smartrecruiters.com/{Company}/{15 digits}-{slug}`. SmartRecruiters answers the company identifier in any case, so the lower-cased tenant of the key is usable by discovery.
- The `RAJob.atsType` doc comment is in a `.prisma` file: see Schema requests.

ACCEPT, tested: a JSearch row linking to `boards.greenhouse.io/stripe/jobs/123` and the board row `stripe:123` both carry `greenhouse:stripe:123`; `?gh_jid=` only gives null; every pattern has positive and negative cases; the key on all eleven providers; the URL parse and the externalId agree for the four connectors; an existing row gets its key on the next ingest.

Tests: `normalize/ats.test.ts` (109), `normalizeProviderJob.test.ts`, `upsert.test.ts` and its snapshot.

### 2. [P0] Canonical row (JI-5, JC-7; strategy 1.5; critic C10): done, with deviation 1

- `source.ts` `PROVIDER_META`: `ats_public` 10 → 5, `bank_gohire` 15 → 3, `bank_robohire` stays 15.
- `upsert.ts`, two statements, `applyDedupe(db, market, keys)` unchanged in signature:
  1. `buildPostingKeyAlignSql` / `alignPostingKeyGroups`: live public rows of the market that share a posting key and a primary place take the `dedupeKey` of the group's best row. One `UPDATE … RETURNING` whose reads and write are each filtered by market.
  2. `buildDedupeSql(market, keys, alsoKeys)` ranks the given keys plus every key step 1 changed.
- Ranking order, in `CANONICAL_ORDER_SQL` and mirrored by `compareForCanonical`: for Taiwan rows disclosed pay first; `sourcePriority`; an apply link on an employer or ATS host before a job board's; then `postedAt` (nulls last), `firstSeenAt`, `id`.
- `maintain.ts`: `alignSourcePriority(db, market)`, `buildAlignPrioritySql`, `priorityTargets()`. Order of a maintenance run: expiry, missed refreshes, priorities, bank rows with no page, dedupe, enrichment catch-up.
- **After the review (finding 4): a bank row that cannot be listed never keeps the canonical flag.** The lists hold a bank row whose bank has no posting-page template, but dedupe ranks by priority only, so with GoHire at 3 a held GoHire row stayed canonical and hid the employer-board row of the same posting, the only row a candidate could open. `archiveDeadBankLinks` (step 4 of the run) now archives every open public row of a bank that has NO template as `no_apply_target`, in any state of its sync, through the listing-diff helper `archiveUnlistedJobs` with an empty listing. That is the state the bank sync itself produces when it runs without a template (`adapters/bank.ts`, `listing: { externalIds: [], reason: 'no_apply_target' }`); maintenance now reaches the rows the sync does not (sync off, no key, a failing sync). The archive counts as a touch, so the dedupe repair of the same run makes the board twin canonical.
- **And the step is self-healing.** Whenever it archives rows of a bank (either branch), it clears the stored cursor of that bank's sync (`buildRestartBankSyncSql`: `UPDATE "RAIngestQuery" SET "params" = "params" - 'cursor'` for that market and provider), so the next sync reads the bank from the beginning and the upsert reopens every row the bank still lists. This closes the case I named in the first handoff as the reason to stay narrow: a sync whose cursor already carries the current template's mark would have continued where it stopped and left the archived rows closed.

ACCEPT, tested: JSearch and board row of one posting collapse to the board row although their titles differ, and the alternate stays live with no close reason; a GoHire bank row beats the same employer's board row and a feed row for the same company, title and city **when its bank has a posting page**, and the board row takes over when the bank closes; with no posting page the GoHire rows are archived and the board row is canonical after one maintenance run (sync absent and sync disabled both tested; a second run changes nothing); the same posting key in `intl` and `cn` gives two independent canonical rows and a run for one market reads and writes no row of the other; a Taiwan open-data row with pay beats a JSearch twin without; after one maintenance run no live ATS row has 10 and no GoHire row has 15.

Tests: `upsert.test.ts` (61), `maintain.test.ts` (32), `normalizeProviderJob.test.ts`, `rules.test.ts`.

### 3. [P1] The employer's domain in the fuzzy key (JI-5; strategy 1.5 K3): done; the suffix rule rewritten after the review

- `company.ts` `registrableDomain(urlOrHost)`: lower case, `www.` and the seven career labels removed, then the public suffix and the one label in front of it. The suffix is found by rule (`publicSuffixLabels`), no longer by a list of eleven:
  - under a two-letter country code, a second-level label that names a category is part of the suffix: `co com org net edu gov ac or ne go gob govt gouv gv gc mil nhs police sch ltd plc me idv nom`. So `ucl.ac.uk`, `bartshealth.nhs.uk`, `ntu.edu.tw`, `foo.com.mx`, `cra-arc.gc.ca` each keep three labels, and the item's eleven suffixes are cases of the rule;
  - namespaces one level down: `*.sch.uk` (four labels), a US state code under `.us` (`austin.tx.us`) and `k12` / `cc` / `lib` under a state (`lausd.k12.ca.us`), a mainland province code under `.cn` (`acme.sh.cn`). The state and province codes are reserved names, so no employer's own domain is affected;
  - the bare suffix gives null (`gov.uk`, `ac.uk`, `nhs.uk`, `com.mx`, `edu.tw`, `gov.sg`, `ca.us`, `sh.cn`);
  - a careers label standing directly on a multi-part suffix gives null (`www.gov.uk`, `jobs.nhs.uk`, `careers.gov.sg`, `jobs.ac.uk`): that is a sector's shared portal, not one employer.
  Null always means "use the company name", which is the safe side. IP, single label, malformed host and shared hosts give null as before.
- `employerDomain(urlOrHost)` adds the employer-host test (not a job board, not an ATS).
- `identity.ts` `dedupeKey(company, title, place, employerDomain?)`: with a domain `sha1('d:' + domain + '|' + title + '|' + place)`, without one byte-identical to before.
- `normalizeProviderJob.ts`: the row's stated domain (`companyFacts.domain`, then `companyFacts.website`), else `ctx.companyDomains.get(companyNameNormalized)`, each through `employerDomain`.

ACCEPT, tested: the three `registrableDomain` examples and 98 more cases (101 in all), 23 for `employerDomain`; "Stripe" with a stated website and "Stripe, Inc." through the map get one key; two "Summit" with different domains differ; with neither, every provider's key equals the name key; a job-board, ATS or shared host as "website" falls back to the name. **New:** two differently named employers under `nhs.uk`, `ac.uk`, `edu.tw`, `gov.uk` and `com.mx` get different dedupe keys through `normalizeProviderJob` for JSearch and the feed, each key being the employer's own three-label domain; a website that is only the suffix or the sector portal gives the name key.

### 4. [P0] JSearch link rules (JI-6; strategy M-3): done

- `ats.ts`: `pickEmployerLink(urls)` → `{ url, direct, only }`, `applyLinkKind`, `isIndeedHost`, `isLinkedInHost`.
- `normalizeProviderJob.ts`: one table, `LINK_LIST_PROVIDERS` (`jsearch`). For those the apply link is `pickEmployerLink([applyUrl, sourceUrl])`; with none, `applyUrl` is null and the note names the site.
- `identity.ts` `resolveExpiresAt(provider, expiry, postedAt, { boardLink, naiveOffsetMinutes })`: `AGGREGATOR_BOARD_LINK_DAYS = 21` for a JSearch row whose chosen link is on a job-board host; 45 on an employer or ATS host.
- `adapters.ts` `inputFromJSearchJob`: the link is chosen by host; `is_direct` only confirms the chosen link.

ACCEPT, tested end to end: LinkedIn-only and Indeed-only rows have no apply URL and their note; `totaljobs.com` is kept with `postedAt + 21 days`; `jobs.lever.co` keeps 45 days, is direct and carries its posting key; an employer link wins wherever it stands in the list; no LinkedIn URL reaches `applyUrl`, `sourceUrl` or `originalHost`.

### 5. [P0] Expiry (JI-10, JT-2, JI-8; strategy M-22): done, with deviations 2, 3, 6; reopening added after the review

- `identity.ts`: `AGE_EXPIRY_PROVIDERS`, `AGE_EXPIRY_BOARDS` (`activejobs`, `linkedin`, `jsearch`), `NO_DATE_EXPIRY_PROVIDERS`. `resolveExpiresAt`: a stated deadline for every provider except `user_import`; a life from the posting date only for the aggregators; none for employer boards, both banks, `tw_open_data`, `tw_gov_jobs`, `usajobs`.
- `toDate(value, naiveOffsetMinutes)` and `deadlineInstant`: a string with no zone is a wall-clock time in the source's zone; a Date, an epoch or a string that names its zone is never shifted.
- `maintain.ts` `buildExpireSql`: `"expiresAt" < now()` for every board, or `"expiresAt" IS NULL AND "sourceBoard" = ANY(AGE_EXPIRY_BOARDS) AND "postedAt" < now() - 45 days`.
- **After the review (finding 3): a row closed as 'expired' is reopened by a listing that says it is open again.** Before this bundle only an aggregator's row could be 'expired'; now any source's row can, and the upsert reopened only `source_removed`, `bank_closed` and `no_apply_target`. A 台灣就業通 posting renewed with a later STOP_DATE, or a Greenhouse posting whose deadline was extended or removed, would have stayed archived for good while its source lists it. `upsert.ts` now has one rule for the three lifecycle columns (`REVIVE_ON_RELIST_SQL`, mirrored by the pure `revivesOnRelist`): the three source closures as before, and `'expired'` when `EXCLUDED."expiresAt" > now()`, or when `EXCLUDED."expiresAt" IS NULL` and the board is not one of `AGE_EXPIRY_BOARDS`. An aggregator's row that ran out by age comes back with the same past `postedAt + 45 / 21 days` and stays closed. `reported` and `duplicate` always stand. The board list is inlined from the constant, so the statement gains no parameter. The first branch keeps its exact text, so `pipeline.test.ts` line 225 (MKT-3A's) still passes.

ACCEPT, tested: an `ats_public` posting from 300 days ago has no expiry and survives; with a deadline it has that one and is archived once it passed; a `tw_open_data` STOP_DATE ends with that day in Taiwan; a JSearch row without expiry goes by age, an ATS row never; a zone-less mainland time is stored 8 hours earlier. **New:** 19 table cases of `revivesOnRelist` (deadline extended, deadline removed on a board or bank row, the same passed deadline, aggregator rows by age not reopened, `reported` / `duplicate` stand) and the same rule end to end through the normalizer for `ats_public`, `tw_open_data`, `jsearch` and `activejobs`; the statement text for all three columns.

### 6. [P1] Carry-through fields (JI-7, JI-11, JT-7): done

- `types.ts`: `WORK_SHIFTS`, `WorkShift`, `SponsorshipReading`; `NormalizedJob.sponsorshipProvider`, `locationDistrict`, `workShift`.
- `upsert.ts`: `locationDistrict`, `workShift`, `headcount` as `EXCLUDED` values. Sponsorship by one CASE for both columns (`sponsorshipSql`): a quoted row keeps what it has; else a reading is stored with `'provider:<provider id>'`; else a stored `provider:…` reading is cleared; anything else stands.

ACCEPT, tested: `offered` from `activejobs_feed` gives `sponsorship 'offered'` and `sponsorshipSource 'provider:activejobs_feed'`; the CASE text for both columns; district and shift round-trip; an unknown shift is dropped.

### 7. [P1] Checks the parity wave left (JI-5, JC-7): done; two rules fixed

- `1.5-2.5万` → 15,000-25,000 CNY a month: passes as built. `15-25K·14薪` keeps 14 months: passes. No pay text → every pay field null: passes.
- **Failed and fixed (`salary.ts`):** the bare pair. For a mainland row, figures that name no unit (no currency, period, N薪, K / 千 / 万) are kept as posted in `salaryText`, with no amount and `salaryDisclosed false`. One rule: `ParsedPay.ambiguous` from the parser, and the fields path of `normalizeSalary`. Outside the mainland nothing changed (tested).
- **After the review (finding 6): `/天` and `/日` are a unit.** The day pattern of `PERIOD_IN_TEXT` ended in `\b`, which never holds between a CJK character and the end of the text, so `200-300/天` had no period and fell under the new bare-pair rule (hidden as "no unit"; before this bundle it was stored as CNY 200-300 with no period). The pattern now reads `/天` and `/日` wherever they stand, except before 本 or 期. `200-300/天`, `200-300/日`, `200-300 / 天`, `每日200-300`, `每天200-300`, `300元/天`, `150/小时` are a day (or hour) rate in yuan, disclosed. The fix is in the shared period table, so a Taiwan row written `200-300/天` is now a TWD day rate too (it was TWD with no period).
- Phone numbers and WeChat ids: the strip is PAR-11's `stripContactInfo`; `text.test.ts` pins the seam from the normalizer's side.
- Tracker: `features/tracker/openedRow.test.ts` (5 tests). A tracker entry stays on the row the user opened; no code in the repository reads `canonicalJobId`.

### Carry-over

**waveM1, section MKT-3C**
1. Kept (`titleMatchScore`, `ROLE_FROM_INGEST`): untouched.
2. **Done.** `currencyFromText`: `US$` is USD and `CA$` is CAD; the one-letter prefixes count only when no letter stands before them; `NZ$` added.
3. Done in item 5.
4. Done in items 3 and 6; `headcount` is written.
5. **Left, on purpose** (`foldTwToCn` lacks 內, 顧, 問, 講, 廚, 術, 門). The fold is no longer only a title matcher: `features/skills/keys.ts` builds every skill's stored comparison key from it and `features/retrieval/hantHans.ts` every stored search token. Adding 術 changes the key of every stored skill that contains 技術 and the tokens of every indexed posting that contains it, so the table can only grow together with a skill re-key and a re-index, which are owner-run steps. The reviewer read this and judged the reason sound. See Requests (owner).
6. Present since the gate; kept.
7. PAR 6: done (item 2). PAR 7a: no reader is in my files; see Requests. **PAR 7b: done, now in full.** `maintain.ts` `archiveDeadBankLinks`: (a) a bank with no posting-page template has every open public row archived as `no_apply_target`, whatever its sync does; (b) a bank with a template whose adapter is absent or not enabled has the rows archived whose `applyUrl` is not the bank's page for that job, and rows whose link works stay listed. After either, the bank's sync cursor is cleared, so nothing can be stranded. My first handoff did only (b) and did nothing without a template, on the reasoning that the readers hold those rows; the review showed that the hold does not cover the twin (item 2).
8. Not mine (MKT-3E).
9. Kept (`TW_FLOOR_*`): untouched.

**waveM2, section MKT-3C**
1. Optional fold characters: left, same reason as M1.5. The question asked: yes, one table can serve all three. The right one is the Unihan table of `retrieval/hantHans.ts` once it is generated (Owner 14), as the character layer under the vocabulary terms of `zhVariants.ts`.

**wavePAR, "Market waves", entries 1 to 7b**
1. `'linkedin'`: left. `PROVIDER_META.linkedin` cannot go while the literal is in `platform/brand/registry.ts` (no owner); MKT-3A's handoff gives the order.
2, 4, 5, 7: not my files. 3: done (`headcount`). 6: done. 7a: Requests. 7b: done.

## Files changed

All inside MKT-3C's owns. 18 modified, 2 new. No file outside the owns was edited at any point, so there was nothing to revert.

- `server/src/features/jobs/normalize/`: `ats.ts`, `company.ts`, `identity.ts`, `index.ts`, `normalizeProviderJob.ts`, `salary.ts`, `source.ts`, `types.ts`, `adapters.ts`; tests `normalizeProviderJob.test.ts`, `rules.test.ts`, `salary.test.ts`, `text.test.ts`; new `ats.test.ts`.
- `server/src/features/jobs/ingest/`: `upsert.ts`, `upsert.test.ts`, `__snapshots__/upsert.test.ts.snap`, `maintain.ts`, `maintain.test.ts`.
- New `server/src/features/tracker/openedRow.test.ts`.
- Outside the worktree: this handoff only.

Changed in the review pass: `normalize/company.ts`, `normalize/salary.ts`, `ingest/upsert.ts`, `ingest/maintain.ts`, and the tests `rules.test.ts`, `normalizeProviderJob.test.ts`, `salary.test.ts`, `upsert.test.ts` with its snapshot, `maintain.test.ts`.

New exports of `normalize/index.ts`: `applyLinkKind`, `atsPostingKeyFromBoardRow`, `atsPostingKeyFromUrl`, `atsPostingKeyFromUrls`, `atsPostingKeyOf`, `atsPostingRefFromUrl`, `isIndeedHost`, `pickEmployerLink`, `employerDomain`, `registrableDomain`, `AGE_EXPIRY_BOARDS`, `AGE_EXPIRY_PROVIDERS`, `AGGREGATOR_BOARD_LINK_DAYS`, `NO_DATE_EXPIRY_PROVIDERS`, `deadlineInstant`, `naiveOffsetMinutesFor`, `MAX_DISTRICT_CHARS`, `WORK_SHIFTS`, and the types `ApplyLinkKind`, `AtsPostingKeyAts`, `AtsPostingRef`, `EmployerLinkPick`, `ExpiryOptions`, `SponsorshipReading`, `WorkShift`.

New exports of `ingest/upsert.ts` in the review pass: `REVIVED_CLOSE_REASONS`, `EXPIRED_CLOSE_REASON`, `revivesOnRelist`, type `RelistedRow`. Of `ingest/maintain.ts`: `BANK_SYNC_PROVIDER`, `buildRestartBankSyncSql`.

`MaintainResult` has `priorityAligned` and `deadBankLinks`; `runMaintenance` takes an optional `deadBankLinks` option. `deadBankLinks` now also counts the rows of a bank with no posting page.

## Tests run

All in the worktree, after the last edit.

| Command | Result |
|---|---|
| Owned files: `npx vitest run server/src/features/jobs/normalize server/src/features/jobs/ingest/upsert.test.ts server/src/features/jobs/ingest/maintain.test.ts server/src/features/tracker/openedRow.test.ts` | 9 files, **1,495 passed**: `salary.test.ts` 541, `rules.test.ts` 305, `normalizeProviderJob.test.ts` 200, `level.test.ts` 185, `ats.test.ts` 109, `upsert.test.ts` 61, `text.test.ts` 57, `maintain.test.ts` 32, `openedRow.test.ts` 5 |
| `npx vitest run server/src/features/jobs` | 53 files: 2,735 passed, 2 failed (the two under "Red tests"), 6 todo |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 716 files, 17,564 tests: **17,547 passed, 6 failed in 3 files**, 1 skipped, 10 todo. The six are listed below; nothing else is red |

The review pass added 85 tests and made no test outside the owns fail that passed before it.

## Red tests for other bundles

Both in files MKT-3A owns, both caused by a value an item of this bundle changes on purpose. Unchanged by the review pass.

1. **MKT-3A**, `server/src/features/jobs/ingest/pipeline.test.ts` › "bank sync through the pipeline › GoHire: market cn, fromRecruiterBank, no consent → …" (line 137): expects `sourcePriority: 15` on a GoHire row. It should assert `sourcePriority: 3` (item 2; strategy 1.5, critic C10).
2. **MKT-3A**, `server/src/features/jobs/ingest/cron.test.ts` › "maintenance SQL › expires public postings past their expiry or 45 days old — never a bank job or a public ATS board posting (WP-42)" (line 233): snapshot of the old statement, `toContain('"sourceBoard" <> ALL(')` and the values. It should assert `toContain('"sourceBoard" = ANY(')`, `rec.values` equal to `['intl', ['activejobs', 'linkedin', 'jsearch'], 45]`, and take the new snapshot (`npx vitest run server/src/features/jobs/ingest/cron.test.ts -u` changes that one entry). The exact statement is pinned as text in `maintain.test.ts`. The other `jobs-maintain` tests of that file pass as they are, with the new step 4 included.

## Pre-existing failures

- **`components/features/copilot/__tests__/cards.test.tsx`, 4 tests** (two `filter_diff`, one `memory_add`, one "WP-50 producers ↔ WP-51 cards"): they fail alone and on any worktree since 2026-10-11 08:00 UTC. `components/features/copilot/__tests__/wireCards.ts:199` builds the proposals with `expiresAt: new Date(NOW.getTime() + 86_400_000)` and `NOW` is `2026-10-10T08:00:00Z`; the cards compare that with the real clock and render "This suggestion expired". My diff touches no web file and nothing under `features/copilot`. Fix for whoever owns the file: use a far-future instant, as line 271 of the same file does.

## Requests

**Orchestrator: three changes from the review in files no M3 bundle owns**

1. **Review finding 2, `server/src/roboapply/v2/lib/raCrossBankMatch.ts` line 834 (no owner in any phase).** `mapRecruiterJobToRAJobUpsert` puts the literal `sourcePriority: 15` into `data`, which is used for create AND update, for either bank, and `RACrossBankSearchService.ts` upserts with it on every cross-bank search of a bank that is not read from the mirror. A GoHire row a search touches goes back from 3 to 15; the next board ingest of its group makes the board row canonical, the daily maintenance sets 3 again, and the canonical row of the group alternates. Exact change: replace the literal with `PROVIDER_META[c.bank === 'gohire' ? 'bank_gohire' : 'bank_robohire'].sourcePriority` (import `PROVIDER_META` from `features/jobs/normalize/index.js`, which that file already imports from), or take `sourcePriority` out of the update half, since the bank sync owns the row once it exists. Add to the cross-bank mapping test: the value equals `PROVIDER_META`'s for both banks. Nothing in my files can prevent this write; `alignSourcePriority` only repairs it once a day.
2. **Review finding 7, `server/src/features/jobs/import/repository.ts` `findPublicMatch` (lines 165-175, no owner).** A pasted job is matched to a public canonical row by URL or by the import's `dedupeKey`. An import states no domain, so its key is the name key, while public rows now often carry a domain key or a key adopted from an exact twin; when the pasted URL is not exactly a stored `applyUrl` / `sourceUrl` the import no longer links to the public row and a private duplicate is created. Exact change: add the posting key to the match, `if (match.atsPostingKey) or.push({ atsPostingKey: match.atsPostingKey })` (the normalizer already gives a `user_import` row its `atsPostingKey`; pass it through the caller's match object), and pass `ctx.companyDomains` to the import's `normalizeProviderJob` call once MKT-3A's map exists, so both sides compute the same key.
3. **Review finding 5, a decision for the owner, then `features/seo/scope.ts` and the public job page (`jobs/detail/view.ts`, MKT-5C in M5).** Public surfaces require `isCanonical AND publicDisplay`. A bank row gets `publicDisplay` only with recorded syndication consent, and the bank schema has no such field yet, so a canonical GoHire row is never publicly displayable. With `bank_gohire` at 3, wherever an operator lists `ats_public` in `PUBLIC_DISPLAY_PROVIDERS`, a mainland posting that has both a GoHire row and a board row leaves GoApply's public pages and sitemap once the GoHire row is canonical (before, the board row at 10 beat the bank row at 15). The priority is the strategy's ruling (C10), so I did not touch it. Either accept it (it is under Known gaps), or let the public-scope readers show the best `publicDisplay` row of a group when its canonical row is not publicly displayable. Do not put `publicDisplay` ahead of `sourcePriority` in the ranking: that would undo C10 for every bank row. Note that this only arises while GoHire has a posting page; without one its rows are archived and the board row is canonical.

**Orchestrator: from the first handoff, unchanged**

- **The feed's age floor does not know the new sources.** `feed/sourceLine.ts` `NO_AGE_FLOOR_BOARDS` (no owner in any phase) lists the banks and the four ATS names, and `ageFloorSql` (`feed/sql.ts`, MKT-4F in M4) applies the 120-day floor to every other board. So a `tw_open_data`, `tw_gov_jobs` or `usajobs` row, and a row of a board system added in M5, is hidden once its posting date is older than 120 days, although ingest keeps it open (JI-10). Root change: apply the floor where `j."sourceBoard" = ANY(AGE_EXPIRY_BOARDS)` or the row is a user's import, drop `NO_AGE_FLOOR_BOARDS`, and let `sourceLine.test.ts` compare with `AGE_EXPIRY_BOARDS`. Then `NO_DATE_EXPIRY_BOARDS` in `maintain.ts` can be deleted.
- PAR 7a, the other readers with their own age window, none in my files: `FeedQueryService.publicList` (45 days for every row; MKT-5C owns the file in M5), `features/alerts/repo.ts` `candidateJobIds`, the SEO pages (`expiresAt` only, which is right now that deadlines are stored).
- The copilot fixture date (Pre-existing failures).
- After the M3 merge, the JI-5 acceptance across bundles: MKT-3D's discovery should see `atsPostingKey` on the hook object for a JSearch row that links to a board.
- `sourceLine.ts` `heldBankBoards` says in its comment that the hold is "the read-side twin for rows … while the bank's sync does not run". After this bundle maintenance archives those rows within a day; the hold stays right as the safety net between runs. Comment only.

**MKT-3A**
- The two red tests above.
- Your `companyDomains` keys match (`companyNameNormalized`); values are reduced and refused here as planned. A value that is only a suffix or a sector portal (`nhs.uk`, `www.gov.uk`, `jobs.ac.uk`) is refused too and the name key is used.
- `pickEmployerLink`, `applyLinkKind` and `isIndeedHost` are exported from `normalize/index.ts` if you want the client and the normalizer on one function. Not required.
- The upsert now reopens an 'expired' row under the rule of item 5. `pipeline.test.ts` line 225 still passes as written (the text it pins is kept).
- Maintenance step 4 writes to `RAIngestQuery` (it removes `params.cursor` of a bank's sync, only after it archived rows of that bank). If `pipeline.ts` or the planner ever stores the bank cursor elsewhere, `buildRestartBankSyncSql` in `maintain.ts` has to follow.

**MKT-3D**
- `job.atsPostingKey` on the hook object is `'<ats>:<tenant>:<postingId>'` in lower case, the tenant included. If you want the tenant as the URL writes it, `atsPostingRefFromUrl(job.applyUrl ?? job.sourceUrl)` returns it. `ats` values: `greenhouse`, `lever`, `lever_eu`, `ashby`, `smartrecruiters`, `workable`, `workday`, `icims`.
- A `#cn` suffix on `externalId` is ignored by the key.
- A board's stated deadline is honoured: pass it as `expiresAt` (Greenhouse lists `application_deadline`). A posting archived because its deadline passed is reopened when the board lists it with a later deadline or with none.

**MKT-3E**
- Pass STOP_DATE as `'YYYY-MM-DD'` or `'YYYY/MM/DD'` (a calendar day: open through that day in Taiwan, stored as `…T15:59:59.999Z`) or as an ISO instant with its zone. A Republic-of-China year has to be converted by the adapter. If a test of yours pins `expiresAt` for a date-only STOP_DATE at midnight UTC, it should assert the end of that day in UTC+8.
- A vacancy whose STOP_DATE passed and that the source lists again with a later STOP_DATE is reopened by the upsert. One listed again with the same passed date stays closed.
- `locationDistrict` is stored as you send it (40 characters); `workShift` must already be one of `day | evening | night | rotating | part_time`.
- A pay text written `日薪 1500`, `1500/日` or `1500/天` is a day rate.

**MKT-3F / orchestrator** (`ingest/status.ts`, no M3 owner)
- `SOURCE_STATUS_NOTES` does not hold `linkedin_only_link` and `indeed_only_link`, so the sources panel shows such a row under "no apply URL" only. If the panel should say why, add the two reasons and two sentences under `admin.console.sources.skips.*`. Nothing breaks without it.
- The panel may want to say when a bank's rows are closed because the bank has no posting page: the count is `deadBankLinks` in the `jobs-maintain` result, and the admin system check already reports the missing template.

**MKT-4D**
- Until your item 6, enrichment that answers `not_stated` on an enriched row sets `sponsorship` to null and leaves `sponsorshipSource = 'provider:…'`; the next ingest writes the reading again. Your rule (c) ends that.

**MKT-5B**
- A new board system needs a line in `BOARD_KEY_ATS` (`normalize/ats.ts`): `ats.test.ts` iterates `PUBLIC_ATS` and fails otherwise. `priorityTargets()` in `maintain.ts` reads `PUBLIC_ATS`, so its rows are aligned without a change.
- A Lever EU board row needs its own `sourceBoard` (or the key will read `lever:` from the externalId while its links give `lever_eu:`).

**Owner of `features/cn/jobs/salary.ts`** (no bundle in M3)
- `cnSalary` answers "薪资未披露" whenever `salaryDisclosed` is not true. A mainland row whose pay is a bare pair now has `salaryText: '35-57'` and `salaryDisclosed: false`, so the GoApply card says "not disclosed" while the posting printed two numbers. To show them as posted, let `cnSalary` return the stored text when `statesAmount(salaryText)` holds.

**Owner**
- The Traditional-to-Simplified fold (M1 carry-over 5, M2 carry-over 1): one step that generates the Unihan table, re-keys `RASkill` and re-indexes the search documents; then the three tables become one.
- Decision asked: deviation 1 (exact twins collapse at the same primary place).
- Decision asked: review finding 5 (Requests, orchestrator 3).
- Operations: `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` (and the RoboHire one) decides whether a bank's rows exist in the lists at all. While it is unset, the first `jobs-maintain` archives every open row of that bank; once it is set and the sync runs, the rows come back on the first full sync. Two environments that run crons against one database with different templates would archive and reopen each other's bank rows; keep the template identical wherever the crons run.

## Schema requests

No column, index or model is needed: everything this bundle writes exists since MKT-0 and SCHEMA-8. Two doc comments in `server/prisma/schema/ra-jobs.prisma` are out of date (comment only, no diff for the database):

```prisma
  /// 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'smartrecruiters' | 'icims' |
  /// 'workable' | 'taleo' | 'successfactors' | 'moka' | 'beisen' | 'feishu' | 'dayee' |
  /// 'recruitee' | 'personio' | 'teamtailor' | 'bamboohr' | 'other'
  atsType              String?

  /// Lower wins (normalize/source.ts PROVIDER_META): GoHire bank 3, employer boards 5, usajobs 8,
  /// activejobs 10, Taiwan open data 12, RoboHire bank 15, linkedin 20, jsearch 30, user_import 90.
  sourcePriority Int     @default(50)
```

## Env variables added or redefined

None added. One existing pair has a wider effect, stated above under Requests (owner): `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` / `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` unset or unusable now means the daily maintenance archives that bank's open rows as `no_apply_target` (they were already on no list), not only that the readers hold them.

## i18n keys added or changed

None. The bundle owns no namespace and adds no copy.

## Known gaps

- **Nothing ran against a database.** The statements `buildPostingKeyAlignSql`, `buildAlignPrioritySql`, the new `buildExpireSql`, `buildRestartBankSyncSql`, the sponsorship CASE and the reopening CASE are tested as text and parameters, and through in-memory tables or pure mirrors that apply the same rules; Postgres has not parsed them. The first is the one to read before the first run: a data-modifying CTE with `DISTINCT ON` over three expressions and `UPDATE … FROM … RETURNING`. `buildRestartBankSyncSql` uses the jsonb `-` operator on `RAIngestQuery.params` (a Prisma `Json` column).
- **What the first runs after the merge do.** The first `jobs-maintain` per market writes the new priority on every live employer-board row and every live GoHire row once, archives every open row of a bank that has no posting page (those rows were on no list) and clears that bank's sync cursor, and the dedupe repair then regroups. A row gets its posting key, its domain key and its new expiry only when its source lists it again; until both twins of a pair were re-ingested they can sit in two groups. Stored JSearch rows whose only link is LinkedIn or Indeed are no longer refreshed and leave by the missed-refresh rule or their stored expiry. A mainland row with a bare numeric pay becomes "not disclosed" at its next ingest.
- **The cross-bank writer still stores priority 15** on the GoHire rows it touches (review finding 2; Requests, orchestrator 1). Until that literal is changed, the canonical row of such a group can alternate between the bank row and the board row from one day to the next.
- **A canonical GoHire row is not publicly displayable** (review finding 5; Requests, orchestrator 3): with a posting page set, a mainland posting that also has a board row is not on GoApply's public pages while the bank schema has no syndication consent.
- **A user's import finds its public twin by key less often** (review finding 7; Requests, orchestrator 2).
- **A bank row archived while its bank had no posting page comes back only through the bank's sync.** Setting the template is not enough while the sync is off: the row was closed without knowing whether the bank still lists it, and reopening it from our side could list a job the bank closed in the meantime.
- **The upsert writes a row's own fuzzy key on every ingest** and step 1 puts an aligned twin back in the same call: two writes per twin per ingest instead of none. Harmless; a column for the adopted key would avoid it.
- **Exact twins need the same city text.** A board row filed under "Remote" and its aggregator copy filed under a city stay two groups (today's behaviour).
- **No transitive grouping.** A fuzzy twin of an aligned row that has no posting key of its own stays in the fuzzy group the aligned row left.
- **Posting keys not read:** Greenhouse's embedded form and its EU hosts, Workday pages without a requisition suffix, and every ATS without a pattern (Taleo, SuccessFactors, the four new ones). Their shapes are not in the research notes, and none is typed from memory.
- **`registrableDomain` is a rule, not the Public Suffix List** (no dependency was added). What it does not cover is read one label short, so two employers there would share a domain key: Japanese prefecture and city domains (`*.tokyo.jp`, `*.lg.jp`), `pvt.k12.<state>.us`, and category labels outside the list (for example `biz.pl`, `gen.tr`, `asn.au`). In the other direction, an employer whose own domain is a category label under a country code (`go.co`) gets no domain key and falls back to its name, which is safe.
- **A stated domain is trusted for the key.** A source that states a wrong or parent-company website moves a row out of its name group.
- **An Indeed URL can still be a JSearch row's `sourceUrl`** when another link is the apply link. Only LinkedIn is barred from source fields by the documents.
- **Step 4 reads at most 20,000 open rows of a bank per run** and runs only in `jobs-maintain` (once a day), so a bank row stored without a posting page can stay canonical for up to a day.
- **Mainland numeric pay with a period and no currency** is still stored with no currency, so the GoApply card cannot print it. JOB_SOURCES_CN 7.6 says "currency CNY unless stated"; that inference needs the job's country in the rule and an owner's yes.
- **Other mainland sources' time zones are assumed, not measured.** Every zone-less string on a market-`cn` row is read as UTC+8.

## Review resolution

1. **[high] The domain key merged different employers under any two-level suffix outside the list of eleven: confirmed and fixed** (`normalize/company.ts`). The fixed list is gone; `publicSuffixLabels` treats every category label under a two-letter country code as part of the suffix, the bare suffix gives null, and I went further than the proposed fix in three places because they are the same defect in target markets: US state namespaces (`austin.tx.us`, `lausd.k12.ca.us`: every California school district shared `ca.us`), mainland province namespaces (`acme.sh.cn`), `*.sch.uk`, and a careers label standing directly on a multi-part suffix (`jobs.nhs.uk` is the NHS job board, `careers.gov.sg` the public service portal, `www.gov.uk` the government site: with the proposed fix alone these would still have been one "employer domain" for every row that states them). Tests: `rules.test.ts` 49 new cases (`ucl.ac.uk` and `kcl.ac.uk` differ; two `*.nhs.uk` trusts differ; `ntu.edu.tw` and `nccu.edu.tw` differ; `gov.uk`, `ac.uk`, `nhs.uk`, `com.mx`, `edu.tw`, `gov.sg` alone give null), and `normalizeProviderJob.test.ts` "review finding 1": five pairs of differently named employers under one suffix keep different dedupe keys for JSearch and the feed.
2. **[medium] The cross-bank writer stores priority 15 on GoHire rows: confirmed, not fixable in my files, Request to the orchestrator** with the exact change (`raCrossBankMatch.ts` line 834 is the literal; the file has no owner). Listed under Known gaps.
3. **[medium] A row closed as 'expired' is never reopened: confirmed and fixed** (`ingest/upsert.ts`), with the proposed rule. The three CASE lines share one fragment and a pure mirror; the header comment and the snapshot are updated; 19 table cases plus an end-to-end test through the normalizer. I checked the one thing that could have made it unsafe: only `maintain.ts` writes `closeReason = 'expired'` (a user's "expired" report closes a row as `reported`), so the rule cannot reopen a reported posting.
4. **[medium] A held GoHire row becomes canonical and hides its board twin: confirmed and fixed** (`ingest/maintain.ts`), wider than proposed in two ways. (a) The no-template rule does not ask whether the sync runs: a sync that is enabled but failing leaves the same live held rows, and with a healthy sync there is nothing left to archive, so the condition only added a hole. (b) The proposed fix relied on "the cursor restarts when a template is set". That holds only when the stored cursor's mark differs from the new template's; a cursor written with the same template (set, removed with the sync off, set again; or a second environment without the variable running the cron on the same database) would continue and strand every archived row. The step therefore clears the bank's sync cursor whenever it archived rows. Tests: `maintain.test.ts` "review finding 4" (four no-template spellings times three sync states, RoboHire in its own market, the restart statement, and the requested `runMaintenance` case: sync off, no template, a live GoHire row and its board twin in one group, the board row canonical after one run; control with a template and a running sync). The two expiry tests of that file now state that both banks are listable, since they are about the expiry rule alone.
5. **[low] A canonical GoHire row is never publicly displayable: confirmed, a decision outside my files.** Recorded under Known gaps and as a Request with both options, as the reviewer asked; the ranking is unchanged.
6. **[low] `200-300/天` hidden as "no unit": confirmed and fixed** (`normalize/salary.ts`). The cause was the `\b` after 天 / 日 in the day pattern, which also explains why `300元/天` worked and the bare form did not. `每日` was already in the table. Tests: eight spellings in `salary.test.ts`, and the two words a slash can stand before (日本, 日期) stay unread.
7. **[low] A user's import finds its public twin by key less often: confirmed, unowned file, Request to the orchestrator** with the exact change (`import/repository.ts` `findPublicMatch`). Listed under Known gaps.

**Item the reviewer judged not done, `foldTwToCn` (waveM1 MKT-3C.5, waveM2 MKT-3C.1): still left, on purpose.** I checked again that the reason holds: `features/skills/keys.ts` and `features/retrieval/hantHans.ts` both build stored values from the fold, so adding a character changes stored skill keys and search tokens and needs the owner-run re-key and re-index in the same step. The reviewer reached the same conclusion. It stays a Request to the owner.

**Unowned edits:** none found by the reviewer and none made in this pass.
