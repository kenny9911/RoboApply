// lib/api/account.ts
//
// Typed client for the RoboApply User Account + Billing surfaces. Wraps
// `roboApi` (lib/api/client.ts) which already unwraps the `{success,data}`
// envelope (returns `data`) and throws `RoboApiError` (.code / .message) on
// failure. The two backend bases:
//
//   /api/v1/roboapply/account   profile · password · sign-out-all · usage · delete
//   /api/v1/roboapply/billing   plan · checkout · portal · cancel
//
// Stripe-redirect endpoints (checkout / portal) return `{ url }`; the caller
// is responsible for `window.location.href = url`.

import { roboApi } from './client';
import { API_BASE } from '../config';

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
// Endpoints
// ─────────────────────────────────────────────────────────────────────

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
  /** Absolute URL the browser opens directly — Stripe 302s to its hosted PDF,
   *  Alipay streams a generated receipt. Carries the session cookie. */
  invoiceDownloadUrl: (id: string) =>
    `${API_BASE}${BILLING_BASE}/invoices/${encodeURIComponent(id)}/download`,
};
