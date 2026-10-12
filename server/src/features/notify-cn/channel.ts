// server/src/features/notify-cn/channel.ts — the `wechat_mp` delivery channel (WP-73).
//
// Registered with WP-39a's `registerDeliveryChannel('wechat_mp', impl)` when
// routes.ts is imported, so a message `deliverMessage` fans out (in-app
// first, then email, then each registered channel) is mirrored to WeChat
// when it has a WeChat template. The channel:
//   - serves GoApply only and is unconfigured without `WECHAT_MP_*`
//     (`notify.wechat`), so the runner skips it;
//   - maps the message's template key to one of the three WeChat templates;
//     every other message (job alerts, tips, …) has no WeChat template and is
//     skipped 'no_wechat_template' (SMS is never a fallback);
//   - leaves every other check (linked account, the person's channel
//     choice, an accepted prompt left, the template id) to `sendNotice`,
//     which also stamps `pushSentAt` on the in-app row it mirrors.
// Producers that write their inbox row directly (the campus calendar today)
// and the practice-report / payment producers call
// `notifyCnService().sendNotice(...)` themselves.

import { registerDeliveryChannel, type DeliveryChannel, type DeliveryMessage, type DeliveryResult } from '../alerts/index.js';
import type { WechatTemplateKey } from './contract.js';
import { notifyCnService, type NotifyCnService } from './service.js';

export const WECHAT_MP_CHANNEL_ID = 'wechat_mp' as const;
export const WECHAT_MP_BRANDS = ['goapply'] as const;

/** Message template keys (email `notify.*` and inbox keys) that have a WeChat template. */
export const WECHAT_TEMPLATE_FOR_MESSAGE: Readonly<Record<string, WechatTemplateKey>> = {
  'notify.campus_deadline': 'deadline_reminder',
  'campus.deadline': 'deadline_reminder',
};

export interface WechatMpChannelDeps {
  service?: () => NotifyCnService;
}

export function createWechatMpChannel(deps: WechatMpChannelDeps = {}): DeliveryChannel {
  const service = deps.service ?? notifyCnService;
  return {
    id: WECHAT_MP_CHANNEL_ID,
    brands: WECHAT_MP_BRANDS,
    isConfigured: () => service().configured(),
    async deliver(msg: DeliveryMessage): Promise<DeliveryResult> {
      if (msg.brand !== 'goapply') return { delivered: false, skippedReason: 'feature_disabled' };
      const template = WECHAT_TEMPLATE_FOR_MESSAGE[msg.templateKey];
      if (!template) return { delivered: false, skippedReason: 'no_wechat_template' };
      return service().sendNotice({
        userId: msg.userId,
        template,
        params: msg.params as never,
        href: msg.href,
        notificationId: msg.notificationId,
        category: msg.category,
        eventId: typeof msg.params?.eventId === 'string' ? msg.params.eventId : null,
      });
    },
  };
}

let channel: DeliveryChannel | null = null;

/** Register the production channel once (idempotent: the same impl every time). */
export function registerWechatMpChannel(): DeliveryChannel {
  channel ??= createWechatMpChannel();
  registerDeliveryChannel(WECHAT_MP_CHANNEL_ID, channel);
  return channel;
}
