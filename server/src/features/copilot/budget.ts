// server/src/features/copilot/budget.ts — the Assistant's daily model budget
// per brand (ARCH §5.6; TASK_PLAN WP-50).
//
// `brandEnv(brand, 'COPILOT_DAILY_BUDGET_USD')` (RoboApply: COPILOT_DAILY_BUDGET_USD,
// GoApply: CN_COPILOT_DAILY_BUDGET_USD, no fallback between them). Spend is
// counted in micro-dollars in RARateCounter (one fixed UTC-day window per
// brand, the same table as the rate limits). When the day's spend reaches the
// budget, new turns are refused before any model call and nothing is charged.
// Unset or invalid → DEFAULT_COPILOT_DAILY_BUDGET_USD.

import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId } from '../../platform/brand/registry.js';
import { DAY, consumeRateLimit, type RateLimitResult, type RateWindow } from '../../platform/ratelimit/index.js';

export const DEFAULT_COPILOT_DAILY_BUDGET_USD = 50;
const MICRO = 1_000_000;

export function copilotDailyBudgetUsd(brand: BrandId, env: EnvSource = process.env): number {
  const raw = brandEnv(brand, 'COPILOT_DAILY_BUDGET_USD', env);
  const n = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COPILOT_DAILY_BUDGET_USD;
}

export const budgetKey = (brand: BrandId) => `budget:llm:copilot:usd_micro:${brand}`;

export interface CopilotBudget {
  /** True when today's spend has reached the brand's budget. */
  exhausted(brand: BrandId): Promise<boolean>;
  /** Add a turn's model cost (USD). */
  spend(brand: BrandId, usd: number): Promise<void>;
}

type Consume = (input: { key: string; windows: readonly RateWindow[]; cost?: number }) => Promise<RateLimitResult>;

export function createCopilotBudget(options: { env?: EnvSource; consume?: Consume } = {}): CopilotBudget {
  const consume: Consume = options.consume ?? ((input) => consumeRateLimit(input));
  const windows = (brand: BrandId): RateWindow[] => [{ limit: Math.round(copilotDailyBudgetUsd(brand, options.env ?? process.env) * MICRO), windowSec: DAY }];
  return {
    async exhausted(brand) {
      const w = windows(brand);
      // cost 0 reads the current window without adding to it.
      const res = await consume({ key: budgetKey(brand), windows: w, cost: 0 });
      const count = res.windows[0]?.count ?? 0;
      return count >= w[0]!.limit;
    },
    async spend(brand, usd) {
      const micro = Math.max(0, Math.round(usd * MICRO));
      if (micro === 0) return;
      await consume({ key: budgetKey(brand), windows: windows(brand), cost: micro });
    },
  };
}
