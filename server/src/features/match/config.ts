// server/src/features/match/config.ts
//
// Fit-scoring configuration (ARCHITECTURE.md §4.7; TASK_PLAN.md R-09, WP-18).
// Every value has a safe default; env overrides are validated and ignored
// (with the default kept) when malformed, so a typo never zeroes the scores.
//
//   MATCH_WEIGHTS                  JSON {title_level, skills, industry, logistics, career_path} (35/30/15/10/10)
//   MATCH_TIERS                    JSON {great, good, possible} (80/65/45; great > good > possible)
//   SCORE_DAILY_BUDGET / CN_…      AI scores per brand per day, platform-paid (20,000). Read per key through
//                                  brandEnv (D5): GoApply uses CN_SCORE_DAILY_BUDGET when set, else the shared
//                                  SCORE_DAILY_BUDGET; each brand still has its own counter.
//   SCORE_PRECOMPUTE_PER_USER_DAY  AI scores the precompute cron may queue per user per day (25)
//   MATCH_PRIORS / CN_…            JSON {title_level, skills, industry, logistics, career_path}: what a component
//                                  the quick estimate cannot compare contributes (44/39/24/50/45). Read through
//                                  brandEnv (D5): GoApply uses CN_MATCH_PRIORS when set, else the shared value.
//   MATCH_CALIBRATION_MIN_PAIRS    (estimate, AI) pairs a market needs before the isotonic map replaces the
//                                  ranking blend (500)
//   MATCH_SCORER_RUBRIC / CN_…     fit_v4 (default) or fit_v3: the rubric the fit scorer writes. fit_v4 is the
//                                  requirement checklist (scorer_v4); fit_v3 is the rollback (four judged
//                                  components, scorer_v3). Read through brandEnv (D5): GoApply uses
//                                  CN_MATCH_SCORER_RUBRIC when set, else the shared value. Any other value keeps
//                                  the default. A change needs no deploy: rows of the other rubric keep serving,
//                                  flagged stale, and the precompute cron replaces them within its budgets (I7).

import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';
import { DAY } from '../../platform/ratelimit/defaults.js';
import {
  DEFAULT_MATCH_PRIORS,
  DEFAULT_MATCH_TIERS,
  DEFAULT_MATCH_WEIGHTS,
  FIT_RUBRIC_BY_PROMPT,
  MATCH_DIMENSION_KEYS,
  tierForScore,
  type FitPromptVersion,
  type FitRubric,
  type FitTierKey,
  type MatchPriors,
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

/**
 * MATCH_PRIORS (GoApply: CN_MATCH_PRIORS, else the shared value): the starting
 * priors of the quick estimate. Every key given must be a finite number from 0
 * to 100; one malformed key keeps the defaults whole, like MATCH_WEIGHTS.
 */
export function getMatchPriors(brand: BrandId | ProductBrand = 'roboapply', env: EnvSource = process.env): MatchPriors {
  const parsed = parseJson(brandEnv(brand, 'MATCH_PRIORS', env));
  if (!parsed) return { ...DEFAULT_MATCH_PRIORS };
  const out = { ...DEFAULT_MATCH_PRIORS } as MatchPriors;
  for (const key of MATCH_DIMENSION_KEYS) {
    if (!(key in parsed)) continue;
    const raw = parsed[key];
    // A number, or a number written as text ("40"); never null, a boolean or an empty string (Number() reads those as 0 or 1).
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ...DEFAULT_MATCH_PRIORS };
    out[key] = n;
  }
  return out;
}

/** (estimate, AI) pairs a market needs before its isotonic map is used (MARKET_STRATEGY 2.4). */
export const DEFAULT_CALIBRATION_MIN_PAIRS = 500;
/** Pairs a market needs before priors computed from its data replace the starting priors. */
export const CALIBRATION_PRIORS_MIN_PAIRS = 200;

/** MATCH_CALIBRATION_MIN_PAIRS: a whole number of at least 1; else 500. */
export function calibrationMinPairs(env: EnvSource = process.env): number {
  const n = positiveInt(env.MATCH_CALIBRATION_MIN_PAIRS, DEFAULT_CALIBRATION_MIN_PAIRS);
  return n >= 1 ? n : DEFAULT_CALIBRATION_MIN_PAIRS;
}

/** The rubric a new fit score is written under when nothing is configured (scorer v4: the requirement checklist). */
export const DEFAULT_SCORER_RUBRIC: FitRubric = 'fit_v4';

/** The scorer prompt that writes each rubric (the inverse of `FIT_RUBRIC_BY_PROMPT`). */
const PROMPT_OF_RUBRIC = Object.fromEntries(Object.entries(FIT_RUBRIC_BY_PROMPT).map(([prompt, rubric]) => [rubric, prompt])) as Record<FitRubric, FitPromptVersion>;

/** The scorer prompt that writes `rubric`. */
export function promptOfRubric(rubric: FitRubric): FitPromptVersion {
  return PROMPT_OF_RUBRIC[rubric];
}

/**
 * MATCH_SCORER_RUBRIC (GoApply: CN_MATCH_SCORER_RUBRIC, else the shared
 * value): `fit_v4` or `fit_v3`. Unset, empty or anything else is `fit_v4`: a
 * typo never switches the scorer.
 */
export function scorerRubric(brand: BrandId | ProductBrand = 'roboapply', env: EnvSource = process.env): FitRubric {
  const raw = (brandEnv(brand, 'MATCH_SCORER_RUBRIC', env) ?? '').trim().toLowerCase();
  return Object.hasOwn(PROMPT_OF_RUBRIC, raw) ? (raw as FitRubric) : DEFAULT_SCORER_RUBRIC;
}

/**
 * The scorer version a brand's fits are pinned to: one model, one prompt and
 * the rubric that prompt writes. One version at a time per market. A stored
 * row written under another model, prompt or rubric keeps serving (flagged
 * stale) until the precompute cron replaces it, newest feed candidates first
 * and inside the existing budgets; a version change is a planned backfill,
 * never a silent cache miss and never a bulk invalidation (I7).
 */
export interface ScorerPin {
  /** The resolved scorer model of the brand, or null when none is configured. */
  model: string | null;
  prompt: FitPromptVersion;
  rubric: FitRubric;
}

/**
 * The pin of a brand. `model` is the scorer model the caller resolved for the
 * brand (LLM_MATCHING_MODEL; GoApply: CN_LLM_MATCHING_MODEL when set, else the
 * shared one; whether the brand may call its route is match/scorerRoute.ts).
 * The rubric is `scorerRubric(brand, env)` and the prompt is the one that
 * writes it.
 */
export function currentScorerPin(brand: BrandId | ProductBrand, model: string | null, env: EnvSource = process.env): ScorerPin {
  const rubric = scorerRubric(brand, env);
  return { model, prompt: promptOfRubric(rubric), rubric };
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
