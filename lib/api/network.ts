// lib/api/network.ts — People at {company}, connections import, outreach drafts, GoApply 内推码 hub.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-54.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/network/jobs/:id/connections
//   GET    /api/v1/roboapply/network/imports/linkedin-connections
//   POST   /api/v1/roboapply/network/imports/linkedin-connections
//   DELETE /api/v1/roboapply/network/imports/linkedin-connections
//   GET    /api/v1/roboapply/network/contacts
//   POST   /api/v1/roboapply/network/contacts
//   DELETE /api/v1/roboapply/network/contacts/:id
//   POST   /api/v1/roboapply/network/contacts/:id/lookup-email
//   GET    /api/v1/roboapply/network/outreach-drafts
//   POST   /api/v1/roboapply/network/outreach-drafts
//   PATCH  /api/v1/roboapply/network/outreach-drafts/:id
//   POST   /api/v1/roboapply/network/outreach-drafts/:id/copied
//   POST   /api/v1/roboapply/network/outreach-drafts/:id/sent
//   GET    /api/v1/roboapply/cn/referrals
//   POST   /api/v1/roboapply/cn/referrals
//   POST   /api/v1/roboapply/cn/referrals/:id/report
//   DELETE /api/v1/roboapply/cn/referrals/:id

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as N from './contracts/network';
import type * as CR from './contracts/cn/referrals';

/** `network.connectionsForJob` — GET /api/v1/roboapply/network/jobs/:id/connections */
export function getConnectionsForJob(id: string, opts?: CallOptions): Promise<N.ConnectionsForJobResponse> {
  return call<N.ConnectionsForJobResponse>('GET', `/api/v1/roboapply/network/jobs/${seg(id)}/connections`, opts);
}

/** `network.importStatus` — GET /api/v1/roboapply/network/imports/linkedin-connections */
export function getConnectionsImportStatus(opts?: CallOptions): Promise<N.ConnectionsImportStatus> {
  return call<N.ConnectionsImportStatus>('GET', `/api/v1/roboapply/network/imports/linkedin-connections`, opts);
}

/** `network.importConnections` — POST /api/v1/roboapply/network/imports/linkedin-connections (multipart field `file`) */
export function importLinkedInConnections(form: FormData, opts?: CallOptions): Promise<N.ConnectionsImportResponse> {
  return call<N.ConnectionsImportResponse>('POST', `/api/v1/roboapply/network/imports/linkedin-connections`, { ...opts, body: form, multipart: true });
}

/** `network.deleteImportedConnections` — DELETE /api/v1/roboapply/network/imports/linkedin-connections */
export function deleteImportedConnections(opts?: CallOptions): Promise<N.DeleteConnectionsResponse> {
  return call<N.DeleteConnectionsResponse>('DELETE', `/api/v1/roboapply/network/imports/linkedin-connections`, opts);
}

/** `network.listContacts` — GET /api/v1/roboapply/network/contacts */
export function listContacts(query?: In<typeof N.ListContactsQuerySchema>, opts?: CallOptions): Promise<N.ListContactsResponse> {
  return call<N.ListContactsResponse>('GET', withQuery(`/api/v1/roboapply/network/contacts`, query), opts);
}

/** `network.listDrafts` — GET /api/v1/roboapply/network/outreach-drafts (query: jobId or trackerEntryId) */
export function listOutreachDrafts(query: { jobId?: string; trackerEntryId?: string }, opts?: CallOptions): Promise<N.ListOutreachDraftsResponse> {
  return call<N.ListOutreachDraftsResponse>('GET', withQuery(`/api/v1/roboapply/network/outreach-drafts`, query), opts);
}

/** `network.createDraft` — POST /api/v1/roboapply/network/outreach-drafts */
export function createOutreachDraft(body: In<typeof N.CreateOutreachDraftBodySchema>, opts?: CallOptions): Promise<N.OutreachDraftView> {
  return call<N.OutreachDraftView>('POST', `/api/v1/roboapply/network/outreach-drafts`, { ...opts, body });
}

/** `network.patchDraft` — PATCH /api/v1/roboapply/network/outreach-drafts/:id */
export function patchOutreachDraft(id: string, body: In<typeof N.PatchOutreachDraftBodySchema> = {}, opts?: CallOptions): Promise<N.OutreachDraftView> {
  return call<N.OutreachDraftView>('PATCH', `/api/v1/roboapply/network/outreach-drafts/${seg(id)}`, { ...opts, body });
}

/** `network.draftCopied` — POST /api/v1/roboapply/network/outreach-drafts/:id/copied */
export function markDraftCopied(id: string, opts?: CallOptions): Promise<N.OutreachDraftView> {
  return call<N.OutreachDraftView>('POST', `/api/v1/roboapply/network/outreach-drafts/${seg(id)}/copied`, opts);
}

/** `network.draftSent` — POST /api/v1/roboapply/network/outreach-drafts/:id/sent */
export function markDraftSent(id: string, opts?: CallOptions): Promise<N.OutreachDraftView> {
  return call<N.OutreachDraftView>('POST', `/api/v1/roboapply/network/outreach-drafts/${seg(id)}/sent`, opts);
}

/** `cnReferrals.list` — GET /api/v1/roboapply/cn/referrals */
export function listReferralCodes(query?: In<typeof CR.ListReferralCodesQuerySchema>, opts?: CallOptions): Promise<CR.ListReferralCodesResponse> {
  return call<CR.ListReferralCodesResponse>('GET', withQuery(`/api/v1/roboapply/cn/referrals`, query), opts);
}

/** `cnReferrals.create` — POST /api/v1/roboapply/cn/referrals */
export function createReferralCode(body: In<typeof CR.CreateReferralCodeBodySchema>, opts?: CallOptions): Promise<CR.ReferralCodeView> {
  return call<CR.ReferralCodeView>('POST', `/api/v1/roboapply/cn/referrals`, { ...opts, body });
}

/** `cnReferrals.report` — POST /api/v1/roboapply/cn/referrals/:id/report */
export function reportReferralCode(id: string, body: In<typeof CR.ReportReferralCodeBodySchema>, opts?: CallOptions): Promise<{ reported: true }> {
  return call<{ reported: true }>('POST', `/api/v1/roboapply/cn/referrals/${seg(id)}/report`, { ...opts, body });
}

/** `cnReferrals.delete` — DELETE /api/v1/roboapply/cn/referrals/:id */
export function deleteReferralCode(id: string, opts?: CallOptions): Promise<{ deleted: true }> {
  return call<{ deleted: true }>('DELETE', `/api/v1/roboapply/cn/referrals/${seg(id)}`, opts);
}

