// server/src/features/match/eval/fitOrder.ts
//
// The fit order of the synthetic fixtures: for every persona, its pooled
// postings ordered by the canonical fit (`getFits`: the stored AI fit when
// there is one, else the estimate; never a model call), and NDCG@10 / @20 of
// that order against the constructed labels. Shared by the ranking and the
// language suites, so both read one computation.

import type { MarketFixtures } from './fixtures/load.js';
import type { Persona } from './fixtures/schema.js';
import { ndcgAtK } from './metrics.js';
import { fitModuleInUse } from './seams.js';
import { fixtureWorld } from './world.js';

export interface PersonaRanking {
  persona: Persona;
  /** Pooled posting ids, best fit first (no score last; ties by id). */
  ranked: string[];
  ndcg10: number | null;
  ndcg20: number | null;
  /** Pooled postings that got a score. */
  scored: number;
  pool: number;
}

const cache = new Map<string, Promise<PersonaRanking[]>>();

async function compute(fx: MarketFixtures): Promise<PersonaRanking[]> {
  const world = fixtureWorld(fx.market, fx.personas, fx.postings);
  const fit = await world.fit();
  const out: PersonaRanking[] = [];
  for (const persona of fx.personas) {
    const labels = fx.labels.labels[persona.id] ?? {};
    const ids = Object.keys(labels).sort();
    const fits = await fit.getFits(persona.id, ids);
    const scoreOf = (id: string): number | null => {
      const s = fits.get(id)?.score;
      return typeof s === 'number' && Number.isFinite(s) ? s : null;
    };
    const ranked = [...ids].sort((a, b) => {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      if (sa === null && sb === null) return a.localeCompare(b);
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sb - sa || a.localeCompare(b);
    });
    out.push({
      persona,
      ranked,
      ndcg10: ndcgAtK(ranked, labels, 10),
      ndcg20: ndcgAtK(ranked, labels, 20),
      scored: ids.filter((id) => scoreOf(id) !== null).length,
      pool: ids.length,
    });
  }
  return out;
}

/** Rankings of one market's fixtures (computed once per run). Throws `SeamMissing` until `getFits` exists. */
export function rankMarket(fx: MarketFixtures, cacheKey: string): Promise<PersonaRanking[]> {
  // One computation per fixture folder, market and fit module: a stand-in bound by a test never answers for the real one.
  const key = `${cacheKey}:${fx.market}:${fitModuleInUse()}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = compute(fx);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

export function meanOf(values: Array<number | null>): { value: number | null; n: number } {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return { value: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null, n: nums.length };
}
