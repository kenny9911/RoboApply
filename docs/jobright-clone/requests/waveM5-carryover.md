# Wave M5 carry-over requests

**Written at the M5 gate of the market wave, 2026-10-12.** Source: the eight handoffs `orch/handoffs-mkt/MKT-5A.md` … `MKT-5H.md`, the M5 sections of `requests/waveM1-carryover.md` … `waveM4-carryover.md`, `requests/orchestrator-queue.md` and the gate's own contract check. M5 was the last phase of the market wave: every phase of the plan is implemented, so nothing below can go to a later bundle. Each entry names who must act (orchestrator, a fix package, the owner, counsel, the second repository) and the exact next step. What the gate applied is listed at the end for context.

Nothing at this gate was run against a database, a running stack, a browser, RapidAPI, USAJobs, 北森, GoHire, RoboHire, Stripe, a model or an embeddings endpoint, and no network request was made. No `*.prisma` file, no `i18n/messages` file and no billing code was edited; no `A<n> …` Alipay test was edited and none was red.

Earlier carry-over files still apply where this one says so: an entry that names `waveM2…M4-carryover.md` is unchanged since that gate and is not copied here.

---

## Open after the market wave

### Orchestrator: the steps that follow this gate (`HANDOFF.md` steps 3 to 6)

1. **Merge and translate the staged strings (one pass).** `node scripts/i18n-merge-staging.mjs --dry-run` at the end of this gate: valid; **1,171 new keys, 30 changed, 0 removed**. M5 adds to the lists of `wavePAR-carryover.md` and `waveM1…M4-carryover.md`:
   - Staged in M5, English: `companyFacts` (new namespace, 16 keys, all under `companyFacts.sponsorship`; RoboApply only, no Chinese file); `jobDetail` 3 (`header.badge.sponsorship_provider`, `closed.boardCheck`, `closed.lastListed`); `jobsTw` 8 new (`negotiable.bodyNoAmount`, `negotiable.sourceLink`, `meta.foundThroughGoogle`, `meta.foundThroughGoogleOnly`, `admin.problem.connector_disabled`, `.tenant_denied`, `.tenant_floor`, `admin.import.reason.connector_disabled`) and 1 CHANGED (`negotiable.body`, now with `{amount}` and `{asOf}`); `filters` 14 (`fields.twDistricts`, `fields.twDistrictsOf`, `fields.workShifts`, `help.twDistricts`, `help.twDistrictsFull`, `help.twDistrictsOnly`, `help.workShifts`, `help.twPay`, `options.workShifts.*` five, `chips.shiftValue`).
   - Staged at this gate, English and Chinese (`admin.en.json`, `admin.zh.json`), 13 keys under `admin.console.sources`: `name.activejobs_feed`, `name.tw_gov_jobs`, `name.usajobs`; `about.` the same three; `reason.no_key`, `reason.plan_too_small`, `reason.plan_unknown`; `skips.bank_validity_ended`, `skips.bank_time_without_zone`, `skips.bank_reread_started`, `skips.country_not_selected`. `components/v3/admin/__tests__/sources.test.tsx` requires a Chinese twin for every staged English `admin` key.
   - After the merge run `grep -rn '40,000\|4萬\|4万' i18n/messages` and expect no hit: `jobsTw.negotiable.body` loses its eight stale translations at the merge, and `components/features/market/tw/__tests__/twExtras.test.tsx` fails if a locale keeps a sentence for it without `{amount}` and `{asOf}`.
   - Translate zh-TW first for the `jobsTw` and `filters` keys (Taiwan readers otherwise fall back to English). Suggested zh-TW wording is in handoff MKT-5F, Request 2; the toggle's name inside `filters.help.twPay` must be the zh-TW bundle's own `filters.controls.listedPayToggle`; `filters.options.workShifts.night` is "Night" on purpose (the copy gate bans the phrase "night shift").
   - `companyFacts`: keep the `<link>…</link>` tag and the ICU plurals (`fact.dolLca`, `fact.uscis`, `fact.ukRoutes`, `earlier`); "H-1B" is not translated; zh-TW 財政年度 for "fiscal year"; the source names, the register's own values and the UK licence sentence are server data.
   - Key to remove from all nine bundles after the merge (no component reads it): `jobDetail.closed.lastSeen`.
   - Not staged, waits for a decision: one sentence for `/help/ranking` (namespace `landing`): "A tier can stay one step behind its score by up to 3 points, so that it does not flip back and forth around a threshold." Add it while `waveM1-carryover.md` Owner 20 stands as built (handoff MKT-5H, Request 7). Optional card string `jobs.card.postedAgo` = "Posted {when}" only if the owner wants a relative date on the card (handoff MKT-5C, I-2).
2. **Production build in a separate worktree** (`HANDOFF.md` step 4), with the `/legal` file-trace check.
3. **Browser verification of both brands** (`HANDOFF.md` step 5). New in M5 and not seen in any browser: the sponsorship-facts block on the job page (handoff MKT-5G, Known gaps 6: light and dark, 375 px and 1280 px, open and behind its line, the "earlier fiscal years" line); the district picker (高雄市 has 38 toggles, which wrap at 375 px), the shift filter and the Taiwan pay note with its amount from `GET /tw/pay-rule`; the closed notice of a job the click-time check found gone; the credit line under a Similar job and under a Company-tab row (this gate); GoApply's sources console with nine board systems (this gate).
4. **Neon branch data, PR** (`HANDOFF.md` step 6), unchanged.

### Fix package, or the orchestrator when there is time (files with no owner)

