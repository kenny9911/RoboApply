// server/src/features/match/cron.ts — score-precompute (every 15 min; WP-18, ARCH §4.7).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and RoboApplyCronService
// (node-cron) inside `runWithBrand(brand, …)` with a 240 s budget. For users of
// the brand active in the last 7 days (most recent first):
//   0. skip the run when no scorer model is configured or the brand's LLM
//      policy refuses its route (R-13: GoApply sends nothing abroad);
//   1. skip users without AI consent (GoApply `aiAllowed=false`: zero model
//      calls), without a resume, or whose per-user precompute allowance
//      (SCORE_PRECOMPUTE_PER_USER_DAY, default 25) is spent;
//   2. read the candidate jobs the feed lists first for them (the feed's
//      `preview` seam: their active search with the feed's own filters, its
//      fused and ranked order and its visibility rules), so AI scores land on
//      the jobs they will see, in the order they will see them;
//   3. queue `job.score` for those candidates IN THE FEED'S ORDER, skipping
//      only the ones that have a fresh AI score. The list is not sorted again
//      by the estimate: the feed's order already is the best reading of what
//      the person sees first, and the newest candidates of the feed are
//      re-scored first after a version change.
//      Fresh means written for this resume content AND under the current pin
//      (config.ts `currentScorerPin`: the model and the scorer prompt of
//      MATCH_SCORER_RUBRIC) AND for the posting as it is now: a row of an
//      earlier model, an earlier prompt or rubric, or an earlier version of
//      the posting is picked again. That is the planned backfill after a
//      version or posting change (I7): gradual, inside the per-user and brand
//      budgets below, never a bulk invalidation; until its turn comes the old
//      row keeps serving, flagged stale.
//      The walk stops when the person's allowance (and the brand's budget)
//      worth of items was really queued: a candidate whose item already
//      exists (still waiting, or dead after a refused answer) takes no slot,
//      so it cannot keep the candidates behind it from being scored. An item
//      that is DONE while its pair has no fresh score is queued again: its
//      row was replaced since (the rubric or the model was switched and
//      switched back), and the same version key would otherwise block the
//      pair until the finished item is pruned.
// One user's failure (their profile, their search, the feed preview) is
// logged and counted; the run goes on with the next user, so a user whose
// preview throws cannot block everyone behind them run after run.
// The brand's daily budget (brandEnv SCORE_DAILY_BUDGET, default 20,000) is
// checked here (skip when spent) and charged per model call by the worker.
// The AI score is a platform cost, never a user credit.
//
// `runScorePrecompute` is this task followed by the calibration refresh
// (calibration.ts): the estimate-to-AI map weekly and the priors monthly, for
// the brand's market, inside the same time budget. It calls no model. No cron
// entry of its own: the job already runs every 15 minutes.
//
// The third and last step is the retrieval sweep (features/retrieval/sweep.ts,
// MKT-2H): it queues the postings that still need a search document or a
// vector and the people whose vector is out of date, and removes the vectors
// of GoApply users without a live consent. It only enqueues and deletes; the
// embedding runs in the queue workers. Skipped when the time budget is gone.

import crypto from 'node:crypto';
import type { RateLimitResult, RateWindow } from '../../platform/ratelimit/index.js';
import type { CronResult, CronTask, EnqueueOptions, EnqueuedItem } from '../../platform/queue/index.js';
import { calibrationFor, type CalibrationRefreshResult } from './calibration.js';
import { currentJobHash } from './jobHash.js';
import {
  PRECOMPUTE_ACTIVE_DAYS,
  PRECOMPUTE_CANDIDATES,
  PRECOMPUTE_MAX_USERS,
  SCORE_WINDOW_SEC,
  currentScorerPin,
  precomputePerUserDay,
  scoreCounterKeys,
  scoreDailyBudget,
} from './config.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { defaultScorerRouteAllowed } from './scorerRoute.js';
import { visibleTo, type MatchService } from './MatchService.js';
import type { MatchRepo } from './repo.js';
import { MATCH_WORK_KINDS, type JobScorePayload } from './workers.js';

