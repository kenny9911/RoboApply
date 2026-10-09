// lib/api/campus.ts — GoApply campus calendar (校招日历): list, subscriptions, public pages, admin curation.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-58.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/cn/campus-events
//   GET    /api/v1/roboapply/cn/campus-events/subscriptions
//   POST   /api/v1/roboapply/cn/campus-events/subscriptions
//   DELETE /api/v1/roboapply/cn/campus-events/subscriptions/:id
//   GET    /api/v1/roboapply/cn/campus-events/:id
//   GET    /api/v1/public/campus
//   GET    /api/v1/public/campus/companies/:slug
//   GET    /api/v1/roboapply/admin/cn/campus/events
//   POST   /api/v1/roboapply/admin/cn/campus/events/extract
//   POST   /api/v1/roboapply/admin/cn/campus/events
//   PATCH  /api/v1/roboapply/admin/cn/campus/events/:id
//   POST   /api/v1/roboapply/admin/cn/campus/events/:id/verify
//   POST   /api/v1/roboapply/admin/cn/campus/events/:id/publish
//   DELETE /api/v1/roboapply/admin/cn/campus/events/:id

import { call, type CallOptions, type In, type Items, type Out, seg, withQuery } from './contracts/wire';
import type * as CA from './contracts/cn/campus';

/** A calendar subscription. The contract names no view type yet (WP-58). */
export type CampusSubscriptionView = Out<typeof CA.CreateCampusSubscriptionBodySchema> & { id: string; createdAt: string };
/** Extractor proposal for admin curation (a draft the admin verifies). */
export type CampusEventDraft = Out<typeof CA.CampusEventDraftBodySchema>;

/** `campus.list` — GET /api/v1/roboapply/cn/campus-events */
export function listCampusEvents(query?: In<typeof CA.ListCampusEventsQuerySchema>, opts?: CallOptions): Promise<Items<CA.CampusEventView>> {
  return call<Items<CA.CampusEventView>>('GET', withQuery(`/api/v1/roboapply/cn/campus-events`, query), opts);
}

/** `campus.listSubscriptions` — GET /api/v1/roboapply/cn/campus-events/subscriptions */
export function listCampusSubscriptions(opts?: CallOptions): Promise<Items<CampusSubscriptionView>> {
  return call<Items<CampusSubscriptionView>>('GET', `/api/v1/roboapply/cn/campus-events/subscriptions`, opts);
}

/** `campus.subscribe` — POST /api/v1/roboapply/cn/campus-events/subscriptions */
export function subscribeCampus(body: In<typeof CA.CreateCampusSubscriptionBodySchema>, opts?: CallOptions): Promise<CampusSubscriptionView> {
  return call<CampusSubscriptionView>('POST', `/api/v1/roboapply/cn/campus-events/subscriptions`, { ...opts, body });
}

/** `campus.unsubscribe` — DELETE /api/v1/roboapply/cn/campus-events/subscriptions/:id */
export function unsubscribeCampus(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/cn/campus-events/subscriptions/${seg(id)}`, opts);
}

/** `campus.get` — GET /api/v1/roboapply/cn/campus-events/:id */
export function getCampusEvent(id: string, opts?: CallOptions): Promise<CA.CampusEventView> {
  return call<CA.CampusEventView>('GET', `/api/v1/roboapply/cn/campus-events/${seg(id)}`, opts);
}

/** `campus.public.list` — GET /api/v1/public/campus */
export function listPublicCampusEvents(query?: In<typeof CA.ListCampusEventsQuerySchema>, opts?: CallOptions): Promise<Items<CA.CampusEventView>> {
  return call<Items<CA.CampusEventView>>('GET', withQuery(`/api/v1/public/campus`, query), opts);
}

/** `campus.public.company` — GET /api/v1/public/campus/companies/:slug */
export function getPublicCampusCompany(slug: string, opts?: CallOptions): Promise<Items<CA.CampusEventView>> {
  return call<Items<CA.CampusEventView>>('GET', `/api/v1/public/campus/companies/${seg(slug)}`, opts);
}

/** `campus.admin.list` — GET /api/v1/roboapply/admin/cn/campus/events */
export function adminListCampusEvents(query?: In<typeof CA.AdminCampusEventsQuerySchema>, opts?: CallOptions): Promise<Items<CA.CampusEventView>> {
  return call<Items<CA.CampusEventView>>('GET', withQuery(`/api/v1/roboapply/admin/cn/campus/events`, query), opts);
}

/** `campus.admin.extract` — POST /api/v1/roboapply/admin/cn/campus/events/extract */
export function adminExtractCampusEvent(body: In<typeof CA.ExtractCampusEventBodySchema>, opts?: CallOptions): Promise<CampusEventDraft> {
  return call<CampusEventDraft>('POST', `/api/v1/roboapply/admin/cn/campus/events/extract`, { ...opts, body });
}

/** `campus.admin.create` — POST /api/v1/roboapply/admin/cn/campus/events */
export function adminCreateCampusEvent(body: In<typeof CA.CampusEventDraftBodySchema>, opts?: CallOptions): Promise<CA.CampusEventView> {
  return call<CA.CampusEventView>('POST', `/api/v1/roboapply/admin/cn/campus/events`, { ...opts, body });
}

/** `campus.admin.update` — PATCH /api/v1/roboapply/admin/cn/campus/events/:id */
export function adminUpdateCampusEvent(id: string, body: In<typeof CA.PatchCampusEventBodySchema> = {}, opts?: CallOptions): Promise<CA.CampusEventView> {
  return call<CA.CampusEventView>('PATCH', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}`, { ...opts, body });
}

/** `campus.admin.verify` — POST /api/v1/roboapply/admin/cn/campus/events/:id/verify */
export function adminVerifyCampusEvent(id: string, opts?: CallOptions): Promise<CA.CampusEventView> {
  return call<CA.CampusEventView>('POST', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}/verify`, opts);
}

/** `campus.admin.publish` — POST /api/v1/roboapply/admin/cn/campus/events/:id/publish */
export function adminPublishCampusEvent(id: string, opts?: CallOptions): Promise<CA.CampusEventView> {
  return call<CA.CampusEventView>('POST', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}/publish`, opts);
}

/** `campus.admin.delete` — DELETE /api/v1/roboapply/admin/cn/campus/events/:id */
export function adminDeleteCampusEvent(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const campusApi = {
  listCampusEvents,
  listCampusSubscriptions,
  subscribeCampus,
  unsubscribeCampus,
  getCampusEvent,
  listPublicCampusEvents,
  getPublicCampusCompany,
  adminListCampusEvents,
  adminExtractCampusEvent,
  adminCreateCampusEvent,
  adminUpdateCampusEvent,
  adminVerifyCampusEvent,
  adminPublishCampusEvent,
  adminDeleteCampusEvent,
};
