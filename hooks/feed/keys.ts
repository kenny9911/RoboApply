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
//                     and version, so a filter change still gives a new list,
//                     and the words the list is ranked by (useListRelevance),
//                     so ranking by them, or clearing them, gives a new list too.
//   ['pay-check', …]  the /pay page's answer for one title and place. Not under
//                     'feed' either: a job action changes nothing it reads (it
//                     counts other people's posts), so a Save never refetches it.

import type { FeedSort } from '../../lib/api/contracts/feed';

export type FeedFitView = 'all' | 'good' | 'great';

export interface FeedListKeyInput {
  searchProfileId: string | null;
  version: number | null;
  sort: FeedSort;
  fitTier: FeedFitView;
  /** Stable string of query-only overrides (Explore category), '' for none. */
  overridesKey?: string;
  /** The words the list is ranked by (never a filter), '' or absent for none: another text is another list. */
  relevance?: string | null;
  /** `false`: a read that is not a visit to the Jobs list (the Dashboard's picks); kept apart from the list's own read. */
  visit?: boolean;
}

export const feedKeys = {
  all: ['feed'] as const,
  newCount: () => ['feed', 'new-count'] as const,
  explore: () => ['feed', 'explore'] as const,
  skillsCheck: () => ['feed', 'skills-check'] as const,
  payCheck: (title: string, location: string) => ['pay-check', title, location] as const,
  listRoot: ['feed-list'] as const,
  list: (k: FeedListKeyInput) =>
    k.visit === false
      ? (['feed-list', k.searchProfileId ?? '', k.version ?? 0, k.sort, k.fitTier, k.overridesKey ?? '', k.relevance ?? '', 'no-visit'] as const)
      : (['feed-list', k.searchProfileId ?? '', k.version ?? 0, k.sort, k.fitTier, k.overridesKey ?? '', k.relevance ?? ''] as const),
};
