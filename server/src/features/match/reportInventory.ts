// server/src/features/match/reportInventory.ts
//
// Where the competitiveness report reads the saved search and its posts —
// only through the search and feed seams (TASK_PLAN.md §2.1 rule 4). The
// preview seam lists what the user's feed lists for that search: the brand's
// market, canonical rows, hidden jobs excluded — and, because it has no
// public-only switch, the user's own imported (private) jobs too. Those are
// dropped by the service (CompetitivenessService.samplePosts) before any
// aggregate is counted: aggregates count public rows only (TASK_PLAN §2.2).
// The live counts (`countForFilters`, `limitingFilters`) are public-only.
//
//   getProfile    search `searchProfileService.get` (404 for another user's id)
//   sampleJobIds  feed `preview` sorted newest, fit-tier view off: the newest
//                 posts of the search (the seam's ceiling is 50 posts; a
//                 dedicated sample seam is a handoff request to the feed area)
//   count         feed `countForFilters` (capped at 5,000)
//   limiting      feed `limitingFilters`: real counts per removable filter
//
// Imports are lazy: the feed area imports MATCH, so a static import here
// would be a cycle.

import type { FeedCountResult, LimitingFilter } from '../feed/index.js';
import type { FilterSet, SearchProfileWire } from '../search/index.js';

export interface ReportInventory {
  getProfile(userId: string, id: string): Promise<SearchProfileWire>;
  sampleJobIds(userId: string, profile: SearchProfileWire, limit: number): Promise<string[]>;
  count(userId: string, filters: FilterSet): Promise<FeedCountResult>;
  limiting(userId: string, profileId: string): Promise<LimitingFilter[]>;
}

/** The search's filters without the fit-tier view (a view filter would bias the sample toward good fits). */
export function sampleFilters(filters: FilterSet): FilterSet {
  const { fitTier: _view, ...rest } = filters;
  return rest;
}

/**
 * Overrides that make the feed preview (which starts from the ACTIVE search)
 * read exactly `target`'s filters: every key of the active search is cleared
 * first, then `target`'s keys are set, and the fit-tier view is turned off.
 */
export function previewOverrides(active: Pick<SearchProfileWire, 'id' | 'filters'>, target: Pick<SearchProfileWire, 'id' | 'filters'>): Partial<FilterSet> {
  const cleared: Record<string, undefined> = {};
  if (active.id !== target.id) for (const k of Object.keys(active.filters)) cleared[k] = undefined;
  return { ...cleared, ...(active.id === target.id ? {} : sampleFilters(target.filters)), fitTier: 'all' } as Partial<FilterSet>;
}

async function searchSeam() {
  return import('../search/index.js');
}

async function feedSeam() {
  return (await import('../feed/index.js')).feedService;
}

async function withSearchErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { searchErrorToHttpError } = await searchSeam();
    throw searchErrorToHttpError(err) ?? err;
  }
}

export function createDefaultReportInventory(): ReportInventory {
  return {
    async getProfile(userId, id) {
      const { searchProfileService } = await searchSeam();
      return withSearchErrors(() => searchProfileService.get(userId, id));
    },
    async sampleJobIds(userId, profile, limit) {
      const { searchProfileService } = await searchSeam();
      const active = await withSearchErrors(() => searchProfileService.getActive(userId));
      const feed = await feedSeam();
      const items = await feed.preview(userId, { filters: previewOverrides(active, profile), sort: 'newest', limit });
      return items.map((i) => i.jobId);
    },
    async count(userId, filters) {
      return (await feedSeam()).countForFilters(userId, sampleFilters(filters));
    },
    async limiting(userId, profileId) {
      return withSearchErrors(async () => (await feedSeam()).limitingFilters(userId, profileId));
    },
  };
}
