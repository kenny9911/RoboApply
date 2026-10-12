// server/src/features/notify-cn/index.ts — public surface (FND-5; owner WP-73).
//
// Other areas import notify-cn only from here:
//   - `notifyCnService().sendNotice({ userId, template, params, href, notificationId, eventId })`
//     for producers that write their own inbox row (campus 网申截止 WP-58 — wired:
//     the final reminder of a 'wechat' subscription; practice report ready and
//     WeChat Pay success are not wired yet). Params per template:
//     `NOTICE_PARAM_SCHEMAS` (contract.ts). Returns a DeliveryResult; never
//     throws for expected skips.
//   - the `wechat_mp` delivery channel is registered with
//     alerts.registerDeliveryChannel when routes.ts is imported.

export * from './contract.js';
export { createNotifyCnRouter, createWechatMpWebhookRouter } from './routes.js';
export type { NotifyCnRouterDeps } from './routes.js';
export { NotifyCnService, notifyCnService, wechatChosen } from './service.js';
export type { NoticeOutcome, NotifyCnServiceDeps } from './service.js';
export { createWechatMpChannel, registerWechatMpChannel, WECHAT_MP_BRANDS, WECHAT_MP_CHANNEL_ID, WECHAT_TEMPLATE_FOR_MESSAGE } from './channel.js';
export { configuredTemplates, mpApp, templateConfig, DEFAULT_TEMPLATE_FIELDS, TEMPLATE_SOURCES } from './config.js';
export type { TemplateConfig } from './config.js';
export type { NotifyCnRepo } from './repo.js';
