'use client';

// hooks/shared/useCredits.ts — the signed-in user's credit summary
// (`GET /api/v1/roboapply/credits`, ARCHITECTURE.md §7; FND-7).
//
// The client never computes caps or usage; it prints what the server sends:
// "Uses 1 of your 2 left today", "Up to 50 a day" — never "unlimited"
// (PRODUCT §6.1). Unknown values stay `null` so the UI renders "—", not 0.
//
// One cached query shared by every caller. `/auth/me` carries the same
// summary (`entitlements`); WP-10's AuthProvider seeds this cache with
// `primeCredits()` so a page load costs no extra request.

import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';

import { getCredits } from '../../lib/api/credits';
import { apiErrorCode } from '../../lib/api/contracts/wire';
import type { CreditsResponse } from '../../lib/api/contracts/credits';

export type EntitlementSummary = CreditsResponse['summary'];
export type BucketSummary = EntitlementSummary['buckets'][keyof EntitlementSummary['buckets']];
export type CreditBucket = keyof EntitlementSummary['buckets'];

export const CREDITS_QUERY_KEY = ['credits', 'summary'] as const;
/** Usage changes with every AI action; keep it fresh but avoid a request per render. */
export const CREDITS_STALE_MS = 30 * 1000;

/** Errors that no retry can fix (signed out, area not live yet, flag off). */
const FINAL_CODES = new Set([
  'unauthorized',
  'auth_expired',
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'NO_AUTH',
  'auth_other_brand',
  'not_implemented',
  'feature_disabled',
  'not_found',
]);

export function shouldRetryCredits(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && FINAL_CODES.has(code)) return false;
  return failureCount < 1;
}

export function useCredits(options: { enabled?: boolean } = {}): UseQueryResult<CreditsResponse> {
  return useQuery<CreditsResponse>({
    queryKey: CREDITS_QUERY_KEY,
    queryFn: ({ signal }) => getCredits({ signal }),
    staleTime: CREDITS_STALE_MS,
    retry: shouldRetryCredits,
    enabled: options.enabled ?? true,
  });
}

/** Seed the cache from `/auth/me.entitlements` (WP-10) or clear it on sign-out (null). */
export function primeCredits(client: QueryClient, summary: EntitlementSummary | null): void {
  if (!summary) {
    client.removeQueries({ queryKey: CREDITS_QUERY_KEY });
    return;
  }
  const prev = client.getQueryData<CreditsResponse>(CREDITS_QUERY_KEY);
  client.setQueryData<CreditsResponse>(CREDITS_QUERY_KEY, { summary, practice: prev?.practice ?? null });
}

/** Refetch after an action that spent or refunded credits. */
export function useInvalidateCredits(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: CREDITS_QUERY_KEY }), [client]);
}

/** One bucket's summary, or null when unknown. */
export function bucketSummary(summary: EntitlementSummary | null | undefined, bucket: string): BucketSummary | null {
  if (!summary) return null;
  return (summary.buckets as Record<string, BucketSummary | undefined>)[bucket] ?? null;
}

/** Credits usable now: the window allowance left plus bonus credits. Null when unknown. */
export function creditsLeft(b: BucketSummary | null | undefined): number | null {
  if (!b) return null;
  return Math.max(0, b.remaining) + Math.max(0, b.grantRemaining);
}
