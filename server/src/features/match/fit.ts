// server/src/features/match/fit.ts — the fit contract (MARKET_STRATEGY 2.2;
// MARKET_TASK_PLAN 3.3; SM-5). The only place a fit is assembled.
//
// For a person and a job there is exactly one fit, computed against the
// person's PRIMARY resume and current profile. Every surface reads it here:
//
//   getFit(userId, jobId, opts?)         one job. A model runs only when
//                                        `allowModelCall` is true and every
//                                        gate passes (AI consent, a model the
//                                        brand may use, the daily caps).
//   getFits(userId, jobIds)              a list, at most 500 ids. Never a
//                                        model call: the stored AI score when
//                                        it can be shown, else the estimate.
//   getVariantFit(userId, jobId, id)     another resume version ("With this
//                                        version"), for tailoring only.
//
// What a fit is made of (`assembleFit`, pure):
//   - The v2 estimate (preScore.ts), always computed. It is the fit when no
//     stored AI score can be shown, mapped onto the AI scale once the market
//     has a calibration map (calibration.ts).
//   - A stored AI score is the fit (I2) when it was written for this resume
//     content by a fit scorer (`scorer_v4`, the requirement checklist, or
//     `scorer_v3`, its rollback). The legacy v2 scorer writes rows without
//     components into the same table; those are never a fit. A single-job
//     read of a v4 row also carries its checklist (`requirements`); a list
//     carries none, like the prose.
//   - A row written by an earlier model or prompt than the pinned one, or for
//     an earlier version of the posting (its job content hash differs from the
//     posting's hash now), keeps serving, with `stale: true`, until the
//     precompute cron or an explicit on-demand call replaces it (I7). No
//     surface falls back to an estimate because the model id changed or
//     because enrichment added a skill to the posting.
//   - The total of a stored row is recomputed on every read from its
//     components, today's weights and today's logistics, with no model call.
//     Its tier moves only when the new total is 3 points past the edge it
//     crosses (I5). A new scorer v4 result within 3 points of an edge is
//     stored with the tier on the estimate's side of that edge
//     (scorerV4.ts `borderlineTier`); this read keeps it there.
//   - An AI score that could judge less than 60% of the rubric weight (its
//     other components are "not stated"), or that judged no skill line for a
//     posting that states no level, is never Great and its confidence is low,
//     whatever its total (I4, `aiFitThin`): the same rule the estimate applies
//     to a thin posting. The total itself is shown as computed.
//   - AI is off for this person (GoApply without the "Use AI" consent): the
//     estimate, with `estimateReason: 'ai_off'`, on every surface (I8).
//
// The three functions run on the MatchService (it owns the reads, the caps and
// the one model call) and are its `fits`; the module-level exports below bind
// the production service lazily, so importing this file opens nothing. They
// are the only way a fit is read: the service has no other fit reader.

import { applyMap, type CalibrationMap } from './calibration.js';
import { tierFor, type ScorerPin } from './config.js';
import {
  ESTIMATOR_VERSION,
  MatchDimensionsSchema,
  POSTING_COVERAGE_MIN,
  TIER_HYSTERESIS_POINTS,
  rubricOfPrompt,
  tierForScore,
  toWireKind,
  type ConfidenceReason,
  type EstimateReason,
  type EstimateResult,
  type FitConfidence,
  type FitRubric,
  type FitSnapshot,
  type FitTierKey,
  type MatchDimension,
  type MatchFitView,
  type MatchPriors,
  type MatchTiers,
  type MatchWeights,
  type PreScoreResult,
  type RequirementCheck,
} from './contract.js';
import { toMatchJob, type MatchJobRecord } from './context.js';
import { currentJobHash } from './jobHash.js';
import type { MatchService, ScoreMode } from './MatchService.js';
import { combineDimensions, confidenceFor, confidenceReasonFor, hardSkillList, logisticsDimension, postingStates, preScore, splitSkills, type MatchJob, type MatchUser } from './preScore.js';
import { jobHashCurrent, type ResumeRecord, type StoredFitRow } from './repo.js';

