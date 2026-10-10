// lib/api/prep.ts — Practice questions (question bank), contributions, moderation.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-59.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/interview-bank/companies
//   GET    /api/v1/roboapply/interview-bank/companies/:slug/questions
//   GET    /api/v1/roboapply/interview-bank/questions
//   GET    /api/v1/roboapply/interview-bank/questions/:id
//   POST   /api/v1/roboapply/interview-bank/questions/:id/guide
//   POST   /api/v1/roboapply/interview-bank/questions/:id/report
//   POST   /api/v1/roboapply/interview-bank/contributions
//   GET    /api/v1/roboapply/interview-bank/jobs/:jobId/questions
//   POST   /api/v1/roboapply/interview-bank/jobs/:jobId/questions
//   GET    /api/v1/roboapply/admin/prep/contributions
//   POST   /api/v1/roboapply/admin/prep/contributions/:id/approve
//   POST   /api/v1/roboapply/admin/prep/contributions/:id/reject
//   GET    /api/v1/roboapply/admin/prep/questions
//   POST   /api/v1/roboapply/admin/prep/questions
//   POST   /api/v1/roboapply/admin/prep/questions/:id/hide
//   POST   /api/v1/roboapply/admin/prep/questions/:id/restore

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as PR from './contracts/prep';

export type PrepCompanyView = PR.PrepCompanyView;
export type ContributionView = PR.ContributionView;

const BANK = '/api/v1/roboapply/interview-bank';
const ADMIN = '/api/v1/roboapply/admin/prep';

/** `prep.companies` — companies with moderated user reports. */
export function listPrepCompanies(query?: In<typeof PR.CompaniesQuerySchema>, opts?: CallOptions): Promise<PR.CompaniesResponse> {
  return call<PR.CompaniesResponse>('GET', withQuery(`${BANK}/companies`, query), opts);
}

/** `prep.questions` — user reports about one company (slug, or the company name when there is no record). */
export function listCompanyQuestions(slug: string, query?: In<typeof PR.CompanyQuestionsQuerySchema>, opts?: CallOptions): Promise<PR.CompanyQuestionsResponse> {
  return call<PR.CompanyQuestionsResponse>('GET', withQuery(`${BANK}/companies/${seg(slug)}/questions`, query), opts);
}

/** `prep.curated` — staff-written practice questions. */
export function listCuratedQuestions(query?: In<typeof PR.CuratedQuestionsQuerySchema>, opts?: CallOptions): Promise<PR.QuestionListResponse> {
  return call<PR.QuestionListResponse>('GET', withQuery(`${BANK}/questions`, query), opts);
}

/** `prep.question` — one question (+ its guide when written). */
export function getQuestion(id: string, opts?: CallOptions): Promise<PR.QuestionDetail> {
  return call<PR.QuestionDetail>('GET', `${BANK}/questions/${seg(id)}`, opts);
}

/** `prep.guide` — write the AI guide (first view; 30/day). */
export function generateQuestionGuide(id: string, opts?: CallOptions): Promise<PR.QuestionDetail> {
  return call<PR.QuestionDetail>('POST', `${BANK}/questions/${seg(id)}/guide`, opts);
}

/** `prep.report` */
export function reportQuestion(id: string, body: In<typeof PR.ReportQuestionBodySchema>, opts?: CallOptions): Promise<PR.ReportQuestionResponse> {
  return call<PR.ReportQuestionResponse>('POST', `${BANK}/questions/${seg(id)}/report`, { ...opts, body });
}

/** `prep.contribute` — moderated before anyone sees it. */
export function contributeQuestion(body: In<typeof PR.ContributionBodySchema>, opts?: CallOptions): Promise<PR.ContributionReceipt> {
  return call<PR.ContributionReceipt>('POST', `${BANK}/contributions`, { ...opts, body });
}

/** `prep.jobSet` — the AI set for a job + company reports (never calls a model). */
export function getJobQuestions(jobId: string, opts?: CallOptions): Promise<PR.JobQuestionSetResponse> {
  return call<PR.JobQuestionSetResponse>('GET', `${BANK}/jobs/${seg(jobId)}/questions`, opts);
}

/** `prep.jobSet.generate` — write the AI set for a job (10/day). */
export function generateJobQuestions(jobId: string, opts?: CallOptions): Promise<PR.JobQuestionSetResponse> {
  return call<PR.JobQuestionSetResponse>('POST', `${BANK}/jobs/${seg(jobId)}/questions`, opts);
}

/** `prep.admin.queue` */
export function adminListContributions(query?: In<typeof PR.ModerationQueueQuerySchema>, opts?: CallOptions): Promise<PR.ContributionListResponse> {
  return call<PR.ContributionListResponse>('GET', withQuery(`${ADMIN}/contributions`, query), opts);
}

/** `prep.admin.approve` — publish as a user report. */
export function adminApproveContribution(id: string, body: In<typeof PR.ApproveContributionBodySchema>, opts?: CallOptions): Promise<PR.QuestionView> {
  return call<PR.QuestionView>('POST', `${ADMIN}/contributions/${seg(id)}/approve`, { ...opts, body });
}

/** `prep.admin.reject` */
export function adminRejectContribution(id: string, body: In<typeof PR.RejectContributionBodySchema>, opts?: CallOptions): Promise<PR.ContributionView> {
  return call<PR.ContributionView>('POST', `${ADMIN}/contributions/${seg(id)}/reject`, { ...opts, body });
}

/** `prep.admin.questions` — reported, hidden or staff-written questions. */
export function adminListQuestions(query?: In<typeof PR.AdminQuestionsQuerySchema>, opts?: CallOptions): Promise<PR.AdminQuestionListResponse> {
  return call<PR.AdminQuestionListResponse>('GET', withQuery(`${ADMIN}/questions`, query), opts);
}

/** `prep.admin.create` — a staff-written question (never names a company). */
export function adminCreateQuestion(body: In<typeof PR.CreateCuratedQuestionBodySchema>, opts?: CallOptions): Promise<PR.QuestionView> {
  return call<PR.QuestionView>('POST', `${ADMIN}/questions`, { ...opts, body });
}

/** `prep.admin.hide` / `prep.admin.restore` */
export function adminSetQuestionHidden(id: string, hidden: boolean, opts?: CallOptions): Promise<PR.QuestionView> {
  return call<PR.QuestionView>('POST', `${ADMIN}/questions/${seg(id)}/${hidden ? 'hide' : 'restore'}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const prepApi = {
  listPrepCompanies,
  listCompanyQuestions,
  listCuratedQuestions,
  getQuestion,
  generateQuestionGuide,
  reportQuestion,
  contributeQuestion,
  getJobQuestions,
  generateJobQuestions,
  adminListContributions,
  adminApproveContribution,
  adminRejectContribution,
  adminListQuestions,
  adminCreateQuestion,
  adminSetQuestionHidden,
};
