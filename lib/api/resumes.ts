// lib/api/resumes.ts — Resume suite additions: grade, issue fixes, keyword report, tailor sessions, layout.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-22 → WP-36a/36b → WP-65.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// The legacy resume CRUD stays on lib/api/v2 (frozen) until WP-36b moves its
// callers here.
//
// Endpoints:
//   POST   /api/v1/roboapply/v2/resumes/tailor-sessions
//   GET    /api/v1/roboapply/v2/resumes/tailor-sessions/:id
//   PATCH  /api/v1/roboapply/v2/resumes/tailor-sessions/:id/claims/:claimId
//   POST   /api/v1/roboapply/v2/resumes/tailor-sessions/:id/finalize
//   POST   /api/v1/roboapply/v2/resumes/grades/:gradeId/cancel
//   POST   /api/v1/roboapply/v2/resumes/:id/grade
//   GET    /api/v1/roboapply/v2/resumes/:id/grade/latest
//   POST   /api/v1/roboapply/v2/resumes/:id/issues/:issueId/fix
//   POST   /api/v1/roboapply/v2/resumes/:id/keyword-report
//   PATCH  /api/v1/roboapply/v2/resumes/:id/layout

import { call, type CallOptions, type In, type Out, seg } from './contracts/wire';
import type * as R from './contracts/resume';

/** `resume.createTailorSession` — POST /api/v1/roboapply/v2/resumes/tailor-sessions */
export function createTailorSession(body: In<typeof R.CreateTailorSessionBodySchema>, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('POST', `/api/v1/roboapply/v2/resumes/tailor-sessions`, { ...opts, body });
}

/** `resume.getTailorSession` — GET /api/v1/roboapply/v2/resumes/tailor-sessions/:id */
export function getTailorSession(id: string, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('GET', `/api/v1/roboapply/v2/resumes/tailor-sessions/${seg(id)}`, opts);
}

/** `resume.updateClaim` — PATCH /api/v1/roboapply/v2/resumes/tailor-sessions/:id/claims/:claimId */
export function updateTailorClaim(id: string, claimId: string, body: In<typeof R.UpdateClaimBodySchema>, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('PATCH', `/api/v1/roboapply/v2/resumes/tailor-sessions/${seg(id)}/claims/${seg(claimId)}`, { ...opts, body });
}

/** `resume.finalizeTailor` — POST /api/v1/roboapply/v2/resumes/tailor-sessions/:id/finalize */
export function finalizeTailorSession(id: string, opts?: CallOptions): Promise<R.TailorSessionView> {
  return call<R.TailorSessionView>('POST', `/api/v1/roboapply/v2/resumes/tailor-sessions/${seg(id)}/finalize`, opts);
}

/** `resume.cancelGrade` — POST /api/v1/roboapply/v2/resumes/grades/:gradeId/cancel */
export function cancelGrade(gradeId: string, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/v2/resumes/grades/${seg(gradeId)}/cancel`, opts);
}

/** `resume.grade` — POST /api/v1/roboapply/v2/resumes/:id/grade */
export function startGrade(id: string, body: In<typeof R.GradeBodySchema> = {}, opts?: CallOptions): Promise<R.GradeStartResponse> {
  return call<R.GradeStartResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/grade`, { ...opts, body });
}

/** `resume.latestGrade` — GET /api/v1/roboapply/v2/resumes/:id/grade/latest */
export function getLatestGrade(id: string, opts?: CallOptions): Promise<R.GradeView | null> {
  return call<R.GradeView | null>('GET', `/api/v1/roboapply/v2/resumes/${seg(id)}/grade/latest`, opts);
}

/** `resume.fixIssue` — POST /api/v1/roboapply/v2/resumes/:id/issues/:issueId/fix */
export function fixIssue(id: string, issueId: string, body: In<typeof R.FixIssueBodySchema>, opts?: CallOptions): Promise<R.FixIssueResponse> {
  return call<R.FixIssueResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/issues/${seg(issueId)}/fix`, { ...opts, body });
}

/** `resume.keywordReport` — POST /api/v1/roboapply/v2/resumes/:id/keyword-report */
export function getKeywordReport(id: string, body: In<typeof R.KeywordReportBodySchema>, opts?: CallOptions): Promise<R.KeywordReportResponse> {
  return call<R.KeywordReportResponse>('POST', `/api/v1/roboapply/v2/resumes/${seg(id)}/keyword-report`, { ...opts, body });
}

/** `resume.layout` — PATCH /api/v1/roboapply/v2/resumes/:id/layout */
export function patchResumeLayout(id: string, body: In<typeof R.PatchLayoutBodySchema>, opts?: CallOptions): Promise<Out<typeof R.ResumeLayoutSchema>> {
  return call<Out<typeof R.ResumeLayoutSchema>>('PATCH', `/api/v1/roboapply/v2/resumes/${seg(id)}/layout`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const resumesApi = {
  createTailorSession,
  getTailorSession,
  updateTailorClaim,
  finalizeTailorSession,
  cancelGrade,
  startGrade,
  getLatestGrade,
  fixIssue,
  getKeywordReport,
  patchResumeLayout,
};
