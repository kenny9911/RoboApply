// server/src/features/billing-cn/contract.ts
//
// GoApply WeChat Pay v3 (TASK_PLAN.md WP-62; capability `pay.wechatpay`:
// the merchant credentials and the entity match; no switch has to be turned
// on, and CN_PAYMENTS_ENABLED=false is the kill switch for new orders, D5).
// WeChat Pay is the second, optional rail beside Alipay (D6). Mounts:
//   /api/v1/roboapply/billing-cn/wechatpay  (seeker)
//   /api/v1/webhooks/wechatpay              (WeChat Pay notify; raw body)
//
// The notify handler reads the raw request `Buffer` (app.ts parses
// /api/v1/webhooks with express.raw before express.json): the platform
// signature covers the exact bytes. Fulfilment is idempotent through
// WP-21a's `fulfilPass()`. No `coaching` purpose on CN rails. Receipts name
// the actual collecting entity; charging stays off until that entity matches
// the merchant (OPS C-13). Passes never renew and nothing is debited
// automatically: "续费" is the user buying the same pass again.

import { z } from 'zod';

export const CN_PURPOSES = ['subscription', 'interview_pack'] as const;
export type CnPurpose = (typeof CN_PURPOSES)[number];
export const WECHATPAY_TRADE_TYPES = ['native', 'h5', 'jsapi'] as const;
export type WechatPayTradeType = (typeof WECHATPAY_TRADE_TYPES)[number];

/** Minutes a WeChat Pay order can be paid before it closes. */
export const WECHATPAY_ORDER_TTL_MINUTES = 15;

/** POST /billing-cn/wechatpay */
export const CreateWechatOrderBodySchema = z
  .object({
    /** The pass or pack to buy (GoApply catalog key, e.g. `pro_monthly`, `practice_pack_5`). */
    planKey: z.string().min(1).max(40).optional(),
    /** Optional cross-check: must match the plan (`interview_pack` for packs, `subscription` for passes). */
    purpose: z.enum(CN_PURPOSES).optional(),
    relatedId: z.string().min(1).max(64).optional(),
    /** Native QR on desktop, H5 in mobile browsers, JSAPI inside WeChat. */
    tradeType: z.enum(WECHATPAY_TRADE_TYPES).default('native'),
    /**
     * Always ignored (kept so older clients still validate). JSAPI pays with
     * the openid the user's WeChat sign-in recorded under the paying app, and
     * answers 409 `wechat_openid_missing` when there is none (the client then
     * falls back to the QR code).
     */
    openId: z.string().max(128).optional(),
    /**
     * Version of the 用户协议 / fee terms the buyer ticked (the `version` of
     * GET /public/legal/terms; no auto-renewal exists on CN passes). It must
     * equal the currently published version, otherwise 409 `terms_outdated`
     * (`details.currentVersion`); the accepted version is stored as a consent
     * record (`CN_PAY_TERMS_CONSENT_TYPE`).
     */
    termsVersion: z.string().min(1).max(40),
  })
  .strict()
  .refine((v) => Boolean(v.planKey) || Boolean(v.purpose), { message: 'Send planKey or purpose.' });

interface CreateWechatOrderBase {
  orderId: string;
  expiresAt: string;
  /** The legal entity that collects the money (shown before paying and on the receipt). */
  collectingEntity: string;
  amountMinor: number;
  currency: 'CNY';
  planKey: string;
}

export type CreateWechatOrderResponse =
  | (CreateWechatOrderBase & { tradeType: 'native'; codeUrl: string })
  | (CreateWechatOrderBase & { tradeType: 'h5'; h5Url: string })
  | (CreateWechatOrderBase & {
      tradeType: 'jsapi';
      jsapi: { appId: string; timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string };
    });

export const OrderParamsSchema = z.object({ orderId: z.string().min(1).max(64) });

/**
 * `needs_support`: WeChat Pay took the money but we could not honour the order
 * as-is (e.g. the amount did not match). Nothing is granted automatically;
 * staff grant it by hand or refund it. The buyer is told to contact support.
 */
export type CnOrderState = 'pending' | 'paid' | 'closed' | 'refunded' | 'failed' | 'needs_support';

export interface CnOrderStatus {
  orderId: string;
  status: CnOrderState;
  planKey: string | null;
  purpose: CnPurpose | null;
  amountMinor: number;
  currency: 'CNY';
  paidAt: string | null;
  /** When an unpaid order stops accepting payment. */
  expiresAt: string;
  tradeType: WechatPayTradeType | null;
  /** The legal entity that collects the money; null when none is configured. */
  collectingEntity: string | null;
  /** Paid passes: the user's Pro access end (a repeat purchase extends it). Null otherwise. */
  accessUntil: string | null;
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
  /**
   * 503 on POST /billing-cn/wechatpay, and only under the kill switch
   * (CN_PAYMENTS_ENABLED=false) on a deployment where WeChat Pay is set up.
   * New orders are refused; the notify and the order status stay open so a
   * payment already in flight is still fulfilled. Never the default state.
   */
  paymentsDisabled: 'payments_disabled',
  planNotSellable: 'plan_not_sellable',
  notifySignatureInvalid: 'notify_signature_invalid',
  /** JSAPI without a known openid under WECHATPAY_APP_ID (409; use Native QR instead). */
  wechatOpenIdMissing: 'wechat_openid_missing',
  /** `purpose` does not match the plan (422). */
  purposeMismatch: 'purpose_mismatch',
  /**
   * The ticked 用户协议 version is not the published one, or none is published
   * (409; `details.currentVersion` is the published version or null). The
   * client reloads the terms and asks the buyer to tick the box again.
   */
  termsOutdated: 'terms_outdated',
} as const;

/** SeekerConsentRecord type for "I agree to the 用户协议 / fee terms" at a WeChat Pay checkout. */
export const CN_PAY_TERMS_CONSENT_TYPE = 'cn_pay_terms_ack';

/** Order creations per user (abuse guard; 429 `rate_limited` beyond it). */
export const BILLING_CN_CREATE_RATE_LIMIT = [
  { limit: 10, windowSec: 60 },
  { limit: 60, windowSec: 86_400 },
] as const;
