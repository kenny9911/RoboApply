'use client';

// hooks/credits/useVisitorCountry.ts — the buyer's country for the plan sheet
// (EU/UK/TW withdrawal acknowledgement, Taiwan price line; WP-21b).
//
// Resolution order, first known wins:
//   1. `known` — a server page already read the edge header (/settings/billing
//      passes it; `null` there means "the edge sent no usable country", so
//      no lookup is made);
//   2. `fromPlans` — `GET /billing/plans` `visitor.country` (requested from WP-21a);
//   3. the `visitorCountryAction` server function (same edge header), for
//      client-only surfaces such as /settings#billing.
// `resolved` is false only while step 3 is in flight; unknown stays null and
// is never guessed from the locale.

import { useQuery } from '@tanstack/react-query';

import { visitorCountryAction } from '../../app/(auth)/settings/billing/actions';

export const VISITOR_COUNTRY_QUERY_KEY = ['credits', 'visitorCountry'] as const;

export interface VisitorCountry {
  country: string | null;
  resolved: boolean;
}

function normalise(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

export function useVisitorCountry(
  known: string | null | undefined,
  fromPlans: string | null | undefined,
  options: { enabled?: boolean } = {},
): VisitorCountry {
  const knownCountry = normalise(known);
  const plansCountry = normalise(fromPlans);
  const needsLookup = known === undefined && !plansCountry && (options.enabled ?? true);
  const q = useQuery<string | null>({
    queryKey: VISITOR_COUNTRY_QUERY_KEY,
    queryFn: async () => normalise(await visitorCountryAction()),
    enabled: needsLookup,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  if (knownCountry) return { country: knownCountry, resolved: true };
  if (plansCountry) return { country: plansCountry, resolved: true };
  if (!needsLookup) return { country: null, resolved: true };
  if (q.isError) return { country: null, resolved: true };
  return { country: q.data ?? null, resolved: q.isSuccess };
}