// ── The type ──────────────────────────────────────────────────────────────

/** The AI-written parts of a stored score, as they are shown (single-job reads only; a list carries none). */
export interface FitProse {
  /** Second person, no number. */
  summary: string | null;
  strengths: string[];
  gaps: string[];
  /** Model-picked terms the server verified; never a term the skill lists already carry. */
  keywordsMatched: string[];
  keywordsMissing: string[];
  /** The language the prose was written in. */
  locale: string;
}

export interface Fit {
  jobId: string;
  /** 0–100, or null when nothing can be compared ("—", never 0). */
  score: number | null;
  tier: FitTierKey | null;
  /** `ai`: a stored scorer result. `estimate`: the deterministic quick estimate (wire value `pre`). */
  kind: 'ai' | 'estimate';
  /** Share of the rubric weight backed by stated evidence on both sides, 0–1. */
  coverage: number;
  confidence: FitConfidence;
  /** One reason when the confidence is low; null otherwise. */
  confidenceReason: ConfidenceReason | null;
  dimensions: MatchDimension[];
  /**
   * The requirement checklist of a scorer v4 fit: each requirement line of the
   * posting with its verified status and the resume quote behind it. On
   * single-job reads only. [] for an estimate, for a row scorer v3 wrote and
   * on every list row (a list reads no prose and no checklist).
   */
  requirements: RequirementCheck[];
  topOverlap: string | null;
  topGap: string | null;
  basis: {
    /** The primary resume for `getFit` / `getFits`; the named version for `getVariantFit`; null with no resume. */
    resumeVariantId: string | null;
    resumeContentHash: string | null;
    /**
     * The posting's content hash now (jobHash.ts). Always set by `getFit` and
     * `getVariantFit`, which hold the full row. On a `getFits` row it is the
     * stored `RAJob.contentHash`, and null while the posting has none: a list
     * never reads a description to compute it.
     */
    jobContentHash: string | null;
    /** The saved search the logistics answers were read from. Logistics only: no chip of it moves a fit. */
    searchProfileVersion: number | null;
  };
  version: {
    rubric: FitRubric;
    estimator: typeof ESTIMATOR_VERSION;
    /** The model and prompt that wrote an AI fit (its own, which may be older than the pin); null for an estimate. */
    model: string | null;
    prompt: string | null;
  };
  /** When the AI score was written; for an estimate, when it was computed. ISO. */
  scoredAt: string;
  /**
   * An AI fit written by an earlier model or prompt than the pinned one, or
   * for an earlier version of the posting, waiting for its planned re-score.
   * It keeps serving meanwhile. On a `getFits` row the posting part is known
   * only when `basis.jobContentHash` is (see there); the model and prompt
   * part always is.
   */
  stale: boolean;
  /** The estimate was mapped onto the AI scale by the market's calibration map. */
  calibrated: boolean;
  /** The v2 estimate for the same person and job on its own scale (before any map): what ranking blends an AI score with. */
  estimateScore: number | null;
  /** Why this is an estimate, when a reason is known. */
  estimateReason: EstimateReason | null;
  /** The posting's hard skills the person shows and the ones they do not, and the soft skills it names (never counted). */
  skills: { aligned: string[]; missing: string[]; softSkills: string[]; listed: number };
  /** The AI prose of the stored score; only on single-job reads. */
  prose: FitProse | null;
  /** Served without a model call in this request. */
  cached: boolean;
  /**
   * Set when this request asked for the written parts in another language and
   * they could not be written: the reason (`daily_cap`, `budget`,
   * `ai_unavailable`, `ai_failed`). The stored fit is answered as it was.
   * Whether the stored row is current (a rewrite of its words) or stale (its
   * planned re-score would have written them) makes no difference: the person
   * asked, and is told why nothing changed.
   */
  rewriteBlocked?: EstimateReason | null;
}

// The wire value of a fit kind (`toWireKind`: an estimate stays `pre`) is a contract rule; re-exported for callers of this module.
export { toWireKind };

// ── Tier hysteresis (I5) ──────────────────────────────────────────────────

