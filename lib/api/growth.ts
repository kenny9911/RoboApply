// lib/api/growth.ts — First-party events, getting-started checklist, invite friends.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-23 (invites: WP-60).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/invites
//   POST   /api/v1/roboapply/invites/shared
//   POST   /api/v1/public/events
//   GET    /api/v1/roboapply/growth/checklist
//   POST   /api/v1/roboapply/growth/checklist/dismiss
//   GET    /api/v1/roboapply/admin/growth/referrals/held         (admin)
//   POST   /api/v1/roboapply/admin/growth/referrals/:id/review   (admin)
//
// There is no "email my friends" call: people share their invite link
// themselves (copy, the device share sheet, their own mail app, WeChat), so
// nothing is sent to someone who never asked for it (WP-60).
//
// The admin review router (`createInvitesAdminRouter`) is mounted as
// `growth.referrals.admin` at /api/v1/roboapply/admin/growth/referrals
// (Wave 5 gate).

import { API_BASE } from '../config';
import { devBrandHeader } from './client';
import { apiUrl, call, type CallOptions, type In } from './contracts/wire';
import type * as G from './contracts/growth';

export const EVENTS_PATH = '/api/v1/public/events';

/** `invites.get` — GET /api/v1/roboapply/invites */
export function getInvites(opts?: CallOptions): Promise<G.InvitesResponse> {
  return call<G.InvitesResponse>('GET', `/api/v1/roboapply/invites`, opts);
}

/** `invites.shared` — POST /api/v1/roboapply/invites/shared */
export function markInviteShared(body: In<typeof G.InviteSharedBodySchema>, opts?: CallOptions): Promise<G.InviteSharedResponse> {
  return call<G.InviteSharedResponse>('POST', `/api/v1/roboapply/invites/shared`, { ...opts, body });
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

/** `growth.checklist` — GET /api/v1/roboapply/growth/checklist */
export function getChecklist(opts?: CallOptions): Promise<G.ChecklistView> {
  return call<G.ChecklistView>('GET', `/api/v1/roboapply/growth/checklist`, opts);
}

/** `growth.checklist.dismiss` — POST /api/v1/roboapply/growth/checklist/dismiss */
export function dismissChecklist(opts?: CallOptions): Promise<G.ChecklistView> {
  return call<G.ChecklistView>('POST', `/api/v1/roboapply/growth/checklist/dismiss`, opts);
}

// Admin review of held invite rewards.

/** `growth.referrals.admin.held` — GET /api/v1/roboapply/admin/growth/referrals/held */
export function listHeldReferrals(opts?: CallOptions): Promise<G.HeldReferralsResponse> {
  return call<G.HeldReferralsResponse>('GET', `/api/v1/roboapply/admin/growth/referrals/held`, opts);
}

/** `growth.referrals.admin.review` — POST /api/v1/roboapply/admin/growth/referrals/:id/review */
export function reviewReferral(id: string, body: In<typeof G.ReferralReviewBodySchema>, opts?: CallOptions): Promise<G.ReferralReviewResponse> {
  return call<G.ReferralReviewResponse>('POST', `/api/v1/roboapply/admin/growth/referrals/${encodeURIComponent(id)}/review`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const growthApi = {
  getInvites,
  markInviteShared,
  listHeldReferrals,
  reviewReferral,
  sendEvents,
  sendEventsBeacon,
  getChecklist,
  dismissChecklist,
};
