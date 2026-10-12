// server/src/features/feed/defaultService.ts — the process-wide feed service with production deps (WP-32).
//
// Everything heavy is imported lazily (Prisma, the LLM layer, the job-search
// planner, the embeddings client, the ingest pipeline), so importing the feed
// area opens no pool and loads no model client.

import type { Market } from '../../platform/brand/registry.js';
import { resolveEmbeddingConfig } from '../../platform/embeddings/index.js';
import { logger } from '../../services/LoggerService.js';
import { explainMatch } from '../compliance/index.js';
import type { MarketHookContext, MarketHookJob } from '../jobs/marketHooks.js';
import { getFits, matchService } from '../match/index.js';
import { searchProfileService } from '../search/index.js';
import { createFeedQueryService, type FeedEmbeddings, type FeedRetrieval, type FeedServiceDeps } from './FeedQueryService.js';
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
  const [{ configuredSearchPlanner }, { parseAgentPlan }, { JobSearchValidationError }] = await Promise.all([
    import('../../job-search/agent.js'),
    import('../../job-search/agent-validation.js'),
    import('../../job-search/validation.js'),
  ]);
  const signal = AbortSignal.timeout(20_000);
  const ask = () => configuredSearchPlanner({ request: text, locale: ctx.locale }, { userId: ctx.userId, signal });
  const raw = await ask();
  try {
    return parseAgentPlan(raw) as PlannerPlan;
  } catch (err) {
    // A request that names no role is an answer, not a fault. An answer outside the plan's shape (a field the
    // strict check refuses, broken JSON) is asked for once more, within the same 20 s: one such answer made
    // the sentence search fail with "AI unavailable" (browser pass of HANDOFF step 5).
    if (err instanceof JobSearchValidationError) throw err;
    return parseAgentPlan(await ask()) as PlannerPlan;
  }
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

/**
 * The embeddings client for the vector of a query text (platform/embeddings).
 * `{ unavailable }` when the brand has no key, its route policy refuses the
 * endpoint or the day's budget is spent: the list then runs without the dense
 * leg. A failed call throws; the feed catches it and does the same.
 */
export const defaultFeedEmbeddings: FeedEmbeddings = {
  async embedTexts(brand, texts, options) {
    const { embedTexts } = await import('../../platform/embeddings/index.js');
    return embedTexts(brand, texts, options);
  },
};

/** The stored vectors of features/retrieval, and the tag a new query vector of a brand carries (null: no key). */
export const defaultFeedRetrieval: FeedRetrieval = {
  async currentModelTag(market) {
    const { currentModelTag } = await import('../retrieval/index.js');
    return currentModelTag(market);
  },
  async userVector(userId, market, modelTag) {
    const { userVector } = await import('../retrieval/index.js');
    return userVector(userId, market, modelTag);
  },
  queryModelTag(brandId) {
    try {
      return resolveEmbeddingConfig(brandId === 'goapply' ? 'goapply' : 'roboapply').modelTag;
    } catch {
      return null;
    }
  },
};

/**
 * One targeted ingest for a saved search whose list came back thin: the
 * profile's queries are planned and queued (budget 0: nothing runs inside the
 * request). The pipeline honours every provider budget and the brand's own
 * provider list, so a GoApply request reaches no search provider.
 */
export async function defaultRequestIngest(searchProfileId: string): Promise<void> {
  const { ingestForProfile } = await import('../jobs/ingest/index.js');
  await ingestForProfile(searchProfileId, 0);
}

export function defaultFeedDeps(): FeedServiceDeps {
  return {
    repo: createPrismaFeedRepo(),
    // The fits come from the fit contract's own `getFits` (match/fit.ts), the function every other surface calls.
    match: {
      userContext: (userId) => matchService.userContext(userId),
      config: () => matchService.config(),
      getFits: (userId, jobIds, opts) => getFits(userId, jobIds, opts),
      calibrationMap: () => matchService.calibrationMap(),
    },
    search: searchProfileService,
    personalized: defaultPersonalized,
    consumeRefresh: defaultConsumeRefresh,
    aiAllowed: defaultAiAllowed,
    planner: defaultPlanner,
    cardMeta: defaultCardMeta,
    explain: (input) => explainMatch(input),
    embeddings: defaultFeedEmbeddings,
    retrieval: defaultFeedRetrieval,
    requestIngest: defaultRequestIngest,
  };
}

export const defaultFeedQueryService = createFeedQueryService(defaultFeedDeps());
