// lib/api/account.ts
//
// Typed client for the RoboApply User Account + Billing surfaces. Wraps
// `roboApi` (lib/api/client.ts) which already unwraps the `{success,data}`
// envelope (returns `data`) and throws `RoboApiError` (.code / .message) on
// failure. The two backend bases:
//
//   /api/v1/roboapply/account   profile · password · sign-out-all · usage · delete · wipe-data
//   /api/v1/roboapply/billing   plan · checkout · portal · cancel
//
// Stripe-redirect endpoints (checkout / portal) return `{ url }`; the caller
// is responsible for `window.location.href = url`.

import { roboApi, type RequestOptions } from './client';
import { API_BASE } from '../config';
import type { CheckoutResponse } from './contracts/credits';

// ─────────────────────────────────────────────────────────────────────
// Enums / shared
// ─────────────────────────────────────────────────────────────────────

/** Mock-interview subscription plans. Legacy premium/premium_plus kept so an
 *  existing subscriber's tier still renders. */
export type MockPlanKey = 'free' | 'starter' | 'growth';
export type AccountTier = MockPlanKey | 'premium' | 'premium_plus';

/** Tier ids that can be purchased (free is not a charge). */
export type PurchasableTier = 'starter' | 'growth';

// ─────────────────────────────────────────────────────────────────────
// Account
// ─────────────────────────────────────────────────────────────────────

export interface AccountProfile {
  id: string;
  email: string;
  name: string | null;
  provider: string;
  hasPassword: boolean;
  memberSince: string; // ISO
  readinessScore: number;
  tier: AccountTier;
  subscriptionStatus: string;
  currentPeriodEnd: string | null; // ISO
  cancelAtPeriodEnd: boolean;
}

export interface UpdateNameResponse {
  name: string;
}

export interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

export interface SignOutAllResponse {
  revoked: number;
}

export interface DeleteAccountResponse {
  ok: true;
  deactivated: true;
}

/** Per-table removal counts from a data-only wipe (POST /account/wipe-data).
 *  Clears application data (match history / queue / activity / pipeline);
 *  account, profile, and résumés survive. */
export interface WipeDataResponse {
  trackerEntries: number;
  matchScores: number;
  runs: number;
  digests: number;
  /** Jobright-clone application-data rows removed, per table (WP-10). */
  clone: Record<string, number>;
  /** Stored application files that could not be confirmed deleted (rows kept; retried later). */
  applicationFilesKept: number;
}

// ─────────────────────────────────────────────────────────────────────
// Usage (value framing — counts only, never cost)
// ─────────────────────────────────────────────────────────────────────

export interface AccountUsageFeature {
  key: string;
  label: string;
  count: number;
}

export interface AccountUsageDay {
  day: string; // ISO date (YYYY-MM-DD)
  count: number;
}

export interface AccountUsageResponse {
  range: { from: string; to: string; tz: string };
  tier: AccountTier;
  dailyCap: number;
  byFeature: AccountUsageFeature[];
  byDay: AccountUsageDay[];
  totalActions: number;
}

