// server/src/features/match/index.ts — public surface of MATCH (FND-5; owners WP-18, WP-77).
//
// Seams: `scoreJob` (job detail's POST /jobs/:id/score), `preScoreMany`
// (feed, extension; deterministic, no LLM), `fitAnalysis` (Assistant tool).
// With `aiAllowed(user)=false` WP-18 returns the pre-score with zero LLM calls.

import { NotImplementedError } from '../../platform/http.js';
import type { FitAnalysisCard, FitTierKey } from './contract.js';

export * from './contract.js';
export { createMatchRouter } from './routes.js';
export { MATCH_WORK_KINDS } from './workers.js';

export interface PreScore {
  jobId: string;
  score: number;
  tier: FitTierKey;
  kind: 'pre';
}

export interface MatchService {
  scoreJob(userId: string, jobId: string, options?: { resumeVariantId?: string; force?: boolean }): Promise<{ score: number; tier: FitTierKey; kind: 'pre' | 'ai' }>;
  preScoreMany(userId: string, jobIds: string[]): Promise<PreScore[]>;
  fitAnalysis(userId: string, jobId: string, idempotencyKey: string): Promise<FitAnalysisCard>;
}

export const matchService: MatchService = {
  async scoreJob() {
    throw new NotImplementedError('match.scoreJob');
  },
  async preScoreMany() {
    throw new NotImplementedError('match.preScoreMany');
  },
  async fitAnalysis() {
    throw new NotImplementedError('match.fitAnalysis');
  },
};