export interface PrecomputeDeps {
  service: MatchService;
  repo: MatchRepo;
  aiAllowed: (userId: string) => Promise<boolean>;
  resolveModel: () => Promise<string | null>;
  /** Brand LLM-route policy (R-13) for the resolved model; default: the real check. */
  routeAllowed?: (brand: ProductBrand, model: string) => boolean | Promise<boolean>;
  consume: (input: { key: string; windows: readonly RateWindow[]; cost?: number }) => Promise<RateLimitResult>;
  enqueue: (kind: string, payload: JobScorePayload, options: EnqueueOptions) => Promise<EnqueuedItem>;
  /**
   * The ids of the jobs the feed lists first for this user (feed `preview`),
   * at most `limit`. Empty for a user whose list is not personalised (GoApply
   * without 个性化推荐: no fit is used or shown, so none is computed) and when
   * the brand may not show postings.
   */
  candidateIds: (userId: string, limit: number, brand: ProductBrand) => Promise<string[]>;
  env?: EnvSource;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stop starting a new user when this much budget is left. */
const RESERVE_MS = 5_000;

/** One queued item per (person, job) and per version of what the score depends on: resume, model, prompt and posting. */
function dedupeKey(userId: string, jobId: string, resumeHash: string, model: string, prompt: string, jobHash: string): string {
  const h = crypto.createHash('sha256').update(`${resumeHash}|${model}|${prompt}|${jobHash}`).digest('hex').slice(0, 16);
  return `job.score:${userId}:${jobId}:${h}`;
}

export function createScorePrecompute(getDeps: () => Promise<PrecomputeDeps>): CronTask {
  return async (ctx): Promise<CronResult> => {
    const deps = await getDeps();
    const brand = ctx.brand;
    const model = await deps.resolveModel();
    // No model, or one this brand may not send user data to (GoApply → domestic only).
    if (!model || !(await (deps.routeAllowed ?? defaultScorerRouteAllowed)(brand, model))) return { skipped: 'ai_unavailable' };
    // The one scorer version of this market. The queued item carries no version: the worker scores with the pin of
    // the moment it runs, so a switch of MATCH_SCORER_RUBRIC between queueing and scoring is honoured.
    const pin = currentScorerPin(brand, model, deps.env);

    // Peek at the brand budget (cost 0 reads the counter without spending).
    const budgetWindow = [{ limit: scoreDailyBudget(brand, deps.env), windowSec: SCORE_WINDOW_SEC }];
    const budget = await deps.consume({ key: scoreCounterKeys.budget(brand.id), windows: budgetWindow, cost: 0 });
    let budgetLeft = budget.remaining;
    if (budgetLeft <= 0) return { skipped: 'budget' };

    const users = await deps.repo.activeUsers(brand.id, new Date(ctx.now.getTime() - PRECOMPUTE_ACTIVE_DAYS * DAY_MS), PRECOMPUTE_MAX_USERS);
    if (!users.length) return { skipped: 'no_work', processed: 0 };

    const perUserCap = precomputePerUserDay(deps.env);
    let processed = 0;
    let enqueued = 0;
    let skippedConsent = 0;
    let failed = 0;

    /** One user's share of the run: the number of `job.score` items newly queued for them. */
    const queueForUser = async (userId: string): Promise<number> => {
      const userKey = scoreCounterKeys.precompute(brand.id, userId);
      const userWindow = [{ limit: perUserCap, windowSec: SCORE_WINDOW_SEC }];
      const allowance = (await deps.consume({ key: userKey, windows: userWindow, cost: 0 })).remaining;
      if (allowance <= 0) return 0;
      if (!(await deps.aiAllowed(userId))) {
        skippedConsent += 1;
        return 0;
      }
      const { resume } = await deps.service.userContext(userId);
      if (!resume) return 0;
      // Candidates = the feed's own list for this user (no second, narrower query).
      const ids = await deps.candidateIds(userId, PRECOMPUTE_CANDIDATES, brand);
      if (!ids.length) return 0;
      const rows = new Map((await deps.repo.getJobs(ids)).map((r) => [r.id, r]));
      // The feed's own order, one entry per job; a job that is gone, or that this person may not see on this brand, is left out.
      const candidates = [...new Set(ids)]
        .map((id) => rows.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r && visibleTo(r, userId, brand.market, deps.env));
      if (!candidates.length) return 0;
      const jobHashes = new Map(candidates.map((r) => [r.id, currentJobHash(r)]));
      // Fresh = this resume, the pinned model and prompt, the posting as it is now. Anything else is re-scored here.
      const fresh = await deps.repo.freshAiScoredJobIds({
        userId,
        jobIds: candidates.map((r) => r.id),
        resumeVariantId: resume.id,
        resumeContentHash: resume.resumeContentHash,
        modelUsed: model,
        promptVersion: pin.prompt,
        jobContentHashes: jobHashes,
      });
      // A candidate is skipped only when it has a row of the current pin for the posting as it is now. The walk goes
      // down the feed's order until `cap` items were really queued, so an item that already exists takes no slot.
      const cap = Math.min(allowance, budgetLeft);
      let queuedForUser = 0;
      try {
        for (const p of candidates) {
          if (queuedForUser >= cap) break;
          if (fresh.has(p.id)) continue;
          const payload: JobScorePayload = { userId, jobId: p.id, resumeVariantId: resume.id };
          const options: EnqueueOptions = {
            dedupeKey: dedupeKey(userId, p.id, resume.resumeContentHash, model, pin.prompt, jobHashes.get(p.id) ?? ''),
            userId,
            brand: brand.id,
            priority: 200,
          };
          const item = await deps.enqueue(MATCH_WORK_KINDS.jobScore, payload, options);
          if (item.created) {
            queuedForUser += 1;
          } else if (item.status === 'done') {
            // The item of this very version finished, and the pair has no fresh score: the row it wrote was replaced
            // since (a switch of the rubric or the model, and back). Put it back in the queue. A dead item is left
            // alone (its answer was refused, or it failed five times), and so is one that is still waiting.
            const again = await deps.enqueue(MATCH_WORK_KINDS.jobScore, payload, { ...options, onConflict: 'requeue' });
            if (again.status === 'queued') queuedForUser += 1;
          }
        }
      } finally {
        // What was queued is charged even when a later enqueue failed.
        if (queuedForUser > 0) {
          budgetLeft -= queuedForUser;
          enqueued += queuedForUser;
          await deps.consume({ key: userKey, windows: userWindow, cost: queuedForUser });
        }
      }
      return queuedForUser;
    };

    for (const userId of users) {
      if (ctx.budget.exhausted(RESERVE_MS) || budgetLeft <= 0) break;
      processed += 1;
      try {
        await queueForUser(userId);
      } catch (err) {
        failed += 1;
        logger.warn('MATCH_PRECOMPUTE', 'skipped a user whose precompute failed; continuing with the next', {
          brand: brand.id,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { processed, enqueued, skippedConsent, failed };
  };
}

/** Feed `preview` (lazy: the feed area imports MATCH). Runs inside the cron's `runWithBrand`. */
async function defaultCandidateIds(userId: string, limit: number, brand: ProductBrand): Promise<string[]> {
  const { feedService, isFeedPersonalized } = await import('../feed/index.js');
  if (!(await isFeedPersonalized(userId, brand.market))) return [];
  const items = await feedService.preview(userId, { sort: 'recommended', limit });
  return items.map((i) => i.jobId);
}

async function defaultDeps(): Promise<PrecomputeDeps> {
  const [{ defaultMatchService, defaultMatchRepo }, { aiAllowed }, { consumeRateLimit }, queue, agent] = await Promise.all([
    import('./defaultService.js'),
    import('../../platform/consent/aiAllowed.js'),
    import('../../platform/ratelimit/index.js'),
    import('../../platform/queue/index.js'),
    import('../../roboapply/v2/agents/RAJobMatchScorerAgent.js'),
  ]);
  return {
    service: defaultMatchService,
    repo: defaultMatchRepo,
    aiAllowed: (userId) => aiAllowed(userId),
    resolveModel: async () => {
      try {
        return agent.resolvedJobMatchScorerModel();
      } catch {
        return null;
      }
    },
    consume: (input) => consumeRateLimit(input),
    enqueue: (kind, payload, options) => queue.enqueue(kind, payload, options),
    candidateIds: defaultCandidateIds,
  };
}

/** What the calibration step needs: the refresh for one market. */
export interface CalibrationStepDeps {
  refreshIfDue: (market: ProductBrand['market'], now: Date) => Promise<CalibrationRefreshResult>;
}

/**
 * The calibration refresh of the cron's brand market, when it is due (the map
 * weekly, the priors monthly). Skipped when the time budget is nearly spent;
 * a failure is reported, never thrown: it must not fail the precompute run
 * that came before it.
 */
export function createCalibrationRefresh(getDeps: () => Promise<CalibrationStepDeps>) {
  return async (ctx: Parameters<CronTask>[0]): Promise<CalibrationRefreshResult | { skipped: 'no_time' | 'failed' }> => {
    if (ctx.budget.exhausted(RESERVE_MS)) return { skipped: 'no_time' };
    try {
      return await (await getDeps()).refreshIfDue(ctx.brand.market, ctx.now);
    } catch (err) {
      logger.warn('MATCH_CALIBRATION', 'calibration refresh failed; the stored calibration stays in use', {
        brand: ctx.brand.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { skipped: 'failed' };
    }
  };
}

/** What the retrieval step runs: the sweep of features/retrieval for the cron's brand. */
export interface RetrievalSweepStepDeps {
  sweep: (ctx: Parameters<CronTask>[0]) => Promise<Record<string, unknown>>;
}

/**
 * The retrieval sweep as a step of this cron. Skipped when the time budget is
 * nearly spent; a failure is reported, never thrown: it must not fail the
 * steps that came before it.
 */
export function createRetrievalSweepStep(getDeps: () => Promise<RetrievalSweepStepDeps>) {
  return async (ctx: Parameters<CronTask>[0]): Promise<Record<string, unknown>> => {
    if (ctx.budget.exhausted(RESERVE_MS)) return { skipped: 'no_time' };
    try {
      return await (await getDeps()).sweep(ctx);
    } catch (err) {
      logger.warn('RETRIEVAL_SWEEP', 'retrieval sweep failed; the next run tries again', { brand: ctx.brand.id, error: err instanceof Error ? err.message : String(err) });
      return { skipped: 'failed' };
    }
  };
}

/**
 * score-precompute as the cron runs it: the precompute task, then the
 * calibration refresh, then (when given) the retrieval sweep, last. Every
 * result is reported: `calibration` and `retrieval` sit next to the
 * precompute fields.
 */
export function composeScorePrecompute(
  precompute: CronTask,
  calibration: ReturnType<typeof createCalibrationRefresh>,
  retrieval?: ReturnType<typeof createRetrievalSweepStep>,
): CronTask {
  return async (ctx): Promise<CronResult> => {
    const result = await precompute(ctx);
    const withCalibration = { ...result, calibration: await calibration(ctx) };
    return retrieval ? { ...withCalibration, retrieval: await retrieval(ctx) } : withCalibration;
  };
}

async function defaultCalibrationDeps(): Promise<CalibrationStepDeps> {
  const { defaultMatchRepo } = await import('./defaultService.js');
  const calibration = calibrationFor(defaultMatchRepo);
  return { refreshIfDue: (market, now) => calibration.refreshIfDue(market, now) };
}

/** Kept for callers that refresh outside the cron (an admin action, a script): the calibration step on its own. */
export const refreshCalibrationIfDue = createCalibrationRefresh(defaultCalibrationDeps);

/** The sweep of features/retrieval (lazy: that area imports MATCH); who was active comes from this area's repository. */
async function defaultRetrievalSweepDeps(): Promise<RetrievalSweepStepDeps> {
  const [{ runRetrievalSweep }, { defaultMatchRepo }] = await Promise.all([import('../retrieval/index.js'), import('./defaultService.js')]);
  return {
    sweep: async (ctx) => ({ ...(await runRetrievalSweep(ctx, { activeUsers: (brandId, since, limit) => defaultMatchRepo.activeUsers(brandId, since, limit) })) }),
  };
}

/** The retrieval sweep on its own (a script, an admin action). */
export const runRetrievalSweepStep = createRetrievalSweepStep(defaultRetrievalSweepDeps);

/**
 * score-precompute (every 15 min): AI scores within the daily budget (ARCH §4.7), then the calibration refresh, then the
 * retrieval sweep.
 */
export const runScorePrecompute: CronTask = composeScorePrecompute(createScorePrecompute(defaultDeps), refreshCalibrationIfDue, runRetrievalSweepStep);
