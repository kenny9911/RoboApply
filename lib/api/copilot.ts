// lib/api/copilot.ts — Assistant: threads, streaming turns, proposals, feedback, memory.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-51 (API: WP-50).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/copilot/threads
//   POST   /api/v1/roboapply/copilot/threads
//   GET    /api/v1/roboapply/copilot/threads/:id/messages
//   POST   /api/v1/roboapply/copilot/threads/:id/messages
//   DELETE /api/v1/roboapply/copilot/threads/:id
//   POST   /api/v1/roboapply/copilot/proposals/:id/apply
//   POST   /api/v1/roboapply/copilot/proposals/:id/dismiss
//   POST   /api/v1/roboapply/copilot/messages/:id/feedback
//   GET    /api/v1/roboapply/copilot/memory
//   DELETE /api/v1/roboapply/copilot/memory/:id
//   GET    /api/v1/roboapply/copilot/nudge
//
// `streamTurn()` (WP-51; ARCHITECTURE.md §5.7) is the SSE-over-fetch reader the
// Assistant UI uses for a turn: it reads `text/event-stream` with fetch (an
// EventSource cannot POST), skips heartbeat comments, survives events split
// across network chunks (including a multi-byte character cut in half), drops
// events that do not have the contract's shape, and resolves with how the turn
// ended — `done`, `error` (the server's `error` event) or `aborted` (Stop).
// `done.content` is the final reply after the server's guard (what was
// stored): the conversation replaces the streamed text with it. A turn whose
// reply could not be saved ends with error `save_failed` and no `done`; the
// user was not charged and may try again.
// A non-2xx answer before the stream starts (402 credits_exhausted, 503
// ai_unavailable, 404 feature_disabled) rejects with `RoboApiError`.

import { call, type CallOptions, type In, type Items, postStream, seg, type SseEvent, type StreamOptions, withQuery } from './contracts/wire';
import type * as CP from './contracts/copilot';

/** `copilot.listThreads` — GET /api/v1/roboapply/copilot/threads */
export function listThreads(opts?: CallOptions): Promise<Items<CP.ThreadView>> {
  return call<Items<CP.ThreadView>>('GET', `/api/v1/roboapply/copilot/threads`, opts);
}

/** `copilot.createThread` — POST /api/v1/roboapply/copilot/threads */
export function createThread(body: In<typeof CP.CreateThreadBodySchema> = {}, opts?: CallOptions): Promise<CP.ThreadView> {
  return call<CP.ThreadView>('POST', `/api/v1/roboapply/copilot/threads`, { ...opts, body });
}

/** `copilot.listMessages` — GET /api/v1/roboapply/copilot/threads/:id/messages */
export function listMessages(id: string, query?: In<typeof CP.MessagesQuerySchema>, opts?: CallOptions): Promise<Items<CP.MessageView>> {
  return call<Items<CP.MessageView>>('GET', withQuery(`/api/v1/roboapply/copilot/threads/${seg(id)}/messages`, query), opts);
}

/** `copilot.sendMessage` — POST /api/v1/roboapply/copilot/threads/:id/messages (SSE) */
export function sendMessage(id: string, body: In<typeof CP.SendMessageBodySchema>, opts: StreamOptions<CP.CopilotSseEvent>): Promise<void> {
  return postStream<CP.CopilotSseEvent>(`/api/v1/roboapply/copilot/threads/${seg(id)}/messages`, body, opts);
}

/** `copilot.archiveThread` — DELETE /api/v1/roboapply/copilot/threads/:id */
export function archiveThread(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/copilot/threads/${seg(id)}`, opts);
}

/** `copilot.applyProposal` — POST /api/v1/roboapply/copilot/proposals/:id/apply */
export function applyProposal(id: string, body: In<typeof CP.ApplyProposalBodySchema> = {}, opts?: CallOptions): Promise<CP.ApplyProposalResponse> {
  return call<CP.ApplyProposalResponse>('POST', `/api/v1/roboapply/copilot/proposals/${seg(id)}/apply`, { ...opts, body });
}

/** `copilot.dismissProposal` — POST /api/v1/roboapply/copilot/proposals/:id/dismiss */
export function dismissProposal(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/copilot/proposals/${seg(id)}/dismiss`, opts);
}

/** `copilot.feedback` — POST /api/v1/roboapply/copilot/messages/:id/feedback */
export function sendMessageFeedback(id: string, body: In<typeof CP.MessageFeedbackBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/copilot/messages/${seg(id)}/feedback`, { ...opts, body });
}

/** `copilot.listMemory` — GET /api/v1/roboapply/copilot/memory */
export function listMemory(opts?: CallOptions): Promise<Items<CP.MemoryFactView>> {
  return call<Items<CP.MemoryFactView>>('GET', `/api/v1/roboapply/copilot/memory`, opts);
}

/** `copilot.deleteMemory` — DELETE /api/v1/roboapply/copilot/memory/:id */
export function deleteMemory(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/copilot/memory/${seg(id)}`, opts);
}

