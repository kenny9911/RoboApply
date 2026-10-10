// server/src/features/match/MatchService.ts
//
// Fit scoring (ARCHITECTURE.md §4.7; TASK_PLAN.md WP-18):
//
//   preScoreMany / preScoreJobs  deterministic "Quick estimate" (feed, extension); no LLM
//   scoreJob                     scorer v3 behind the cache; platform-paid, 80/day/user and a
//                                brand budget, beyond either the pre-score with its reason
//   fitAnalysis                  the structured card; spends a `fit_analysis` credit only
//                                when a model call is actually needed
//   keywordCheck                 requirement rows (title, years, education, skills, keywords)
//
// Rules this file enforces:
//   - The server computes the total: the model judges four components; the
//     fifth (location, pay and visa) is deterministic; weights renormalize
//     over the components that are stated.
//   - Evidence that is not a verbatim substring of the resume or the posting
//     is dropped (CitationGuard).
//   - `aiAllowed(user)` is checked before any model call. When false (GoApply
//     without the "Use AI" consent) nothing is sent to a model: the answer is
//     the pre-score labelled "Quick estimate".
//   - Cache key (user, job, resume variant) + resume content hash + model +
//     prompt version. A change in logistics (the user's location/pay/visa
//     answers) recomputes the total without a model call.
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
import {
  MATCH_ERROR_CODES,
  MatchDimensionsSchema,
  SCORER_PROMPT_VERSION,
  type EstimateReason,
  type FitAnalysisCard,
  type KeywordCheckResponse,
  type MatchDimension,
  type MatchFitView,
  type MatchTiers,
  type MatchWeights,
  type PreScoreResult,
} from './contract.js';
import {
  ON_DEMAND_SCORE_CAP_PER_DAY,
  SCORE_WINDOW_SEC,
  getMatchTiers,
  getMatchWeights,
  scoreCounterKeys,
  scoreDailyBudget,
  tierFor,
} from './config.js';
import { buildMatchUser, postingText, toMatchJob, userNames, type MatchJobRecord } from './context.js';
import { guardEvidence } from './evidence.js';
import { buildKeywordRows } from './keywordRows.js';
import { stripResumeForScoring } from './pii.js';
import { defaultScorerRouteAllowed } from './scorerRoute.js';
import {
  combineDimensions,
  degreeMeets,
  logisticsChecks,
  jobSkillList,
  logisticsDimension,
  mentions,
  normalizeText,
  userShows,
  overlapAndGap,
  preScore,
  splitSkills,
  type MatchJob,
  type MatchUser,
} from './preScore.js';
import { createPrismaMatchRepo, type MatchRepo, type ResumeRecord, type ScoreRecord } from './repo.js';

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
  /** Brand LLM-route policy (R-13) for the resolved model; false → no model call ("Quick estimate"). */
  routeAllowed?: (brand: ProductBrand, model: string) => boolean | Promise<boolean>;
  aiAllowed?: (userId: string) => Promise<boolean>;
  consume?: (input: { key: string; windows: readonly RateWindow[]; cost?: number }) => Promise<RateLimitResult>;
  withCredit?: <T>(opts: ReserveOptions, fn: () => Promise<T>) => Promise<T>;
  profileSnapshot?: (userId: string) => Promise<string | null>;
  costLog?: (input: CostLogInput) => Promise<void>;
  brand?: () => ProductBrand;
  env?: EnvSource;
  now?: () => Date;
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
 * mode to allow postings (R-14): with CN_RECRUITMENT_INFO_MODE=off only the
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
  user: Pick<MatchUser, 'skills' | 'resumeTextNorm'>,
): { keywordsMatched: string[]; keywordsMissing: string[] } {
  const postingNorm = normalizeText(posting);
  const inPost = (t: string) => mentions(postingNorm, t);
  const uniq = (xs: string[]) => xs.map((x) => x.trim()).filter((x, i, a) => x && a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
  const all = uniq([...matched, ...missing]).filter(inPost);
  return {
    keywordsMatched: all.filter((t) => userShows(user, t)),
    keywordsMissing: all.filter((t) => !userShows(user, t)),
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
  scoreJob(userId: string, jobId: string, options?: ScoreOptions): Promise<MatchFitView>;
  preScoreMany(userId: string, jobIds: string[]): Promise<PreScoreResult[]>;
  preScoreJobs(userId: string, jobs: MatchJobRecord[]): Promise<PreScoreResult[]>;
  fitAnalysis(userId: string, jobId: string, idempotencyKey: string, options?: { resumeVariantId?: string | null; locale?: string }): Promise<FitAnalysisCard>;
  keywordCheck(userId: string, jobId: string, options?: { resumeVariantId?: string | null }): Promise<KeywordCheckResponse>;
  /** The user's side of the pre-score (precompute, extension). */
  userContext(userId: string): Promise<{ user: MatchUser; resume: ResumeRecord | null }>;
  config(): { weights: MatchWeights; tiers: MatchTiers };
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
  const config = () => ({ weights: getMatchWeights(deps.env), tiers: getMatchTiers(deps.env) });

  async function userContext(userId: string, variantId?: string | null): Promise<{ user: MatchUser; resume: ResumeRecord | null; names: string[] }> {
    const market = brandOf().market;
    const [inputs, resume] = await Promise.all([repo.getUserInputs(userId, market), repo.getResume(userId, variantId)]);
    if (variantId && !resume) throw new HttpError('not_found', 'Resume not found.', { reason: MATCH_ERROR_CODES.variantNotFound });
    const full = { ...inputs, resumeParsed: resume?.parsedData ?? null };
    const user: MatchUser = { ...buildMatchUser(full, now()), resumeTextNorm: resume ? normalizeText(resume.resumeMarkdown) : null };
    return { user, resume, names: userNames(full) };
  }

  async function loadVisibleJob(userId: string, jobId: string): Promise<MatchJobRecord> {
    const job = await repo.getJob(jobId);
    if (!job || !visibleTo(job, userId, brandOf().market, deps.env)) {
      throw new HttpError('not_found', 'Job not found.', { reason: MATCH_ERROR_CODES.jobNotFound });
    }
    return job;
  }

  function skillsView(user: MatchUser, job: MatchJob): MatchFitView['skills'] {
    const { aligned, missing } = splitSkills(user, job);
    return { aligned, missing, listed: jobSkillList(job).length };
  }

  function preView(pre: PreScoreResult, reason: EstimateReason | null, resumeVariantId: string | null, user: MatchUser, job: MatchJob): MatchFitView {
    return {
      jobId: pre.jobId,
      score: pre.score,
      tier: pre.tier,
      kind: 'pre',
      dimensions: pre.dimensions,
      summary: null,
      strengths: [],
      gaps: [],
      keywordsMatched: [],
      keywordsMissing: [],
      skills: skillsView(user, job),
      topOverlap: pre.topOverlap,
      topGap: pre.topGap,
      scoredAt: now().toISOString(),
      resumeVariantId,
      estimateReason: reason,
      summaryLocaleStale: false,
      cached: false,
    };
  }

  /** Re-apply current weights and the current deterministic logistics to stored AI components. */
  function refreshDimensions(stored: MatchDimension[], user: MatchUser, job: MatchJob, weights: MatchWeights): MatchDimension[] {
    const logistics = logisticsDimension(user, job, weights);
    return stored.map((d) => (d.key === 'logistics' ? logistics : { ...d, weight: weights[d.key] }));
  }

  function aiView(row: ScoreRecord, dims: MatchDimension[], score: number | null, user: MatchUser, job: MatchJob, locale: string, cached: boolean): MatchFitView {
    const exp = readExplanation(row.explanation);
    const { topOverlap, topGap } = overlapAndGap(user, job);
    return {
      jobId: row.jobId,
      score,
      tier: tierFor(score, config().tiers),
      kind: 'ai',
      dimensions: dims,
      summary: exp.rationale || null,
      strengths: exp.strengths,
      gaps: exp.gaps,
      keywordsMatched: exp.keywordsMatched,
      keywordsMissing: exp.keywordsMissing,
      skills: skillsView(user, job),
      topOverlap: topOverlap ?? exp.strengths[0] ?? null,
      topGap: topGap ?? exp.gaps[0] ?? null,
      scoredAt: row.generatedAt.toISOString(),
      resumeVariantId: row.resumeVariantId,
      estimateReason: null,
      summaryLocaleStale: (row.locale ?? exp.responseLanguage ?? 'en') !== locale,
      cached,
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

  async function scoreJob(userId: string, jobId: string, options: ScoreOptions = {}): Promise<MatchFitView> {
    const mode = options.mode ?? 'on_demand';
    const locale = options.locale ?? 'en';
    const brand = brandOf();
    const { weights, tiers } = config();
    const jobRow = await loadVisibleJob(userId, jobId);
    const { user, resume, names } = await userContext(userId, options.resumeVariantId);
    const job = toMatchJob(jobRow);
    const pre = preScore(user, job, { weights, tiers });

    if (!resume) return preView(pre, 'no_resume', null, user, job);
    // GoApply "Use AI" consent (and any future per-user AI gate): no model call at all.
    if (!(await isAiAllowed(userId))) return preView(pre, 'ai_off', resume.id, user, job);
    const model = await resolveModel(brand);
    if (!model) return preView(pre, 'ai_unavailable', resume.id, user, job);

    const existing = await repo.getScore(userId, jobId, resume.id);
    const parsedDims = existing ? MatchDimensionsSchema.safeParse(existing.dimensions) : null;
    const fresh =
      !!existing &&
      existing.promptVersion === SCORER_PROMPT_VERSION &&
      existing.resumeContentHashAtScore === resume.resumeContentHash &&
      existing.modelUsed === model &&
      !!parsedDims?.success;

    if (fresh && existing && parsedDims?.success) {
      const dims = refreshDimensions(parsedDims.data, user, job, weights);
      const total = combineDimensions(dims);
      const exp = readExplanation(existing.explanation);
      const localeOk = (existing.locale ?? exp.responseLanguage ?? 'en') === locale;
      const wantsProse = !localeOk && options.regenerateExplanation === true;
      if (mode === 'cache_only' || (!options.force && !wantsProse)) {
        let row = existing;
        // Logistics or weights changed since the score: recompute the total, no model call.
        if (total !== null && (total !== existing.score || existing.searchProfileVersion !== user.searchProfileVersion)) {
          row = await repo.saveScore({
            ...existing,
            score: total,
            tier: tierFor(total, tiers),
            dimensions: dims,
            searchProfileVersion: user.searchProfileVersion,
            generatedAt: existing.generatedAt,
          });
        }
        return aiView(row, dims, total, user, job, locale, true);
      }
    }
    if (mode === 'cache_only') return preView(pre, null, resume.id, user, job);

    const capped = await underCaps(userId, mode, brand);
    if (capped) return preView(pre, capped, resume.id, user, job);

    // ── Model call ──
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
          logistics: { score: pre.dimensions.find((d) => d.key === 'logistics')?.score ?? null, lines: logisticsLines(user, job) },
          targets: { titles: user.targetTitles, seniority: user.targetSeniority },
        },
        { locale, model },
      );
    } catch (err) {
      logger.warn('MATCH', 'scorer v3 failed', { userId, jobId, error: err instanceof Error ? err.message : String(err) });
      if (options.onAiFailure === 'throw') throw new ScorerFailedError(err);
      return preView(pre, 'ai_failed', resume.id, user, job);
    }

    // CitationGuard against the text the model actually saw.
    const sources = { resume: resumeForModel, posting };
    const logistics = logisticsDimension(user, job, weights);
    const dims: MatchDimension[] = (['title_level', 'skills', 'industry', 'logistics', 'career_path'] as const).map((key) => {
      if (key === 'logistics') return logistics;
      const d = out.dimensions[key];
      const score = d.score;
      return {
        key,
        weight: weights[key],
        score,
        status: score === null ? 'not_stated' : 'scored',
        evidence: guardEvidence(d.evidence, sources),
      } satisfies MatchDimension;
    });
    const total = combineDimensions(dims);
    if (total === null) return preView(pre, 'ai_failed', resume.id, user, job);

    const reason = !existing
      ? 'first_score'
      : existing.promptVersion !== SCORER_PROMPT_VERSION
        ? 'prompt_changed'
        : existing.resumeContentHashAtScore !== resume.resumeContentHash
          ? 'resume_changed'
          : existing.modelUsed !== model
            ? 'model_changed'
            : options.force
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
        responseLanguage: locale,
        promptVersion: SCORER_PROMPT_VERSION,
      },
      resumeContentHashAtScore: resume.resumeContentHash,
      modelUsed: model,
      scoreKind: 'ai',
      tier: tierFor(total, tiers),
      dimensions: dims,
      promptVersion: SCORER_PROMPT_VERSION,
      locale,
      searchProfileVersion: user.searchProfileVersion,
      generatedAt: now(),
    });
    if (resume.targetJobId === jobId) {
      await repo.updateVariantCachedScore(resume.id, total).catch(() => undefined);
    }
    await costLog({ userId, jobId, resumeVariantId: resume.id, reason, mode });
    return aiView(saved, dims, total, user, job, locale, false);
  }

  async function preScoreJobs(userId: string, jobs: MatchJobRecord[]): Promise<PreScoreResult[]> {
    const market = brandOf().market;
    const visible = jobs.filter((j) => visibleTo(j, userId, market, deps.env));
    if (!visible.length) return [];
    const { user } = await userContext(userId);
    const cfg = config();
    return visible.map((j) => preScore(user, toMatchJob(j), cfg));
  }

  async function preScoreMany(userId: string, jobIds: string[]): Promise<PreScoreResult[]> {
    const ids = [...new Set(jobIds)].slice(0, 500);
    if (!ids.length) return [];
    const rows = await repo.getJobs(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return preScoreJobs(userId, ids.map((id) => byId.get(id)).filter((r): r is MatchJobRecord => !!r));
  }

  function toCard(view: MatchFitView, user: MatchUser, job: MatchJob, charged: boolean): FitAnalysisCard {
    const ai = view.kind === 'ai';
    return {
      jobId: view.jobId,
      score: view.score,
      tier: view.tier,
      kind: view.kind,
      dimensions: view.dimensions,
      skills: skillsView(user, job),
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
  };
}
