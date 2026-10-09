// server/src/features/copilot/index.ts — public surface of the Assistant (FND-5; owner WP-50).
//
// Seams:
//   - handleVisitorTurn(input, { tools: 'public' }) — WP-78's visitor
//     assistant; page-scoped public tools only, no persistence.
//   - listFeedback() — WP-74's admin feedback queue.
// Both throw NotImplementedError until WP-50 fills them; callers must handle it.

import { NotImplementedError } from '../../platform/http.js';
import type { CopilotFeedbackRow, CopilotSseEvent, VisitorTurnInput } from './contract.js';

export * from './contract.js';
export { createCopilotRouter } from './routes.js';
export { COPILOT_WORK_KINDS } from './workers.js';

export interface VisitorTurnOptions {
  /** Only the page-scoped public tools (search_jobs public, salary_context, explain_feature). */
  tools: 'public';
  /** Aborts the model call when the client disconnects. */
  signal?: AbortSignal;
}

/** One turn's events, in order; the route writes each as an SSE event. */
export type CopilotEventStream = AsyncIterable<CopilotSseEvent>;

export interface CopilotService {
  handleTurn(
    userId: string,
    threadId: string,
    input: { text: string; chip?: string; contextJobId?: string },
    options?: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<CopilotEventStream>;
  handleVisitorTurn(input: VisitorTurnInput, options: VisitorTurnOptions): Promise<CopilotEventStream>;
  listFeedback(options?: { cursor?: string; limit?: number }): Promise<{ items: CopilotFeedbackRow[]; cursor: string | null }>;
}

export const copilotService: CopilotService = {
  async handleTurn() {
    throw new NotImplementedError('copilot.handleTurn');
  },
  async handleVisitorTurn() {
    throw new NotImplementedError('copilot.handleVisitorTurn');
  },
  async listFeedback() {
    throw new NotImplementedError('copilot.listFeedback');
  },
};

export const handleVisitorTurn = (input: VisitorTurnInput, options: VisitorTurnOptions = { tools: 'public' }) =>
  copilotService.handleVisitorTurn(input, options);
export const listFeedback = (options?: { cursor?: string; limit?: number }) => copilotService.listFeedback(options);
