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

import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';
import { getLiveKitCreds } from '../config.js';

let receiver: WebhookReceiver | null = null;

function getReceiver(): WebhookReceiver {
  if (!receiver) {
    const { apiKey, apiSecret } = getLiveKitCreds();
    receiver = new WebhookReceiver(apiKey, apiSecret);
  }
  return receiver;
}

export function __resetWebhookReceiverForTest(): void {
  receiver = null;
}

/**
 * Verify + decode a LiveKit webhook. Throws if the signature is invalid.
 * @param rawBody   the raw POST body string
 * @param authHeader the `Authorization` header value
 */
export async function receiveWebhook(rawBody: string, authHeader?: string): Promise<WebhookEvent> {
  return getReceiver().receive(rawBody, authHeader);
}
