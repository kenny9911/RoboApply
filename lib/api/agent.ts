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
//
// WP-52 routes added after the FND contract (typed by the contract's own
// exports since WP-93; no mirror types remain in this file). Their doc lines
// use the strict "<stub> — METHOD path" form, so
// __tests__/contracts/fixtures.test.ts checks them against the mount table:
//   POST   /api/v1/roboapply/agent/setup/step
//   POST   /api/v1/roboapply/agent/list/generate
//   GET    /api/v1/roboapply/agent/queue/:id
//   GET    /api/v1/roboapply/agent/queue/:id/history
//   GET    /api/v1/roboapply/agent/answers/questions
//   GET    /api/v1/roboapply/agent/badge
//   POST   /api/v1/roboapply/agent/queue/:id/restore

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as A from './contracts/agent';
import type * as F from './contracts/feed';

/** `agent.getSettings` — GET /api/v1/roboapply/agent/settings */
export function getAgentSettings(opts?: CallOptions): Promise<A.AgentSettingsResponse> {
  return call<A.AgentSettingsResponse>('GET', `/api/v1/roboapply/agent/settings`, opts);
}

/** `agent.putSettings` — PUT /api/v1/roboapply/agent/settings */
export function putAgentSettings(body: In<typeof A.PutAgentSettingsBodySchema> = {}, opts?: CallOptions): Promise<A.AgentSettingsResponse> {
  return call<A.AgentSettingsResponse>('PUT', `/api/v1/roboapply/agent/settings`, { ...opts, body });
}

/** `agent.setup` — GET /api/v1/roboapply/agent/setup */
export function getAgentSetup(opts?: CallOptions): Promise<A.AgentSetupResponse> {
  return call<A.AgentSetupResponse>('GET', `/api/v1/roboapply/agent/setup`, opts);
}

/** `agent.calibration` — POST /api/v1/roboapply/agent/setup/calibration */
export function submitCalibration(body: In<typeof A.CalibrationBodySchema>, opts?: CallOptions): Promise<A.AgentSetupResponse> {
  return call<A.AgentSetupResponse>('POST', `/api/v1/roboapply/agent/setup/calibration`, { ...opts, body });
}

// Query (WP-52): `limit` 1–20, `exclude` = comma-separated job ids.
/** `agent.suggestions` — GET /api/v1/roboapply/agent/suggestions */
export function getSuggestions(query?: SuggestionsQuery, opts?: CallOptions): Promise<Items<F.FeedItem>> {
  return call<Items<F.FeedItem>>('GET', withQuery(`/api/v1/roboapply/agent/suggestions`, query), opts);
}

