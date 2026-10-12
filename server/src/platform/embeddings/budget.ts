// server/src/platform/embeddings/budget.ts
//
// The daily embedding budget of a brand, in tokens (MKT-2H; MARKET_TASK_PLAN
// section 5: EMBED_DAILY_TOKENS, default 20,000,000; GoApply may override it
// with CN_EMBED_DAILY_TOKENS). Counted on `RARateCounter` through the platform
// limiter, key `budget:embed:<brand>`, in a UTC-day window, like the
// enrichment and scorer budgets.
//
// The token count of a call is known only after it: `hasRoom` reads the counter
// without spending (cost 0) and `charge` adds what the call used. A counter
// that cannot be read is NOT a spent budget: `hasRoom` throws, the client
// fails the call and the queue retries it with its normal backoff. No request
// is made uncounted, and nobody waits a day for one failed read.

import { brandEnv, type EnvSource } from '../brand/brandEnv.js';
import type { ProductBrand } from '../brand/registry.js';
import { logger } from '../../services/LoggerService.js';

export const DEFAULT_EMBED_DAILY_TOKENS = 20_000_000;
const DAY_SEC = 24 * 60 * 60;

export const embedBudgetKey = (brandId: string): string => `budget:embed:${brandId}`;

/** EMBED_DAILY_TOKENS for the brand; unset or invalid → 20,000,000. 0 switches embedding off. */
export function embedDailyTokens(brand: ProductBrand, env: EnvSource = process.env): number {
  const raw = brandEnv(brand, 'EMBED_DAILY_TOKENS', env);
  if (!raw) return DEFAULT_EMBED_DAILY_TOKENS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_EMBED_DAILY_TOKENS;
}

export interface EmbeddingBudget {
  /** True while the brand has tokens left today; false when the budget is 0 or spent. Throws when the counter cannot be read. */
  hasRoom(brand: ProductBrand, env: EnvSource, now: Date): Promise<boolean>;
  /** Count `tokens` against today's budget. Never throws. */
  charge(brand: ProductBrand, tokens: number, env: EnvSource, now: Date): Promise<void>;
}

/** What the budget needs from the limiter (`consumeRateLimit`). */
export type EmbeddingBudgetConsume = (input: {
  key: string;
  windows: ReadonlyArray<{ limit: number; windowSec: number }>;
  cost: number;
  now: Date;
}) => Promise<{ remaining: number }>;

async function defaultConsume(input: Parameters<EmbeddingBudgetConsume>[0]): Promise<{ remaining: number }> {
  const { consumeRateLimit } = await import('../ratelimit/index.js');
  return consumeRateLimit(input);
}

export function createEmbeddingBudget(consume: EmbeddingBudgetConsume = defaultConsume): EmbeddingBudget {
  return {
    async hasRoom(brand, env, now) {
      const limit = embedDailyTokens(brand, env);
      if (limit <= 0) return false;
      const peek = await consume({ key: embedBudgetKey(brand.id), windows: [{ limit, windowSec: DAY_SEC }], cost: 0, now });
      return peek.remaining > 0;
    },
    async charge(brand, tokens, env, now) {
      const cost = Math.max(0, Math.floor(tokens));
      if (cost === 0) return;
      try {
        await consume({ key: embedBudgetKey(brand.id), windows: [{ limit: embedDailyTokens(brand, env), windowSec: DAY_SEC }], cost, now });
      } catch (err) {
        logger.warn('EMBEDDINGS', 'the embedding budget could not be charged', { brand: brand.id, tokens: cost, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

export const defaultEmbeddingBudget: EmbeddingBudget = createEmbeddingBudget();
