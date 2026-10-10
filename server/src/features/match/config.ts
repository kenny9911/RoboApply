// server/src/features/match/config.ts
//
// Fit-scoring configuration (ARCHITECTURE.md §4.7; TASK_PLAN.md R-09, WP-18).
// Every value has a safe default; env overrides are validated and ignored
// (with the default kept) when malformed, so a typo never zeroes the scores.
//
//   MATCH_WEIGHTS                  JSON {title_level, skills, industry, logistics, career_path} (35/30/15/10/10)
//   MATCH_TIERS                    JSON {great, good, possible} (80/65/45; great > good > possible)
//   SCORE_DAILY_BUDGET / CN_…      AI scores per brand per day, platform-paid (20,000; brandEnv, no fallback)
//   SCORE_PRECOMPUTE_PER_USER_DAY  AI scores the precompute cron may queue per user per day (25)

import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';
import { DAY } from '../../platform/ratelimit/defaults.js';
import {
  DEFAULT_MATCH_TIERS,
  DEFAULT_MATCH_WEIGHTS,
  MATCH_DIMENSION_KEYS,
  tierForScore,
  type FitTierKey,
  type MatchTiers,
  type MatchWeights,
} from './contract.js';

/** On-demand AI scores per user per day (job detail); beyond it the "Quick estimate". */
export const ON_DEMAND_SCORE_CAP_PER_DAY = 80;
export const DEFAULT_SCORE_DAILY_BUDGET = 20_000;
export const DEFAULT_PRECOMPUTE_PER_USER_DAY = 25;
/** Precompute considers users active in the last N days. */
export const PRECOMPUTE_ACTIVE_DAYS = 7;
/** Users looked at per cron run per brand (most recent first). */
export const PRECOMPUTE_MAX_USERS = 200;
/** Candidate jobs per user: the top of their feed (the feed preview seam lists at most 50). */
export const PRECOMPUTE_CANDIDATES = 50;

export const SCORE_WINDOW_SEC = DAY;

function parseJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** MATCH_WEIGHTS: every key a finite number ≥ 0 and at least one > 0; else the defaults. */
export function getMatchWeights(env: EnvSource = process.env): MatchWeights {
  const parsed = parseJson(env.MATCH_WEIGHTS);
  if (!parsed) return { ...DEFAULT_MATCH_WEIGHTS };
  const out = { ...DEFAULT_MATCH_WEIGHTS } as MatchWeights;
  for (const key of MATCH_DIMENSION_KEYS) {
    if (!(key in parsed)) continue;
    const n = Number(parsed[key]);
    if (!Number.isFinite(n) || n < 0) return { ...DEFAULT_MATCH_WEIGHTS };
    out[key] = n;
  }
  if (MATCH_DIMENSION_KEYS.every((k) => out[k] === 0)) return { ...DEFAULT_MATCH_WEIGHTS };
  return out;
}

/** MATCH_TIERS: 0 ≤ possible < good < great ≤ 100; else the defaults. */
export function getMatchTiers(env: EnvSource = process.env): MatchTiers {
  const parsed = parseJson(env.MATCH_TIERS);
  if (!parsed) return { ...DEFAULT_MATCH_TIERS };
  const t = {
    great: Number(parsed.great ?? DEFAULT_MATCH_TIERS.great),
    good: Number(parsed.good ?? DEFAULT_MATCH_TIERS.good),
    possible: Number(parsed.possible ?? DEFAULT_MATCH_TIERS.possible),
  };
  const valid =
    [t.great, t.good, t.possible].every((n) => Number.isFinite(n)) && t.possible >= 0 && t.possible < t.good && t.good < t.great && t.great <= 100;
  return valid ? t : { ...DEFAULT_MATCH_TIERS };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** AI scores a brand may run per day (brandEnv: `SCORE_DAILY_BUDGET` / `CN_SCORE_DAILY_BUDGET`). */
export function scoreDailyBudget(brand: BrandId | ProductBrand, env: EnvSource = process.env): number {
  return positiveInt(brandEnv(brand, 'SCORE_DAILY_BUDGET', env), DEFAULT_SCORE_DAILY_BUDGET);
}

/** AI scores the precompute cron may queue per user per day. */
export function precomputePerUserDay(env: EnvSource = process.env): number {
  return positiveInt(env.SCORE_PRECOMPUTE_PER_USER_DAY, DEFAULT_PRECOMPUTE_PER_USER_DAY);
}

/** Tier with the configured thresholds; null score → null tier ("—"). */
export function tierFor(score: number | null, tiers: MatchTiers): FitTierKey | null {
  return score === null ? null : tierForScore(score, tiers);
}

/** Counter keys in RARateCounter (one fixed day window each). */
export const scoreCounterKeys = {
  onDemand: (brandId: string, userId: string) => `match:${brandId}:score:user:${userId}`,
  precompute: (brandId: string, userId: string) => `match:${brandId}:precompute:user:${userId}`,
  budget: (brandId: string) => `budget:llm:score:${brandId}`,
};
