// lib/api/offers.ts — Offer comparison.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-64.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/offers
//   POST   /api/v1/roboapply/offers/compare
//   PUT    /api/v1/roboapply/offers/:trackerEntryId
//   DELETE /api/v1/roboapply/offers/:trackerEntryId
//   POST   /api/v1/roboapply/offers/:trackerEntryId/negotiation-draft

import { call, type CallOptions, type In, type Items, seg } from './contracts/wire';
import type * as OF from './contracts/offers';

/** `offers.list` — GET /api/v1/roboapply/offers */
export function listOffers(opts?: CallOptions): Promise<Items<OF.OfferView>> {
  return call<Items<OF.OfferView>>('GET', `/api/v1/roboapply/offers`, opts);
}

/** `offers.compare` — POST /api/v1/roboapply/offers/compare */
export function compareOffers(body: In<typeof OF.CompareOffersBodySchema>, opts?: CallOptions): Promise<OF.OfferComparison> {
  return call<OF.OfferComparison>('POST', `/api/v1/roboapply/offers/compare`, { ...opts, body });
}

/** `offers.put` — PUT /api/v1/roboapply/offers/:trackerEntryId */
export function putOffer(trackerEntryId: string, body: In<typeof OF.PutOfferBodySchema>, opts?: CallOptions): Promise<OF.OfferView> {
  return call<OF.OfferView>('PUT', `/api/v1/roboapply/offers/${seg(trackerEntryId)}`, { ...opts, body });
}

/** `offers.delete` — DELETE /api/v1/roboapply/offers/:trackerEntryId */
export function deleteOffer(trackerEntryId: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/offers/${seg(trackerEntryId)}`, opts);
}

/** `offers.negotiationDraft` — POST /api/v1/roboapply/offers/:trackerEntryId/negotiation-draft */
export function createNegotiationDraft(trackerEntryId: string, opts?: CallOptions): Promise<OF.NegotiationDraft> {
  return call<OF.NegotiationDraft>('POST', `/api/v1/roboapply/offers/${seg(trackerEntryId)}/negotiation-draft`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const offersApi = {
  listOffers,
  compareOffers,
  putOffer,
  deleteOffer,
  createNegotiationDraft,
};
