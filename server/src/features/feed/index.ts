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
//   - similarJobIds: the public jobs nearest to a job by its vector (features/retrieval), for Similar jobs
// All of them run in the brand of the current request (or runWithBrand).
// `preview` and `POST /feed/query` accept `relevance` (free text to order by, never a filter);
// it is part of the session hash and changes the order from phase M4.

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { FeedCountResult, FeedItem, FilterSet, LimitingFilter, PublicFeedItem } from './contract.js';
import { defaultFeedQueryService } from './defaultService.js';
import type { AlertCandidateOptions, AlertCandidates, FeedPreviewInput, SampleOptions } from './FeedQueryService.js';

export * from './contract.js';
export { createFeedRouter } from './routes.js';
export { createPublicFeedRouter } from './publicRoutes.js';
export { createFeedQueryService, REPORT_CLOSE_REASONS } from './FeedQueryService.js';
export type { AlertCandidateOptions, AlertCandidates, FeedPreviewInput, FeedQueryInput, FeedQueryService, FeedServiceDeps, SampleOptions } from './FeedQueryService.js';
export { createMarketStats, marketStats, summarizePay, salaryWhere as marketSalaryWhere, SALARY_LOOKBACK_DAYS, SALARY_ROW_CAP } from './marketStats.js';
export type { JobRoleRow, MarketStats, MarketStatsDb, MarketStatsDeps, PayRow, SalarySample, SalaryStatsInput, SalaryStatsResult } from './marketStats.js';
export { createFeedSignals, feedSignals } from './signals.js';
export type { FeedSignals } from './signals.js';
/** The feed's personalisation switch (GoApply: a live 个性化推荐 grant; RoboApply: always) — WP-31 asserts through it. */
export { defaultPersonalized as isFeedPersonalized } from './defaultService.js';

export interface FeedService {
  countForFilters(userId: string, filters: FilterSet): Promise<FeedCountResult>;
  limitingFilters(userId: string, searchProfileId: string): Promise<LimitingFilter[]>;
  /** `input.relevance` (free text to order by, at most 240 characters) is accepted; it changes the order from phase M4. */
  preview(userId: string, input: FeedPreviewInput): Promise<FeedItem[]>;
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

// ── Similar jobs by vector (MKT-2H; MATCH 4.9 "Similar jobs") ─────────────

/** The part of a job row `similarJobIds` reads. */
export interface SimilarJobAnchor {
  id: string;
  market: string;
  locationCountry?: string | null;
}

/** What `similarJobIds` reads from features/retrieval (a fake in tests). */
export interface SimilarJobsDeps {
  currentModelTag: (market: string) => Promise<string | null>;
  nearestJobsByJob: (jobId: string, options: { market: string; country?: string | null; modelTag: string; limit: number }) => Promise<Array<{ jobId: string }>>;
}

let similarDepsOverride: SimilarJobsDeps | null = null;

/** Test seam: replace the retrieval reads (null restores the real ones). */
export function setSimilarJobsDepsForTests(deps: SimilarJobsDeps | null): void {
  similarDepsOverride = deps;
}

/**
 * The ids of the public, canonical, open jobs nearest to `row` by its vector,
 * nearest first, within the row's market (and its country when it has one).
 * Null when the market has no model tag, the job has no vector or the read
 * fails: the caller then uses its own list. The caller passes a row the viewer
 * may see (a public job, or the viewer's OWN import): a private job of another
 * person is never an anchor. The ids are candidates only: the caller still
 * drops hidden and flagged jobs and orders by fit.
 */
export async function similarJobIds(row: SimilarJobAnchor, limit: number): Promise<string[] | null> {
  try {
    const deps = similarDepsOverride ?? ((await import('../retrieval/index.js')) as SimilarJobsDeps);
    const modelTag = await deps.currentModelTag(row.market);
    if (!modelTag) return null;
    const near = await deps.nearestJobsByJob(row.id, { market: row.market, country: row.locationCountry ?? null, modelTag, limit });
    return near.length ? near.map((n) => n.jobId) : null;
  } catch {
    return null;
  }
}
