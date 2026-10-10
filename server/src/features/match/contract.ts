// server/src/features/match/contract.ts
//
// Fit scoring, fit analysis, the keyword check and the competitiveness report
// (ARCHITECTURE.md §2.5, §3.4, §4.7; TASK_PLAN.md WP-18, WP-77; R-09). Mount:
// /api/v1/roboapply/match. `POST /jobs/:id/score` lives on the job-detail
// router and calls `matchService.scoreJob` (WP-34 mounts
// `createScoreJobHandler()` from match/index.ts there).
//
// Tiers (R-09, config MATCH_TIERS): Great ≥80 · Good 65–79 · Possible 45–64 ·
// Unlikely <45. Weights 35/30/15/10/10 (MATCH_WEIGHTS). The server sums the
// total; the model never emits it. Every score renders with "This is not
// your chance of getting hired."

import { z } from 'zod';

export const DEFAULT_MATCH_TIERS = { great: 80, good: 65, possible: 45 } as const;
export const DEFAULT_MATCH_WEIGHTS = { title_level: 35, skills: 30, industry: 15, logistics: 10, career_path: 10 } as const;
export type MatchDimensionKey = keyof typeof DEFAULT_MATCH_WEIGHTS;
export type FitTierKey = 'great' | 'good' | 'possible' | 'unlikely';
export type MatchTiers = { great: number; good: number; possible: number };
export type MatchWeights = Record<MatchDimensionKey, number>;

/** The five components, in the order the UI lists them ("What we compared"). */
export const MATCH_DIMENSION_KEYS: readonly MatchDimensionKey[] = ['title_level', 'skills', 'industry', 'logistics', 'career_path'];

/** Tier for a score with the default thresholds (MatchService reads MATCH_TIERS config). */
export function tierForScore(score: number, tiers: MatchTiers = DEFAULT_MATCH_TIERS): FitTierKey {
  if (score >= tiers.great) return 'great';
  if (score >= tiers.good) return 'good';
  if (score >= tiers.possible) return 'possible';
  return 'unlikely';
}

const Id = z.string().min(1).max(64);
export const MatchJobParamsSchema = z.object({ id: Id });

// ── Documented JSON columns (ra-match.prisma) ────────────────────────────

/**
 * `RAJobMatchScore.dimensions`. Evidence `ref` names what a deterministic
 * evidence line is (`title`, `seniority`, `skill_have`, `skill_missing`,
 * `education_required`, `class_year`, `industry`, `location`, `pay`, `visa`);
 * AI evidence has no `ref` and is always a verbatim substring of the resume
 * or the posting (CitationGuard).
 */
export const MatchDimensionsSchema = z.array(
  z
    .object({
      key: z.enum(['title_level', 'skills', 'industry', 'logistics', 'career_path']),
      weight: z.number(),
      score: z.number().nullable(),
      status: z.enum(['scored', 'not_stated']),
      evidence: z.array(z.object({ text: z.string(), source: z.enum(['resume', 'posting']), ref: z.string().optional() }).strict()),
    })
    .strict(),
);

export type MatchDimension = z.infer<typeof MatchDimensionsSchema>[number];
export type MatchEvidence = MatchDimension['evidence'][number];

/**
 * `RAJobMatchScore.explanation`. Legacy v2 rows carry `signals` (synthesized;
 * no longer written). Scorer v3 rows carry `{ strengths, gaps, rationale,
 * keywordsMatched, keywordsMissing, responseLanguage, promptVersion }`.
 */
export const MatchExplanationSchema = z
  .object({
    strengths: z.array(z.string()),
    gaps: z.array(z.string()),
    rationale: z.string(),
    signals: z.object({ skills: z.unknown(), experience: z.unknown(), location: z.unknown(), salary: z.unknown() }).partial(),
  })
  .passthrough();

/** `RAKeywordExtraction.keywords`: top 30 `{ keyword, importance, frequency }` */
export const KeywordExtractionSchema = z.array(
  z.object({ keyword: z.string(), importance: z.enum(['high', 'medium', 'low']), frequency: z.number() }).strict(),
);

