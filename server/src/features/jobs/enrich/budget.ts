// server/src/features/jobs/enrich/budget.ts
//
// Daily LLM budget for enrichment, per market (ARCHITECTURE.md §4.5:
// `ENRICH_DAILY_JOBS`, default 8,000 per market). One unit = one model call.
// Counted on `RARateCounter` through the platform limiter, key
// `budget:llm:enrich:<market>`, in a UTC-day window. A job over budget is
// not dropped: its rule-based parts are written now and the work item is
// deferred until the window resets.

import { DAY, consumeRateLimit, type RateLimitDb } from '../../../platform/ratelimit/index.js';

export const DEFAULT_ENRICH_DAILY_JOBS = 8000;

/** `ENRICH_DAILY_JOBS` (applies to each market separately); invalid or unset → 8,000. 0 disables LLM enrichment. */
export function enrichDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ENRICH_DAILY_JOBS?.trim();
  if (!raw) return DEFAULT_ENRICH_DAILY_JOBS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_ENRICH_DAILY_JOBS;
}

export function enrichBudgetKey(market: string): string {
  return `budget:llm:enrich:${market}`;
}

export interface BudgetDecision {
  allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSec: number;
  limit: number;
}

export type EnrichBudget = (market: string, now: Date) => Promise<BudgetDecision>;

/** Consume one unit of the market's daily budget. */
export function createEnrichBudget(options: { db?: RateLimitDb; env?: Record<string, string | undefined> } = {}): EnrichBudget {
  return async (market, now) => {
    const limit = enrichDailyLimit(options.env);
    if (limit === 0) {
      const next = Math.ceil((Math.floor(now.getTime() / (DAY * 1000)) + 1) * DAY - now.getTime() / 1000);
      return { allowed: false, retryAfterSec: Math.max(1, next), limit };
    }
    const result = await consumeRateLimit({ key: enrichBudgetKey(market), windows: [{ limit, windowSec: DAY }], now, db: options.db });
    return { allowed: result.allowed, retryAfterSec: result.retryAfterSec, limit };
  };
}
