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

import { call, type CallOptions, type In, type Items, postStream, seg, type StreamOptions, withQuery } from './contracts/wire';
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

/** Every wrapper of this area, for callers that prefer one import. */
export const copilotApi = {
  listThreads,
  createThread,
  listMessages,
  sendMessage,
  archiveThread,
  applyProposal,
  dismissProposal,
  sendMessageFeedback,
  listMemory,
  deleteMemory,
};
