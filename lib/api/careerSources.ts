// lib/api/careerSources.ts — Public ATS career sources (admin).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-42, MKT-3D.
// One list for both brands: a board is one source that feeds both sites (each
// posting lands on the site of the country it is in), so an admin on either
// host works on the same rows. `market` in a list query means "boards that
// feed this market"; without it the server uses the market of the brand the
// admin is on. `market` in a create body is ignored.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/admin/career-sources
//   POST   /api/v1/roboapply/admin/career-sources
//   POST   /api/v1/roboapply/admin/career-sources/import
//   PATCH  /api/v1/roboapply/admin/career-sources/:id
//   DELETE /api/v1/roboapply/admin/career-sources/:id
//   POST   /api/v1/roboapply/admin/career-sources/:id/run

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as CS from './contracts/jobs/sources/atsPublic';

export type {
  CareerSourceOrigin,
  CareerSourceRunResult,
  CareerSourceState,
  CareerSourceView,
  ImportCareerSourcesResult,
  ImportInvalidReason,
  PublicAts,
  TwCardMeta,
  TwPermitTag,
  TwPermitTagView,
} from './contracts/jobs/sources/atsPublic';

/** `careerSources.list` — GET /api/v1/roboapply/admin/career-sources */
export function adminListCareerSources(query?: In<typeof CS.ListCareerSourcesQuerySchema>, opts?: CallOptions): Promise<Items<CS.CareerSourceView>> {
  return call<Items<CS.CareerSourceView>>('GET', withQuery(`/api/v1/roboapply/admin/career-sources`, query), opts);
}

/** `careerSources.create` — POST /api/v1/roboapply/admin/career-sources */
export function adminCreateCareerSource(body: In<typeof CS.CareerSourceBodySchema>, opts?: CallOptions): Promise<CS.CareerSourceView> {
  return call<CS.CareerSourceView>('POST', `/api/v1/roboapply/admin/career-sources`, { ...opts, body });
}

/** `careerSources.import` — POST /api/v1/roboapply/admin/career-sources/import (a CSV or JSON list, at most 5,000 boards). */
export function adminImportCareerSources(body: In<typeof CS.ImportCareerSourcesBodySchema>, opts?: CallOptions): Promise<CS.ImportCareerSourcesResult> {
  return call<CS.ImportCareerSourcesResult>('POST', `/api/v1/roboapply/admin/career-sources/import`, { ...opts, body });
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
  adminImportCareerSources,
  adminUpdateCareerSource,
  adminDeleteCareerSource,
  adminRunCareerSource,
};
