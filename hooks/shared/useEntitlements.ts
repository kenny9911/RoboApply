'use client';

// hooks/shared/useEntitlements.ts — plan profile and feature entitlements
// (saved searches, instant alerts, full competitiveness report) for the
// signed-in user (ARCHITECTURE.md §7.2; FND-7).
//
// Reads the same cached summary as useCredits (seeded from `/auth/me` by
// WP-10). Fail closed: until the summary arrives every count is null and
// every switch is false, so a paid-only control never flashes on. There is
// deliberately no entitlement for the recruiter-jobs filter (free on every
// plan, PRODUCT F-FEED-04).

import { useCredits, type EntitlementSummary } from './useCredits';

export type EntitlementValues = EntitlementSummary['entitlements'];
export type EntitlementKey = keyof EntitlementValues;

export type EntitlementsStatus = 'loading' | 'ready' | 'error';

export interface EntitlementsValue {
  summary: EntitlementSummary | null;
  /** 'free' | 'pro' (plan column), or null until known. */
  planProfile: EntitlementSummary['planProfile'] | null;
  /** True only when the summary says Pro. */
  isPro: boolean;
  /** A sellable Pro plan exists on this brand ("See Pro" links). */
  upgradable: boolean;
  entitlements: EntitlementValues | null;
  status: EntitlementsStatus;
}

export function entitlementsFrom(summary: EntitlementSummary | null | undefined, isError = false): EntitlementsValue {
  const s = summary ?? null;
  return {
    summary: s,
    planProfile: s?.planProfile ?? null,
    isPro: s?.planProfile === 'pro',
    upgradable: s?.upgradable === true,
    entitlements: s?.entitlements ?? null,
    status: s ? 'ready' : isError ? 'error' : 'loading',
  };
}

export function useEntitlements(options: { enabled?: boolean } = {}): EntitlementsValue {
  const query = useCredits(options);
  return entitlementsFrom(query.data?.summary, query.isError);
}

/**
 * One entitlement: a number (cap) or a boolean (switch). Null until known —
 * callers render "—" for counts and treat null switches as off.
 */
export function useEntitlement<K extends EntitlementKey>(key: K): EntitlementValues[K] | null {
  const { entitlements } = useEntitlements();
  return entitlements ? entitlements[key] : null;
}
