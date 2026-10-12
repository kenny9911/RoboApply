// lib/api/offers.ts — Offer comparison.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-64.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/offers
//   POST   /api/v1/roboapply/offers/compare
//   POST   /api/v1/roboapply/offers/explain
//   PUT    /api/v1/roboapply/offers/:trackerEntryId
//   DELETE /api/v1/roboapply/offers/:trackerEntryId
//   GET    /api/v1/roboapply/offers/:trackerEntryId/benchmark
//   POST   /api/v1/roboapply/offers/:trackerEntryId/negotiation-draft

import { call, type CallOptions, type In, seg } from './contracts/wire';
import type * as OF from './contracts/offers';

/** `offers.list` — GET /api/v1/roboapply/offers (every application with an offer, newest first; `aiAvailable` = the AI gate). */
export function listOffers(opts?: CallOptions): Promise<OF.OffersListResponse> {
  return call<OF.OffersListResponse>('GET', `/api/v1/roboapply/offers`, opts);
}

/** `offers.compare` — POST /api/v1/roboapply/offers/compare */
export function compareOffers(body: In<typeof OF.CompareOffersBodySchema>, opts?: CallOptions): Promise<OF.OfferComparison> {
  return call<OF.OfferComparison>('POST', `/api/v1/roboapply/offers/compare`, { ...opts, body });
}

/** `offers.explain` — POST /api/v1/roboapply/offers/explain (AI; 503 ai_unavailable when off) */
export function explainOffers(body: In<typeof OF.ExplainOffersBodySchema>, opts?: CallOptions): Promise<OF.OfferExplanation> {
  return call<OF.OfferExplanation>('POST', `/api/v1/roboapply/offers/explain`, { ...opts, body });
}

/** `offers.put` — PUT /api/v1/roboapply/offers/:trackerEntryId */
export function putOffer(trackerEntryId: string, body: In<typeof OF.PutOfferBodySchema>, opts?: CallOptions): Promise<OF.OfferView> {
  return call<OF.OfferView>('PUT', `/api/v1/roboapply/offers/${seg(trackerEntryId)}`, { ...opts, body });
}

/** `offers.delete` — DELETE /api/v1/roboapply/offers/:trackerEntryId */
export function deleteOffer(trackerEntryId: string, opts?: CallOptions): Promise<{ deleted: true }> {
  return call<{ deleted: true }>('DELETE', `/api/v1/roboapply/offers/${seg(trackerEntryId)}`, opts);
}

/** `offers.benchmark` — GET /api/v1/roboapply/offers/:trackerEntryId/benchmark (posted pay for the role, N shown) */
export function getOfferBenchmark(trackerEntryId: string, opts?: CallOptions): Promise<OF.OfferBenchmark> {
  return call<OF.OfferBenchmark>('GET', `/api/v1/roboapply/offers/${seg(trackerEntryId)}/benchmark`, opts);
}

/** `offers.negotiationDraft` — POST /api/v1/roboapply/offers/:trackerEntryId/negotiation-draft (AI) */
export function createNegotiationDraft(
  trackerEntryId: string,
  body: In<typeof OF.NegotiationDraftBodySchema> = {},
  opts?: CallOptions,
): Promise<OF.NegotiationDraft> {
  return call<OF.NegotiationDraft>('POST', `/api/v1/roboapply/offers/${seg(trackerEntryId)}/negotiation-draft`, { ...opts, body });
}

/** Every wrapper of this area, for callers that prefer one import. */
export const offersApi = {
  listOffers,
  compareOffers,
  explainOffers,
  putOffer,
  deleteOffer,
  getOfferBenchmark,
  createNegotiationDraft,
};
