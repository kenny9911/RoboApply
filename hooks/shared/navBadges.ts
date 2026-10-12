'use client';

// hooks/shared/navBadges.ts — the nav's badge contract and the four badge
// hooks behind it (FND-6a; PRODUCT_PLAN.md §3.3).
//
// A nav entry names a badge by id (`components/v3/shell/destinations.ts`,
// field `badge`); the Sidebar, the bottom bar and the More sheet render
// whatever the matching hook returns. Each hook belongs to the area that owns
// the number, so no badge is ever computed in the shell:
//
//   jobs          hooks/feed/useJobsBadge.ts              WP-33  new jobs that fit since the last visit
//   ready         hooks/agent/useReadyBadge.ts            WP-53  kits ready and not yet opened
//   applications  hooks/tracker/useApplicationsBadge.ts   WP-38  applications with no reply after 10 days
//   profile       hooks/profile/useProfileBadge.ts        WP-19  "Incomplete" dot until autofill fields are filled
//
// Rules (D3): a badge is a real number from a real query. `null` means "no
// badge" (unknown, loading, not built yet or zero); a count of 0 is never
// drawn. Stubs return null until their owner fills them.
//
// Also here: the coaching roster gate. The Coaching entry shows only when the
// `coaching` flag is on AND the brand's roster has at least one active coach
// (PRODUCT §3.3), so the shell asks the coaching API, and only when the entry
// could otherwise show.

import { useQuery } from '@tanstack/react-query';

import { listCoaches } from '../../lib/api/coaching';
import { useJobsBadge } from '../feed/useJobsBadge';
import { useReadyBadge } from '../agent/useReadyBadge';
import { useApplicationsBadge } from '../tracker/useApplicationsBadge';
import { useProfileBadge } from '../profile/useProfileBadge';

export type NavBadgeId = 'jobs' | 'ready' | 'applications' | 'profile';

/** What a badge hook returns: a count, a dot, or nothing. */
export type NavBadgeValue = { kind: 'count'; count: number } | { kind: 'dot' };

export const NAV_BADGE_IDS: readonly NavBadgeId[] = ['jobs', 'ready', 'applications', 'profile'];

/** Key in the `nav` namespace for the screen-reader sentence of each badge. */
export const NAV_BADGE_LABEL_KEYS: Record<NavBadgeId, string> = {
  jobs: 'badge_new_jobs',
  ready: 'badge_ready',
  applications: 'badge_no_reply',
  profile: 'badge_profile',
};

/** Normalise a hook's value: zero, negative or non-finite counts are no badge. */
export function normalizeBadge(value: NavBadgeValue | null | undefined): NavBadgeValue | null {
  if (!value) return null;
  if (value.kind === 'dot') return value;
  return Number.isFinite(value.count) && value.count > 0 ? { kind: 'count', count: Math.floor(value.count) } : null;
}

/** All four badges. Every hook runs on every render (rules of hooks); each decides whether to fetch. */
export function useNavBadges(): Record<NavBadgeId, NavBadgeValue | null> {
  const jobs = useJobsBadge();
  const ready = useReadyBadge();
  const applications = useApplicationsBadge();
  const profile = useProfileBadge();
  return {
    jobs: normalizeBadge(jobs),
    ready: normalizeBadge(ready),
    applications: normalizeBadge(applications),
    profile: normalizeBadge(profile),
  };
}

export const COACH_ROSTER_QUERY_KEY = ['coaching', 'roster', 'nonEmpty'] as const;

/**
 * True when the brand's coach roster has at least one active coach. Asks only
 * when `enabled` (the flag is on and the entry could show); false while
 * loading, on error and when the area answers 501 (fail closed).
 */
export function useCoachRosterAvailable(enabled: boolean): boolean {
  const query = useQuery({
    queryKey: COACH_ROSTER_QUERY_KEY,
    queryFn: ({ signal }) => listCoaches(undefined, { signal }),
    enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  return enabled && (query.data?.items?.length ?? 0) > 0;
}
