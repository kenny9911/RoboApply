// server/src/features/agent/index.ts — public surface of Ready to apply (FND-5; owner WP-52).
//
// Seams:
//   agentService.answerBank(userId)               the extension's autofill (WP-55a): saved answers
//   agentService.markAnswersUsed(userId, keys)     the extension: answers it used to fill a form
//   agentService.saveApprovedAnswer(userId, input) the extension's "Save this answer" (F-EXT-04; WP-93)
//   agentService.markUserSubmitted(userId, jobId)  the extension's "Did you submit?" → yes (D1: the only submit signal)
//   agentService.jobPlaces(userId, jobIds)         the Assistant: where jobs stand on the list (read only)
//   agentService.quoteJob(userId, jobId)           the Assistant: what preparing one job uses, before anything is spent
//   agentService.addToQueue(userId, input)         the Assistant, once the user applied its proposal: put a job on the list
//   agentService.prepare(userId, ids, { idempotencyKey })  the same: start preparing (the ready_kits credit gate)
//   produceReminders (./cron.ts)                   the `reminders` producer `agent` (kit not opened, list ready)
//   runReadyWeekly (./cron.ts)                     the `ready-weekly` cron
//   questionKeysFor / isValidQuestionKey / protectedTypeFor   canonical answer-bank keys (questionKeys.ts)

import type { AnswerBankItemView, JobPlacesResponse, JobPrepareQuote, PrepareProposal, QueueAddedVia, QueueItemView } from './contract.js';
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
  /** The extension's "Save this answer": an answer the user approved in the panel (source `ai_confirmed`). */
  saveApprovedAnswer(userId: string, input: { questionText: string; answer: string; locale?: string }): Promise<{ questionKey: string }>;
  /** The Assistant: where these jobs stand on the user's list. Read only. */
  jobPlaces(userId: string, jobIds: readonly string[]): Promise<JobPlacesResponse>;
  /** The Assistant: what preparing one job's application uses (the cost sheet's own lines), before anything is spent. Read only. */
  quoteJob(userId: string, jobId: string): Promise<JobPrepareQuote>;
  /** The Assistant, after the user applied its proposal: put jobs on the list (no credit; the item it has when a job is there already). */
  addToQueue(userId: string, input: { jobIds: string[]; addedVia?: QueueAddedVia }): Promise<{ items: QueueItemView[] }>;
  /**
   * The Assistant, after the user applied its proposal: start preparing these
   * kits (`prepare` with `confirm`), each `ready_kits` reservation keyed by
   * `idempotencyKey`. 402 credits_exhausted when a bucket is short. Never submits (D1).
   */
  prepare(userId: string, ids: string[], options: { idempotencyKey: string }): Promise<PrepareProposal>;
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
  async saveApprovedAnswer(userId, input) {
    return getAgentService().saveApprovedAnswer(userId, input);
  },
  async jobPlaces(userId, jobIds) {
    return getAgentService().jobPlaces(userId, jobIds);
  },
  async quoteJob(userId, jobId) {
    return getAgentService().quoteJob(userId, jobId);
  },
  async addToQueue(userId, input) {
    return getAgentService().addToQueue(userId, input);
  },
  async prepare(userId, ids, options) {
    return getAgentService().prepare(userId, ids, true, { idempotencyKey: options.idempotencyKey });
  },
};
