// server/src/features/jobs/detail/index.ts — public surface (FND-5; owner WP-34).
// The Assistant's get_job tool and the extension use `jobDetailService.get`.

import { NotImplementedError } from '../../../platform/http.js';
import type { ApplyClickResponse, JobDetailResponse } from './contract.js';

export * from './contract.js';
export { createJobDetailRouter } from './routes.js';

export interface JobDetailService {
  get(userId: string, jobId: string): Promise<JobDetailResponse>;
  /** Shared apply path (feed card, detail page, Ready to apply `open`): tracker → applied at once. */
  recordApplyClick(userId: string, jobId: string): Promise<ApplyClickResponse>;
  undoApplied(userId: string, jobId: string): Promise<void>;
}

export const jobDetailService: JobDetailService = {
  async get() {
    throw new NotImplementedError('jobs.get');
  },
  async recordApplyClick() {
    throw new NotImplementedError('jobs.recordApplyClick');
  },
  async undoApplied() {
    throw new NotImplementedError('jobs.undoApplied');
  },
};
