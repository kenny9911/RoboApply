// lib/api/announcements.ts — "What's new" announcements (user + admin).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-61.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/announcements/next
//   POST   /api/v1/roboapply/announcements/:id/seen
//   GET    /api/v1/roboapply/admin/announcements
//   POST   /api/v1/roboapply/admin/announcements
//   PATCH  /api/v1/roboapply/admin/announcements/:id
//   DELETE /api/v1/roboapply/admin/announcements/:id

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as AN from './contracts/announcements';

/** `announcements.next` — GET /api/v1/roboapply/announcements/next */
export function getNextAnnouncement(opts?: CallOptions): Promise<AN.NextAnnouncementResponse> {
  return call<AN.NextAnnouncementResponse>('GET', `/api/v1/roboapply/announcements/next`, opts);
}

/** `announcements.seen` — POST /api/v1/roboapply/announcements/:id/seen */
export function markAnnouncementSeen(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/announcements/${seg(id)}/seen`, opts);
}

/** `announcements.admin.list` — GET /api/v1/roboapply/admin/announcements */
export function adminListAnnouncements(query?: In<typeof AN.AdminAnnouncementsQuerySchema>, opts?: CallOptions): Promise<Items<AN.AnnouncementView>> {
  return call<Items<AN.AnnouncementView>>('GET', withQuery(`/api/v1/roboapply/admin/announcements`, query), opts);
}

/** `announcements.admin.create` — POST /api/v1/roboapply/admin/announcements */
export function adminCreateAnnouncement(body: In<typeof AN.UpsertAnnouncementBodySchema>, opts?: CallOptions): Promise<AN.AnnouncementView> {
  return call<AN.AnnouncementView>('POST', `/api/v1/roboapply/admin/announcements`, { ...opts, body });
}

/** `announcements.admin.update` — PATCH /api/v1/roboapply/admin/announcements/:id */
export function adminUpdateAnnouncement(id: string, body: In<typeof AN.PatchAnnouncementBodySchema> = {}, opts?: CallOptions): Promise<AN.AnnouncementView> {
  return call<AN.AnnouncementView>('PATCH', `/api/v1/roboapply/admin/announcements/${seg(id)}`, { ...opts, body });
}

/** `announcements.admin.delete` — DELETE /api/v1/roboapply/admin/announcements/:id */
export function adminDeleteAnnouncement(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/admin/announcements/${seg(id)}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const announcementsApi = {
  getNextAnnouncement,
  markAnnouncementSeen,
  adminListAnnouncements,
  adminCreateAnnouncement,
  adminUpdateAnnouncement,
  adminDeleteAnnouncement,
};
