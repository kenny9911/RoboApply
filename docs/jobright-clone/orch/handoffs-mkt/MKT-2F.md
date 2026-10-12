# MKT-2F

Every consumer reads the one fit: lists, the Assistant, tailoring, stored snapshots, the every-seam contract test; Similar jobs takes a vector source (rest of SM-5; parts of SM-3, SM-7, SM-11). Worktree `wp-MKT-2F`, branch `wp/MKT-2F`. Nothing committed, pushed or run against a database, a model, an embeddings endpoint or the network.

Status after the review pass: six items are done. **Item 4 is done except one ACCEPT line** ("An alert mail sent for an estimated job says so"): the line is rendered by a template that no M2 bundle owns, so it is **Request 1, which is not optional** and must be applied at the M2 merge before item 4 is accepted. The literal grep of item 1 still prints the Assistant's own adapter name, declared in a file I do not own (Request 2). Everything else the review raised is fixed in code with a test (see "Review resolution").

Gates in this worktree: 678 test files / 15,870 tests green (base 675 / 15,702), both typechecks, `npm run check`, `npm run eval:match -- --enforce M2` exits 0. Every changed path is inside my owns (checked against `market-bundles.json` by script).

## Items

### 1. [P0] List surfaces read `getFits`. Done (the literal grep keeps one name: Request 2).

- **Alerts** (`alerts/service.ts`, `selection.ts`): the dependency `preScore` is now `fits(userId, jobIds)`, wired as `scoredFromFits(await getFits(...), fitSnapshot)`. `ScoredJob` gains `kind`, `confidence` and `snapshot`. `selectAlertJobs` keeps "Possible or better" and adds the rule: a quick estimate with low confidence never counts above Possible (`alertTierOf`). **Changed in the review pass:** that rule now decides the ORDER only. The card keeps the fit's own score, tier and kind, so an alert shows what the feed card and the job page show (I1). `PickedJob` carries `lowered: true` for such a job; the flag is not stored on the card. Order: the tier the fit counts as, then a lowered estimate after the fits that earned that tier, then score, then an AI fit before an estimate, then newest.
- **Job page and Similar jobs** (`jobs/detail/`): the dependencies are `fit` (`getFit`, no model call) and `fits` (`getFits`). The page's fit is `fitToView(getFit)` (carry-over 4). `toFitBadge` takes a `Fit` and carries `confidence` and `confidenceReason`; a test keeps it equal to the feed's `fitBadge`.
- **Ready list** (`agent/deps.ts`, `store.ts`): `readyListFits` reads `getFits` behind the unchanged GoApply rule (no fit without a live 个性化推荐 grant). `QueueFit` gains `kind` (`pre` / `ai`) and `confidence`.
- **Onboarding** (`onboarding/match.ts`, `defaults.ts`): the dependency is `fits`, wired as `fitsForRanking(await getFits(...))`. `rankFits` replaces `rankPreScores` (kept as an alias).
- **Extension chip** (`extension/defaultDeps.ts`): `match.cached` is `getFit` with no model call. `match.page` calls the new `estimateForPosting(userId, posting)` in `match/fit.ts`. `chip()` passes `confidence` and `confidenceReason`.
- **`estimateForPosting`**: hands the posting to `getFits` as a row the caller already holds, under the id `adhoc:posting`, private to the user. So it is assembled by the same `assembleFit` as every stored job (same priors, same calibration map), never stored, never a model call. A test shows a page and a stored job with the same text get the same chip.
- **Lifecycle tip** (`lifecycle/repo.ts`): `topFitJob` reads stored rows only as candidate ids, then keeps jobs whose `getFits` result is an AI fit at Good or better, best first. A stale or version-specific row no longer names a job. **Changed in the review pass:** the candidate query has `distinct: ['jobId']`, so the 20 candidates are 20 different jobs and rows of tailored versions cannot crowd out the job that has an AI fit for the main resume.
- **Keyword report** (`resume/store.ts findFitRow`): found while checking the ACCEPT grep. It read `RAJobMatchScore` directly for any resume version, any scorer version and regardless of GoApply's AI consent. It now reads `getFit` and answers a fit only on the report of the main resume, and only an AI fit. See "Where I differ" 3. **Changed in the review pass:** the main resume id is looked up first (`primaryVariantId`, the same rule as the match repository's `getResume`), and a version that is not the main resume answers null without any fit read (`fitRowForVersion`).
- **Deprecated wrappers**: `matchService.preScoreMany` and `preScoreJobs` are still exported and unchanged (I do not own `MatchService.ts`). `match/index.ts` documents them as deprecated. Their only remaining callers are inside `features/match` (`cron.ts` ranks its queue with `preScoreJobs`). No other domain breaks.
- **ACCEPT grep**: `grep -rnE "preScoreMany|preScoreJobs|scoreJob\(" server/src/features` outside `match/` and `resume/tailor/` prints four lines, all the Assistant's own adapter method `CopilotAreas.scoreJob` (`copilot/types.ts:39`, `areas.ts:103`, `tools/jobs.ts:329` and `:333`). The method calls `getFit` / `getVariantFit`; no surface calls the match scorer. Making the grep empty needs a rename in `copilot/types.ts`, which no M2 bundle owns (Request 2). The scan test in `match/fit.test.ts` now uses the item's literal pattern and allows exactly those four adapter lines, or none, so it passes before and after the rename and fails on any other occurrence.
- Tests: `alerts/selection.test.ts`, `service.test.ts`, `modeOff.test.ts`; `jobs/detail/detail.test.ts`; `agent/__tests__/fitsFor.test.ts` (new), `service.test.ts`; `onboarding/match.test.ts`; `extension/defaultDeps.test.ts`, `service.test.ts`; `lifecycle/lifecycle.test.ts`; `resume/tailor/fitWiring.test.ts` (new); `match/fit.test.ts`.

