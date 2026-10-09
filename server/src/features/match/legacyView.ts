// server/src/features/match/legacyView.ts
//
// Helpers for the legacy V2 job routes (`server/src/roboapply/v2/routes/
// jobs.ts`) until WP-34's job-detail route replaces them and WP-75 unmounts
// them. The V2 client is frozen (TASK_PLAN §2.1 rule 9), so every change here
// is additive:
//   - `explanation.signals` is no longer synthesized. The key stays (V2 cards
//     read it) but every value is derived from real data or null:
//       scorer v3 rows: skills = the skills component, experience = the
//         title-and-level component, location / salary = the deterministic
//         location and pay checks (met 100 · not met 0 · not stated null);
//       v2 rows: skills = the share of the model's matched keywords (what the
//         route always computed); experience / location / salary = null (they
//         were a copy of the total and two constants).
//   - the score view gains `tier`, `kind`, `dimensions` and `estimateReason`.
//     The legacy route only ever answers AI scores, so `kind` is 'ai' and
//     `estimateReason` null; `dimensions` is the stored scorer v3 breakdown,
//     null on a v2 row (it never had one, and none is invented).
//
// Pure except `legacyAiGate`, which checks the GoApply AI consent and the
// brand LLM-route policy before the legacy route calls a model.

import type { ProductBrand } from '../../platform/brand/registry.js';
import { MatchDimensionsSchema, SCORER_PROMPT_VERSION, type FitTierKey, type MatchDimension } from './contract.js';
import { getMatchTiers, tierFor } from './config.js';
import { defaultScorerRouteAllowed } from './scorerRoute.js';

export interface LegacySignals {
  skills: number | null;
  experience: number | null;
  location: number | null;
  salary: number | null;
}

export interface LegacyScoreExtras {
  tier: FitTierKey | null;
  kind: 'ai';
  dimensions: MatchDimension[] | null;
  estimateReason: null;
}

type RowLike = { score?: unknown; explanation?: unknown; dimensions?: unknown; promptVersion?: unknown; tier?: unknown };

const TIERS = new Set<FitTierKey>(['great', 'good', 'possible', 'unlikely']);

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

/** The scorer v3 breakdown of a row; null for any other row (a v2 row's columns are never trusted). */
export function v3Dimensions(row: RowLike): MatchDimension[] | null {
  if (row.promptVersion !== SCORER_PROMPT_VERSION) return null;
  const parsed = MatchDimensionsSchema.safeParse(row.dimensions);
  return parsed.success ? parsed.data : null;
}

function checkValue(dims: MatchDimension[], met: string, notMet: string): number | null {
  const refs = dims.find((d) => d.key === 'logistics')?.evidence.map((e) => e.ref) ?? [];
  if (refs.includes(met)) return 100;
  if (refs.includes(notMet)) return 0;
  return null;
}

/** Honest legacy `signals` (see the header). */
export function legacySignals(dimensions: MatchDimension[] | null, explanation: unknown): LegacySignals {
  if (dimensions && dimensions.length) {
    const s = (k: MatchDimension['key']) => pct(dimensions.find((d) => d.key === k)?.score ?? null);
    return {
      skills: s('skills'),
      experience: s('title_level'),
      location: checkValue(dimensions, 'location_met', 'location_not_met'),
      salary: checkValue(dimensions, 'pay_met', 'pay_not_met'),
    };
  }
  return { skills: pct(record(record(explanation).signals).skills), experience: null, location: null, salary: null };
}

/** `signals` for a fresh v2 score: the share of the model's matched keywords; nothing else is known. */
export function v2Signals(out: { keywordsMatched?: unknown; keywordsMissing?: unknown }): LegacySignals {
  const matched = Array.isArray(out.keywordsMatched) ? out.keywordsMatched.length : 0;
  const missing = Array.isArray(out.keywordsMissing) ? out.keywordsMissing.length : 0;
  return { skills: matched + missing > 0 ? Math.round((matched / (matched + missing)) * 100) : null, experience: null, location: null, salary: null };
}

/** The legacy `explanation`, with its arrays normalized and honest `signals`. */
export function legacyExplanation(row: RowLike): Record<string, unknown> {
  const exp = record(row.explanation);
  return {
    ...exp,
    strengths: Array.isArray(exp.strengths) ? exp.strengths : [],
    gaps: Array.isArray(exp.gaps) ? exp.gaps : [],
    rationale: typeof exp.rationale === 'string' ? exp.rationale : '',
    signals: legacySignals(v3Dimensions(row), exp),
  };
}

/** The additive fields of the legacy score view. */
export function legacyExtras(row: RowLike, env?: Record<string, string | undefined>): LegacyScoreExtras {
  const stored = typeof row.tier === 'string' && TIERS.has(row.tier as FitTierKey) ? (row.tier as FitTierKey) : null;
  const score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null;
  return { tier: stored ?? tierFor(score, getMatchTiers(env)), kind: 'ai', dimensions: v3Dimensions(row), estimateReason: null };
}

/**
 * May the legacy route call a model for this user now?
 *   'ai_off'         GoApply without the "Use AI" consent (zero model calls);
 *   'ai_unavailable' the brand's LLM policy refuses the model's route (R-13).
 * The consent check uses the request's brand, so RoboApply never reads the DB.
 */
export async function legacyAiGate(
  input: { userId: string; brand: ProductBrand; model: string },
  deps: {
    aiAllowed?: (subject: { id: string; brand: string }) => Promise<boolean>;
    routeAllowed?: (brand: ProductBrand, model: string) => boolean | Promise<boolean>;
  } = {},
): Promise<'ai_off' | 'ai_unavailable' | null> {
  const aiAllowed = deps.aiAllowed ?? (async (subject) => (await import('../../platform/consent/aiAllowed.js')).aiAllowed(subject));
  if (!(await aiAllowed({ id: input.userId, brand: input.brand.id }))) return 'ai_off';
  const routeAllowed = deps.routeAllowed ?? defaultScorerRouteAllowed;
  if (!(await routeAllowed(input.brand, input.model))) return 'ai_unavailable';
  return null;
}
