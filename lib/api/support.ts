// lib/api/support.ts — Support contact form and the public marketing facts.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-40.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   POST   /api/v1/roboapply/support/contact
//   GET    /api/v1/roboapply/support/index-stats
//   GET    /api/v1/roboapply/support/credit-caps

import { call, type CallOptions, type In } from './contracts/wire';
import type * as SU from './contracts/support';

/** `support.contact` — POST /api/v1/roboapply/support/contact */
export function sendSupportMessage(body: In<typeof SU.SupportContactBodySchema>, opts?: CallOptions): Promise<SU.SupportContactResponse> {
  return call<SU.SupportContactResponse>('POST', `/api/v1/roboapply/support/contact`, { ...opts, body });
}

/** `support.indexStats` — GET /api/v1/roboapply/support/index-stats (public counts, cached hourly). */
export function getIndexStats(opts?: CallOptions): Promise<SU.IndexStatsResponse> {
  return call<SU.IndexStatsResponse>('GET', `/api/v1/roboapply/support/index-stats`, opts);
}

/** `support.creditCaps` — GET /api/v1/roboapply/support/credit-caps (Free vs Pro caps for /pricing). */
export function getCreditCaps(opts?: CallOptions): Promise<SU.CreditCapsResponse> {
  return call<SU.CreditCapsResponse>('GET', `/api/v1/roboapply/support/credit-caps`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const supportApi = {
  sendSupportMessage,
  getIndexStats,
  getCreditCaps,
};
