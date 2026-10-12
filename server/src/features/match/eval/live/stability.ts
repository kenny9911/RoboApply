// server/src/features/match/eval/live/stability.ts
//
// Scorer stability (strategy 2.6): the same pairs scored three times by the
// production scorer; intraclass correlation of the totals and the share of
// pairs whose tier flips between runs. Gate: ICC ≥ 0.85, flips under 5%.
// Measured per market, with that market's scorer model and brand context.
// The scoring function is injected; the default calls the real scorer on a
// synthetic persona's resume and a posting of the snapshot.

import { icc, tierFlipRate, tierOfScore } from '../metrics.js';
import { byPairHash, hash32 } from './audit.js';

export const STABILITY_RUNS = 3;
/** Pairs scored per market (strategy 2.6: "3 runs on 100 pairs"). */
export const STABILITY_PAIRS = 100;

export interface StabilityPair {
  personaId: string;
  postingId: string;
}

/**
 * The pairs of one market the scorer is run on, drawn over ALL its pooled
 * pairs so that every persona is in the sample before any persona is in it
 * twice: personas in a fixed pseudo-random order (the hash of their id), each
 * giving its pairs in a fixed pseudo-random order, one per round, until `max`
 * pairs are drawn. The same draw on every run. Never "the first N in
 * iteration order", which is two personas of one role and one language.
 */
export function stabilitySample<T extends StabilityPair>(pairs: readonly T[], max: number = STABILITY_PAIRS): T[] {
  const byPersona = new Map<string, T[]>();
  for (const p of byPairHash(pairs)) byPersona.set(p.personaId, [...(byPersona.get(p.personaId) ?? []), p]);
  const personas = [...byPersona.keys()].sort((a, b) => hash32(a) - hash32(b) || a.localeCompare(b));
  const out: T[] = [];
  for (let round = 0; out.length < max; round++) {
    let took = false;
    for (const id of personas) {
      const next = byPersona.get(id)![round];
      if (!next) continue;
      took = true;
      out.push(next);
      if (out.length >= max) break;
    }
    if (!took) break;
  }
  return out;
}

export type ScoreOnce = (pair: StabilityPair, run: number) => Promise<number | null>;

export interface StabilityResult {
  icc: number | null;
  tierFlipRate: number | null;
  /** Pairs every run scored. */
  pairs: number;
  runs: number;
  /** Pairs dropped because a run gave no score (a failed call is never counted as a score). */
  dropped: number;
  /** runs[r][i]: the total run r gave pair i (kept pairs only). */
  scores: number[][];
  kept: StabilityPair[];
}

export async function runStability(pairs: readonly StabilityPair[], score: ScoreOnce, options: { runs?: number; maxPairs?: number } = {}): Promise<StabilityResult> {
  const runs = options.runs ?? STABILITY_RUNS;
  const sample = pairs.slice(0, options.maxPairs ?? STABILITY_PAIRS);
  const raw: Array<Array<number | null>> = [];
  for (let r = 0; r < runs; r++) {
    const row: Array<number | null> = [];
    for (const pair of sample) {
      try {
        const s = await score(pair, r);
        row.push(typeof s === 'number' && Number.isFinite(s) ? s : null);
      } catch {
        row.push(null);
      }
    }
    raw.push(row);
  }
  const keep = sample.map((_, i) => raw.every((row) => row[i] !== null));
  const kept = sample.filter((_, i) => keep[i]);
  const scores = raw.map((row) => row.filter((_, i) => keep[i]) as number[]);
  return {
    icc: icc(scores),
    tierFlipRate: tierFlipRate(scores.map((row) => row.map((s) => tierOfScore(s)))),
    pairs: kept.length,
    runs,
    dropped: sample.length - kept.length,
    scores,
    kept,
  };
}
