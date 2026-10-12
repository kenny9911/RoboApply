// lib/api/match.ts — Fit analysis and the competitiveness report.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-18 (report: WP-77).
// The fit-analysis and competitiveness calls need `opts.idempotencyKey`
// (hooks/match passes the credit gate's key), so a retry never spends a
// second credit.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// `POST /jobs/:id/score` lives on the job-detail mount: lib/api/jobs.ts
// `scoreJob`.
//
// Endpoints:
//   POST   /api/v1/roboapply/match/jobs/:id/fit-analysis
//   GET    /api/v1/roboapply/match/jobs/:id/keyword-check
//   POST   /api/v1/roboapply/match/competitiveness
//   GET    /api/v1/roboapply/match/competitiveness/latest

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as M from './contracts/match';

/** `match.fitAnalysis` — POST /api/v1/roboapply/match/jobs/:id/fit-analysis */
export function getFitAnalysis(id: string, body: In<typeof M.FitAnalysisBodySchema> = {}, opts?: CallOptions): Promise<M.FitAnalysisCard> {
  return call<M.FitAnalysisCard>('POST', `/api/v1/roboapply/match/jobs/${seg(id)}/fit-analysis`, { ...opts, body });
}

/** `match.keywordCheck` — GET /api/v1/roboapply/match/jobs/:id/keyword-check */
export function getKeywordCheck(id: string, query: In<typeof M.KeywordCheckQuerySchema> = {}, opts?: CallOptions): Promise<M.KeywordCheckResponse> {
  return call<M.KeywordCheckResponse>('GET', withQuery(`/api/v1/roboapply/match/jobs/${seg(id)}/keyword-check`, query), opts);
}

/** `match.competitiveness` — POST /api/v1/roboapply/match/competitiveness */
export function createCompetitivenessReport(body: In<typeof M.CompetitivenessBodySchema>, opts?: CallOptions): Promise<M.CompetitivenessReport> {
  return call<M.CompetitivenessReport>('POST', `/api/v1/roboapply/match/competitiveness`, { ...opts, body });
}

/** `match.competitivenessLatest` — GET /api/v1/roboapply/match/competitiveness/latest (the newest report, or null) */
export function getLatestCompetitivenessReport(
  query: In<typeof M.CompetitivenessLatestQuerySchema> = {},
  opts?: CallOptions,
): Promise<M.CompetitivenessReport | null> {
  return call<M.CompetitivenessReport | null>('GET', withQuery(`/api/v1/roboapply/match/competitiveness/latest`, query), opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const matchApi = {
  getFitAnalysis,
  getKeywordCheck,
  createCompetitivenessReport,
  getLatestCompetitivenessReport,
};
