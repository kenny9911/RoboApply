// server/src/features/push/workers.ts — queue workers of web push (WP-61).
//
// server/src/platform/queue/registry.ts (FND-5) imports `workers` from every
// area and registers them; the `queue-drain` cron runs them inside
// `runWithBrand(item.brand)`.
//
//   'push.send': deliver one notification (`PushSendPayload`) to every device
//                of one person, on either brand (D5). The delivery channel
//                sends inline; this kind is for producers that prefer the
//                queue. The item names its message-center `category`; the
//                worker sends only when the person chose push for that
//                category (otherwise it completes with nothing sent). Missing
//                VAPID keys for the item's brand, a missing category or that
//                brand's `webPush` kill switch being off
//                (FLAG_<BRAND>_WEB_PUSH=false — the same switch the channel
//                honours) are permanent (dead at once); a send that reached
//                no device retries.
//
// Importing this module also registers the `web_push` delivery channel, so a
// process that only drains the queue still mirrors alerts to push.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, isBrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import { PermanentWorkError, type WorkerDefinition } from '../../platform/queue/index.js';
import type { NotificationPreferencesView } from '../notifications/index.js';
import { loadPushPreferences, pushChosen, registerWebPushChannel } from './channel.js';
import type { PushSendPayload } from './contract.js';
import { pushService, type PushService } from './service.js';

registerWebPushChannel();

/**
 * Queue kinds of this area. A `push.send` producer must name the message's
 * `category`; the worker re-checks the person's push choice for it at send
 * time, so a producer cannot notify a device for a category the person
 * turned push off for.
 */
export const PUSH_WORK_KINDS = { pushSend: 'push.send' } as const;

function parsePayload(raw: unknown): PushSendPayload {
  const p = raw as Partial<PushSendPayload> | null;
  const payload = p?.payload as Partial<PushSendPayload['payload']> | undefined;
  if (
    !p ||
    typeof p.userId !== 'string' ||
    !isBrandId(p.brand) ||
    typeof p.category !== 'string' ||
    !p.category ||
    !payload ||
    typeof payload.title !== 'string' ||
    typeof payload.href !== 'string' ||
    typeof payload.tag !== 'string'
  ) {
    throw new PermanentWorkError('push.send: malformed payload');
  }
  return {
    userId: p.userId,
    brand: p.brand,
    category: p.category,
    payload: { title: payload.title, body: typeof payload.body === 'string' ? payload.body : null, href: payload.href, tag: payload.tag },
    notificationId: typeof p.notificationId === 'string' ? p.notificationId : null,
  };
}

export type PushPreferencesLoader = (userId: string, brand: ProductBrand) => Promise<NotificationPreferencesView | null>;

/** The `push.send` handler (exported for tests). */
export async function handlePushSend(
  raw: unknown,
  service: PushService = pushService(),
  preferences: PushPreferencesLoader = loadPushPreferences,
  env: EnvSource = process.env,
): Promise<{ sent: number; pruned: number; skippedReason?: 'preference_off' }> {
  const item = parsePayload(raw);
  const brand = getBrand(item.brand);
  if (!isEnabledForBrand('webPush', brand, env)) throw new PermanentWorkError('push.send: web push disabled');
  if (!service.config(brand)) throw new PermanentWorkError('push.send: VAPID keys are not configured');
  // No device → done before loading the preferences view.
  const devices = await service.devicesFor(item.userId, brand);
  if (!devices.length) return { sent: 0, pruned: 0 };
  // The person's own choice, checked at send time (it may have changed since
  // the item was queued). Off → done, nothing sent, no retry.
  if (!pushChosen(await preferences(item.userId, brand), item.category)) {
    return { sent: 0, pruned: 0, skippedReason: 'preference_off' };
  }
  const res = await service.sendToUser(item.userId, brand, item.payload, devices);
  if (res.subscriptions > 0 && res.sent === 0 && res.pruned < res.subscriptions) {
    throw new Error('push.send: no device accepted the message');
  }
  if (res.sent > 0 && item.notificationId) await service.markNotificationPushed(item.notificationId).catch(() => undefined);
  return { sent: res.sent, pruned: res.pruned };
}

export const workers: WorkerDefinition[] = [
  {
    kind: PUSH_WORK_KINDS.pushSend,
    concurrency: 5,
    handler: async (item) => {
      await handlePushSend(item.payload);
    },
  },
];
