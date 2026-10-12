// server/src/features/match/eval/suites/ranking.suite.ts
//
// Ranking layer (strategy 2.6): NDCG@10 and NDCG@20 of the fit order against
// the constructed labels, per market, through the `getFits` seam. The gate is
// "no regression" against fixtures/baselines.json; without a baseline the
// values are printed and nothing fails.
//
// Career changers are measured and printed on their own rows
// (`ndcg_at_10 [career_changer]`) and are NOT part of the gated value. Their
// labels follow the role the person says they want, and the only place that
// wish reaches the matcher is a Role chip of the saved search. Invariant 2
// says a chip changes no fit, so a fit that is right cannot rank the wanted
// role first, and one that leaks the chip would raise the number. The goal may
// count in the feed order; a suite that measures that order can gate them.

import { loadMarketFixtures } from '../fixtures/load.js';
import { meanOf, rankMarket, type PersonaRanking } from '../fitOrder.js';
import { CAREER_CHANGER_SUBSET, type GateLayer } from '../gates.js';
import { notBuiltOrThrow, unmeasured, type SuiteContext, type SuiteMeasure } from '../suite.js';

export const name = 'ranking';
export const layer: GateLayer = 'ranking';

const METRICS = [
  ['ndcg_at_10', 'ndcg10'],
  ['ndcg_at_20', 'ndcg20'],
] as const;

export const CAREER_CHANGER_NOTE =
  'career changers: the labels follow the role the person wants, which the fit must not read (invariant 2); reported, not gated, until a suite measures the feed order';

function pairsNote(rows: readonly PersonaRanking[]): string {
  const unscored = rows.reduce((s, r) => s + (r.pool - r.scored), 0);
  const pairs = rows.reduce((s, r) => s + r.pool, 0);
  return `${pairs} persona-posting pairs, ${unscored} with no score`;
}

export async function run(ctx: SuiteContext): Promise<SuiteMeasure[]> {
  const out: SuiteMeasure[] = [];
  for (const market of ctx.markets) {
    const fx = loadMarketFixtures(market, ctx.fixturesDir);
    if (!fx) {
      for (const [metric] of METRICS) out.push(unmeasured(metric, 'no_fixture', `no personas, postings or labels for ${market} in fixtures/`, { market }));
      continue;
    }
    try {
      const rankings = await rankMarket(fx, ctx.fixturesDir);
      const gated = rankings.filter((r) => r.persona.kind !== CAREER_CHANGER_SUBSET);
      const changers = rankings.filter((r) => r.persona.kind === CAREER_CHANGER_SUBSET);
      for (const [metric, key] of METRICS) {
        const m = meanOf(gated.map((r) => r[key]));
        out.push({ metric, market, value: m.value, n: m.n, labels: 'constructed', note: `${pairsNote(gated)}; career changers are reported apart` });
      }
      if (changers.length) {
        for (const [metric, key] of METRICS) {
          const m = meanOf(changers.map((r) => r[key]));
          out.push({ metric, market, subset: CAREER_CHANGER_SUBSET, value: m.value, n: m.n, labels: 'constructed', note: CAREER_CHANGER_NOTE });
        }
      }
    } catch (err) {
      for (const [metric] of METRICS) out.push(notBuiltOrThrow(metric, err, { market }));
    }
  }
  return out;
}
