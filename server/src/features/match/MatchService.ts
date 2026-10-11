// server/src/features/match/MatchService.ts
//
// Fit scoring (ARCHITECTURE.md §4.7; TASK_PLAN.md WP-18; MARKET_STRATEGY 2.2).
// The reads, the caps and the one model call behind the fit contract (fit.ts):
//
//   fits.getFit / getFits / getVariantFit   the fit contract (fit.ts): one job, a list, another resume version
//   scoreJob                     `getFit` as a `MatchFitView` (job detail); scorer v3 behind the cache,
//                                platform-paid, 80/day/user and a brand budget, beyond either the
//                                estimate with its reason
//   preScoreMany                 `getFits` as a list of `PreScoreResult` (kept for callers not yet on getFits)
//   preScoreJobs                 the estimate only, over rows the caller loaded (precompute ranking, extension pages)
//   fitAnalysis                  the structured card; spends a `fit_analysis` credit only
//                                when a model call is actually needed
//   keywordCheck                 requirement rows (title, years, education, skills, keywords)
//
// Rules this file enforces:
//   - The server computes the total: the model judges four components; the
//     fifth (location, pay and visa) is deterministic; for an AI score the
//     weights renormalize over the components that are stated.
//   - Evidence that is not a verbatim substring of the resume or the posting
//     is dropped (CitationGuard).
//   - `aiAllowed(user)` is checked before any model call and before a stored
//     AI score is shown. When false (GoApply without the "Use AI" consent)
//     nothing is sent to a model: the answer is the estimate, on every surface.
//   - A stored row is the fit when it was written for this resume content by
//     a fit scorer. A row of an earlier model or prompt, or one written for an
//     earlier version of the posting (job content hash), keeps serving, flagged
//     stale, until precompute or an on-demand call re-scores it (I7). A change
//     in logistics or weights recomputes the total without a model call; the
//     tier then moves only 3 points past the edge it crosses (I5).
//   - A list of fits (`getFits`) reads no description, ever: rows the caller
//     already loaded are not read again, and the posting's hash is taken from
//     the stored `RAJob.contentHash` only. Whether the posting changed since a
//     score was written is therefore known on a list once that column is
//     filled; the single-job read and the precompute cron hold the full row
//     and always know.
//   - The resume reaches the model PII-stripped, with no sensitive fields;
//     school tier is never an input.

import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import type { RateLimitResult, RateWindow } from '../../platform/ratelimit/index.js';
import type { ReserveOptions } from '../../platform/credits/index.js';
import { logger } from '../../services/LoggerService.js';
import type {
  RAJobMatchScorerV3Input,
  RAJobMatchScorerV3Output,
} from '../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { calibrationFor, withCalibratedPriors, type ActiveCalibration, type CalibrationMap } from './calibration.js';
import {
  MATCH_ERROR_CODES,
  SCORER_PROMPT_VERSION,
  type EstimateReason,
  type EstimateResult,
  type FitAnalysisCard,
  type KeywordCheckResponse,
  type MatchDimension,
  type MatchFitView,
  type MatchPriors,
  type MatchTiers,
  type MatchWeights,
  type PreScoreResult,
} from './contract.js';
import {
  ON_DEMAND_SCORE_CAP_PER_DAY,
  SCORE_WINDOW_SEC,
  currentScorerPin,
  getMatchPriors,
  getMatchTiers,
  getMatchWeights,
  scoreCounterKeys,
  scoreDailyBudget,
  tierFor,
  type ScorerPin,
} from './config.js';
import { buildMatchUser, postingText, toMatchJob, userNames, type MatchJobRecord } from './context.js';
import { guardEvidence } from './evidence.js';
import { assembleFit, fitToListResult, fitToView, storedFitStatus, type Fit, type FitFunctions, type FitProse, type GetFitOptions, type GetFitsOptions } from './fit.js';
import { currentJobHash, storedJobHash } from './jobHash.js';
import { buildKeywordRows } from './keywordRows.js';
import { stripResumeForScoring } from './pii.js';
import { runMatchPreparers } from './prepare.js';
import { defaultScorerRouteAllowed } from './scorerRoute.js';
import {
  combineDimensions,
  degreeMeets,
  logisticsChecks,
  logisticsDimension,
  mentions,
  normalizeText,
  userShows,
  type ShownSource,
  preScore,
  type MatchJob,
  type MatchUser,
} from './preScore.js';
import { createPrismaMatchRepo, type MatchRepo, type ResumeRecord, type ScoreRecord, type StoredFitRow } from './repo.js';
import { dedupeTerms, displayTerm, termKey } from './terms.js';

// ── Dependencies (all injectable; defaults are lazy so importing is cheap) ──

export interface ScorerLike {
  run(input: RAJobMatchScorerV3Input, options: { locale?: string; model?: string }): Promise<RAJobMatchScorerV3Output>;
}

