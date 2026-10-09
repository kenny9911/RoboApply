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

import { z } from 'zod';
import type { FilterSet } from '../search/contract.js';

const Id = z.string().min(1).max(64);

export const FEED_SORTS = ['recommended', 'newest', 'best_fit', 'highest_pay', 'deadline'] as const;
export type FeedSort = (typeof FEED_SORTS)[number];
export const FIT_TIER_LABELS = ['great', 'good', 'possible', 'unlikely'] as const;
export type FitTier = (typeof FIT_TIER_LABELS)[number];

// ── POST /feed/query ─────────────────────────────────────────────────────

export const FeedQueryBodySchema = z
  .object({
    searchProfileId: Id.optional(),
    /** `deadline` is GoApply only. */
    sort: z.enum(FEED_SORTS).default('recommended'),
    q: z.string().trim().max(200).optional(),
    /** Partial FilterSet applied on top of the profile for this query only (validated by search.parseFilterSet). */
    overrides: z.record(z.string(), z.unknown()).optional(),
    cursor: z.string().max(512).optional(),
    /** View filter: hide weaker fits (counts returned in `hiddenByTier`). */
    fitTier: z.enum(['all', 'good', 'great']).optional(),
  })
  .strict();

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
  company: { id: string | null; name: string; logoUrl: string | null };
  location: string | null;
  workModel: 'remote' | 'hybrid' | 'onsite' | null;
  employmentType: string | null;
  seniority: string | null;
  /** Null = "Pay not listed" (never 0). */
  pay: { min: number | null; max: number | null; currency: string; period: 'year' | 'month' | 'day' | 'hour'; text: string | null } | null;
  postedAt: string | null;
  /** "Last checked {date}" from lastSeenAt. */
  lastSeenAt: string | null;
  /** Source line, e.g. aggregator + original host, or `{sourceName}`. */
  source: { name: string; kind: 'provider' | 'bank' | 'ats_public' | 'user_import' };
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  isAgency: boolean;
  /** At most 3, only from real fields. */
  badges: Array<{ kind: 'direct_from_employer' | 'sponsorship' | 'new' | 'closing_soon' | 'market_tag'; label: string; quote?: string }>;
  fit: FitBadge | null;
  tracker: { status: string } | null;
  /** GoApply 网申 window / 届别 when stated. */
  campus?: { applyClosesAt: string | null; classYears: number[] } | null;
}

export interface FeedQueryResponse {
  items: FeedItem[];
  cursor: string | null;
  endOfFeed: boolean;
  /** Jobs hidden by the fit-tier view filter: "Hiding {n} weaker fits." */
  hiddenByTier: number;
  sessionId: string;
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
  /** Job count after the change. */
  countAfter: number | null;
}
export interface HideJobResponse {
  proposedFilterDiff: FilterDiffProposal | null;
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

export interface ExploreCategory {
  taxonomyId: string;
  label: string;
  /** Live count (public canonical rows of the brand's market). */
  count: number;
}
export interface ExploreResponse {
  categories: ExploreCategory[];
  asOf: string;
}

export const NlQueryBodySchema = z.object({ text: z.string().trim().min(2).max(500), searchProfileId: Id.optional() }).strict();
export interface NlQueryResponse {
  diff: FilterDiffProposal;
  explanation: string;
}

export const NewCountQuerySchema = z.object({ since: z.iso.datetime().optional() });
export interface NewCountResponse {
  /** Real count of ≥ Good fit jobs since the last visit. */
  count: number;
  since: string | null;
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
export type PublicFeedItem = Omit<FeedItem, 'fit' | 'tracker'>;
export interface PublicFeedResponse {
  items: PublicFeedItem[];
}

// ── Documented JSON columns (ra-feed.prisma) ─────────────────────────────

/** `RAFeedSession.ranks`: `[{ jobId, fit, kind: 'pre'|'ai', rank }]` */
export const FeedSessionRanksSchema = z.array(
  z.object({ jobId: z.string(), fit: z.number().nullable(), kind: z.enum(['pre', 'ai']), rank: z.number() }).strict(),
);
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
  refreshLimited: 'feed_refresh_limited',
  ratingAlreadyToday: 'feed_rating_already_today',
} as const;
