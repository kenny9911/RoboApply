// server/src/features/feed/contract.ts
//
// The job feed (ARCHITECTURE.md §2.6, §3.4, §4.8; TASK_PLAN.md WP-32, WP-33;
// public part WP-78). Mounts: /api/v1/roboapply/feed (seeker, capability
// `jobs.feed` per route) and /api/v1/public/feed (visitor list).
//
// Honesty (D3): FeedItem badges come only from real fields; pay is "Pay not
// listed" (null), never 0; "Direct from employer" only when
// `fromRecruiterBank && employerVerified && !isAgency`; applicant counts only
// when sourced; sponsorship badge only from a quoted signal. Every aggregate
// and public count filters `visibility='public' AND isCanonical AND
// archivedAt IS NULL AND market = brand.market`.
//
// Source and apply contract (GOAPPLY_PARITY_PLAN §5; consumed by the web cards,
// the job page and the feed header): every item carries `apply { url, target }`,
// `source { name, original, url, lastVerifiedAt, via }` and `salary` (null when
// the posting states no pay); the query response carries `sources { gohire,
// employerBoards }` on GoApply and `thin`. The rules are in feed/sourceLine.ts.
// D1: `apply.url` is a link the user opens; nothing is submitted for them.

import { z } from 'zod';
import type { MatchExplanation } from '../compliance/contract.js';
import type { FilterSet, FilterSetPatch } from '../search/contract.js';
import type { ApplyLink, SalaryLine, SourceFacts } from './sourceLine.js';

export type { ApplyLink, ApplyTarget, SalaryLine, SourceFacts, SourceKind, SourceVia } from './sourceLine.js';
// The rules behind those fields, pure and dependency-free, for every area that
// shows a job (job page, alerts, Ready to apply, the GoApply card meta).
export {
  EMPLOYER_BOARD_SOURCES,
  GOHIRE_SOURCE_BOARD,
  applyLinkOf,
  cnListable,
  cnListableWhere,
  hasApplyLink,
  hasPayFigure,
  httpUrl,
  salaryLineOf,
  sourceFactsOf,
  sourceKindOf,
  viaOf,
} from './sourceLine.js';

const Id = z.string().min(1).max(64);

export const FEED_SORTS = ['recommended', 'newest', 'best_fit', 'highest_pay', 'deadline'] as const;
export type FeedSort = (typeof FEED_SORTS)[number];
export const FIT_TIER_LABELS = ['great', 'good', 'possible', 'unlikely'] as const;
export type FitTier = (typeof FIT_TIER_LABELS)[number];

// ── POST /feed/query ─────────────────────────────────────────────────────

export const FeedQueryBodySchema = z
  .object({
    searchProfileId: Id.optional(),
    /**
     * `deadline` is GoApply only: jobs whose posting states a 网申 close date
     * (soonest first), then the rest newest first.
     */
    sort: z.enum(FEED_SORTS).default('recommended'),
    q: z.string().trim().max(200).optional(),
    /** Partial FilterSet applied on top of the profile for this query only (validated by search.parseFilterSet). */
    overrides: z.record(z.string(), z.unknown()).optional(),
    cursor: z.string().max(512).optional(),
    /** View filter: hide weaker fits (counts returned in `hiddenByTier`). */
    fitTier: z.enum(['all', 'good', 'great']).optional(),
  })
  .strict();

/**
 * How the list was ordered. `recency` = date posted + filters only: GoApply
 * users who turned 个性化推荐 off or have not chosen yet (PIPL Art. 24), where
 * no fit score is used or shown.
 */
export type FeedOrder = 'personalized' | 'recency';

export interface FitBadge {
  tier: FitTier;
  /** 0–100, shown as "87 / 100". */
  score: number;
  /** `pre` = deterministic "Quick estimate"; `ai` = scorer v3. */
  kind: 'pre' | 'ai';
  topGap: string | null;
  topOverlap: string | null;
}