const TIER_ORDER: readonly FitTierKey[] = ['unlikely', 'possible', 'good', 'great'];

/**
 * The tier a stored row shows for a recomputed total: the stored tier unless
 * the total is at least `TIER_HYSTERESIS_POINTS` past the edge it crosses
 * (1 point over an edge keeps the stored tier, 3 points over changes it). An
 * unknown stored tier takes the total's own tier.
 */
export function hysteresisTier(storedTier: string | null | undefined, total: number, tiers: MatchTiers): FitTierKey {
  let at = TIER_ORDER.indexOf(storedTier as FitTierKey);
  if (at < 0) return tierForScore(total, tiers);
  // edges[i] is the lower edge of TIER_ORDER[i + 1].
  const edges = [tiers.possible, tiers.good, tiers.great];
  while (at < TIER_ORDER.length - 1 && total >= edges[at]! + TIER_HYSTERESIS_POINTS) at += 1;
  while (at > 0 && total <= edges[at - 1]! - TIER_HYSTERESIS_POINTS) at -= 1;
  return TIER_ORDER[at]!;
}

// ── Reading a stored row ──────────────────────────────────────────────────

export interface StoredFitStatus {
  /** The row may be shown as the fit for this resume and this posting. */
  usable: boolean;
  /** Usable, but written by another model or prompt than the pinned one, or for an earlier version of the posting (I7). */
  stale: boolean;
  dimensions: MatchDimension[] | null;
}

const NOT_USABLE: StoredFitStatus = { usable: false, stale: false, dimensions: null };

/**
 * May this stored row be shown as the fit? Same resume content, a fit
 * scorer's prompt, and components that parse with at least one scored. The
 * model, the prompt version and the posting's content hash are NOT part of the
 * test: a row of an older model or prompt, or one written for an earlier
 * version of the posting, is `stale`, never absent. (A posting's hash also
 * moves when enrichment adds a skill to it; the score written before that
 * keeps serving until its planned re-score.) A row older than the hash column,
 * and a posting whose hash is not known here (`jobContentHash: null`), count
 * as current.
 */
export function storedFitStatus(
  row: Pick<StoredFitRow, 'dimensions' | 'promptVersion' | 'modelUsed' | 'jobContentHash' | 'resumeContentHashAtScore'> | null | undefined,
  ctx: { resumeContentHash: string; jobContentHash: string | null; pin: ScorerPin },
): StoredFitStatus {
  if (!row) return NOT_USABLE;
  if (row.resumeContentHashAtScore !== ctx.resumeContentHash) return NOT_USABLE;
  if (!rubricOfPrompt(row.promptVersion)) return NOT_USABLE;
  const parsed = MatchDimensionsSchema.safeParse(row.dimensions);
  if (!parsed.success || !parsed.data.some((d) => d.status === 'scored' && d.score !== null)) return NOT_USABLE;
  const stale =
    row.promptVersion !== ctx.pin.prompt ||
    (ctx.pin.model !== null && row.modelUsed !== ctx.pin.model) ||
    !jobHashCurrent(row.jobContentHash, ctx.jobContentHash);
  return { usable: true, stale, dimensions: parsed.data };
}