### 2. [P0] The Assistant reads the canonical fit. Done.

- `copilot/areas.ts`: `storedFit` is `getFit` with no model call and ignores any resume version. `scoreJob` is `getFit` with a model call allowed (`on_demand`) unless `resumeVariantId` is set, in which case it is `getVariantFit`. `createDefaultAreas` takes an optional `fits` (test seam).
- `copilot/tools/jobs.ts`: `analyze_fit` and the added-jobs rows no longer pass `ctx.resumeId`. The output gains `label: "Your fit"`, `confidence` and, for an estimate, `reason` and `confidenceReason`. New optional argument `resumeVariantId`: the output then also holds `withThisVersion { variant: true, label: "With this version", … }` and a note telling the model to name each measure. The card stays the canonical fit. A version that is not the user's answers `resume_version_not_found` and the canonical fit is still returned.
- Tests: `copilot/__tests__/tools.test.ts` (canonical whatever resume is attached, two measures with the argument, confidence and reason, `storedFit` never calls a model, production areas over an in-memory match service), `areaFakes.ts` updated.

### 3. [P0] Tailoring shows "Your fit" and "With this version"; the canonical routes take no variant. Done.

- `TailorServiceDeps`: `score` is replaced by `canonicalFit(userId, jobId, { allowModelCall, locale })` and `variantFit(userId, jobId, variantId, locale)`, wired in the new `resume/tailor/fitDeps.ts` (`tailorFitDeps`). Both answer a `FitSnapshot`.
- On create, `scoreBefore` is the canonical AI fit (the main resume), not the session's base version. On finalize, `scoreAfter` is the variant fit of the result version.
- The view: `fit: { canonical, variant, before, after }`. `canonical` and `variant` are `{ value, kind: 'ai', tier, scoredAt, version }` or null; `before` / `after` are the same values in the old shape for one release. A value is present only for a real AI fit.
- `match/contract.ts`: `ScoreJobBodySchema` and `FitAnalysisBodySchema` drop `resumeVariantId`. A request that still sends it gets 422 `invalid_request` (the item says 400; this codebase answers 422 for `invalid_request`, as the existing unknown-field tests show). The keyword check keeps its parameter.
- Web: `useJobFit` and `useRewriteFitText` take no version and `jobFitKey` is one key per job. `useFitAnalysis` keeps an unused second parameter so `FitAnalysisCard.tsx` (not mine) still compiles. `JobFit` takes no version. `TailorResult` shows "Your fit" and "With this version" with the note under them, and keeps the honesty line.
- Carry-over 3: the local `fitOf` in `TailorService.ts` is gone; `grep fitOf server/src` is empty outside tests.
- Tests: `resume/tailor/TailorService.test.ts`, `routes.test.ts`, `fitWiring.test.ts`; `match/routes.test.ts`; `components/features/tailor/__tests__/tailor.test.tsx`; `hooks/match/useJobFit.test.tsx`.

