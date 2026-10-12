// server/src/features/match/reportInventory.ts
//
// Where the competitiveness report reads the saved search and its posts —
// only through the search and feed seams (TASK_PLAN.md §2.1 rule 4).
//
//   getProfile    search `searchProfileService.get` (404 for another user's id)
//   sampleJobIds  feed `sampleForFilters`: the search's newest posts by id,
//                 with the feed's own filter rules, no ranking, PUBLIC rows
//                 only (the query itself leaves the user's own imported jobs
//                 out, so nothing is dropped afterwards) and at most 400
//   count         feed `countForFilters` (capped at 5,000)
//   limiting      feed `limitingFilters`: real counts per removable filter
// Aggregates count public rows only (TASK_PLAN §2.2); the live counts are
// public-only too. On GoApply with recruitment-info mode off every seam
// answers empty, so the report is suppressed.
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

/** The feed sample seam's ceiling (FEED_LIMITS.retrievalLimit). */
export const SAMPLE_SEAM_MAX = 400;

async function searchSeam() {
  return import('../search/index.js');
}

type FeedSeam = (typeof import('../feed/index.js'))['feedService'];
let feedSeamLoad: Promise<FeedSeam> | null = null;
/** One load shared by every caller (the report asks for the sample, the count and the limiting filters at once). */
function feedSeam(): Promise<FeedSeam> {
  return (feedSeamLoad ??= import('../feed/index.js').then((m) => m.feedService));
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
      const feed = await feedSeam();
      return feed.sampleForFilters(userId, sampleFilters(profile.filters), {
        order: 'newest',
        limit: Math.max(1, Math.min(SAMPLE_SEAM_MAX, Math.floor(limit))),
        publicOnly: true,
      });
    },
    async count(userId, filters) {
      return (await feedSeam()).countForFilters(userId, sampleFilters(filters));
    },
    async limiting(userId, profileId) {
      return withSearchErrors(async () => (await feedSeam()).limitingFilters(userId, profileId));
    },
  };
}