export interface CostLogInput {
  userId: string;
  jobId: string;
  resumeVariantId: string;
  reason: string;
  mode: ScoreMode;
}

export interface MatchServiceDeps {
  repo?: MatchRepo;
  scorer?: ScorerLike;
  /** The model the scorer will use, or null when none is configured for this brand. */
  resolveModel?: () => string | null;
  /** Brand LLM-route policy (match/scorerRoute.ts) for the resolved model; false → no model call ("Quick estimate"). */
  routeAllowed?: (brand: ProductBrand, model: string) => boolean | Promise<boolean>;
  aiAllowed?: (userId: string) => Promise<boolean>;
  consume?: (input: { key: string; windows: readonly RateWindow[]; cost?: number }) => Promise<RateLimitResult>;
  withCredit?: <T>(opts: ReserveOptions, fn: () => Promise<T>) => Promise<T>;
  profileSnapshot?: (userId: string) => Promise<string | null>;
  costLog?: (input: CostLogInput) => Promise<void>;
  brand?: () => ProductBrand;
  env?: EnvSource;
  now?: () => Date;
  /** The market's calibration (map and data-derived priors). Default: the stored document, read through the repo (calibration.ts). */
  calibration?: (market: ProductBrand['market']) => Promise<ActiveCalibration>;
}

/**
 * - on_demand: job detail; counts against 80/day/user and the brand budget.
 * - paid: fit analysis with a credit; skips the platform caps.
 * - precompute: the cron's queued item; counts against the brand budget only
 *   (the per-user precompute cap is spent when the item is queued).
 * - cache_only: never calls a model.
 */
export type ScoreMode = 'on_demand' | 'paid' | 'precompute' | 'cache_only';

export interface ScoreOptions {
  /** Another resume version than the primary one (the tailoring path; the canonical fit is always the primary resume). */
  resumeVariantId?: string | null;
  force?: boolean;
  regenerateExplanation?: boolean;
  locale?: string;
  mode?: ScoreMode;
  /** 'fallback' (default): a failed model call answers the pre-score; 'throw': rethrow. */
  onAiFailure?: 'fallback' | 'throw';
}

