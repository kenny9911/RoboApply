// server/src/features/match/index.ts — public surface of MATCH (FND-5; owners WP-18, WP-77).
//
// Seams:
//   - `getFit` / `getFits` / `getVariantFit`  THE fit contract (fit.ts; MARKET_STRATEGY 2.2): one fit per
//                                  person and job against the primary resume, the same on every surface.
//                                  `getFits` never calls a model; `getVariantFit` is for tailoring only.
//   - `estimateForPosting`         the same estimate for a posting that is not a stored job (the extension's
//                                  page): never stored, never a model call
//   - `fitSnapshot`                the copy of a fit that may be stored or mailed (kind, versions, scoredAt; I6)
//   - `matchService.scoreJob`      job detail's POST /jobs/:id/score (mount `createScoreJobHandler()`): `getFit` as a view
//   - `matchService.preScoreMany`  DEPRECATED: `getFits` in the older list shape. No caller outside this area
//     `matchService.preScoreJobs`  DEPRECATED: the estimate only, over rows the caller already loaded. No caller
//                                  outside this area (the precompute cron ranks its own queue with it). Both stay
//                                  exported so no other domain breaks; new code reads `getFits` / `estimateForPosting`.
//   - `matchService.fitAnalysis`   the Assistant's fit tool (spends `fit_analysis` when a model runs)
//   - `matchService.keywordCheck`  / `keywordRows()` resume check keyword report (WP-22), tailoring (WP-36a)
//   - `preScore`, `buildMatchUser`, `toMatchJob`  pure pre-score pieces (feed ranking)
//   - `competitivenessService`     "You and what employers ask" (WP-77; flag `competitiveness`):
//                                  `latest(userId, searchProfileId?)` for the Assistant / Ready to apply;
//                                  the report page is /jobs/report (`?search=<id>`, `?job=<id>`)
// With `aiAllowed(user)=false` every path answers the pre-score with zero LLM calls.

import { defaultCompetitivenessService, defaultMatchService } from './defaultService.js';
import type { CompetitivenessService } from './CompetitivenessService.js';
import type { KeywordCheckResponse } from './contract.js';
import type { MatchService } from './MatchService.js';

export * from './contract.js';
export { createMatchRouter, createScoreJobHandler } from './routes.js';
export { MATCH_WORK_KINDS } from './workers.js';
export { createMatchService, visibleTo, ScorerFailedError } from './MatchService.js';
export type { MatchService, MatchServiceDeps, ScoreMode, ScoreOptions } from './MatchService.js';
export { preScore, preScoreDimensions, combineDimensions, combineWithPriors, isByFilters, logisticsChecks, skillKey, splitSkills, LOGISTICS_BY_FILTERS_REF } from './preScore.js';
export type { MatchJob, MatchUser, PreScoreConfig, DegreeLevel } from './preScore.js';
export { buildMatchUser, toMatchJob } from './context.js';
export type { MatchJobRecord, UserMatchInputs } from './context.js';
export { buildKeywordRows } from './keywordRows.js';
// Limits other areas display (admin "Limits" page) come from here, never from a copy.
export { getMatchPriors, getMatchTiers, getMatchWeights, currentScorerPin, ON_DEMAND_SCORE_CAP_PER_DAY, scoreCounterKeys, scoreDailyBudget } from './config.js';
export type { ScorerPin } from './config.js';
// The fit contract (fit.ts): the only place a fit is assembled.
export { getFit, getFits, getVariantFit, estimateForPosting, fitSnapshot, assembleFit, createFitService, fitFunctions, fitToListResult, fitToView, hysteresisTier, setFitServiceForTests, storedFitStatus, toWireKind, ADHOC_POSTING_ID } from './fit.js';
export type { AdhocPosting, Fit, FitConfig, FitFunctions, FitInputs, FitProse, FitSource, GetFitOptions, GetFitsOptions, StoredFitStatus } from './fit.js';
// `stripResumeForScoring` (pii.ts) is NOT exported on purpose (M2 gate, MKT-2H request 1 declined): the
// retrieval workers pick it up as their default strip the moment it is exported (retrieval/workers.ts
// `defaultStrip`), and it is the weaker of the two today: a profile link written without a scheme
// ("linkedin.com/in/<handle>") passes it, while retrieval's own `redactResumeText` removes the link.
// Export it only once pii.ts removes those links too (requests/waveM2-carryover.md, MKT-4G).
export { jobContentHash, currentJobHash } from './jobHash.js';
export type { JobHashInput } from './jobHash.js';
export { registerMatchPreparer, runMatchPreparers } from './prepare.js';
export { applyMap } from './calibration.js';
export type { CalibrationMap } from './calibration.js';
export { createCompetitivenessService } from './CompetitivenessService.js';
export type { CompetitivenessService, CompetitivenessServiceDeps } from './CompetitivenessService.js';
export { BROADEN_EXCLUDED_FIELDS, askedSkills, buildReportBody, evaluatePost } from './competitiveness.js';
export type { PostEvaluation, ReportPost, RequirementStatus } from './competitiveness.js';

/** @deprecated name kept for FND-5 callers; use `PreScoreResult`. */
export type { PreScoreResult as PreScore } from './contract.js';

export const matchService: MatchService = defaultMatchService;
export const competitivenessService: CompetitivenessService = defaultCompetitivenessService;

/** Keyword rows for (user, job[, resume variant]) — WP-22's keyword report and WP-36a reuse them. */
export const keywordRows = (userId: string, jobId: string, options?: { resumeVariantId?: string | null }): Promise<KeywordCheckResponse> =>
  matchService.keywordCheck(userId, jobId, options);
