// lib/api/support.ts — Support contact form.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-40.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   POST   /api/v1/roboapply/support/contact

import { call, type CallOptions, type In } from './contracts/wire';
import type * as SU from './contracts/support';

/** `support.contact` — POST /api/v1/roboapply/support/contact */
export function sendSupportMessage(body: In<typeof SU.SupportContactBodySchema>, opts?: CallOptions): Promise<SU.SupportContactResponse> {
  return call<SU.SupportContactResponse>('POST', `/api/v1/roboapply/support/contact`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const supportApi = {
  sendSupportMessage,
};