export class ScorerFailedError extends Error {
  constructor(cause: unknown) {
    super(`fit scorer failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ScorerFailedError';
  }
}

const lazyScorer: ScorerLike = {
  async run(input, options) {
    const { RAJobMatchScorerV3Agent } = await import('../../roboapply/v2/agents/RAJobMatchScorerAgent.js');
    return new RAJobMatchScorerV3Agent().run(input, options);
  },
};

let modelResolver: (() => string | null) | null = null;
async function defaultResolveModelAsync(): Promise<string | null> {
  if (!modelResolver) {
    const { resolvedJobMatchScorerModel } = await import('../../roboapply/v2/agents/RAJobMatchScorerAgent.js');
    modelResolver = () => {
      try {
        return resolvedJobMatchScorerModel();
      } catch {
        return null;
      }
    };
  }
  return modelResolver();
}

async function defaultAiAllowed(userId: string): Promise<boolean> {
  const { aiAllowed } = await import('../../platform/consent/aiAllowed.js');
  return aiAllowed(userId);
}

async function defaultConsume(input: { key: string; windows: readonly RateWindow[]; cost?: number }): Promise<RateLimitResult> {
  const { consumeRateLimit } = await import('../../platform/ratelimit/index.js');
  return consumeRateLimit(input);
}

async function defaultWithCredit<T>(opts: ReserveOptions, fn: () => Promise<T>): Promise<T> {
  const { creditService } = await import('../../platform/credits/index.js');
  return creditService.withCredit(opts, fn);
}

async function defaultProfileSnapshot(userId: string): Promise<string | null> {
  try {
    const { profileSnapshotForLlm } = await import('../profile/index.js');
    const snap = await profileSnapshotForLlm(userId);
    return snap?.text?.trim() ? snap.text : null;
  } catch {
    // WP-19 fills the seam; until then the resume alone is the context.
    return null;
  }
}

async function defaultCostLog(input: CostLogInput): Promise<void> {
  try {
    const [{ writeDeductionLog }, { costPatchFromTally }, { getCurrentRequestId }] = await Promise.all([
      import('../../lib/matchBilling.js'),
      import('../../lib/deductionCost.js'),
      import('../../lib/requestContext.js'),
    ]);
    const requestId = getCurrentRequestId() ?? null;
    const cost = costPatchFromTally(requestId);
    await writeDeductionLog({
      userId: input.userId,
      sku: 'ra_match_score',
      source: 'plan',
      platformCostUsd: cost.platformCostUsd,
      units: 1,
      requestId,
      relatedEntityType: 'ra_job',
      relatedEntityId: input.jobId,
      metadata: {
        ...cost.metadata,
        source: 'match_v3',
        agent: 'RAJobMatchScorerV3Agent',
        resumeVariantId: input.resumeVariantId,
        reason: input.reason,
        mode: input.mode,
        cached: false,
      },
    });
  } catch (err) {
    logger.warn('MATCH', 'cost log failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * A job the user may see on this brand: same market; public or their own
 * import. On GoApply a third-party posting also needs the recruitment-info
 * mode to allow postings (it does by default, D5): with
 * CN_RECRUITMENT_INFO_MODE=off only the
 * user's own imports can be scored, analysed or keyword-checked. The same
 * answer as cn/jobs `cnPostingVisible` (a test keeps the two equal), read from
 * the platform's mode resolver so MATCH does not load the GoApply jobs area.
 */
export function visibleTo(
  job: Pick<MatchJobRecord, 'market' | 'visibility' | 'ownerUserId'>,
  userId: string,
  market: string,
  env: EnvSource = process.env,
): boolean {
  if (job.market !== market) return false;
  if (!(job.visibility === 'public' || job.ownerUserId === userId)) return false;
  // A posting that is not the user's own import is a third-party posting.
  if (job.market === 'cn' && job.visibility !== 'private' && cnRecruitmentInfoMode(env) === 'off') return false;
  return job.visibility !== 'private' || job.ownerUserId === userId;
}

interface StoredExplanation {
  strengths: string[];
  gaps: string[];
  rationale: string;
  keywordsMatched: string[];
  keywordsMissing: string[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function readExplanation(v: unknown): StoredExplanation & { responseLanguage: string | null } {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    strengths: strings(o.strengths),
    gaps: strings(o.gaps),
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
    keywordsMatched: strings(o.keywordsMatched),
    keywordsMissing: strings(o.keywordsMissing),
    responseLanguage: typeof o.responseLanguage === 'string' ? o.responseLanguage : null,
  };
}

/**
 * Keep a model-picked keyword only when it is true: it appears in the posting,
 * and the resume/profile mentions it (matched) or does not (missing).
 */
export function verifyKeywords(
  matched: string[],
  missing: string[],
  posting: string,
  user: ShownSource,
): { keywordsMatched: string[]; keywordsMissing: string[] } {
  const postingNorm = normalizeText(posting);
  const inPost = (t: string) => mentions(postingNorm, t);
  const all = dedupeTerms([...matched, ...missing].map((x) => x.trim()).filter(Boolean), (x) => x).filter(inPost);
  return {
    keywordsMatched: all.filter((t) => userShows(user, t)),
    keywordsMissing: all.filter((t) => !userShows(user, t)),
  };
}

/**
 * The model's stored terms as they are shown: sorted again by the current
 * "does the resume show it" rule (a stored "missing: cloud infrastructure" is
 * not missing for a resume that lists AWS), one entry per thing, nothing the
 * skill chips already list, in the usual spelling.
 */
export function shownKeywords(
  stored: { keywordsMatched: string[]; keywordsMissing: string[] },
  user: ShownSource,
  skills: { aligned: string[]; missing: string[] },
): { keywordsMatched: string[]; keywordsMissing: string[] } {
  const listed = new Set([...skills.aligned, ...skills.missing].map(termKey));
  const all = dedupeTerms([...stored.keywordsMatched, ...stored.keywordsMissing].map((x) => x.trim()).filter(Boolean), (x) => x).filter((t) => !listed.has(termKey(t)));
  return {
    keywordsMatched: all.filter((t) => userShows(user, t)).map(displayTerm),
    keywordsMissing: all.filter((t) => !userShows(user, t)).map(displayTerm),
  };
}

/** Logistics lines given to the model as facts. */
function logisticsLines(user: MatchUser, job: MatchJob): string[] {
  const c = logisticsChecks(user, job);
  const say = (label: string, r: string | null) =>
    r === null ? null : `${label}: ${r === 'met' ? 'fits what the candidate asked for' : r === 'not_met' ? 'does not fit what the candidate asked for' : 'not stated'}`;
  return [say('Location', c.location), say('Pay', c.pay), say('Visa sponsorship', c.visa)].filter((x): x is string => !!x);
}

// ── Service ───────────────────────────────────────────────────────────────

export interface MatchService {
  /**
   * The fit contract on this service's dependencies (fit.ts): `getFit` (one
   * job, the PRIMARY resume), `getFits` (a list, never a model call) and
   * `getVariantFit` (another resume version; tailoring only). Production code
   * reads them through the functions of the same names exported by fit.ts.
   */
  readonly fits: FitFunctions;
  /** `getFit` (or, with `resumeVariantId`, `getVariantFit`) as the wire view of job detail. */
  scoreJob(userId: string, jobId: string, options?: ScoreOptions): Promise<MatchFitView>;
  /** `getFits` as a list: the stored AI score where one can be shown (`kind: 'ai'`), else the quick estimate. No model call. */
  preScoreMany(userId: string, jobIds: string[]): Promise<PreScoreResult[]>;
  /** The deterministic quick estimate only, over rows the caller loaded (precompute ranking, extension pages). */
  preScoreJobs(userId: string, jobs: MatchJobRecord[]): Promise<EstimateResult[]>;
  fitAnalysis(userId: string, jobId: string, idempotencyKey: string, options?: { resumeVariantId?: string | null; locale?: string }): Promise<FitAnalysisCard>;
  keywordCheck(userId: string, jobId: string, options?: { resumeVariantId?: string | null }): Promise<KeywordCheckResponse>;
  /** The user's side of the pre-score (precompute, extension). */
  userContext(userId: string): Promise<{ user: MatchUser; resume: ResumeRecord | null }>;
  /** Weights, tiers and the configured starting priors (the market's data-derived priors are applied inside the fit). */
  config(): { weights: MatchWeights; tiers: MatchTiers; priors: MatchPriors };
  /** The market's calibration map, when it may use one (feed ranking reads it next to the fits). */
  calibrationMap(): Promise<CalibrationMap | null>;
}

/** The most ids one `getFits` call reads. */
export const FITS_MAX_IDS = 500;

interface FitCallOptions {
  variantId?: string | null;
  mode: ScoreMode;
  locale: string;
  force?: boolean;
  regenerateExplanation?: boolean;
  onAiFailure?: 'fallback' | 'throw';
}

export function createMatchService(deps: MatchServiceDeps = {}): MatchService {
  const repo = deps.repo ?? createPrismaMatchRepo();
  const scorer = deps.scorer ?? lazyScorer;
  const resolveModelRaw = async () => (deps.resolveModel ? deps.resolveModel() : defaultResolveModelAsync());
  const routeAllowed = deps.routeAllowed ?? defaultScorerRouteAllowed;
  /** The scorer model, or null when none is configured or the brand may not use its route. */
  const resolveModel = async (brand: ProductBrand): Promise<string | null> => {
    const model = await resolveModelRaw();
    if (!model) return null;
    if (!(await routeAllowed(brand, model))) {
      logger.warn('MATCH', 'scorer model refused by the brand LLM policy; answering the quick estimate', { brand: brand.id, model });
      return null;
    }
    return model;
  };
  const isAiAllowed = deps.aiAllowed ?? defaultAiAllowed;
  const consume = deps.consume ?? defaultConsume;
  const withCredit = deps.withCredit ?? defaultWithCredit;
  const profileSnapshot = deps.profileSnapshot ?? defaultProfileSnapshot;
  const costLog = deps.costLog ?? defaultCostLog;
  const brandOf = deps.brand ?? getCurrentBrandOrDefault;
  const now = deps.now ?? (() => new Date());
  const config = () => ({ weights: getMatchWeights(deps.env), tiers: getMatchTiers(deps.env), priors: getMatchPriors(brandOf(), deps.env) });
  const calibration = deps.calibration ?? ((market: ProductBrand['market']) => calibrationFor(repo, { env: deps.env }).forMarket(market));

  /** What every estimate and every fit of this request is computed with: the config, the market's priors and its map. */
  async function fitConfig(): Promise<{ weights: MatchWeights; tiers: MatchTiers; priors: MatchPriors; map: CalibrationMap | null }> {
    const base = config();
    let cal: ActiveCalibration = { map: null, priors: null };
    try {
      cal = await calibration(brandOf().market);
    } catch (err) {
      logger.warn('MATCH', 'calibration unavailable; using the starting priors and no map', { error: err instanceof Error ? err.message : String(err) });
    }
    return { ...base, priors: withCalibratedPriors(base.priors, cal.priors), map: cal.map };
  }

  /** The pinned scorer version (the configured model, whether or not this brand may call it now). */
  async function scorerPin(brand: ProductBrand): Promise<ScorerPin> {
    return currentScorerPin(brand, await resolveModelRaw());
  }

  async function userContext(userId: string, variantId?: string | null): Promise<{ user: MatchUser; resume: ResumeRecord | null; names: string[] }> {
    // Anything the synchronous estimate needs loaded first (prepare.ts); nothing is registered in this phase.
    // A loader that fails must not take every list and every job page down with it: the read goes on with what is
    // loaded, and the next read runs the loader again.
    try {
      await runMatchPreparers();
    } catch (err) {
      logger.warn('MATCH', 'a match preparer failed; continuing without it (retried on the next read)', { error: err instanceof Error ? err.message : String(err) });
    }
    const market = brandOf().market;
    const [inputs, resume] = await Promise.all([repo.getUserInputs(userId, market), repo.getResume(userId, variantId)]);
    if (variantId && !resume) throw new HttpError('not_found', 'Resume not found.', { reason: MATCH_ERROR_CODES.variantNotFound });
    const full = { ...inputs, resumeParsed: resume?.parsedData ?? null };
    const user: MatchUser = { ...buildMatchUser(full, now()), resumeTextNorm: resume ? normalizeText(resume.resumeMarkdown) : null, hasResume: !!resume };
    return { user, resume, names: userNames(full) };
  }

  async function loadVisibleJob(userId: string, jobId: string): Promise<MatchJobRecord> {
    const job = await repo.getJob(jobId);
    if (!job || !visibleTo(job, userId, brandOf().market, deps.env)) {
      throw new HttpError('not_found', 'Job not found.', { reason: MATCH_ERROR_CODES.jobNotFound });
    }
    return job;
  }

  /** The stored row's prose as it is shown now (keywords re-sorted by the current rule, nothing the skill lists carry). */
  function proseOf(row: Pick<ScoreRecord, 'explanation' | 'locale'>, user: MatchUser, skills: Fit['skills']): FitProse {
    const exp = readExplanation(row.explanation);
    const keywords = shownKeywords(exp, user, skills);
    return {
      summary: exp.rationale || null,
      strengths: exp.strengths,
      gaps: exp.gaps,
      keywordsMatched: keywords.keywordsMatched,
      keywordsMissing: keywords.keywordsMissing,
      locale: row.locale ?? exp.responseLanguage ?? 'en',
    };
  }

  async function underCaps(userId: string, mode: ScoreMode, brand: ProductBrand): Promise<EstimateReason | null> {
    if (mode === 'paid') return null;
    try {
      const budgetKey = scoreCounterKeys.budget(brand.id);
      const budgetWindows = [{ limit: scoreDailyBudget(brand, deps.env), windowSec: SCORE_WINDOW_SEC }];
      if (mode === 'on_demand') {
        // Peek at the brand budget first (cost 0 reads without spending), so a
        // spent budget never costs the user one of their 80 daily scores.
        const peek = await consume({ key: budgetKey, windows: budgetWindows, cost: 0 });
        if (!peek.allowed || peek.remaining <= 0) return 'budget';
        const perUser = await consume({
          key: scoreCounterKeys.onDemand(brand.id, userId),
          windows: [{ limit: ON_DEMAND_SCORE_CAP_PER_DAY, windowSec: SCORE_WINDOW_SEC }],
        });
        if (!perUser.allowed) return 'daily_cap';
      }
      const budget = await consume({ key: budgetKey, windows: budgetWindows });
      if (!budget.allowed) return 'budget';
      return null;
    } catch (err) {
      // A counter outage must not turn into unmetered model spend.
      logger.warn('MATCH', 'score counters unavailable; answering the quick estimate', { error: err instanceof Error ? err.message : String(err) });
      return 'budget';
    }
  }

  /**
   * The fit of one job: the one implementation behind `getFit`,
   * `getVariantFit` and `scoreJob`. `mode: 'cache_only'` never calls a model.
   */
  async function fitOne(userId: string, jobId: string, o: FitCallOptions): Promise<Fit> {
    const brand = brandOf();
    const jobRow = await loadVisibleJob(userId, jobId);
    const { user, resume, names } = await userContext(userId, o.variantId);
    const cfg = await fitConfig();
    const pin = await scorerPin(brand);
    const job = toMatchJob(jobRow);
    const jobContentHash = currentJobHash(jobRow);
    const base = { job: jobRow, jobContentHash, user, resume, config: cfg, pin, map: cfg.map, now: now() };
    const estimate = (reason: EstimateReason | null): Fit => assembleFit({ ...base, stored: null, estimateReason: reason });
    /** The fit a stored row gives (its prose included). */
    const fromRow = (row: ScoreRecord, cached: boolean): Fit => {
      const bare = assembleFit({ ...base, stored: row, cached });
      return bare.kind === 'ai' ? { ...bare, prose: proseOf(row, user, bare.skills) } : bare;
    };

    if (!resume) return estimate('no_resume');
    // GoApply "Use AI" consent (and any future per-user AI gate): no model call, and no stored AI score either.
    if (!(await isAiAllowed(userId))) return estimate('ai_off');

    const existing = await repo.getScore(userId, jobId, resume.id);
    const status = storedFitStatus(existing, { resumeContentHash: resume.resumeContentHash, jobContentHash, pin });
    const mayCall = o.mode !== 'cache_only';

    // A rewrite of the written parts in another language ("Rewrite them in this
    // language"): the stored score and its components are kept; only the
    // summary, strengths and gaps are written again. Set when that is what was asked.
    let rewrite: ScoreRecord | null = null;
    if (status.usable && existing) {
      const exp = readExplanation(existing.explanation);
      const localeOk = (existing.locale ?? exp.responseLanguage ?? 'en') === o.locale;
      const wantsProse = !localeOk && o.regenerateExplanation === true;
      // A row of an earlier model or prompt, or of an earlier version of the posting, is re-scored by precompute or by
      // an on-demand call, never by a list.
      const rescore = mayCall && (o.force === true || status.stale);
      if (wantsProse && !rescore) rewrite = existing;
      if (!mayCall || (!rescore && !wantsProse)) {
        const fit = fromRow(existing, true);
        // Logistics or weights changed since the score: store the recomputed total (and its tier), no model call.
        if (fit.kind === 'ai' && fit.score !== null && (fit.score !== existing.score || fit.tier !== existing.tier || existing.searchProfileVersion !== user.searchProfileVersion)) {
          await repo.saveScore({
            ...existing,
            score: fit.score,
            tier: fit.tier,
            dimensions: fit.dimensions,
            searchProfileVersion: user.searchProfileVersion,
            generatedAt: existing.generatedAt,
          });
        }
        return fit;
      }
    }
    if (!mayCall) return estimate(null);

    /** What answers when the model may not run or fails: the stored fit when there is one to keep, else the estimate. */
    const keep = status.usable && existing && (rewrite || status.stale) ? existing : null;

    const model = await resolveModel(brand);
    if (!model) return keep ? fromRow(keep, true) : estimate('ai_unavailable');

    const capped = await underCaps(userId, o.mode, brand);
    // A rewrite or a planned re-score that may not run leaves the stored AI fit as it is, never a quick estimate in
    // its place. The queued precompute item gets the reason instead, so the worker can defer it.
    if (capped) return keep && o.mode !== 'precompute' ? fromRow(keep, true) : estimate(capped);

    // ── Model call ──
    const pre = preScore(user, job, cfg);
    const posting = postingText(jobRow);
    const resumeForModel = stripResumeForScoring(resume.resumeMarkdown, { names });
    let out: RAJobMatchScorerV3Output;
    try {
      out = await scorer.run(
        {
          resumeMarkdown: resumeForModel,
          profileContext: await profileSnapshot(userId),
          job: {
            title: jobRow.title,
            companyName: jobRow.companyName,
            seniority: jobRow.seniority,
            educationLevel: jobRow.educationLevel,
            minYears: jobRow.minYears,
            skills: jobRow.skills,
            description: jobRow.descriptionPlain || jobRow.description,
            qualifications: jobRow.qualifications,
            responsibilities: jobRow.responsibilities,
          },
          // The facts, as the AI score counts them (met / stated), not the estimate's prior.
          logistics: { score: logisticsDimension(user, job, cfg.weights).score, lines: logisticsLines(user, job) },
          // What the person says they are looking for (the saved search): context for the model, never an input of the estimate.
          targets: { titles: user.targetTitles, seniority: user.targetSeniority },
        },
        { locale: o.locale, model },
      );
    } catch (err) {
      logger.warn('MATCH', 'scorer v3 failed', { userId, jobId, error: err instanceof Error ? err.message : String(err) });
      if (o.onAiFailure === 'throw') throw new ScorerFailedError(err);
      return keep ? fromRow(keep, true) : estimate('ai_failed');
    }

    if (rewrite) {
      // Same score, same components, same keywords; new words only.
      const kept = fromRow(rewrite, true);
      const stored = rewrite.explanation && typeof rewrite.explanation === 'object' && !Array.isArray(rewrite.explanation) ? (rewrite.explanation as Record<string, unknown>) : {};
      const saved = await repo.saveScore({
        ...rewrite,
        ...(kept.kind === 'ai' && kept.score !== null ? { score: kept.score, tier: kept.tier } : {}),
        dimensions: kept.dimensions,
        explanation: { ...stored, strengths: out.strengths, gaps: out.gaps, rationale: out.summary ?? '', responseLanguage: o.locale },
        locale: o.locale,
        searchProfileVersion: user.searchProfileVersion,
        generatedAt: rewrite.generatedAt,
      });
      await costLog({ userId, jobId, resumeVariantId: resume.id, reason: 'locale_regen', mode: o.mode });
      return fromRow(saved, false);
    }

    // CitationGuard against the text the model actually saw.
    const sources = { resume: resumeForModel, posting };
    const logistics = logisticsDimension(user, job, cfg.weights);
    const dims: MatchDimension[] = (['title_level', 'skills', 'industry', 'logistics', 'career_path'] as const).map((key) => {
      if (key === 'logistics') return logistics;
      const d = out.dimensions[key];
      const score = d.score;
      return {
        key,
        weight: cfg.weights[key],
        score,
        status: score === null ? 'not_stated' : 'scored',
        evidence: guardEvidence(d.evidence, sources),
      } satisfies MatchDimension;
    });
    const total = combineDimensions(dims);
    if (total === null) return keep ? fromRow(keep, true) : estimate('ai_failed');

    const reason = !existing
      ? 'first_score'
      : existing.promptVersion !== SCORER_PROMPT_VERSION
        ? 'prompt_changed'
        : existing.resumeContentHashAtScore !== resume.resumeContentHash
          ? 'resume_changed'
          : existing.modelUsed !== model
            ? 'model_changed'
            : existing.jobContentHash && existing.jobContentHash !== jobContentHash
              ? 'posting_changed'
              : o.force
                ? 'forced'
                : 'locale_regen';
    const saved = await repo.saveScore({
      userId,
      jobId,
      resumeVariantId: resume.id,
      score: total,
      explanation: {
        strengths: out.strengths,
        gaps: out.gaps,
        rationale: out.summary ?? '',
        // Model-picked terms, kept only when the server can confirm them.
        ...verifyKeywords(out.keywordsMatched, out.keywordsMissing, posting, user),
        // Same keys RACrossBankSearchService / RAOnboardingRecommendService read.
        responseLanguage: o.locale,
        promptVersion: SCORER_PROMPT_VERSION,
        // The v2 estimate this score was written next to: the (estimate, AI) pair calibration.ts learns from.
        estimateAtScore: { score: pre.score, coverage: pre.coverage },
      },
      resumeContentHashAtScore: resume.resumeContentHash,
      modelUsed: model,
      scoreKind: 'ai',
      // A new model result takes its own tier.
      tier: tierFor(total, cfg.tiers),
      dimensions: dims,
      promptVersion: SCORER_PROMPT_VERSION,
      locale: o.locale,
      searchProfileVersion: user.searchProfileVersion,
      jobContentHash,
      rubricVersion: currentScorerPin(brand, model).rubric,
      generatedAt: now(),
    });
    if (resume.targetJobId === jobId) {
      await repo.updateVariantCachedScore(resume.id, total).catch(() => undefined);
    }
    await costLog({ userId, jobId, resumeVariantId: resume.id, reason, mode: o.mode });
    return fromRow(saved, false);
  }

  /**
   * The fits of a list: the one implementation behind `getFits` and
   * `preScoreMany`. Never a model call and never a write. A job that is gone
   * or that the person may not see has no entry; a job whose fit fails to
   * assemble is logged and left out, never thrown.
   *
   * What it reads, so a feed window stays cheap: the rows the caller did not
   * hand over (list projection, no description) and the stored AI scores of
   * the window (one query). No posting text is read, for any row. The
   * posting's hash is the stored `RAJob.contentHash` when the row has one
   * (then a score written for an earlier version of the posting is flagged
   * stale); a row without one is served as current here, and the single-job
   * read or the precompute cron, which hold the full row, flag and re-score
   * it. Either way the score, tier and kind are the ones `getFit` answers: a
   * stale score keeps serving, so the two forms never disagree on what is shown.
   */
  async function fitMany(userId: string, jobIds: string[], opts: GetFitsOptions = {}): Promise<Map<string, Fit>> {
    const out = new Map<string, Fit>();
    const ids = [...new Set(jobIds)].slice(0, FITS_MAX_IDS);
    if (!ids.length) return out;
    const brand = brandOf();
    const byId = new Map((opts.rows ?? []).map((r) => [r.id, r]));
    const unread = ids.filter((id) => !byId.has(id));
    if (unread.length) for (const r of await repo.getFitJobs(unread)) byId.set(r.id, r);
    const visible = ids.map((id) => byId.get(id)).filter((r): r is MatchJobRecord => !!r && visibleTo(r, userId, brand.market, deps.env));
    if (!visible.length) return out;
    const { user, resume } = opts.context ?? (await userContext(userId));
    const cfg = await fitConfig();
    const pin = await scorerPin(brand);

    let stored = new Map<string, StoredFitRow>();
    if (resume) {
      try {
        stored = await repo.listAiScores({ userId, jobIds: visible.map((j) => j.id), resumeVariantId: resume.id, resumeContentHash: resume.resumeContentHash });
      } catch (err) {
        // The quick estimate still answers; a list never fails over the stored scores.
        logger.warn('MATCH', 'stored AI scores unavailable for a list; answering the quick estimate', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // The same gate `getFit` applies: with AI off for this person a stored AI score is not shown (asked only when there is one).
    let aiOk = true;
    if (stored.size) {
      try {
        aiOk = await isAiAllowed(userId);
      } catch {
        aiOk = false;
      }
    }
    const reason: EstimateReason | null = !resume ? 'no_resume' : !aiOk ? 'ai_off' : null;
    const at = now();
    for (const row of visible) {
      try {
        out.set(
          row.id,
          assembleFit({
            job: row,
            // Never computed here: that would need the description of every row.
            jobContentHash: storedJobHash(row),
            user,
            resume,
            stored: stored.get(row.id) ?? null,
            config: cfg,
            pin,
            map: cfg.map,
            aiAllowed: aiOk,
            estimateReason: reason,
            now: at,
          }),
        );
      } catch (err) {
        logger.warn('MATCH', 'fit failed for a job in a list', { jobId: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  const callOptions = (opts: GetFitOptions | undefined, variantId: string | null): FitCallOptions => ({
    variantId,
    mode: opts?.allowModelCall === true ? (opts.mode ?? 'on_demand') : 'cache_only',
    locale: opts?.locale ?? 'en',
  });

  async function scoreJob(userId: string, jobId: string, options: ScoreOptions = {}): Promise<MatchFitView> {
    const locale = options.locale ?? 'en';
    const fit = await fitOne(userId, jobId, {
      variantId: options.resumeVariantId ?? null,
      mode: options.mode ?? 'on_demand',
      locale,
      force: options.force,
      regenerateExplanation: options.regenerateExplanation,
      onAiFailure: options.onAiFailure,
    });
    return fitToView(fit, { locale });
  }

  async function preScoreJobs(userId: string, jobs: MatchJobRecord[]): Promise<EstimateResult[]> {
    const market = brandOf().market;
    const visible = jobs.filter((j) => visibleTo(j, userId, market, deps.env));
    if (!visible.length) return [];
    const { user } = await userContext(userId);
    const cfg = await fitConfig();
    return visible.map((j) => preScore(user, toMatchJob(j), cfg));
  }

  /**
   * `getFits` in the list shape older callers read (Similar jobs, alerts, the
   * Assistant, Ready to apply), in the order the ids were given. One person
   * and one job carry one number on every surface.
   */
  async function preScoreMany(userId: string, jobIds: string[]): Promise<PreScoreResult[]> {
    const fits = await fitMany(userId, jobIds);
    return [...new Set(jobIds)].map((id) => fits.get(id)).filter((f): f is Fit => !!f).map(fitToListResult);
  }

  function toCard(view: MatchFitView, user: MatchUser, job: MatchJob, charged: boolean): FitAnalysisCard {
    const ai = view.kind === 'ai';
    return {
      jobId: view.jobId,
      score: view.score,
      tier: view.tier,
      kind: view.kind,
      dimensions: view.dimensions,
      skills: view.skills,
      education: {
        required: job.educationLevel && job.educationLevel !== 'none' ? job.educationLevel : null,
        yours: user.highestDegreeLabel ?? user.highestDegree,
        meets: degreeMeets(user.highestDegree, job.educationLevel),
      },
      highlights: ai ? view.strengths : [],
      gaps: ai ? view.gaps : [],
      summary: ai ? view.summary : null,
      aiWritten: ai && (view.summary !== null || view.strengths.length > 0 || view.gaps.length > 0),
      estimateReason: view.estimateReason,
      charged,
    };
  }

  async function fitAnalysis(
    userId: string,
    jobId: string,
    idempotencyKey: string,
    options: { resumeVariantId?: string | null; locale?: string } = {},
  ): Promise<FitAnalysisCard> {
    const jobRow = await loadVisibleJob(userId, jobId);
    const { user } = await userContext(userId, options.resumeVariantId);
    const job = toMatchJob(jobRow);
    const base = { resumeVariantId: options.resumeVariantId, locale: options.locale };
    // A fresh AI score (or a reason no model may run) answers without a credit.
    const peek = await scoreJob(userId, jobId, { ...base, mode: 'cache_only' });
    if (peek.kind === 'ai' || (peek.estimateReason && ['no_resume', 'ai_off', 'ai_unavailable'].includes(peek.estimateReason))) {
      return toCard(peek, user, job, false);
    }
    const view = await withCredit(
      { userId, bucket: 'fit_analysis', idempotencyKey, refType: 'ra_job', refId: jobId, brand: brandOf().id },
      async () => {
        let v: MatchFitView;
        try {
          v = await scoreJob(userId, jobId, { ...base, mode: 'paid', onAiFailure: 'throw' });
        } catch (err) {
          if (err instanceof ScorerFailedError) throw new HttpError('ai_unavailable', 'The fit analysis could not be written right now. Nothing was charged.');
          throw err;
        }
        if (v.kind !== 'ai') throw new HttpError('ai_unavailable', 'The fit analysis could not be written right now. Nothing was charged.');
        return v;
      },
    );
    return toCard(view, user, job, true);
  }

  async function keywordCheck(userId: string, jobId: string, options: { resumeVariantId?: string | null } = {}): Promise<KeywordCheckResponse> {
    const jobRow = await loadVisibleJob(userId, jobId);
    const [{ user, resume }, keywords] = await Promise.all([userContext(userId, options.resumeVariantId), repo.getKeywords(jobId)]);
    const rows = buildKeywordRows({
      job: { ...toMatchJob(jobRow), minYears: jobRow.minYears },
      user,
      resumeText: resume?.resumeMarkdown ?? '',
      keywords,
    });
    return { jobId, resumeVariantId: resume?.id ?? null, rows, asOf: now().toISOString() };
  }

  return {
    fits: {
      getFit: (userId, jobId, opts) => fitOne(userId, jobId, callOptions(opts, null)),
      getFits: fitMany,
      getVariantFit: (userId, jobId, variantId, opts) => fitOne(userId, jobId, callOptions(opts, variantId)),
    },
    scoreJob,
    preScoreMany,
    preScoreJobs,
    fitAnalysis,
    keywordCheck,
    async userContext(userId) {
      const { user, resume } = await userContext(userId);
      return { user, resume };
    },
    config,
    async calibrationMap() {
      return (await fitConfig()).map;
    },
  };
}
