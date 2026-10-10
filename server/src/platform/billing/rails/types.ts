// server/src/platform/billing/rails/types.ts
//
// The payment-rail interface (ARCHITECTURE.md §7.4). One implementation per
// rail id; the brand decides which rails exist (`brand.paymentRails`), the
// registry decides which are implemented (registry.ts), and the capability
// resolver decides which are configured (`pay.<rail>`, platform/flags.ts).
//
//   createCheckout(order) → a redirect URL, a QR code URL or JSAPI params
//   verifyCallback(input) → { outTradeNo, status, paidAmountMinor }
//
// WeChat Pay (WP-62) registers with `registerRail('wechatpay', impl)` and
// fulfils paid orders through `fulfilPass()` — no billing file changes.

import type { EnvSource } from '../../brand/brandEnv.js';
import type { PaymentRail, ProductBrand } from '../../brand/registry.js';
import type { CatalogPlan } from '../planCatalog.js';

export type { PaymentRail } from '../../brand/registry.js';

export interface CheckoutOrder {
  brand: ProductBrand;
  plan: CatalogPlan;
  user: { id: string; email: string; name: string | null };
  seekerProfileId: string;
  /** Existing Stripe customer, when the user has one. */
  stripeCustomerId?: string | null;
  acknowledgements: {
    /** The unticked auto-renewal box was ticked (required for auto-renewing plans). */
    autoRenewAck: boolean;
    /** The withdrawal waiver was ticked (EU/UK/TW). */
    withdrawalWaiver: boolean;
  };
  /** Same-origin return paths (already sanitised). */
  successPath?: string;
  cancelPath?: string;
  /** CN rails: how the payer pays (WeChat Pay: Native QR / H5 / JSAPI). */
  context?: { tradeType?: 'native' | 'h5' | 'jsapi'; openId?: string };
  /**
   * Buyer's country from the edge (WP-79): 'TW' charges the plan's Taiwan
   * price when one is configured — the same rule the plan sheet showed.
   * Omitted → the plan's base currency.
   */
  country?: string | null;
  /**
   * The buyer holds a live student verification (WP-79). Student plans are
   * refused unless this is exactly `true`; the caller reads it from
   * `studentService.isVerified(userId)` (features/account-v2).
   */
  studentVerified?: boolean;
}

export type CheckoutResult =
  | { kind: 'redirect'; url: string; orderId: string | null }
  | { kind: 'qr'; qrCodeUrl: string; orderId: string; expiresAt?: string }
  | { kind: 'jsapi'; jsapiParams: Record<string, string>; orderId: string };

export interface CallbackInput {
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body for rails that sign bytes (WeChat Pay v3). */
  rawBody?: Buffer;
}

export interface CallbackVerification {
  /** Our order number (AlipayOrder.outTradeNo). */
  outTradeNo: string;
  status: 'paid' | 'closed' | 'pending';
  /** Amount the provider says was paid, minor units; null when it did not say. */
  paidAmountMinor: number | null;
  transactionId: string | null;
}

export interface PaymentRailImpl {
  id: PaymentRail;
  /** Rail-specific configuration beyond the `pay.<rail>` capability (e.g. the CN collecting entity). */
  isConfigured(brand: ProductBrand, env: EnvSource): boolean;
  createCheckout(order: CheckoutOrder): Promise<CheckoutResult>;
  /** Provider callback verification. Throws CallbackRejectedError on a bad signature/secret. */
  verifyCallback?(input: CallbackInput): Promise<CallbackVerification>;
}

export type CallbackRejectReason = 'bad_secret' | 'not_configured' | 'invalid_params';

export class CallbackRejectedError extends Error {
  readonly code = 'callback_rejected' as const;
  /** bad_secret → 403; not_configured → 503 (the provider retries once it is set); invalid_params → 400. */
  readonly reason: CallbackRejectReason;
  constructor(message = 'Callback rejected', reason: CallbackRejectReason = 'invalid_params') {
    super(message);
    this.name = 'CallbackRejectedError';
    this.reason = reason;
  }
}
