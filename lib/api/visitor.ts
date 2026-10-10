// lib/api/visitor.ts — Visitor surfaces: public feed, visitor assistant, logged-out job alerts.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-78.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/public/feed
//   POST   /api/v1/public/copilot
//   POST   /api/v1/public/alerts
//   GET    /api/v1/public/alerts/confirm
//   POST   /api/v1/public/alerts/confirm
//   POST   /api/v1/public/alerts/unsubscribe

import { call, type CallOptions, type In, postStream, type StreamOptions, withQuery } from './contracts/wire';
import type * as V from './contracts/visitor';
import type * as F from './contracts/feed';
import type * as CP from './contracts/copilot';

/** `feed.public` — GET /api/v1/public/feed */
export function getPublicFeed(query?: In<typeof F.PublicFeedQuerySchema>, opts?: CallOptions): Promise<V.VisitorFeedResponse> {
  return call<V.VisitorFeedResponse>('GET', withQuery(`/api/v1/public/feed`, query), opts);
}

/** `visitor.copilot` — POST /api/v1/public/copilot (SSE) */
export function sendVisitorTurn(body: In<typeof V.VisitorTurnBodySchema>, opts: StreamOptions<CP.CopilotSseEvent>): Promise<void> {
  return postStream<CP.CopilotSseEvent>(`/api/v1/public/copilot`, body, opts);
}

/** `visitor.createAlert` — POST /api/v1/public/alerts */
export function createAnonAlert(body: In<typeof V.CreateAnonAlertBodySchema>, opts?: CallOptions): Promise<V.CreateAnonAlertResponse> {
  return call<V.CreateAnonAlertResponse>('POST', `/api/v1/public/alerts`, { ...opts, body });
}

/** `visitor.confirmAlert` — GET /api/v1/public/alerts/confirm */
export function confirmAnonAlert(query: In<typeof V.AnonAlertTokenQuerySchema>, opts?: CallOptions): Promise<V.AnonAlertView> {
  return call<V.AnonAlertView>('GET', withQuery(`/api/v1/public/alerts/confirm`, query), opts);
}

/** `visitor.confirmAlertSubmit` — POST /api/v1/public/alerts/confirm */
export function submitAnonAlertConfirm(body: In<typeof V.ConfirmAnonAlertBodySchema>, opts?: CallOptions): Promise<V.AnonAlertView> {
  return call<V.AnonAlertView>('POST', `/api/v1/public/alerts/confirm`, { ...opts, body });
}

/** `visitor.unsubscribeAlert` — POST /api/v1/public/alerts/unsubscribe */
export function unsubscribeAnonAlert(body: In<typeof V.AnonAlertUnsubscribeBodySchema>, opts?: CallOptions): Promise<V.AnonAlertUnsubscribeResponse> {
  return call<V.AnonAlertUnsubscribeResponse>('POST', `/api/v1/public/alerts/unsubscribe`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const visitorApi = {
  getPublicFeed,
  sendVisitorTurn,
  createAnonAlert,
  confirmAnonAlert,
  submitAnonAlertConfirm,
  unsubscribeAnonAlert,
};
