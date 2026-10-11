// server/src/features/credits/contract.ts
//
// Credits, plans, cancellation and admin caps (ARCHITECTURE.md §3.9, §7;
// TASK_PLAN.md R-07, R-08, R-25, WP-21a/21b). Mounts:
//   /api/v1/roboapply/credits        (seeker; incl. POST /cancel, POST /resume and
//                                     GET + POST /withdrawal, the statutory withdrawal)
//   /api/v1/roboapply/billing/plans  (S/P; new path — legacy /billing routes untouched)
//   /api/v1/public/cancel            (public one-click cancel flow, §312k BGB; the
//                                     emailed link can also preview and withdraw)
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
import type { WithdrawalRegion } from '../../platform/billing/acknowledgements.js';
import type { RefundDecision, WithdrawalRule } from '../../platform/billing/refunds.js';
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
 * POST /credits/resume: "Keep my plan". Turns auto-renewal back on for a plan
 * that was cancelled and is still running (MARKET_STRATEGY §5.1 "Cancel and
 * resume"). The box "I agree this renews automatically every {period} at
 * {price} until I cancel" must be ticked: it is stored as an `auto_renew_ack`
 * consent record for the price that is charged, before Stripe is asked.
 *
 * Errors (the envelope's top-level `code`):
 *   422 `auto_renew_ack_required`  the box is missing or not `true`;
 *   409 `nothing_to_resume`        no live plan, a pass, a plan that still
 *                                  renews, a period that ended, or GoApply
 *                                  (its plans are one-time and never renew);
 *   503 `rail_not_configured`      card payments are not set up here;
 *   502 `payment_provider_error`   Stripe failed; the plan stays cancelled.
 */
export const ResumeSubscriptionBodySchema = z.object({ autoRenewAck: z.literal(true) }).strict();
export type ResumeSubscriptionBody = z.infer<typeof ResumeSubscriptionBodySchema>;
export interface ResumeResponse {
  status: 'resumed';
  planKey: string;
  /** The next renewal (the end of the running period); null when unknown. */
  renewsAt: string | null;
}

// ── Statutory withdrawal (MARKET_STRATEGY §4.4 "Statutory withdrawal") ────

/** A purchase that can be withdrawn from: a paid Stripe invoice that is not a renewal. */
export interface WithdrawalPurchaseView {
  source: 'stripe';
  /** Send it back as `purchaseId`. */
  id: string;
  planKey: string;
  /** When it was paid; the 14 days run from here. */
  chargedAt: string;
  /** Everything paid under the purchase so far (a weekly plan on day 10: two charges). Minor units. */
  amountMinor: number;
  currency: string;
}

/** What withdrawing from that purchase returns, and until when. */
export interface WithdrawalQuoteView {
  /** `withdrawal_14d`: everything paid goes back. `withdrawal_14d_prorata`: the unused days (the buyer asked us to start at once). */
  rule: WithdrawalRule;
  /** Minor units. Can be 0 on the last day of a short period: the contract still ends. */
  refundMinor: number;
  currency: string;
  /**
   * The last moment the withdrawal is open (ISO): the purchase's 14th day, or
   * the end of the paid period when that comes first. For a withdrawal the
   * buyer already confirmed and that failed at the payment provider it is 14
   * days after that confirmation: until then it can be sent again and returns
   * the amount stated here, the one quoted when it was first confirmed.
   */
  deadline: string;
  /** Only for `withdrawal_14d_prorata`: whole days counted as used, and the days of the paid period. */
  prorata: { usedDays: number; periodDays: number } | null;
  /** A withdrawal ends the plan at once, whatever the amount. */
  endsAccess: true;
  region: WithdrawalRegion;
}

/** One open withdrawal: the purchase and its quote. */
export interface WithdrawalOption {
  purchase: WithdrawalPurchaseView;
  quote: WithdrawalQuoteView;
}

/**
 * GET /credits/withdrawal: what the signed-in buyer can withdraw from right
 * now. A withdrawal is open for 14 days after each purchase (never a renewal)
 * of a buyer whose billing country is in the EU, the EEA, the United Kingdom
 * or Taiwan, with or without the waiver box (the amount differs).
 *
 * `purchases` lists EVERY open purchase, the latest first (a pack bought on
 * day 3 of a monthly plan and the plan are two entries, each with its own
 * amount and deadline). `purchase` and `quote` are the first entry, for a
 * reader that shows one. `available` is false, with nulls and an empty list,
 * outside those countries, after the 14 days, once withdrawn or refunded,
 * where card payments are not set up, and always on GoApply (its rails have
 * no refund call; its published rule is on /pricing).
 *
 * One purchase stays listed past its 14th day: a withdrawal the buyer
 * confirmed in time that failed at the payment provider (POST answered 502).
 * It is listed, at the amount quoted then, until 14 days after that
 * confirmation (`quote.deadline`), so the buyer can send it again.
 *
 * Errors: 502 `payment_provider_error` when the purchases cannot be read.
 */
export interface WithdrawalResponse {
  available: boolean;
  purchase: WithdrawalPurchaseView | null;
  quote: WithdrawalQuoteView | null;
  purchases: WithdrawalOption[];
}

/**
 * POST /credits/withdrawal: withdraw from the purchase the buyer chose. The
 * subscription is cancelled at once, then the quoted amount is refunded and a
 * confirmation mail goes out. `confirm: true` is the second of the two steps.
 *
 * Errors (the envelope's top-level `code`):
 *   409 `withdrawal_not_available`  no withdrawal is open for this purchase
 *                                   (a stale id, after the 14 days, already
 *                                   withdrawn, GoApply, or a purchase whose
 *                                   payment cannot be resolved for a refund:
 *                                   nothing was ended). With `details.reason:
 *                                   'refund_refused'` the subscription was
 *                                   ended and the refund was refused because
 *                                   the money already went back (it was
 *                                   refunded by hand just before): read the
 *                                   plan again;
 *   429 `rate_limited`              more than 3 in an hour (sending a request
 *                                   that failed with 502 again is counted
 *                                   apart, 10 in an hour);
 *   503 `rail_not_configured`       card payments are not set up here;
 *   502 `payment_provider_error`    Stripe failed, or refused the refund
 *                                   request for another reason than "already
 *                                   refunded"; sending it again finishes it
 *                                   (`details` is `{ provider }` only, never
 *                                   the provider's text). The moment of this first request is
 *                                   kept for 14 days: the request sent again
 *                                   is decided as of that moment (the same
 *                                   amount, also after the purchase's 14th
 *                                   day), and GET lists the purchase until then.
 */
export const WithdrawBodySchema = z.object({ purchaseId: z.string().trim().min(1).max(255), confirm: z.literal(true) }).strict();
export type WithdrawBody = z.infer<typeof WithdrawBodySchema>;
export interface WithdrawResponse {
  status: 'withdrawn';
  /**
   * Minor units, as the rule gives them at the moment of this request (or of the first request, for one sent again
   * after a 502). A pro-rata amount counts used days, so it can be one day lower than a quote read before a day
   * boundary of the paid period; the confirm does not carry the quoted amount yet (`requests/waveM4-carryover.md`).
   */
  refundMinor: number;
  currency: string;
  accessEnded: true;
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
 * in the market wave and are always sent. They are required here since M4
 * (every plans fixture of the web carries them). The web still reads each
 * through `plansBillingFacts` (lib/api/account.ts), which treats a missing or
 * malformed value as "not stated", so a page served by an older deployment
 * prints nothing instead of failing.
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
    collectingEntity: string | null;
  };
  /** The numbers of the published refund rules. */
  refundPolicy: PlansRefundPolicy;
  /**
   * The published student rule: the brand's student prices with the computed
   * percentage below the regular plan, for a caller who is NOT sent the
   * student plans themselves (on GoApply the buyable student rows in `plans`
   * reach a signed-in, verified student only), while the `student` capability
   * is on. Null when the student plans are in `plans` already, or the
   * capability is off. A price list only: nothing here can be bought with.
   */
  studentOffer: PlansStudentOffer[] | null;
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

const PublicCancelToken = z.string().min(16).max(512);

/**
 * POST /api/v1/public/cancel/preview {token}: what the emailed link can do,
 * WITHOUT using it up (confirm still works afterwards). `withdrawal` is the
 * statutory withdrawal open for the plan the link cancels, or null: outside
 * the EU, the EEA, the United Kingdom and Taiwan, after the 14 days, and also
 * when the purchase could not be read from the payment provider just now or
 * the link was previewed more than 20 times (the ordinary cancellation never
 * depends on that read, and confirm with `withdraw` still withdraws). A pack
 * bought alongside is not offered here: this link is about the plan.
 *
 * Errors: 410 `cancel_token_invalid` for an unknown, used, expired or
 * other-brand link, exactly as confirm answers.
 */
export const PublicCancelPreviewBodySchema = z.object({ token: PublicCancelToken }).strict();
export interface PublicCancelPreviewResponse {
  /** The plan the link cancels ('free' when nothing is live any more). */
  planKey: string;
  /** Where an ordinary cancellation leaves access: the end of the paid period. */
  accessUntil: string | null;
  withdrawal: Pick<WithdrawalQuoteView, 'refundMinor' | 'currency' | 'rule' | 'deadline'> | null;
}

/**
 * POST /api/v1/public/cancel/confirm {token, withdraw?}. Without `withdraw`
 * (or with false): cancels at the end of the paid period and sends the
 * confirmation mail, as before. With `withdraw: true`: withdraws from the
 * plan's purchase (the subscription ends at once, the quoted amount is
 * refunded, the withdrawal mail goes out) and the answer carries
 * `withdrawal.status: 'withdrawn'` with `accessUntil: null`. If the
 * withdrawal is not open any more the plan is cancelled at period end instead
 * and the answer says `withdrawal.status: 'not_available'`. A plan that a
 * withdrawal made elsewhere already ended answers `already_cancelled` (with
 * or without `withdraw`). A payment-provider failure answers 502 and leaves
 * the link usable; the withdrawal it could not finish is then decided as of
 * that first request, on this link and on the signed-in page. The one refusal after the
 * subscription was ended (409 `withdrawal_not_available` with `details.reason:
 * 'refund_refused'`, see POST /credits/withdrawal) is answered as that error
 * and cancels nothing more.
 */
export const PublicCancelConfirmBodySchema = z.object({ token: PublicCancelToken, withdraw: z.boolean().optional() }).strict();
export type PublicCancelConfirmResponse = CancelResponse & {
  /** Present only when the request asked to withdraw. */
  withdrawal?: { status: 'withdrawn' | 'not_available'; refundMinor: number | null; currency: string | null };
};

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
  /** 409: POST /credits/resume found no cancelled plan that is still running. */
  nothingToResume: 'nothing_to_resume',
  /** 422: POST /credits/resume without the ticked auto-renewal box. */
  autoRenewAckRequired: 'auto_renew_ack_required',
  /** 410: the public cancel link is unknown, already used, for the other brand or older than 30 minutes. */
  cancelTokenInvalid: 'cancel_token_invalid',
  /** 409: POST /credits/withdrawal for a purchase with no open withdrawal (stale id, after the 14 days, already withdrawn, GoApply). */
  withdrawalNotAvailable: 'withdrawal_not_available',
  /** 503: the cancel-survey table is not in this database yet. */
  storageUnavailable: 'storage_unavailable',
} as const;

/** Minutes a public cancel link stays valid (single use). */
export const PUBLIC_CANCEL_TOKEN_MINUTES = 30;
