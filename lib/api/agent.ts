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
// WP-52 routes added after the FND contract (still typed by the mirror types
// below; INT swaps them for A.*). Their doc lines were switched to the strict
// "<stub> — METHOD path" form at the Wave 4 gate, so
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

// Query (WP-52): `limit` 1–20, `exclude` = comma-separated job ids.
/** `agent.suggestions` — GET /api/v1/roboapply/agent/suggestions */
export function getSuggestions(query?: SuggestionsQuery, opts?: CallOptions): Promise<Items<F.FeedItem>> {
  return call<Items<F.FeedItem>>('GET', withQuery(`/api/v1/roboapply/agent/suggestions`, query), opts);
}

// WP-52 also sends `weekKey` (this week in the user's time zone) and `counts`
// (per tab, all weeks); both are optional here until its contract merges.
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

// ── WP-52 additions ─────────────────────────────────────────────────────────
//
// Mirrors of the types WP-52 adds to server/src/features/agent/contract.ts
// (same names and shapes). They live here only until that contract merges;
// INT replaces each with the contract's own export.

/** The three tabs of /ready (contract `QUEUE_TABS`). */
export type QueueTab = 'to_prepare' | 'ready' | 'done';

/** GET /agent/queue (contract `QueueListResponse`; the extras are optional until it merges). */
export interface QueueListResult extends Items<A.QueueItemView> {
  /** Items per tab, all weeks. */
  counts?: Record<QueueTab, number>;
  /** This week in the user's time zone, e.g. '2026-W41'. */
  weekKey?: string;
}

/** The job a kit is for, as WP-52 stores it (contract `QueueJobSummary`). */
export interface QueueJobSummary {
  title: string;
  companyName: string;
  location: string | null;
  hasApplyUrl: boolean;
  closed: boolean;
  asksForCoverLetter: boolean;
}

/** GET /agent/badge (contract `ReadyBadgeResponse`). */
export interface ReadyBadgeResponse {
  /** Kits prepared and not opened yet. */
  readyNotOpened: number;
}

/** Query of GET /agent/suggestions. */
export interface SuggestionsQuery {
  limit?: number;
  exclude?: string;
}

/** One row of a kit's history (contract `KitEventView`, F-AGENT-11). */
export interface KitEventView {
  id: string;
  /** `transition` = a state change; `decision` = the user used or revised a part; `notice` = a reminder. */
  kind?: 'transition' | 'decision' | 'notice';
  fromState: A.QueueState | null;
  toState: A.QueueState;
  actor: 'user' | 'system' | 'extension';
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** GET /agent/queue/:id/history */
export interface KitHistoryResponse {
  items: KitEventView[];
}

/** GET /agent/queue/:id — the kit review screen (contract `QueueItemDetail`). */
export interface QueueItemDetail {
  item: A.QueueItemView;
  kit: {
    resume: {
      /** The resume version to send (the tailored one, or the base resume when nothing was tailored). */
      variantId: string | null;
      tailorSessionId: string | null;
      /** "Verify details" claims still open; the kit cannot be approved while > 0. */
      pendingClaims: number;
      tailored: boolean;
      used: boolean;
    };
    letter: { coverLetterId: string | null; needed: boolean; used: boolean };
    answers: A.AnswerBankItemView[];
    /** Suggested resume file name (style from settings), without extension. */
    fileName: string | null;
    /** AI steps are available for this account (consent and a model for the brand). */
    aiAvailable: boolean;
  };
  history: KitEventView[];
}

export type SetupWizardStep = 'profile' | 'calibrate' | 'answers' | 'weekly' | 'extension';

/** Body of POST /agent/setup/step (only "Get the extension" can be skipped). */
export interface SetupStepBody {
  step: SetupWizardStep;
  action?: 'complete' | 'skip';
}

/** Body of POST /agent/list/generate. */
export interface GenerateListBody {
  /** Filter changes made inside Ready to apply (used for this list only; the main search is untouched). */
  overrides?: Record<string, unknown>;
  /** Add another `weeklyTarget` jobs even when this week's list is full. */
  more?: boolean;
}

export interface GenerateListResponse {
  weekKey: string;
  added: number;
  items: A.QueueItemView[];
  /** The list used filters that differ from the main search. */
  filtersDiffer: boolean;
  /** Why nothing (or less than the target) was added. */
  reason: 'no_feed' | 'no_matches' | 'queue_full' | 'target_reached' | null;
}

/** POST /agent/setup/step answer: the setup state, plus the first weekly list when this call finished setup. */
export interface SetupStepResponse extends A.AgentSetupResponse {
  completedAt?: string | null;
  firstList?: GenerateListResponse | null;
}

/** GET /agent/answers/questions — one common question of this brand (contract `QuestionKeyView`). */
export interface QuestionKeyView {
  key: string;
  /** i18n key of the label (`ready.questions.<key>`). */
  labelKey: string;
  /** Default question text per language. */
  text: Record<string, string>;
  optional: boolean;
  /** Never used by AI; filled only from this answer. */
  sensitive: boolean;
  /** An extension protected question type: AI never answers it. */
  protectedType: string | null;
  /** Accepts `<key>:<ISO currency>` variants (salary expectation per currency). */
  perCurrency: boolean;
}

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