export interface FeedItem {
  jobId: string;
  title: string;
  company: {
    id: string | null;
    name: string;
    logoUrl: string | null;
    /** Only with a provenance entry in RACompany.facts (D3); null renders "Not listed". */
    sizeBand?: { value: string; source: string; asOf: string } | null;
  };
  location: string | null;
  workModel: 'remote' | 'hybrid' | 'onsite' | null;
  employmentType: string | null;
  seniority: string | null;
  /** Null = "Pay not listed" (never 0). */
  pay: { min: number | null; max: number | null; currency: string; period: 'year' | 'month' | 'week' | 'day' | 'hour'; text: string | null } | null;
  /** CN "N薪" when the posting states it. */
  payMonths?: number | null;
  postedAt: string | null;
  /**
   * True when `postedAt` is not the posting's own date but the day we first
   * saw the job (or the user added it): the card says "First seen {date}",
   * as the job page does, never "Posted {date}".
   */
  postedAtEstimated?: boolean;
  /** "Last checked {date}" from lastSeenAt. */
  lastSeenAt: string | null;
  /**
   * Source line, e.g. aggregator + original host, or `{sourceName}`, with the
   * facts every mainland card shows (来源 / 原始链接 / 最后核验): `original`
   * (the original publisher: the employer for an employer-board row), `url`
   * (the original posting link), `lastVerifiedAt` (when we last saw it live)
   * and `via` ('bank' | 'ats' | 'import'; absent for an aggregator row).
   * The four facts are always sent by the server (typed optional so an object
   * built elsewhere is still a FeedItem; readers default them to null).
   */
  source: { name: string; kind: 'provider' | 'bank' | 'ats_public' | 'user_import' } & Partial<SourceFacts>;
  /**
   * The posting's own apply link, which the user opens (D1: we never submit).
   * `target`: 'gohire' = the GoHire posting page (a GoHire bank row),
   * 'employer' = the employer's own careers site or ATS page (an employer-board
   * row), null = not known (a user's own import, an aggregator's link). The
   * whole value is null when the row has no usable link. Always sent.
   */
  apply?: ApplyLink | null;
  /**
   * Pay as the posting states it, in one place for the card: `text` is the
   * line as posted ("18-28K·15薪") where there is one. Null when the posting
   * states no pay ("薪资未披露" / "Pay not listed"; never 面议, never 0).
   * Always sent; agrees with `pay` (which stays for existing readers).
   */
  salary?: SalaryLine | null;
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  isAgency: boolean;
  /**
   * At most 3, fixed priority, only from real fields (PRODUCT F-FEED-05/07).
   * `label` is a stable key the UI translates (for `market_tag` the tag id,
   * e.g. 'soe'); `quote` is the posting's own words where the badge rests on
   * one. `new` and `closing_soon` are reserved and never emitted (no urgency).
   */
  badges: FeedBadge[];
  /** Null when nothing could be compared, or (GoApply) when personalisation is off. */
  fit: FitBadge | null;
  tracker: { status: string } | null;
  /**
   * GoApply 网申 close date / 届别, only as the posting states them.
   * `applyClosesAt` is the stated date (yyyy-mm-dd, China time) with its
   * quote; null when the posting states none (RAJob.expiresAt is never shown:
   * it is often an estimate).
   */
  campus?: { applyClosesAt: string | null; applyClosesQuote?: string | null; classYears: number[] } | null;
  /** 0-based position in the feed session (impressions beacon); null outside a session. */
  position?: number | null;
  /**
   * Market card lines from `marketHooks.cardMeta()`, keyed by hook set
   * (`cn` → JobMetaCn, `ats_public` → JobMetaTw). Left off when no market
   * hook has anything to add (most RoboApply cards).
   */
  cardMeta?: MarketCardMeta;
  /**
   * "Why this job" lines (PIPL Art. 24, `explainMatch`): present wherever a
   * fit is shown, and on GoApply lists ordered by date (which say so).
   */
  explanation?: FeedExplanation;
}

/**
 * The compliance area's `MatchExplanation` as a card carries it. The server
 * always sends `mode` 'personalized' or 'non_personalized'; it is typed as a
 * string here so a card object built from parsed JSON (where a literal has
 * widened to string) still is a FeedItem. Readers narrow it (the web adapter
 * `itemExtras` returns a `MatchExplanation`).
 */
export type FeedExplanation = Omit<MatchExplanation, 'mode'> & { mode: MatchExplanation['mode'] | (string & {}) };

/** `marketHooks.cardMeta()` output: one record per applicable hook set. */
export type MarketCardMeta = Record<string, Record<string, unknown>>;

