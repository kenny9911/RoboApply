// server/src/features/agent/index.ts — public surface of Ready to apply (FND-5; owner WP-52).
//
// Seams:
//   agentService.answerBank(userId)               the extension's autofill (WP-55a): saved answers
//   agentService.markAnswersUsed(userId, keys)     the extension: answers it used to fill a form
//   agentService.markUserSubmitted(userId, jobId)  the extension's "Did you submit?" → yes (D1: the only submit signal)
//   produceReminders (./cron.ts)                   the `reminders` producer `agent` (kit not opened, list ready)
//   runReadyWeekly (./cron.ts)                     the `ready-weekly` cron
//   questionKeysFor / isValidQuestionKey / protectedTypeFor   canonical answer-bank keys (questionKeys.ts)

import type { AnswerBankItemView } from './contract.js';
import { getAgentService } from './service.js';

export * from './contract.js';
export { createAgentRouter, type AgentRouterOptions } from './routes.js';
export { AGENT_WORK_KINDS } from './workers.js';
export { createAgentService, getAgentService, failureCode, type AgentServiceImpl, type GenerateListOptions } from './service.js';
export type { AgentDeps, PreparePayload } from './deps.js';
export {
  QUESTION_KEYS,
  customQuestionKey,
  isSensitiveQuestionKey,
  isValidQuestionKey,
  protectedTypeFor,
  questionDefFor,
  questionKeysFor,
  type QuestionKeyDef,
} from './questionKeys.js';
export { canTransition, kitFileName, meetsMinTier, postAsksForCoverLetter, weekKeyFor } from './stateMachine.js';

export interface AgentService {
  answerBank(userId: string): Promise<AnswerBankItemView[]>;
  /** The extension's "Did you submit?" answer (only signal of a submit; D1). */
  markUserSubmitted(userId: string, jobId: string): Promise<void>;
  /** The extension filled a form with these saved answers (sets `lastUsedAt`). */
  markAnswersUsed(userId: string, questionKeys: string[]): Promise<void>;
}

export const agentService: AgentService = {
  async answerBank(userId) {
    return (await getAgentService().listAnswers(userId)).items;
  },
  async markUserSubmitted(userId, jobId) {
    await getAgentService().markUserSubmitted(userId, jobId);
  },
  async markAnswersUsed(userId, questionKeys) {
    await getAgentService().markAnswersUsed(userId, questionKeys);
  },
};
