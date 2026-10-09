// server/src/features/notify-cn/index.ts — public surface (FND-5; owner WP-73).
// WP-73 registers the `wechat_mp` delivery channel with alerts.registerDeliveryChannel.

export * from './contract.js';
export { createNotifyCnRouter, createWechatMpWebhookRouter } from './routes.js';
