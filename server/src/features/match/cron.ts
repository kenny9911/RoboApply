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
//   2. pre-score the candidate jobs the feed would list for them (the feed's
//      `preview` seam: their active search with the feed's own filters, order
//      and visibility rules), so AI scores land on the jobs they will see;
//   3. queue `job.score` for the best pre-scores that have no fresh AI score.
//      Fresh means written for this resume content AND by the pinned model and
//      prompt AND for the posting as it is now: a row of an earlier model, an
//      earlier prompt or an earlier version of the posting is picked again.
//      That is the planned backfill after a version or posting change (I7);
//      until its turn comes the old row keeps serving, flagged stale.
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

import crypto from 'node:crypto';
import type { RateLimitResult, RateWindow } from '../../platform/ratelimit/index.js';
import type { CronResult, CronTask, EnqueueOptions, EnqueuedItem } from '../../platform/queue/index.js';
import { calibrationFor, type CalibrationRefreshResult } from './calibration.js';
import { SCORER_PROMPT_VERSION } from './contract.js';
import { currentJobHash } from './jobHash.js';
import {
  PRECOMPUTE_ACTIVE_DAYS,
  PRECOMPUTE_CANDIDATES,
  PRECOMPUTE_MAX_USERS,
  SCORE_WINDOW_SEC,
  precomputePerUserDay,
  scoreCounterKeys,
  scoreDailyBudget,
} from './config.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { defaultScorerRouteAllowed } from './scorerRoute.js';
import type { MatchService } from './MatchService.js';
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
function dedupeKey(userId: string, jobId: string, resumeHash: string, model: string, jobHash: string): string {
  const h = crypto.createHash('sha256').update(`${resumeHash}|${model}|${SCORER_PROMPT_VERSION}|${jobHash}`).digest('hex').slice(0, 16);
  return `job.score:${userId}:${jobId}:${h}`;
}

export function createScorePrecompute(getDeps: () => Promise<PrecomputeDeps>): CronTask {
  return async (ctx): Promise<CronResult> => {
    const deps = await getDeps();
    const brand = ctx.brand;
    const model = await deps.resolveModel();
    // No model, or one this brand may not send user data to (GoApply → domestic only).
    if (!model || !(await (deps.routeAllowed ?? defaultScorerRouteAllowed)(brand, model))) return { skipped: 'ai_unavailable' };

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
      const candidates = ids.map((id) => rows.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
      if (!candidates.length) return 0;
      const pre = (await deps.service.preScoreJobs(userId, candidates)).filter((p) => p.score !== null);
      pre.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const jobHashes = new Map(candidates.map((r) => [r.id, currentJobHash(r)]));
      // Fresh = this resume, the pinned model and prompt, the posting as it is now. Anything else is re-scored here.
      const fresh = await deps.repo.freshAiScoredJobIds({
        userId,
        jobIds: pre.map((p) => p.jobId),
        resumeVariantId: resume.id,
        resumeContentHash: resume.resumeContentHash,
        modelUsed: model,
        promptVersion: SCORER_PROMPT_VERSION,
        jobContentHashes: jobHashes,
      });
      const picks = pre.filter((p) => !fresh.has(p.jobId)).slice(0, Math.min(allowance, budgetLeft));
      let queuedForUser = 0;
      try {
        for (const p of picks) {
          const item = await deps.enqueue(
            MATCH_WORK_KINDS.jobScore,
            { userId, jobId: p.jobId, resumeVariantId: resume.id },
            { dedupeKey: dedupeKey(userId, p.jobId, resume.resumeContentHash, model, jobHashes.get(p.jobId) ?? ''), userId, brand: brand.id, priority: 200 },
          );
          if (item.created) queuedForUser += 1;
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

/**
 * score-precompute as the cron runs it: the precompute task, then the
 * calibration refresh. Both results are reported; `calibration` sits next to
 * the precompute fields.
 */
export function composeScorePrecompute(precompute: CronTask, calibration: ReturnType<typeof createCalibrationRefresh>): CronTask {
  return async (ctx): Promise<CronResult> => {
    const result = await precompute(ctx);
    return { ...result, calibration: await calibration(ctx) };
  };
}

async function defaultCalibrationDeps(): Promise<CalibrationStepDeps> {
  const { defaultMatchRepo } = await import('./defaultService.js');
  const calibration = calibrationFor(defaultMatchRepo);
  return { refreshIfDue: (market, now) => calibration.refreshIfDue(market, now) };
}

/** Kept for callers that refresh outside the cron (an admin action, a script): the calibration step on its own. */
export const refreshCalibrationIfDue = createCalibrationRefresh(defaultCalibrationDeps);

/** score-precompute (every 15 min): AI scores within the daily budget (ARCH §4.7), then the calibration refresh. */
export const runScorePrecompute: CronTask = composeScorePrecompute(createScorePrecompute(defaultDeps), refreshCalibrationIfDue);
