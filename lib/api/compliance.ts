// lib/api/compliance.ts — Compliance: disclosures, personal-information requests, data export, legal documents.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-13.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/compliance/disclosures
//   GET    /api/v1/roboapply/compliance/pi-requests
//   POST   /api/v1/roboapply/compliance/pi-requests
//   POST   /api/v1/roboapply/compliance/export
//   GET    /api/v1/public/legal/:doc
//   GET    /api/v1/roboapply/admin/compliance/pi-requests

import { call, type CallOptions, type In, type Items, seg, withQuery } from './contracts/wire';
import type * as CM from './contracts/compliance';

/** `compliance.disclosures` — GET /api/v1/roboapply/compliance/disclosures */
export function getDisclosures(opts?: CallOptions): Promise<CM.DisclosuresResponse> {
  return call<CM.DisclosuresResponse>('GET', `/api/v1/roboapply/compliance/disclosures`, opts);
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

/** `compliance.legalDoc` — GET /api/v1/public/legal/:doc */
export function getLegalDoc(doc: string, query?: In<typeof CM.LegalDocQuerySchema>, opts?: CallOptions): Promise<CM.LegalDocResponse> {
  return call<CM.LegalDocResponse>('GET', withQuery(`/api/v1/public/legal/${seg(doc)}`, query), opts);
}

/** `compliance.admin.piRequests` — GET /api/v1/roboapply/admin/compliance/pi-requests */
export function adminListPiRequests(query?: In<typeof CM.AdminPiRequestsQuerySchema>, opts?: CallOptions): Promise<Items<CM.PiRequestView>> {
  return call<Items<CM.PiRequestView>>('GET', withQuery(`/api/v1/roboapply/admin/compliance/pi-requests`, query), opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const complianceApi = {
  getDisclosures,
  listPiRequests,
  createPiRequest,
  requestDataExport,
  getLegalDoc,
  adminListPiRequests,
};
