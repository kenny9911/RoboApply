// server/src/features/jobs/detail/index.ts — public surface of job detail (FND-5; owner WP-34).
//
// Seams:
//   - jobDetailService.get                the Assistant's get_job tool, the extension
//   - jobDetailService.similar            the job page's Similar jobs list, for the Assistant's
//                                         similar_jobs tool (M4 gate; MKT-4H request 1). A
//                                         caller whose card prints an open-data row's credit
//                                         line passes `{ creditLines: true }` and gets those
//                                         rows with `cardMeta.tw_sources`; any other caller
//                                         never gets one (MKT-5C)
//   - jobDetailService.recordApplyClick   the shared apply path (feed card, job page,
//                                         Ready to apply `open`): tracker → applied at once
//   - jobDetailService.undoApplied        "Undo · I didn't apply"
//   - trackerEntryLockKey(userId, jobId)  advisory-lock key every tracker-entry writer
//                                         takes before creating an entry (WP-38)
//   - registerExtensionAtsTypes(types, fillsJob?)  WP-55a/WP-70 register the ATS
//                                         types the extension can fill and the
//                                         market/host check (`extensionSupported`)

import type { ApplyClickResponse, JobDetailResponse, SimilarJobsResponse, UndoAppliedResponse } from './contract.js';
import type { JobReadOptions } from './service.js';

export * from './contract.js';
export { createJobDetailRouter, type JobDetailRouterDeps } from './routes.js';
export { createJobDetailService, LISTING_WAIT_MS, SIMILAR_LIMIT, trackerEntryLockKey, type JobDetailDb, type JobDetailServiceDeps, type JobDetailServiceImpl, type JobReadOptions } from './service.js';
export { registerExtensionAtsTypes } from './defaultService.js';
export { peopleSearchLinks, shareTarget, toBadges, toPay, toSponsorship, toRequirements, slugify } from './view.js';

export interface JobDetailService {
  /** `opts.locale`: the request's UI language (the skill labels of the fit follow it). */
  get(userId: string, jobId: string, opts?: JobReadOptions): Promise<JobDetailResponse>;
  /**
   * The job page's Similar jobs list (`GET /jobs/:id/similar`): by job vector,
   * best fit first, with the page's own rules (no hidden or flagged job, and
   * no row whose credit line the caller does not print: `opts.creditLines`).
   */
  similar(userId: string, jobId: string, opts?: JobReadOptions): Promise<SimilarJobsResponse>;
  /** Shared apply path (feed card, detail page, Ready to apply `open`): tracker → applied at once. */
  recordApplyClick(userId: string, jobId: string): Promise<ApplyClickResponse>;
  undoApplied(userId: string, jobId: string): Promise<UndoAppliedResponse>;
}

const impl = async () => (await import('./defaultService.js')).defaultJobDetailService();

/** Market-scoped to the current brand (request context). */
export const jobDetailService: JobDetailService = {
  async get(userId, jobId, opts) {
    return (await impl()).get(userId, jobId, opts);
  },
  async similar(userId, jobId, opts) {
    return (await impl()).similar(userId, jobId, opts);
  },
  async recordApplyClick(userId, jobId) {
    return (await impl()).recordApplyClick(userId, jobId);
  },
  async undoApplied(userId, jobId) {
    return (await impl()).undoApplied(userId, jobId);
  },
};
