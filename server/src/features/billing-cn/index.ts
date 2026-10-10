// server/src/features/billing-cn/index.ts — public surface (FND-5; filled by WP-62).
//
// GoApply WeChat Pay: the seeker router, the raw-body notify router and the
// service (createOrder / orderStatus / handleNotify). The rail itself lives in
// platform/billing/rails/wechatpay.ts and is registered with WP-21a's
// `registerRail('wechatpay', …)` when the router module loads.

export * from './contract.js';
export { createWechatPayNotifyRouter, createWechatPayRouter } from './routes.js';
export { BillingCnError, BillingCnService, billingCnService } from './service.js';
export type { BillingCnDeps, CreateWechatOrderInput, NotifyOutcome, RequestMeta } from './service.js';
