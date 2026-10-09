// lib/api/tools.ts — Free tools without an account (multipart uploads).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-57.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Form fields: `TOOLS_UPLOAD_FIELDS` in the contract.
//
// Endpoints:
//   POST   /api/v1/public/tools/resume-check
//   POST   /api/v1/public/tools/resume-job-match

import { call, type CallOptions } from './contracts/wire';
import type * as TO from './contracts/tools';

/** `tools.resumeCheck` — POST /api/v1/public/tools/resume-check (multipart) */
export function runResumeCheck(form: FormData, opts?: CallOptions): Promise<TO.ResumeCheckReport> {
  return call<TO.ResumeCheckReport>('POST', `/api/v1/public/tools/resume-check`, { ...opts, body: form, multipart: true });
}

/** `tools.resumeJobMatch` — POST /api/v1/public/tools/resume-job-match (multipart) */
export function runResumeJobMatch(form: FormData, opts?: CallOptions): Promise<TO.ResumeJobMatchReport> {
  return call<TO.ResumeJobMatchReport>('POST', `/api/v1/public/tools/resume-job-match`, { ...opts, body: form, multipart: true });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const toolsApi = {
  runResumeCheck,
  runResumeJobMatch,
};
