// extension/src/shared/messages.ts — every message the extension's parts exchange.
//
//   web page  → service worker   (externally_connectable; brand hosts only)
//       { type:'ping' } · { type:'pair', token, apiOrigin }
//   popup / content → service worker   (chrome.runtime.sendMessage)
//       { type:'status' } · { type:'redeem', code } · { type:'disconnect' } · { type:'api', call }
//   popup / service worker → content script   (chrome.tabs.sendMessage)
//       { type:'content.ping' } · { type:'panel.open' } · { type:'page.read' }
//
// The device token lives only in the service worker's chrome.storage.local;
// content scripts and pages never see it. API calls from the content script
// go through the service worker (`type:'api'`).

import type {
  AnswerQuestionBody,
  AnswerQuestionResponse,
  AutofillProfile,
  BrandIdWire,
  CreateAutofillRunBody,
  CreateAutofillRunResponse,
  ExtMeResponse,
  PageJobBody,
  PageJobResponse,
  PatchAutofillRunBody,
  ResumeForJobBody,
  ResumeForJobResponse,
  SaveAnswerBody,
  SaveAnswerResponse,
  SiteRequestBody,
} from './contract';

export type ApiCall =
  | { op: 'me' }
  | { op: 'autofillProfile' }
  | { op: 'pageJob'; body: PageJobBody }
  | { op: 'saveJob'; body: PageJobBody }
  | { op: 'createRun'; body: CreateAutofillRunBody; idempotencyKey: string }
  | { op: 'patchRun'; id: string; body: PatchAutofillRunBody }
  | { op: 'answer'; body: AnswerQuestionBody; idempotencyKey: string }
  | { op: 'saveAnswer'; body: SaveAnswerBody }
  | { op: 'resumeForJob'; body: ResumeForJobBody }
  | { op: 'fetchFile'; url: string }
  | { op: 'siteRequest'; body: SiteRequestBody };

export interface FetchedFile {
  base64: string;
  contentType: string;
  fileName: string | null;
}

/** Response type per op. */
export interface ApiResults {
  me: ExtMeResponse;
  autofillProfile: AutofillProfile;
  pageJob: PageJobResponse;
  saveJob: unknown;
  createRun: CreateAutofillRunResponse;
  patchRun: unknown;
  answer: AnswerQuestionResponse;
  saveAnswer: SaveAnswerResponse;
  resumeForJob: ResumeForJobResponse;
  fetchFile: FetchedFile;
  siteRequest: unknown;
}

/** `network_error` and `not_connected` are the extension's own codes; the rest are the server's. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number; message?: string; details?: unknown };

export type InternalMessage =
  | { type: 'status' }
  | { type: 'redeem'; code: string }
  | { type: 'disconnect' }
  | { type: 'api'; call: ApiCall };

export interface StatusResponse {
  connected: boolean;
  /** The token was refused (revoked device): show "Reconnect". */
  needsReconnect: boolean;
  brand: BrandIdWire;
  version: string;
  /** The brand's web origin (for "Open %BRAND%" links). */
  webOrigin: string;
}

export type ExternalMessage = { type: 'ping' } | { type: 'pair'; token: string; apiOrigin: string };

export type PingResponse = { ok: true; brand: BrandIdWire; version: string; connected: boolean };
export type PairResponse = { ok: true } | { ok: false; code: 'untrusted_origin' | 'invalid_token' | 'wrong_brand' };

export type ContentMessage = { type: 'content.ping' } | { type: 'panel.open' } | { type: 'page.read' };

export interface ContentPingResponse {
  /** The form site this page's adapter fills, or null. */
  siteName: string | null;
}

export interface PageReadResponse {
  job: PageJobBody | null;
}
