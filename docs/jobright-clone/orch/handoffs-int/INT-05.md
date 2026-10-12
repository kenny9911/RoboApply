INT-05 · status: **complete** — 16 of 17 items done, 1 deferred as its own text specifies. All 8 review findings were verified as real; 7 are fixed in code and 1 (launch prerequisite) is a database check for the orchestrator. All four gates are green. Nothing was committed, pushed or stashed, and no dev server, browser or database was touched.

On the relayed request ("launch the new version and let me try out"): nothing was launched from this bundle, because it is server-only and bundles may not start servers. Before the orchestrator launches, the database check under Requests must pass, or the first feed page, every job report and every ingest batch will fail.

Worktree: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-05` (branch `wp/INT-05`). Paths below are relative to `server/src/` unless they start with `__tests__/`.

## Review resolution

| # | Finding | Result |
|---|---|---|
| 1 | Rules-only enrichment retry repeats once the queue prunes its items | **Fixed.** The pass is now recorded on the row. A rules-only finish writes `enrichModel = 'rules'` only for `no_model` and `budget_disabled`; `covered`, `no_ai_consent` and `llm_failed` write the new `'rules_checked'`, which maintenance never selects. New tests drain with the real `enrichJob`, drop the work items, and expect nothing queued on later runs. |
| 2 | `apply_closes` written from dates that are not application deadlines | **Fixed** in `cn/jobs/card.ts`. "截止 + date" needs an application word directly before it or in the same clause, or the bare label opening its line. "date + 前/截止" needs the application word in the same clause, and is skipped when the date bounds starting work, graduating, a certificate or an age. Both reviewer sentences are negative tests. |
| 3 | `school_tier` and `cn_hire` ignore negation and context | **Fixed.** School tiers: a negation before the tier list or a waiver after it gives no tag; "非211院校勿投" still gives one. Hire type: a duty verb earlier in the clause, or a role/experience word right after, gives no tag. Bare 无 is no longer a negation for hire words, so "无锡校招岗位" is tagged. All reviewer sentences are tests. |
| 4 | Launch prerequisite: three schema objects with no fallback | **Not a code change.** Stays under Requests; I may not touch a database. |
| 5 | Job-page undo of a re-application leaves `outcome` empty | **Fixed** in `features/jobs/detail/service.ts`. Undo back to an ended stage restores the outcome and writes the matching `outcome` event, using the tracker's own `OUTCOME_STATUS` map. The cited test now asserts outcome and both events. |
| 6 | `publicList` applies public-page rules after LIMIT | **Fixed.** The not-expired rule and the "recruiter bank or allowed board" rule are now in the statement, so LIMIT counts listable rows. `publicPageIds` stays as the final guard. `FeedRepo` gained `publicBoards()`. |
| 7 | A cleared GoApply fraud flag can be re-added at ingest when the review log read fails | **Fixed** in `cn/jobs/service.ts`. With the review log unreadable, ingest emits no new flag; incoming flags pass through and enrichment decides. Blacklist and review log are now read separately, so a blacklist failure alone keeps keyword flags. An import still shows its warnings. |
| 8 | One user's preview failure aborts the fit-score precompute run | **Fixed** in `features/match/cron.ts`. Each user runs in its own try/catch; a failure is logged and counted in a new `failed` field. The test has the first user throw and the next two still queued. |
| — | Unowned edit `features/match/index.test.ts` | **Kept.** It is a test colocated with `features/match/index.ts`, which I own. |
| — | Unmet item 17 | **Still not done**, as its own text requires: no live-form evidence, `jobs/normalize/ats.ts` untouched. |

No finding was rejected.

## Per-item result

| # | Item | Result |
|---|---|---|
| 1 | `marketStats.salary`, `feedSignals`, offers switch | Done. |
| 2 | `sampleForFilters`, precompute from preview, limit exports | Done. Precompute now also survives one user's failure. |
| 3 | `publicList` public-page rules | Done; rules now apply in the statement and again in the re-check. |
| 4 | `FeedItem.cardMeta` / `explanation`, browse, job-page meta | Done. |
| 5a | Mode-off in match and saved-search readers | Done. |
| 5b | Mode-off route scan | Done. `tracker` and `notifications` stay as `it.todo`. |
| 5c | Upsert persists `fraudFlags` / `marketTags` | Done (add-only merge). |
| 5d | SKU `ra_cn_fraud_check` | Done. |
| 6 | GoApply non-personalised order | Confirmed and tested. |
| 7 | `feedService.alertCandidates` | Done; returns `{ ids, truncated }`. |
| 8 | Apply/undo consolidation | Done; undo now restores the outcome of an ended stage. |
| 9 | "Practiced" step | Done. |
| 10 | Imports | Save of own private rows and 409 `no_apply_link` were already in place (tests added). External count and import warnings done. |
| 11 | Taiwan ATS source | Done. |
| 12 | Enrichment maintenance | Done, capped at 500 per run; retry state now lives on the row. |
| 13 | `originalHost` upsert, `windowEndsId` column | Done. |
| 14 | GoApply tag producers | Done, now with context and negation rules. |
| 15 | Reporter count after an admin decision; cleared scam rules | Done. |
| 16 | DOL LCA importer | Done; only a dry run on the fixture was executed. |
| 17 | hotjob.cn → dayee host | Not done: deferred, no live-form evidence. |

## Behaviour changes worth knowing

- **`RAJob.enrichModel` has a new value, `'rules_checked'`.** It means rules-only and settled for this `ENRICH_VERSION`. Existing `'rules'` rows get one forced pass and then settle.
- **A job whose model call failed on its last attempt is not retried** until the posting changes or `ENRICH_VERSION` is bumped. That was also the case before this bundle.
- **A GoApply import without AI consent is settled as rules-only.** Granting consent later does not re-enrich old imports on its own.
- **The GoApply tag readers give no tag when in doubt.** A campus posting that only says "开展2027届校园招聘" gets no `cn_hire:campus`, but the feed's 届别 fallback still lists it under 校招.
- **A date range with no close word gives no `apply_closes` tag** ("网申时间：2026年9月1日至2026年11月30日").
- **At ingest with the review log unreadable, a brand-new fee-scam posting is unflagged until its enrichment runs.** New jobs are queued for enrichment immediately.
- **Precompute result has a new `failed` count.**
- **Unchanged from the previous handoff:**
  - Explore tile counts use the 120-day floor.
  - Precompute looks at 50 candidates and skips GoApply users without the personalised-recommendation consent.
  - Ingest merge is add-only.
  - `FeedItem.explanation.mode` is a loose string.
  - `COMPETITIVENESS_LIMITS.sampleMax` is still 50.

## Files

**Created**
- `features/feed/marketStats.ts`, `signals.ts`
- `features/feed/marketStats.test.ts`, `signals.test.ts`, `seams.test.ts`, `personalization.cn.test.ts`
- `features/jobs/data/lca.ts`, `importLca.ts`, `lca.test.ts`, `__fixtures__/LCA_Disclosure_Data_FY2026_Q1.sample.csv`
- `features/jobs/ingest/maintain.test.ts`, `index.test.ts`
- `features/match/index.test.ts` (colocated test, outside the owns list — kept)
- `features/cn/jobs/__tests__/repository.test.ts`

**Modified** (plus matching tests and three snapshots)
- feed: `FeedQueryService.ts`, `contract.ts`, `defaultService.ts`, `index.ts`, `items.ts`, `repo.ts`, `sql.ts`, `testkit.ts`
- jobs/detail: `contract.ts`, `defaultService.ts`, `service.ts`, `view.ts`
- jobs/enrich: `agent.ts`, `reconcile.ts`, `repository.ts`, `service.ts`, `schema.ts`, `index.ts`
- jobs/import: `index.ts`, `service.ts`
- jobs/ingest: `cron.ts`, `index.ts`, `maintain.ts`, `pipeline.ts`, `upsert.ts`
- jobs/normalize: `identity.ts`, `salary.ts`, `types.ts`
- jobs/sources: `index.ts`, `types.ts`, `atsPublic/adapter.ts`
- match: `CompetitivenessService.ts`, `MatchService.ts`, `config.ts`, `contract.ts`, `cron.ts`, `index.ts`, `repo.ts`, `reportInventory.ts`, `testkit.ts`
- `features/offers/postedRange.ts`, `features/search/SearchProfileService.ts`
- cn/jobs: `card.ts`, `repository.ts`, `service.ts`, `__tests__/modeOff.routes.test.ts`
- `lib/matchBilling.ts`, `roboapply/v2/lib/raFeatureCatalog.ts`
- `__tests__/fixtures/feed/index.ts`, `__tests__/fixtures/jobs/index.ts`

Touched in this review round: `jobs/enrich/schema.ts`, `index.ts`, `service.ts`; `jobs/ingest/maintain.ts`; `jobs/detail/service.ts`; `feed/sql.ts`, `repo.ts`, `FeedQueryService.ts`, `testkit.ts`; `match/cron.ts`; `cn/jobs/card.ts`, `service.ts`; and their tests.

**Deleted**: none.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/{feed,jobs,search,offers,tw,cn/jobs,match} server/src/roboapply/v2/lib/raFeatureCatalog.test.ts server/src/features/boundary.test.ts server/src/test/areaStubs.test.ts __tests__/contracts` | 94 files, 2282 passed, 1 skipped, 8 todo |
| `npm run typecheck:server` | clean |
| `npm run typecheck:web` | clean |
| `npm run check` | 6 of 6 checks pass |
| `npx vitest run --exclude ".claude/**"` | 557 files, 10144 passed, 1 skipped, 21 todo |

