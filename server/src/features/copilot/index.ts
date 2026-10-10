// server/src/features/copilot/index.ts — public surface of the Assistant (FND-5 seam; WP-50).
//
// Seams:
//   - handleVisitorTurn(input, { tools: 'public' }) — WP-78's visitor
//     assistant; page-scoped public tools only (search_jobs over public
//     listings, salary_context, explain_feature), no persistence, no credits.
//     Returns the turn's SSE events; the caller rate-limits per IP and writes
//     them with platform/sse.
//   - listFeedback() — WP-74's admin feedback queue.
//   - getCopilotService() — the process-wide service (routes, tests).

import crypto from 'node:crypto';
import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import { parseBrandId } from '../../platform/brand/registry.js';
import { aiAllowed, hasLiveConsent } from '../../platform/consent/index.js';
import { creditService } from '../../platform/credits/index.js';
import { hiringContactsMode, isEnabled } from '../../platform/flags.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { logger } from '../../services/LoggerService.js';
import { createDefaultAreas } from './areas.js';
import { createCopilotBudget } from './budget.js';
import { CopilotService, type CopilotEventStream, type CopilotServiceDeps } from './CopilotService.js';
import type { CopilotFeedbackRow, VisitorTurnInput } from './contract.js';
import { createPrismaNudgeSignals } from './nudges.js';
import { createPrismaCopilotStore, newMessageId } from './store.js';
import type { SummaryDeps } from './summary.js';
import { COPILOT_WORK_KINDS } from './workers.js';

export * from './contract.js';
export { createCopilotRouter } from './routes.js';
export type { CopilotRouterOptions } from './routes.js';
export { COPILOT_WORK_KINDS } from './workers.js';
export { CopilotService } from './CopilotService.js';
export type { CopilotEventStream, CopilotServiceDeps, TurnInput, TurnOptions } from './CopilotService.js';
export { collect as collectCopilotEvents } from './channel.js';

export interface VisitorTurnOptions {
  /** Only the page-scoped public tools (search_jobs public, salary_context, explain_feature). */
  tools: 'public';
  /** Aborts the model call when the client disconnects. */
  signal?: AbortSignal;
  /** Reply language (the visitor's locale). */
  locale?: string;
}

const llmLazy: CopilotServiceDeps['llm'] = {
  async streamChatWithTools(messages, opts) {
    const { llmService } = await import('../../platform/llm/index.js');
    return llmService.streamChatWithTools(messages, opts);
  },
};

export function defaultCopilotDeps(): CopilotServiceDeps {
  const store = createPrismaCopilotStore();
  return {
    store,
    areas: createDefaultAreas({ store }),
    llm: llmLazy,
    aiAllowed: (userId) => aiAllowed(userId),
    assertPhoneBound: async (userId) => {
      if (getCurrentBrandOrDefault().market !== 'cn') return;
      const { assertPhoneBound } = await import('../auth-cn/index.js');
      await assertPhoneBound(userId);
    },
    credits: creditService,
    budget: createCopilotBudget(),
    hasConsent: (userId, type) => hasLiveConsent(userId, type),
    isEnabled: (key, userId) => isEnabled(key, { userId }),
    hiringContactsMode: () => hiringContactsMode(),
    costOf: (model, usage) => logger.calculateCost(model, usage.promptTokens, usage.completionTokens),
    enqueueSummary: async ({ threadId, userId, brand, mark }) => {
      const { enqueue, kickDrain } = await import('../../platform/queue/index.js');
      await enqueue(COPILOT_WORK_KINDS.copilotSummary, { threadId }, { dedupeKey: `copilot.summary:${threadId}:${mark}`, userId, brand: parseBrandId(brand) ?? undefined });
      void kickDrain([COPILOT_WORK_KINDS.copilotSummary]);
    },
    logAiLabel: async ({ userId, contentId }) => {
      const { complianceService } = await import('../compliance/index.js');
      await complianceService.logAiContentLabel({ userId, contentId, kind: 'assistant_reply', provider: 'llm' });
    },
    nudgeSignals: createPrismaNudgeSignals(),
    brand: () => getCurrentBrandOrDefault(),
    now: () => new Date(),
    requestId: () => getCurrentRequestId() ?? null,
    newMessageId,
    newCardId: () => `card_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
  };
}

export function defaultSummaryDeps(): SummaryDeps {
  return {
    store: createPrismaCopilotStore(),
    aiAllowed: (userId) => aiAllowed(userId),
    summarize: async (messages, { brand }) => {
      const [{ llmService, getTaskModel }] = await Promise.all([import('../../platform/llm/index.js')]);
      const brandId = parseBrandId(brand) ?? undefined;
      return llmService.chat(messages, { model: getTaskModel('onboarding', brandId), brand: brandId, task: 'onboarding', maxTokens: 400, temperature: 0.2 });
    },
  };
}

let singleton: CopilotService | null = null;

/** The process-wide Assistant (Prisma store, platform credits, the brand's LLM routing). */
export function getCopilotService(): CopilotService {
  singleton ??= new CopilotService(defaultCopilotDeps());
  return singleton;
}

/** Test seam: replace (or reset with null) the process-wide service. */
export function setCopilotServiceForTests(service: CopilotService | null): void {
  singleton = service;
}

/** WP-78: one visitor turn (public tools only, nothing stored). */
export const handleVisitorTurn = (input: VisitorTurnInput, options: VisitorTurnOptions = { tools: 'public' }): Promise<CopilotEventStream> =>
  getCopilotService().handleVisitorTurn(input, options);

/** WP-74: thumbs up/down with their notes, newest first. */
export const listFeedback = (options?: { cursor?: string; limit?: number }): Promise<{ items: CopilotFeedbackRow[]; cursor: string | null }> =>
  getCopilotService().listFeedback(options);

/** Kept for the FND-5 seam shape: the service object other areas call. */
export const copilotService = {
  handleTurn: (...args: Parameters<CopilotService['handleTurn']>) => getCopilotService().handleTurn(...args),
  handleVisitorTurn,
  listFeedback,
};
