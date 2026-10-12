// lib/api/tools.ts — Free tools without an account (multipart uploads).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-57.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Form fields: `TOOLS_UPLOAD_FIELDS` in the contract (`resume`, `postingTitle`,
// `postingText`, `consent`); `toolForm()` below builds the form.
//
// Endpoints:
//   GET    /api/v1/public/tools/config
//   POST   /api/v1/public/tools/resume-check
//   POST   /api/v1/public/tools/resume-job-match
//   GET    /api/v1/public/tools/results/:id
//   POST   /api/v1/public/tools/results/:id/claim

import { call, seg, type CallOptions } from './contracts/wire';
import type * as TO from './contracts/tools';

/** `tools.config` — GET /api/v1/public/tools/config */
export function getToolsConfig(opts?: CallOptions): Promise<TO.ToolsConfigView> {
  return call<TO.ToolsConfigView>('GET', `/api/v1/public/tools/config`, opts);
}

/** `tools.resumeCheck` — POST /api/v1/public/tools/resume-check (multipart) */
export function runResumeCheck(form: FormData, opts?: CallOptions): Promise<TO.ResumeCheckReport> {
  return call<TO.ResumeCheckReport>('POST', `/api/v1/public/tools/resume-check`, { ...opts, body: form, multipart: true });
}

/** `tools.resumeJobMatch` — POST /api/v1/public/tools/resume-job-match (multipart) */
export function runResumeJobMatch(form: FormData, opts?: CallOptions): Promise<TO.ResumeJobMatchReport> {
  return call<TO.ResumeJobMatchReport>('POST', `/api/v1/public/tools/resume-job-match`, { ...opts, body: form, multipart: true });
}

/** `tools.result` — GET /api/v1/public/tools/results/:id */
export function getToolResult(id: string, opts?: CallOptions): Promise<TO.ToolReport> {
  return call<TO.ToolReport>('GET', `/api/v1/public/tools/results/${seg(id)}`, opts);
}

/** `tools.claim` — POST /api/v1/public/tools/results/:id/claim */
export function claimToolResult(id: string, opts?: CallOptions): Promise<TO.ClaimToolResultResponse> {
  return call<TO.ClaimToolResultResponse>('POST', `/api/v1/public/tools/results/${seg(id)}/claim`, opts);
}

/** The multipart body of a tool run (field names mirror `TOOLS_UPLOAD_FIELDS`). */
export function toolForm(input: { resume: File; postingTitle?: string; postingText?: string; consent?: string | null }): FormData {
  const form = new FormData();
  form.set('resume', input.resume);
  if (input.postingTitle !== undefined) form.set('postingTitle', input.postingTitle);
  if (input.postingText !== undefined) form.set('postingText', input.postingText);
  if (input.consent) form.set('consent', input.consent);
  return form;
}

/** Every wrapper of this area, for callers that prefer one import. */
export const toolsApi = {
  getToolsConfig,
  runResumeCheck,
  runResumeJobMatch,
  getToolResult,
  claimToolResult,
  toolForm,
};
