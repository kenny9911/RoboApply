// lib/api/agent.ts — Ready to apply: settings, setup, weekly list, kits, answer bank.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-53 (API: WP-52).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/agent/settings
//   PUT    /api/v1/roboapply/agent/settings
//   GET    /api/v1/roboapply/agent/setup
//   POST   /api/v1/roboapply/agent/setup/calibration
//   GET    /api/v1/roboapply/agent/suggestions
//   GET    /api/v1/roboapply/agent/queue
//   POST   /api/v1/roboapply/agent/queue
//   POST   /api/v1/roboapply/agent/queue/:id/prepare
//   POST   /api/v1/roboapply/agent/queue/:id/confirm
//   POST   /api/v1/roboapply/agent/queue/:id/open
//   POST   /api/v1/roboapply/agent/queue/:id/undo-applied
//   POST   /api/v1/roboapply/agent/queue/:id/applied
//   POST   /api/v1/roboapply/agent/queue/:id/skip
//   DELETE /api/v1/roboapply/agent/queue/:id
//   GET    /api/v1/roboapply/agent/answers
//   PUT    /api/v1/roboapply/agent/answers

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as A from './contracts/agent';
import type * as F from './contracts/feed';

/** `agent.getSettings` — GET /api/v1/roboapply/agent/settings */
export function getAgentSettings(opts?: CallOptions): Promise<A.AgentSettings> {
  return call<A.AgentSettings>('GET', `/api/v1/roboapply/agent/settings`, opts);
}

/** `agent.putSettings` — PUT /api/v1/roboapply/agent/settings */
export function putAgentSettings(body: In<typeof A.PutAgentSettingsBodySchema> = {}, opts?: CallOptions): Promise<A.AgentSettings> {
  return call<A.AgentSettings>('PUT', `/api/v1/roboapply/agent/settings`, { ...opts, body });
}

/** `agent.setup` — GET /api/v1/roboapply/agent/setup */
export function getAgentSetup(opts?: CallOptions): Promise<A.AgentSetupResponse> {
  return call<A.AgentSetupResponse>('GET', `/api/v1/roboapply/agent/setup`, opts);
}

/** `agent.calibration` — POST /api/v1/roboapply/agent/setup/calibration */
export function submitCalibration(body: In<typeof A.CalibrationBodySchema>, opts?: CallOptions): Promise<A.AgentSetupResponse> {
  return call<A.AgentSetupResponse>('POST', `/api/v1/roboapply/agent/setup/calibration`, { ...opts, body });
}

/** `agent.suggestions` — GET /api/v1/roboapply/agent/suggestions */
export function getSuggestions(opts?: CallOptions): Promise<Items<F.FeedItem>> {
  return call<Items<F.FeedItem>>('GET', `/api/v1/roboapply/agent/suggestions`, opts);
}

/** `agent.listQueue` — GET /api/v1/roboapply/agent/queue */
export function listQueue(query?: In<typeof A.QueueListQuerySchema>, opts?: CallOptions): Promise<Items<A.QueueItemView>> {
  return call<Items<A.QueueItemView>>('GET', withQuery(`/api/v1/roboapply/agent/queue`, query), opts);
}

/** `agent.addToQueue` — POST /api/v1/roboapply/agent/queue */
export function addToQueue(body: In<typeof A.AddToQueueBodySchema>, opts?: CallOptions): Promise<Items<A.QueueItemView>> {
  return call<Items<A.QueueItemView>>('POST', `/api/v1/roboapply/agent/queue`, { ...opts, body });
}

/** `agent.prepare` — POST /api/v1/roboapply/agent/queue/:id/prepare */
export function prepareKit(id: string, body: In<typeof A.PrepareBodySchema> = {}, opts?: CallOptions): Promise<A.PrepareProposal> {
  return call<A.PrepareProposal>('POST', `/api/v1/roboapply/agent/queue/${seg(id)}/prepare`, { ...opts, body });
}

/** `agent.confirm` — POST /api/v1/roboapply/agent/queue/:id/confirm */
export function confirmKitPart(id: string, body: In<typeof A.ConfirmPartBodySchema>, opts?: CallOptions): Promise<A.QueueItemView> {
  return call<A.QueueItemView>('POST', `/api/v1/roboapply/agent/queue/${seg(id)}/confirm`, { ...opts, body });
}

/** `agent.open` — POST /api/v1/roboapply/agent/queue/:id/open */
export function openApplication(id: string, opts?: CallOptions): Promise<A.OpenApplicationResponse> {
  return call<A.OpenApplicationResponse>('POST', `/api/v1/roboapply/agent/queue/${seg(id)}/open`, opts);
}

/** `agent.undoApplied` — POST /api/v1/roboapply/agent/queue/:id/undo-applied */
export function undoQueueApplied(id: string, opts?: CallOptions): Promise<A.QueueItemView> {
  return call<A.QueueItemView>('POST', `/api/v1/roboapply/agent/queue/${seg(id)}/undo-applied`, opts);
}

/** `agent.markApplied` — POST /api/v1/roboapply/agent/queue/:id/applied */
export function markQueueApplied(id: string, opts?: CallOptions): Promise<A.QueueItemView> {
  return call<A.QueueItemView>('POST', `/api/v1/roboapply/agent/queue/${seg(id)}/applied`, opts);
}

/** `agent.skip` — POST /api/v1/roboapply/agent/queue/:id/skip */
export function skipQueueItem(id: string, opts?: CallOptions): Promise<A.QueueItemView> {
  return call<A.QueueItemView>('POST', `/api/v1/roboapply/agent/queue/${seg(id)}/skip`, opts);
}

/** `agent.remove` — DELETE /api/v1/roboapply/agent/queue/:id */
export function removeQueueItem(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/agent/queue/${seg(id)}`, opts);
}

/** `agent.getAnswers` — GET /api/v1/roboapply/agent/answers */
export function getAnswerBank(opts?: CallOptions): Promise<Items<A.AnswerBankItemView>> {
  return call<Items<A.AnswerBankItemView>>('GET', `/api/v1/roboapply/agent/answers`, opts);
}

/** `agent.putAnswers` — PUT /api/v1/roboapply/agent/answers */
export function putAnswerBank(body: In<typeof A.PutAnswersBodySchema>, opts?: CallOptions): Promise<Items<A.AnswerBankItemView>> {
  return call<Items<A.AnswerBankItemView>>('PUT', `/api/v1/roboapply/agent/answers`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const agentApi = {
  getAgentSettings,
  putAgentSettings,
  getAgentSetup,
  submitCalibration,
  getSuggestions,
  listQueue,
  addToQueue,
  prepareKit,
  confirmKitPart,
  openApplication,
  undoQueueApplied,
  markQueueApplied,
  skipQueueItem,
  removeQueueItem,
  getAnswerBank,
  putAnswerBank,
};
