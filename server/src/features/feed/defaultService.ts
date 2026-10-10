// server/src/features/feed/defaultService.ts — the process-wide feed service with production deps (WP-32).
//
// Everything heavy is imported lazily (Prisma, the LLM layer, the job-search
// planner), so importing the feed area opens no pool and loads no model client.

import type { Market } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { explainMatch } from '../compliance/index.js';
import type { MarketHookContext, MarketHookJob } from '../jobs/marketHooks.js';
import { matchService } from '../match/index.js';
import { searchProfileService } from '../search/index.js';
import { createFeedQueryService, type FeedServiceDeps } from './FeedQueryService.js';
import type { PlannerPlan } from './filterDiff.js';
import { createPrismaFeedRepo } from './repo.js';

/** RoboApply: always personalised. GoApply: only with a live 个性化推荐 grant (fails closed). */
export async function defaultPersonalized(userId: string, market: Market): Promise<boolean> {
  if (market !== 'cn') return true;
  try {
    const { hasLiveConsent } = await import('../../platform/consent/index.js');
    return await hasLiveConsent(userId, 'personalized_recommendation');
  } catch {
    return false;
  }
}

async function defaultConsumeRefresh(userId: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
  try {
    const { consumeRateLimit, rateLimitKey, rateLimitWindows } = await import('../../platform/ratelimit/index.js');
    const r = await consumeRateLimit({ key: rateLimitKey('feedRefresh', 'user', userId), windows: rateLimitWindows('feedRefresh') });
    return { allowed: r.allowed, retryAfterSec: r.retryAfterSec };
  } catch (err) {
    // The refresh cap is an abuse guard; a counter outage must not take the feed down.
    logger.warn('FEED', 'refresh rate-limit check failed (allowing)', { error: err instanceof Error ? err.message : String(err) });
    return { allowed: true, retryAfterSec: 0 };
  }
}

async function defaultAiAllowed(userId: string): Promise<boolean> {
  const { aiAllowed } = await import('../../platform/consent/aiAllowed.js');
  return aiAllowed(userId);
}

/**
 * The job-search planner (job-search/agent.ts), upgraded for the feed: same
 * prompt and strict plan validation; the call runs through the per-brand LLM
 * layer (GoApply: domestic models + content safety). 20 s budget.
 */
async function defaultPlanner(text: string, ctx: { userId: string; locale: string }): Promise<PlannerPlan> {
  const [{ configuredSearchPlanner }, { parseAgentPlan }] = await Promise.all([import('../../job-search/agent.js'), import('../../job-search/agent-validation.js')]);
  const raw = await configuredSearchPlanner({ request: text, locale: ctx.locale }, { userId: ctx.userId, signal: AbortSignal.timeout(20_000) });
  return parseAgentPlan(raw) as PlannerPlan;
}

/**
 * `marketHooks.cardMeta`, loaded on the first card: the hook modules bring
 * the GoApply fraud classifier and the ATS source adapters with them, which
 * importing the feed does not need.
 */
async function defaultCardMeta(job: MarketHookJob, ctx: MarketHookContext): Promise<Record<string, Record<string, unknown>>> {
  const { cardMeta } = await import('../jobs/marketHooks.js');
  return cardMeta(job, ctx);
}

export function defaultFeedDeps(): FeedServiceDeps {
  return {
    repo: createPrismaFeedRepo(),
    match: matchService,
    search: searchProfileService,
    personalized: defaultPersonalized,
    consumeRefresh: defaultConsumeRefresh,
    aiAllowed: defaultAiAllowed,
    planner: defaultPlanner,
    cardMeta: defaultCardMeta,
    explain: (input) => explainMatch(input),
  };
}

export const defaultFeedQueryService = createFeedQueryService(defaultFeedDeps());