Each is designed and not built; none is needed for the gates.

5. **The liveness check never asks about a `lever_eu` key** (handoffs MKT-5B and MKT-5C, Known gaps 2). The connector reads `api.eu.lever.co` since M5 and writes `lever_eu:<site>:<id>` keys; such a row is "unknown" without a request and closes through its board sync. Next step: in `server/src/features/jobs/liveness/postingApi.ts` add `lever_eu` to `LIVENESS_ATS` and `POSTING_ENDPOINTS` (the `lever` entry with host `api.eu.lever.co`, `tenantCaseMatters: true`), check that `check.ts` reads the site's spelling from a `jobs.eu.lever.co` link, and change three assertions of `check.test.ts` ("one of the three hosts" at lines 190 and 202, the `lever_eu` row at 292). Not applied at the gate: no live EU board was ever read by any bundle, and a 404 rule that is wrong archives live postings. First read one EU posting and one unknown id on that host.
6. **`server/src/features/feed/FeedQueryService.ts`: the fallback read of `sponsorshipSource` is dead in production.** `FEED_COLUMNS` selects the column (MKT-5F) and `FeedJobRow` carries it as an optional field (this gate). `withSponsorshipSource` and `sponsorshipSourceSql` fire only for a row built without the column (the test kit's). Next step: delete both, add `sponsorshipSource: null` to `feedRow` in `feed/testkit.ts`, make the field non-optional, and rewrite the three tests of "the provider-reading sponsorship badge on a page of the list" that count the extra read.
7. **`/legal` does not list the three sponsorship publications** (handoff MKT-5G, Request O-4; an ACCEPT line of JI-11 that is not met). The UK register's licence duty is met where the fact is shown. Next step, exact text in the handoff: `features/compliance/contract.ts` (`'sponsorship_facts'` in `DATA_ATTRIBUTION_PURPOSES`), `disclosures.ts` (one row per entry of `sponsorshipSourcesInUse(prisma)`, cached), `compliance.test.ts` (accept `Open Government Licence` and the new purpose), and the string `legal.attributions.purpose.sponsorship_facts` = "Company sponsorship records".
8. **Credit line still held on three surfaces** (the hold-outs of `feed/sourceLine.ts` `creditLineHeld`): job alerts (in the app and by e-mail), the Ready to apply suggestions and picks, and the tailoring tip (`lifecycle/repo.ts` `topFitJob`). 台灣就業通 and 事求人 rows are left out there. Similar jobs (page and Assistant) and the Company tab print the line since this gate. Next step per surface: print `cardMeta.tw_sources.attribution` and drop the hold (`requests/waveM3-carryover.md`, Orchestrator 3).
9. **`explainNow` does not pass a missing side** (handoff MKT-5C, Known gaps 10; `waveM4-carryover.md` "Files with no owner" 2). (a) `features/compliance/explainMatch.ts`: `missingSide` on `ExplainMatchInput`, the three `legal.explain.profileMissing.*` keys, the third headline; (b) `jobs/detail/defaultService.ts` `explainNow` passes it. Nothing is false today.
10. **The Ready weekly selection has no wrong-title weight** (handoff MKT-5C, Known gaps 6): expose the person's negative role and title weights on the feed seam (`feed/index.ts`) and let `applyDislikes` demote those jobs. Asking for `sort: 'recommended'` is not a safe swap (the handoff says why).
11. **Callers of `getFits` with no language**: `alerts/service.ts`, `lifecycle/repo.ts`, `onboarding/defaults.ts` (`waveM4-carryover.md` "Files with no owner" 15). The feed route passes the request language since this gate.
12. **Admin console.** (a) No form for the Taiwan pay rule and no label for the audit event `admin_tw_pay_rule_updated` (`features/admin/contract.ts` `ADMIN_AUDIT_EVENTS`); the API and the wrappers `adminGetTwPayRule` / `adminPutTwPayRule` are ready (handoff MKT-5F, Request 4). (b) Optional tallies that stay in the run's log only: `feed_out_of_window`, `feed_expired_refused`, `feed_expired_error`, `feed_budget_reached`, `other_market_location` (handoff MKT-5A, Request 6) and the eight of handoff MKT-5D, Request 2 (`no_stable_id`, `tw_gov_*`, `usajobs_*`); each needs its entry in `SOURCE_STATUS_NOTES`, in `TALLY_ORDER` and a staged sentence in English and Chinese (wording in the handoffs). (c) The daily health e-mail has no line for a seeded source that failed its reads and was switched off (`features/admin/healthEmail.ts`; handoff MKT-5B, O-5).
13. **Employer-board seeds** (`scripts/board-seeds/`; handoff MKT-5B, O-6 and Known gaps 6, 7). Needs live reads of public board APIs: set `MAX_RESPONSE_CHARS` to `48 * 1024 * 1024`, record `answerChars` for large one-answer boards and leave a board out above 75% of it, rebuild with SpaceX, Anduril and OpenAI; add readers for Workable, Recruitee, Personio and Lever EU to `validate.mjs` and seed them (none is seeded today); then let `isLargeBoard` read `answerChars`, so the first load of an empty database is not serial for 497 boards.
14. **An unchanged posting is rewritten in full on every board read** (`jobs/ingest/pipeline.ts`, `upsert.ts`; handoff MKT-5B, O-8; `waveM4-carryover.md` "Files with no owner" 14). Only a Greenhouse board that is kept whole takes the list-first step.
15. **Small ones, each exact in its handoff.**
    - `scripts/check-api-boundary.mjs` line 152: a string that is a whole URL on another host is not a call to our API; then `components/features/market/tw/meta.ts` can hold the Workable address as a plain literal (handoff MKT-5B, O-10). Cosmetic.
    - `server/src/features/feed/index.ts`: `export { needsSponsorshipFor } from './items.js'`, then `jobs/companies/sponsorship/service.ts` imports it and `needsSponsorshipIn` goes (handoff MKT-5G, O-3). `sponsorship.test.ts` holds the two equal meanwhile.
    - `hooks/shared/useJobActions.ts`: move the tab rule into the hook (never open a link before `applyClick` resolves; default opener `createApplyTabOpener`); `components/features/agent/KitParts.tsx` `openPendingTab` has the same one-window weakness (handoff MKT-5C, O-11).
    - `server/src/features/cn/jobs/card.ts`: accept a hire type the source itself states, for a future 北森 校招 pass (handoff MKT-5B, O-7).
    - `platform/startup.ts`: one boot warning from `syndicationUrlProblem(bankSyndicationConfig('gohire')?.url)`; today a wrong `GOHIRE_SYNDICATION_URL` shows only when a sync runs (handoff MKT-5E, Known gaps 12).
    - `server/src/features/jobs/sources/sourceRegister.test.ts`: `ARRIVING_WITH` and the two loops over it in `switchProblems` can go now that the three bundles are merged and the test is green (handoff MKT-5D, Request 4). `usaJobs.ts` `UsaJobsInput` and `twGovJobs.ts` `TwGovJobsInput` can become plain `ProviderJobInput`, and the normalizer's cast can go (`ProviderJobInput.marketTags` exists since this gate).
    - `server/src/features/seo/scope.ts` `PROVIDER_BOARDS`: `usajobs: ['usajobs']` after the owner decides `PUBLIC_DISPLAY_PROVIDERS`; the two Taiwan boards only together with the credit line on the visitor list (handoff MKT-5D, Request 3).
    - `server/src/features/jobs/data/importLca.ts` still writes unless `--dry-run` is given, while the two new importers write only with `--apply` (handoff MKT-5G, Known gaps 3): in `parseLcaArgs` return `dryRun: !argv.includes('--apply')`, and `lca.test.ts` line 223 expects `dryRun: true`.
    - `normalize/normalizeProviderJob.ts`: use the feed's category when the title names no role (handoff MKT-5A, Request 9); change MKT-5A's test "a category is not a role" and the MKT-1C test in one change.
    - `.env.example`: a "developer scripts" section for `ELEVENLABS_API_KEY`, `PARLEY_ADMIN_PASSWORD`, `ROBOAPPLY_API_READY_TIMEOUT_MS`, `ROBOAPPLY_PREVIEW`; older comments name server files as `lib/…` where the path is `server/src/lib/…` (handoff MKT-5H, Known gaps 6 and 8).
    - Optional, each written out in its handoff: `components/features/job/JobOverview.tsx` prints the provider's sponsorship reading in the work-authorization block too (MKT-5C, G-1); `copilot/tools/filters.ts` says why two Taiwan filters went (`parseFilterSet(...).droppedForPlace`; MKT-5F, 5a); `ingest/upsert.ts` takes a bank row's agency flag from the bank whatever the mapping sends, or `normalizeProviderJob.ts` leaves the company record's flag to the name rule (MKT-5E, Request 7).
    - GoHire syndication, only if the bank cannot give what the contract asks (handoff MKT-5E, Known gaps 3 and 7): keep the ids of a whole pass in `AppConfig` and report a listing on its last page (a job hard-deleted without a tombstone otherwise stays open for about 45 to 52 days); a pause between pages and reading `Retry-After` into the next run time (needs a field on the fetch result that `pipeline.ts` honours).
    - No RoboApply deploy runbook exists under `docs/runbooks/`; the account-purge paragraph of handoff MKT-5H, Request 6 is in `ARCHITECTURE.md` 7.1 and in `requests/orchestrator-queue.md` ("Before `feat/jobright-clone` reaches production"). Add it to a runbook when one is written.
16. **Still open from `waveM4-carryover.md`, "Files with no owner", unchanged:** 1 (skills: machine-guessed alias keys), 3 (the age-limit flag has no reader), 4 and 5 (billing: the exports, the two root fixes, the amount-bound confirm of a withdrawal with its web half, the console lines), 6 (the fit card), 7 (the harness), 8 (the Assistant's dead title-search stand-in and `storedFit`), 9 (`RAJob.skills` replaced by a provider list), 10 (the phone-merge path), 11 (GoApply alerts and the tip without the 个性化推荐 grant: the owner chooses first, Owner 18 below), 13 (the affix token of the search tokenizer). And the "Files with no owner" of `waveM3-carryover.md` that its item 12 lists.
17. **Plan documents that wait for owner answers** (handoff MKT-5H, Requests 2 and 4): fold the "As built" notes of M2 to M4 into `market/MARKET_STRATEGY.md` after `waveM2-carryover.md` Owner 5, 6, 21, 22, 23; `market/JOB_SOURCES_TW.md` line 65 ("keep our 45-day rule on `TRANDATE`") after `waveM3-carryover.md` Owner 1; `market/JOB_SOURCES_CN.md` and strategy 1.4 list nine deep-link boards as if live (three are; JC-5 is not delivered until `waveM3-carryover.md` Owner 9).

### Fix package: from the cross-review of the gate (2026-10-12)

Lettered so that the numbers above and below keep their meaning. Each is designed and not built; none is needed for the gates.

- **X1. One account can still make the server ask an ATS many times.** Built at the gate: one server process sends one ATS host at most 60 new posting checks in any 60 seconds (`liveness/check.ts`, `LIVENESS_HOST_REQUESTS_PER_MINUTE`; beyond it the answer is "unknown" and the page is served from our own records). That bounds a person who walks the job list and the weekly Ready run, per process: N serverless instances can send N times that. Not built: a limit per person on the three routes that start a check, `GET /jobs/:id` and `POST /jobs/:id/apply-click` (`server/src/features/jobs/detail/routes.ts`, behind a `deps` seam like `newsLimiter`) and `POST /agent/queue` (`server/src/features/agent/routes.ts`, whose `limiter` seam exists): `rateLimit({ name: 'jobOpenPerUser', windows: [{ limit: 120, windowSec: MINUTE }], by: 'user' })`. It was left out because the limiter is database-backed: it adds one counter write to every job open. Who decides: the owner (is one write per job open acceptable?), then a fix package. The operator's stop in the meantime: `LIVENESS_CHECK_DISABLED=true` (the check alone) or `ATS_PUBLIC_SOURCES_DISABLED=true` (every board read).
- **X2. Most response-size caps are applied after the whole body is in memory.** Only `ingest/adapters/syndication.ts` `readCapped` stops reading at the cap. The licensed feed checks `Content-Length` and then calls `response.json()` (`roboapply/v2/lib/raFantasticJobs.ts`); `liveness/postingApi.ts` (2 MB), `sources/atsPublic/http.ts` (48 MB, up to 8 boards in flight), `sources/usaJobs.ts` and `sources/twGovJobs.ts` compare the length after `res.text()`. A chunked answer without `Content-Length` is therefore bounded by the timeout (4 to 30 seconds), not by the cap. The hosts are allow-listed vendors. Next step: move `readCapped` to a shared helper (for example `server/src/features/jobs/sources/readCapped.ts`) and use it in the five readers; a normal answer behaves as before.
- **X3. An aggregator's row closed as `ats_removed` has no automatic way back** (handoff MKT-5C, Known gaps 12; the operator's undo is under Owner 14). The cure the handoff designed: in `jobs-maintain`, ask the ATS again about a capped number of `ats_removed` rows whose `lastSeenAt` is later than their `closedAt` (their source listed them again after the closure), and reopen those the ATS lists.
- **X4. The mainland's 45-day rule ignores the board switches.** `ingest/maintain.ts` `archiveUnseenMainland` closes every public mainland row not seen for 45 days whatever stopped the reads (`ATS_PUBLIC_SOURCES_DISABLED`, `ATS_WORKABLE_DISABLED`, a 北森 flag turned back off, a board switched off by three hard failures). That follows strategy 1.5 ("else 45 days unseen"); the documents now say so (`.env.example`, `docs/job-search/ATS_BOARDS.md`, `docs/job-search/SOURCE_REGISTER.md` section 3). If the owner wants a kill switch to freeze GoApply's stock instead, the change is one condition in `buildUnseenMainlandSql` (leave out the boards of `PUBLIC_ATS` while the switch is on) and one case in `server/src/features/m5Seams.test.ts`, which today checks the rule against the bank's re-read only.

### Owner decisions / schema

The schema is frozen and the gate edited no `*.prisma` file. Every request is additive; none is needed for the gates. Review the SQL, apply to the Neon branch first (`HANDOFF.md` section 5).

18. **`RAUserUiState.prevFeedVisitAt`** (handoff MKT-5C, S-1): the "New" chips can change inside one sitting until it exists.

    ```prisma
    // server/prisma/schema/ra-notify.prisma, model RAUserUiState
    /// The value `lastFeedVisitAt` held before the current sitting began (a sitting: openings of the
    /// list less than a feed session, 30 minutes, apart). The "New" chips count from it for the whole sitting.
    prevFeedVisitAt DateTime?
    ```

    Code once it exists: `feed/repo.ts` `stampFeedVisit` copies the old stamp when it is null or at least a session older; `FeedQueryService.ts` `previousVisit(stamp, previous, now)`.
19. **`RAJob.sourceScope`** (handoff MKT-5F, Schema request 1; `waveM3-carryover.md` Schema request 4): a 台灣就業通 row of a county that hits the row cap is never closed by absence until it exists.

    ```prisma
    // server/prisma/schema/ra-jobs.prisma, model RAJob
    /// The request of a split source that last returned the row, written on every sighting.
    /// tw_open_data: '<CITY>' (the county's own answer), '<CITY>:<zipno>', '<CITY>:<zipno>:<jobno>',
    /// '<CITY>::<jobno>' (a county read by 大類). Null for every other source.
    sourceScope String?
    ```

    Then about 40 lines: `ProviderJobInput.sourceScope`, the pass-through in the normalizer, the write in `ingest/upsert.ts`, and the closure rule in `twOpenData.ts` (handoff MKT-5F, Known gaps 1).
20. Optional: **`RAJob.liveCheckedAt DateTime?`** (handoff MKT-5C, S-2: the ATS's confirmation of a row that is not its own board row survives a new process); **`RAJob.workShifts String[] @default([])`** (handoff MKT-5F, Schema request 2: a shift filter finds a posting under every shift it lists); **`RAH1bEmployerStat.asOf DateTime?`** (handoff MKT-5G: the LCA fact can say "as of {date}").
21. **Comments only** (no diff for the database; handoff MKT-5H, Request 5): `ra-skills.prisma` `RASkill.status` holds four values (`reviewed`, `unreviewed`, `dropped`, `seed`), the comment names two; `ra-credits.prisma`, the comment on `RACreditLedger.bucket` lacks `billing:passover:*`. With the comment requests of `waveM4-carryover.md` (Schema request 3).
22. Still open from earlier gates, unchanged: the optional requests 1 and 2 of `waveM4-carryover.md`, `RAJob.taxonomySource String?` (`waveM1-carryover.md`), the four of `waveM2-carryover.md`, requests 1 to 3 of `waveM3-carryover.md`.

### Owner

**Before the first deploy of this code**

1. **Workable**: keep the connector on or set `ATS_WORKABLE_DISABLED=true`. Discovery has recorded Workable and Lever EU candidates since M3; any that exist are validated (20 a run) and read from the first deploy. Workable's terms are unconfirmed (handoff MKT-5B).
2. **事求人 is read once a day by default** in every environment that runs the ingest cron (`TW_GOV_JOBS_ENABLED=false` turns it off). The first read queues about 1,100 postings for enrichment.
3. **The first `jobs-ingest` after the merge reads the GoHire bank once from its beginning** (its stored cursor has no pass start). Harmless: rows are held until the posting page exists. RoboHire's sync does not restart.
4. **Apply before a paid Active Jobs DB plan is bought: nothing** (the cron order, handoff MKT-5A Request 1, is applied at this gate). Before buying, measure the month with the vendor's count endpoint with the filters the sync sends; the default thirteen countries with no taxonomy filter are very likely above a 100,000 plan. Trim `INGEST_FEED_COUNTRIES` and set `INGEST_FEED_TAXONOMIES` until the count fits. The first week costs more (the seven-day backfill).
5. After buying a plan in the middle of a period set `INGEST_QUOTA_RECHECK_HOURS=1` until the first response of the new plan was read; on a deployment that serves only GoApply also set `FANTASTIC_MONTHLY_JOBS` (nothing there ever reads the plan). On the first paid day watch the tally for `feed_unmapped`, `feed_out_of_window`, `feed_expired_error`, `feed_expired_refused` and the query's last error for `window_not_applied`; `FANTASTIC_EXPIRED_PATH` corrects the expired route without a deploy; record one page as a fixture (handoff MKT-5A, Known gaps 1 to 5, 8, 14).

**Keys, files and accounts**

6. Request the free USAJOBS key and set `USAJOBS_API_KEY` and `USAJOBS_USER_AGENT_EMAIL`; on the first run compare one page with `__fixtures__/usajobs/README.md` (handoff MKT-5D, Known gaps 1).
7. Sponsorship facts: download the USCIS H-1B Employer Data Hub files and the UK Register of Licensed Sponsors and run the two importers per database, first as a dry run, then with `--apply` (commands in handoff MKT-5G, Known gaps 2). Export one fiscal year of the hub's current layout as CSV and run the dry run on it (Known gaps 1): until then the facts stop at FY2023.
8. GoHire syndication, in the order of `market/GOHIRE_SYNDICATION.md` section 14: approve the work package for the second repository, issue the scoped service key and agree its rate limit (this side sends the pages of one sync back to back and does not read `Retry-After`), confirm GoHire's licence and supply `CN_HR_LICENCE_HOLDER` / `CN_HR_LICENCE_NUMBER`, run `scripts/gohire-syndication-probe.mjs`, then set `GOHIRE_SYNDICATION_URL`, `GOHIRE_SYNDICATION_KEY`, `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` and `RA_CROSSBANK_CROSS_TENANT_CONFIRMED=true`.
9. When Taiwan's pay-disclosure amendment is promulgated, store the new rule: `PUT /api/v1/roboapply/admin/tw/pay-rule` (the body is in handoff MKT-5F, Request 8). The note follows within 5 minutes.

**Decisions**

10. `PUBLIC_DISPLAY_PROVIDERS`, after reading `docs/job-search/SOURCE_REGISTER.md` section 4 (`tw_open_data` and `usajobs` are the recommended first entries). If USAJOBS rows go on public pages, decide whether to print the sentence its terms encourage (the product is not run or endorsed by OPM).
11. A Taiwan reviewer: which of the thirteen unconfirmed 事求人 staff categories may a member of the public apply for (372 records a day are left out)? Each confirmed kind is one string in `TW_GOV_PUBLIC_KINDS`.
12. Taiwan filters: should 中班 read "Evening"; should a new pay floor on a Taiwan search start as TWD a month (built so; three lines in `PayEditor`); should a district choice narrow only its own county (today it is one rule for the whole search, and the drawer says so; handoff MKT-5F, Requests 9 and 10).
13. A GoHire job with no recorded consent: shown to signed-in GoApply users, never on a public page (today's rule; `GOHIRE_SYNDICATION.md` 6.2). Decision 22 of `wavePAR-carryover.md` (the 测试 rule) is still open; the narrow rule is kept and 「测试简历匹配」 is caught.
14. Liveness: a Lever posting reached only through someone else's link is confirmed open by the check and not closed by a 404; an aggregator-only posting its ATS lists again stays closed as `ats_removed`. Each can be changed at the price of more requests to the ATS (handoff MKT-5C, Known gaps 3 and 12). One GET to a SmartRecruiters posting known to be closed would settle Known gaps 4.

    **Undoing a mistaken closure by the check** (a vendor incident that answered 404 for live postings; an employer who unpublished and republished under the same id). The ATS's own board row (`closeReason = 'source_removed'`) needs nothing: the next read of its board reopens it. Every other row of the posting was closed as `'ats_removed'`, and nothing reopens that reason: not its source listing it again, not `jobs-maintain`, no admin action. It is the copy in the other market too (the closure follows the posting key across markets, by design). The undo is a statement the owner runs on the database concerned, never an agent, after reading the count:

    ```sql
    -- 1. Look first: what did the check close in the window of the incident?
    SELECT "market", "sourceBoard", count(*) FROM "RAJob"
    WHERE "closeReason" = 'ats_removed' AND "closedAt" BETWEEN '<from>' AND '<to>'
    GROUP BY 1, 2;
    -- 2. Reopen exactly those rows. "updatedAt" moves so that the next jobs-maintain run repairs their dedupe groups.
    UPDATE "RAJob" SET "archivedAt" = NULL, "closedAt" = NULL, "closeReason" = NULL, "updatedAt" = now()
    WHERE "closeReason" = 'ats_removed' AND "closedAt" BETWEEN '<from>' AND '<to>';
    ```

    A posting that is really gone is closed again the next time somebody opens it (a server process reuses a "gone" answer for ten minutes). The automatic cure is fix package X3.
15. An alias table for sponsorship facts (exact-name matching shows nothing for a subsidiary or a trading name), only as a reviewed list (handoff MKT-5G, Known gaps 9). The 48 MB answer limit and the 600-posting line of the board sync are named constants: say if either should differ.
16. The legacy cross-bank search (`/v2/discover`) keeps a 45-day posting-age bound on both transports (`FRESHNESS_DAYS` in `raCrossBankMatch.ts`), so a GoHire job older than that is in the feed and not in its results: decide whether that search should follow M-22 (handoff MKT-5E, Known gaps 6).
17. `docs/jobright-clone/README.md`, "Owner steps still open" (42 steps), was written by MKT-5H from the M5 handoffs as they stood before three of them were rewritten after review. It was NOT compared again at the gate: where it and this section differ, this section and the final handoffs are right.
18. Still open, unchanged: GoApply alerts and the lifecycle tip print a fit for a person without the 个性化推荐 grant (`waveM2-carryover.md` Owner 24); `tw_open_data` keeps the feed's age floor until `waveM3-carryover.md` Owner 1 is answered (checked at this gate: `AGE_FLOOR_BOARDS` still holds it); the best `publicDisplay` row for public readers (`waveM3-carryover.md` Owner 3); the owner lists of `waveM1…M4-carryover.md`. The 42 open steps are in `docs/jobright-clone/README.md`, "Owner steps still open".

### Counsel

1. **北森**: the five steps of `docs/job-search/ATS_BOARDS.md` 5.2 before `CN_ATS_BEISEN_ENABLED` is ever set. The connector is unverified end to end (the wire shape comes from one third-party source; the fixture is synthetic). If `PUBLIC_DISPLAY_PROVIDERS` is ever to include `ats_public`, the memo must cover public pages.
2. The UK register can list sole traders under their own names, and the Open Government Licence does not cover personal data in the information (handoff MKT-5G, Known gaps 10; low).
3. The counsel items of `waveM4-carryover.md` (i18n item 15, Owner 8) are unchanged.

### Second repository (RoboHire / GoHire backend)

1. Build `GET /api/v1/syndication/jobs` to `docs/jobright-clone/market/GOHIRE_SYNDICATION.md`; the acceptance list is its section 11. Send `employerVerified: true` only for the employer's own verified record (6.1); move a job's `updatedAt` when its employer's verification, consent, company facts or validity change (5.4); send a tombstone for a deleted job (without one it stays open here for about 45 to 52 days); do not send a job before its `validFrom`.
2. The candidate-facing posting page (section 12.2) is as necessary as the route: without `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` (and `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE`) every synced job is held.

---

## What the first runs after this merge do (nothing here was run)

- **`jobs-ingest`**: reads the GoHire bank once from its beginning (Owner 3); starts the daily 事求人 read for RoboApply (Owner 2); USAJOBS, the licensed feed and the mainland's Active Jobs DB stay off (no key, no paid plan).
- **`jobs-boards`**: validates and reads Workable and Lever EU candidates that discovery recorded (Owner 1); a never-read one-answer board is read and written in one slot, so the first load of an empty database is serial for the Greenhouse and Ashby boards; archives the open postings of every tenant on `CN_ATS_TENANT_DENYLIST`.
- **`jobs-maintain`**: archives public mainland rows not seen for 45 days as `expired` (every board except `user_import`); queues the skills-only pass. Only a read moves `lastSeenAt`, so a kill switch held longer than 45 days (`ATS_PUBLIC_SOURCES_DISABLED`, `ATS_WORKABLE_DISABLED`, a 北森 flag turned back off) empties the mainland board stock until the next read, which reopens each posting its board still lists (fix package X4).
- **Opening a job, the apply click and Ready to apply** ask the posting's ATS (Greenhouse, Lever, SmartRecruiters only) whether it is still listed: one request per posting per process per window, 8 at once, at most 60 new requests a minute to one host per process. `LIVENESS_CHECK_DISABLED=true` turns it off, and so does `ATS_PUBLIC_SOURCES_DISABLED=true` (since the cross-review of this gate: the check is a read of a public job board). A check the job page stopped waiting for (1.5 seconds) is kept alive on Vercel until it has written its answer.
- The job-search API's cache version changes once (its key now also holds the Active Jobs DB transport and direct key).

## Applied at the gate (for context)

Red tests at the start: 13 in 9 files. All green at the end.

- **Red tests fixed on the test side (the code was right by the plan):** `jobs/sources/types.test.ts` (2), `jobs/sources/registry.test.ts`, `jobs/ingest/adapters/adapters.test.ts` (2), `admin/__tests__/services.test.ts` (JC-6: Active Jobs DB and its feed are sources of both brands, off for the mainland without a paid plan); `jobs/ingest/maintain.test.ts` (2; nine board systems, not a literal four); `cn/jobs/__tests__/modeOff.routes.test.ts` (the control case sets the bank page: a company's list holds a bank row back like the feed, carry-over 2c); `components/features/feed/cnListing.test.tsx` (the employer link is not opened before the server answers, JI-10); `careerSourcesPanel.test.tsx` (2; the sentences MKT-5F staged replace the fallback the test pinned).
- **Red test fixed in code:** `jobs/normalize/ats.test.ts`: `BOARD_KEY_ATS` holds the nine systems.
- **Seams found by the gate's contract check, fixed:** `FANTASTIC_FEED_SLICE_CHECK_DISABLED` (added in MKT-5A's review round) was read by code and documented nowhere: now in `.env.example`, the env test list, the register and the task plan, with the two operator sentences of handoff MKT-5A Request 8 (both env files). `INGEST_BANK_RESYNC_DAYS` is described as the GoHire bank's only. `jobsTw.admin.problem.tenant_floor` says "asked", as MKT-5B's final rule does.
- **Requests applied:** the three ingest crons load the stored quota reading before they list adapters, and `jobs-maintain` counts `unseenMainland` (MKT-5A R1, MKT-5C O-3); `jobs/ingest/index.ts` exports the feed gate, the feed budget, `knownIngestProvidersForBrand` and `applyDedupe`, and `admin/limits.ts` re-exports `FEED_MIN_MONTHLY_JOBS` (MKT-5A R3, MKT-5C O-1, MKT-5E R2); `job-search/service.ts` follows the Active Jobs DB transport (MKT-5A R5); the admin System panel reads `plan_too_small` and `plan_unknown` as gated and the registry names `plan_unknown` (MKT-5A R4, all three points); the sources console knows the three new sources, three new reasons and four new tallies, and offers every board system the server reads (MKT-5B O-2, O-3, O-4; MKT-5D R2; MKT-5E R1); `careerSourceCounts` reads `ats` and does not count a passed-over board as failing (MKT-5B O-11); `ProviderJobInput.marketTags` (MKT-5D R1); `FeedJobRow.sponsorshipSource` and the request language on the feed route (MKT-5C O-2, O-6); Similar jobs on the page and in the Assistant, and the Company tab, print the open-data credit line and list those rows (MKT-5C O-4, O-5; MKT-5G O-2); a closed job is said as closed when it is added to Ready to apply (MKT-5C O-10); the "Ranked by" strip is left out when the server says the words took no part (MKT-5C O-7); a Taiwan row found through Google job search does not name the aggregator on the card or in the job header (MKT-5F R6, JT-8); `lib/api/contracts/tw.ts` (MKT-5F R3).
- **New test:** `server/src/features/m5Seams.test.ts` holds six contracts between M5 bundles on the merged tree (a source's own tags; the unseen rule against the bank re-read; the dedupe repair; the run tallies; the sponsorship source; the posting-key rule). It must stay green like the three M4 seam tests.
- **Documents:** `market/MARKET_TASK_PLAN.md` 3.2, 3.3, 5 and 6 (as built); `market/MARKET_STRATEGY.md` 1.2, 1.3 and 5.3; `market/PAYMENTS_AUDIT.md` (the test clock); `market/JOB_SOURCES_TW.md` 3.2 and `JOB_SOURCES_INTL.md` 6.4 (facts MKT-5D measured); `docs/job-search/SOURCE_REGISTER.md`; `README.md` and `HANDOFF.md` (the M5 row).
- **Applied after the cross-review of the gate (three medium and nine low findings; all twelve were real):**
  - Code, each with a test that failed before: `ATS_PUBLIC_SOURCES_DISABLED=true` stops the on-demand posting check too (`liveness/check.ts` `livenessEnabled`); a budget of 60 new posting checks a minute per ATS host and process (`LivenessHosts.admit`, answer `host_budget`); the cross-bank search over the GoHire mirror applies the feed's scope, in the read and in the id lookup (`closedAt` null, no fraud flag: `raBankProviders.ts` `mirrorRowListable`, `RACrossBankSearchService.ts`); `PUBLIC_DISPLAY_PROVIDERS=activejobs` covers the licensed feed's rows (`normalizeProviderJob.ts`), so the feed no longer turns a public row private; a posting check the job page stopped waiting for is handed to `waitUntil` (`jobs/detail/service.ts` `keepAlive`, wired in `defaultService.ts`); the keyed Active Jobs DB request never follows a redirect (`raFantasticJobs.ts`, error `redirect`).
  - Comments brought to the tree as built: the source registry's header (`sources/registry.ts`), `sources/twHooks.ts`, `feed/FeedQueryService.ts`.
  - Documents: `.env.example` (the two board switches and the mainland's 45-day rule, the posting check's limits, the ids `PUBLIC_DISPLAY_PROVIDERS` accepts), `docs/job-search/ATS_BOARDS.md`, `docs/job-search/SOURCE_REGISTER.md` (a row for the posting check in section 3; section 4 names the company list), `HANDOFF.md` (the build worktree needs `--detach`; which uncommitted paths are the gate's; what the crons of step 5 call; which mainland rows step 6 archives), `requests/orchestrator-queue.md`, and this file (fix package X1 to X4, the undo under Owner 14).
- **Checked and found in order:** every M5 variable of the env test list is read by code; `NO_DATE_EXPIRY_BOARDS` is gone; the skills-only pass is queued; `tw_open_data` is still in `AGE_FLOOR_BOARDS`; `CN_UNSEEN_DAYS` (45) is above the bank's longest re-read (30) and both name market `cn`; the five M4 variables are in `.env.example`; the register's section 3 was already corrected by MKT-5D after its review.

## Paths the gate left uncommitted (84; `git status --short` at the end of the gate and its cross-review fix pass)

`M` = modified, `??` = new. Stage exactly these, by path (`HANDOFF.md` section 3). The list is of no use once they are committed: delete this section then.

```
M  .env.example
M  __tests__/deploy/envExample.test.ts
M  components/features/agent/KitReview.tsx
M  components/features/agent/ReadyPage.tsx
M  components/features/company/CompanyTab.tsx
M  components/features/feed/JobsWorkspace.tsx
M  components/features/feed/cardModel.test.ts
M  components/features/feed/cardModel.ts
M  components/features/feed/cnListing.test.tsx
M  components/features/feed/feed.test.tsx
M  components/features/job/GetReadyChecklist.tsx
M  components/features/job/JobHeader.tsx
M  components/features/job/SimilarJobs.tsx
M  components/features/job/job.test.tsx
M  components/features/market/tw/JobMetaTw.tsx
M  components/features/market/tw/__tests__/careerSourcesPanel.test.tsx
M  components/v3/admin/SourcesConsole.tsx
M  deploy/cn/cn.env.example
M  docs/job-search/ATS_BOARDS.md
M  docs/job-search/SOURCE_REGISTER.md
M  docs/jobright-clone/HANDOFF.md
M  docs/jobright-clone/README.md
M  docs/jobright-clone/market/JOB_SOURCES_INTL.md
M  docs/jobright-clone/market/JOB_SOURCES_TW.md
M  docs/jobright-clone/market/MARKET_STRATEGY.md
M  docs/jobright-clone/market/MARKET_TASK_PLAN.md
M  docs/jobright-clone/market/PAYMENTS_AUDIT.md
M  docs/jobright-clone/requests/orchestrator-queue.md
?? docs/jobright-clone/requests/waveM5-carryover.md
M  hooks/feed/useFeed.ts
?? hooks/job/useAddToReady.test.tsx
M  hooks/job/useAddToReady.ts
M  i18n/staging/admin.en.json
M  i18n/staging/admin.zh.json
M  i18n/staging/jobsTw.en.json
M  lib/api/careerSources.ts
?? lib/api/contracts/tw.ts
M  lib/api/tw.ts
M  server/src/features/admin/__tests__/services.test.ts
M  server/src/features/admin/limits.ts
M  server/src/features/admin/system.ts
M  server/src/features/cn/jobs/__tests__/modeOff.routes.test.ts
M  server/src/features/copilot/__tests__/tools.test.ts
M  server/src/features/copilot/areas.ts
M  server/src/features/feed/FeedQueryService.ts
M  server/src/features/feed/routes.ts
M  server/src/features/feed/sourceLine.ts
M  server/src/features/feed/types.ts
M  server/src/features/jobs/companies/routes.ts
M  server/src/features/jobs/detail/contract.ts
M  server/src/features/jobs/detail/defaultService.ts
M  server/src/features/jobs/detail/detail.test.ts
M  server/src/features/jobs/detail/routes.ts
M  server/src/features/jobs/detail/service.ts
M  server/src/features/jobs/ingest/adapters/adapters.test.ts
M  server/src/features/jobs/ingest/adapters/fantasticFeed.test.ts
M  server/src/features/jobs/ingest/adapters/rapidApi.cn.test.ts
M  server/src/features/jobs/ingest/boards.test.ts
M  server/src/features/jobs/ingest/config.ts
M  server/src/features/jobs/ingest/cron.ts
M  server/src/features/jobs/ingest/index.ts
M  server/src/features/jobs/ingest/maintain.test.ts
M  server/src/features/jobs/ingest/status.ts
M  server/src/features/jobs/liveness/check.test.ts
M  server/src/features/jobs/liveness/check.ts
M  server/src/features/jobs/liveness/index.ts
M  server/src/features/jobs/normalize/ats.ts
M  server/src/features/jobs/normalize/normalizeProviderJob.test.ts
M  server/src/features/jobs/normalize/normalizeProviderJob.ts
M  server/src/features/jobs/normalize/types.ts
M  server/src/features/jobs/sources/atsPublic/contract.ts
M  server/src/features/jobs/sources/registry.test.ts
M  server/src/features/jobs/sources/registry.ts
M  server/src/features/jobs/sources/twHooks.ts
M  server/src/features/jobs/sources/types.test.ts
M  server/src/features/m4Seams.test.ts
?? server/src/features/m5Seams.test.ts
M  server/src/job-search/service.ts
M  server/src/roboapply/v2/lib/raBankProviders.test.ts
M  server/src/roboapply/v2/lib/raBankProviders.ts
M  server/src/roboapply/v2/lib/raFantasticJobs.test.ts
M  server/src/roboapply/v2/lib/raFantasticJobs.ts
M  server/src/roboapply/v2/services/RACrossBankSearchService.test.ts
M  server/src/roboapply/v2/services/RACrossBankSearchService.ts
```
