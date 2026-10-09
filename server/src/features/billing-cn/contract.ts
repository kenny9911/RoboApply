// server/src/features/billing-cn/contract.ts
//
// GoApply WeChat Pay v3 (TASK_PLAN.md WP-62; R-15; capability
// `pay.wechatpay`, which also needs CN_PAYMENTS_ENABLED=true). Mounts:
//   /api/v1/roboapply/billing-cn/wechatpay  (seeker)
//   /api/v1/webhooks/wechatpay              (WeChat Pay notify; raw body)
//
// The notify handler reads the raw request `Buffer` (app.ts parses
// /api/v1/webhooks with express.raw before express.json): the platform
// signature covers the exact bytes. Fulfilment is idempotent through
// WP-21a's `fulfilPass()`. No `coaching` purpose on CN rails. Receipts name
// the actual collecting entity.

import { z } from 'zod';

export const CN_PURPOSES = ['subscription', 'interview_pack'] as const;
export const WECHATPAY_TRADE_TYPES = ['native', 'h5', 'jsapi'] as const;

/** POST /billing-cn/wechatpay */
export const CreateWechatOrderBodySchema = z
  .object({
    planKey: z.string().min(1).max(40).optional(),
    purpose: z.enum(CN_PURPOSES).optional(),
    relatedId: z.string().min(1).max(64).optional(),
    /** Native QR on desktop, H5 in mobile browsers, JSAPI inside WeChat. */
    tradeType: z.enum(WECHATPAY_TRADE_TYPES).default('native'),
    /** Required for JSAPI: the user's openid under the paying app. */
    openId: z.string().max(128).optional(),
    /** Auto-renewal does not exist on CN passes; acknowledgement of the terms version shown. */
    termsVersion: z.string().min(1).max(40),
  })
  .strict()
  .refine((v) => Boolean(v.planKey) || Boolean(v.purpose), { message: 'Send planKey or purpose.' })
  .refine((v) => v.tradeType !== 'jsapi' || Boolean(v.openId), { message: 'JSAPI needs openId.' });

export type CreateWechatOrderResponse =
  | { orderId: string; tradeType: 'native'; codeUrl: string; expiresAt: string }
  | { orderId: string; tradeType: 'h5'; h5Url: string; expiresAt: string }
  | {
      orderId: string;
      tradeType: 'jsapi';
      jsapi: { appId: string; timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string };
      expiresAt: string;
    };

export const OrderParamsSchema = z.object({ orderId: z.string().min(1).max(64) });
export interface CnOrderStatus {
  orderId: string;
  status: 'pending' | 'paid' | 'closed' | 'refunded' | 'failed';
  planKey: string | null;
  amountMinor: number;
  currency: 'CNY';
  paidAt: string | null;
}

/** WeChat Pay v3 notify headers used for verification. */
export const WECHATPAY_NOTIFY_HEADERS = [
  'wechatpay-timestamp',
  'wechatpay-nonce',
  'wechatpay-signature',
  'wechatpay-serial',
  'wechatpay-signature-type',
] as const;

/** Notify success/failure body WeChat Pay expects. */
export interface WechatNotifyAck {
  code: 'SUCCESS' | 'FAIL';
  message: string;
}

export const BILLING_CN_ERROR_CODES = {
  paymentsDisabled: 'payments_disabled',
  planNotSellable: 'plan_not_sellable',
  notifySignatureInvalid: 'notify_signature_invalid',
} as const;
