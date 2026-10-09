// lib/api/match.ts — Fit analysis and the competitiveness report.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-18 (report: WP-77).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// `POST /jobs/:id/score` lives on the job-detail mount: lib/api/jobs.ts
// `scoreJob`.
//
// Endpoints:
//   POST   /api/v1/roboapply/match/jobs/:id/fit-analysis
//   POST   /api/v1/roboapply/match/competitiveness
//   GET    /api/v1/roboapply/match/competitiveness/latest

import { call, type CallOptions, type In, seg } from './contracts/wire';
import type * as M from './contracts/match';

/** `match.fitAnalysis` — POST /api/v1/roboapply/match/jobs/:id/fit-analysis */
export function getFitAnalysis(id: string, body: In<typeof M.FitAnalysisBodySchema> = {}, opts?: CallOptions): Promise<M.FitAnalysisCard> {
  return call<M.FitAnalysisCard>('POST', `/api/v1/roboapply/match/jobs/${seg(id)}/fit-analysis`, { ...opts, body });
}

/** `match.competitiveness` — POST /api/v1/roboapply/match/competitiveness */
export function createCompetitivenessReport(body: In<typeof M.CompetitivenessBodySchema>, opts?: CallOptions): Promise<M.CompetitivenessReport> {
  return call<M.CompetitivenessReport>('POST', `/api/v1/roboapply/match/competitiveness`, { ...opts, body });
}

/** `match.competitivenessLatest` — GET /api/v1/roboapply/match/competitiveness/latest */
export function getLatestCompetitivenessReport(opts?: CallOptions): Promise<M.CompetitivenessReport | null> {
  return call<M.CompetitivenessReport | null>('GET', `/api/v1/roboapply/match/competitiveness/latest`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const matchApi = {
  getFitAnalysis,
  createCompetitivenessReport,
  getLatestCompetitivenessReport,
};