The full suite ran once after the last change and was clean on that run.

## Requests

- **Orchestrator / owner — before launch.** Confirm the target dev database has `RAJob.originalHost` (SCHEMA-2), `RAFeedSession.windowEndsId` (SCHEMA-3) and `RAJobReview` (SCHEMA-5). `prisma db push` needs the owner's confirmation. Then run the live ingest smoke: it exercises the upsert's new `ON CONFLICT` JSON merge on Postgres for the first time.
- **J1 (orchestrator)**: point copilot `areas.ts` at `marketStats.salary(input)` and `feedSignals` from `features/feed/index.js`.
- **J3 (orchestrator)**: `admin/limits.ts` can import `scoreDailyBudget`, `scoreCounterKeys` from `features/match/index.js` and `dailyCallLimit` from `features/jobs/ingest/index.js`.
- **J4 (orchestrator / INT-07)**: replace `repo.candidateJobIds(...)` with `feedService.alertCandidates(row.id, { since, limit, postedSince })`; it returns `{ ids, truncated }`.
- **J8 (orchestrator)**: remove `tracker` and `notifications` from `NOT_EXERCISED` in `modeOff.routes.test.ts` once INT-04 and INT-07 land their tests.
- **INT-06**: add `as const` to the `explanation` literal in `components/features/feed/cardModel.test.ts` (around line 156); then `FeedExplanation` can become `MatchExplanation` exactly.
- **INT-08**:
  - The admin "Keep" must write an `RAJobReview` row with `decision: 'restore'` and `clearedRules`.
  - Point the retired `feedRankingFor` todo at `features/feed/personalization.cn.test.ts`.
  - Any admin view that reads `RAJob.enrichModel` should treat `'rules_checked'` like `'rules'` (no model ran).
