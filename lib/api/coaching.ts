// lib/api/coaching.ts — Coaching roster and booking requests (user + admin).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-72.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/coaching/coaches
//   GET    /api/v1/roboapply/coaching/coaches/:id
//   POST   /api/v1/roboapply/coaching/coaches/:id/request
//   GET    /api/v1/roboapply/admin/coaching/coaches
//   POST   /api/v1/roboapply/admin/coaching/coaches
//   PATCH  /api/v1/roboapply/admin/coaching/coaches/:id
//   DELETE /api/v1/roboapply/admin/coaching/coaches/:id

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as CO from './contracts/coaching';

/** `coaching.list` — GET /api/v1/roboapply/coaching/coaches */
export function listCoaches(query?: In<typeof CO.ListCoachesQuerySchema>, opts?: CallOptions): Promise<Items<CO.CoachView>> {
  return call<Items<CO.CoachView>>('GET', withQuery(`/api/v1/roboapply/coaching/coaches`, query), opts);
}

/** `coaching.get` — GET /api/v1/roboapply/coaching/coaches/:id */
export function getCoach(id: string, opts?: CallOptions): Promise<CO.CoachView> {
  return call<CO.CoachView>('GET', `/api/v1/roboapply/coaching/coaches/${seg(id)}`, opts);
}

/** `coaching.request` — POST /api/v1/roboapply/coaching/coaches/:id/request */
export function requestCoach(id: string, body: In<typeof CO.CoachRequestBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/coaching/coaches/${seg(id)}/request`, { ...opts, body });
}

/** `coaching.admin.list` — GET /api/v1/roboapply/admin/coaching/coaches */
export function adminListCoaches(query?: In<typeof CO.AdminCoachesQuerySchema>, opts?: CallOptions): Promise<Items<CO.CoachView>> {
  return call<Items<CO.CoachView>>('GET', withQuery(`/api/v1/roboapply/admin/coaching/coaches`, query), opts);
}

/** `coaching.admin.create` — POST /api/v1/roboapply/admin/coaching/coaches */
export function adminCreateCoach(body: In<typeof CO.CoachBodySchema>, opts?: CallOptions): Promise<CO.CoachView> {
  return call<CO.CoachView>('POST', `/api/v1/roboapply/admin/coaching/coaches`, { ...opts, body });
}

/** `coaching.admin.update` — PATCH /api/v1/roboapply/admin/coaching/coaches/:id */
export function adminUpdateCoach(id: string, body: In<typeof CO.PatchCoachBodySchema> = {}, opts?: CallOptions): Promise<CO.CoachView> {
  return call<CO.CoachView>('PATCH', `/api/v1/roboapply/admin/coaching/coaches/${seg(id)}`, { ...opts, body });
}

/** `coaching.admin.delete` — DELETE /api/v1/roboapply/admin/coaching/coaches/:id */
export function adminDeleteCoach(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/admin/coaching/coaches/${seg(id)}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const coachingApi = {
  listCoaches,
  getCoach,
  requestCoach,
  adminListCoaches,
  adminCreateCoach,
  adminUpdateCoach,
  adminDeleteCoach,
};