### 4. [P0] Stored snapshots carry kind, version and scoredAt. Done except one ACCEPT line: not accepted until Request 1 is applied.

- `FitSnapshotSchema`, `FitSnapshot`, `readFitSnapshot` in `match/contract.ts`; `fitSnapshot(fit)` in `match/fit.ts`.
- **Alerts**: each card (`AlertCard`) carries `kind` and `fit` (the snapshot). They are in the mail params and in `SeekerNotification.params`. The card's `tier` is the snapshot's tier (one card, one tier; a test asserts it for every card).
- **Ready list**: no fit value is written to a queue or kit row (I checked `agent/store.ts` and `service.ts`); rows read the live fit on every list request. A test pins the second read.
- **Tailoring**: `RATailorSession.fitSnapshot` is written in the same update as each number (`store.updateSession`). A session from before the column reports `kind: 'ai'`, `scoredAt` = the session's `updatedAt`, `version: null`.
- **Lifecycle**: `topFitJob` returns `fit` (the snapshot) with the job, and the service already passes the job object into the template params.
- **NOT MET: "An alert mail sent for an estimated job says so."** The tier line of the instant and digest mails is printed by `server/src/platform/email/templates/notify/index.ts` (`jobListHtml`, `jobListText`: `tierLabel(j.tier, t)`), and its string lives in `server/src/i18n/email/staging/notify.en.json`. Neither file has an owner in M2, and the item's FILES line names `alerts/notify.ts` and `deliver.ts`, which do not render the line (I read both: they pass `params` through). The data is in the params (`kind: 'estimate'` on each card), so the change is the template's two lines, one string and one test: Request 1 has the exact text. Until it lands an alert for an estimated job reads "Good fit" with nothing saying it is a quick estimate, which I6 forbids.

### 5. [P0] One contract test that calls every seam; the invariants join `npm test`. Done.

