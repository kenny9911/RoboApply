// server/src/features/resume/index.ts — public surface of RES (FND-5; owners WP-22 → WP-36a/36b → WP-65).
//
// Seams: `unverifiedClaimsCount(variantId)` (WP-36b export guard, WP-55a
// resume-for-job), `createTailorSession` (Assistant / Ready to apply apply
// path), `keywordReport` (job detail). Stubs until the owners fill them.

import { NotImplementedError } from '../../platform/http.js';
import type { KeywordReportResponse, TailorSessionView } from './contract.js';

export * from './contract.js';
export { createResumeSuiteRouter } from './routes.js';
export { RESUME_WORK_KINDS } from './workers.js';

export interface ResumeSuiteService {
  unverifiedClaimsCount(variantId: string): Promise<number>;
  createTailorSession(userId: string, input: { baseVariantId: string; jobId: string; idempotencyKey: string }): Promise<TailorSessionView>;
  keywordReport(userId: string, variantId: string, jobId: string): Promise<KeywordReportResponse>;
}

export const resumeSuiteService: ResumeSuiteService = {
  async unverifiedClaimsCount() {
    throw new NotImplementedError('resume.unverifiedClaimsCount');
  },
  async createTailorSession() {
    throw new NotImplementedError('resume.createTailorSession');
  },
  async keywordReport() {
    throw new NotImplementedError('resume.keywordReport');
  },
};

export const unverifiedClaimsCount = (variantId: string) => resumeSuiteService.unverifiedClaimsCount(variantId);
