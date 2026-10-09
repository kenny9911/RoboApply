// lib/api/billingCn.ts — GoApply WeChat Pay orders.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-62.
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// The WeChat Pay notify webhook (`/api/v1/webhooks/wechatpay`) is
// server-to-server and is not wrapped.
//
// Endpoints:
//   POST   /api/v1/roboapply/billing-cn/wechatpay
//   GET    /api/v1/roboapply/billing-cn/wechatpay/orders/:orderId

import { call, type CallOptions, type In, seg } from './contracts/wire';
import type * as B from './contracts/billing-cn';

/** `billingCn.createOrder` — POST /api/v1/roboapply/billing-cn/wechatpay */
export function createWechatPayOrder(body: In<typeof B.CreateWechatOrderBodySchema>, opts?: CallOptions): Promise<B.CreateWechatOrderResponse> {
  return call<B.CreateWechatOrderResponse>('POST', `/api/v1/roboapply/billing-cn/wechatpay`, { ...opts, body });
}

/** `billingCn.orderStatus` — GET /api/v1/roboapply/billing-cn/wechatpay/orders/:orderId */
export function getWechatPayOrder(orderId: string, opts?: CallOptions): Promise<B.CnOrderStatus> {
  return call<B.CnOrderStatus>('GET', `/api/v1/roboapply/billing-cn/wechatpay/orders/${seg(orderId)}`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const billingCnApi = {
  createWechatPayOrder,
  getWechatPayOrder,
};
