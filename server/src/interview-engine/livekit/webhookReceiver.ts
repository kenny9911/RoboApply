// backend/src/interview-engine/livekit/webhookReceiver.ts
//
// Verifies + parses LiveKit Cloud webhooks. LiveKit signs the raw body with the
// API key/secret and passes the token in the `Authorization` header; the
// WebhookReceiver validates it. We care about:
//   - egress_ended   → recording finished; persist file location/size/duration
//   - room_finished  → session ended; trigger finalize if not already
//   - egress_updated → status transitions (logged)
//
// The route handler (routes/webhookRoutes.ts) MUST pass the RAW request body
// string (not the parsed JSON) for signature verification to work.
//
// Per plane (D5; GOAPPLY_PARITY_PLAN §3.5): the token's `iss` claim is the
// signing API key. The receiver finds the configured LiveKit project with that
// key (the shared one, or GoApply's own when CN_LIVEKIT_* is set), verifies
// with that project's secret, and returns the key together with every brand
// that runs on it. Two brands on one project is the default (GoApply without
// CN_LIVEKIT_URL), so a webhook is matched to a session by the key of the
// plane the session runs on, not by a single brand. A token no configured
// project signed is rejected.

import { createHash } from 'node:crypto';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { configuredLiveKitPlanes, getLiveKitCreds } from '../config.js';
import type { BrandId } from '../../platform/brand/registry.js';

const receivers = new Map<string, WebhookReceiver>();

// Keyed by the key AND a digest of the full secret, so a rotated secret (even
// one of the same length, on a hot env reload) gets a fresh receiver instead
// of verifying with the old one. The secret itself is never kept as a key.
function receiverFor(apiKey: string, apiSecret: string): WebhookReceiver {
  const key = `${apiKey}|${createHash('sha256').update(apiSecret).digest('base64url')}`;
  let receiver = receivers.get(key);
  if (!receiver) {
    receiver = new WebhookReceiver(apiKey, apiSecret);
    receivers.set(key, receiver);
  }
  return receiver;
}

export function __resetWebhookReceiverForTest(): void {
  receivers.clear();
}

/** The `iss` claim of a LiveKit webhook JWT (unverified — used only to pick the key). */
export function webhookIssuer(authHeader?: string): string | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iss?: unknown };
    return typeof claims.iss === 'string' && claims.iss ? claims.iss : null;
  } catch {
    return null;
  }
}

export interface ReceivedWebhook {
  event: WebhookEvent;
  /** The API key of the LiveKit project that signed the webhook (verified). */
  apiKey: string;
  /** Every brand whose new sessions run on that project now (both, on a shared project). */
  brands: BrandId[];
}

/** Who signed a webhook, as the session handlers take it. */
export type WebhookSigner = Pick<ReceivedWebhook, 'apiKey' | 'brands'>;

/**
 * Verify + decode a LiveKit webhook from any configured LiveKit project.
 * Throws if no configured project signed it (or the signature is invalid).
 */
export async function receiveBrandWebhook(rawBody: string, authHeader?: string): Promise<ReceivedWebhook> {
  const planes = configuredLiveKitPlanes();
  if (planes.length === 0) {
    // Same error the Wave 0 receiver raised when LiveKit was unset.
    getLiveKitCreds('roboapply');
  }
  const iss = webhookIssuer(authHeader);
  const plane = planes.find((p) => p.apiKey === iss);
  if (!plane) throw new Error('webhook was not signed by a configured LiveKit project');
  const event = await receiverFor(plane.apiKey, plane.apiSecret).receive(rawBody, authHeader);
  return { event, apiKey: plane.apiKey, brands: [...plane.brands] };
}

/**
 * Verify + decode a LiveKit webhook. Throws if the signature is invalid.
 * @param rawBody   the raw POST body string
 * @param authHeader the `Authorization` header value
 */
export async function receiveWebhook(rawBody: string, authHeader?: string): Promise<WebhookEvent> {
  return (await receiveBrandWebhook(rawBody, authHeader)).event;
}
