// lib/api/coverLetters.ts — Cover letters.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-37.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/cover-letters
//   POST   /api/v1/roboapply/cover-letters
//   GET    /api/v1/roboapply/cover-letters/:id
//   PATCH  /api/v1/roboapply/cover-letters/:id
//   DELETE /api/v1/roboapply/cover-letters/:id
//   POST   /api/v1/roboapply/cover-letters/:id/rewrite
//   POST   /api/v1/roboapply/cover-letters/:id/restore
//   GET    /api/v1/roboapply/cover-letters/:id/export

import { apiUrl, call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as CL from './contracts/coverletter';

/** `coverLetter.list` — GET /api/v1/roboapply/cover-letters */
export function listCoverLetters(query?: In<typeof CL.ListLettersQuerySchema>, opts?: CallOptions): Promise<Items<CL.CoverLetterView>> {
  return call<Items<CL.CoverLetterView>>('GET', withQuery(`/api/v1/roboapply/cover-letters`, query), opts);
}

/** `coverLetter.create` — POST /api/v1/roboapply/cover-letters */
export function createCoverLetter(body: In<typeof CL.CreateLetterBodySchema>, opts?: CallOptions): Promise<CL.CoverLetterView> {
  return call<CL.CoverLetterView>('POST', `/api/v1/roboapply/cover-letters`, { ...opts, body });
}

/** `coverLetter.get` — GET /api/v1/roboapply/cover-letters/:id */
export function getCoverLetter(id: string, opts?: CallOptions): Promise<CL.CoverLetterView> {
  return call<CL.CoverLetterView>('GET', `/api/v1/roboapply/cover-letters/${seg(id)}`, opts);
}

/** `coverLetter.patch` — PATCH /api/v1/roboapply/cover-letters/:id */
export function patchCoverLetter(id: string, body: In<typeof CL.PatchLetterBodySchema> = {}, opts?: CallOptions): Promise<CL.CoverLetterView> {
  return call<CL.CoverLetterView>('PATCH', `/api/v1/roboapply/cover-letters/${seg(id)}`, { ...opts, body });
}

/** `coverLetter.delete` — DELETE /api/v1/roboapply/cover-letters/:id */
export function deleteCoverLetter(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/cover-letters/${seg(id)}`, opts);
}

/** `coverLetter.rewrite` — POST /api/v1/roboapply/cover-letters/:id/rewrite */
export function rewriteCoverLetter(id: string, body: In<typeof CL.RewriteLetterBodySchema>, opts?: CallOptions): Promise<CL.CoverLetterView> {
  return call<CL.CoverLetterView>('POST', `/api/v1/roboapply/cover-letters/${seg(id)}/rewrite`, { ...opts, body });
}

/** `coverLetter.restore` — POST /api/v1/roboapply/cover-letters/:id/restore */
export function restoreCoverLetter(id: string, body: In<typeof CL.RestoreLetterBodySchema>, opts?: CallOptions): Promise<CL.CoverLetterView> {
  return call<CL.CoverLetterView>('POST', `/api/v1/roboapply/cover-letters/${seg(id)}/restore`, { ...opts, body });
}

/** `coverLetter.export` — GET /api/v1/roboapply/cover-letters/:id/export */
export function coverLetterExportUrl(id: string, query: In<typeof CL.ExportLetterQuerySchema>): string {
  return apiUrl(withQuery(`/api/v1/roboapply/cover-letters/${seg(id)}/export`, query));
}

/** Every wrapper of this area, for callers that prefer one import. */
export const coverLettersApi = {
  listCoverLetters,
  createCoverLetter,
  getCoverLetter,
  patchCoverLetter,
  deleteCoverLetter,
  rewriteCoverLetter,
  restoreCoverLetter,
  coverLetterExportUrl,
};
