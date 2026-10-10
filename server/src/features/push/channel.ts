// server/src/features/push/channel.ts — the `web_push` delivery channel (WP-61).
//
// Registered with WP-39a's `registerDeliveryChannel('web_push', impl)`, so
// every job alert, reminder and lifecycle message that `deliverMessage` fans
// out (in-app first, then email, then the registered channels) is mirrored to
// the person's devices when they subscribed. The channel:
//   - serves both brands (D5), each behind its own `webPush` flag and VAPID
//     set (GoApply: `CN_VAPID_*` when `CN_VAPID_PUBLIC_KEY` is set, else the
//     shared pair);
//   - is unconfigured when no brand has VAPID keys (the runner skips it); a
//     message for a brand without keys is skipped 'not_configured';
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
import { vapidConfig, WEB_PUSH_BRANDS } from './config.js';
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

  /** Why this brand cannot push right now, or null when it can. */
  const brandReady = (brand: ProductBrand): 'feature_disabled' | 'not_configured' | null => {
    if (!isEnabledForBrand('webPush', brand, env())) return 'feature_disabled';
    return vapidConfig(brand, env()) === null ? 'not_configured' : null;
  };

  return {
    id: WEB_PUSH_CHANNEL_ID,
    brands: WEB_PUSH_BRANDS,
    // The runner asks once for the channel, not per brand: on when any brand can push.
    isConfigured() {
      return WEB_PUSH_BRANDS.some((id) => brandReady(getBrand(id)) === null);
    },
    async deliver(msg: DeliveryMessage): Promise<DeliveryResult> {
      const brand = getBrand(msg.brand);
      // This brand's own switch and keys (FLAG_GOAPPLY_WEB_PUSH=false turns GoApply off and leaves RoboApply on).
      const notReady = brandReady(brand);
      if (notReady) return { delivered: false, skippedReason: notReady };
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
