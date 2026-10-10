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
// Per brand (WP-63a): RoboApply and GoApply run separate LiveKit projects
// (LIVEKIT_* / CN_LIVEKIT_*) that may post to the same endpoint. The token's
// `iss` claim is the signing API key, so the receiver picks the brand whose
// key signed it and verifies with that brand's secret; a token no configured
// project signed is rejected.

import { createHash } from 'node:crypto';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { getLiveKitCreds, isLiveKitConfigured } from '../config.js';
import { BRAND_IDS, type BrandId } from '../../platform/brand/registry.js';

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
  /** The brand whose LiveKit project signed the webhook. */
  brand: BrandId;
}

/**
 * Verify + decode a LiveKit webhook from any configured brand project.
 * Throws if no configured project signed it (or the signature is invalid).
 */
export async function receiveBrandWebhook(rawBody: string, authHeader?: string): Promise<ReceivedWebhook> {
  const configured = BRAND_IDS.filter((id) => isLiveKitConfigured(id));
  if (configured.length === 0) {
    // Same error the Wave 0 receiver raised when LiveKit was unset.
    getLiveKitCreds('roboapply');
  }
  const iss = webhookIssuer(authHeader);
  const signer = configured.find((id) => getLiveKitCreds(id).apiKey === iss);
  if (!signer) throw new Error('webhook was not signed by a configured LiveKit project');
  const { apiKey, apiSecret } = getLiveKitCreds(signer);
  const event = await receiverFor(apiKey, apiSecret).receive(rawBody, authHeader);
  return { event, brand: signer };
}

/**
 * Verify + decode a LiveKit webhook. Throws if the signature is invalid.
 * @param rawBody   the raw POST body string
 * @param authHeader the `Authorization` header value
 */
export async function receiveWebhook(rawBody: string, authHeader?: string): Promise<WebhookEvent> {
  return (await receiveBrandWebhook(rawBody, authHeader)).event;
}
