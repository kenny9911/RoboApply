// hooks/feed/keys.ts — React Query keys of the feed area (WP-33).
//
// Two roots on purpose:
//   ['feed', …]       small reads (new-count, explore, skills-check). Every job
//                     action (save, hide, apply) invalidates this root
//                     (hooks/shared/useJobActions JOB_RELATED_QUERY_ROOTS) and
//                     useApplyFilters invalidates it after a filter change.
//   ['feed-list', …]  the infinite list. NOT under 'feed': refetching it with
//                     no cursor starts a new feed session, which the server
//                     rate-limits (20 per 10 minutes), so a Save must never
//                     reload the list. The key carries the saved search's id
//                     and version, so a filter change still gives a new list.

import type { FeedSort } from '../../lib/api/contracts/feed';

export type FeedFitView = 'all' | 'good' | 'great';

export interface FeedListKeyInput {
  searchProfileId: string | null;
  version: number | null;
  sort: FeedSort;
  fitTier: FeedFitView;
  /** Stable string of query-only overrides (Explore category), '' for none. */
  overridesKey?: string;
}

export const feedKeys = {
  all: ['feed'] as const,
  newCount: () => ['feed', 'new-count'] as const,
  explore: () => ['feed', 'explore'] as const,
  skillsCheck: () => ['feed', 'skills-check'] as const,
  listRoot: ['feed-list'] as const,
  list: (k: FeedListKeyInput) =>
    ['feed-list', k.searchProfileId ?? '', k.version ?? 0, k.sort, k.fitTier, k.overridesKey ?? ''] as const,
};
