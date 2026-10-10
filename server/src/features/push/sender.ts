// server/src/features/push/sender.ts — one encrypted Web Push request (`web-push`).
//
// Tests inject a fake `PushSender`; nothing here runs in unit tests.

import type { VapidConfig } from './config.js';
import { PUSH_POLICY } from './contract.js';

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushSendResult =
  | { ok: true; statusCode: number }
  | {
      ok: false;
      /** HTTP status from the push service, or null for a network/encryption error. */
      statusCode: number | null;
      /** 404/410: the browser dropped the subscription; delete it now. */
      gone: boolean;
      message: string;
    };

export type PushSender = (target: PushTarget, payload: string, vapid: VapidConfig, options?: { topic?: string }) => Promise<PushSendResult>;

/** A push topic must be ≤32 URL-safe base64 characters. */
export function pushTopic(tag: string): string | undefined {
  const t = tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return t || undefined;
}

export const webPushSender: PushSender = async (target, payload, vapid, options = {}) => {
  const webpush = (await import('web-push')).default;
  try {
    const res = await webpush.sendNotification(target, payload, {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: PUSH_POLICY.ttlSeconds,
      timeout: PUSH_POLICY.timeoutMs,
      urgency: 'normal',
      contentEncoding: 'aes128gcm',
      ...(options.topic ? { topic: options.topic } : {}),
    });
    return { ok: true, statusCode: res.statusCode };
  } catch (err) {
    const statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : null;
    return {
      ok: false,
      statusCode,
      gone: statusCode === 404 || statusCode === 410,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};
