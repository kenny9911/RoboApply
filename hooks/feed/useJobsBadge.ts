'use client';

// hooks/feed/useJobsBadge.ts — the Jobs nav badge: new jobs that fit since the
// user's last visit to the feed (PRODUCT_PLAN.md §3.3, row 1; WP-33).
//
// The number is the server's real count (`GET /feed/new-count`: jobs at Good
// fit or better since `lastFeedVisitAt`), never an estimate. Unknown, loading,
// an error, a feed that is switched off for this brand, and zero all return
// null: the shell draws nothing for null (hooks/shared/navBadges.ts).
//
// Visiting the feed clears it: JobsWorkspace sets this query's data to 0 once
// its first page is on screen. Which request stamps `lastFeedVisitAt` on the
// server is WP-32's (requested: the feed visit, not this badge read).

import { useQuery } from '@tanstack/react-query';

import { getNewCount } from '../../lib/api/feed';
import { useFlag } from '../../lib/flags';
import type { NavBadgeValue } from '../shared/navBadges';
import { feedKeys } from './keys';

/** Count → badge value; null for anything that is not a positive whole number. Pure, for tests. */
export function jobsBadgeFrom(count: unknown): NavBadgeValue | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  return { kind: 'count', count: Math.floor(count) };
}

export function useJobsBadge(): NavBadgeValue | null {
  const feedOn = useFlag('jobs.feed');
  const { data } = useQuery({
    queryKey: feedKeys.newCount(),
    queryFn: ({ signal }) => getNewCount(undefined, { signal }),
    enabled: feedOn,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (!feedOn) return null;
  return jobsBadgeFrom(data?.count);
}
