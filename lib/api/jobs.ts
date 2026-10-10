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
//   GET    /api/v1/roboapply/jobs/:id/company-news   (V2; 404 feature_disabled while dark)
//   GET    /api/v1/roboapply/companies
//   GET    /api/v1/roboapply/companies/:idOrSlug
//   GET    /api/v1/roboapply/companies/:id/h1b
//   GET    /api/v1/roboapply/companies/:id/jobs

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as D from './contracts/jobs/detail';
import { listingApply, listingSource, type ListingApply, type ListingSource } from './feed';
import type * as CO from './contracts/jobs/companies';

/** `jobs.get` — GET /api/v1/roboapply/jobs/:id */
export function getJob(id: string, opts?: CallOptions): Promise<D.JobDetailResponse> {
  return call<D.JobDetailResponse>('GET', `/api/v1/roboapply/jobs/${seg(id)}`, opts);
}

/** `jobs.score` — POST /api/v1/roboapply/jobs/:id/score */
export function scoreJob(id: string, body: In<typeof D.ScoreJobBodySchema> = {}, opts?: CallOptions): Promise<D.ScoreJobResponse> {
  return call<D.ScoreJobResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/score`, { ...opts, body });
}

/** `jobs.similar` — GET /api/v1/roboapply/jobs/:id/similar */
export function getSimilarJobs(id: string, opts?: CallOptions): Promise<D.SimilarJobsResponse> {
  return call<D.SimilarJobsResponse>('GET', `/api/v1/roboapply/jobs/${seg(id)}/similar`, opts);
}

/** `jobs.save` — POST /api/v1/roboapply/jobs/:id/save */
export function saveJob(id: string, opts?: CallOptions): Promise<D.SaveJobResponse> {
  return call<D.SaveJobResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/save`, opts);
}

/** `jobs.unsave` — DELETE /api/v1/roboapply/jobs/:id/save */
export function unsaveJob(id: string, opts?: CallOptions): Promise<D.SaveJobResponse> {
  return call<D.SaveJobResponse>('DELETE', `/api/v1/roboapply/jobs/${seg(id)}/save`, opts);
}

/** `jobs.applyClick` — POST /api/v1/roboapply/jobs/:id/apply-click */
export function applyClick(id: string, opts?: CallOptions): Promise<D.ApplyClickResponse> {
  return call<D.ApplyClickResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/apply-click`, opts);
}

/** `jobs.markApplied` — POST /api/v1/roboapply/jobs/:id/applied */
export function markApplied(id: string, body: In<typeof D.MarkAppliedBodySchema> = {}, opts?: CallOptions): Promise<D.MarkAppliedResponse> {
  return call<D.MarkAppliedResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/applied`, { ...opts, body });
}

/** `jobs.undoApplied` — DELETE /api/v1/roboapply/jobs/:id/applied */
export function undoApplied(id: string, opts?: CallOptions): Promise<D.UndoAppliedResponse> {
  return call<D.UndoAppliedResponse>('DELETE', `/api/v1/roboapply/jobs/${seg(id)}/applied`, opts);
}

/** `jobs.share` — POST /api/v1/roboapply/jobs/:id/share */
export function shareJob(id: string, opts?: CallOptions): Promise<D.ShareResponse> {
  return call<D.ShareResponse>('POST', `/api/v1/roboapply/jobs/${seg(id)}/share`, opts);
}

/** `jobs.companyNews` — GET /api/v1/roboapply/jobs/:id/company-news (search results, not verified) */
export function getCompanyNews(id: string, opts?: CallOptions): Promise<D.CompanyNewsResponse> {
  return call<D.CompanyNewsResponse>('GET', `/api/v1/roboapply/jobs/${seg(id)}/company-news`, opts);
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
export function getCompanyJobs(id: string, query?: In<typeof CO.CompanyJobsQuerySchema>, opts?: CallOptions): Promise<CO.CompanyJobsResponse> {
  return call<CO.CompanyJobsResponse>('GET', withQuery(`/api/v1/roboapply/companies/${seg(id)}/jobs`, query), opts);
}

/**
 * The job page's listing facts, read from the detail response with the same
 * safe defaults as the feed card (lib/api/feed.ts). The contract puts `apply`
 * and the extended `source` on the job; a response from before it has
 * `job.applyUrl` and `job.source.{ name, kind, originalName }`, which give the
 * same answers.
 */
export interface JobListing {
  source: ListingSource;
  apply: ListingApply;
}

export function jobListing(detail: Pick<D.JobDetailResponse, 'job'> | null | undefined): JobListing {
  const job = detail?.job ?? null;
  return { source: listingSource(job), apply: listingApply(job) };
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
  getCompanyNews,
  searchCompanies,
  getCompany,
  getCompanyH1b,
  getCompanyJobs,
};
