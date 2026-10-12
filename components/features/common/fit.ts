// components/features/common/fit.ts — fit tiers on the client (R-09).
//
// Great ≥80 · Good 65–79 · Possible 45–64 · Unlikely <45. The server owns
// the thresholds (`MATCH_TIERS` config, server/src/features/match/contract.ts
// `DEFAULT_MATCH_TIERS`) and sends `tier` with every score; this mirror exists
// only for a score that arrives without one. A parity test keeps the two
// equal (__tests__/shell/primitives.test.tsx).

export type FitTierKey = 'great' | 'good' | 'possible' | 'unlikely';

export const FIT_TIERS: readonly FitTierKey[] = ['great', 'good', 'possible', 'unlikely'];

export const DEFAULT_MATCH_TIERS = { great: 80, good: 65, possible: 45 } as const;

export function tierForScore(
  score: number,
  tiers: { great: number; good: number; possible: number } = DEFAULT_MATCH_TIERS,
): FitTierKey {
  if (score >= tiers.great) return 'great';
  if (score >= tiers.good) return 'good';
  if (score >= tiers.possible) return 'possible';
  return 'unlikely';
}

/** A usable 0–100 score, or null (render "—", never 0). */
export function normalizeScore(score: number | null | undefined): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}
