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

/**
 * What a component the quick estimate cannot compare contributes, at its full
 * weight (MARKET_STRATEGY 2.4): the long-run mean of that component over AI
 * scores. The four figures come from 202 stored scorer-v3 rows; logistics has
 * no measured figure yet and starts neutral. Config MATCH_PRIORS /
 * CN_MATCH_PRIORS; re-estimated per market from real pairs (calibration.ts).
 */
export const DEFAULT_MATCH_PRIORS = { title_level: 44, skills: 39, industry: 24, logistics: 50, career_path: 45 } as const;
export type MatchPriors = Record<MatchDimensionKey, number>;

/** How much of the rubric a fit rests on (estimate v2; MARKET_STRATEGY 2.4). */
export type FitConfidence = 'high' | 'medium' | 'low';
/** The first reason that applies when the confidence is low; null otherwise. */
export const CONFIDENCE_REASONS = ['no_skills_listed', 'no_level_stated', 'no_role_evidence', 'no_resume', 'few_details'] as const;
export type ConfidenceReason = (typeof CONFIDENCE_REASONS)[number];
/** Coverage at or above `high` is high confidence, from `medium` up to it medium, below it low. */
export const CONFIDENCE_THRESHOLDS = { high: 0.75, medium: 0.5 } as const;
/** A posting that states less than this share of the rubric is never Great and has low confidence (invariant I4). */
export const POSTING_COVERAGE_MIN = 0.6;
/** A stored tier changes on a recomputed total only this many points past the edge it crosses (invariant I5). */
export const TIER_HYSTERESIS_POINTS = 3;

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
 * `education_required`, `class_year`, `industry`, `location_met`,
 * `location_not_met`, `pay_met`, `pay_not_met`, `visa_offered`,
 * `visa_not_offered`, and `logistics_by_your_filters`: every stated location
 * and pay check is met only because the person's own saved search filters on
 * it, so the estimate does not compare the part: it is `not_stated` and counts
 * at its prior, and this line quotes the place and pay words); AI evidence has no
 * `ref` and is always a verbatim substring of the resume or the posting
 * (CitationGuard).
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

/**
 * The fit rubrics and the scorer prompts that write them
 * (`RAJobMatchScore.rubricVersion` / `.promptVersion`). A stored row is read
 * as a fit only when its prompt is one of these: the legacy v2 scorer writes
 * rows without components into the same table, and those are never a fit.
 */
export const FIT_RUBRIC_BY_PROMPT = { scorer_v3: 'fit_v3', scorer_v4: 'fit_v4' } as const;
export type FitPromptVersion = keyof typeof FIT_RUBRIC_BY_PROMPT;
export type FitRubric = (typeof FIT_RUBRIC_BY_PROMPT)[FitPromptVersion];
/** The estimate's version (`Fit.version.estimator`). */
export const ESTIMATOR_VERSION = 'est_v2' as const;

/** The rubric a scorer prompt writes, or null when the prompt is not a fit scorer's. */
export function rubricOfPrompt(promptVersion: string | null | undefined): FitRubric | null {
  return promptVersion && Object.hasOwn(FIT_RUBRIC_BY_PROMPT, promptVersion) ? FIT_RUBRIC_BY_PROMPT[promptVersion as FitPromptVersion] : null;
}

// ── Requirement checklist (scorer v4; MARKET_TASK_PLAN 3.3) ───────────────

/**
 * One requirement a posting states, extracted once per posting
 * (`RAJob.requirements = { v: 1, contentHash, model, extractedAt, items }`).
 * `text` is the posting's own words.
 */
export const JobRequirementSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(['skill', 'experience', 'education', 'domain', 'scope']),
    text: z.string().min(1).max(600),
    importance: z.enum(['must', 'preferred']),
  })
  .strict();
export type JobRequirement = z.infer<typeof JobRequirementSchema>;

/** A requirement checked against the resume: the status and the resume's own words behind it ('' when none). */
export const RequirementCheckSchema = JobRequirementSchema.extend({
  status: z.enum(['met', 'partly', 'not_shown', 'not_applicable']),
  evidence: z.string().max(600),
}).strict();
export type RequirementCheck = z.infer<typeof RequirementCheckSchema>;

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
   * (`keywordsMatched`) or does not (`keywordsMissing`) show it. Listed once
   * each, in the usual spelling, and never a term `skills` already lists.
   * Empty for a quick estimate.
   */
  keywordsMatched: string[];
  keywordsMissing: string[];
  /**
   * Deterministic, complete: the posting's skills your resume or profile
   * shows and the ones it does not (same rule as the keyword check).
   * `listed` is how many skills the posting lists (0: nothing to compare).
   */
  skills: {
    aligned: string[];
    missing: string[];
    listed: number;
    /** Soft skills the posting names ("communication"): shown, never compared and never part of the number. */
    softSkills?: string[];
  };
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
  /**
   * Share of the rubric weight backed by stated evidence on both sides, 0–1,
   * and what follows from it. Sent with every fit since estimate v2; a reader
   * treats a missing value as unknown (no reason line).
   */
  coverage?: number;
  confidence?: FitConfidence;
  /** One reason when `confidence` is low; null otherwise. */
  confidenceReason?: ConfidenceReason | null;
  /** The requirement checklist (scorer v4). Empty until that scorer writes it. */
  requirements?: RequirementCheck[];
  /** The stored AI score was written by an earlier model or prompt and is waiting for its planned re-score. */
  stale?: boolean;
  /** The estimate was mapped onto the AI scale by the market's calibration map. */
  calibrated?: boolean;
  /**
   * Set when a rewrite of the written parts was asked for and could not run:
   * the reason (`daily_cap`, `budget`, …). The stored fit is answered as it
   * was. Optional and additive; the service that sets it is MatchService
   * (owned by a later phase), so a reader treats a missing value as "not known".
   */
  rewriteBlocked?: EstimateReason | null;
}