export interface AccountUsageParams {
  from?: string;
  to?: string;
  tz?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Billing
// ─────────────────────────────────────────────────────────────────────

export interface BillingRegion {
  market: 'cn' | 'other';
  currency: 'CNY' | 'USD';
  method: 'alipay' | 'stripe';
  source: string;
}

export interface BillingCurrent {
  tier: AccountTier;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  currentPeriodEnd: string | null; // ISO
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
  /** CN/Alipay one-time monthly pass → no auto-renew (manual re-purchase). */
  manualRenewal: boolean;
}

export interface BillingCredits {
  balance: number;
  periodAllotment: number | null;
  tier: string;
}

export interface BillingPlanItem {
  key: MockPlanKey;
  credits: number;
  usdMinor: number;
  cnyMinor: number;
  current: boolean;
  purchasable: boolean;
}

export interface BillingPlanResponse {
  region: BillingRegion;
  current: BillingCurrent;
  credits: BillingCredits;
  plans: BillingPlanItem[];
  stripeConfigured: boolean;
  alipayConfigured: boolean;
}

export interface CreditsResponse {
  balance: number;
  periodAllotment: number | null;
  tier: string;
  currentPeriodEnd: string | null;
  /** Minutes covered by one mock-interview credit. Optional for compatibility
   *  with an older backend during a rolling deployment. */
  creditMinutes?: number;
}

export interface BillingInvoice {
  id: string;
  kind: 'stripe' | 'alipay';
  date: string; // ISO
  amountMinor: number;
  currency: string;
  status: string;
  description: string;
  downloadable: boolean;
}

export interface BillingHistoryResponse {
  invoices: BillingInvoice[];
}

export interface StripeRedirect {
  url: string;
}

export interface CancelPlanResponse {
  ok: true;
}

// ─────────────────────────────────────────────────────────────────────
// Clone plans (WP-21b UI over WP-21a's server; PRODUCT_PLAN.md §6.3)
//
// The `/billing` checkout endpoints take a `planKey` body (WP-21a; the old
// `{ tier }` body now answers 409) and answer the contract's `CheckoutResponse`
// (server/src/features/credits/contract.ts): one type for both sides.
// Switching is one server endpoint, adapted below.
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /billing/checkout (the brand's default rail: Stripe on RoboApply) and
 * /billing/alipay (GoApply's Alipay rail) with a clone plan key. Which rails
 * can take a payment now is `checkout.rails` of GET /billing/plans.
 */
export interface PlanCheckoutBody {
  /** A `PLAN_KEYS` value from GET /billing/plans. */
  planKey: string;
  /** The unticked-by-default "renews automatically" box (consent `auto_renew_ack`); required for auto-renewing plans. */
  autoRenewAck?: boolean;
  /** EU/UK/TW "Start now" withdrawal waiver (consent `withdrawal_waiver`); optional. */
  withdrawalWaiver?: boolean;
  /** Same-origin path after a successful payment. */
  next?: string;
  /** Same-origin path when the buyer leaves the payment page. */
  cancelNext?: string;
}

/**
 * One checkout attempt (MARKET_STRATEGY §5.1 "Idempotency keys"). The plan
 * sheet makes one key per attempt and sends it as the `Idempotency-Key`
 * request header; the server turns it into the payment provider's own
 * idempotency key, so a double click opens one payment page and a second,
 * intended purchase (a new attempt, a new key) opens a new one. Without the
 * header the server falls back to a 60-second bucket. The Alipay route takes
 * the header too and ignores it today.
 */
export interface CheckoutCallOptions {
  attemptKey?: string | null;
}

/** What the server accepts as an attempt key (a UUID fits). */
export const CHECKOUT_ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const CHECKOUT_ATTEMPT_HEADER = 'Idempotency-Key';

/** Request options carrying the attempt key, or none when the key is missing or not in the accepted form. */
export function checkoutRequestOptions(opts?: CheckoutCallOptions | null): RequestOptions | undefined {
  const key = typeof opts?.attemptKey === 'string' ? opts.attemptKey.trim() : '';
  return CHECKOUT_ATTEMPT_KEY_PATTERN.test(key) ? { headers: { [CHECKOUT_ATTEMPT_HEADER]: key } } : undefined;
}

/**
 * What checkout answers, by `kind`: `redirect` (open `url`: Stripe, the Alipay
 * cashier, WeChat Pay H5), `qr` (`qrCodeUrl` is the content of a payment code,
 * e.g. a `weixin://` link — draw a QR code from it, never load it as an
 * image) or `jsapi` (parameters for the WeChat in-app cashier).
 */
export type PlanCheckoutResponse = CheckoutResponse;

// ─────────────────────────────────────────────────────────────────────
// Facts `GET /billing/plans` adds for the pricing page (market wave, D6).
//
// Written by hand from the cross-bundle contract (MARKET_TASK_PLAN.md §3.1;
// the server half is built in parallel): the fields are OPTIONAL here, read
// through `plansBillingFacts`, and anything absent or malformed is "not
// stated", so the page prints nothing instead of a made-up number or name
// (D3). No number of the refund rules is written in the web bundle.
//
//   refundPolicy: { firstPurchaseDays, shortPlanHours, paidOnlyCreditLimit,
//                   accidentalRenewalDays, withdrawalDays, packValidMonths,
//                   version }
//   checkout.collectingEntity: string | null   (GoApply only)
//   studentOffer: Array<{ key, amountMinor, studentDiscountPercent }> | null
//     (requested: the student prices for a visitor who is not sent the
//      student plans; absent until the server sends it)
// ─────────────────────────────────────────────────────────────────────

/** The numbers of the published refund rules (server `platform/billing/refunds.ts`). */
export interface RefundPolicyFacts {
  /** First purchase: refund within this many days… */
  firstPurchaseDays: number;
  /** …or this many hours for the weekly plan and the 7-day pass… */
  shortPlanHours: number;
  /** …if fewer than this many paid-only actions were used. */
  paidOnlyCreditLimit: number;
  /** A renewal charged by mistake: within this many days. */
  accidentalRenewalDays: number;
  /** Statutory withdrawal window (EU / EEA / UK / Taiwan), days. */
  withdrawalDays: number;
  /** A practice pack stays valid this many months. */
  packValidMonths: number;
  /** The policy version the server applies ('' when not stated). */
  version: string;
}

/** One student price published to a visitor (the plan itself is listed only for a verified student). */
export interface StudentOfferRow {
  key: string;
  amountMinor: number;
  studentDiscountPercent: number | null;
}

export interface PlansBillingFacts {
  /** Null → the refund lines are not printed. */
  refundPolicy: RefundPolicyFacts | null;
  /** The legal entity that collects the payment; null → the line is not printed. */
  collectingEntity: string | null;
  /** Empty → no student price is published on this response. */
  studentOffer: StudentOfferRow[];
}

const REFUND_POLICY_NUMBERS = ['firstPurchaseDays', 'shortPlanHours', 'paidOnlyCreditLimit', 'accidentalRenewalDays', 'withdrawalDays', 'packValidMonths'] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The additive facts of a plans response, normalised. Works before and after the server sends them. */
export function plansBillingFacts(view: unknown): PlansBillingFacts {
  const root = isRecord(view) ? view : {};
  const rawPolicy = root.refundPolicy;
  const refundPolicy: RefundPolicyFacts | null =
    isRecord(rawPolicy) && REFUND_POLICY_NUMBERS.every((k) => isCount(rawPolicy[k]))
      ? {
          firstPurchaseDays: rawPolicy.firstPurchaseDays as number,
          shortPlanHours: rawPolicy.shortPlanHours as number,
          paidOnlyCreditLimit: rawPolicy.paidOnlyCreditLimit as number,
          accidentalRenewalDays: rawPolicy.accidentalRenewalDays as number,
          withdrawalDays: rawPolicy.withdrawalDays as number,
          packValidMonths: rawPolicy.packValidMonths as number,
          version: typeof rawPolicy.version === 'string' ? rawPolicy.version : '',
        }
      : null;
  const checkout = isRecord(root.checkout) ? root.checkout : {};
  const entity = typeof checkout.collectingEntity === 'string' ? checkout.collectingEntity.trim() : '';
  const studentOffer: StudentOfferRow[] = [];
  if (Array.isArray(root.studentOffer)) {
    for (const row of root.studentOffer) {
      if (!isRecord(row) || typeof row.key !== 'string' || !row.key || !isCount(row.amountMinor)) continue;
      const pct = row.studentDiscountPercent;
      studentOffer.push({ key: row.key, amountMinor: row.amountMinor, studentDiscountPercent: isCount(pct) && pct < 100 ? pct : null });
    }
  }
  return { refundPolicy, collectingEntity: entity || null, studentOffer };
}

/** POST /billing/switch/quote — what a legacy practice-plan subscriber pays to switch to Pro. Nothing is charged. */
export interface SwitchQuote {
  quoteId: string;
  planKey: string;
  currency: string;
  /** Prorated amount charged today if the user confirms. */
  amountDueTodayMinor: number;
  /** The new plan's renewal price. */
  renewalAmountMinor: number;
  /** ISO date of the next renewal at the new price. */
  nextRenewalAt: string;
}

export interface SwitchQuoteBody {
  planKey: string;
}

/** POST /billing/switch/confirm — charges only now. */
export interface SwitchConfirmBody {
  quoteId: string;
  autoRenewAck: boolean;
  withdrawalWaiver?: boolean;
}

export interface SwitchConfirmResponse {
  status: 'switched';
  planKey: string;
  nextRenewalAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────

// WP-21a serves one endpoint for both steps, `POST /billing/switch`: without
// `confirm` it answers `{ quote }`; with `{ confirm: true, prorationDate }` it
// charges. The UI's opaque `quoteId` carries the plan key and the proration
// timestamp the server needs back (Wave 2 gate seam fix).
interface ServerSwitchQuote {
  planKey: string;
  currency: string;
  amountDueTodayMinor: number;
  newRenewalPriceMinor: number;
  nextRenewalDate: string;
  prorationDate: number;
}

export function fromServerQuote(q: ServerSwitchQuote): SwitchQuote {
  return {
    quoteId: `${q.planKey}:${q.prorationDate}`,
    planKey: q.planKey,
    currency: q.currency,
    amountDueTodayMinor: q.amountDueTodayMinor,
    renewalAmountMinor: q.newRenewalPriceMinor,
    nextRenewalAt: q.nextRenewalDate,
  };
}

export function parseQuoteId(quoteId: string): { planKey: string; prorationDate: number } {
  const at = quoteId.lastIndexOf(':');
  const planKey = at > 0 ? quoteId.slice(0, at) : '';
  const prorationDate = Number(at > 0 ? quoteId.slice(at + 1) : NaN);
  if (!planKey || !Number.isInteger(prorationDate) || prorationDate <= 0) throw new Error('Invalid switch quote id');
  return { planKey, prorationDate };
}

const ACCOUNT_BASE = '/api/v1/roboapply/account';
const BILLING_BASE = '/api/v1/roboapply/billing';

function usageQuery(params?: AccountUsageParams): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.tz) qs.set('tz', params.tz);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const accountApi = {
  // account
  profile: () => roboApi.get<AccountProfile>(ACCOUNT_BASE),
  updateName: (name: string) =>
    roboApi.patch<UpdateNameResponse>(ACCOUNT_BASE, { name }),
  changePassword: (body: ChangePasswordBody) =>
    roboApi.post<{ ok: true }>(`${ACCOUNT_BASE}/password`, body),
  signOutAll: () =>
    roboApi.post<SignOutAllResponse>(`${ACCOUNT_BASE}/signout-all`),
  usage: (params?: AccountUsageParams) =>
    roboApi.get<AccountUsageResponse>(`${ACCOUNT_BASE}/usage${usageQuery(params)}`),
  deleteAccount: (confirmEmail: string) =>
    roboApi.post<DeleteAccountResponse>(`${ACCOUNT_BASE}/delete`, { confirmEmail }),
  /** Clear application data only (match history / queue / activity / pipeline).
   *  Account + résumés survive; the caller stays signed in. */
  wipeData: () =>
    roboApi.post<WipeDataResponse>(`${ACCOUNT_BASE}/wipe-data`, { confirm: true }),

  // billing
  plan: (region?: 'cn' | 'other') =>
    roboApi.get<BillingPlanResponse>(`${BILLING_BASE}/plan${region ? `?region=${region}` : ''}`),
  credits: () => roboApi.get<CreditsResponse>(`${BILLING_BASE}/credits`),
  checkout: (tier: PurchasableTier, next?: string, cancelNext?: string) =>
    roboApi.post<StripeRedirect>(`${BILLING_BASE}/checkout`, { tier, next, cancelNext }),
  alipayCheckout: (tier: PurchasableTier, next?: string) =>
    roboApi.post<StripeRedirect>(`${BILLING_BASE}/alipay`, { tier, next }),
  portal: () => roboApi.post<StripeRedirect>(`${BILLING_BASE}/portal`),
  cancel: () => roboApi.post<CancelPlanResponse>(`${BILLING_BASE}/cancel`),
  history: () => roboApi.get<BillingHistoryResponse>(`${BILLING_BASE}/history`),
  /** Clone plan checkout (Stripe, RoboApply). */
  checkoutPlan: (body: PlanCheckoutBody, opts?: CheckoutCallOptions) =>
    roboApi.post<PlanCheckoutResponse>(`${BILLING_BASE}/checkout`, body, checkoutRequestOptions(opts)),
  /**
   * Clone plan checkout through Alipay (GoApply). The rail is open whenever
   * `GET /billing/plans` lists `alipay` in `checkout.rails`; there is no
   * payments switch to turn on. Answers `rail_not_configured` (503) when the
   * rail cannot charge and `plan_not_sellable` (409) under the kill switch.
   */
  alipayCheckoutPlan: (body: PlanCheckoutBody, opts?: CheckoutCallOptions) =>
    roboApi.post<PlanCheckoutResponse>(`${BILLING_BASE}/alipay`, body, checkoutRequestOptions(opts)),
  /** Legacy practice plan → Pro: a quote first; nothing is charged (POST /billing/switch without `confirm`). */
  switchQuote: async (body: SwitchQuoteBody): Promise<SwitchQuote> => {
    const { quote } = await roboApi.post<{ quote: ServerSwitchQuote }>(`${BILLING_BASE}/switch`, { planKey: body.planKey });
    return fromServerQuote(quote);
  },
  /** Legacy practice plan → Pro: charges the quoted amount (POST /billing/switch with `confirm`). */
  switchConfirm: async (body: SwitchConfirmBody): Promise<SwitchConfirmResponse> => {
    const { planKey, prorationDate } = parseQuoteId(body.quoteId);
    const res = await roboApi.post<{ switched: true; planKey: string }>(`${BILLING_BASE}/switch`, {
      planKey,
      confirm: true,
      prorationDate,
      autoRenewAck: body.autoRenewAck,
      ...(body.withdrawalWaiver !== undefined ? { withdrawalWaiver: body.withdrawalWaiver } : {}),
    });
    return { status: 'switched', planKey: res.planKey, nextRenewalAt: null };
  },
  /** Absolute URL the browser opens directly — Stripe 302s to its hosted PDF,
   *  Alipay streams a generated receipt. Carries the session cookie. */
  invoiceDownloadUrl: (id: string) =>
    `${API_BASE}${BILLING_BASE}/invoices/${encodeURIComponent(id)}/download`,
};