/**
 * `copilot.nudge` — GET /api/v1/roboapply/copilot/nudge. At most one nudge,
 * decided by the server from real signals (a low feed rating, a reported job
 * while agency posts show, no minimum pay while many posts list pay, a
 * followed GoApply deadline). Use `nudge.kind` only: `nudge.prompt` is debug
 * English and is never shown or sent (the chip and the composer text come
 * from `assistant.nudge.<kind>` / `assistant.nudge.prompts.<kind>`).
 */
export function getNudge(opts?: CallOptions): Promise<CP.NudgeResponse> {
  return call<CP.NudgeResponse>('GET', `/api/v1/roboapply/copilot/nudge`, opts);
}

// ─── streamTurn ──────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Narrow one raw SSE event to the contract's `CopilotSseEvent`, or null when
 * its name or shape is not one the contract defines (the client then ignores
 * it, so the server can add events ahead of the UI). Pure.
 */
export function toCopilotEvent(raw: SseEvent): CP.CopilotSseEvent | null {
  const d = raw.data;
  if (!isObj(d)) return null;
  switch (raw.event) {
    case 'meta':
      return isStr(d.threadId) && isStr(d.messageId) ? { event: 'meta', data: { threadId: d.threadId, messageId: d.messageId } } : null;
    case 'delta':
      return isStr(d.text) ? { event: 'delta', data: { text: d.text } } : null;
    case 'tool':
      if (!isStr(d.id) || !isStr(d.name) || (d.phase !== 'start' && d.phase !== 'end')) return null;
      return { event: 'tool', data: { id: d.id, name: d.name, phase: d.phase, ...(typeof d.ok === 'boolean' ? { ok: d.ok } : {}) } };
    case 'card':
      return isStr(d.type) && isStr(d.id) ? { event: 'card', data: d as unknown as CP.CopilotCard } : null;
    case 'error':
      return {
        event: 'error',
        data: {
          code: isStr(d.code) ? d.code : 'stream_error',
          message: isStr(d.message) ? d.message : '',
          retryable: d.retryable === true,
        },
      };
    case 'done': {
      if (!isStr(d.messageId)) return null;
      const u = isObj(d.usage) ? d.usage : {};
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const left = typeof d.creditsRemaining === 'number' && Number.isFinite(d.creditsRemaining) ? d.creditsRemaining : null;
      return {
        event: 'done',
        data: {
          messageId: d.messageId,
          usage: { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens) },
          creditsRemaining: left,
          // The final reply after the guard. An empty string is a real answer (cards only).
          ...(isStr(d.content) ? { content: d.content } : {}),
          ...(typeof d.guarded === 'boolean' ? { guarded: d.guarded } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/** How a streamed turn ended. */
export type TurnOutcome =
  | { status: 'done'; messageId: string; creditsRemaining: number | null; content?: string }
  | { status: 'error'; code: string; message: string; retryable: boolean }
  | { status: 'aborted' }
  /** The stream closed without `done` or `error` (a dropped connection). */
  | { status: 'incomplete' };

export interface StreamTurnOptions extends CallOptions {
  onEvent: (event: CP.CopilotSseEvent) => void;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/**
 * Send one user turn and stream the answer (`POST /copilot/threads/:id/messages`).
 * Every valid event goes to `onEvent` in order; the promise resolves with the
 * outcome. Rejects only for an HTTP error before streaming (`RoboApiError`).
 */
export async function streamTurn(
  threadId: string,
  body: In<typeof CP.SendMessageBodySchema>,
  { onEvent, ...opts }: StreamTurnOptions,
): Promise<TurnOutcome> {
  // A holder, not a `let`: the callback assigns it and TypeScript would
  // otherwise narrow a closure-assigned local to `null` after the await.
  const end: { outcome: TurnOutcome | null } = { outcome: null };
  const handle = (raw: SseEvent) => {
    if (end.outcome) return; // nothing after done/error
    const ev = toCopilotEvent(raw);
    if (!ev) return;
    onEvent(ev);
    if (ev.event === 'done') {
      end.outcome = { status: 'done', messageId: ev.data.messageId, creditsRemaining: ev.data.creditsRemaining, ...(ev.data.content !== undefined ? { content: ev.data.content } : {}) };
    }
    else if (ev.event === 'error') end.outcome = { status: 'error', code: ev.data.code, message: ev.data.message, retryable: ev.data.retryable };
  };
  try {
    await postStream<SseEvent>(`/api/v1/roboapply/copilot/threads/${seg(threadId)}/messages`, body, { ...opts, onEvent: handle });
  } catch (err) {
    if (end.outcome) return end.outcome;
    if (isAbort(err, opts.signal)) return { status: 'aborted' };
    // A network failure before any byte arrived is a RoboApiError('network_error');
    // after the stream started, the read failed mid-way.
    if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'RoboApiError') throw err;
    return { status: 'error', code: 'stream_interrupted', message: '', retryable: true };
  }
  if (end.outcome) return end.outcome;
  return opts.signal?.aborted ? { status: 'aborted' } : { status: 'incomplete' };
}

/** Every wrapper of this area, for callers that prefer one import. */
export const copilotApi = {
  listThreads,
  createThread,
  listMessages,
  sendMessage,
  streamTurn,
  archiveThread,
  applyProposal,
  dismissProposal,
  sendMessageFeedback,
  listMemory,
  deleteMemory,
  getNudge,
};