// ── A stored copy of a fit (strategy 2.2, invariant I6) ──────────────────

/**
 * What is stored when a fit leaves the live read: an alert mail or
 * notification card, a lifecycle mail, a tailoring session's "before" and
 * "after". A number alone goes stale without saying so; a snapshot says which
 * kind of fit it was, which rubric, estimator and model produced it, and when.
 *
 * Rule for every in-app list and page: the number on screen comes from
 * `getFit` / `getFits` at render time. A snapshot is shown only in a message
 * that left the app (mail, push, WeChat notice) and in history views, with
 * its date.
 */
export const FitSnapshotSchema = z
  .object({
    score: z.number().min(0).max(100).nullable(),
    tier: z.enum(['great', 'good', 'possible', 'unlikely']).nullable(),
    /** `ai`: a stored scorer result. `estimate`: the quick estimate. */
    kind: z.enum(['ai', 'estimate']),
    rubric: z.enum(['fit_v3', 'fit_v4']),
    estimator: z.string().min(1).max(40),
    /** The model that wrote an AI fit; null for an estimate. */
    model: z.string().max(200).nullable(),
    /** ISO time the fit was scored (an AI fit) or computed (an estimate). */
    scoredAt: z.string().min(1).max(40),
  })
  .strict();
export type FitSnapshot = z.infer<typeof FitSnapshotSchema>;

/**
 * The wire value of a fit kind: an estimate stays `pre`, so the published
 * extension and the web keep working. (Here, in the contract, so another area
 * can map a kind without loading the match service.)
 */
export function toWireKind(kind: 'ai' | 'estimate'): 'pre' | 'ai' {
  return kind === 'ai' ? 'ai' : 'pre';
}

/** A stored snapshot read back; null when the value is not one (a row written before snapshots existed). */
export function readFitSnapshot(value: unknown): FitSnapshot | null {
  const parsed = FitSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * One job's fit for a list. `preScore()` always answers the deterministic
 * quick estimate (`kind: 'pre'`; no LLM, ~0.1 ms per job).
 * `matchService.preScoreMany` answers the score every surface shows: the
 * stored AI score when the user has one for the job (`kind: 'ai'`, never a new
 * model call), else the quick estimate — so the feed, Similar jobs, alerts and
 * the Assistant never show two numbers for one job.
 */
export interface PreScoreResult {
  jobId: string;
  score: number | null;
  tier: FitTierKey | null;
  kind: 'pre' | 'ai';
  dimensions: MatchDimension[];
  topOverlap: string | null;
  topGap: string | null;
  /** Share of the rubric weight backed by stated evidence on both sides, 0–1 (estimate v2). */
  coverage?: number;
  confidence?: FitConfidence;
  /** One reason when `confidence` is low; null otherwise. */
  confidenceReason?: ConfidenceReason | null;
}

/**
 * The quick estimate as `preScore()` answers it: a `PreScoreResult` whose
 * coverage and confidence are always present, with what the ranking and the
 * calibration need next to it.
 */
export interface EstimateResult extends PreScoreResult {
  kind: 'pre';
  coverage: number;
  confidence: FitConfidence;
  confidenceReason: ConfidenceReason | null;
  /** Share of the rubric weight the POSTING states, 0–1 (role and level, skills, industry, location or pay). */
  postingCoverage: number;
  /** Soft skills the posting names: shown, never part of the number. */
  softSkills: string[];
  /** The most this estimate may claim (the honesty limits of preScore.ts); null when it has no score at all. */
  limit: number | null;
}

// ── POST /jobs/:id/score (job-detail mount; platform-paid, 80/day/user) ──

// The canonical fit is always for the PRIMARY resume (strategy 2.2), so this
// body takes no resume version: a request that still sends `resumeVariantId`
// is refused as an unknown field (422 invalid_request). A fit for another
// version is a separately named measure ("With this version") that only
// tailoring shows (`getVariantFit`).
export const ScoreJobBodySchema = z
  .object({
    force: z.boolean().optional(),
    /** Pay one model call only to rewrite the prose in this request's language. */
    regenerateExplanation: z.boolean().optional(),
  })
  .strict();

// ── POST /match/jobs/:id/fit-analysis (credit `fit_analysis`, Idempotency-Key) ──

/** No resume version either: the fit-analysis card answers the canonical fit (see `ScoreJobBodySchema`). */
export const FitAnalysisBodySchema = z.object({}).strict();
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

// The keyword check keeps its version parameter: tailoring reads the keyword
// report per resume version, and the response names the version it read.
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
  /**
   * For skills/keywords: each term and whether your resume shows it. `via` is
   * set when the resume does not name the term itself but names something
   * that shows it ("relational databases" via "PostgreSQL"), so the reader
   * sees what counted.
   */
  items: Array<{ term: string; found: boolean; required?: boolean; via?: string }>;
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