/** `RAFitReport.report` — a `CompetitivenessReportBody` (kind 'competitiveness'); read back by `parseStoredReport`. */
export const FitReportBodySchema = z.record(z.string(), z.unknown());

// ── Shared fit views (scorer v3) ──────────────────────────────────────────

/** The prompt/schema version every v3 row carries (`RAJobMatchScore.promptVersion`). */
export const SCORER_PROMPT_VERSION = 'scorer_v3' as const;

/** Why a score is a deterministic "Quick estimate" instead of the AI score. */
export type EstimateReason =
  | 'ai_off' // GoApply without the "Use AI" consent (aiAllowed=false)
  | 'no_resume' // nothing to compare the posting with
  | 'daily_cap' // 80 AI scores a day per user (platform-paid)
  | 'budget' // the brand's daily AI scoring budget is spent
  | 'ai_unavailable' // no model configured for this brand
  | 'ai_failed'; // the model call failed; nothing was charged

/**
 * The fit for one (user, job): what `POST /jobs/:id/score` answers (a
 * superset of jobs/detail `FitView`). Rendered "87 / 100" with "This is not
 * your chance of getting hired."; `kind: 'pre'` renders "Quick estimate".
 */
export interface MatchFitView {
  jobId: string;
  /** 0–100, or null when nothing could be compared (renders "—", never 0). */
  score: number | null;
  tier: FitTierKey | null;
  kind: 'pre' | 'ai';
  dimensions: MatchDimension[];
  /** AI summary, second person, no number; null for a quick estimate. */
  summary: string | null;
  /** AI-written; empty for a quick estimate. */
  strengths: string[];
  /** AI-written observations about the resume; empty for a quick estimate. */
  gaps: string[];
  /**
   * Terms the model picked from the post, kept only when verified on the
   * server: each appears in the posting, and the resume/profile does
   * (`keywordsMatched`) or does not (`keywordsMissing`) mention it. Empty for
   * a quick estimate.
   */
  keywordsMatched: string[];
  keywordsMissing: string[];
  /**
   * Deterministic, complete: the posting's skills your resume or profile
   * shows and the ones it does not (same rule as the keyword check).
   * `listed` is how many skills the posting lists (0: nothing to compare).
   */
  skills: { aligned: string[]; missing: string[]; listed: number };
  /** One overlap and one gap for cards (real data only; null when none). */
  topOverlap: string | null;
  topGap: string | null;
  scoredAt: string;
  resumeVariantId: string | null;
  estimateReason: EstimateReason | null;
  /** The AI prose is in another UI language than this request (the number stands). */
  summaryLocaleStale: boolean;
  /** True when served from the cache without a model call. */
  cached: boolean;
}

/** A deterministic pre-score (feed, extension). No LLM, ~0.1 ms per job. */
export interface PreScoreResult {
  jobId: string;
  score: number | null;
  tier: FitTierKey | null;
  kind: 'pre';
  dimensions: MatchDimension[];
  topOverlap: string | null;
  topGap: string | null;
}

// ── POST /jobs/:id/score (job-detail mount; platform-paid, 80/day/user) ──

export const ScoreJobBodySchema = z
  .object({
    resumeVariantId: Id.optional(),
    force: z.boolean().optional(),
    /** Pay one model call only to rewrite the prose in this request's language. */
    regenerateExplanation: z.boolean().optional(),
  })
  .strict();

// ── POST /match/jobs/:id/fit-analysis (credit `fit_analysis`, Idempotency-Key) ──

export const FitAnalysisBodySchema = z.object({ resumeVariantId: Id.optional() }).strict();
export interface FitAnalysisCard {
  jobId: string;
  /** 0–100, or null when nothing could be compared (renders "—", never 0). */
  score: number | null;
  tier: FitTierKey | null;
  /** `pre` renders "Quick estimate". */
  kind: 'pre' | 'ai';
  dimensions: MatchDimension[];
  /** Deterministic: the posting's skills your resume/profile shows, the ones it does not, and how many it lists. */
  skills: { aligned: string[]; missing: string[]; listed: number };
  /** `required` is the posting's stated degree level; null when not stated. */
  education: { required: string | null; yours: string | null; meets: boolean | null };
  /** AI-written strengths (empty for a quick estimate). */
  highlights: string[];
  /** AI-written gaps, phrased as observations about the resume. */
  gaps: string[];
  /** Second person, no number; AI-written (null for a quick estimate). */
  summary: string | null;
  /** True when the card carries AI text (render AiGeneratedBadge on GoApply). */
  aiWritten: boolean;
  /** Why this is a quick estimate, when it is one. */
  estimateReason: EstimateReason | null;
  /** True when this request spent a `fit_analysis` credit. */
  charged: boolean;
}

