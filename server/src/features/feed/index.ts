// server/src/features/feed/index.ts — public surface of the feed area (FND-5; owner WP-32).
//
// Seams other areas call:
//   - countForFilters / limitingFilters: search (/search-profiles/count, /:id/limiting), onboarding O7
//   - preview: the Assistant's search_jobs / top_fit_jobs tools, the fit-score precompute (no session)
//   - publicList: visitor feed (WP-78; the SEO pages' public rules, no fit)
//   - sampleForFilters: job ids for a filter set, newest first, no ranking (competitiveness report)
//   - alertCandidates: new job ids for a saved search with the feed's filter semantics (alerts)
//   - marketStats.salary: posted pay for a role and place, Sourced, N ≥ 20 (Assistant, offers)
//   - feedSignals.latestRating / reportedSince: the user's own feed actions (Assistant nudges)
//   - recordInteraction: affinity from save / apply click / applied (WP-34, WP-38, extension)
//   - isFeedPersonalized: whether the feed may use the profile for order and fit (WP-31)
// All of them run in the brand of the current request (or runWithBrand).

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { FeedCountResult, FeedItem, FeedSort, FilterSet, LimitingFilter, PublicFeedItem } from './contract.js';
import { defaultFeedQueryService } from './defaultService.js';
import type { AlertCandidateOptions, AlertCandidates, SampleOptions } from './FeedQueryService.js';

export * from './contract.js';
export { createFeedRouter } from './routes.js';
export { createPublicFeedRouter } from './publicRoutes.js';
export { createFeedQueryService, REPORT_CLOSE_REASONS } from './FeedQueryService.js';
export type { AlertCandidateOptions, AlertCandidates, FeedQueryService, FeedServiceDeps, SampleOptions } from './FeedQueryService.js';
export { createMarketStats, marketStats, summarizePay, salaryWhere as marketSalaryWhere, SALARY_LOOKBACK_DAYS, SALARY_ROW_CAP } from './marketStats.js';
export type { JobRoleRow, MarketStats, MarketStatsDb, MarketStatsDeps, PayRow, SalarySample, SalaryStatsInput, SalaryStatsResult } from './marketStats.js';
export { createFeedSignals, feedSignals } from './signals.js';
export type { FeedSignals } from './signals.js';
/** The feed's personalisation switch (GoApply: a live 个性化推荐 grant; RoboApply: always) — WP-31 asserts through it. */
export { defaultPersonalized as isFeedPersonalized } from './defaultService.js';

export interface FeedService {
  countForFilters(userId: string, filters: FilterSet): Promise<FeedCountResult>;
  limitingFilters(userId: string, searchProfileId: string): Promise<LimitingFilter[]>;
  preview(userId: string, input: { q?: string; filters?: Partial<FilterSet>; sort?: FeedSort; limit: number }): Promise<FeedItem[]>;
  publicList(input: { role?: string; city?: string; country?: string; limit: number }): Promise<PublicFeedItem[]>;
  /**
   * Job ids for `filters`, newest first, with the feed's own filter rules and
   * no ranking. `limit` ≤ 400; `publicOnly` (default true) never returns the
   * user's own imported jobs. GoApply with recruitment-info mode off: [].
   */
  sampleForFilters(userId: string, filters: FilterSet, options: SampleOptions): Promise<string[]>;
  /**
   * New jobs for a saved search's alert: public jobs first seen after
   * `since` that pass the search's filters as the feed applies them (radius,
   * posted-within, GoApply fields, visibility and mode rules). No ranking, no
   * session; `truncated` says more than `limit` matched.
   */
  alertCandidates(searchProfileId: string, options: AlertCandidateOptions): Promise<AlertCandidates>;
  /** Affinity +0.1 save / +0.15 apply click / +0.25 applied (ARCH §4.9). Never throws for a missing job. */
  recordInteraction(userId: string, jobId: string, kind: 'save' | 'apply_click' | 'applied'): Promise<void>;
}

function ctxFor(userId: string) {
  const brand = getCurrentBrandOrDefault();
  return { userId, market: brand.market, brandId: brand.id, now: defaultFeedQueryService.now() };
}

export const feedService: FeedService = {
  countForFilters: (userId, filters) => defaultFeedQueryService.countForFilters(ctxFor(userId), filters),
  limitingFilters: (userId, searchProfileId) => defaultFeedQueryService.limitingFilters(ctxFor(userId), searchProfileId),
  preview: (userId, input) => defaultFeedQueryService.preview(ctxFor(userId), input),
  publicList: (input) => {
    const brand = getCurrentBrandOrDefault();
    return defaultFeedQueryService.publicList({ market: brand.market, now: defaultFeedQueryService.now() }, input);
  },
  sampleForFilters: (userId, filters, options) => defaultFeedQueryService.sampleForFilters(ctxFor(userId), filters, options),
  alertCandidates: (searchProfileId, options) => {
    const brand = getCurrentBrandOrDefault();
    return defaultFeedQueryService.alertCandidates({ market: brand.market, now: defaultFeedQueryService.now() }, searchProfileId, options);
  },
  recordInteraction: (userId, jobId, kind) => defaultFeedQueryService.recordInteraction(ctxFor(userId), jobId, kind),
};

export const countForFilters = (userId: string, filters: FilterSet) => feedService.countForFilters(userId, filters);
export const limitingFilters = (userId: string, searchProfileId: string) => feedService.limitingFilters(userId, searchProfileId);
