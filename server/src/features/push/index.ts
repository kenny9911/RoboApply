// server/src/features/push/index.ts — public surface of web push (FND-5; owner WP-61).
// The `web_push` delivery channel is registered with alerts.registerDeliveryChannel
// when routes.ts or workers.ts is imported (channel.ts `registerWebPushChannel`).

export * from './contract.js';
export { createPushRouter } from './routes.js';
export type { PushRouterDeps } from './routes.js';
export { PUSH_WORK_KINDS, handlePushSend } from './workers.js';
export { PushService, pushService, safeHref, serializePayload, toSubscriptionView } from './service.js';
export type { PushServiceDeps, SendToUserResult } from './service.js';
export { createWebPushChannel, pushChosen, registerWebPushChannel, WEB_PUSH_BRANDS, WEB_PUSH_CHANNEL_ID } from './channel.js';
export type { WebPushChannelDeps } from './channel.js';
export { vapidConfig, webPushServesBrand } from './config.js';
export type { VapidConfig } from './config.js';
export type { PushRepo, PushSubscriptionRow } from './repo.js';
export type { PushSender, PushSendResult, PushTarget } from './sender.js';