// ── GET /match/jobs/:id/keyword-check (free, deterministic; F-RES-08) ─────

export const KeywordCheckQuerySchema = z.object({ resumeVariantId: Id.optional() }).strict();

export type KeywordRowKey = 'title' | 'years' | 'education' | 'skills' | 'keywords';
/**
 * `not_stated`: the posting does not say. `unknown`: your resume/profile does
 * not show it, so we cannot tell (never counted as a miss).
 */
export type KeywordRowStatus = 'met' | 'partly' | 'not_met' | 'not_stated' | 'unknown';
export interface KeywordRow {
  key: KeywordRowKey;
  status: KeywordRowStatus;
  /** What the posting asks for (a title, years, degree level), when stated. */
  need: string | number | null;
  /** What your resume/profile shows, when known. */
  have: string | number | null;
  /** For skills/keywords: how many of `total` your resume mentions. */
  found: number | null;
  total: number | null;
  /** For skills/keywords: each term and whether your resume mentions it. */
  items: Array<{ term: string; found: boolean; required?: boolean }>;
}
export interface KeywordCheckResponse {
  jobId: string;
  resumeVariantId: string | null;
  rows: KeywordRow[];
  asOf: string;
}

// ── Competitiveness report: "You and what employers ask" (flag `competitiveness`; credit `competitiveness`; WP-77) ──
//
// Computed from our own job index for one saved search (PRODUCT F-MATCH-04):
// the share of the search's posts whose stated degree / years / required
// skills the user meets, the most requested skills ("asked for in X of Y
// posts"), and "Broaden your search" options with real extra-job counts.
// Deterministic: no model call. There is no applicant data, so nothing here
// compares the user with other applicants (no "you outperform X%").
//
// D3: every comparative number is a `ReportSourced` with `sampleSize`;
// aggregates below MIN_SAMPLE (20) are null ("Not enough data yet"), and a
// sample under 20 posts suppresses the whole comparison (`suppressed`).

export const CompetitivenessBodySchema = z.object({ searchProfileId: Id }).strict();
export const CompetitivenessLatestQuerySchema = z.object({ searchProfileId: Id.optional() }).strict();

/** How a report number was produced (rendered as the method sentence). */
export type CompetitivenessMethod =
  /** Counted over the newest posts of the saved search (`sample.size` of them). */
  | 'newest_posts_sample'
  /** A live count of the search's posts in our index (capped at 5,000). */
  | 'search_count'
  /** A live count: how many more posts the search shows with one filter removed. */
  | 'filter_removal_count';

/** Provenance of one report number; structurally a platform `Sourced<T>` (source = our job index). */
export interface ReportSourced<T = number> {
  value: T;
  source: 'index';
  /** Posts behind an aggregate (required on every share and "X of Y" number). */
  sampleSize?: number;
  /** ISO time the posts were read. */
  asOf: string;
  method: CompetitivenessMethod;
}

/** A share (0–1) of `sampleSize` posts; `met` is the numerator ("met of sampleSize"). */
export interface ReportShare extends ReportSourced<number> {
  sampleSize: number;
  met: number;
}

export type RequirementKey = 'degree' | 'years' | 'skills';

/**
 * One requirement over the sample. A post "states" a degree when it names a
 * level above none, years when it names a minimum above 0, and skills when
 * it marks at least one skill as required. Posts that do not state it never
 * count as a miss.
 */
