# MKT-5C

Closure and freshness: the on-demand posting check, three date facts, the mainland unseen rule, the sponsorship label rule. Worktree `wp-MKT-5C`, branch `wp/MKT-5C`. Nothing committed. This is the complete handoff after the independent review; it replaces the earlier one.

**State in one paragraph.** All six items are built and tested. The review's seven findings are resolved: six in code, one (the last) in this handoff, as the reviewer asked. Gates on the final tree: every test in the files I own is green (559 tests in 10 files), both typechecks are clean, `npm run check` is clean, `eval:match --enforce M4` exits 0. The full suite has **one red test outside my owns, caused by my change and not avoidable**: it pins the behaviour that finding 2 calls the defect (the employer link opened before the server answers). It is listed under "Red tests for other bundles" with the assertion it should now make. Nothing else is red. No file outside my owns was edited. No network request was made in this session.

## Review resolution

Each finding was checked against the code before anything was changed. All seven are real.

1. **High: a posting the ATS said is gone came back when an aggregator listed it again. Fixed.** Confirmed in `ingest/upsert.ts`: `REVIVED_CLOSE_REASONS` holds `source_removed`, so any listing by the row's own source reopened it with `lastSeenAt = now()`, and the check then answered "open" from that date for six hours. Two changes in `liveness/check.ts`:
   - `applyLiveness` now writes the close reason by who may reopen the row. The ATS's own board row (`isBoardRowOfKey`: its board is the ATS of the key and its `externalId` is the key; the `#cn` copy too) keeps `source_removed`, because its source is the ATS's own listing. **Every other row of the posting is closed as `ats_removed`**, a reason the upsert does not reopen (no change in `upsert.ts` was needed).
   - `checkPostingLive` answers "seen recently" from `lastSeenAt` only for the ATS's own board row. For a row of any other source only the ATS's own answer spares the request: "listed" is reused for `LIVENESS_RECHECK_HOURS` in the process (never under 10 minutes), "gone" and "cannot tell" for 10 minutes. A "gone" answer stands against an aggregator's later sighting; only the board's own later listing reopens the question.
   - Tests in `check.test.ts`: the defect's own sequence replayed (archive, the aggregator lists again, the row stays closed and is answered closed with no request; the board row is reopened by the board); `revivesOnRelist('ats_removed', …)` is false for three kinds of listing and the reason is not in `REVIVED_CLOSE_REASONS`; a JSearch row seen an hour ago whose key answers 404 is closed; a board row seen two hours ago makes no request; a "listed" answer serves the same row and another provider's row for five hours and the ATS is asked again past six. `detail.test.ts` and `agent/__tests__/liveness.test.ts` assert the same through the real check.
   - The durable marker the reviewer mentions is Schema request S-2 (optional).
2. **Medium: the apply click still opened the dead page. Fixed in the two callers I own.** `JobCard.tsx` and `JobDetailPanel.tsx` no longer hand `useJobActions` a link, so the hook's existing path runs: an empty tab inside the click, pointed at the link the server answers with, closed when the click is refused. On 409 `job_closed` the card now says "This job is no longer listed" in place (the existing `jobDetail.closed.title`), shows no apply button and raises no "That didn't work. Try again." toast. Tests with the tab as a recording object: no tab ever reaches the employer link on 409 (the card on both brands, and the job page).
   - **One thing beyond the reviewer's text.** An empty tab is wrong in a browser with one window (WeChat's and other apps' built-in browsers, an Android WebView, an iOS web view inside an app): there `window.open` loads its address in the page itself, so `about:blank` would replace our page and the answer would never arrive. Both callers pass one shared opener (`applyTabOpener` in `cardModel.ts`, built on the existing `lib/auth/inAppBrowser.ts`): with tabs it does exactly what the hook does; with one window it opens nothing inside the click, and the page itself goes to the answered link once the server has answered (which is what "open" does there anyway, and needs no pop-up permission). So the protection holds in WeChat too, and no page goes blank. Tested as a pure function with nine user-agent shapes and through the card.
   - This turns one unowned test red: see "Red tests for other bundles".
