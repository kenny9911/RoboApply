'use client';

// hooks/credits/useSubscriptionState.ts — one view of "what plan am I on and
// what can I do with it" for /settings#billing (WP-21b).
//
// Two server sources, nothing computed beyond reading them:
//   - the entitlement summary (`/credits`, same as `/auth/me.entitlements`):
//     plan key, Pro/Free column, interval, period end, legacy flag and
//     whether the plan was cancelled (`cancelAtPeriodEnd`);
//   - the legacy billing plan (`/billing/plan`): payment status (past due),
//     Stripe customer (portal), manual renewal, and what the subscription
//     is charged at each renewal (amount and currency).
// Unknown stays null (rendered "—"), never 0 or "Free".
//
// Cancel-at-period-end comes from the summary only. The legacy plan is not a
// second opinion: with two sources a stale one could show "Renews on …" for a
// plan the user has already cancelled.

import { useBillingPlan } from '../useAccount';
import { useCredits, type EntitlementSummary } from '../shared/useCredits';
import type { BillingPlanResponse } from '../../lib/api/account';

export type SubscriptionStatus = 'loading' | 'ready' | 'error';

export interface SubscriptionState {
  status: SubscriptionStatus;
  planKey: string | null;
  profile: 'free' | 'pro' | null;
  /** Grandfathered `starter` / `growth` practice plan. */
  legacy: boolean;
  interval: string | null;
  periodEnd: string | null;
  /** A plan that renews by itself until cancelled (weekly / monthly / quarterly or a legacy Stripe plan). */
  autoRenews: boolean;
  /** It will actually renew: an auto-renewing plan that has NOT been cancelled. */
  willRenew: boolean;
  /** A one-time pass that ends by itself. */
  isPass: boolean;
  cancelAtPeriodEnd: boolean;
  /** Last renewal failed (Stripe past_due / unpaid / incomplete). */
  paymentFailed: boolean;
  /** The Stripe customer portal is available. */
  hasPortal: boolean;
  /** Practice interview credits, or null when unknown. */
  practiceBalance: number | null;
  /** A sellable Pro plan exists on this brand. */
  upgradable: boolean;
  /**
   * What the plan is charged at each renewal, in minor units of
   * `chargedCurrency`, as the billing plan states it (`current.amountMinor`).
   * Null when the server does not say; never taken from the catalog here.
   */
  chargedAmountMinor: number | null;
  /** Upper-case ISO currency of `chargedAmountMinor`, or null. */
  chargedCurrency: string | null;
}

const RENEWING = new Set(['week', 'month', 'quarter']);

/**
 * `summary.cancelAtPeriodEnd`, or undefined when the summary is missing or
 * came from a server that does not send the field yet (a rolling deploy).
 * Readers that print "Renews on {date}" need the three states: they make the
 * claim only on a known `false`.
 */
export function summaryCancelAtPeriodEnd(summary: EntitlementSummary | null | undefined): boolean | undefined {
  const v = (summary as { cancelAtPeriodEnd?: unknown } | null | undefined)?.cancelAtPeriodEnd;
  return typeof v === 'boolean' ? v : undefined;
}
const FAILED = new Set(['past_due', 'unpaid', 'incomplete']);

export function deriveSubscriptionState(input: {
  summary: EntitlementSummary | null | undefined;
  practice?: { balance: number } | null;
  legacyPlan?: BillingPlanResponse | null;
  summaryError?: boolean;
}): SubscriptionState {
  const s = input.summary ?? null;
  const cur = input.legacyPlan?.current ?? null;
  const legacyTierPaid = !!cur && cur.tier !== 'free';
  const intervalRenews = !!s?.interval && RENEWING.has(s.interval);
  const legacyRenews = !!s?.legacyPlan && legacyTierPaid && !!cur?.hasStripeCustomer && !cur?.manualRenewal;
  const status: SubscriptionStatus = s ? 'ready' : input.summaryError ? 'error' : 'loading';
  const autoRenews = intervalRenews || legacyRenews;
  const cancelAtPeriodEnd = summaryCancelAtPeriodEnd(s) === true;
  // Both or neither: an amount without its currency cannot be printed.
  const amount = cur?.amountMinor;
  const currency = typeof cur?.currency === 'string' ? cur.currency.trim().toUpperCase() : '';
  const charged = typeof amount === 'number' && Number.isInteger(amount) && amount > 0 && /^[A-Z]{3}$/.test(currency);
  return {
    status,
    planKey: s?.planKey ?? null,
    profile: s?.planProfile ?? null,
    legacy: s?.legacyPlan === true,
    interval: s?.interval ?? null,
    periodEnd: s?.periodEnd ?? cur?.currentPeriodEnd ?? null,
    autoRenews,
    willRenew: autoRenews && !cancelAtPeriodEnd,
    isPass: s?.interval === 'pass' || (!!cur?.manualRenewal && legacyTierPaid),
    cancelAtPeriodEnd,
    paymentFailed: !!cur && FAILED.has(String(cur.status).toLowerCase()),
    hasPortal: cur?.hasStripeCustomer === true,
    practiceBalance: input.practice ? input.practice.balance : (input.legacyPlan?.credits.balance ?? null),
    upgradable: s?.upgradable === true,
    chargedAmountMinor: charged ? (amount as number) : null,
    chargedCurrency: charged ? currency : null,
  };
}

export function useSubscriptionState(): SubscriptionState & { refetch: () => void } {
  const credits = useCredits();
  const legacy = useBillingPlan();
  const state = deriveSubscriptionState({
    summary: credits.data?.summary,
    practice: credits.data?.practice ?? null,
    legacyPlan: legacy.data ?? null,
    summaryError: credits.isError,
  });
  return {
    ...state,
    refetch: () => {
      void credits.refetch();
      void legacy.refetch();
    },
  };
}