export const FEED_BADGE_KINDS = [
  'direct_from_employer',
  'sponsorship',
  'no_sponsorship',
  'clearance_required',
  'citizens_only',
  'market_tag',
  'agency',
  'remote',
  'pay_listed',
  'benefits_listed',
  'new',
  'closing_soon',
] as const;
export type FeedBadgeKind = (typeof FEED_BADGE_KINDS)[number];
export interface FeedBadge {
  kind: FeedBadgeKind;
  label: string;
  quote?: string;
}

export interface FeedQueryResponse {
  items: FeedItem[];
  cursor: string | null;
  endOfFeed: boolean;
  /** Jobs hidden by the fit-tier view filter: "Hiding {n} weaker fits." */
  hiddenByTier: number;
  sessionId: string;
  /** `recency` when personalisation is off (GoApply): sorted by date posted and filters only. Always sent by WP-32. */
  order?: FeedOrder;
  /** The sort actually applied (`recommended`/`best_fit` fall back to `newest` when `order` is `recency`). Always sent by WP-32. */
  sort?: FeedSort;
  /**
   * Where the postings this query can reach come from, for the feed header
   * (GoApply: "来自 N 家企业招聘官网", or "来自 GoHire 与 N 家企业招聘官网" when
   * `gohire` is true). Counted from the rows themselves (public rows matching
   * the filters, inside the list's age window): `employerBoards` is the number
   * of distinct employer boards, `gohire` whether any GoHire bank row is
   * listed. Sent on market `cn`; left off when it could not be counted (never
   * a guess, D3) and on other markets.
   */
  sources?: FeedSources;
  /**
   * True when the whole list holds fewer results than `FEED_THIN_BELOW`: the
   * web shows the source header and, on GoApply, the search links to other
   * sites. It is about the list, not the page or the part read so far: on
   * GoApply it is known from the first page (the matching public rows are
   * counted); elsewhere it turns true once the list has reached its age floor
   * short. False while more results may still come and nothing counts them.
   * Always sent.
   */
  thin?: boolean;
}

export interface FeedSources {
  gohire: boolean;
  employerBoards: number;
}

// ── GET /feed/counts ─────────────────────────────────────────────────────

export interface FeedCountsResponse {
  forYou: number;
  saved: number;
  external: number;
  applied: number;
}

// ── Hide / unhide / report ───────────────────────────────────────────────

export const JobParamsSchema = z.object({ id: Id });

export const HIDE_REASONS = [
  'wrong_title',
  'wrong_level',
  'wrong_location',
  'pay_too_low',
  'company',
  'already_applied',
  'not_interested',
  'other',
] as const;
export const HideJobBodySchema = z.object({ reasonCode: z.enum(HIDE_REASONS), detail: z.string().max(500).optional() }).strict();
export interface FilterDiffProposal {
  searchProfileId: string;
  baseVersion: number;
  ops: Array<{ op: 'add' | 'remove' | 'set'; path: string; value: unknown }>;
  /**
   * The same change as a FilterSetPatch, ready for
   * `PATCH /search-profiles/:id { baseVersion, filtersPatch }` (one PATCH).
   */
  patch: FilterSetPatch;
  /** Job count after the change (capped at 5,000; null when it could not be counted). */
  countAfter: number | null;
}
export interface HideJobResponse {
  proposedFilterDiff: FilterDiffProposal | null;
  /** Reasons with no one-step filter change open an editor instead (ARCH §4.9). */
  editor?: 'location' | 'seniority' | null;
}

/** GoApply adds 招转培 / 培训贷 / 收费 reasons. */
export const REPORT_REASONS = ['expired', 'scam', 'wrong_info', 'duplicate', 'agency', 'offensive', 'training_loan', 'pay_to_work', 'fee_required', 'other'] as const;
export const ReportJobBodySchema = z.object({ reason: z.enum(REPORT_REASONS), note: z.string().max(1000).optional() }).strict();

// ── Telemetry and calibration ────────────────────────────────────────────

export const ImpressionsBodySchema = z
  .object({
    sessionId: Id,
    positions: z
      .array(z.object({ jobId: Id, position: z.number().int().min(0).max(10_000), ms: z.number().int().min(0).max(3_600_000) }).strict())
      .min(1)
      .max(100),
  })
  .strict();

