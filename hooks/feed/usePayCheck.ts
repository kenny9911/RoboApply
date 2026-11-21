'use client';

// hooks/feed/usePayCheck.ts — the /pay page's read: what live posts of the
// last 90 days in the brand's market state about pay for a job title, with an
// optional place (GET /feed/pay-check; server feed/payCheck.ts). Read-only, no
// credits. Nothing is asked until there is a title; one answer per title and
// place, kept 10 minutes (the posts behind it change daily at most).

import { useQuery } from '@tanstack/react-query';

import { getPayCheck } from '../../lib/api/feed';
import { feedKeys } from './keys';

export interface PayCheckAsk {
  title: string;
  /** City, region, country or "remote"; empty for anywhere. */
  location: string;
}

/** The ask as the server reads it (trimmed; a blank location is no location). Pure. */
export function payCheckQuery(ask: PayCheckAsk): { title: string; location?: string } {
  const title = ask.title.trim();
  const location = ask.location.trim();
  return location ? { title, location } : { title };
}

export function usePayCheck(ask: PayCheckAsk | null) {
  const query = ask ? payCheckQuery(ask) : null;
  return useQuery({
    queryKey: feedKeys.payCheck(query?.title ?? '', query?.location ?? ''),
    queryFn: ({ signal }) => getPayCheck(query!, { signal }),
    enabled: !!query?.title,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}
