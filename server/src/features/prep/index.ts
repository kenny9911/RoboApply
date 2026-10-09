// server/src/features/prep/index.ts — public surface of PREP (FND-5; owner WP-59).
// The Assistant's interview_prep tool calls `planForJob`.

import { NotImplementedError } from '../../platform/http.js';
import type { QuestionView } from './contract.js';

export * from './contract.js';
export { createInterviewBankRouter } from './routes.js';
export { createPrepAdminRouter } from './adminRoutes.js';

export interface PrepService {
  planForJob(userId: string, jobId: string): Promise<{ questions: QuestionView[] }>;
}

export const prepService: PrepService = {
  async planForJob() {
    throw new NotImplementedError('prep.planForJob');
  },
};