export const RATING_REASONS = ['wrong_titles', 'wrong_level', 'wrong_location', 'missing_skills', 'jobs_old', 'unwanted_companies'] as const;
export const FeedRatingBodySchema = z
  .object({ score: z.number().int().min(0).max(10), reasons: z.array(z.enum(RATING_REASONS)).max(6).default([]), note: z.string().max(1000).optional() })
  .strict();

// ── Explore, NL query, new-count, skills-check ───────────────────────────

export const ExploreQuerySchema = z.object({ locale: z.string().max(8).optional() });
export interface ExploreCategory {
  taxonomyId: string;
  label: string;
  /** Live count (public canonical rows of the brand's market). */
  count: number;
  /** The same count with its provenance (D3): live public postings in this market. */
  sourced: { value: number; source: 'aggregate'; asOf: string; method: string };
}
export interface ExploreResponse {
  categories: ExploreCategory[];
  asOf: string;
}

export const NlQueryBodySchema = z.object({ text: z.string().trim().min(2).max(500), searchProfileId: Id.optional() }).strict();
export interface NlQueryResponse {
  diff: FilterDiffProposal;
  /** The request parts that were not turned into filters, in the user's words (nothing is claimed to be checked). */
  explanation: string;
  unmatched: string[];
}

/**
 * `since` overrides the stored last visit. `markVisited=true` stamps
 * `RAUserUiState.lastFeedVisitAt` after counting (the first page of
 * `POST /feed/query` stamps it too). A polling badge omits `markVisited`, so
 * polling never resets the count it shows. (Contract change from TASK_PLAN
 * WP-32 "new-count stamps lastFeedVisitAt": recorded in the WP-32 handoff.)
 * Results are cached per user for 2 minutes.
 */
export const NewCountQuerySchema = z.object({
  since: z.iso.datetime().optional(),
  markVisited: z.enum(['true', 'false']).optional(),
});
export interface NewCountResponse {
  /**
   * Real count of jobs first seen since the last visit: ≥ Good fit when
   * personalised; every matching job when not (GoApply with 个性化推荐 off).
   */
  count: number;
  since: string | null;
  /** The count hit its ceiling (400 personalised, 5,000 otherwise): show "{count}+". */
  capped?: boolean;
}

export interface SkillsCheckResponse {
  /** Required skills absent from profile skills, with "asked in X of Y". */
  skills: Array<{ skill: string; askedIn: number; outOf: number }>;
}

// ── Public visitor list: GET /api/v1/public/feed ─────────────────────────

export const PublicFeedQuerySchema = z.object({
  role: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
});
/** No fit, `publicDisplay` jobs only, 20 items. */
export type PublicFeedItem = Omit<FeedItem, 'fit' | 'tracker' | 'cardMeta' | 'explanation'>;
export interface PublicFeedResponse {
  items: PublicFeedItem[];
}

// ── Documented JSON columns (ra-feed.prisma) ─────────────────────────────

const FeedSessionRankEntrySchema = z.object({ jobId: z.string(), fit: z.number().nullable(), kind: z.enum(['pre', 'ai']), rank: z.number() }).strict();
/**
 * `RAFeedSession.ranks`: `[{ jobId, fit, kind: 'pre'|'ai', rank }]`. The
 * refill keyset id lives in its own column, `RAFeedSession.windowEndsId`
 * (SCHEMA-3, SR-32-4). Sessions written before that column stored the
 * envelope `{ entries, windowEndsId }` here (30-minute TTL); it is still read.
 */
export const FeedSessionRanksSchema = z.union([
  z.array(FeedSessionRankEntrySchema),
  z.object({ entries: z.array(FeedSessionRankEntrySchema), windowEndsId: z.string().nullable() }).strict(),
]);
/** `RAUserAffinity.{taxonomy,company,skill}Weights`: `{ [key]: -1..1 }` */
export const AffinityWeightsSchema = z.record(z.string(), z.number().min(-1).max(1));
/** `RAJobInteraction.detail` for kinds 'applied' | 'unapplied' | 'share' | 'copilot_open'. */
export const JobInteractionDetailSchema = z.record(z.string(), z.unknown());

