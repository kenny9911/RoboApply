// server/src/features/jobs/detail/index.ts — public surface of job detail (FND-5; owner WP-34).
//
// Seams:
//   - jobDetailService.get                the Assistant's get_job tool, the extension
//   - jobDetailService.recordApplyClick   the shared apply path (feed card, job page,
//                                         Ready to apply `open`): tracker → applied at once
//   - jobDetailService.undoApplied        "Undo · I didn't apply"
//   - trackerEntryLockKey(userId, jobId)  advisory-lock key every tracker-entry writer
//                                         takes before creating an entry (WP-38)
//   - registerExtensionAtsTypes(types)    WP-55a/WP-70 register the ATS types the
//                                         extension can fill (`extensionSupported`)

import type { ApplyClickResponse, JobDetailResponse, UndoAppliedResponse } from './contract.js';

export * from './contract.js';
export { createJobDetailRouter, type JobDetailRouterDeps } from './routes.js';
export { createJobDetailService, SIMILAR_LIMIT, trackerEntryLockKey, type JobDetailDb, type JobDetailServiceDeps, type JobDetailServiceImpl } from './service.js';
export { registerExtensionAtsTypes } from './defaultService.js';
export { peopleSearchLinks, shareTarget, toBadges, toPay, toSponsorship, toRequirements, slugify } from './view.js';

export interface JobDetailService {
  get(userId: string, jobId: string): Promise<JobDetailResponse>;
  /** Shared apply path (feed card, detail page, Ready to apply `open`): tracker → applied at once. */
  recordApplyClick(userId: string, jobId: string): Promise<ApplyClickResponse>;
  undoApplied(userId: string, jobId: string): Promise<UndoAppliedResponse>;
}

const impl = async () => (await import('./defaultService.js')).defaultJobDetailService();

/** Market-scoped to the current brand (request context). */
export const jobDetailService: JobDetailService = {
  async get(userId, jobId) {
    return (await impl()).get(userId, jobId);
  },
  async recordApplyClick(userId, jobId) {
    return (await impl()).recordApplyClick(userId, jobId);
  },
  async undoApplied(userId, jobId) {
    return (await impl()).undoApplied(userId, jobId);
  },
};