// Query: `tab` / `state` / `weekKey`, plus `cursor` (the previous page's
// `nextCursor`) and `limit` (default and max 200).
/** `agent.listQueue` — GET /api/v1/roboapply/agent/queue */
export function listQueue(query?: In<typeof A.QueueListQuerySchema>, opts?: CallOptions): Promise<QueueListResult> {
  return call<QueueListResult>('GET', withQuery(`/api/v1/roboapply/agent/queue`, query), opts);
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

// ── Types of the WP-52 routes ───────────────────────────────────────────────
//
// Every name below is the contract's own export (server/src/features/agent/
// contract.ts through lib/api/contracts/agent.ts): there are no local mirror
// shapes in this file. The aliases keep the names this area's hooks and
// components already import.

/** The three tabs of /ready (contract `QUEUE_TABS`). */
export type QueueTab = A.QueueTab;

/** GET /agent/queue (contract `QueueListResponse`): the page, counts per tab, this week's key and the next cursor. */
export type QueueListResult = A.QueueListResponse;

/** The job a kit is for (contract `QueueJobSummary`; `fit` only when the server knows it). */
export type QueueJobSummary = A.QueueJobSummary;

/** GET /agent/badge (contract `ReadyBadgeResponse`). */
export type ReadyBadgeResponse = A.ReadyBadgeResponse;

/** Query of GET /agent/suggestions (contract `SuggestionsQuerySchema`). */
export type SuggestionsQuery = In<typeof A.SuggestionsQuerySchema>;

/** One row of a kit's history (contract `KitEventView`, F-AGENT-11). */
export type KitEventView = A.KitEventView;

/** GET /agent/queue/:id/history */
export type KitHistoryResponse = A.KitHistoryResponse;

/** GET /agent/queue/:id — the kit review screen (contract `QueueItemDetail`, incl. `kit.revisionCost`). */
export type QueueItemDetail = A.QueueItemDetail;

/** Body of POST /agent/setup/step (only "Get the extension" can be skipped). */
export type SetupStepBody = In<typeof A.SetupStepBodySchema>;
export type SetupWizardStep = SetupStepBody['step'];

/** Body of POST /agent/list/generate (`overrides` are kept for Ready to apply's later lists). */
export type GenerateListBody = In<typeof A.GenerateListBodySchema>;
export type GenerateListResponse = A.GenerateListResponse;

/** POST /agent/setup/step answer: the setup state, plus the first weekly list when this call finished setup. */
export type SetupStepResponse = A.SetupStepResponse;

/** GET /agent/answers/questions — one common question of this brand (contract `QuestionKeyView`). */
export type QuestionKeyView = A.QuestionKeyView;

/** GET / PUT /agent/settings: the weekly choices plus which search the lists come from. */
export type AgentSettingsResponse = A.AgentSettingsResponse;

/** `agent.completeStep` — POST /api/v1/roboapply/agent/setup/step */
export function completeSetupStep(body: SetupStepBody, opts?: CallOptions): Promise<SetupStepResponse> {
  return call<SetupStepResponse>('POST', `/api/v1/roboapply/agent/setup/step`, { ...opts, body });
}

/** `agent.generateList` — POST /api/v1/roboapply/agent/list/generate */
export function generateList(body: GenerateListBody = {}, opts?: CallOptions): Promise<GenerateListResponse> {
  return call<GenerateListResponse>('POST', `/api/v1/roboapply/agent/list/generate`, { ...opts, body });
}

/** `agent.detail` — GET /api/v1/roboapply/agent/queue/:id */
export function getKitDetail(id: string, opts?: CallOptions): Promise<QueueItemDetail> {
  return call<QueueItemDetail>('GET', `/api/v1/roboapply/agent/queue/${seg(id)}`, opts);
}

/** `agent.history` — GET /api/v1/roboapply/agent/queue/:id/history */
export function getKitHistory(id: string, opts?: CallOptions): Promise<KitHistoryResponse> {
  return call<KitHistoryResponse>('GET', `/api/v1/roboapply/agent/queue/${seg(id)}/history`, opts);
}

/** `agent.questions` — GET /api/v1/roboapply/agent/answers/questions */
export function getQuestionKeys(opts?: CallOptions): Promise<Items<QuestionKeyView>> {
  return call<Items<QuestionKeyView>>('GET', `/api/v1/roboapply/agent/answers/questions`, opts);
}

// The nav badge (one count query).
/** `agent.badge` — GET /api/v1/roboapply/agent/badge */
export function getReadyBadge(opts?: CallOptions): Promise<ReadyBadgeResponse> {
  return call<ReadyBadgeResponse>('GET', `/api/v1/roboapply/agent/badge`, opts);
}

// Skipped → back on the list.
/** `agent.restore` — POST /api/v1/roboapply/agent/queue/:id/restore */
export function restoreQueueItem(id: string, opts?: CallOptions): Promise<A.QueueItemView> {
  return call<A.QueueItemView>('POST', `/api/v1/roboapply/agent/queue/${seg(id)}/restore`, opts);
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
  completeSetupStep,
  generateList,
  getKitDetail,
  getKitHistory,
  getQuestionKeys,
  getReadyBadge,
  restoreQueueItem,
};