/** Seam used by search (/search-profiles/count, /:id/limiting) and onboarding. */
export interface FeedCountResult {
  count: number | null;
  capped: boolean;
}
export interface LimitingFilter {
  field: string;
  value: unknown;
  removalGain: number;
}
export type { FilterSet };

export const FEED_ERROR_CODES = {
  refreshLimited: 'feed_refresh_limited', // 429 rate_limited { reason, retryAfterSec }
  ratingAlreadyToday: 'feed_rating_already_today', // 409 conflict { reason }
  sessionExpired: 'feed_session_expired', // 409 conflict { reason }: start again without a cursor
  deadlineSortCnOnly: 'deadline_sort_cn_only', // 422 invalid_request { reason }
  jobNotFound: 'job_not_found', // 404 not_found { reason }
  noRole: 'nl_query_no_role', // 422 invalid_request { reason }: the text names no role
} as const;

// ── Ranking factors (public "How ranking works" page, /help/ranking, WP-40) ──

/**
 * Every factor of the Recommended order, with its weight. There is NO boost
 * for recruiter-bank jobs (a filter only, ARCH §4.8). WP-40 lists these on
 * /help/ranking; tests pin them so the page and the code cannot drift.
 */
export const RANKING_FACTORS = [
  { key: 'fit', weight: 0.55, what: 'Fit score: the AI score when one exists, otherwise the quick estimate minus 5 points.' },
  { key: 'freshness', weight: 0.2, what: 'How recently the job was posted: 100 × e^(−hours since posting / 72).' },
  { key: 'affinity', weight: 0.15, what: 'Your own actions: saving, applying and hiding jobs, and companies you marked as preferred; fades 2% a day.' },
  { key: 'source_quality', weight: 0.1, what: 'How complete the posting is: pay listed, a known application system, a real posting date, a detailed description.' },
] as const;

/**
 * Ordering rules besides the weighted factors (also listed on /help/ranking).
 * `sponsorship_first` applies under every sort, within each retrieval window
 * (the newest 400 matching jobs, then the next older ones).
 */
export const ORDERING_RULES = [
  {
    key: 'sponsorship_first',
    points: null,
    when: 'You said you need visa sponsorship (RoboApply).',
    what: 'Jobs whose posting mentions sponsorship come first, in the order you chose; jobs whose posting says it does not sponsor are hidden.',
  },
  {
    key: 'skills_boost',
    points: 10,
    when: 'Skills is the only filter that narrows your list.',
    what: 'Jobs that require more of your chosen skills rank higher in Recommended: up to 10 points, in proportion to how many of them the job asks for.',
  },
] as const;

/** Points added to a Recommended rank for the career goal chosen in onboarding (`onboardingAnswers.goal`). */
export const GOAL_ADJUSTMENTS = {
  more_senior: { points: 6, when: 'The job is above the lowest level you selected.' },
  management: { points: 6, when: 'The job manages people (role type or title).' },
  higher_pay: { points: 6, when: 'The listed pay is above your minimum, in the same currency.' },
  flexibility: { points: 4, when: 'The job is remote or hybrid.' },
  new_industry: { points: 0, when: 'No adjustment.' },
  different_role: { points: 0, when: 'No adjustment.' },
  learn_skills: { points: 0, when: 'No adjustment.' },
  work_life_balance: { points: 0, when: 'No adjustment.' },
  job_security: { points: 0, when: 'No adjustment.' },
} as const;

/**
 * A result list shorter than this is "thin" (`FeedQueryResponse.thin`). It is
 * the feed's existing thin-result threshold: the first window is widened from
 * 14 to 45 days below the same number (`FEED_LIMITS.widenBelowRows`).
 */
export const FEED_THIN_BELOW = 60;

/** Feed limits (ARCH §3.4, §3.10, §4.8). */
export const FEED_LIMITS = {
  pageSize: 20,
  retrievalLimit: 400,
  firstWindowDays: 14,
  widenWindowDays: 45,
  widenBelowRows: FEED_THIN_BELOW,
  maxAgeDays: 120,
  sessionTtlMin: 30,
  countCap: 5000,
  companyMaxPerWindow: 2,
  companyWindow: 20,
  freshnessHalfLifeHours: 72,
  reportCloseThreshold: 3,
  skillsCheckTop: 5,
  skillsCheckList: 50,
} as const;
