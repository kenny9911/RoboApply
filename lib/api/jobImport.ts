// lib/api/jobImport.ts — Added by you: import a job from a link or by hand.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-35.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   POST   /api/v1/roboapply/jobs/import                 { url } → draft · { manual, importId? } → saved job
//   GET    /api/v1/roboapply/jobs/import                 the user's added jobs
//   GET    /api/v1/roboapply/jobs/import/:importId       status of a draft or a saved job
//   DELETE /api/v1/roboapply/jobs/import/jobs/:jobId     remove an added job
//
// Saving spends the `job_import` credit: pass `idempotencyKey` (useCreditGate
// gives one per attempt) so a retry never charges twice.

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as I from './contracts/jobs/import';

/** `jobImport.create` — POST /api/v1/roboapply/jobs/import */
export function importJob(body: In<typeof I.ImportJobBodySchema>, opts?: CallOptions): Promise<I.ImportJobResponse> {
  return call<I.ImportJobResponse>('POST', `/api/v1/roboapply/jobs/import`, { ...opts, body });
}

/** `jobImport.status` — GET /api/v1/roboapply/jobs/import/:importId */
export function getImportStatus(importId: string, opts?: CallOptions): Promise<I.ImportStatusResponse> {
  return call<I.ImportStatusResponse>('GET', `/api/v1/roboapply/jobs/import/${seg(importId)}`, opts);
}

/** `jobImport.list` — GET /api/v1/roboapply/jobs/import */
export function listAddedJobs(query: In<typeof I.AddedJobsQuerySchema> = {}, opts?: CallOptions): Promise<I.AddedJobsResponse> {
  return call<I.AddedJobsResponse>('GET', withQuery(`/api/v1/roboapply/jobs/import`, query), opts);
}

/** `jobImport.remove` — DELETE /api/v1/roboapply/jobs/import/jobs/:jobId */
export function removeAddedJob(jobId: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/jobs/import/jobs/${seg(jobId)}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const jobImportApi = {
  importJob,
  getImportStatus,
  listAddedJobs,
  removeAddedJob,
};
