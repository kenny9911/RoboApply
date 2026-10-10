// lib/api/push.ts — Web push subscriptions (RoboApply).
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-61.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// Endpoints:
//   GET    /api/v1/roboapply/push/vapid-public-key
//   POST   /api/v1/roboapply/push/subscriptions
//   POST   /api/v1/roboapply/push/subscriptions/lookup
//   DELETE /api/v1/roboapply/push/subscriptions/:id

import { call, type CallOptions, type In, seg } from './contracts/wire';
import type * as PU from './contracts/push';

/** `push.vapidKey` — GET /api/v1/roboapply/push/vapid-public-key */
export function getVapidPublicKey(opts?: CallOptions): Promise<PU.VapidKeyResponse> {
  return call<PU.VapidKeyResponse>('GET', `/api/v1/roboapply/push/vapid-public-key`, opts);
}

/** `push.subscribe` — POST /api/v1/roboapply/push/subscriptions */
export function createPushSubscription(body: In<typeof PU.CreatePushSubscriptionBodySchema>, opts?: CallOptions): Promise<PU.PushSubscriptionView> {
  return call<PU.PushSubscriptionView>('POST', `/api/v1/roboapply/push/subscriptions`, { ...opts, body });
}

/**
 * `push.lookup` — POST /api/v1/roboapply/push/subscriptions/lookup
 * The caller's own row for this browser's endpoint, or `{ subscription: null }`.
 */
export function lookupPushSubscription(
  body: In<typeof PU.LookupPushSubscriptionBodySchema>,
  opts?: CallOptions,
): Promise<PU.PushSubscriptionLookupResponse> {
  return call<PU.PushSubscriptionLookupResponse>('POST', `/api/v1/roboapply/push/subscriptions/lookup`, { ...opts, body });
}

/** `push.unsubscribe` — DELETE /api/v1/roboapply/push/subscriptions/:id */
export function deletePushSubscription(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('DELETE', `/api/v1/roboapply/push/subscriptions/${seg(id)}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const pushApi = {
  getVapidPublicKey,
  createPushSubscription,
  lookupPushSubscription,
  deletePushSubscription,
};
