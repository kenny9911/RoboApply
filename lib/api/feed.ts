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

// ── Listing contract readers (parity plan §5: "source line and apply target") ──
//
// The feed item and the job detail expose
//   apply:  { url, target: 'gohire' | 'employer' }
//   source: { name, original, url, lastVerifiedAt, via: 'bank' | 'ats' | 'import' }
// and the feed response carries `sources: { gohire, employerBoards }` and
// `thin`. Every field is read with a safe default, so a response from before
// those fields existed renders exactly what it rendered then: nothing is
// guessed, a missing value is null (D3).

export type ListingVia = 'bank' | 'ats' | 'import';
export type ApplyTarget = 'gohire' | 'employer';

/** Where a posting came from, as the card and the job page show it. */
export interface ListingSource {
  /** The channel we read it through (the board vendor, the recruiter bank). */
  name: string | null;
  /** Who published it first: the employer for a board row, the bank for a bank row. */
  original: string | null;
  /** The original posting. Only http(s); anything else is dropped. */
  url: string | null;
  /** When we last saw the posting live (the row's last-seen time). */
  lastVerifiedAt: string | null;
  via: ListingVia | null;
}

/** Where the apply button leads. `url` is null when the posting has no usable link. */
export interface ListingApply {
  url: string | null;
  target: ApplyTarget | null;
}

type Loose = Record<string, unknown>;
const looseObj = (v: unknown): Loose | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : null);
const looseStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** An http(s) link as it will be rendered, or null. Never a `javascript:` or relative value. */
export function safeHttpUrl(value: unknown): string | null {
  const raw = looseStr(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const VIA_OF_KIND: Record<string, ListingVia> = { bank: 'bank', ats_public: 'ats', user_import: 'import' };

/**
 * The source of a feed item or a job (`{ source, lastSeenAt, fromRecruiterBank }`).
 * `via` falls back to the source kind, `lastVerifiedAt` to `lastSeenAt`, and
 * `original` to the detail view's older `originalName`.
 */
export function listingSource(row: unknown): ListingSource {
  const r = looseObj(row) ?? {};
  const source = looseObj(r.source) ?? {};
  const via = source.via === 'bank' || source.via === 'ats' || source.via === 'import' ? source.via : (VIA_OF_KIND[String(source.kind)] ?? (r.fromRecruiterBank === true ? 'bank' : null));
  return {
    name: looseStr(source.name),
    original: looseStr(source.original) ?? looseStr(source.originalName),
    url: safeHttpUrl(source.url),
    lastVerifiedAt: looseStr(source.lastVerifiedAt) ?? looseStr(r.lastSeenAt),
    via,
  };
}

/**
 * The apply target of a feed item or a job.
 *
 * With the contract field (`apply`, present even when it is null) the server's
 * answer is final: `apply: null` is a posting with no usable link, and
 * `target: null` is a link whose destination the server does not claim (for
 * example a recruiter-bank row that is not GoHire's). Neither is replaced by a
 * guess.
 *
 * Only a response from before the contract (no `apply` field at all) falls
 * back: `url` to the detail view's `applyUrl`, `target` to the source kind (a
 * bank row opens the bank's page, a board row the employer's), null otherwise.
 * The target is never read from the link itself.
 */
export function listingApply(row: unknown): ListingApply {
  const r = looseObj(row) ?? {};
  if (r.apply !== undefined) {
    const apply = looseObj(r.apply) ?? {};
    return { url: safeHttpUrl(apply.url), target: apply.target === 'gohire' || apply.target === 'employer' ? apply.target : null };
  }
  const via = listingSource(r).via;
  return { url: safeHttpUrl(r.applyUrl), target: via === 'bank' ? 'gohire' : via === 'ats' ? 'employer' : null };
}

/**
 * True when the posting states no pay. With the contract field (`salary`,
 * present even when it is null) that is `salary: null`; a response from before
 * it has no `pay` and no pay words.
 */
export function payUndisclosed(row: unknown): boolean {
  const r = looseObj(row) ?? {};
  if (r.salary !== undefined) return !looseObj(r.salary);
  return !looseObj(r.pay) && !looseStr(r.payText);
}

/** What the rows of one feed query come from (for the list header). */
export interface FeedSourcesSummary {
  /** Recruiter-bank rows are listed. */
  gohire: boolean;
  /** How many employer careers boards the visible rows come from. */
  employerBoards: number;
}

/** `sources` of a feed response, or null when the server sent none (no header line then). */
export function feedSources(response: unknown): FeedSourcesSummary | null {
  const sources = looseObj(looseObj(response)?.sources);
  if (!sources) return null;
  const boards = typeof sources.employerBoards === 'number' && Number.isFinite(sources.employerBoards) ? Math.max(0, Math.floor(sources.employerBoards)) : 0;
  return { gohire: sources.gohire === true, employerBoards: boards };
}

/** True only when the server says the result set is thin (the deep links are then offered). */
export function feedIsThin(response: unknown): boolean {
  return looseObj(response)?.thin === true;
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
