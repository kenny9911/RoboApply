// server/src/features/admin/limits.ts — the daily limits the System panel
// compares usage against, and the RARateCounter keys that count the usage.
//
// The owning areas do not export these readers from their index.ts yet
// (match/config.ts `scoreDailyBudget`, copilot/budget.ts
// `copilotDailyBudgetUsd`, jobs/ingest/config.ts `dailyCallLimit`), and a
// feature area may only import another area's index.ts or contract.ts
// (boundary.test.ts). So the readers are mirrored here with the same env
// names and defaults; `__tests__/services.test.ts` ("limits mirror the owning
// areas") imports the originals and fails on any drift. Handoff request: export them from the areas' index
// files, then import them here and delete the mirrors.

import { brandEnv, type BrandId, type EnvSource } from '../../platform/brand/index.js';
import { enrichDailyLimit } from '../jobs/enrich/index.js';

export { enrichDailyLimit };

/** match/config.ts DEFAULT_SCORE_DAILY_BUDGET. */
export const DEFAULT_SCORE_DAILY_BUDGET = 20_000;
/** copilot/budget.ts DEFAULT_COPILOT_DAILY_BUDGET_USD. */
export const DEFAULT_COPILOT_DAILY_BUDGET_USD = 50;
/** jobs/ingest/config.ts DEFAULT_DAILY_CALLS. */
export const DEFAULT_PROVIDER_DAILY_CALLS: Readonly<Record<string, number>> = { activejobs: 300, linkedin: 150, jsearch: 200 };

function positiveInt(raw: string | null | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** AI scores a brand may run per day (`SCORE_DAILY_BUDGET` / `CN_SCORE_DAILY_BUDGET`). */
export function scoreDailyBudget(brand: BrandId, env: EnvSource = process.env): number {
  return positiveInt(brandEnv(brand, 'SCORE_DAILY_BUDGET', env), DEFAULT_SCORE_DAILY_BUDGET);
}

/** The Assistant's daily model budget in USD (`COPILOT_DAILY_BUDGET_USD` / `CN_COPILOT_DAILY_BUDGET_USD`). */
export function copilotDailyBudgetUsd(brand: BrandId, env: EnvSource = process.env): number {
  const raw = brandEnv(brand, 'COPILOT_DAILY_BUDGET_USD', env);
  const n = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COPILOT_DAILY_BUDGET_USD;
}

/** `INGEST_<PROVIDER>_DAILY_CALLS`, else the default; null = not metered. */
export function providerDailyCallLimit(provider: string, env: EnvSource = process.env): number | null {
  const fallback = DEFAULT_PROVIDER_DAILY_CALLS[provider];
  const raw = env[`INGEST_${provider.toUpperCase()}_DAILY_CALLS`]?.trim();
  if (fallback === undefined && !raw) return null;
  if (!raw) return fallback ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : (fallback ?? 0);
}

/** RARateCounter keys (one fixed UTC-day window each). */
export const BUDGET_COUNTER_KEYS = {
  enrich: (market: string) => `budget:llm:enrich:${market}`,
  score: (brand: string) => `budget:llm:score:${brand}`,
} as const;
