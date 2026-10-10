// lib/api/careerSources.ts — Public ATS career sources (admin).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-42.
// Both brands since the parity wave: the server scopes every call to the
// market of the brand whose host the admin is on (RoboApply → intl, GoApply →
// cn). `market` in a query or body may only name that market.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/admin/career-sources
//   POST   /api/v1/roboapply/admin/career-sources
//   PATCH  /api/v1/roboapply/admin/career-sources/:id
//   DELETE /api/v1/roboapply/admin/career-sources/:id
//   POST   /api/v1/roboapply/admin/career-sources/:id/run

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as CS from './contracts/jobs/sources/atsPublic';

export type { CareerSourceRunResult, CareerSourceView, PublicAts, TwCardMeta, TwPermitTag, TwPermitTagView } from './contracts/jobs/sources/atsPublic';

/** `careerSources.list` — GET /api/v1/roboapply/admin/career-sources */
export function adminListCareerSources(query?: In<typeof CS.ListCareerSourcesQuerySchema>, opts?: CallOptions): Promise<Items<CS.CareerSourceView>> {
  return call<Items<CS.CareerSourceView>>('GET', withQuery(`/api/v1/roboapply/admin/career-sources`, query), opts);
}

/** `careerSources.create` — POST /api/v1/roboapply/admin/career-sources */
export function adminCreateCareerSource(body: In<typeof CS.CareerSourceBodySchema>, opts?: CallOptions): Promise<CS.CareerSourceView> {
  return call<CS.CareerSourceView>('POST', `/api/v1/roboapply/admin/career-sources`, { ...opts, body });
}

/** `careerSources.update` — PATCH /api/v1/roboapply/admin/career-sources/:id */
export function adminUpdateCareerSource(id: string, body: In<typeof CS.PatchCareerSourceBodySchema> = {}, opts?: CallOptions): Promise<CS.CareerSourceView> {
  return call<CS.CareerSourceView>('PATCH', `/api/v1/roboapply/admin/career-sources/${seg(id)}`, { ...opts, body });
}

/** `careerSources.delete` — DELETE /api/v1/roboapply/admin/career-sources/:id (its open jobs are archived). */
export function adminDeleteCareerSource(id: string, opts?: CallOptions): Promise<{ archivedJobs: number }> {
  return call<{ archivedJobs: number }>('DELETE', `/api/v1/roboapply/admin/career-sources/${seg(id)}`, opts);
}

/** `careerSources.runNow` — POST /api/v1/roboapply/admin/career-sources/:id/run */
export function adminRunCareerSource(id: string, opts?: CallOptions): Promise<CS.CareerSourceRunResult> {
  return call<CS.CareerSourceRunResult>('POST', `/api/v1/roboapply/admin/career-sources/${seg(id)}/run`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const careerSourcesApi = {
  adminListCareerSources,
  adminCreateCareerSource,
  adminUpdateCareerSource,
  adminDeleteCareerSource,
  adminRunCareerSource,
};
