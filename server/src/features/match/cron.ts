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
//   2. pre-score recent candidate jobs from their active search profile;
//   3. queue `job.score` for the best pre-scores that have no fresh AI score.
// The brand's daily budget (brandEnv SCORE_DAILY_BUDGET, default 20,000) is
// checked here (skip when spent) and charged per model call by the worker.
// The AI score is a platform cost, never a user credit.

import crypto from 'node:crypto';
import type { RateLimitResult, RateWindow } from '../../platform/ratelimit/index.js';
import type { CronResult, CronTask, EnqueueOptions, EnqueuedItem } from '../../platform/queue/index.js';
import { SCORER_PROMPT_VERSION } from './contract.js';
import {
  PRECOMPUTE_ACTIVE_DAYS,
  PRECOMPUTE_CANDIDATES,
  PRECOMPUTE_MAX_USERS,
  PRECOMPUTE_WINDOW_DAYS,
  SCORE_WINDOW_SEC,
  precomputePerUserDay,
  scoreCounterKeys,
  scoreDailyBudget,
} from './config.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
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
  env?: EnvSource;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stop starting a new user when this much budget is left. */
const RESERVE_MS = 5_000;

function dedupeKey(userId: string, jobId: string, resumeHash: string, model: string): string {
  const h = crypto.createHash('sha256').update(`${resumeHash}|${model}|${SCORER_PROMPT_VERSION}`).digest('hex').slice(0, 16);
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
    const since = new Date(ctx.now.getTime() - PRECOMPUTE_WINDOW_DAYS * DAY_MS);
    let processed = 0;
    let enqueued = 0;
    let skippedConsent = 0;

    for (const userId of users) {
      if (ctx.budget.exhausted(RESERVE_MS) || budgetLeft <= 0) break;
      processed += 1;
      const userKey = scoreCounterKeys.precompute(brand.id, userId);
      const userWindow = [{ limit: perUserCap, windowSec: SCORE_WINDOW_SEC }];
      const allowance = (await deps.consume({ key: userKey, windows: userWindow, cost: 0 })).remaining;
      if (allowance <= 0) continue;
      if (!(await deps.aiAllowed(userId))) {
        skippedConsent += 1;
        continue;
      }
      const { user, resume } = await deps.service.userContext(userId);
      if (!resume) continue;
      const candidates = await deps.repo.candidateJobs({
        market: brand.market,
        userId,
        // The active search profile's roles (any level); none → recent jobs of the market.
        filters: user.targetTaxonomyIds.length ? { taxonomyIds: user.targetTaxonomyIds } : null,
        since,
        limit: PRECOMPUTE_CANDIDATES,
      });
      if (!candidates.length) continue;
      const pre = (await deps.service.preScoreJobs(userId, candidates)).filter((p) => p.score !== null);
      pre.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const fresh = await deps.repo.freshAiScoredJobIds({
        userId,
        jobIds: pre.map((p) => p.jobId),
        resumeVariantId: resume.id,
        resumeContentHash: resume.resumeContentHash,
        modelUsed: model,
        promptVersion: SCORER_PROMPT_VERSION,
      });
      const picks = pre.filter((p) => !fresh.has(p.jobId)).slice(0, Math.min(allowance, budgetLeft));
      let queuedForUser = 0;
      for (const p of picks) {
        const item = await deps.enqueue(
          MATCH_WORK_KINDS.jobScore,
          { userId, jobId: p.jobId, resumeVariantId: resume.id },
          { dedupeKey: dedupeKey(userId, p.jobId, resume.resumeContentHash, model), userId, brand: brand.id, priority: 200 },
        );
        if (item.created) queuedForUser += 1;
      }
      if (queuedForUser > 0) {
        await deps.consume({ key: userKey, windows: userWindow, cost: queuedForUser });
        budgetLeft -= queuedForUser;
        enqueued += queuedForUser;
      }
    }
    return { processed, enqueued, skippedConsent };
  };
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
  };
}

/** score-precompute (every 15 min): AI scores within the daily budget (ARCH §4.7). */
export const runScorePrecompute: CronTask = createScorePrecompute(defaultDeps);
