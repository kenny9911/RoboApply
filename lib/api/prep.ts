// lib/api/prep.ts — Practice questions (question bank), contributions, moderation.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-59.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/interview-bank/companies
//   GET    /api/v1/roboapply/interview-bank/companies/:slug/questions
//   GET    /api/v1/roboapply/interview-bank/questions/:id
//   POST   /api/v1/roboapply/interview-bank/questions/:id/report
//   POST   /api/v1/roboapply/interview-bank/contributions
//   GET    /api/v1/roboapply/admin/prep/contributions
//   POST   /api/v1/roboapply/admin/prep/contributions/:id/approve
//   POST   /api/v1/roboapply/admin/prep/contributions/:id/reject

import { call, type CallOptions, type In, type Items, type Out, seg, withQuery } from './contracts/wire';
import type * as PR from './contracts/prep';

/** A company in the question bank. The contract names no view type yet (WP-59). */
export interface PrepCompanyView {
  slug: string;
  name: string;
  questionCount: number;
}
/** A contribution in the moderation queue. The contract names no view type yet (WP-59). */
export type ContributionView = Out<typeof PR.ContributionBodySchema> & { id: string; createdAt: string };

/** `prep.companies` — GET /api/v1/roboapply/interview-bank/companies */
export function listPrepCompanies(query?: In<typeof PR.CompaniesQuerySchema>, opts?: CallOptions): Promise<Items<PrepCompanyView>> {
  return call<Items<PrepCompanyView>>('GET', withQuery(`/api/v1/roboapply/interview-bank/companies`, query), opts);
}

/** `prep.questions` — GET /api/v1/roboapply/interview-bank/companies/:slug/questions */
export function listCompanyQuestions(slug: string, query?: In<typeof PR.CompanyQuestionsQuerySchema>, opts?: CallOptions): Promise<Items<PR.QuestionView>> {
  return call<Items<PR.QuestionView>>('GET', withQuery(`/api/v1/roboapply/interview-bank/companies/${seg(slug)}/questions`, query), opts);
}

/** `prep.question` — GET /api/v1/roboapply/interview-bank/questions/:id */
export function getQuestion(id: string, opts?: CallOptions): Promise<PR.QuestionDetail> {
  return call<PR.QuestionDetail>('GET', `/api/v1/roboapply/interview-bank/questions/${seg(id)}`, opts);
}

/** `prep.report` — POST /api/v1/roboapply/interview-bank/questions/:id/report */
export function reportQuestion(id: string, body: In<typeof PR.ReportQuestionBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/interview-bank/questions/${seg(id)}/report`, { ...opts, body });
}

/** `prep.contribute` — POST /api/v1/roboapply/interview-bank/contributions */
export function contributeQuestion(body: In<typeof PR.ContributionBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/interview-bank/contributions`, { ...opts, body });
}

/** `prep.admin.queue` — GET /api/v1/roboapply/admin/prep/contributions */
export function adminListContributions(query?: In<typeof PR.ModerationQueueQuerySchema>, opts?: CallOptions): Promise<Items<ContributionView>> {
  return call<Items<ContributionView>>('GET', withQuery(`/api/v1/roboapply/admin/prep/contributions`, query), opts);
}

/** `prep.admin.approve` — POST /api/v1/roboapply/admin/prep/contributions/:id/approve */
export function adminApproveContribution(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/admin/prep/contributions/${seg(id)}/approve`, opts);
}

/** `prep.admin.reject` — POST /api/v1/roboapply/admin/prep/contributions/:id/reject */
export function adminRejectContribution(id: string, body: In<typeof PR.RejectContributionBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/admin/prep/contributions/${seg(id)}/reject`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const prepApi = {
  listPrepCompanies,
  listCompanyQuestions,
  getQuestion,
  reportQuestion,
  contributeQuestion,
  adminListContributions,
  adminApproveContribution,
  adminRejectContribution,
};
