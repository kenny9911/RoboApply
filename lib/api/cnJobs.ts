// lib/api/cnJobs.ts — GoApply jobs: deep links, fraud review, blacklist.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-41.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/cn/jobs/external-links
//   GET    /api/v1/roboapply/admin/cn/jobs/fraud
//   POST   /api/v1/roboapply/admin/cn/jobs/fraud/:jobId/resolve
//   GET    /api/v1/roboapply/admin/cn/jobs/blacklist
//   POST   /api/v1/roboapply/admin/cn/jobs/blacklist
//   DELETE /api/v1/roboapply/admin/cn/jobs/blacklist/:id

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as CJ from './contracts/cn/jobs';

/** A blacklist row (admin). */
export type BlacklistEntryView = CJ.BlacklistEntryView;

/** `cnJobs.externalLinks` — GET /api/v1/roboapply/cn/jobs/external-links */
export function getExternalLinks(query: In<typeof CJ.ExternalLinksQuerySchema>, opts?: CallOptions): Promise<CJ.ExternalLinksResponse> {
  return call<CJ.ExternalLinksResponse>('GET', withQuery(`/api/v1/roboapply/cn/jobs/external-links`, query), opts);
}

/** `cnJobs.admin.fraudQueue` — GET /api/v1/roboapply/admin/cn/jobs/fraud */
export function adminListFraudQueue(query?: In<typeof CJ.FraudQueueQuerySchema>, opts?: CallOptions): Promise<CJ.FraudQueueResponse> {
  return call<CJ.FraudQueueResponse>('GET', withQuery(`/api/v1/roboapply/admin/cn/jobs/fraud`, query), opts);
}

/** `cnJobs.admin.resolve` — POST /api/v1/roboapply/admin/cn/jobs/fraud/:jobId/resolve */
export function adminResolveFraud(jobId: string, body: In<typeof CJ.ResolveFraudBodySchema>, opts?: CallOptions): Promise<CJ.ResolveFraudResponse> {
  return call<CJ.ResolveFraudResponse>('POST', `/api/v1/roboapply/admin/cn/jobs/fraud/${seg(jobId)}/resolve`, { ...opts, body });
}

/** `cnJobs.admin.blacklist` — GET /api/v1/roboapply/admin/cn/jobs/blacklist */
export function adminListBlacklist(opts?: CallOptions): Promise<CJ.BlacklistListResponse> {
  return call<CJ.BlacklistListResponse>('GET', `/api/v1/roboapply/admin/cn/jobs/blacklist`, opts);
}

/** `cnJobs.admin.addBlacklist` — POST /api/v1/roboapply/admin/cn/jobs/blacklist */
export function adminAddBlacklist(body: In<typeof CJ.BlacklistEntryBodySchema>, opts?: CallOptions): Promise<CJ.BlacklistAddResponse> {
  return call<CJ.BlacklistAddResponse>('POST', `/api/v1/roboapply/admin/cn/jobs/blacklist`, { ...opts, body });
}

/** `cnJobs.admin.removeBlacklist` — DELETE /api/v1/roboapply/admin/cn/jobs/blacklist/:id */
export function adminRemoveBlacklist(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/admin/cn/jobs/blacklist/${seg(id)}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const cnJobsApi = {
  getExternalLinks,
  adminListFraudQueue,
  adminResolveFraud,
  adminListBlacklist,
  adminAddBlacklist,
  adminRemoveBlacklist,
};
