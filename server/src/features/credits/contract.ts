// server/src/features/credits/contract.ts
//
// Credits, plans, cancellation and admin caps (ARCHITECTURE.md §3.9, §7;
// TASK_PLAN.md R-07, R-08, R-25, WP-21a/21b). Mounts:
//   /api/v1/roboapply/credits        (seeker)
//   /api/v1/roboapply/billing/plans  (S/P; new path — legacy /billing routes untouched)
//   /api/v1/public/cancel            (public one-click cancel flow, §312k BGB)
//   /api/v1/roboapply/admin/credits  (admin)
//
// Honesty: caps print as "Up to N a day" — never "unlimited"; no offers at
// launch, no struck-through anchors, weekly never preselected; plan prices
// only from `getPlanCatalog` (catalog defaults with optional overrides on
// both brands: GoApply in fen, RoboApply in cents), never from copy.

import { z } from 'zod';
import type { EntitlementSummary } from '../../platform/credits/summary.js';
import type { CreditCatalog, CreditCatalogOverride } from '../../platform/credits/catalog.js';
import type { PlanView } from '../../platform/billing/planViews.js';
import type { RefundDecision } from '../../platform/billing/refunds.js';
import type { CheckoutResult, PaymentRail } from '../../platform/billing/rails/types.js';

/** GET /credits → the same summary `/auth/me.entitlements` carries (caps, usage, reset times, plan). */
export interface CreditsResponse {
  summary: EntitlementSummary;
  /** Practice interview credits (delegated to mockCreditService). */
  practice: {
    balance: number;
    /** Credits the current period granted ("2 of 3 left"); null when unknown. */
    periodAllotment?: number | null;
    /** Minutes one credit covers (RA_MOCK_CREDIT_MINUTES, default 20). */
    creditMinutes?: number;
  } | null;
}

/**
 * GET /credits/history?cursor — credit uses, newest first: committed metered
 * actions, and practice interviews (`bucket: 'practice'`, `fromSource:
 * 'mock_credit'`). A practice interview's `amount` is the credits it took and
 * can be a fraction (they are pro-rated by minutes).
 */
