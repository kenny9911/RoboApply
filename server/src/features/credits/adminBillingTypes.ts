// server/src/features/credits/adminBillingTypes.ts — request schemas and
// response types of the admin billing routes (adminRoutes.ts, adminBilling.ts)
// and the one rule that says whether a billing row counts as refunded.
//
// Mounted under /api/v1/roboapply/admin/credits (admin only):
//   POST /refunds                    AdminRefundBody → AdminRefundResponse
//   GET  /refunds?userId=&cursor=    → AdminRefundListResponse (50 a page, newest first)
//   GET  /cn-orders?userId=          → AdminCnOrdersResponse
//   POST /cn-orders/:orderId/refund  RecordCnRefundBody → RecordCnRefundResponse
//   GET  /practice-cost              → PracticeCostResponse
//   GET  /stripe-health?prices=      → StripeHealthResponse (`prices=1` adds the price check)
//
// The web console writes these shapes by hand from the same text
// (lib/api/adminBilling.ts); this file is not a mirrored contract.
//
// Only zod is imported here, so the billing service can use the refund-marker
// rule without loading the admin service.

import { z } from 'zod';

// ── Refunds (Stripe) ──────────────────────────────────────────────────────

/** One refund decision: the shape the web already makes for a checkout attempt (a UUID fits). */
export const REFUND_ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const stripeId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`));

/** A paid invoice, or a one-time Checkout Session. Exactly one of the two keys. */
export const AdminRefundTargetSchema = z.union([
  z.object({ invoiceId: stripeId('in') }).strict(),
  z.object({ checkoutSessionId: stripeId('cs') }).strict(),
]);

export const AdminRefundBodySchema = z.object({
  userId: z.string().min(1).max(64),
  target: AdminRefundTargetSchema,
  /** Minor units; omitted = everything that is still refundable. */
  amountMinor: z.number().int().positive().max(100_000_000).optional(),
  reason: z.string().trim().min(1).max(300),
  /**
   * Names this one refund decision: one value per refund dialog, the same
   * value when that dialog retries. It is the last part of the Stripe
   * idempotency key, so a second refund of the same amount on one payment is a
   * new request and a retry is not. The `Idempotency-Key` header is read when
   * the body carries none; a refund without either is refused (422).
   */
  attemptKey: z.string().regex(REFUND_ATTEMPT_KEY_PATTERN).optional(),
});
export type AdminRefundBody = z.infer<typeof AdminRefundBodySchema>;

export interface AdminRefundResponse {
  refundId: string;
  amountMinor: number;
  currency: string;
  /** Nothing of the payment is left to refund after this one. */
  full: boolean;
}

export const AdminRefundListQuerySchema = z.object({
  userId: z.string().min(1).max(64).optional(),
  cursor: z.string().min(1).max(256).optional(),
});
export type AdminRefundListQuery = z.infer<typeof AdminRefundListQuerySchema>;

export type AdminRefundKind = 'refund' | 'withdrawal' | 'dispute' | 'manual_cn';

/** One RABillingRefund row. */
export interface AdminRefundRow {
  id: string;
  userId: string;
  brand: string;
  rail: string;
  kind: AdminRefundKind;
  amountMinor: number;
  currency: string;
  full: boolean;
  entitlementReversed: boolean;
  reason: string | null;
  /** An admin's user id, 'self', 'public_link' or 'stripe'. */
  actor: string | null;
  invoiceId: string | null;
  checkoutSessionId: string | null;
  alipayOrderId: string | null;
  createdAt: string;
}

export interface AdminRefundListResponse {
  items: AdminRefundRow[];
  cursor: string | null;
}

/** Rows a page of GET /refunds holds. */
export const ADMIN_REFUND_PAGE_SIZE = 50;

// ── The refunded marker ───────────────────────────────────────────────────

export type RefundedMark = 'full' | 'partial';

/**
 * Whether a billing row (a Stripe invoice, a CN order) counts as refunded,
 * from its RABillingRefund rows: 'full' when one of them says nothing of the
 * payment is left (`full`) or is a dispute (a dispute always takes the whole
 * payment back), 'partial' when there are rows and none of them is, null
 * without rows. One rule for the billing history and the admin order list.
 */
export function refundedMarkOf(rows: ReadonlyArray<{ kind: string; full: boolean }>): RefundedMark | null {
  if (rows.length === 0) return null;
  return rows.some((row) => row.full || row.kind === 'dispute') ? 'full' : 'partial';
}

// ── Manual refund record for CN orders (AL-7) ─────────────────────────────

export const AdminCnOrdersQuerySchema = z.object({ userId: z.string().min(1).max(64) });

export interface AdminCnOrderRow {
  /** AlipayOrder.id: what POST /cn-orders/:orderId/refund takes (not the order number). */
  id: string;
  outTradeNo: string;
  planKey: string;
  channel: 'alipay' | 'wechatpay';
  /** Fen. */
  amountMinor: number;
  completedAt: string;
  refunded: RefundedMark | null;
  /**
   * Present (and true) only when the order's refund is on record in full and
   * the reversal of what it bought failed: the record stopped half way, and
   * the same record call finishes it. The console offers "Check the record"
   * for such a row (M4 gate; MKT-4C's request to MKT-4B). Omitted otherwise.
   */
  reversalPending?: true;
}

export interface AdminCnOrdersResponse {
  items: AdminCnOrderRow[];
}

export const AdminCnOrderParamsSchema = z.object({ orderId: z.string().min(1).max(64) });

export const RecordCnRefundBodySchema = z.object({
  reason: z.string().trim().min(1).max(300),
  /** The money was already returned in the merchant console. Nothing is recorded without it. */
  confirmMoneyReturned: z.literal(true),
  /** Fen; omitted = the whole order. A smaller amount is recorded and changes no access. */
  refundedAmountMinor: z.number().int().positive().optional(),
});
export type RecordCnRefundBody = z.infer<typeof RecordCnRefundBodySchema>;

export type CnRefundEntitlement = 'pass_ended' | 'pass_shortened' | 'pack_zeroed' | 'none';

export interface RecordCnRefundResponse {
  status: 'recorded' | 'already_recorded';
  orderId: string;
  /** What the record did to the account ('none' for a partial amount, and for a pass or pack that was already over). */
  entitlement: CnRefundEntitlement;
}

// ── Practice cost (PC-5) ──────────────────────────────────────────────────

/** Sessions averaged per brand, and the fewest an average is shown for. */
export const PRACTICE_COST_MAX_SESSIONS = 50;
export const PRACTICE_COST_MIN_SESSIONS = 10;

export interface PracticeCost {
  /** Sessions in the average (at most 50, the most recent ones). */
  sampleSize: number;
  /** USD per session, as the usage log stores it; null under 10 sessions. */
  averageUsd: number | null;
  enough: boolean;
  maxSessions: typeof PRACTICE_COST_MAX_SESSIONS;
  minSessions: typeof PRACTICE_COST_MIN_SESSIONS;
  /** When the oldest and the newest session of the sample were recorded. */
  oldest: string | null;
  newest: string | null;
}

export interface PracticeCostResponse {
  brands: { roboapply: PracticeCost; goapply: PracticeCost };
}

// ── Stripe health (ST-3) ──────────────────────────────────────────────────

export interface StripeHealthResponse {
  keyMode: 'none' | 'test' | 'live';
  /** A Stripe client may be built from this environment. */
  usable: boolean;
  refusedReason: 'missing' | 'live_key_outside_production' | null;
  /** How many webhook signing secrets are configured (never the secrets). */
  webhookSecrets: number;
  /** A usable key and a webhook secret the webhook can verify with. */
  railReady: boolean;
  endpoint: {
    /** False when the check was not made: no usable key, or the key may not read webhook endpoints. */
    checked: boolean;
    url: string | null;
    missingEvents: string[];
    reason?: 'not_found' | 'restricted_key' | 'error';
  };
  /** Plan keys whose Stripe price is pinned by the environment (never the price ids). */
  pinnedPlans: string[];
  /**
   * The price check. Sent only when the request asks for it (`?prices=1`): it
   * reads one price per pin and one list per group of lookup keys, so the
   * default answer stays one Stripe call.
   */
  prices?: StripeHealthPrices;
}

/** `?prices=1` (or `true`) asks for the price check; `0`, `false` or nothing does not. Another value is refused (422). */
export const StripeHealthQuerySchema = z.object({
  prices: z
    .enum(['1', 'true', '0', 'false'])
    .optional()
    .transform((value) => value === '1' || value === 'true'),
});

export type StripePriceProblem =
  /** A pinned price Stripe does not know: checkout on this plan fails. */
  | 'pin_not_found'
  /** A pinned price whose amount, currency or renewal differs from the catalog: the buyer is shown one price and charged another. */
  | 'pin_mismatch'
  /** A pinned price that was archived: checkout on this plan fails. */
  | 'pin_archived'
  /** The synced price was archived and no active one replaces it: a running instance may still send it. */
  | 'synced_archived'
  /** The active synced price differs from the catalog (checkout refuses to sell on it). */
  | 'synced_mismatch';

export interface StripeHealthPriceShape {
  amountMinor: number | null;
  currency: string | null;
  /** Null for a one-time price (a pass, a pack). */
  recurring: { interval: string; intervalCount: number } | null;
}

/** One price that is not what the catalog says. Named by plan and currency, never by price id. */
export interface StripeHealthPriceIssue {
  planKey: string;
  currency: string;
  problem: StripePriceProblem;
  /** What the catalog charges. */
  expected: StripeHealthPriceShape;
  /** What Stripe holds; null when it holds no such price. */
  found: (StripeHealthPriceShape & { active: boolean }) | null;
}

export interface StripeHealthPrices {
  /** False when the check was not made: no usable key, or the key may not read prices. */
  checked: boolean;
  /** How many pinned prices were read, and how many plans were looked up by their lookup key. */
  pinsChecked: number;
  lookupKeysChecked: number;
  issues: StripeHealthPriceIssue[];
  reason?: 'restricted_key' | 'error';
}

// ── Errors ────────────────────────────────────────────────────────────────

export const ADMIN_BILLING_ERROR_STATUS = {
  /** The CN order exists but was never paid (pending, closed or failed): there is no refund to record. */
  order_not_completed: 409,
} as const;

export type AdminBillingErrorCode = keyof typeof ADMIN_BILLING_ERROR_STATUS;

/** A refusal of an admin billing action that is not one of the shared billing or HTTP codes. */
export class AdminBillingError extends Error {
  readonly code: AdminBillingErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: AdminBillingErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AdminBillingError';
    this.code = code;
    this.status = ADMIN_BILLING_ERROR_STATUS[code];
    this.details = details;
  }
}
