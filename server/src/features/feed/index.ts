// server/src/features/feed/index.ts — public surface of the feed area (FND-5; owner WP-32).
//
// Seams other areas call (all stubs until WP-32):
//   - countForFilters / limitingFilters: search (/search-profiles/count, /:id/limiting), onboarding O7
//   - preview: the Assistant's search_jobs / top_fit_jobs tools (no session)
//   - publicList: visitor feed (WP-78)

import { NotImplementedError } from '../../platform/http.js';
import type { FeedCountResult, FeedItem, FeedSort, FilterSet, LimitingFilter, PublicFeedItem } from './contract.js';

export * from './contract.js';
export { createFeedRouter } from './routes.js';
export { createPublicFeedRouter } from './publicRoutes.js';

export interface FeedService {
  countForFilters(userId: string, filters: FilterSet): Promise<FeedCountResult>;
  limitingFilters(userId: string, searchProfileId: string): Promise<LimitingFilter[]>;
  preview(userId: string, input: { q?: string; filters?: Partial<FilterSet>; sort?: FeedSort; limit: number }): Promise<FeedItem[]>;
  publicList(input: { role?: string; city?: string; country?: string; limit: number }): Promise<PublicFeedItem[]>;
}

/** Stub until WP-32. `countForFilters` callers return `{count:null}` on NotImplementedError. */
export const feedService: FeedService = {
  async countForFilters() {
    throw new NotImplementedError('feed.countForFilters');
  },
  async limitingFilters() {
    throw new NotImplementedError('feed.limitingFilters');
  },
  async preview() {
    throw new NotImplementedError('feed.preview');
  },
  async publicList() {
    throw new NotImplementedError('feed.publicList');
  },
};

export const countForFilters = (userId: string, filters: FilterSet) => feedService.countForFilters(userId, filters);
export const limitingFilters = (userId: string, searchProfileId: string) => feedService.limitingFilters(userId, searchProfileId);
