'use client';

// hooks/credits/useSubscriptionState.ts — one view of "what plan am I on and
// what can I do with it" for /settings#billing (WP-21b).
//
// Two server sources, nothing computed beyond reading them:
//   - the entitlement summary (`/credits`, same as `/auth/me.entitlements`):
//     plan key, Pro/Free column, interval, period end, legacy flag;
//   - the legacy billing plan (`/billing/plan`): payment status (past due),
//     cancel-at-period-end, Stripe customer (portal), manual renewal.
// Unknown stays null (rendered "—"), never 0 or "Free".
//
// Cancel-at-period-end: the summary does not carry it yet (requested from
// WP-21a as `summary.cancelAtPeriodEnd`); `summaryCancelAtPeriodEnd()` is the
// one adapter that reads it, and the legacy plan answers until it ships.

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
}

const RENEWING = new Set(['week', 'month', 'quarter']);

/**
 * `summary.cancelAtPeriodEnd` (requested from WP-21a), or undefined while the
 * server does not send it. The narrow adapter every reader goes through.
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
  const cancelAtPeriodEnd = summaryCancelAtPeriodEnd(s) ?? cur?.cancelAtPeriodEnd === true;
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
