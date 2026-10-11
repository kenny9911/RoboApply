# MKT-1F

Estimate v2, the fit contract (`getFit` / `getFits` / `getVariantFit`) and the one-scale ranking input (SM-3, SM-4, core of SM-5). Worktree `wp-MKT-1F`, branch `wp/MKT-1F`. Nothing committed, pushed or run against a database, a model or the network.

All six items are done, and the seven review findings are resolved (see "Review resolution" at the end). Gates in this worktree after the review changes: 649 test files / 14,452 tests green (base 645 / 14,292), both typechecks, `npm run check`.

Merge-time check, repeated after the review changes: I copied this worktree, MKT-1D's `eval/` directory and MKT-1E's `features/jobs/` into a scratch directory (read-only copies; nothing in a sibling worktree was touched) and ran `tsx server/src/features/match/eval/run.ts --enforce M1` there. Result: **exit 0**. INV-1, 2, 4, 5, 6, 8, 9, 10 pass; INV-3 (M2) and INV-7 (M4) are pending as planned; the language suite passes (zh-TW 0.959 / 0.969, zh-CN 0.944 / 0.963 against en 0.960 / 0.975). The server typecheck is clean on that copy and this bundle's 31 test files pass on it. The siblings were still editing while I ran this (their own `eval/live` and `jobs/enrich` tests changed between two copies taken seconds apart and were red in ways that do not touch this bundle's code), so the orchestrator's run on the merged tree remains the gate.

## Items

### 1. Estimate v2 (a): level and role from the resume and profile, never from filter chips. Done.