- `eval/seamRegistry.ts`: ten seams, each running the surface's own code on the fakes of `ctx.world`, modules loaded at run time by path. `onboarding_result` is the tenth; the nine original names are kept.
- `eval/enforced.test.ts`: `registerInvariants({ enforce: 'M2' })`, plus per-seam tests in both scenarios, a test that a newly stored AI fit reaches every seam, I8 at seam level on GoApply without the AI consent (zero scorer, embeddings and planner calls, zero allowance spent, with and without a stored AI row), and the completeness test.
- **Changed in the review pass:** the `alert_selection` seam reads what the reader sees. When the alert sends a card, the reading is `{ score: card.fit.score, tier: card.tier, kind: card.kind }` (and the card's snapshot must equal the snapshot the selection read); only a job that was not sent falls back to the selection's read. New block "a quick estimate with low confidence": a world whose posting states under 60% of the rubric gives a Good estimate with low confidence (asserted as the precondition), and all ten seams must equal `getFit` there. I checked it has teeth: making `jobCard` print Possible for a lowered job fails `alert_selection` and the named alert test; reverted.
- Completeness: the test scans `server/src` (outside `features/match`) for files that read `getFit`, `getFits`, `getVariantFit` or `estimateForPosting` and compares with a static list. A new reader fails until it is registered.
- `npm run eval:match -- --enforce M2` exits 0 in this worktree: INV-1, 2, 3, 4, 5, 6, 8, 9, 10 pass, INV-7 pending (due M4).

### 6. [P0] Similar jobs by job vector, re-ordered by the one fit. Done.

- `JobDetailServiceDeps.similarSource(row, limit)`. With a non-empty answer the service loads those ids under the same scope as before (market, public, canonical, open, same country, the GoApply and bank link rules), drops flagged and hidden rows, orders by fit (unknown last) then source order, and returns 6. Absent, null, empty, not a list, a throw, or no id surviving the checks: the same-role list. `similarIds` on `GET /jobs/:id` uses the same source without scoring.
- `defaultService.ts similarFromFeed`: reads `similarJobIds` from `feed/index.js` without a static type. A feed module without the export answers null.
- GoApply: nothing is asked of the source while `jobs.recommendations` is off, and no fit is read without the 个性化推荐 grant (new for Similar jobs; see "Where I differ" 2).
- Tests: `jobs/detail/detail.test.ts` (the Java Backend Architect case, each fallback, the scope re-check, order, limit, a failing fit read, the GoApply rules, the missing export).

### 7. [P1] Cards and the fit card show confidence; GoApply wording pinned. Done.

- `FitScore.tsx`: for an estimate with low confidence, one reason line. `no_resume` reuses the existing no-resume sentence and is never printed twice. A reason with no words for it shows nothing.
- `JobCard.tsx`: the tag stays "Quick estimate"; the reason replaces the "Compared the title, skills and location…" line. No tier chip for a null score. See "Where I differ" 4.
- `match.test.tsx`: the two GoApply assertions (pay in the posting's words with no annualised figure; no visa wording across 16 rendered variants), and the confidence cases.
- Tests: `components/features/match/match.test.tsx`, `components/features/feed/jobCard.int.test.tsx`.

### Carry-over (waveM1-carryover.md, section MKT-2F)

| # | Entry | Result |
|---|---|---|
| 1 | `explainNow` drops a by-filters logistics part | Done, with a test |
| 2 | Split the not-compared line by `fit.kind` (optional) | Left. `DimensionList.tsx` is not in my owns and has no prop for it |
| 2a | Tell `explainMatch` which side is missing | Left. `compliance/explainMatch.ts` has no owner before MKT-4A. The tier is passed, as before |
| 3 | Rename `fitOf` in `TailorService.ts` | Done (removed) |
| 4 | Job page uses `fitToView(await getFit(...))` | Done. No locale is passed: `get(userId, jobId)` has none, as before |
| 5 | Read `estimateReason`, `basis.jobContentHash`, `stale` with defaults | No consumer of mine reads the hash or `stale` |
| 6 | Harness shape, tenth seam, one-call `enforced.test.ts` | Done |
| 7 | Keep `fit.compared.evidence.logistics_by_your_filters` | Kept |
| 8 | `MatchFitView.rewriteBlocked` | The optional field is in `match/contract.ts`. Setting it is MKT-4G's (`MatchService.ts`) |

wavePAR-carryover "Market waves": entry 1 names `jobs/detail/view.ts` (`API_BOARDS`, the `linkedin` literal) and entry 7a names `alerts/repo.ts`. I left both: the first is the provider-union removal (JI-2, job-source bundles), the second is JI-10, which the plan gives to MKT-3C and MKT-5C.

## Where I differ from the item text, and why

1. **The tailoring view reads "Your fit" live.** The item returns the stored numbers. Item 4's own rule says every in-app page shows the number from `getFit` at render time, and the harness needs a tailoring read that makes no model call. So the view calls `canonicalFit` with `allowModelCall: false` for sessions in review or finalized, and falls back to the stored snapshot when the live fit is not an AI fit or cannot be read. Cost: one extra `getFit` per session view.
2. **Similar jobs reads no fit on GoApply without the 个性化推荐 grant.** The item says this rule "stays", but the code did not apply it to Similar jobs before. It now does, through the existing `personalized` dependency. The list itself is unchanged (source order, no fit badge). RoboApply is unaffected.
3. **The keyword report shows a fit only for the main resume.** Not in the item text, but its FILES line lists `resume/store.ts` and its ACCEPT says no surface other than tailoring and the Assistant's version question shows a variant number. The report of a non-main version now shows no fit score where it used to show that version's stored AI score. This is a visible change on RoboApply; Request 8 is the owner's choice to show it as "With this version" instead.
4. **The card reason is its own line, not inside the chip.** The item says "show the short reason instead of only Quick estimate". The chip sits in a column that does not shrink (`feed.module.css`, not mine), so a long chip would squeeze the lead text at 375px. The reason uses the existing work-line style and the same four sentences as the fit card, so there is one set of strings to translate.
5. **422, not 400**, for a variant on the canonical routes (see item 3).
6. **`TailorSessionView.fit.canonical` and `.variant` are optional in the type.** The server always sends them. Required fields would break typechecks of web test files I do not own.
7. **`toWireKind` moved to `match/contract.ts`** (re-exported from `fit.ts`). `features/boundary.test.ts` allows cross-area imports of `index.ts` and `contract.ts` only, and `jobs/detail/view.ts` needs the mapping without loading the match service.
8. **The harness's `analyze_fit` read in the estimate scenario uses a match service whose counters refuse.** `analyze_fit` asks for the free on-demand score, so with nothing stored it would create the AI fit. The read is taken as if the day's allowance were used up; the repository, scorer, brand and clock are the world's. With AI off or a stored fit the world's own functions are used, so the I8 test still proves the consent gate.
9. **"An estimate with confidence low never qualifies above possible" is an ordering rule, not a relabel (PRECEDENCE: the strategy wins).** Item 1 could be read as "show it as Possible", which is what the first version did. MARKET_STRATEGY 2.2 I1 lists alerts among the surfaces that return the same score, tier and kind as the feed card and the job page, so a card that says "Possible" while the feed says "Good fit · Quick estimate" for the same person and job breaks it. The low-confidence estimate still qualifies, is counted as Possible when the alert orders and cuts its list (so it never takes a place from a fit that earned its tier), and is shown with the fit's own tier and `kind: 'estimate'`.

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2F/`.

- `server/src/features/match/`: `fit.ts`, `fit.test.ts`, `contract.ts`, `index.ts`, `routes.ts`, `routes.test.ts`, `eval/seamRegistry.ts`, `eval/enforced.test.ts` (new)
- `server/src/features/alerts/`: `service.ts`, `selection.ts`, `service.test.ts`, `selection.test.ts`, `modeOff.test.ts`
- `server/src/features/jobs/detail/`: `service.ts`, `defaultService.ts`, `view.ts`, `detail.test.ts`
- `server/src/features/agent/`: `deps.ts`, `store.ts`, `contract.ts`, `__tests__/service.test.ts`, `__tests__/fitsFor.test.ts` (new), `__tests__/fitFixture.ts` (new, test support)
- `server/src/features/onboarding/`: `defaults.ts`, `match.ts`, `match.test.ts`
- `server/src/features/extension/`: `defaultDeps.ts`, `defaultDeps.test.ts`, `service.ts`, `service.test.ts`, `contract.ts`
- `server/src/features/copilot/`: `areas.ts`, `tools/jobs.ts`, `__tests__/areaFakes.ts`, `__tests__/tools.test.ts`
- `server/src/features/resume/`: `index.ts`, `store.ts`, `contract.ts`, `tailor/TailorService.ts`, `tailor/store.ts`, `tailor/memoryStore.ts`, `tailor/fitDeps.ts` (new), `tailor/TailorService.test.ts`, `tailor/routes.test.ts`, `tailor/fitWiring.test.ts` (new)
- `server/src/features/lifecycle/`: `repo.ts`, `lifecycle.test.ts`
- Web: `components/features/match/{FitScore.tsx, JobFit.tsx, match.test.tsx}`, `components/features/feed/{JobCard.tsx, jobCard.int.test.tsx}`, `components/features/tailor/{TailorResult.tsx, __tests__/tailor.test.tsx}`, `hooks/match/{useJobFit.ts, useFitAnalysis.ts, useJobFit.test.tsx}`
- Copy: `i18n/staging/fit.en.json`, `i18n/staging/tailor.en.json`
- Handoff: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-2F.md` (the one file the wave lets me write outside the worktree)

Removed in the review pass: `server/src/features/match/fit.fixture.ts` (it was not in my owns). The `Fit` builder for tests now lives in `server/src/features/agent/__tests__/fitFixture.ts`: an owned directory, and `__tests__` directories are left out of the server build (`server/tsconfig.json`), so it is no longer compiled into `dist`. Its type import goes through `match/index.js`, so `features/boundary.test.ts` stays green.

## Tests run

| Command | Result |
|---|---|
| The 21 test files changed or added in this worktree | 21 files, 881 tests passed |
| `npx vitest run server/src/features/match/eval` | 7 files, 197 passed |
| `npx vitest run server/src/features/boundary.test.ts` | 1 file, 5 passed |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | all six checks clean |
| `npx vitest run --exclude ".claude/**"` | 678 files, 15,870 passed, 1 skipped, 10 todo |
| `npm run eval:match -- --enforce M2` | exit 0 (INV-3 pass; INV-7 pending until M4) |

## Red tests for other bundles

None.

## Pre-existing failures

None.

## Requests

**Orchestrator**

1. **Alert mail line: required for item 4 (apply at the M2 merge; not optional).** No bundle owns these files in M2.
   - `server/src/platform/email/templates/notify/index.ts`: add `kind?: 'ai' | 'estimate';` to `AlertJobCard` (after `tier`, with the comment "A quick estimate, not an AI read (strategy 2.2 I6). Absent on cards stored before MKT-2F: printed as before."). Add one helper beside `tierLabel`:
     ```ts
     /** The tier line of a job card: "Good fit", or "Good fit · Quick estimate" for an estimated job. */
     export function fitLine(job: Pick<AlertJobCard, 'tier' | 'kind'>, t: EmailTranslator): string {
       const tier = tierLabel(job.tier, t);
       return job.kind === 'estimate' ? t('notify.common.tierEstimate', { tier }) : tier;
     }
     ```
     and replace `tierLabel(j.tier, t)` with `fitLine(j, t)` in `jobListHtml` (inside `escapeHtml(...)`) and in `jobListText`. The card's `fit` snapshot needs no type there: `AlertCard` in `alerts/service.ts` already extends `AlertJobCard` with it.
   - `server/src/i18n/email/staging/notify.en.json`: `{ "notify": { "common": { "tierEstimate": "{tier} · Quick estimate" } } }`. Chinese for GoApply at the translation pass: `"{tier} · 快速估算"` (the web's wording for the same tag).
   - `server/src/platform/email/templates/notify/notify.test.ts`: render `jobAlertInstant` and `jobAlertDigest` with `jobs: [job(1, { kind: 'estimate' }), job(2, { kind: 'ai' }), job(3)]` and assert, for `bodyHtml` and `bodyText`: the first card's line is "Good fit · Quick estimate"; the second and the third (no `kind`: a card stored before this change) are "Good fit" with no "Quick estimate"; the string "Quick estimate" appears exactly once.
   - Nothing changes in `alerts/`: `kind` is already on every card in the mail params and in `SeekerNotification.params` (`alerts/service.test.ts` asserts it).
2. **`server/src/features/copilot/types.ts`** (no owner in M2; MKT-4H owns the directory in M4): rename `CopilotAreas.scoreJob` to `fit(userId, jobId, options: { locale?: string })`, add `variantFit(userId, jobId, variantId: string, options: { locale?: string })`, and drop `resumeVariantId` from the options of `storedFit`. Then in files I own: `areas.ts` splits `scoreJob` into the two methods (`getFit` on_demand, `getVariantFit`), `tools/jobs.ts` calls `ctx.areas.fit(...)` at line 329 and `ctx.areas.variantFit(...)` at line 333 and drops the option at line 79, `__tests__/areaFakes.ts` follows. The item's literal grep is then empty, and the `ASSISTANT_ADAPTER` exception in `match/fit.test.ts` matches nothing and can be deleted (the test passes either way).
3. **`components/features/match/FitAnalysisCard.tsx`** (MKT-4E owns the directory in M4): drop the `resumeVariantId` prop and the argument to `useFitAnalysis`; then remove the unused parameter from `hooks/match/useFitAnalysis.ts`.
4. **Extension package** (`extension/src/shared/contract.ts`, `Panel.tsx`): add the optional `confidence` and `confidenceReason` to `FitChip` and print the reason for a low-confidence estimate. The server sends both now.
5. **`server/src/features/match/eval/README.md`** still says the seam reads "are wired in phase M2" in the future tense, and lists nine surfaces.
6. **After the M2 merge**: replace the cast in `jobs/detail/defaultService.ts similarFromFeed` with a typed import of `similarJobIds`, and run `enforced.test.ts`. If MKT-2G or MKT-2H added a file that reads the fit contract, the completeness test names it; add it to `FIT_READERS` (and to the registry if it is a surface).
7. **Home of the test fixture.** `server/src/features/agent/__tests__/fitFixture.ts` is used by the tests of six areas (alerts, Similar jobs, Ready list, extension, onboarding, lifecycle). Its natural home is the match area, beside `match/testkit.ts` (owned by MKT-1F / MKT-4E, not by me). If you want it there, move `fitFixture`, `fitsFixture` and `FIT_FIXTURE_AT` into `match/testkit.ts` (or a `match/__tests__/` file) and repoint the six imports; nothing else depends on the path.

**Owner**

8. The keyword report of a resume version that is not the main resume now shows no fit score ("Where I differ" 3). If it should show that version's number, it needs the label "With this version" in `components/features/resume/KeywordReport.tsx` and a flag from `ResumeCheckService`.
9. In an alert, a thin quick estimate (low confidence) is listed after every job that earned its tier, and shown with its own tier and the words "Quick estimate" (once Request 1 lands). Confirm, or say such a job should not alert at all. Either answer is one line in `alertTierOf` (`alerts/selection.ts`).

**MKT-4G**

10. Set `MatchFitView.rewriteBlocked` where the daily cap stops a rewrite. When you take over `MatchService.ts`, `preScoreMany` can go (no caller outside `match/`); `preScoreJobs` is still used by `cron.ts`.

**MKT-4A**

11. `explainMatch` could say "Your profile does not show…" when the person's side is missing (carry-over 2a). `Fit.confidenceReason` is on the view the job page passes.

## Schema requests

None. The code writes and reads `RATailorSession.fitSnapshot` (delivered by MKT-0).

## Env variables added or redefined

None.

## i18n keys added or changed

All English, shared by both brands, staged; no Chinese-only copy.

- `fit.confidence.reason.no_skills_listed`: "This post lists no skills"
- `fit.confidence.reason.no_level_stated`: "This post states no level"
- `fit.confidence.reason.no_role_evidence`: "Your resume shows no role to compare"
- `fit.confidence.reason.few_details`: "This post says too little to compare"
- `tailor.fit.yours`: "Your fit"
- `tailor.fit.withVersion`: "With this version"
- `tailor.fit.note`: "Your fit on the job page stays the one for your main resume until you make this version your main resume."

`tailor.result.scoreBefore` and `tailor.result.scoreAfter` ("Before", "After") are no longer read by `TailorResult.tsx`; grep before removing them at the i18n pass.

Requested, not staged by me (mail string, unowned file; Request 1): `notify.common.tierEstimate` = "{tier} · Quick estimate".

## Known gaps

1. An alert mail for an estimated job does not say "Quick estimate" until Request 1 lands. The data is in the params. This is the open ACCEPT line of item 4.
2. The vector path of Similar jobs is inert in this worktree: `feed/index.ts` has no `similarJobIds` until MKT-2H merges. The fallback list is today's.
3. `estimateForPosting` makes one stored-score query for an id that never has a row (it goes through `getFits`). Removing it needs a change in `MatchService.ts`.
4. `server/src/roboapply/v2/services/RACrossBankSearchService.ts` still reads and writes `RAJobMatchScore` directly (the legacy cross-bank path). It is outside my owns and outside `features/`, so the consumer scan does not cover it.
5. The lifecycle tip and the keyword report have no registry seam: each shows a fit only when it is an AI fit, so there is no estimate reading to compare. Their own tests check they read the contract.
6. Lifecycle tip: the candidates are the 20 jobs with the highest stored row of any resume version. A person with more than 20 such jobs whose main-resume fits are all estimates, and one AI fit further down, still gets a tip that names no job. Ordering candidates by the main resume's rows first would need the main resume id in that query; not done.
7. Prisma applies `distinct` after reading the matching rows, so the lifecycle candidate query reads every Great or Good stored row of the person for open public jobs before it keeps 20 jobs (two short columns and the job's title and company per row). Not measured against a database.
8. Nothing was checked in a browser. The UI changes are text in existing styles on both brands; I did not verify 375px and 1280px, light and dark, by eye.
9. The tailoring view's live read adds about five queries per session view (not measured against a database). The keyword report on that page now adds one or two id lookups and no fit read for a tailored version.
10. Server test files are covered by neither typecheck. An ad-hoc `tsc` over the test files touched in the review pass is clean except four errors in `onboarding/match.test.ts` (lines 28, 218, 317, 330: `SAMPLE_BASICS` readonly tuples), all on lines from the base commits; the tests pass.

## Review resolution

| # | Review point | Verdict | What I did |
|---|---|---|---|
| U1 / F1 | Item 4: the alert mail does not say "Quick estimate" (medium) | Real. Cannot be fixed inside my owns | Verified: the line is printed only at `platform/email/templates/notify/index.ts:183` and `:196`; `alerts/notify.ts` and `deliver.ts` render nothing. No M2 bundle owns the template, its test or `i18n/email/staging/notify.en.json`. Item 4 is now reported as not accepted until Request 1, which holds the exact type, helper, string and test. The cards already carry `kind` |
| F2 | An alert card can show another tier than the fit; the seam does not read the shown tier (low) | Real. Fixed with option A | `selection.ts`: `PickedJob.tier` is the fit's own tier; the cap is `lowered: true` and the order key only. `jobCard` therefore stores one tier. `seamRegistry.ts readAlertSelection` returns `{ score: card.fit.score, tier: card.tier, kind: card.kind }` for a sent card. Tests: `selection.test.ts` (order, tier, `lowered`, tier equals snapshot tier), `service.test.ts` (cards in the mail and in-app params), `enforced.test.ts` (a Good low-confidence estimate equals `getFit` on all ten seams; the alert card equals the feed card). Mutation check done and reverted. Said under "Where I differ" 9 and Owner question 9 |
| F3 | Lifecycle candidates de-duplicated after the limit (low) | Real. Fixed | `lifecycle/repo.ts`: `distinct: ['jobId']` on the candidate query. `lifecycle.test.ts`: the test's fake now answers the query as the database would (order, distinct, limit); new case with 20 variant rows over five estimate-only jobs and one lower row whose job has an AI Good fit: the tip names that job. The query shape (`take`, `distinct`, `orderBy`) is asserted |
| F4 | Keyword report runs a full `getFit` for versions whose result is discarded (low) | Real. Fixed | `resume/store.ts`: `fitRowForVersion` looks up the main resume id first (`primaryVariantId`, injectable as `mainResumeId`) and returns null with no fit read for another version, for no resume, or when the lookup fails. The check on `fit.basis.resumeVariantId` stays as the authority. `fitWiring.test.ts`: a non-main version makes zero fit reads and touches nothing in the match repository; no main resume or a failing lookup reads nothing; a lookup that disagrees with the fit shows nothing |
| F5 | Item 1 ACCEPT grep still prints `scoreJob(` (low) | Real. The rename needs `copilot/types.ts`, not mine | Left as Request 2 with the exact change. Inside my owns: the scan test in `match/fit.test.ts` now uses the item's literal pattern outside `match/` and `resume/tailor/` and allows exactly the four adapter lines or none, plus a test that `copilot/areas.ts` reads `getFit` / `getVariantFit` and never the match service. No hand-made alias to hide the name from the grep |
| E1 | Unowned edit: `server/src/features/match/fit.fixture.ts` | Agreed. Removed | Deleted the file; the builder is `server/src/features/agent/__tests__/fitFixture.ts` (owned directory, excluded from the server build, type import through `match/index.js`). Six test imports repointed. Request 7 offers the move into the match area |
| E2 | Unowned edit: the handoff file in the clone worktree | Not an unowned edit | The task names this path as the one file to write outside the worktree. Kept and rewritten |
