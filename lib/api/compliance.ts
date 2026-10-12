// lib/api/compliance.ts — Compliance: consents, disclosures, personal-information requests, data export, legal documents.
//
// Thin typed wrappers over the area contract (FND-7; filled by WP-13).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/compliance/disclosures
//   GET    /api/v1/roboapply/compliance/retention
//   GET    /api/v1/roboapply/compliance/consents
//   POST   /api/v1/roboapply/compliance/consents
//   GET    /api/v1/roboapply/compliance/pi-requests
//   POST   /api/v1/roboapply/compliance/pi-requests
//   POST   /api/v1/roboapply/compliance/export
//   GET    /api/v1/roboapply/compliance/exports/:id/download   (browser download link)
//   GET    /api/v1/public/legal/footer
//   GET    /api/v1/public/legal/disclosures
//   GET    /api/v1/public/legal/retention
//   GET    /api/v1/public/legal/consents
//   GET    /api/v1/public/legal/:doc
//   GET    /api/v1/roboapply/admin/compliance/pi-requests
//   PATCH  /api/v1/roboapply/admin/compliance/pi-requests/:id

import { apiUrl, call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as CM from './contracts/compliance';

/** `compliance.disclosures` — GET /api/v1/roboapply/compliance/disclosures */
export function getDisclosures(opts?: CallOptions): Promise<CM.DisclosuresResponse> {
  return call<CM.DisclosuresResponse>('GET', `/api/v1/roboapply/compliance/disclosures`, opts);
}

/** `compliance.retention` — GET /api/v1/roboapply/compliance/retention */
export function getRetention(opts?: CallOptions): Promise<{ items: CM.RetentionRuleView[] }> {
  return call<{ items: CM.RetentionRuleView[] }>('GET', `/api/v1/roboapply/compliance/retention`, opts);
}

/** `compliance.consents` — GET /api/v1/roboapply/compliance/consents */
export function getConsents(query?: In<typeof CM.ConsentsQuerySchema>, opts?: CallOptions): Promise<CM.ConsentsResponse> {
  return call<CM.ConsentsResponse>('GET', withQuery(`/api/v1/roboapply/compliance/consents`, query), opts);
}

/** `compliance.recordConsent` — POST /api/v1/roboapply/compliance/consents */
export function recordConsent(body: In<typeof CM.RecordConsentBodySchema>, opts?: CallOptions): Promise<CM.RecordConsentResponse> {
  return call<CM.RecordConsentResponse>('POST', `/api/v1/roboapply/compliance/consents`, { ...opts, body });
}

/** `compliance.listPiRequests` — GET /api/v1/roboapply/compliance/pi-requests */
export function listPiRequests(opts?: CallOptions): Promise<Items<CM.PiRequestView>> {
  return call<Items<CM.PiRequestView>>('GET', `/api/v1/roboapply/compliance/pi-requests`, opts);
}

/** `compliance.createPiRequest` — POST /api/v1/roboapply/compliance/pi-requests */
export function createPiRequest(body: In<typeof CM.CreatePiRequestBodySchema>, opts?: CallOptions): Promise<CM.PiRequestView> {
  return call<CM.PiRequestView>('POST', `/api/v1/roboapply/compliance/pi-requests`, { ...opts, body });
}

/** `compliance.export` — POST /api/v1/roboapply/compliance/export */
export function requestDataExport(opts?: CallOptions): Promise<CM.ExportRequestResponse> {
  return call<CM.ExportRequestResponse>('POST', `/api/v1/roboapply/compliance/export`, opts);
}

/** `compliance.exportDownload` — GET /api/v1/roboapply/compliance/exports/:id/download */
export function exportDownloadUrl(id: string): string {
  return apiUrl(`/api/v1/roboapply/compliance/exports/${seg(id)}/download`);
}

/** `compliance.footer` — GET /api/v1/public/legal/footer */
export function getLegalFooter(opts?: CallOptions): Promise<CM.LegalFooterModel> {
  return call<CM.LegalFooterModel>('GET', `/api/v1/public/legal/footer`, opts);
}

/** `compliance.publicDisclosures` — GET /api/v1/public/legal/disclosures */
export function getPublicDisclosures(opts?: CallOptions): Promise<CM.DisclosuresResponse> {
  return call<CM.DisclosuresResponse>('GET', `/api/v1/public/legal/disclosures`, opts);
}

/** `compliance.publicRetention` — GET /api/v1/public/legal/retention */
export function getPublicRetention(opts?: CallOptions): Promise<{ items: CM.RetentionRuleView[] }> {
  return call<{ items: CM.RetentionRuleView[] }>('GET', `/api/v1/public/legal/retention`, opts);
}

/** `compliance.signupConsents` — GET /api/v1/public/legal/consents */
export function getSignupConsents(query?: In<typeof CM.ConsentsQuerySchema>, opts?: CallOptions): Promise<CM.ConsentsResponse> {
  return call<CM.ConsentsResponse>('GET', withQuery(`/api/v1/public/legal/consents`, query), opts);
}

/** `compliance.legalDoc` — GET /api/v1/public/legal/:doc */
export function getLegalDoc(doc: string, query?: In<typeof CM.LegalDocQuerySchema>, opts?: CallOptions): Promise<CM.LegalDocResponse> {
  return call<CM.LegalDocResponse>('GET', withQuery(`/api/v1/public/legal/${seg(doc)}`, query), opts);
}

/** `compliance.admin.piRequests` — GET /api/v1/roboapply/admin/compliance/pi-requests */
export function adminListPiRequests(query?: In<typeof CM.AdminPiRequestsQuerySchema>, opts?: CallOptions): Promise<Items<CM.AdminPiRequestView>> {
  return call<Items<CM.AdminPiRequestView>>('GET', withQuery(`/api/v1/roboapply/admin/compliance/pi-requests`, query), opts);
}

/** `compliance.admin.updatePiRequest` — PATCH /api/v1/roboapply/admin/compliance/pi-requests/:id */
export function adminUpdatePiRequest(id: string, body: In<typeof CM.AdminUpdatePiRequestBodySchema>, opts?: CallOptions): Promise<CM.AdminPiRequestView> {
  return call<CM.AdminPiRequestView>('PATCH', `/api/v1/roboapply/admin/compliance/pi-requests/${seg(id)}`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const complianceApi = {
  getDisclosures,
  getRetention,
  getConsents,
  recordConsent,
  listPiRequests,
  createPiRequest,
  requestDataExport,
  exportDownloadUrl,
  getLegalFooter,
  getPublicDisclosures,
  getPublicRetention,
  getSignupConsents,
  getLegalDoc,
  adminListPiRequests,
  adminUpdatePiRequest,
};
