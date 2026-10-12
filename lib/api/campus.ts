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

import { call, type CallOptions, type In, type Out, seg, withQuery } from './contracts/wire';
import type * as CA from './contracts/cn/campus';

export type CampusSubscriptionView = CA.CampusSubscriptionView;
export type CampusEventList = CA.CampusEventList;
export type CampusCompanyResponse = CA.CampusCompanyResponse;
export type AdminCampusEventView = CA.AdminCampusEventView;
export type AdminCampusEventList = CA.AdminCampusEventList;
export type CampusExtractResponse = CA.CampusExtractResponse;
/** A draft body as the admin form sends it. */
export type CampusEventDraft = Out<typeof CA.CampusEventDraftBodySchema>;

/** `campus.list` — GET /api/v1/roboapply/cn/campus-events */
export function listCampusEvents(query?: In<typeof CA.ListCampusEventsQuerySchema>, opts?: CallOptions): Promise<CampusEventList> {
  return call<CampusEventList>('GET', withQuery(`/api/v1/roboapply/cn/campus-events`, query), opts);
}

/** `campus.listSubscriptions` — GET /api/v1/roboapply/cn/campus-events/subscriptions */
export function listCampusSubscriptions(opts?: CallOptions): Promise<CA.CampusSubscriptionList> {
  return call<CA.CampusSubscriptionList>('GET', `/api/v1/roboapply/cn/campus-events/subscriptions`, opts);
}

/** `campus.subscribe` — POST /api/v1/roboapply/cn/campus-events/subscriptions */
export function subscribeCampus(body: In<typeof CA.CreateCampusSubscriptionBodySchema>, opts?: CallOptions): Promise<CampusSubscriptionView> {
  return call<CampusSubscriptionView>('POST', `/api/v1/roboapply/cn/campus-events/subscriptions`, { ...opts, body });
}

/** `campus.unsubscribe` — DELETE /api/v1/roboapply/cn/campus-events/subscriptions/:id */
export function unsubscribeCampus(id: string, opts?: CallOptions): Promise<{ id: string }> {
  return call<{ id: string }>('DELETE', `/api/v1/roboapply/cn/campus-events/subscriptions/${seg(id)}`, opts);
}

/** `campus.get` — GET /api/v1/roboapply/cn/campus-events/:id */
export function getCampusEvent(id: string, opts?: CallOptions): Promise<CA.CampusEventView> {
  return call<CA.CampusEventView>('GET', `/api/v1/roboapply/cn/campus-events/${seg(id)}`, opts);
}

/** `campus.public.list` — GET /api/v1/public/campus */
export function listPublicCampusEvents(query?: In<typeof CA.ListCampusEventsQuerySchema>, opts?: CallOptions): Promise<CampusEventList> {
  return call<CampusEventList>('GET', withQuery(`/api/v1/public/campus`, query), opts);
}

/** `campus.public.company` — GET /api/v1/public/campus/companies/:slug */
export function getPublicCampusCompany(slug: string, opts?: CallOptions): Promise<CampusCompanyResponse> {
  return call<CampusCompanyResponse>('GET', `/api/v1/public/campus/companies/${seg(slug)}`, opts);
}

/** `campus.admin.list` — GET /api/v1/roboapply/admin/cn/campus/events */
export function adminListCampusEvents(query?: In<typeof CA.AdminCampusEventsQuerySchema>, opts?: CallOptions): Promise<AdminCampusEventList> {
  return call<AdminCampusEventList>('GET', withQuery(`/api/v1/roboapply/admin/cn/campus/events`, query), opts);
}

/** `campus.admin.extract` — POST /api/v1/roboapply/admin/cn/campus/events/extract */
export function adminExtractCampusEvent(body: In<typeof CA.ExtractCampusEventBodySchema>, opts?: CallOptions): Promise<CampusExtractResponse> {
  return call<CampusExtractResponse>('POST', `/api/v1/roboapply/admin/cn/campus/events/extract`, { ...opts, body });
}

/** `campus.admin.create` — POST /api/v1/roboapply/admin/cn/campus/events */
export function adminCreateCampusEvent(body: In<typeof CA.CampusEventDraftBodySchema>, opts?: CallOptions): Promise<AdminCampusEventView> {
  return call<AdminCampusEventView>('POST', `/api/v1/roboapply/admin/cn/campus/events`, { ...opts, body });
}

/** `campus.admin.update` — PATCH /api/v1/roboapply/admin/cn/campus/events/:id */
export function adminUpdateCampusEvent(id: string, body: In<typeof CA.PatchCampusEventBodySchema> = {}, opts?: CallOptions): Promise<AdminCampusEventView> {
  return call<AdminCampusEventView>('PATCH', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}`, { ...opts, body });
}

/** `campus.admin.verify` — POST /api/v1/roboapply/admin/cn/campus/events/:id/verify */
export function adminVerifyCampusEvent(id: string, opts?: CallOptions): Promise<AdminCampusEventView> {
  return call<AdminCampusEventView>('POST', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}/verify`, opts);
}

/** `campus.admin.publish` — POST /api/v1/roboapply/admin/cn/campus/events/:id/publish */
export function adminPublishCampusEvent(id: string, opts?: CallOptions): Promise<AdminCampusEventView> {
  return call<AdminCampusEventView>('POST', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}/publish`, opts);
}

/** `campus.admin.delete` — DELETE /api/v1/roboapply/admin/cn/campus/events/:id */
export function adminDeleteCampusEvent(id: string, opts?: CallOptions): Promise<CA.AdminCampusDeleteResponse> {
  return call<CA.AdminCampusDeleteResponse>('DELETE', `/api/v1/roboapply/admin/cn/campus/events/${seg(id)}`, opts);
}

/**
 * Paths of the public reads, for the server-rendered /campus pages, which call
 * the API from the Next server with the visitor's host (components/features/campus/serverData.ts).
 */
export const campusPublicPaths = {
  list: (query = '') => `/api/v1/public/campus${query}`,
  company: (slug: string) => `/api/v1/public/campus/companies/${seg(slug)}`,
};

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
