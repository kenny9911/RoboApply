// server/src/features/push/contract.ts
//
// Web push, both brands (ARCHITECTURE.md §8.4; TASK_PLAN.md WP-61;
// GOAPPLY_PARITY_PLAN.md, owner ruling D5). Mount: /api/v1/roboapply/push,
// capability `webPush` per route, per brand. GoApply is on by default with
// the shared VAPID pair (its own CN_VAPID_* set is an optional override);
// FCM and Mozilla push endpoints are unreliable from the mainland, so on
// GoApply a browser that cannot reach them simply never gets a subscription
// and the other channels (inbox, email, WeChat) carry the alert. Opt-in only
// after a user action ("Get alerts on this device"); permission is never
// requested on page load. Failed endpoints are pruned.

import { z } from 'zod';

export interface VapidKeyResponse {
  publicKey: string;
}

/** PushSubscription.toJSON() shape. */
export const CreatePushSubscriptionBodySchema = z
  .object({
    endpoint: z.string().url().max(2000),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
    userAgent: z.string().max(400).optional(),
  })
  .strict();
export interface PushSubscriptionView {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}
export const PushSubscriptionParamsSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * "Is this browser's subscription mine?" — the opt-in asks on mount before it
 * shows "Alerts are on". POST (not a query string): the endpoint URL is a
 * capability and stays out of URLs and access logs.
 */
export const LookupPushSubscriptionBodySchema = z.object({ endpoint: z.string().url().max(2000) }).strict();
export interface PushSubscriptionLookupResponse {
  /** The caller's own row for this endpoint on the current brand, else null (another account's, or pruned). */
  subscription: PushSubscriptionView | null;
}

/**
 * `details.reason` values of this area's errors (the platform `code` is the
 * generic one: 501 `provider_not_configured`, 422 `invalid_request`).
 */
export const PUSH_ERROR_CODES = {
  /** VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are not all set. */
  vapidUnset: 'push_not_configured',
  /** The endpoint is not on a known browser push service. */
  endpointNotAllowed: 'push_endpoint_not_allowed',
} as const;

/**
 * Browser push services we deliver to (https only). The server POSTs to the
 * endpoint a browser hands us, so anything else is refused (no request to an
 * arbitrary URL): Chrome/Edge (FCM), Firefox (Mozilla autopush), Edge legacy
 * (WNS), Safari (Apple).
 */
export const PUSH_ENDPOINT_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
] as const;

/** True when `endpoint` is an https URL on a known push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_ENDPOINT_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export const PUSH_POLICY = {
  /** Devices kept per account; subscribing one more drops the oldest. */
  maxSubscriptionsPerUser: 10,
  /** Consecutive failed sends (other than 404/410, which prune at once) before a device is dropped. */
  maxFailures: 5,
  /** How long the push service keeps an undelivered message (seconds). */
  ttlSeconds: 24 * 60 * 60,
  /** Request timeout per send (ms). */
  timeoutMs: 10_000,
} as const;

/**
 * The JSON the service worker (`public/sw.js`) receives. `href` is a
 * same-site path; the worker opens it on click. No numbers that are not in
 * the in-app message (D3): title and body are the message's own text.
 */
export interface PushPayload {
  title: string;
  body: string | null;
  href: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag: string;
}

/** `push.send` queue payload (one notification to every device of one person). */
export interface PushSendPayload {
  userId: string;
  brand: 'roboapply' | 'goapply';
  /**
   * The message-center category (`NotificationCategory`, e.g. 'job_alerts').
   * Required: the worker sends only when the person chose push for it
   * (`preferencesFor(userId).channels[category]` includes 'push'), the same
   * rule as the `web_push` delivery channel. Missing → dead at once.
   */
  category: string;
  payload: PushPayload;
  /** The mirrored `SeekerNotification`, stamped `pushSentAt` on success. */
  notificationId?: string | null;
}
