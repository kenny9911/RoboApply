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
// only from `getPlanCatalog` (env-configured), never from copy.

import { z } from 'zod';
import type { EntitlementSummary } from '../../platform/credits/summary.js';
import type { CreditCatalog, CreditCatalogOverride } from '../../platform/credits/catalog.js';
import type { PlanView } from '../../platform/billing/planViews.js';
import type { RefundDecision } from '../../platform/billing/refunds.js';

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

/** GET /credits/history?cursor — committed ledger rows. */
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

/** GET /billing/plans (public; signed-in users also get `current`). */
export interface PlansResponse {
  /** The brand's plans with configured prices; `sellable` false → shown, not purchasable. */
  plans: PlanView[];
  /** Never a weekly plan or the pass. */
  defaultSelection: string | null;
  currency: 'USD' | 'CNY';
  /** At least one plan can be bought now (GoApply: false until payments open — "暂未开放"). */
  paymentsOpen: boolean;
  checkout: {
    /** Rails that can take a payment now. */
    rails: Array<'stripe' | 'alipay' | 'wechatpay'>;
    /** Show the EU/UK/TW withdrawal-waiver box (edge country of this request). */
    showWithdrawalWaiver: boolean;
    country: string | null;
    /** Stored with each acknowledgement record. */
    acknowledgementVersion: string;
  };
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
  thresholdTwd: 600000;
  warnAt: number;
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

export const CREDITS_ERROR_CODES = {
  noSubscription: 'no_subscription',
  cancelTokenInvalid: 'cancel_token_invalid',
} as const;

/** Minutes a public cancel link stays valid (single use). */
export const PUBLIC_CANCEL_TOKEN_MINUTES = 30;
