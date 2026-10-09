'use client';

// hooks/credits/usePlans.ts — the brand's plan catalog with server prices
// (`GET /api/v1/roboapply/billing/plans`, WP-21a; UI WP-21b).
//
// One cached query shared by the plan sheet, PlanBadge and PriceReference.
// Prices come only from this response (D3: never from copy). Public endpoint
// (S/P), so it also works on /pricing and /cancel without a session.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getPlans, plansExtras, type PlansView } from '../../lib/api/credits';
import type { CatalogPlan } from '../../lib/api/credits';
import { shouldRetryCredits } from '../shared/useCredits';

export const PLANS_QUERY_KEY = ['credits', 'plans'] as const;
/** Prices change only when the owner edits config; five minutes is plenty. */
export const PLANS_STALE_MS = 5 * 60 * 1000;

export function usePlans(options: { enabled?: boolean } = {}): UseQueryResult<PlansView> {
  return useQuery<PlansView>({
    queryKey: PLANS_QUERY_KEY,
    queryFn: ({ signal }) => getPlans({ signal }),
    staleTime: PLANS_STALE_MS,
    retry: shouldRetryCredits,
    enabled: options.enabled ?? true,
  });
}

/** Plans the in-app sheet offers: priced, current phase, not a flag-gated V2 SKU (unless on). */
export function visiblePlans(plans: readonly CatalogPlan[] | null | undefined, opts: { studentEnabled?: boolean } = {}): CatalogPlan[] {
  if (!plans) return [];
  return plans.filter((p) => {
    if (p.kind === 'free') return false;
    if (p.amountMinor === null || p.unsellableReason === 'price_unset') return false;
    if (p.requiresFlag === 'student' && !opts.studentEnabled) return false;
    if (p.phase !== 'mvp' && !(p.requiresFlag === 'student' && opts.studentEnabled)) return false;
    return true;
  });
}

/**
 * The plan to preselect: the server's `defaultSelection`, but only when it is
 * a sellable plan that may be preselected. The weekly plan and the 7-day pass
 * are never preselected, whatever the server says (H24, PRODUCT §6.3).
 */
export function initialSelection(view: Pick<PlansView, 'plans' | 'defaultSelection'> | null | undefined, requested?: string | null): string | null {
  if (!view) return null;
  const plans = view.plans ?? [];
  // An explicit request (a deep link such as the cancel-time "7-day pass instead?")
  // is the user's own choice, so any sellable plan may be chosen that way.
  if (requested) {
    const asked = plans.find((p) => p.key === requested && p.sellable);
    if (asked) return asked.key;
  }
  const key = view.defaultSelection;
  const plan = plans.find((p) => p.key === key);
  // GoApply's 30-day pass may be the default (it is that brand's "monthly");
  // the weekly plan and the 7-day pass never are.
  if (!plan || !plan.sellable || plan.neverPreselected || plan.interval === 'week' || plan.key === 'pro_weekly' || plan.key === 'pro_week_pass') return null;
  return plan.key;
}

/** The brand's monthly plan (for "Save N%"), if priced. */
export function monthlyPlan(plans: readonly CatalogPlan[] | null | undefined): CatalogPlan | null {
  return plans?.find((p) => p.key === 'pro_monthly' && p.amountMinor !== null) ?? null;
}

export { plansExtras };
