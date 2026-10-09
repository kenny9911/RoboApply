// lib/api/growth.ts — First-party events and invite friends.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-23 (invites: WP-60).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/invites
//   POST   /api/v1/roboapply/invites/email
//   POST   /api/v1/public/events

import { call, type CallOptions, type In } from './contracts/wire';
import type * as G from './contracts/growth';

/** `invites.get` — GET /api/v1/roboapply/invites */
export function getInvites(opts?: CallOptions): Promise<G.InvitesResponse> {
  return call<G.InvitesResponse>('GET', `/api/v1/roboapply/invites`, opts);
}

/** `invites.email` — POST /api/v1/roboapply/invites/email */
export function sendInviteEmail(body: In<typeof G.InviteEmailBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/invites/email`, { ...opts, body });
}

/** `growth.events` — POST /api/v1/public/events */
export function sendEvents(body: In<typeof G.EventsBatchBodySchema>, opts?: CallOptions): Promise<G.EventsBatchResponse> {
  return call<G.EventsBatchResponse>('POST', `/api/v1/public/events`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const growthApi = {
  getInvites,
  sendInviteEmail,
  sendEvents,
};
