// lib/api/jobs.ts — Job detail, save, apply click, applied/undo, share, similar jobs, companies.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-34.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/jobs/:id
//   POST   /api/v1/roboapply/jobs/:id/score
//   GET    /api/v1/roboapply/jobs/:id/similar
//   POST   /api/v1/roboapply/jobs/:id/save
//   DELETE /api/v1/roboapply/jobs/:id/save
//   POST   /api/v1/roboapply/jobs/:id/apply-click
//   POST   /api/v1/roboapply/jobs/:id/applied
//   DELETE /api/v1/roboapply/jobs/:id/applied
//   POST   /api/v1/roboapply/jobs/:id/share
//   GET    /api/v1/roboapply/companies
//   GET    /api/v1/roboapply/companies/:idOrSlug
//   GET    /api/v1/roboapply/companies/:id/h1b
//   GET    /api/v1/roboapply/companies/:id/jobs

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as D from './contracts/jobs/detail';
import type * as CO from './contracts/jobs/companies';
import type * as F from './contracts/feed';

/** `jobs.get` — GET /api/v1/roboapply/jobs/:id */
export function getJob(id: string, opts?: CallOptions): Promise<D.JobDetailResponse> {
  return call<D.JobDetailResponse>('GET', `/api/v1/roboapply/jobs/${seg(id)}`, opts);
}

/** `jobs.score` — POST /api/v1/roboapply/jobs/:id/score */
export function scoreJob(id: string, body: In<typeof D.ScoreJobBodySchema> = {}, opts?: CallOptions): Promise<D.ScoreJobResponse> {
  return call<D.ScoreJobResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/score`, { ...opts, body });
}

/** `jobs.similar` — GET /api/v1/roboapply/jobs/:id/similar */
export function getSimilarJobs(id: string, opts?: CallOptions): Promise<Items<F.FeedItem>> {
  return call<Items<F.FeedItem>>('GET', `/api/v1/roboapply/jobs/${seg(id)}/similar`, opts);
}

/** `jobs.save` — POST /api/v1/roboapply/jobs/:id/save */
export function saveJob(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/jobs/${seg(id)}/save`, opts);
}

/** `jobs.unsave` — DELETE /api/v1/roboapply/jobs/:id/save */
export function unsaveJob(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/jobs/${seg(id)}/save`, opts);
}

/** `jobs.applyClick` — POST /api/v1/roboapply/jobs/:id/apply-click */
export function applyClick(id: string, opts?: CallOptions): Promise<D.ApplyClickResponse> {
  return call<D.ApplyClickResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/apply-click`, opts);
}

/** `jobs.markApplied` — POST /api/v1/roboapply/jobs/:id/applied */
export function markApplied(id: string, body: In<typeof D.MarkAppliedBodySchema> = {}, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/jobs/${seg(id)}/applied`, { ...opts, body });
}

/** `jobs.undoApplied` — DELETE /api/v1/roboapply/jobs/:id/applied */
export function undoApplied(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/jobs/${seg(id)}/applied`, opts);
}

/** `jobs.share` — POST /api/v1/roboapply/jobs/:id/share */
export function shareJob(id: string, opts?: CallOptions): Promise<D.ShareResponse> {
  return call<D.ShareResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/share`, opts);
}

/** `companies.typeahead` — GET /api/v1/roboapply/companies */
export function searchCompanies(query: In<typeof CO.CompanyTypeaheadQuerySchema>, opts?: CallOptions): Promise<CO.CompanyTypeaheadResponse> {
  return call<CO.CompanyTypeaheadResponse>('GET', withQuery(`/api/v1/roboapply/companies`, query), opts);
}

/** `companies.profile` — GET /api/v1/roboapply/companies/:idOrSlug */
export function getCompany(idOrSlug: string, opts?: CallOptions): Promise<CO.CompanyProfile> {
  return call<CO.CompanyProfile>('GET', `/api/v1/roboapply/companies/${seg(idOrSlug)}`, opts);
}

/** `companies.h1b` — GET /api/v1/roboapply/companies/:id/h1b */
export function getCompanyH1b(id: string, opts?: CallOptions): Promise<CO.H1bHistoryResponse> {
  return call<CO.H1bHistoryResponse>('GET', `/api/v1/roboapply/companies/${seg(id)}/h1b`, opts);
}

/** `companies.jobs` — GET /api/v1/roboapply/companies/:id/jobs */
export function getCompanyJobs(id: string, query?: In<typeof CO.CompanyJobsQuerySchema>, opts?: CallOptions): Promise<Items<F.FeedItem>> {
  return call<Items<F.FeedItem>>('GET', withQuery(`/api/v1/roboapply/companies/${seg(id)}/jobs`, query), opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const jobsApi = {
  getJob,
  scoreJob,
  getSimilarJobs,
  saveJob,
  unsaveJob,
  applyClick,
  markApplied,
  undoApplied,
  shareJob,
  searchCompanies,
  getCompany,
  getCompanyH1b,
  getCompanyJobs,
};
