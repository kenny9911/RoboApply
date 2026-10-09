// server/src/features/coverletter/index.ts — public surface of CL (FND-5; owner WP-37).
// The Assistant's write_cover_letter proposal and Ready to apply `prepare` call `createLetter`.

import { NotImplementedError } from '../../platform/http.js';
import type { CoverLetterView } from './contract.js';

export * from './contract.js';
export { createCoverLetterRouter } from './routes.js';

export interface CoverLetterService {
  createLetter(
    userId: string,
    input: { jobId: string; resumeVariantId: string; tone?: 'plain' | 'warm' | 'formal'; length?: 'short' | 'standard'; trackerEntryId?: string },
    idempotencyKey: string,
  ): Promise<CoverLetterView>;
  getForJob(userId: string, jobId: string): Promise<CoverLetterView | null>;
}

export const coverLetterService: CoverLetterService = {
  async createLetter() {
    throw new NotImplementedError('coverLetter.createLetter');
  },
  async getForJob() {
    throw new NotImplementedError('coverLetter.getForJob');
  },
};
