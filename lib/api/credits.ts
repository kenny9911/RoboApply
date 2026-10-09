// lib/api/credits.ts — Credits, plans, cancel (in-app and public), admin caps / overrides / FX reference.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-21b (API: WP-21a).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/credits
//   GET    /api/v1/roboapply/credits/history
//   POST   /api/v1/roboapply/credits/cancel
//   GET    /api/v1/roboapply/billing/plans
//   POST   /api/v1/public/cancel
//   POST   /api/v1/public/cancel/confirm
//   GET    /api/v1/roboapply/admin/credits/catalog
//   PUT    /api/v1/roboapply/admin/credits/catalog
//   GET    /api/v1/roboapply/admin/credits/overrides
//   POST   /api/v1/roboapply/admin/credits/overrides
//   DELETE /api/v1/roboapply/admin/credits/overrides/:id
//   GET    /api/v1/roboapply/admin/credits/fx-reference
//   PUT    /api/v1/roboapply/admin/credits/fx-reference
//   GET    /api/v1/roboapply/admin/credits/tw-revenue

import { call, type CallOptions, type In, type Items, type Out, seg, withQuery } from './contracts/wire';
import type * as C from './contracts/credits';

/** An entitlement override row (admin). The contract names no view type yet (WP-21a). */
export type CreditOverrideView = Out<typeof C.CreateOverrideBodySchema> & { id: string; createdAt: string };

/** `credits.get` — GET /api/v1/roboapply/credits */
export function getCredits(opts?: CallOptions): Promise<C.CreditsResponse> {
  return call<C.CreditsResponse>('GET', `/api/v1/roboapply/credits`, opts);
}

/** `credits.history` — GET /api/v1/roboapply/credits/history */
export function getCreditHistory(query?: In<typeof C.CreditHistoryQuerySchema>, opts?: CallOptions): Promise<Items<C.CreditLedgerView>> {
  return call<Items<C.CreditLedgerView>>('GET', withQuery(`/api/v1/roboapply/credits/history`, query), opts);
}

/** `credits.cancel` — POST /api/v1/roboapply/credits/cancel */
export function cancelSubscription(body: In<typeof C.CancelSubscriptionBodySchema> = {}, opts?: CallOptions): Promise<C.CancelResponse> {
  return call<C.CancelResponse>('POST', `/api/v1/roboapply/credits/cancel`, { ...opts, body });
}

/** `billing.plans` — GET /api/v1/roboapply/billing/plans */
export function getPlans(opts?: CallOptions): Promise<C.PlansResponse> {
  return call<C.PlansResponse>('GET', `/api/v1/roboapply/billing/plans`, opts);
}

/** `cancel.request` — POST /api/v1/public/cancel */
export function requestPublicCancel(body: In<typeof C.PublicCancelRequestBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/public/cancel`, { ...opts, body });
}

/** `cancel.confirm` — POST /api/v1/public/cancel/confirm */
export function confirmPublicCancel(body: In<typeof C.PublicCancelConfirmBodySchema>, opts?: CallOptions): Promise<C.CancelResponse> {
  return call<C.CancelResponse>('POST', `/api/v1/public/cancel/confirm`, { ...opts, body });
}

/** `credits.admin.getCatalog` — GET /api/v1/roboapply/admin/credits/catalog */
export function adminGetCreditCatalog(opts?: CallOptions): Promise<Out<typeof C.PutCatalogBodySchema>> {
  return call<Out<typeof C.PutCatalogBodySchema>>('GET', `/api/v1/roboapply/admin/credits/catalog`, opts);
}

/** `credits.admin.putCatalog` — PUT /api/v1/roboapply/admin/credits/catalog */
export function adminPutCreditCatalog(body: In<typeof C.PutCatalogBodySchema>, opts?: CallOptions): Promise<Out<typeof C.PutCatalogBodySchema>> {
  return call<Out<typeof C.PutCatalogBodySchema>>('PUT', `/api/v1/roboapply/admin/credits/catalog`, { ...opts, body });
}

/** `credits.admin.listOverrides` — GET /api/v1/roboapply/admin/credits/overrides */
export function adminListOverrides(query?: In<typeof C.ListOverridesQuerySchema>, opts?: CallOptions): Promise<Items<CreditOverrideView>> {
  return call<Items<CreditOverrideView>>('GET', withQuery(`/api/v1/roboapply/admin/credits/overrides`, query), opts);
}

/** `credits.admin.createOverride` — POST /api/v1/roboapply/admin/credits/overrides */
export function adminCreateOverride(body: In<typeof C.CreateOverrideBodySchema>, opts?: CallOptions): Promise<CreditOverrideView> {
  return call<CreditOverrideView>('POST', `/api/v1/roboapply/admin/credits/overrides`, { ...opts, body });
}

/** `credits.admin.deleteOverride` — DELETE /api/v1/roboapply/admin/credits/overrides/:id */
export function adminDeleteOverride(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/admin/credits/overrides/${seg(id)}`, opts);
}

/** `credits.admin.getFx` — GET /api/v1/roboapply/admin/credits/fx-reference */
export function adminGetFxReference(opts?: CallOptions): Promise<Out<typeof C.PutFxReferenceBodySchema> | null> {
  return call<Out<typeof C.PutFxReferenceBodySchema> | null>('GET', `/api/v1/roboapply/admin/credits/fx-reference`, opts);
}

/** `credits.admin.putFx` — PUT /api/v1/roboapply/admin/credits/fx-reference */
export function adminPutFxReference(body: In<typeof C.PutFxReferenceBodySchema>, opts?: CallOptions): Promise<Out<typeof C.PutFxReferenceBodySchema>> {
  return call<Out<typeof C.PutFxReferenceBodySchema>>('PUT', `/api/v1/roboapply/admin/credits/fx-reference`, { ...opts, body });
}

/** `credits.admin.twRevenue` — GET /api/v1/roboapply/admin/credits/tw-revenue */
export function adminGetTwRevenue(opts?: CallOptions): Promise<C.TwRevenueResponse> {
  return call<C.TwRevenueResponse>('GET', `/api/v1/roboapply/admin/credits/tw-revenue`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const creditsApi = {
  getCredits,
  getCreditHistory,
  cancelSubscription,
  getPlans,
  requestPublicCancel,
  confirmPublicCancel,
  adminGetCreditCatalog,
  adminPutCreditCatalog,
  adminListOverrides,
  adminCreateOverride,
  adminDeleteOverride,
  adminGetFxReference,
  adminPutFxReference,
  adminGetTwRevenue,
};