- **INT-04**:
  - Tracker writers still need the `trackerEntryLockKey` lock.
  - The tracker's token-less undo window is 10 minutes; the job page's is 24 hours.
  - Optionally export `outcomeForStatus` from `features/tracker/index.ts`; the job page currently derives it from `OUTCOME_STATUS`.
- **INT-09 (visitor)**: the comment at `features/visitor/routes.ts` line 91 says `publicList` does not apply the whole public-page predicate; it now does.
- **Owner (H-1B data)**: `npx tsx server/src/features/jobs/data/importLca.ts <file.csv|file.xlsx> [--fiscal-year 2026] [--min-wage-sample 20] [--dry-run]`. Without `--dry-run` it writes to `DATABASE_URL`.

## i18n keys

None added, none obsoleted.

## Env vars

None introduced. The enrichment catch-up cap is a code constant (`ENRICH_REQUEUE_PER_RUN = 500`).

## Known gaps

- Item 17 remains deferred.
- The upsert merge and the new visitor-list predicates are tested on generated SQL and fakes only, never on a real database.
- The precompute still builds full feed cards through `preview` and discards them; this is a cost, not a correctness issue.
- The GoApply tag readers are rule-based. Known misses: "支持校招/社招同步投递" gets no hire tag, and "校园招聘实习生" as a title is tagged campus.
- The `seo` router has no postings-allowed control in the mode-off scan.
- `FeedItem.explanation` is loosely typed until INT-06's one-line change.