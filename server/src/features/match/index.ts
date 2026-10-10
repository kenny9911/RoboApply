// server/src/features/match/index.ts — public surface of MATCH (FND-5; owners WP-18, WP-77).
//
// Seams:
//   - `matchService.scoreJob`      job detail's POST /jobs/:id/score (mount `createScoreJobHandler()`)
//   - `matchService.preScoreMany`  feed, extension; deterministic, no LLM
//     `matchService.preScoreJobs`  the same over rows the caller already loaded
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
export { preScore, preScoreDimensions, combineDimensions, logisticsChecks, skillKey, splitSkills } from './preScore.js';
export type { MatchJob, MatchUser, PreScoreConfig, DegreeLevel } from './preScore.js';
export { buildMatchUser, toMatchJob } from './context.js';
export type { MatchJobRecord, UserMatchInputs } from './context.js';
export { buildKeywordRows } from './keywordRows.js';
// Limits other areas display (admin "Limits" page) come from here, never from a copy.
export { getMatchTiers, getMatchWeights, ON_DEMAND_SCORE_CAP_PER_DAY, scoreCounterKeys, scoreDailyBudget } from './config.js';
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