/** Stored AI components with today's weights and today's deterministic logistics (no model call). */
export function refreshDimensions(stored: MatchDimension[], user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension[] {
  const logistics = logisticsDimension(user, job, weights);
  return stored.map((d) => (d.key === 'logistics' ? logistics : { ...d, weight: weights[d.key] }));
}

/** Coverage of an AI fit: the weight of the components the scorer scored (logistics as computed now) over all weights. */
export function aiCoverage(dimensions: MatchDimension[]): number {
  const total = dimensions.reduce((sum, d) => sum + Math.max(0, d.weight), 0);
  if (total <= 0) return 0;
  const scored = dimensions.filter((d) => d.status === 'scored' && d.score !== null && d.weight > 0).reduce((sum, d) => sum + d.weight, 0);
  return Math.round((scored / total) * 1000) / 1000;
}

/** An AI fit backed by under 60% of the rubric weight (invariant I4). */
export function thinCoverage(coverage: number): boolean {
  return coverage < POSTING_COVERAGE_MIN - 1e-9;
}

/**
 * Invariant I4 for an AI fit: a result that could judge less than 60% of the
 * rubric weight is never Great, whatever its total. Applied when a new score
 * is stored (MatchService) and on every read (`assembleFit`), so the stored
 * tier and the shown tier agree.
 */
export function tierWithinCoverage<T extends FitTierKey | null>(tier: T, coverage: number): T | 'good' {
  return tierWhenThin(tier, thinCoverage(coverage));
}

/** A thin fit is never Great; every other tier stays. */
export function tierWhenThin<T extends FitTierKey | null>(tier: T, thin: boolean): T | 'good' {
  return tier === 'great' && thin ? 'good' : tier;
}

/**
 * Is this AI fit thin (invariant I4: never Great, confidence low)? Read on
 * the answer AND on the posting:
 *   - the scorer could judge under 60% of the rubric weight (`thinCoverage`);
 *   - or it judged nothing on skills and the posting states no level.
 *
 * The second half is the invariant's own sentence ("a job with no listed
 * skills and no stated level is never Great") for a scorer that cannot say
 * "not stated" about the level. Scorer v4 always scores title_level from its
 * own reading of two levels, and its domain and trajectory judgments count
 * with no quote behind them, so a posting that says a title and nothing else
 * reached 60% to 70% coverage and was stored and shown Great at 100
 * (M4 cross-review). A level the posting does not state is not evidence, and
 * with no skill or experience line judged there is nothing else to carry a
 * Great. A posting that states its level, or one whose requirement lines the
 * scorer found and judged, is not touched by this half.
 *
 * One function for the write (MatchService) and every read (`assembleFit`).
 */
export function aiFitThin(dimensions: MatchDimension[], job: MatchJob): boolean {
  if (thinCoverage(aiCoverage(dimensions))) return true;
  const skills = dimensions.find((d) => d.key === 'skills');
  const skillsJudged = !!skills && skills.status === 'scored' && skills.score !== null;
  return !skillsJudged && !postingStates(job).level;
}

// ── Assembly ──────────────────────────────────────────────────────────────

export interface FitConfig {
  weights: MatchWeights;
  tiers: MatchTiers;
  priors?: MatchPriors;
}

export interface FitInputs {
  job: MatchJobRecord;
  /**
   * The posting's content hash now. Omitted: computed from `job`, which must
   * then carry the posting's text (a full row). A list passes what it knows
   * without reading a description: the row's stored hash, or null.
   */
  jobContentHash?: string | null;
  user: MatchUser;
  /** The resume the fit is for (the primary one for the canonical fit); null when the person has none. */
  resume: Pick<ResumeRecord, 'id' | 'resumeContentHash'> | null;
  /** The stored row for (person, job, this resume), when there is one. */
  stored?: StoredFitRow | null;
  config: FitConfig;
  pin: ScorerPin;
  /** The market's calibration map, when it may use one. */
  map?: CalibrationMap | null;
  /** False: AI is off for this person, so a stored AI score is not shown (the estimate, on every surface). */
  aiAllowed?: boolean;
  /** Why the answer is an estimate, when the caller knows (ignored for an AI fit). */
  estimateReason?: EstimateReason | null;
  /** The prose of the stored row, prepared by the caller (single-job reads). */
  prose?: FitProse | null;
  /** The checklist of the stored row, prepared by the caller (single-job reads of a scorer v4 row). */
  requirements?: RequirementCheck[] | null;
  /** False when a model call in this request produced the stored row. Default true. */
  cached?: boolean;
  now: Date;
}

/** The estimate as shown: mapped onto the AI scale when the market has a map, never past what the estimate may claim. */
function shownEstimate(estimate: EstimateResult, map: CalibrationMap | null | undefined, tiers: MatchTiers): { score: number | null; tier: FitTierKey | null; calibrated: boolean } {
  if (estimate.score === null || !map) return { score: estimate.score, tier: estimate.tier, calibrated: false };
  const mapped = Math.round(applyMap(map, estimate.score));
  const score = estimate.limit === null ? mapped : Math.min(mapped, estimate.limit);
  return { score, tier: tierFor(score, tiers), calibrated: true };
}

/**
 * The fit for one person and one job from what was read: the stored AI score
 * when it may be shown, else the estimate. Pure; every surface gets its fit
 * from this function, which is why they agree (I1).
 */
export function assembleFit(input: FitInputs): Fit {
  const { user, resume, config } = input;
  const job = toMatchJob(input.job);
  const estimate = preScore(user, job, config);
  const split = splitSkills(user, job);
  const jobContentHash = input.jobContentHash !== undefined ? input.jobContentHash : currentJobHash(input.job);
  const common = {
    jobId: input.job.id,
    requirements: [] as RequirementCheck[],
    topOverlap: split.aligned[0] ?? null,
    topGap: split.missingRequired[0] ?? split.missing[0] ?? null,
    basis: {
      resumeVariantId: resume?.id ?? null,
      resumeContentHash: resume?.resumeContentHash ?? null,
      jobContentHash,
      searchProfileVersion: user.searchProfileVersion,
    },
    estimateScore: estimate.score,
    skills: { aligned: split.aligned, missing: split.missing, softSkills: split.softSkills, listed: hardSkillList(job).length },
  };

  const status =
    resume && input.stored && input.aiAllowed !== false
      ? storedFitStatus(input.stored, { resumeContentHash: resume.resumeContentHash, jobContentHash, pin: input.pin })
      : NOT_USABLE;

  if (status.usable && status.dimensions && input.stored) {
    const row = input.stored;
    const dimensions = refreshDimensions(status.dimensions, user, job, config.weights);
    const score = combineDimensions(dimensions) ?? row.score;
    const coverage = aiCoverage(dimensions);
    // I4: under 60% of the rubric weight judged, or no skill line judged for a posting that states no level, is low
    // confidence and never Great (`aiFitThin`).
    const thin = aiFitThin(dimensions, job);
    const confidence = confidenceFor(coverage, thin);
    return {
      ...common,
      requirements: input.requirements ?? [],
      score,
      tier: tierWhenThin(hysteresisTier(row.tier, score, config.tiers), thin),
      kind: 'ai',
      coverage,
      confidence,
      confidenceReason: confidence === 'low' ? confidenceReasonFor(user, job) : null,
      dimensions,
      version: { rubric: rubricOfPrompt(row.promptVersion) ?? input.pin.rubric, estimator: ESTIMATOR_VERSION, model: row.modelUsed, prompt: row.promptVersion },
      scoredAt: row.generatedAt.toISOString(),
      stale: status.stale,
      calibrated: false,
      estimateReason: null,
      prose: input.prose ?? null,
      cached: input.cached ?? true,
    };
  }

  const shown = shownEstimate(estimate, input.map, config.tiers);
  return {
    ...common,
    score: shown.score,
    tier: shown.tier,
    kind: 'estimate',
    coverage: estimate.coverage,
    confidence: estimate.confidence,
    confidenceReason: estimate.confidenceReason,
    dimensions: estimate.dimensions,
    version: { rubric: input.pin.rubric, estimator: ESTIMATOR_VERSION, model: null, prompt: null },
    scoredAt: input.now.toISOString(),
    stale: false,
    calibrated: shown.calibrated,
    estimateReason: input.estimateReason ?? null,
    prose: null,
    cached: false,
  };
}

// ── Wire shapes ───────────────────────────────────────────────────────────

/**
 * A fit as `MatchFitView` (`POST /jobs/:id/score`, the fit card). The shape is
 * the one the web and the published extension read: an estimate is `kind:
 * 'pre'`; the fields estimate v2 added are additive.
 */
export function fitToView(fit: Fit, opts: { locale?: string } = {}): MatchFitView {
  const prose = fit.kind === 'ai' ? fit.prose : null;
  return {
    jobId: fit.jobId,
    score: fit.score,
    tier: fit.tier,
    kind: toWireKind(fit.kind),
    dimensions: fit.dimensions,
    summary: prose?.summary ?? null,
    strengths: prose?.strengths ?? [],
    gaps: prose?.gaps ?? [],
    keywordsMatched: prose?.keywordsMatched ?? [],
    keywordsMissing: prose?.keywordsMissing ?? [],
    skills: fit.skills,
    topOverlap: fit.topOverlap ?? prose?.strengths[0] ?? null,
    topGap: fit.topGap ?? prose?.gaps[0] ?? null,
    scoredAt: fit.scoredAt,
    resumeVariantId: fit.basis.resumeVariantId,
    estimateReason: fit.kind === 'ai' ? null : fit.estimateReason,
    summaryLocaleStale: prose ? prose.locale !== (opts.locale ?? 'en') : false,
    cached: fit.kind === 'ai' ? fit.cached : false,
    coverage: fit.coverage,
    confidence: fit.confidence,
    confidenceReason: fit.confidenceReason,
    requirements: fit.requirements,
    stale: fit.stale,
    calibrated: fit.calibrated,
    ...(fit.rewriteBlocked ? { rewriteBlocked: fit.rewriteBlocked } : {}),
  };
}

/** A fit as one row of a list (`PreScoreResult`): the same score, tier and kind, in the wire spelling. */
export function fitToListResult(fit: Fit): PreScoreResult {
  return {
    jobId: fit.jobId,
    score: fit.score,
    tier: fit.tier,
    kind: toWireKind(fit.kind),
    dimensions: fit.dimensions,
    topOverlap: fit.topOverlap,
    topGap: fit.topGap,
    coverage: fit.coverage,
    confidence: fit.confidence,
    confidenceReason: fit.confidenceReason,
  };
}

// ── Snapshots (I6) ────────────────────────────────────────────────────────

/**
 * The copy of a fit that may be stored or sent out of the app (an alert or
 * lifecycle mail, a notification card, a tailoring session's "before" and
 * "after"): the number with its kind, the versions that produced it and when.
 * In-app lists and pages never show a snapshot; they read `getFit` / `getFits`.
 */
export function fitSnapshot(fit: Pick<Fit, 'score' | 'tier' | 'kind' | 'version' | 'scoredAt'>): FitSnapshot {
  return {
    score: fit.score,
    tier: fit.tier,
    kind: fit.kind,
    rubric: fit.version.rubric,
    estimator: fit.version.estimator,
    model: fit.version.model,
    scoredAt: fit.scoredAt,
  };
}

// ── The three functions ───────────────────────────────────────────────────

export interface GetFitOptions {
  /** Default false: the stored AI score or the estimate, never a model call. */
  allowModelCall?: boolean;
  /** Which budget a model call counts against (default `on_demand`). Ignored unless `allowModelCall`. */
  mode?: ScoreMode;
  /** The UI language of the request (the AI prose is flagged when it was written in another). */
  locale?: string;
}

/** What a caller that already loaded something may hand to `getFits` (the feed does, to read it once). */
export interface GetFitsOptions {
  /** The answer of this same service's `userContext(userId)` in this request. */
  context?: { user: MatchUser; resume: ResumeRecord | null };
  /**
   * The UI language of the request, when the caller knows it: skill labels
   * are written in it. Absent: the posting's language, else the market's.
   */
  locale?: string;
  /**
   * Job rows the caller already read from the database in this request (the
   * feed's window, as `toMatchRecord` gives them). An id that has its row
   * here is not read again; the others are. The rows need the columns the
   * estimate reads and no description text.
   */
  rows?: readonly MatchJobRecord[];
}

export interface FitFunctions {
  /** The fit for the person's PRIMARY resume. */
  getFit(userId: string, jobId: string, opts?: GetFitOptions): Promise<Fit>;
  /** Fits for a list (at most 500 ids), keyed by job id. Never a model call. A job the person may not see has no entry. */
  getFits(userId: string, jobIds: string[], opts?: GetFitsOptions): Promise<Map<string, Fit>>;
  /** The fit for another resume version. The only function that accepts a variant; tailoring only. */
  getVariantFit(userId: string, jobId: string, variantId: string, opts?: GetFitOptions): Promise<Fit>;
}

/** What the three functions run on: a MatchService (`createMatchService(deps).fits`). */
export type FitSource = Pick<MatchService, 'fits'>;

/** The three functions of a given MatchService (tests, the harness). */
export function fitFunctions(service: FitSource): FitFunctions {
  return service.fits;
}

/**
 * The fit functions bound to a service built on other dependencies
 * (in-memory fakes): pass `createMatchService(deps)`, or `{ service }`.
 * (This file cannot build the service itself: the service imports it.)
 */
export function createFitService(source: FitSource | { service: FitSource }): FitFunctions {
  const service = 'service' in source && source.service ? source.service : (source as FitSource);
  const fits = service?.fits;
  if (!fits || typeof fits.getFit !== 'function' || typeof fits.getFits !== 'function' || typeof fits.getVariantFit !== 'function') {
    throw new TypeError('createFitService needs a MatchService: pass createMatchService(deps) or { service }');
  }
  return fits;
}

let override: FitFunctions | null = null;

/** Test seam: serve the module-level functions from another service (null restores the production one). */
export function setFitServiceForTests(service: FitSource | null): void {
  override = service ? fitFunctions(service) : null;
}

async function production(): Promise<FitFunctions> {
  if (override) return override;
  // Lazy: defaultService.ts builds the MatchService, which imports this file.
  return fitFunctions((await import('./defaultService.js')).defaultMatchService);
}

/** The fit of one job for the person's primary resume. Runs in the brand of the current request. */
export async function getFit(userId: string, jobId: string, opts?: GetFitOptions): Promise<Fit> {
  return (await production()).getFit(userId, jobId, opts);
}

/** The fits of a list (at most 500 ids) for the person's primary resume. Never a model call. */
export async function getFits(userId: string, jobIds: string[], opts?: GetFitsOptions): Promise<Map<string, Fit>> {
  return (await production()).getFits(userId, jobIds, opts);
}

/** The fit for a named resume version ("With this version"). Tailoring only. */
export async function getVariantFit(userId: string, jobId: string, variantId: string, opts?: GetFitOptions): Promise<Fit> {
  return (await production()).getVariantFit(userId, jobId, variantId, opts);
}

// ── A posting that is not a stored job ────────────────────────────────────

/**
 * The id an ad-hoc posting is estimated under. It is not the id of any stored
 * job (job ids carry no colon), so no stored score can ever belong to it.
 */
export const ADHOC_POSTING_ID = 'adhoc:posting';

/** What `estimateForPosting` reads: a posting in the shape the matcher reads, without the fields that say whose it is. */
export type AdhocPosting = Omit<MatchJobRecord, 'id' | 'visibility' | 'ownerUserId'>;

/**
 * The v2 estimate for a posting that is not one of our jobs (the page the
 * person has open in the browser extension). It is the same fit a stored job
 * would get before any AI read: assembled by `assembleFit` with the person's
 * primary resume, the market's priors and its calibration map.
 *
 * Always `kind: 'estimate'`. Nothing is stored and no model is called: the
 * posting is handed to `getFits` as a row the caller already holds, under an
 * id no stored score can carry. Null when the posting is of another market
 * than the request's brand, or when nothing could be assembled.
 */
export async function estimateForPosting(userId: string, posting: AdhocPosting, fits?: Pick<FitFunctions, 'getFits'>): Promise<Fit | null> {
  const row: MatchJobRecord = { ...posting, id: ADHOC_POSTING_ID, visibility: 'private', ownerUserId: userId };
  const read = fits ?? (await production());
  const fit = (await read.getFits(userId, [row.id], { rows: [row] })).get(row.id) ?? null;
  // An estimate by construction; the check keeps the promise if the id rule above is ever broken.
  return fit && fit.kind === 'estimate' ? fit : null;
}

