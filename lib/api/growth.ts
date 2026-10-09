// lib/api/growth.ts — First-party events, getting-started checklist, invite friends.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-23 (invites: WP-60).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/invites
//   POST   /api/v1/roboapply/invites/email
//   POST   /api/v1/public/events
//   GET    /api/v1/roboapply/growth/checklist          (mount pending, see below)
//   POST   /api/v1/roboapply/growth/checklist/dismiss  (mount pending, see below)
//
// The checklist router (server/src/features/growth/routes.ts
// `createGrowthRouter`) is not in FEATURE_MOUNTS yet: features/index.ts is
// owned by FND/INT, and WP-23 requested the row
//   { id: 'growth', area: 'growth', path: s('/growth'), kind: 'seeker', owner: 'WP-23', build: createGrowthRouter }.
// Until it lands the two calls below answer 404 and the checklist card
// renders nothing. INT: when adding the row, switch their doc comments to
// the standard "`id` — METHOD /path" form so __tests__/contracts/fixtures
// verifies them against the mount table.

import { API_BASE } from '../config';
import { devBrandHeader } from './client';
import { apiUrl, call, type CallOptions, type In } from './contracts/wire';
import type * as G from './contracts/growth';

export const EVENTS_PATH = '/api/v1/public/events';

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
  return call<G.EventsBatchResponse>('POST', EVENTS_PATH, { ...opts, body });
}

/**
 * `growth.events` while the page is being hidden or closed: a `keepalive`
 * fetch (survives unload, allows the CORS preflight a cross-origin API host
 * needs, unlike `sendBeacon` with JSON). Fire and forget; returns false when
 * the browser cannot send it.
 */
export function sendEventsBeacon(body: In<typeof G.EventsBatchBodySchema>): boolean {
  if (typeof fetch !== 'function') return false;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const devBrand = devBrandHeader();
  if (devBrand) headers['X-RA-Brand'] = devBrand;
  try {
    void fetch(apiUrl(EVENTS_PATH), {
      method: 'POST',
      keepalive: true,
      credentials: API_BASE ? 'include' : 'same-origin',
      headers,
      body: JSON.stringify(body),
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** growth.checklist: GET /api/v1/roboapply/growth/checklist (mount pending, WP-23 request to INT) */
export function getChecklist(opts?: CallOptions): Promise<G.ChecklistView> {
  return call<G.ChecklistView>('GET', `/api/v1/roboapply/growth/checklist`, opts);
}

/** growth.checklist.dismiss: POST /api/v1/roboapply/growth/checklist/dismiss (mount pending, WP-23 request to INT) */
export function dismissChecklist(opts?: CallOptions): Promise<G.ChecklistView> {
  return call<G.ChecklistView>('POST', `/api/v1/roboapply/growth/checklist/dismiss`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const growthApi = {
  getInvites,
  sendInviteEmail,
  sendEvents,
  sendEventsBeacon,
  getChecklist,
  dismissChecklist,
};
