'use client';

// components/features/marketing/hooks.ts — client hooks of the marketing site.
// API access stays in lib/api/support.ts (AGENTS rule); prices come from the
// shared plans query (hooks/credits/usePlans).

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';

import { useBrand } from '../../../lib/brand';
import { useCapabilities, type FlagKey } from '../../../lib/flags';
import { useToolsConfig } from '../tools';
import { getCreditCaps, getIndexStats } from '../../../lib/api/support';
import type { CreditCapsResponse, IndexStatsResponse } from '../../../lib/api/contracts/support';
import { buildSignupHref } from './links';

/** `/signup?from=<slug>` preserving `job`, `ref` and `utm_*` from the current URL. */
export function useSignupHref(from: string): string {
  const search = useSearchParams();
  return buildSignupHref(from, search ? new URLSearchParams(search.toString()) : null);
}

export const INDEX_STATS_QUERY_KEY = ['marketing', 'index-stats'] as const;
export const CREDIT_CAPS_QUERY_KEY = ['marketing', 'credit-caps'] as const;

/** Public counts (cached hourly by the API). Unknown → no data, never 0. */
export function useIndexStats() {
  return useQuery<IndexStatsResponse>({
    queryKey: INDEX_STATS_QUERY_KEY,
    queryFn: ({ signal }) => getIndexStats({ signal }),
    staleTime: 15 * 60 * 1000,
    retry: 1,
  });
}

/** Free vs Pro caps for the pricing table. */
export function useCreditCaps() {
  return useQuery<CreditCapsResponse>({
    queryKey: CREDIT_CAPS_QUERY_KEY,
    queryFn: ({ signal }) => getCreditCaps({ signal }),
    staleTime: 15 * 60 * 1000,
    retry: 1,
  });
}

/**
 * Programmatic browse pages are live (`seo.browse`, WP-56). The key is not in
 * the flag registry yet (requested from INT); until it is, this resolves
 * false, so quick search goes to signup and no browse link renders (fail closed).
 */
export const BROWSE_FLAG = 'seo.browse';

export function useBrowseEnabled(): boolean {
  const { flags } = useCapabilities();
  return (flags as Record<string, unknown> | null)?.[BROWSE_FLAG as FlagKey] === true;
}

/** True only when the flag is resolved and on (fail closed). */
export function useMarketingFlag(key: FlagKey | 'hiringContacts:on'): boolean {
  const { flags } = useCapabilities();
  if (!flags) return false;
  if (key === 'hiringContacts:on') return flags.hiringContacts === 'on';
  return flags[key] === true;
}

/**
 * Whether the site chrome links the free tools hub (/tools). RoboApply: always
 * (the tools run there). GoApply: only once the tools config says they run on
 * this stack (they do not in CN-0, where the hub has nothing to open), and
 * not before that answer arrives — a link to an empty page is a dead end.
 */
export function useFreeToolsLinked(): boolean {
  const cn = useBrand().market === 'cn';
  const config = useToolsConfig({ enabled: cn });
  return cn ? config.data?.available === true : true;
}