export const CreditHistoryQuerySchema = z.object({ cursor: z.string().max(256).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
export interface CreditLedgerView {
  id: string;
  bucket: string;
  amount: number;
  sku: string | null;
  fromSource: string;
  at: string;
}

/** POST /credits/cancel — cancel the subscription in one click (survey optional, afterwards). */
export const CancelSubscriptionBodySchema = z
  .object({ reason: z.string().max(80).optional(), note: z.string().max(1000).optional() })
  .strict();
export interface CancelResponse {
  status: 'cancelled' | 'already_cancelled';
  /** Access continues until this time. */
  accessUntil: string | null;
  /** One-time, non-blocking alternative ("Switch to the 7-day pass instead?"). */
  alternative: { planKey: 'pro_week_pass' } | null;
}

/**
 * POST /credits/cancel/survey — the optional "why did you cancel?" answer,
 * sent after the cancel. It only stores the answer (model RACancelSurvey): it
 * never cancels anything, sends no email and records no product event, so
 * sending it twice cannot repeat a side effect of the cancel. Answers 204;
 * 503 `storage_unavailable` while the table is not in the database.
 */
export const CANCEL_SURVEY_REASONS = ['price', 'found_job', 'not_useful', 'pause', 'other'] as const;
export type CancelSurveyReason = (typeof CANCEL_SURVEY_REASONS)[number];
export const CancelSurveyBodySchema = z
  .object({ reason: z.enum(CANCEL_SURVEY_REASONS).optional(), note: z.string().trim().max(1000).optional() })
  .strict()
  .refine((v) => Boolean(v.reason) || Boolean(v.note), { message: 'Send a reason or a note.' });

/**
 * POST /billing/checkout and /billing/alipay (legacy mount; this is the one
 * shape both sides use). `kind` says what the buyer does next:
 *   - `redirect`: open `url` (Stripe Checkout, the Alipay cashier, WeChat Pay H5);
 *   - `qr`: `qrCodeUrl` is the CONTENT of a payment code (WeChat Pay sends a
 *     `weixin://` link). Draw a QR code from it; it is never an image address;
 *   - `jsapi`: hand `jsapiParams` to the WeChat in-app cashier.
 * `orderId` is our order number (null for Stripe sessions that have none
 * yet); `rail` is the rail that took the order.
 */
export type CheckoutResponse = CheckoutResult & { rail: PaymentRail };

/**
 * The numbers of the published refund rules (platform/billing/refunds.ts),
 * so /pricing prints them from the API and never from copy: first purchase
 * within `firstPurchaseDays` days (weekly plan and 7-day pass:
 * `shortPlanHours` hours) if fewer than `paidOnlyCreditLimit` paid-only
 * credits were used; a renewal charged by mistake within
 * `accidentalRenewalDays` days; statutory withdrawal within `withdrawalDays`
 * days; practice packs stay valid `packValidMonths` months.
 */
export interface PlansRefundPolicy {
  firstPurchaseDays: number;
  shortPlanHours: number;
  paidOnlyCreditLimit: number;
  accidentalRenewalDays: number;
  withdrawalDays: number;
  packValidMonths: number;
  /**
   * The public label of this brand's policy version: the rule set's name
   * without any internal review note (the full value stays with stored refund
   * decisions). Never contains "pending".
   */
  version: string;
}

/** One line of the published student rule. Amounts are in the brand's currency. */
export interface PlansStudentOffer {
  key: 'student_monthly' | 'student_quarterly';
  amountMinor: number;
  /** % below the regular plan, computed from the two catalog amounts (rounded down); null when there is no saving. */
  studentDiscountPercent: number | null;
}

/**
 * GET /billing/plans (public; signed-in users also get `current`).
 *
 * `checkout.collectingEntity`, `refundPolicy` and `studentOffer` were added
 * in the market wave. This server always sends them (`PlansResponseSent`);
 * they are optional here so a client reads each with a safe default and keeps
 * working against a response that predates them.
 */
export interface PlansResponse {
  /**
   * The brand's plans with their prices; `sellable` false → shown, not
   * purchasable. Every paid plan of either brand carries an amount (a catalog
   * default or its override). A GoApply plan is sellable unless the kill
   * switch is thrown; a RoboApply plan is sellable while the Stripe rail is
   * ready (a usable key and a webhook secret). Otherwise
   * `unsellableReason: 'payments_disabled'`, with the amount still listed.
   * Student plans (`requiresFlag: 'student'`), while the `student` capability
   * is on (never without it):
   *   - GoApply: in the list only for a signed-in, verified student; everyone
   *     else reads the prices in `studentOffer`;
   *   - RoboApply: in the list for EVERY caller, a visitor included
   *     (`studentOffer` is always null there). Being listed is not being
   *     allowed to buy: checkout refuses a student plan without a confirmed
   *     school email (`student_verification_required`). A client that offers
   *     plans to choose from must leave them out for a buyer who is not
   *     verified (the plan sheet's `visiblePlans` does).
   * One listing rule for both brands is an owner decision (service.ts, P7).
   */
  plans: PlanView[];
  /** Never a weekly plan or the 7-day pass. */
  defaultSelection: string | null;
  currency: 'USD' | 'CNY';
  /**
   * A payment can be opened now: at least one plan is sellable AND at least
   * one rail can charge (`checkout.rails` is not empty). False on a brand
   * whose rail credential is missing (plans and prices still list) and under
   * the GoApply kill switch. The web shows its "not open yet" note only when
   * this is false. (Cross-bundle contract: the pricing page reads it too.)
   */
  paymentsOpen: boolean;
  checkout: {
    /**
     * Rails that can take a payment now, in the order to offer them: the
     * first is the default. GoApply: `alipay` first (with
     * ALIPAY_CALLBACK_SECRET), then `wechatpay` when its merchant is set up;
     * RoboApply: `stripe` (with a usable key and a webhook secret). Empty
     * when no rail can charge.
     */
    rails: Array<'stripe' | 'alipay' | 'wechatpay'>;
    /** Show the EU/UK/TW withdrawal-waiver box (edge country of this request). */
    showWithdrawalWaiver: boolean;
    country: string | null;
    /** Stored with each acknowledgement record. */
    acknowledgementVersion: string;
    /**
     * GoApply only: the entity that collects the money
     * (`CN_PAYMENT_COLLECTING_ENTITY`), printed on /pricing next to the rules.
     * Null on RoboApply and whenever none is configured: the page then prints
     * no entity line (never a made-up name).
     */
    collectingEntity?: string | null;
  };
  /** The numbers of the published refund rules; /pricing hides the section while this is absent. */
  refundPolicy?: PlansRefundPolicy;
  /**
   * The published student rule: the brand's student prices with the computed
   * percentage below the regular plan, for a caller who is NOT sent the
   * student plans themselves (on GoApply the buyable student rows in `plans`
   * reach a signed-in, verified student only), while the `student` capability
   * is on. Null when the student plans are in `plans` already, or the
   * capability is off. A price list only: nothing here can be bought with.
   */
  studentOffer?: PlansStudentOffer[] | null;
  /** TWD reference line (R-25): only when an admin rate ≤45 days old exists; null otherwise. */
  fxReference: {
    currency: 'TWD';
    ratePerUsd: number;
    source: string;
    asOf: string;
    /** Whole NT$ per plan key for plans with a USD price. */
    amounts: Record<string, number>;
  } | null;
  /** Always empty at launch (no offers, H23). */
  offers: never[];
}

/** What this server answers on GET /billing/plans: every additive field present. */
export type PlansResponseSent = PlansResponse & {
  checkout: PlansResponse['checkout'] & { collectingEntity: string | null };
  refundPolicy: PlansRefundPolicy;
  studentOffer: PlansStudentOffer[] | null;
};

/** Public cancel flow: POST /api/v1/public/cancel {email} → 204 always; emails a single-use 30-min link. */
export const PublicCancelRequestBodySchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();
/** POST /api/v1/public/cancel/confirm {token} → CancelResponse; sends a confirmation email. */
export const PublicCancelConfirmBodySchema = z.object({ token: z.string().min(16).max(512) }).strict();

// ── Admin (/admin/credits) ───────────────────────────────────────────────

/** PUT /admin/credits/catalog — validated by platform/credits CreditCatalogOverrideSchema (AppConfig credits.catalog.v1). */
export const PutCatalogBodySchema = z.object({ override: z.unknown() }).strict();

/** GET/PUT /admin/credits/catalog response. */
export interface CatalogAdminResponse {
  /** The stored override (null = defaults only). */
  override: CreditCatalogOverride | null;
  /** Why a stored blob was ignored, when it was invalid. */
  error: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  defaults: Record<'roboapply' | 'goapply', CreditCatalog>;
  effective: Record<'roboapply' | 'goapply', CreditCatalog>;
}

/** An entitlement override row (admin). */
export interface CreditOverrideAdminView {
  id: string;
  userId: string;
  key: string;
  value: unknown;
  reason: string;
  adminId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export const ListOverridesQuerySchema = z.object({ userId: z.string().min(1).max(64).optional(), cursor: z.string().max(256).optional() });
/** `RAEntitlementOverride.key`: 'bucket:<b>' | 'entitlement:<k>' | 'flag:<key>'; value number | boolean (| hiringContacts mode). */
export const CreateOverrideBodySchema = z
  .object({
    userId: z.string().min(1).max(64),
    key: z.string().regex(/^(bucket|entitlement|flag):[A-Za-z0-9_.]+$/),
    value: z.union([z.number().int().min(0).max(10_000), z.boolean(), z.enum(['off', 'deeplinks_only', 'on'])]),
    expiresAt: z.iso.datetime().optional(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();
export const OverrideParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** TWD reference line (R-25, CN L-7): admin-entered rate with source and as-of; hidden when older than 45 days. */
export const PutFxReferenceBodySchema = z
  .object({
    currency: z.literal('TWD'),
    ratePerUsd: z.number().positive().max(1000),
    source: z.string().trim().min(1).max(200),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export const FX_REFERENCE_MAX_AGE_DAYS = 45;

/** GET /admin/credits/fx-reference */
export interface FxReferenceAdminView {
  currency: 'TWD';
  ratePerUsd: number;
  source: string;
  asOf: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Whole days since `asOf`. */
  ageDays: number;
  /** Shown to users only while true (≤45 days). */
  fresh: boolean;
}

/** TW revenue monitor: Stripe TW-card revenue vs the NT$600k threshold (70 % warning). */
export interface TwRevenueResponse {
  periodStart: string;
  /** Year-to-date NT$; null without a fresh reference rate (render "—"). */
  revenueTwd: number | null;
  /** Year-to-date USD from TW cards, cents. */
  revenueUsdMinor: number;
  revenueTwdChargesWhole: number;
  /** The VAT registration level, whole NT$. */
  thresholdTwd: 600000;
  /**
   * The revenue at which the warning starts, in whole NT$ — the same unit as
   * `revenueTwd` and `thresholdTwd` (420000 = 70 % of NT$600,000). Never a
   * ratio: a reader that wants the percentage divides by `thresholdTwd`.
   */
  warnAt: number;
  /** `revenueTwd` has reached `warnAt`. */
  warning: boolean;
  chargeCount: number;
  skippedOtherCurrency: number;
  truncated: boolean;
  fx: { ratePerUsd: number; source: string; asOf: string; fresh: boolean } | null;
  source: 'stripe';
  asOf: string;
}

/** GET /admin/credits/refund-quote?userId — the F-BILL-08 decision for the user's latest charge. */
export const RefundQuoteQuerySchema = z.object({ userId: z.string().min(1).max(64) });
export interface RefundQuoteResponse {
  charge: {
    source: 'stripe' | 'cn';
    id: string;
    chargedAt: string;
    amountMinor: number;
    currency: string;
    planKey: string;
    chargeKind: 'first_purchase' | 'renewal';
  } | null;
  facts: { billingCountry: string | null; withdrawalWaiver: boolean; paidOnlyCreditsUsed: number; packCreditsUsed: number | null } | null;
  decision: RefundDecision | null;
}

/**
 * Wire codes of this area. All of them are the envelope's top-level `code`
 * (never `details.reason`), so the web reads them with `apiErrorCode()`.
 */
export const CREDITS_ERROR_CODES = {
  noSubscription: 'no_subscription',
  /** 410: the public cancel link is unknown, already used, for the other brand or older than 30 minutes. */
  cancelTokenInvalid: 'cancel_token_invalid',
  /** 503: the cancel-survey table is not in this database yet. */
  storageUnavailable: 'storage_unavailable',
} as const;

/** Minutes a public cancel link stays valid (single use). */
export const PUBLIC_CANCEL_TOKEN_MINUTES = 30;