export interface CompetitivenessRequirement {
  key: RequirementKey;
  /** Posts in the sample that state this requirement (sample composition). */
  stated: number;
  /** Of the posts that state it, the share whose requirement you meet; null below 20 or when your side is unknown. */
  share: ReportShare | null;
  /** False when your profile/resume does not show it (degree, dated experience, any skill). */
  youKnown: boolean;
  /** Yours: degree key ('bachelor'…), years (one decimal), or how many skills your profile/resume lists. */
  yours: string | number | null;
  /**
   * What the stating posts typically ask: degree → the most common level
   * (value = level key, `count` posts); years → the median minimum years.
   * Null below 20 stating posts; never for skills.
   */
  typical: (ReportSourced<string | number> & { count?: number }) | null;
}

export interface CompetitivenessSkill {
  skill: string;
  /** "Asked for in X of Y posts": value = X, sampleSize = Y. */
  askedIn: ReportSourced<number> & { sampleSize: number };
  /** Your profile skills or resume text show it (the keyword-check rule). */
  youHave: boolean;
}

export interface BroadenOption {
  /** The FilterSet field this option removes. */
  field: string;
  /** Its current value (for the label). */
  value: unknown;
  /** `filtersPatch` for `PATCH /search-profiles/:id` (removes the field). */
  patch: Record<string, null>;
  /** Real count of extra posts the search shows without it. */
  extraJobs: ReportSourced<number>;
  /**
   * The real figure may be higher than `extraJobs` ("+N or more"): the search
   * or the relaxed search reached the 5,000 count ceiling, or the search's own
   * count is unknown, so the difference of two capped counts is a lower bound.
   */
  capped: boolean;
}

/** The persisted body (`RAFitReport.report`, kind 'competitiveness'). */
export interface CompetitivenessReportBody {
  schemaVersion: 1;
  searchProfileId: string;
  searchProfileName: string;
  searchProfileVersion: number;
  asOf: string;
  sample: { size: number; maxSize: number; method: 'newest_posts_sample' };
  /** All posts in the search right now; null when it could not be counted. */
  total: ReportSourced<number> | null;
  totalCapped: boolean;
  /** `too_few_posts`: under 20 posts in the sample; only Broaden options are shown. */
  suppressed: 'too_few_posts' | null;
  /** Share of the posts that state at least one requirement (and could be checked) whose stated requirements you all meet. */
  meetsRequirements: ReportShare | null;
  /** Sample composition: posts we could check, posts stating nothing, posts we could not check (your side unknown). */
  overall: { checked: number; notStated: number; unknown: number };
  requirements: CompetitivenessRequirement[];
  /** Most requested skills, most asked first (stored up to the full length). */
  topSkills: CompetitivenessSkill[];
  broaden: BroadenOption[];
}

/** `POST /match/competitiveness` and `GET /match/competitiveness/latest`. */
export interface CompetitivenessReport extends CompetitivenessReportBody {
  id: string;
  createdAt: string;
  /** The saved search changed (or was deleted) since this report: run it again for current numbers. */
  stale: boolean;
  /** `competitivenessFull` (Pro): every skill and Broaden option; otherwise the first few. */
  full: boolean;
  /** Skills / options not shown on this plan. */
  hiddenSkills: number;
  hiddenBroaden: number;
  /** A sellable plan shows the full report. */
  upgradable: boolean;
  /** True when this request spent a `competitiveness` credit. */
  charged: boolean;
  /** True only when `create` returned an identical report from earlier the same day (no credit). Always false from `latest`. */
  reused: boolean;
}

/** Limits: sample size, and how many skills / options each plan shows. */
export const COMPETITIVENESS_LIMITS = {
  /** Newest posts of the search the report reads (the feed sample seam allows up to 400). */
  sampleMax: 50,
  /** A skill must be asked for in at least this many posts to be listed. */
  skillMinPosts: 2,
  fullSkills: 15,
  freeSkills: 5,
  fullBroaden: 8,
  freeBroaden: 3,
  /** An identical report (same search version and your same inputs) from the last day is reused free. */
  reuseHours: 24,
} as const;

export const MATCH_ERROR_CODES = {
  scoreCapReached: 'score_daily_cap',
  noResume: 'resume_required',
  jobNotFound: 'job_not_found',
  variantNotFound: 'resume_variant_not_found',
  idempotencyKeyRequired: 'idempotency_key_required',
  searchProfileNotFound: 'search_profile_not_found',
} as const;
