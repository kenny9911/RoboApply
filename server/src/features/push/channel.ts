// server/src/features/push/channel.ts — the `web_push` delivery channel (WP-61).
//
// Registered with WP-39a's `registerDeliveryChannel('web_push', impl)`, so
// every job alert, reminder and lifecycle message that `deliverMessage` fans
// out (in-app first, then email, then the registered channels) is mirrored to
// the person's devices when they subscribed. The channel:
//   - serves RoboApply only (`webPush` flag; GoApply has no web push);
//   - is unconfigured without VAPID keys (the runner skips it);
//   - checks its own subscriptions FIRST (one cheap read; none → skipped
//     'no_subscription'), so the many people without a device never pay for
//     the preferences view;
//   - then checks the person's own channel choice through WP-39b's
//     `notificationCenterService.preferencesFor(userId).channels[category]`
//     (push is opt-in: absent unless the person turned it on);
//   - sends the in-app message's own title and body (no new numbers, D3);
//   - stamps `SeekerNotification.pushSentAt` itself when a device took it.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, type ProductBrand } from '../../platform/brand/registry.js';
import { isEnabledForBrand } from '../../platform/flags.js';
import { inAppCopy, registerDeliveryChannel, type DeliveryChannel, type DeliveryMessage, type DeliveryResult } from '../alerts/index.js';
import type { NotificationPreferencesView } from '../notifications/index.js';
import { vapidConfig, WEB_PUSH_BRANDS, webPushServesBrand } from './config.js';
import type { PushPayload } from './contract.js';
import { pushService, safeHref, type PushService } from './service.js';

export const WEB_PUSH_CHANNEL_ID = 'web_push' as const;
export { WEB_PUSH_BRANDS };

export interface WebPushChannelDeps {
  service?: () => PushService;
  preferences?: (userId: string, brand: ProductBrand) => Promise<NotificationPreferencesView | null>;
  copy?: (brand: ProductBrand, locale: string, templateKey: string, params: Record<string, unknown>) => { title: string; body: string | null };
  env?: EnvSource;
}

/** Is push one of the person's chosen channels for this category? Unknown categories fail closed. */
export function pushChosen(prefs: NotificationPreferencesView | null, category: string): boolean {
  if (!prefs) return false;
  const chosen = (prefs.channels as Record<string, readonly string[] | undefined>)[category];
  return Array.isArray(chosen) && chosen.includes('push');
}

/**
 * The person's notification preferences (WP-39b). Lazy: the message-center
 * module installs the email gate on import, which the router (imported at
 * startup) must not trigger.
 */
export async function loadPushPreferences(userId: string, brand: ProductBrand): Promise<NotificationPreferencesView | null> {
  return (await import('../notifications/index.js')).notificationCenterService.preferencesFor(userId, brand);
}

export function createWebPushChannel(deps: WebPushChannelDeps = {}): DeliveryChannel {
  const env = () => deps.env ?? process.env;
  const service = deps.service ?? pushService;
  const preferences = deps.preferences ?? loadPushPreferences;
  const copy = deps.copy ?? ((brand, locale, templateKey, params) => inAppCopy(brand, locale, templateKey, params, ''));

  return {
    id: WEB_PUSH_CHANNEL_ID,
    brands: WEB_PUSH_BRANDS,
    isConfigured() {
      const brand = getBrand('roboapply');
      return vapidConfig(brand, env()) !== null && isEnabledForBrand('webPush', brand, env());
    },
    async deliver(msg: DeliveryMessage): Promise<DeliveryResult> {
      const brand = getBrand(msg.brand);
      if (!webPushServesBrand(brand) || !isEnabledForBrand('webPush', brand, env())) {
        return { delivered: false, skippedReason: 'feature_disabled' };
      }
      const svc = service();
      const devices = await svc.devicesFor(msg.userId, brand);
      if (!devices.length) return { delivered: false, skippedReason: 'no_subscription' };
      const prefs = await preferences(msg.userId, brand);
      if (!pushChosen(prefs, msg.category)) return { delivered: false, skippedReason: 'preference_off' };

      const text = copy(brand, msg.locale, msg.templateKey, msg.params);
      const payload: PushPayload = {
        title: text.title,
        body: text.body,
        href: safeHref(msg.href),
        tag: msg.notificationId ?? msg.templateKey,
      };
      const res = await svc.sendToUser(msg.userId, brand, payload, devices);
      if (res.subscriptions === 0) return { delivered: false, skippedReason: 'no_subscription' };
      if (res.sent === 0) return { delivered: false, skippedReason: 'send_failed' };
      if (msg.notificationId) await svc.markNotificationPushed(msg.notificationId).catch(() => undefined);
      return { delivered: true };
    },
  };
}

let channel: DeliveryChannel | null = null;

/** Register the production channel once (idempotent: the same impl every time). */
export function registerWebPushChannel(): DeliveryChannel {
  channel ??= createWebPushChannel();
  registerDeliveryChannel(WEB_PUSH_CHANNEL_ID, channel);
  return channel;
}
