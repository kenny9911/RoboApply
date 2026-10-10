// server/src/features/admin/limits.ts — the daily limits the System panel
// compares usage against, and the RARateCounter keys that count the usage.
//
// The System panel (system.ts) imports everything from here under the names
// the owning areas use: `scoreDailyBudget`, `scoreCounterKeys` (match),
// `copilotDailyBudgetUsd` (copilot), `dailyCallLimit` (jobs/ingest),
// `enrichDailyLimit` (jobs/enrich).
//
// ── Join J3 ─────────────────────────────────────────────────────────────
// A feature area may import another area only through its index.ts
// (boundary.test.ts), and until the INT wave the owners did not export three
// of these readers. Once features/match, features/copilot and
// features/jobs/ingest export them from their index.ts, J3 is:
//
//   1. replace the block between "J3 COPIES — BEGIN" and "J3 COPIES — END"
//      with these three lines:
//
//        export { scoreDailyBudget, scoreCounterKeys } from '../match/index.js';
//        export { copilotDailyBudgetUsd } from '../copilot/index.js';
//        export { dailyCallLimit } from '../jobs/ingest/index.js';
//
//   2. delete the test block "limits mirror the owning areas (J3)" in
//      __tests__/services.test.ts, and the two imports below that only the
//      copies use (`brandEnv`/`BrandId`/`EnvSource`, `IngestProvider`).
//
// Nothing else changes: system.ts already calls the owners' names with the
// owners' signatures. Until then the parity test fails on any drift.

import { brandEnv, type BrandId, type EnvSource } from '../../platform/brand/index.js';
import type { IngestProvider } from '../jobs/ingest/index.js';
import { enrichDailyLimit } from '../jobs/enrich/index.js';

export { enrichDailyLimit };

/**
 * RARateCounter key of the day's enrichment model calls for a market
 * (jobs/enrich/budget.ts `enrichBudgetKey`, which that area's index.ts does
 * not export; not part of J3 — the parity test "enrich counter key" stays).
 */
export const enrichCounterKey = (market: string): string => `budget:llm:enrich:${market}`;

// ── J3 COPIES — BEGIN (same names, signatures, env names and defaults as the owners) ──

/** match/config.ts DEFAULT_SCORE_DAILY_BUDGET. */
export const DEFAULT_SCORE_DAILY_BUDGET = 20_000;
/** copilot/budget.ts DEFAULT_COPILOT_DAILY_BUDGET_USD. */
export const DEFAULT_COPILOT_DAILY_BUDGET_USD = 50;
/** jobs/ingest/config.ts DEFAULT_DAILY_CALLS. */
export const DEFAULT_DAILY_CALLS: Readonly<Partial<Record<IngestProvider, number>>> = { activejobs: 300, linkedin: 150, jsearch: 200 };

function positiveInt(raw: string | null | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** match: AI scores a brand may run per day (`SCORE_DAILY_BUDGET` / `CN_SCORE_DAILY_BUDGET`). */
export function scoreDailyBudget(brand: BrandId, env: EnvSource = process.env): number {
  return positiveInt(brandEnv(brand, 'SCORE_DAILY_BUDGET', env), DEFAULT_SCORE_DAILY_BUDGET);
}

/** match: RARateCounter keys (the System panel reads `budget`). */
export const scoreCounterKeys = {
  onDemand: (brandId: string, userId: string) => `match:${brandId}:score:user:${userId}`,
  precompute: (brandId: string, userId: string) => `match:${brandId}:precompute:user:${userId}`,
  budget: (brandId: string) => `budget:llm:score:${brandId}`,
};

/** copilot: the Assistant's daily model budget in USD (`COPILOT_DAILY_BUDGET_USD` / `CN_COPILOT_DAILY_BUDGET_USD`). */
export function copilotDailyBudgetUsd(brand: BrandId, env: EnvSource = process.env): number {
  const raw = brandEnv(brand, 'COPILOT_DAILY_BUDGET_USD', env);
  const n = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COPILOT_DAILY_BUDGET_USD;
}

/** jobs/ingest: `INGEST_<PROVIDER>_DAILY_CALLS`, else the default; null = not metered. */
export function dailyCallLimit(provider: IngestProvider, env: EnvSource = process.env): number | null {
  const fallback = DEFAULT_DAILY_CALLS[provider];
  const raw = env[`INGEST_${provider.toUpperCase()}_DAILY_CALLS`]?.trim();
  if (fallback === undefined && !raw) return null;
  if (!raw) return fallback ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : (fallback ?? 0);
}

// ── J3 COPIES — END ─────────────────────────────────────────────────────