3. **Medium: adding a closed job to Ready to apply said "Your list is full". Fixed on the server; the wording needs Request O-10.** Confirmed: `hooks/job/useAddToReady.ts:25` and `components/features/agent/ReadyPage.tsx:266` word every `conflict` of `POST /agent/queue` as "full". The refusal is now **410 `gone` with `details.reason: 'job_closed'`** (it was 409 `conflict`), so no caller reads a closed job as a full list. Until O-10 lands the three surfaces print their generic line ("We couldn't add it. Try again." on the job page), which is vague but not false. Test: the two answers are distinct on the wire (410 `gone` / `job_closed` and 409 `conflict` / `queue_full`), also when the list is full and the job is closed.
4. **Low: no back-off per ATS host. Fixed.** After a 429 a host gets no request for 60 seconds, or for its `Retry-After` when that is longer (15 minutes at most); three failures in a row (a timeout, a 5xx, no connection) pause it for 60 seconds; an answer that shows the host working clears the count. A held-back posting is "unknown" (`host_paused`), is not remembered, and is asked after the pause. The job page now waits for the check for 1.5 seconds at most (`LISTING_WAIT_MS`); past that it is served from our own records and the check finishes and writes its answer by itself. The apply click waits for the whole answer. One test per rule.
5. **Low: the job page printed the provider-reading badge for every reader on both brands. Fixed, by the reviewer's first option.** One rule for the card and the page, `sponsorshipLabelsShown` in `feed/contract.ts`: an international row, and a person who needs sponsorship in the job's country. The page asks who the reader is (`deps.sponsorshipReader`, the match area's `userContext`) only for a row that carries a provider's reading, so every other job page costs nothing more. Without that answer the reading is not shown. The posting's own quoted statement stays on the page for every reader, as before. Similar-job items follow the same rule. Negative cases added to `detail.test.ts` (does not need it, said nothing, no profile, the read fails, no seam, the per-country answer, GoApply).
6. **Low: `confirmListing` loaded the ingest area on every ATS answer. Fixed.** The repair is resolved only after a "gone" answer (`liveness/index.ts`). Test: the loader is not called for "listed" or "cannot tell" and is called once for "gone".
7. **Low: New chips change inside one sitting; two left items had no Known gaps entry. Done as asked, in this handoff.** Schema request S-1 (`prevFeedVisitAt`) with the code that reads it; Known gaps 9 now describes both effects and names who; Known gaps 10 is the entry for carry-over M4.9. One correction to the reviewer's wording of that next step: `explainNow` already passes `fit.skills.missing`; what the carry-over asks for is `missingSide` ("Files with no owner" 2 of `waveM4-carryover.md`), and the entry says that.

The three entries the reviewer judged not done, each verified:

- **Credit line on similar jobs (M3.3 / M4.8): still half, correctly.** The server half is in place and nothing is shown uncredited. The two callers that must change have no owner in this phase (`components/features/job/SimilarJobs.tsx`, `server/src/features/copilot/areas.ts`): Requests O-4 and O-5, Known gaps 5.
- **`relevanceApplied` (M4.5) and skill labels in the request language (M4.6): server halves only, correctly.** `feed/routes.ts` and the "Ranked by" strip have no owner: Requests O-6 and O-7, Known gaps 7.
- **M3.4, M4.4, M4.9: not done, each now under Known gaps with the next step and who** (8, 6 and 10).

## Where I differ from the item text, and why

1. **The check does not use `getJson` of `sources/atsPublic/http.ts`** (item 1). `features/boundary.test.ts` forbids `jobs/liveness` from importing another area's internals, and the board area's index does not export that reader. The check has its own reader (`liveness/postingApi.ts`), which is stricter: three constant hosts, the URL built from a template and two encoded path segments, https only, no redirect, the identifying User-Agent of `sources/userAgent.ts`, a 4 s timeout. It also reads the body of a 404, which `getJson` hides: **a 404 counts as "closed" only when it is the API's own JSON answer**. A 404 page from a proxy is "unknown", so a live posting is never archived on it.
2. **Lever: a 404 is not always "closed".** I read the three public APIs on 2026-10-12 in the first session (12 GET requests, nothing stored). Lever answers the same 404 for a closed posting and for a live posting asked under the site name in another letter case. So a Lever posting is asked only in the spelling of one of the row's own identifiers that names the same key, and a 404 closes the row only when that spelling came from the board API itself. Under a spelling read from someone else's link, 200 still confirms the posting and 404 is "unknown". Greenhouse and SmartRecruiters read the tenant without regard to case.
3. **The "missed twice" rule is not for JSearch** (item 5, last ACCEPT line). `requests/waveM3-carryover.md` (MKT-5C.1) and strategy 1.5 ("JSearch: no signal") say the opposite of the item, and the cross-review already took JSearch out. The documents win. The test states the real rule with `activejobs`.
4. **The card prints "Posted 14 Dec 2025", not "Posted 300 days ago"** (item 4, first ACCEPT line). The item also says the card's namespace is not edited; the existing string is "Posted {date}". A relative form needs one new card string (Request I-2).
5. **Not every closed row gets `source_removed`** (item 1, CHANGE and first ACCEPT line). Only the ATS's own board row does. An aggregator's copy of the posting gets `ats_removed`. Strategy 1.5 says an aggregator has no closure signal, so its listing the posting again must not undo the ATS's own statement; with one reason for both, it did (finding 1).
6. **"A row seen 2 hours ago makes no request" holds for the ATS's own board row only** (item 1, throttle and ACCEPT). For a row of another source the date is that source's sighting, not the ATS's. Such a row is spared the request only by an answer the ATS gave this process within the window.
7. **Adding a closed job is refused with 410 `gone`, reason `job_closed`, not 409** (item 3, "the existing job_closed result"). The reason is the existing one; the platform code changed because every caller of that route words a 409 as "your list is full" (finding 3).
8. **The apply tab follows the server's answer** (item 2, "so the user is never sent to a dead page"). The item names only the server change; without the web change the page opened the link it already held before the 409 arrived (finding 2).

## Items

### 1. [P0] Liveness check against the ATS's documented single-posting endpoint: done

- `server/src/features/jobs/liveness/`: `postingApi.ts` (the three endpoints, the one request, `Retry-After`), `check.ts` (`checkPostingLive`, `applyLiveness`, the throttles, the host back-off), `index.ts` (`confirmListing`, `checkJobLive`), `check.test.ts`.
- `checkPostingLive(job, deps)` → `{ state, checkedAt, via, reason, requested }`. Greenhouse `boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}`, Lever `api.lever.co/v0/postings/{site}/{id}`, SmartRecruiters `api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}`. 200 with that posting → open. The API's JSON 404 → closed. Everything else → unknown, with nothing written: timeout, 5xx, 429, 400, 403, a redirect, a 200 of another shape, a SmartRecruiters posting marked `active: false`.
- No request at all for: a row with no key, a key of any other ATS (Workday, iCIMS, Ashby, Workable, `lever_eu`), a user's import, a bank row, a row that is closed already, and with `LIVENESS_CHECK_DISABLED=true`.
- Whose sighting counts: `lastSeenAt` answers only for the ATS's own board row (review finding 1; "Where I differ", 6).
- Throttles, in order: the kill switch; the board's own row seen listed under `LIVENESS_RECHECK_HOURS` (6) ago → answered from the row; an answer the ATS gave this process for the same key ("listed" for the recheck window and never under 10 minutes, "gone" and "cannot tell" for 10 minutes); two calls for one key share the request in flight; a paused host (429, or three failures in a row) → "unknown" with no request; at most 8 requests open at once in a process. One request per call at most.
- `applyLiveness(db, job, result, opts)` is the one writer. Open → `lastSeenAt` = the check moment (no database call when the row in hand already says so). Closed → `archivedAt`, `closedAt` and the close reason by who may reopen the row: `source_removed` for the ATS's own board row, `ats_removed` for every other row. **Beyond the item text:** it archives every other open public row that carries the same `atsPostingKey` too, in either market. A user's import, a bank row and a row closed for another reason are never touched.
- The dedupe repair is the ingest area's `applyDedupe`, read from `jobs/ingest/index.ts` at run time and only after a "gone" answer. That index does not export it yet (Request O-1). Until it does, an archived row hands its group over at the next ingest page that touches the group or at the daily `jobs-maintain`.
- ACCEPT, each asserted in `check.test.ts` (75 tests): `greenhouse:acme:1` + 404 → closed and archived (`source_removed` for the board's row, `ats_removed` for an aggregator's); 200 refreshes `lastSeenAt`; a timeout or 500 → unknown and no write; the board's row seen 2 hours ago → no request; a Workday key → no request; the URL comes from the stored key and goes only to the three hosts (ten keys tried, among them path, host and query injections).

### 2. [P0] Opening a job confirms it is still listed: done

- `jobs/detail/service.ts`: `get` runs the check beside the page's other reads and waits for it for 1.5 seconds at most (`LISTING_WAIT_MS`); the view is built from the row as the check left it. `recordApplyClick` runs it first, waits for the whole answer, and answers the existing 409 `job_closed`, so nothing moves to Applied. Both go on exactly as before when the check is absent, off, or cannot tell. Never asked for a private import, a bank row, a closed row or a row with no key.
- `contract.ts`: `job.listing { checkedAt, via: 'ats_api' | 'sync' | null }`, optional in the type and always sent. `defaultService.ts` wires the real check with the Prisma client.
- Web, job page (`JobDetailPanel.tsx`): the closed notice with "We last saw it listed on {date}." and, when this request's check found the posting gone, "We checked the employer's job board when you opened this page. It no longer lists this job." No apply button and no link to the dead page. When the apply click itself answers 409 `job_closed`, the page is read again once and shows the closed notice.
- Web, feed card (`JobCard.tsx`): on 409 `job_closed` the card says "This job is no longer listed" and offers no apply button.
- Web, both: the tab the click opens follows the server's answer (review finding 2), through one opener that is safe in a browser with one window (`cardModel.ts` `applyTabOpener`).
- ACCEPT (JI-10), asserted in `detail.test.ts` with the real check and a recording fake ATS: 404 → `status: 'closed'`, the row archived, a second open makes no request, the apply click answers 409 and creates no tracker entry; 500 and the kill switch leave the job as it was. `job.test.tsx` and `JobCard.test.tsx` cover the closed rendering and the tab on both brands.

### 3. [P1] "Ready to apply" checks the posting before a kit is prepared: done

- `agent/deps.ts`: `checkJobLive(jobId, db)`. It takes the database the service already holds as a second argument, so the agent's in-memory tests never open another client. Optional in the `AgentDeps` type, always present in `defaultAgentDeps()`.
- `agent/service.ts`: asked where a job enters the list (`addToQueue`, the weekly `generateList`) and at the start of preparation, before the existing closed test. Five checks at once, 8 s in all per list; a job not checked in time passes.
- Adding a job that is gone → **410 `gone`, `{ reason: 'job_closed' }`**, nothing inserted, no credit touched. In a multi-add the listed jobs are added and the gone one is left out. In the weekly list the next candidate takes its place. A kit whose job closed after it was started → `expired` with `job_closed`, the `ready_kits` reservation released (`kit_job_closed`), no tailoring and no letter.
- A job whose row is already closed is refused at the entrance the same way. Before, it was inserted as `picked` and expired at the next list read.
- Reading the list never asks.
- TESTS: `agent/__tests__/liveness.test.ts` (17), including the production seam over the in-memory database with a recording fetch.

### 4. [P1] Three separate date facts; "New" means first seen by us: done

- Wire (`feed/contract.ts`, `feed/items.ts`, `jobs/detail/view.ts`): `postedAt` is the employer's date and nothing else; it is null whenever the stored date is one we assigned (`postedAtEstimated`). `firstSeenAt` and `lastSeenAt` travel as their own fields; `isNew` is a field, not a badge. This replaces the interim `displayPostedAt` rule (M3 carry-over 3a).
- `isNewPosting(firstSeenAt, now, newSince)` in `feed/contract.ts`, `NEW_WINDOW_HOURS = 48`. Never derived from the posted date.
- `FeedQueryService.ts` passes the previous visit as `newSince`. The instant travels in the cursor (`<session>:<offset>:<base-36 ms>`), because the stored stamp moves when the first page is served. A stamp younger than a feed session (30 min) is not a previous visit; then, and for a person who never opened the list, the 48-hour rule applies. The limit of that is Known gaps 9.
- Web: `cardModel.ts` `cardDates` and `cardIsNew`. "Posted {date}" only for the employer's date. Without one the card says "First seen {date}", and "Last checked {date}" is the "last verified" line. The New chip sits beside the three fact badges, so it is never cut by the cap. `JobHeader.tsx` prints posted, first seen (left out when it is the same day as posted) and last checked.
- ACCEPT: asserted in `items.test.ts`, `FeedQueryService.test.ts`, `cardModel.test.ts`, `JobCard.test.tsx`, `job.test.tsx`.

### 5. [P1] Mainland rows close by validity, disappearance, or 45 days unseen: done

- `ingest/maintain.ts`: step 2b `archiveUnseenMainland` / `buildUnseenMainlandSql`. Public rows of market `cn` whose `lastSeenAt` is older than `CN_UNSEEN_DAYS` (45), every board except `user_import`, archived as `expired`. The market is a constant of the statement. `MaintainResult.unseenMainland`.
- `ingest/tracking.ts`: `missedRuleApplies(adapter)` is the one place that says which sources the "missed twice" rule is for.
- For MKT-5E's merge check: `CN_UNSEEN_DAYS` is 45, and the close reason is `expired`, which the upsert reopens when the bank lists the job again with no deadline.
- TESTS: `maintain.test.ts` (44) and `tracking.test.ts` (7). See "Where I differ", 3.

### 6. [P1] A job is labelled as sponsoring only with the posting's quote or as a labelled provider reading: done

- One rule for the label, `sponsorshipSignalOf(row)` in `feed/contract.ts`: (a) a quote → the quoted badge, unchanged; (b) `offered` with `sponsorshipSource 'provider:<id>'` and no quote → kind `sponsorship_provider` with the registry's display name, no quote; (c) a provider's `not_offered` alone → nothing; (d) anything else → nothing. No company fact is an input.
- One rule for who sees it, `sponsorshipLabelsShown(row, reader)` in `feed/contract.ts`: an international row and a person who needs sponsorship in the job's country. The card applies it to every sponsorship badge (as before). The job page applies it to the provider's reading (review finding 5); the posting's own quote stays for every reader there.
- Job page: `job.sponsorship` stays `not_stated` for a provider reading and carries `providerReading { status: 'offered', provider }` beside it, for a reader it is shown to.
- The list projection does not select `sponsorshipSource` (`feed/sql.ts` is MKT-5F's). `FeedQueryService.items` reads the column for the rows of a page that could carry the badge, in one small statement. It stops by itself once the row carries the column (Requests F-1, O-2).
- ACCEPT: the four cases in `items.test.ts` and `detail.test.ts`; a person who does not need sponsorship sees neither badge, on the card and on the page; GoApply shows none.

### Carry-over

| Entry | State |
|---|---|
| M1 / M2 / M3.2: PAR 7a, `publicList` keeps a hard 45-day window | **Done.** It takes the `ageFloor` form. |
| M3.1: `runCount`; the missed-twice rule and JSearch | **Done** (documented in `tracking.ts`, tested). |
| M3.3 / M4.8: the credit line on similar jobs | **Half done** (server). Requests O-4, O-5; Known gaps 5. |
| M3.3a: three date facts, interim rule | **Done** (item 4). |
| M3.3b: `statesAmount` with the row's country | **Done** in `feed/items.ts` and `jobs/detail/view.ts`. |
| M3.4: best `publicDisplay` row for the public readers | **Not done.** Known gaps 8. |
| M3.5, M4.7, M4.10 | For information; nothing changed. |
| M4.1: queue the skills-only pass | **Done.** Step 6c of `runEnrichCatchUp`. |
| M4.2: stale rows newest first | **Done.** `ENRICH_REQUEUE_PER_RUN` stays 500. |
| M4.3: delete `NO_DATE_EXPIRY_BOARDS` | **Done**, with its assertion. |
| M4.4: wrong-title weight in the Ready weekly selection | **Not done**, on purpose. Known gaps 6. |
| M4.5: `relevanceApplied` on the first page | **Server half done.** Request O-7. |
| M4.6: skill labels in the request language | **Job page done.** Feed: Request O-6. Ready: a Ready row shows no skill label. Known gaps 7. |
| M4.9: `explainNow` and `explainMatch` | **Not done.** Known gaps 10. |

## Files changed

All paths are under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-5C/`.

New
- `server/src/features/jobs/liveness/index.ts`, `check.ts`, `postingApi.ts`, `check.test.ts`
- `server/src/features/agent/__tests__/liveness.test.ts`
- `server/src/features/jobs/ingest/tracking.test.ts`
- `components/features/feed/JobCard.test.tsx` (colocated with the owned `JobCard.tsx`)

Changed
- `server/src/features/jobs/detail/`: `contract.ts`, `view.ts`, `service.ts`, `defaultService.ts`, `routes.ts`, `index.ts`, `detail.test.ts`
- `server/src/features/jobs/ingest/`: `maintain.ts`, `maintain.test.ts`, `tracking.ts`
- `server/src/features/agent/`: `deps.ts`, `service.ts`
- `server/src/features/feed/`: `contract.ts`, `items.ts`, `items.test.ts`, `FeedQueryService.ts`, `FeedQueryService.test.ts`
- `components/features/job/`: `JobHeader.tsx`, `JobDetailPanel.tsx`, `job.test.tsx`
- `components/features/feed/`: `cardModel.ts`, `cardModel.test.ts`, `JobCard.tsx`
- `i18n/staging/jobDetail.en.json`

Touched in the review round: the three `liveness` sources and their test, `detail/{service,view,contract,defaultService,index}.ts` and `detail.test.ts`, `agent/{service,deps}.ts` and its test, `feed/{contract,items}.ts` and `items.test.ts`, `JobCard.tsx`, `JobDetailPanel.tsx`, `cardModel.ts` and the three web tests. Nothing outside the owns. No `*.prisma`, no billing code, no new dependency.

## Tests run

All in the worktree, on the final tree.

| Command | Result |
|---|---|
| `npx vitest run --exclude ".claude/**"` | 762 files: **761 passed, 1 failed**. 19,848 tests passed, 1 failed, 1 skipped, 10 todo. The one failure is the unowned test listed below. Run twice (after the server changes and after the last web change): the same single failure both times. |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | clean (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M4` | exit 0 |

Owned test files, 559 tests, all green: `liveness/check.test.ts` 75, `jobs/detail/detail.test.ts` 124, `agent/__tests__/liveness.test.ts` 17, `feed/items.test.ts` 42, `feed/FeedQueryService.test.ts` 138, `ingest/maintain.test.ts` 44, `ingest/tracking.test.ts` 7, `job/job.test.tsx` 66, `feed/cardModel.test.ts` 32, `feed/JobCard.test.tsx` 14.

No test reaches a network or a database: the ATS is a recording fake fetch, the database a fake Prisma.

## Red tests for other bundles

- **`components/features/feed/cnListing.test.tsx`** › "GoApply card with the listing contract" › "the apply button opens apply.url in a new tab inside the click, and records the click". No bundle owns the file in M5: **orchestrator**. It asserts that the employer link is opened inside the click, before the server has answered, which is the defect of review finding 2 (its fixture is a board row with a SmartRecruiters posting, exactly a row the click-time check can find gone). It should now assert that an empty tab is opened inside the click and goes to the link the server answers with:

  ```ts
  const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
  const open = vi.fn(() => tab);
  vi.stubGlobal('open', open);
  renderFeed(card(board), { brand: 'goapply' });
  fireEvent.click(screen.getByRole('button', { name: "Apply on the employer's careers site" }));
  expect(open.mock.calls).toEqual([['about:blank', '_blank']]);
  await waitFor(() => expect(tab.location.href).toBe('https://careers.example-tech.cn/jobs/744000012345678'));
  expect(net.to('POST', '/api/v1/roboapply/jobs/job_fixture_cn_board_1/apply-click')).toHaveLength(1);
  ```

  The same assertions pass today in `components/features/feed/JobCard.test.tsx` ("the tab is empty inside the click and goes to the link the server answers with").

## Pre-existing failures

None.

## Requests

**Orchestrator**

- **O-1. `server/src/features/jobs/ingest/index.ts`:** add `export { applyDedupe } from './upsert.js';`. The liveness check then repairs the dedupe group in the same request as the archive (no other edit). Check afterwards: `npx vitest run server/src/features/jobs/liveness`.
- **O-2. `server/src/features/feed/types.ts`:** add `sponsorshipSource: string | null;` to `FeedJobRow` after `sponsorshipEvidence`, and `sponsorshipSource: null,` to `feedRow` in `feed/testkit.ts`. Goes with F-1.
- **O-3. `server/src/features/jobs/ingest/cron.ts`:** `processed` could include `result.unseenMainland`. The count is already in the log and the result.
- **O-4. `server/src/features/copilot/areas.ts` (`similarJobs`):** `detail.similar(userId, jobId, { creditLines: true })`. The Assistant's card prints `cardMeta.tw_sources.attribution` already.
- **O-5. `components/features/job/SimilarJobs.tsx` (no owner):** print `item.cardMeta?.tw_sources?.attribution` under a card that has it (`JobMetaTw` has the sentence). In the same change pass `creditLines: true` in the `/:id/similar` handler of `jobs/detail/routes.ts`, and rewrite the test "similar jobs never recommend a row whose credit line …" in `detail.test.ts`.
- **O-6. `server/src/features/feed/routes.ts`:** `service.query(ctx, { ...body, locale: localeOf(req, ctx.market) })`, so the skill labels of a card's fit follow the request language.
- **O-7. The feed's "Ranked by" strip (web, no owner):** hide it when the first page answers `relevanceApplied: false`.
- **O-8. Merge check with MKT-5B:** if its connector reads Lever's EU host, see Known gaps 2.
- **O-9. Plan documents** (MKT-5H's files), the "as built" text: the rows "Posting key" (consumer: liveness), "Sponsorship source" and "New-since instant" are the Items section above. New since the review: a row closed by the check carries `source_removed` (the ATS's own board row) or `ats_removed` (any other row; never reopened by a listing); only the board row's `lastSeenAt` counts as the ATS's sighting; a host is paused after a 429 or three failures; the job page waits 1.5 s for the check; `POST /agent/queue` answers 410 `gone` / `job_closed` for a closed job; the provider reading is shown on the job page by the card's rule; the apply tab follows the server's answer.
- **O-10. Say "the job closed" when adding to Ready to apply** (three files, no owner; review finding 3):
  - `hooks/job/useAddToReady.ts`: add the status `'closed'`; in the `catch`, read `apiErrorDetails<{ reason?: unknown }>(err)?.reason`: `'job_closed'` → `'closed'` (and invalidate the `job` queries, so the job page reads itself again and arrives closed), `'queue_full'` → `'full'`, anything else → `'error'`. A hook test for the three cases.
  - `components/features/job/GetReadyChecklist.tsx` (line 140) and `components/features/agent/KitReview.tsx` (line 83): for `'closed'` print the existing `ready.review.errors.closed` ("This job is no longer listed by the company.").
  - `components/features/agent/ReadyPage.tsx` (line 266): `const reason = kitErrorReason(err)`; `'job_closed'` → `t('review.errors.closed')`, `'queue_full'` → `t('suggestions.full')`, else `t('suggestions.failed')`.
- **O-11. Optional: move the tab rule into the hook** (`hooks/shared/useJobActions.ts`, no owner). Its `applyOnCompanySite` still opens `options.applyUrl` inside the click when a caller passes one, and its default `blank()` opens `about:blank` in a browser with one window. Make the hook never open a link before `applyClick` resolves, and make its default opener `createApplyTabOpener` (now in `components/features/feed/cardModel.ts`; `lib/ui/` is a better home). Then `JobCard.tsx` and `JobDetailPanel.tsx` drop their `opener` option, and `hooks/shared/sharedHooks.test.tsx` ("opens the known URL inside the click") is rewritten. `components/features/agent/KitParts.tsx` `openPendingTab` has the same one-window weakness and could use the same rule.
- **O-12. The red test above** (`cnListing.test.tsx`).

**MKT-5F**

- **F-1. `server/src/features/feed/sql.ts` (`FEED_COLUMNS`):** add `j."sponsorshipSource"` after `j."sponsorshipEvidence"`. With O-2 the provider badge needs no extra read; `withSponsorshipSource` and `sponsorshipSourceSql` in `FeedQueryService.ts` can then be deleted.

**MKT-5G**

- **G-1. `components/features/job/JobOverview.tsx`:** optional. To print the provider reading in the work-authorization block too: when `job.sponsorship.providerReading` is set (it is set only for a reader it is shown to), one line `t('header.badge.sponsorship_provider', { provider })` with no quote.
- For information: `needsSponsorshipFor` keeps its name and signature in `feed/items.ts` (it now lives in `feed/contract.ts` and is re-exported).

**MKT-5H**: the two variables under "Env variables" below (the meaning of the second changed in the review round).

**i18n pass**

- **I-1.** Translate the three keys below into the nine locales. `jobDetail.closed.lastSeen` is no longer read by any component and can go into `i18n/staging/clean.remove.json`.
- **I-2.** Optional: a card string `jobs.card.postedAgo` = "Posted {when}", if the owner wants "Posted 300 days ago" on the card.

## Schema requests

Both additive. Neither is needed for the acceptance lines.

- **S-1. `RAUserUiState.prevFeedVisitAt`** (`server/prisma/schema/ra-notify.prisma`; review finding 7):

  ```prisma
  /// The value `lastFeedVisitAt` held before the current sitting began (a sitting: openings of the
  /// list less than a feed session, 30 minutes, apart). The "New" chips count from it for the whole sitting.
  prevFeedVisitAt DateTime?
  ```

  Code once it exists: in `feed/repo.ts` (no owner) `stampFeedVisit(userId, at)` copies the old `lastFeedVisitAt` into `prevFeedVisitAt` when the old stamp is null or at least a session older than `at`, and `lastFeedVisit` returns both; in `FeedQueryService.ts` `previousVisit(stamp, previous, now)` returns `stamp` when it is at least a session old and `previous` otherwise (null → the 48-hour rule, as today). One test: a second list opened five minutes after the first marks the same rows new.
- **S-2. Optional: `RAJob.liveCheckedAt`** (`server/prisma/schema/ra-jobs.prisma`; review finding 1):

  ```prisma
  /// When the posting's ATS last confirmed it listed through its public posting API (jobs/liveness). Null: never asked.
  liveCheckedAt DateTime?
  ```

  Today the ATS's confirmation of a row that is not its own board row lives in process memory, so each new process asks once. With the column: `applyLiveness` writes it on "listed" for every open row of the key, `LIVENESS_JOB_SELECT` and `JOB_ROW_SELECT` read it, and `checkPostingLive` answers "open" from it inside the window for any row.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `LIVENESS_CHECK_DISABLED` | `true` (or `1`, `yes`, `on`) turns the on-demand posting check off: no request is ever made, and the job page, the apply click and Ready to apply behave as before the check. Shared by both brands. | `false` |
| `LIVENESS_RECHECK_HOURS` | A posting its ATS confirmed listed within this many hours is not asked about again. The confirmation is either the ATS's own board sync having seen the row (any process) or the ATS's answer earlier in the same process. A whole or decimal number from 0 to 720; anything else is the default. With 0 a "listed" answer is still reused for 10 minutes. | `6` |

Named constants with no variable: `CN_UNSEEN_DAYS` 45, `NEW_WINDOW_HOURS` 48, `LIVENESS_TIMEOUT_MS` 4,000, `LIVENESS_CACHE_MS` 10 minutes, `LIVENESS_MAX_IN_FLIGHT` 8, `LIVENESS_HOST_PAUSE_MS` 60,000, `LIVENESS_HOST_PAUSE_MAX_MS` 15 minutes, `LIVENESS_HOST_FAILURES_TO_PAUSE` 3, `LISTING_WAIT_MS` 1,500 (job page), `LIVE_CHECK_BUDGET_MS` 8,000 (Ready to apply).

## i18n keys added or changed

`i18n/staging/jobDetail.en.json` (brand-neutral; no GoApply-only copy; nothing Taiwan-specific). Unchanged by the review round.

| Key | English |
|---|---|
| `jobDetail.header.badge.sponsorship_provider` | `{provider} lists visa sponsorship` |
| `jobDetail.closed.boardCheck` | `We checked the employer's job board when you opened this page. It no longer lists this job.` |
| `jobDetail.closed.lastListed` | `We last saw it listed on {date}.` |

Existing strings reused: the card reads the first key, `jobDetail.closed.title` ("This job is no longer listed", for a card whose apply click found the posting gone), `jobs.card.posted`, `firstSeen`, `lastChecked`, `badge.new`; the header reads `jobDetail.header.posted`, `firstSeen`, `lastChecked`, `badge.new`. `{provider}` is a provider's display name from the server ("Active Jobs DB") and is not translated.

## Known gaps

Each with the next step and who must act.

1. **Dedupe hand-over right after a closure waits for O-1.** Until then the group is repaired at the next ingest page that touches it or at the daily `jobs-maintain`. Who: orchestrator, one line.
2. **`lever_eu` keys are never checked.** `api.eu.lever.co` is not one of the three hosts. Next step, once MKT-5B's connector reads that host: add `lever_eu` to `LIVENESS_ATS` and `POSTING_ENDPOINTS` in `liveness/postingApi.ts` (the `lever` entry with the EU host) and one test. Who: orchestrator.
3. **A Lever posting reached only through someone else's link is confirmed open by the check but not closed by a 404.** It still closes through its board row (the shared posting key) or its expiry date. To close it on the spot, confirm the site with one listing request before trusting the 404; that is a second request per check. Who: owner decides.
4. **SmartRecruiters' answer for a closed posting was not observed.** An id that belongs to no posting of the company answered 400, which is "unknown" here. If a closed posting also answers 400, SmartRecruiters rows are confirmed by the check but closed only by their board sync. Next step: read one posting id known to be closed. Who: owner or orchestrator; one GET.
5. **Similar jobs on the job page still hold 台灣就業通 and 事求人 rows out** until `SimilarJobs.tsx` prints the credit line (O-5). The Assistant's list needs O-4 only. Who: orchestrator.
6. **The Ready weekly selection does not get the wrong-title weight** (M4.4). Asking for `sort: 'recommended'` is not a safe swap: the list would be cut from the top 50 of Recommended instead of the top 50 by fit, so fewer candidates reach the minimum tier and the weekly target is missed more often; it would also turn `agent/__tests__/service.test.ts` red. The right change is the other one the carry-over names: the feed seam exposes the person's negative role and title weights (`feed/index.ts`, no owner) and `applyDislikes` demotes those jobs. Who: orchestrator, or a follow-up bundle that owns `feed/index.ts` and `agent/`.
7. **Callers of `getFits` with no owner still pass no language** (`alerts/service.ts`, `lifecycle/repo.ts`, `onboarding/defaults.ts`), and the feed route needs O-6. Who: orchestrator.
8. **M3.4** (the best `publicDisplay` row for public readers) waits for the owner's answer to Owner 3 of `waveM3-carryover.md`; `features/seo/scope.ts` is not mine. Who: owner, then orchestrator.
9. **New chips can change inside one sitting, and the nav count can differ from them.** The first list of a sitting marks "first seen since my last visit" and stamps the visit. Any other list opened within 30 minutes (another sort, another fit tier, a changed filter, a reload) cannot know that earlier visit and marks "first seen in the last 48 hours". A person who was away five days sees chips disappear when they switch to Newest; one who was away three hours sees many appear. Paging inside one list is not affected (the instant travels in the cursor). Next step: Schema request S-1 and the code written under it. Who: orchestrator pushes the column (additive, the Neon branch first, each deployment database before its deploy); the code is in `feed/repo.ts` (no owner) and `FeedQueryService.ts`.
10. **`explainNow` does not pass a missing side** (M4.9). `features/compliance/explainMatch.ts` has no owner and does not take the input yet. Next step, in this order: (a) in `explainMatch.ts` add `missingSide?: Partial<Record<MatchDimensionKey, 'posting' | 'person'>>` to `ExplainMatchInput`, the three `legal.explain.profileMissing.*` keys and the third headline, as "Files with no owner" 2 of `waveM4-carryover.md` spells out; (b) in `jobs/detail/defaultService.ts` `explainNow` pass `missingSide` from the fit (`confidenceReason`) and the posting. Nothing is false today: the page says "Not enough to compare …". Who: orchestrator, or a follow-up bundle that owns `features/compliance`.
11. **The check's memory is per process.** Answers, host pauses and requests in flight are kept in the process. A new process (a cold serverless instance) asks the ATS once more about a row that is not the ATS's own board row. Bounded by one request per posting per process per window, 8 at once and the host pause. Next step: Schema request S-2. Who: orchestrator and owner.
12. **An aggregator-only posting that its ATS lists again under the same id stays closed.** `ats_removed` is never reopened by a listing, on purpose. Where we also read the employer's board, the board row is reopened by the board and nothing is lost. Where we do not, that one posting stays out. Next step if the owner wants it back: in the daily `jobs-maintain`, for rows closed as `ats_removed` whose `lastSeenAt` is later than `closedAt` (their source listed them again), ask the ATS once (a small cap per run) and reopen on a 200. That adds scheduled requests to the three hosts, so it is the owner's call. Who: owner.
13. **Adding a closed job to Ready to apply prints the generic "could not be added" line** ("We couldn't add it. Try again." on the job page) until O-10 lands. Who: orchestrator.
14. **A posting whose ATS takes longer than 1.5 seconds to answer is shown open on the job page.** The apply click then waits for the answer and refuses a posting that is gone, so nobody is sent to it. By design (review finding 4).
