// server/src/features/agent/index.ts — public surface of Ready to apply (FND-5; owner WP-52).
// The extension reads the answer bank through `answerBank`; the reminders
// cron calls `produceReminders` (kit ready, not opened) once WP-52 fills it.

import { NotImplementedError } from '../../platform/http.js';
import type { AnswerBankItemView } from './contract.js';

export * from './contract.js';
export { createAgentRouter } from './routes.js';
export { AGENT_WORK_KINDS } from './workers.js';

export interface AgentService {
  answerBank(userId: string): Promise<AnswerBankItemView[]>;
  /** The extension's "Did you submit?" answer (only signal of a submit; D1). */
  markUserSubmitted(userId: string, jobId: string): Promise<void>;
}

export const agentService: AgentService = {
  async answerBank() {
    throw new NotImplementedError('agent.answerBank');
  },
  async markUserSubmitted() {
    throw new NotImplementedError('agent.markUserSubmitted');
  },
};
