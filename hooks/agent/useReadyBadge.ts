'use client';

// hooks/agent/useReadyBadge.ts — the "Ready to apply" nav badge: kits that are
// ready and not opened yet (PRODUCT_PLAN.md §3.3, row 2; WP-53).
//
// The nav renders on every app page, so the badge reads WP-52's one-count
// endpoint (`GET /agent/badge`) instead of the whole list, and never polls:
// it refreshes when the area's queries are invalidated (every kit action
// does) and on window focus. Null for unknown, loading, an error, the flag
// off and zero: the shell draws nothing for null (hooks/shared/navBadges.ts).

import { useQuery } from '@tanstack/react-query';

import { useFlag } from '../../lib/flags';
import { getReadyBadge, type ReadyBadgeResponse } from '../../lib/api/agent';
import type { NavBadgeValue } from '../shared/navBadges';
import { agentKeys } from './keys';
import { shouldRetryAgent } from './useAgent';

/** Server count → badge value. Pure, for tests. */
export function readyBadgeFrom(data: ReadyBadgeResponse | null | undefined): NavBadgeValue | null {
  const count = data?.readyNotOpened;
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  return { kind: 'count', count: Math.floor(count) };
}

export function useReadyBadge(): NavBadgeValue | null {
  const on = useFlag('agent');
  const { data } = useQuery<ReadyBadgeResponse>({
    queryKey: agentKeys.badge(),
    queryFn: ({ signal }) => getReadyBadge({ signal }),
    enabled: on,
    staleTime: 60_000,
    retry: shouldRetryAgent,
    refetchInterval: false,
  });
  if (!on) return null;
  return readyBadgeFrom(data);
}
