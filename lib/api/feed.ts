// lib/api/feed.ts — Job feed (For you / Explore), hide, report, ratings, counts.
//
// Thin typed wrappers over the area contract (FND-7). Owner: WP-33 (API: WP-32).
// Request types are the contract's zod input types; response types are the
// contract's views. Change a signature here only together with its contract.
//
// The logged-out public feed (GET /api/v1/public/feed) is in
// lib/api/visitor.ts (WP-78).
//
// Endpoints:
//   POST   /api/v1/roboapply/feed/query
//   GET    /api/v1/roboapply/feed/counts
//   POST   /api/v1/roboapply/feed/jobs/:id/hide
//   POST   /api/v1/roboapply/feed/jobs/:id/unhide
//   POST   /api/v1/roboapply/feed/jobs/:id/report
//   POST   /api/v1/roboapply/feed/impressions
//   POST   /api/v1/roboapply/feed/rating
//   GET    /api/v1/roboapply/feed/explore
//   POST   /api/v1/roboapply/feed/nl-query
//   GET    /api/v1/roboapply/feed/new-count
//   GET    /api/v1/roboapply/feed/skills-check

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as F from './contracts/feed';

/** `feed.query` — POST /api/v1/roboapply/feed/query */
export function queryFeed(body: In<typeof F.FeedQueryBodySchema> = {}, opts?: CallOptions): Promise<F.FeedQueryResponse> {
  return call<F.FeedQueryResponse>('POST', `/api/v1/roboapply/feed/query`, { ...opts, body });
}

/** `feed.counts` — GET /api/v1/roboapply/feed/counts */
export function getFeedCounts(opts?: CallOptions): Promise<F.FeedCountsResponse> {
  return call<F.FeedCountsResponse>('GET', `/api/v1/roboapply/feed/counts`, opts);
}

/** `feed.hide` — POST /api/v1/roboapply/feed/jobs/:id/hide */
export function hideJob(id: string, body: In<typeof F.HideJobBodySchema>, opts?: CallOptions): Promise<F.HideJobResponse> {
  return call<F.HideJobResponse>('POST', `/api/v1/roboapply/feed/jobs/${seg(id)}/hide`, { ...opts, body });
}

/** `feed.unhide` — POST /api/v1/roboapply/feed/jobs/:id/unhide */
export function unhideJob(id: string, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/feed/jobs/${seg(id)}/unhide`, opts);
}

/** `feed.report` — POST /api/v1/roboapply/feed/jobs/:id/report */
export function reportJob(id: string, body: In<typeof F.ReportJobBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/feed/jobs/${seg(id)}/report`, { ...opts, body });
}

/** `feed.impressions` — POST /api/v1/roboapply/feed/impressions */
export function recordImpressions(body: In<typeof F.ImpressionsBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/feed/impressions`, { ...opts, body });
}

/** `feed.rating` — POST /api/v1/roboapply/feed/rating */
export function rateFeed(body: In<typeof F.FeedRatingBodySchema>, opts?: CallOptions): Promise<void> {
  return call<void>('POST', `/api/v1/roboapply/feed/rating`, { ...opts, body });
}

/** `feed.explore` — GET /api/v1/roboapply/feed/explore */
export function getExplore(opts?: CallOptions): Promise<F.ExploreResponse> {
  return call<F.ExploreResponse>('GET', `/api/v1/roboapply/feed/explore`, opts);
}

/** `feed.nlQuery` — POST /api/v1/roboapply/feed/nl-query */
export function nlQuery(body: In<typeof F.NlQueryBodySchema>, opts?: CallOptions): Promise<F.NlQueryResponse> {
  return call<F.NlQueryResponse>('POST', `/api/v1/roboapply/feed/nl-query`, { ...opts, body });
}

/** `feed.newCount` — GET /api/v1/roboapply/feed/new-count */
export function getNewCount(query?: In<typeof F.NewCountQuerySchema>, opts?: CallOptions): Promise<F.NewCountResponse> {
  return call<F.NewCountResponse>('GET', withQuery(`/api/v1/roboapply/feed/new-count`, query), opts);
}

/** `feed.skillsCheck` — GET /api/v1/roboapply/feed/skills-check */
export function getSkillsCheck(opts?: CallOptions): Promise<F.SkillsCheckResponse> {
  return call<F.SkillsCheckResponse>('GET', `/api/v1/roboapply/feed/skills-check`, opts);
}

/** Every wrapper of this area, for callers that prefer one import. */
export const feedApi = {
  queryFeed,
  getFeedCounts,
  hideJob,
  unhideJob,
  reportJob,
  recordImpressions,
  rateFeed,
  getExplore,
  nlQuery,
  getNewCount,
  getSkillsCheck,
};
