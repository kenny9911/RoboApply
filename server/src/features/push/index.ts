// server/src/features/push/index.ts — public surface of web push (FND-5; owner WP-61).
// The `web_push` delivery channel is registered with alerts.registerDeliveryChannel
// when routes.ts or workers.ts is imported (channel.ts `registerWebPushChannel`).

export * from './contract.js';
export { createPushRouter } from './routes.js';
export { handlePushSend } from './workers.js';
export { PushService, safeHref, serializePayload } from './service.js';
export { createWebPushChannel, pushChosen, registerWebPushChannel, WEB_PUSH_BRANDS } from './channel.js';
export { vapidConfig, webPushServesBrand } from './config.js';
export type { PushSender, PushSendResult } from './sender.js';