- `MatchUser.evidenceRoleIds`: the taxonomy match of the two most recent experience titles (profile experience with the current job first, else the parsed resume's) plus `RAProfile.headline` when it names a role. Built by `context.ts evidenceRoleIdsOf`; `repo.getUserInputs` selects `headline` and `seekerType`.
- `titleOverlap` compares the job's role with `evidenceRoleIds` only (same role 1.0, same group 0.6, same category 0.3). `userTargets()` is deleted. With no role evidence `title_level` is not stated and takes its prior. `targetTaxonomyIds`, `targetTitles`, `targetSeniority` stay on `MatchUser`, documented as what the AI scorer is told and not inputs of the estimate.
- Level: the resume level as before; with no parsed resume and no profile experience it is `levelFromSeekerType` (student, recent_graduate → intern_newgrad; the others none), flagged `levelSource: 'onboarding'`, which forces confidence low.
- Stated eligibility (degree, GoApply 届别 from a quoted tag) is unchanged; school tier is still never read.
- A person's title is placed by the same rule as a posting's title at ingest (`taxonomyIdsForTitle`), so Taiwan titles (資深後端工程師, 資料分析師) fold to the role tree's vocabulary.
- Tests: `preScore.test.ts` "I3: no chip of the saved search moves a fit" (parametrised), role evidence from experience, parsed resume and headline, no evidence, the Teacher / Data Analyst case, senior resume against an internship; `inputs.test.ts` `buildMatchUser` fills `evidenceRoleIds`, `hardFilters`, the onboarding level.

### 2. Estimate v2 (b): priors, hard skills, the logistics rule, coverage and confidence. Done (logistics rule changed by the review).

- `combineWithPriors(dimensions, priors)`: total = Σ weight × (score or prior) / Σ weight. `getMatchPriors(brand, env)` reads `MATCH_PRIORS` / `CN_MATCH_PRIORS` through `brandEnv`; one malformed key keeps the defaults whole. `combineDimensions` (renormalising) is kept for the AI total only.
- Worked example holds: no skills, title 100, logistics really met → 64.8 → 65, tier good, never great.
- Hard skills only: `skillsDimension` counts the first 10 hard skills, required 1 and preferred 0.5; a posting listing only soft skills has a not-stated skills part. `splitSkills` returns `softSkills` separately.
- Logistics (`logisticsForEstimate`):
  - A `not_met` check is a real penalty: 100 × met / stated.
  - When every stated check is met and each is guaranteed by the person's own filter (location, pay), the part is **not compared**: it is returned `status: 'not_stated'`, `score: null`, so the total counts it at the logistics prior like any part that cannot be compared, coverage and the honesty limits leave it out, and no surface shows a number nobody measured. Its one evidence line has ref `logistics_by_your_filters` and quotes the posting's place and pay words; with no words to quote there is no line (never an empty one).
  - The visa check is never filter-guaranteed: the "I need sponsorship" filter (`feed/sql.ts`) only removes postings that say no, so a posting that says it sponsors is a fact and scores. `MatchUser.hardFilters` is now `{ location, pay }`.
  - `logisticsDimension` (the facts) is unchanged and is what the AI path uses.
- `coverage`, `postingCoverage`, `confidence`, `confidenceReason`, `softSkills`, `limit` on the result (`EstimateResult`). The `notBacked` side list is gone: a by-filters part is simply not scored.
- Tests: worked example, priors per component, hard / soft / required / preferred, the logistics cases (by filters, no words to quote, sponsorship offered / silent / refused, really met, not met), thresholds at 0.49 / 0.5 / 0.74 / 0.75, the 0.6 rule, reasons in order, `getMatchPriors`.

### 3. The fit contract. Done (staleness and list reads changed by the review).

- `fit.ts`: the `Fit` type, pure `assembleFit` (the one place a fit is assembled), `storedFitStatus`, `hysteresisTier`, `refreshDimensions`, `toWireKind`, `fitToView`, `fitToListResult`, `createFitService`, and the module-level `getFit`, `getFits`, `getVariantFit` (bound lazily to the production service; `setFitServiceForTests`).
- `jobHash.ts`: `jobContentHash(row)` (sha1 of the normalised title, requirement text, sorted skills), `currentJobHash(row)` (the stored `RAJob.contentHash` when present, else computed from a row that carries its text), `storedJobHash(row)` (the stored one only). The description head is cut to 8,000 characters BEFORE it is normalised, then cut to 4,000: a long description is never normalised whole, and a reader holding only that head computes the same hash.
- A stored row is the fit when it was written for this resume content by a fit scorer (`scorer_v3`, `scorer_v4`) with components that parse. The model, the prompt AND the posting's hash decide `stale`, never usability: a row of an older model or prompt, or one written for an earlier version of the posting, keeps serving, flagged, until precompute or an on-demand call re-scores it (I7). So enrichment adding a skill to a posting never turns an AI fit into a quick estimate.
- `MatchService`: one implementation, `fitOne` and `fitMany`. `scoreJob` is `fitToView(fitOne(...))`; `preScoreMany` is `fitMany` in the list shape. `saveScore` writes `jobContentHash`, `rubricVersion` and `explanation.estimateAtScore { score, coverage }`.
- What a list reads: the rows the caller did not hand over (`getFitJobs`, the list projection with no long text) and the stored AI scores (one query). No description, for any row. `getFits(userId, ids, { context, rows })` takes rows the caller already loaded; the feed hands its window over, so a feed window adds one stored-score query, as before this bundle.
- I5: a recomputed total keeps the stored tier until it is 3 points past the edge it crosses; a new model result takes its own tier.
- I7: a stale row keeps serving on lists and cache-only reads; an on-demand or precompute call re-scores it; if the model may not run (cap, no route, failure) the stale row answers instead of an estimate. Precompute mode still answers the estimate with reason `budget`, so the worker defers the item.
- I8: with AI off, no scorer call, no counter spent, and a stored AI row is not shown on either form.
- `repo.ts`: `ScoreRecord` gains the two columns; `listAiScores` drops the prompt filter and returns the version fields; `freshAiScoredJobIds` takes `jobContentHashes`; `getFitJobs`, `listCalibrationPairs`, `getConfigValue`, `setConfigValue`. `cron.ts`: a row of an older model, prompt or posting is picked again (unchanged by the review: that is the backfill); the dedupe key includes the job hash.
- Tests: `fit.test.ts` (each ACCEPT sentence, the changed posting, the enrichment case, what a list reads, legacy rows, calibration, wire shapes), `MatchService.test.ts`, `jobHash.test.ts`, `cron.test.ts`.

### 4. Ranking input on one scale. Done (tier views changed by the review).

- `ranking.ts`: `fitOf` deleted; `fitForRank({ ai, estimate, map })`; `rankFitOf(fit, map)`; `fitBadge(fit)`.
- `passesTier`: an AI score is judged by the tier its card shows (the stored tier with hysteresis), so a card that says Good is never listed under Great and a card that says Great always is. A quick estimate passes at the threshold when its confidence is not low. No fit at all passes (F-FILT-05).
- `FeedQueryService.score()` makes one `getFits` call per window with the context and the rows it already read; badge, ranking input and "Why this job" come from that one `Fit`. A failing read lists the rows without a fit. `newCount` goes through `passesTier`. `aiScores` removed from `FeedRepo`, the Prisma repo and the fake.
- `FitBadge` gains `confidence`, `confidenceReason`; `RANKING_FACTORS[fit].what` updated; `landing.ranking.fit.body` staged.
- grep: no `pre - 5`, `pre − 5` or `minus 5` in `server/src` outside `feed/repo.test.ts`, the test that pins their absence. `fitOf` remains only as an unrelated local function in `resume/tailor/TailorService.ts`, which I do not own (Requests).
- Tests: `ranking.test.ts` (fitForRank, the pairwise case, passesTier by card tier and with confidence), `FeedQueryService.test.ts` (one getFits call per window with the rows handed over, badge fields, card = session ranks = explanation, the blend, low-confidence 82 hidden by Great, Good-at-81 not under Great and Great-at-79 under it, new-count rule), `repo.test.ts`.

### 5. Calibration and monthly priors. Done (logistics left out by the review).

- `calibration.ts`: `fitIsotonic` (PAV, at most 21 knots), `applyMap`, `estimatePriors`, the AppConfig document `match.calibration.v1`, a 10-minute cache, `createCalibration` / `calibrationFor(repo)`, `refreshIfDue`, `pairsFor`.
- Map used only from `MATCH_CALIBRATION_MIN_PAIRS` (500) pairs; a prior from data only for a component with at least 200 scored values, and never for logistics (`DATA_PRIOR_KEYS`): in an AI row logistics is the deterministic 100 × met / stated, mostly 100 because the person's filters removed the failing jobs. `withCalibratedPriors` ignores a stored logistics value too. The logistics prior is always the configured one.
- `cron.ts`: `runScorePrecompute = composeScorePrecompute(precompute, refreshCalibrationIfDue)`. No change to `cron/handlers.ts` or `vercel.json`.
- Fits: a mapped estimate is `calibrated: true`, never past the estimate's own limit; an AI fit is never mapped.
- Tests: `calibration.test.ts`, `cron.test.ts`, `fit.test.ts`.

### 6. Seams for later phases. Done.

- `MatchJobRecord` (optional), `JOB_SELECT`: `skillIds`, `contentHash`, `lang`, `requirements`, `titleMatchScore`. `FEED_COLUMNS`, `FeedJobRow`, `toMatchRecord`: the same without `requirements`. The SQL snapshot differs by those four columns only.
- `prepare.ts`: `registerMatchPreparer`, `runMatchPreparers`; `MatchService.userContext` awaits it.
- One new column is read: `contentHash`, as the posting's hash on lists and (when present) on single reads.

## Where I differ from the item text, and why

1. **Level counts in posting coverage.** A role with no stated level counts half of `title_level` in `postingCoverage` only, so INV-1 / I4 hold for a job with no skills and no level. (Documents win over the item.)
2. **New wire fields are optional** on `PreScoreResult`, `MatchFitView`, `FitBadge`; required fields broke typechecks of files I do not own. The server always sends them.
3. **`currentScorerPin(brand, model)`** takes the resolved model.
4. **The service exposes `fits: { getFit, getFits, getVariantFit }`** (MKT-1D's `eval/seams.test.ts` needs a factory to bind).
5. **`getFits` returns `Map<string, Fit>`** and takes an optional third argument `{ context, rows }`.
6. **Filter-guaranteed is read from the saved search**, not from `user.country` (a profile country is not a filter).
7. **`confidenceReason` is set only when confidence is low.**
8. **A failing preparer is logged and the read goes on.**
9. **AI totals keep counting met logistics as 100** (bundle note).
10. **Feed deps**: `match.calibrationMap?()` next to `getFits`.
11. **(review) A by-filters logistics part is not stated, not "scored at the prior".** The contribution to the total is the same number; the part carries no score. The item's ACCEPT says "the logistics dimension equals the prior"; it now contributes the prior.
12. **(review) Visa is never filter-guaranteed.** The item lists visa; strategy 4.4 point 5 limits the rule to checks met only because of a hard filter, and the sponsorship filter does not guarantee an offer. Documents win.
13. **(review) No data-derived logistics prior.** The item says "the mean of each AI component"; the strategy gives data priors for four components and none for logistics.
14. **(review) A changed posting is stale, not absent.** The item's CHANGE text puts the hash in the freshness test; its ACCEPT line and the MKT-0 column comment say stale. I follow the ACCEPT line.
15. **(review) `Fit.basis.jobContentHash` is `string | null`.** Always set by `getFit` / `getVariantFit`; on a `getFits` row it is the stored `RAJob.contentHash` or null, because a list never reads a description to compute it. The plan's contract table lists the field without a type; MATCH 4.3 writes `string`.
16. **(review) The help sentence is not the item's.** See i18n.
17. **(review) An AI-scored row passes a tier view by its shown tier**, not by its number (the item says AI-scored rows are unchanged).

## Files changed

New: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1F/server/src/features/match/{fit.ts, fit.test.ts, jobHash.ts, jobHash.test.ts, calibration.ts, calibration.test.ts, prepare.ts, prepare.test.ts}`.

Changed, match (same directory): `preScore.ts`, `preScore.test.ts`, `context.ts`, `inputs.test.ts`, `config.ts`, `contract.ts`, `MatchService.ts`, `MatchService.test.ts`, `repo.ts`, `testkit.ts`, `index.ts`, `cron.ts`, `cron.test.ts`.

Changed, feed (`/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1F/server/src/features/feed/`): `ranking.ts`, `ranking.test.ts`, `FeedQueryService.ts`, `FeedQueryService.test.ts`, `repo.ts`, `repo.test.ts`, `contract.ts`, `types.ts`, `sql.ts`, `__snapshots__/sql.test.ts.snap`, `testkit.ts`, `defaultService.ts`, `seams.test.ts`, `personalization.cn.test.ts`, `routes.test.ts`, `items.test.ts`.

Copy: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1F/i18n/staging/landing.en.json`.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-1F.md`.

Touched in the review round: `match/{fit.ts, fit.test.ts, jobHash.ts, jobHash.test.ts, MatchService.ts, repo.ts, testkit.ts, preScore.ts, preScore.test.ts, context.ts, inputs.test.ts, contract.ts, calibration.ts, calibration.test.ts}`, `feed/{ranking.ts, ranking.test.ts, FeedQueryService.ts, FeedQueryService.test.ts, testkit.ts}`, `i18n/staging/landing.en.json`.

Nothing outside the bundle's owns (`git status` lists only the paths above). The reviewer found no unowned edit and there is none now.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/match server/src/features/feed` | 31 files, 761 passed, 1 skipped |
| `npx vitest run --exclude ".claude/**"` | 649 files, 14,452 passed, 1 skipped, 10 todo |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | all six checks clean (exit 0) |
| `npx vitest run components/features/marketing` | passes (no assertion on the old help sentence) |
| scratch copy with MKT-1D and MKT-1E: `eval/run.ts --enforce M1` | exit 0 |
| scratch copy: `tsc -p server/tsconfig.json --noEmit` | clean |
| scratch copy: this bundle's match and feed tests | 31 files, 761 passed |

Feed cost, measured in memory (memory repo, fake scorer, 400 rows, 60 stored AI scores, 2.7 MB of description text in the window, median of 30 runs on this machine):

| | before the review changes | after |
|---|---|---|
| CPU of one window's `getFits` | 44.8 ms | 25.9 ms |
| job rows read again | 400 | 0 |
| description text read | all 400 rows | none |
| the estimate loop alone (what the feed did before this bundle) | 17.9 ms | 17.9 ms |

So a window costs about 8 ms more CPU than the estimate loop it replaces, and the same single stored-score query as before the bundle, plus the AI-consent check when the window has stored scores. This is not a p95 against a database: I may not reach one, and the harness has no latency suite yet (`latency feed_p95_ms: not_built`). The 150 ms gate still needs its measurement on a running stack.

## Red tests for other bundles

None in this worktree. On the scratch copy the only red tests were MKT-1D's own `eval/run.test.ts` and `eval/live/live.test.ts` and MKT-1E's own `jobs/enrich` SM-10 tests, in files those bundles were editing at that moment (a first copy had 6 red, a second copy seconds later 15); none of them reads this bundle's code paths that changed.

## Pre-existing failures

None.

## Requests

**MKT-2F (M2)**
1. `jobs/detail/defaultService.ts explainNow` passes `fit.dimensions` to `explainMatch`. Drop a part for which `isByFilters(d)` is true (exported from `match/index.ts`), as the feed does. Without it the job page lists "The posting does not say the location or work setup." for a job whose location only repeats the person's filter. (The same sentence already shows today for a person with no location answers at all.)
2. `fit.compared.notStated` ("Not enough to compare, so it doesn't count toward the score.") is no longer true for a quick estimate: a part that cannot be compared now counts at a typical value. Suggested: "Not enough to compare, so this part counts as average."
3. Rename the local `fitOf` in `resume/tailor/TailorService.ts` so the SM-4 grep is empty.
4. For the job page use `fitToView(await getFit(userId, jobId), { locale })`: a single-job `Fit` carries the stored prose, a list `Fit` does not.
5. `Fit.estimateReason` on a list is `no_resume`, `ai_off` or null; a list does not check the caps.
6. `Fit.basis.jobContentHash` can be null on a `getFits` row, and `Fit.stale` on a list knows about a changed posting only when the row stores its hash. Read both with a default.

**Orchestrator**
7. Label for the evidence ref `logistics_by_your_filters`: add it to `EVIDENCE_REFS` in `components/features/match/labels.ts` and stage `fit.compared.evidence.logistics_by_your_filters` (suggested: "These already match the filters you set, so they do not change the score: {text}"). Until then the job page shows the part as "Not enough to compare" with one plain quote of the place and pay words (no number, no repeated line). `labels.ts` is in no M1 or M2 bundle's owns (MKT-4E owns the directory in M4): please add it to MKT-2F, together with Request 1, before M1 reaches users.
8. Carry-over 7a (`publicList` 45-day window) and 7b (a bank row stored with the old link while the bank has a template) name feed files. I left both. 7a is JI-10, which the task plan gives to MKT-3C and MKT-5C, and it depends on a product decision. 7b has no bundle: a read-side fix has to change `bankListable`, `bankListableWhere` and the feed SQL together, and their callers in alerts, Similar jobs and SEO are outside my owns; the carry-over's first option (archive such rows in `jobs-ingest` as `no_apply_target`) is the root fix. Please assign 7b to MKT-3C or MKT-5E.
9. `i18n/staging/_pending-translation.json` still holds the old English of `landing.ranking.fit.body`.
10. The 150 ms feed gate has no measurement: MKT-1D's `latency feed_p95_ms` is `not_built`. Someone with a running stack should record the baseline before and after this merge.

**MKT-2H (M2)**
11. Write `RAJob.contentHash = jobContentHash(row)` (from `match/index.ts`) in the same statement as the search document, and again whenever the title, the qualifications or description head, or the skills change (ingest update and enrichment). Lists read only this column for the posting's hash; while it is empty a list serves a stored AI score as current and only the job page and the precompute cron notice a changed posting. The recipe reads the first 8,000 characters of `descriptionPlain`, so `left("descriptionPlain", 8000)` is enough input.

**MKT-4E (M4)**
12. `keywordRows.ts` calls `titleOverlap`, so its title row now compares the posting's role with the roles the person's record shows, not with the saved search. Confirm that is what the three-state check wants.
13. `splitSkills` and `Fit.skills` separate `softSkills`; `keywordRows` still lists soft skills in its skills row.
14. `DimensionList.tsx` can show a by-filters logistics part in its own words instead of the generic not-stated sentence (`isByFilters` is the test).

**MKT-1E or MKT-3E**
15. `seniorityFromTitle('行銷經理')` answers `lead_staff`; `業務代表` matches no role. Both showed in MKT-1D's zh-TW personas.

**MKT-1D**
16. The ranking suite reports `no_fixture` until a baseline is stored (`--write-baseline`); on the scratch copy NDCG@10 was 0.952 (intl) and 0.942 (cn).

**MKT-4G (M4)**
17. The AI path still passes `logisticsDimension` (facts) to the scorer and to the total; scorer v4 should decide whether a filter-guaranteed logistics part counts at the prior there too. Enrichment-added skills move the job hash, so each re-enrichment re-scores the rows scored since the last one (the old score serves meanwhile); if that cost matters, take enrichment-derived skills out of the hash through a change to the contract in MARKET_TASK_PLAN before MKT-2H stores it.

**Owner**
18. Confirm the logistics prior of 50 and the logistics rule (already on the owner list for SM-3). The prior is now only ever the configured value.
19. Under "Best fit" a job with an AI score of 70 and an estimate of 60 sorts on 65 until a market has its calibration map (strategy 2.4). Say if Best fit should sort on the shown number instead.
20. A job with no fit at all still passes the Good and Great views (F-FILT-05, unchanged), while a low-confidence estimate does not.
21. A quick estimate with low confidence keeps its Good or Great badge on the card in the Everything view and is left out of the Good and Great views (strategy 2.4 and MATCH 4.4 point 6 as written; a student with no resume can see "Great, quick estimate" on a card that the Great filter then hides). The alternative is to limit a low-confidence estimate to Possible, which would also put most postings that list no skills at Possible. I kept the documents' rule and made the help sentence say what happens. Decide which you want.

## Schema requests

None. The code reads and writes `RAJobMatchScore.jobContentHash`, `.rubricVersion`, selects `RAJob.skillIds`, `.contentHash`, `.lang`, `.requirements`, `.titleMatchScore`, `RAProfile.headline`, `.seekerType`, and reads and writes `AppConfig` key `match.calibration.v1`. Every database needs the M0 push before it runs this code.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `MATCH_PRIORS` | JSON `{title_level, skills, industry, logistics, career_path}`: what a part the estimate cannot compare contributes, 0 to 100 each. One malformed key keeps all defaults. Four of them are replaced by the market's own mean once it has 200 scored values; `logistics` never is. | 44 / 39 / 24 / 50 / 45 |
| `CN_MATCH_PRIORS` | The same for GoApply; unset falls back to `MATCH_PRIORS`, then the defaults. | unset |
| `MATCH_CALIBRATION_MIN_PAIRS` | (estimate, AI) pairs a market needs before its isotonic map replaces the ranking blend. Whole number of at least 1. | 500 |

## i18n keys added or changed

- Changed: `landing.ranking.fit.body` (staged in `i18n/staging/landing.en.json`): "Your fit score for the job, out of 100. When a full fit analysis isn't available yet, a quick estimate on the same scale is used. A job whose quick estimate has too little to go on is left out when you filter for Good fits and better or Great fits only."
  The item's last sentence ("Jobs whose post says too little to compare are not shown as Good or Great.") was not what the product does: such a job can show Good in the Everything view, and the reason can be the person's record, not the post. The new sentence uses the filter's own labels.
- No other key. No Chinese-only copy.

## Known gaps

1. Until MKT-2H fills `RAJob.contentHash`, a list does not know that a posting changed since its AI score was written: it serves the score as current (`stale: false`, `basis.jobContentHash: null`). The job page and the precompute cron hold the full row, flag it and re-score it. What is shown (score, tier, kind) is the same on both forms throughout, because a stale score keeps serving.
2. Data-derived priors win over `MATCH_PRIORS` for title_level, skills, industry and career_path once a component has 200 scored values. An operator's env value for those holds only until then; the logistics value always holds.
3. The calibration document is one AppConfig row for both markets. Two brand crons writing in the same instant can lose one market's refresh; the next run 15 minutes later recomputes it.
4. I4 is enforced on the estimate. An AI fit of a thin posting keeps its own total; its `confidence` is computed from the parts the scorer scored.
5. Nothing here was checked in a browser or against a running stack; the feed's p95 is unmeasured (see Tests run for what was measured).
6. A posting re-enriched after it was scored is re-scored once by precompute or the next job-page read (the hash includes the skills, by the plan's contract). The old score serves meanwhile, so nothing visible changes, but the model call is paid again.
7. Docs (`ARCHITECTURE.md`, `/help/ranking` component) are not edited: not in my owns, and the help page needs no code change.

## Review resolution

1. **High, feed windows re-read rows and pulled every description. Fixed, and further than proposed.** `getFits` takes `{ rows }` and the feed hands its window over (`toMatchRecord`), so no job row is read again. The list projection (`getFitJobs`) no longer reads any description. `requirementTextOf` cuts the description to 8,000 characters before normalising. I did not add the proposed "fetch the text for rows whose stored score carries a hash": that set is not a handful. Precompute writes up to 25 hash-bearing scores per person per day into a 14-day window, so an active person would pull the text of 100 to 350 rows per window until MKT-2H. Instead a list takes the posting's hash from the stored `RAJob.contentHash` only, and never reads text. The cost is Known gap 1 (an informational flag, not what is shown). Measured: 44.8 ms → 25.9 ms CPU per 400-row window, 400 → 0 rows re-read, 2.7 MB → 0 of description text. Tests: `fit.test.ts` "what a list reads" (three tests with spies on every repo read), `FeedQueryService.test.ts` (`rowsHanded` equals the window), `jobHash.test.ts` (head cut). The database p95 itself is unmeasured (Request 10).
2. **Medium, a stored AI score was dropped when enrichment added a skill. Fixed as proposed.** In `storedFitStatus` the job hash is a staleness input, not a usability input. The cron's freshness rule is unchanged, so the backfill still happens. Tests: the reviewer's case (score stored, `docker` appended: still `kind: 'ai'` with the same score and tier, a capped call keeps it), the changed-posting test rewritten (serves stale, an allowed call re-scores), `storedFitStatus` unit cases.
3. **Medium, the data-derived logistics prior converged to about 100. Fixed as proposed.** `estimatePriors` skips logistics (`DATA_PRIOR_KEYS`) and `withCalibratedPriors` ignores a stored logistics value. Test: 250 AI rows with logistics 100 in nine of ten leave `priors.logistics` unset.
4. **Low, tier views compared the number while the card shows the hysteresis tier. Fixed as proposed.** `passesTier` judges an AI badge by its tier; `newCount` goes through it. Tests: `ranking.test.ts` (Good at 81, Great at 79, the Good edge), `FeedQueryService.test.ts` (the same through a query).
5. **Low, a low-confidence estimate keeps its badge while the views hide it and the copy said otherwise. Resolved on the copy side; the rule goes to the owner.** I did not limit low-confidence estimates to Possible: the strategy (2.4) and MATCH 4.4 point 6 prescribe exactly the built behaviour, and the limit would also move the worked example (coverage 0.45) and most no-skills postings to Possible. The staged sentence now says what happens, and the choice is Owner item 21.
6. **Low, visa counted as filter-guaranteed; an empty by-filters quote. Fixed.** Visa is never filter-guaranteed (`hardFilters` is `{ location, pay }`); verified against `feed/sql.ts`, which only removes postings that say no with a negation. The by-filters line always has text, or is not there. Tests: sponsorship offered / silent / refused, the visa-only case with no quote, the no-words case, `inputs.test.ts`.
7. **Low, the job page showed "50 / 100" above lines that say the job fits. Fixed inside my owns with the reviewer's fallback; the label work is requested.** The by-filters part is returned as not stated (score null) with the one `logistics_by_your_filters` line, so the page shows "Not enough to compare" and a single quote, never a number nobody measured and never a repeated line. Total, coverage and limits are unchanged in value. Requests 1, 2, 7 and 14 carry the unowned follow-up (`explainNow`, the not-stated sentence, the label in `labels.ts`, `DimensionList`).

Reviewer's lists "undone" and "unownedEdits" were empty; nothing to revert.
