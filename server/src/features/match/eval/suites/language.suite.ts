// server/src/features/match/eval/suites/language.suite.ts
//
// Language layer (strategy 2.6): the ranking metric per language subset. The
// Traditional Chinese, Simplified Chinese and cross-language subsets must stay
// within 10% relative of the English subset. Subsets are taken across the
// selected markets: en and zh-TW are RoboApply personas, zh-CN GoApply
// personas, cross both (the resume and the pooled postings are in different
// languages).
//
// Career changers are left out, as in the gated ranking value (see
// ranking.suite.ts): their labels turn on what the person wants, not on the
// language, and they are not spread evenly over the subsets. The comparison
// is like with like.

import { loadMarketFixtures } from '../fixtures/load.js';
import { meanOf, rankMarket, type PersonaRanking } from '../fitOrder.js';
import { CAREER_CHANGER_SUBSET, LANGUAGE_GATED_SUBSETS, LANGUAGE_REFERENCE_SUBSET, type GateLayer } from '../gates.js';
import { notBuiltOrThrow, unmeasured, type SuiteContext, type SuiteMeasure } from '../suite.js';

export const name = 'language';
export const layer: GateLayer = 'language';

const SUBSETS: readonly string[] = [LANGUAGE_REFERENCE_SUBSET, ...LANGUAGE_GATED_SUBSETS];
const METRICS = ['ndcg_at_10', 'ndcg_at_20'] as const;

export async function run(ctx: SuiteContext): Promise<SuiteMeasure[]> {
  const rankings: PersonaRanking[] = [];
  let loaded = 0;
  try {
    for (const market of ctx.markets) {
      const fx = loadMarketFixtures(market, ctx.fixturesDir);
      if (!fx) continue;
      loaded += 1;
      rankings.push(...(await rankMarket(fx, ctx.fixturesDir)));
    }
  } catch (err) {
    return SUBSETS.flatMap((subset) => METRICS.map((metric) => notBuiltOrThrow(metric, err, { market: 'all', subset })));
  }
  if (!loaded) return SUBSETS.flatMap((subset) => METRICS.map((metric) => unmeasured(metric, 'no_fixture', 'no fixtures for the selected markets', { market: 'all', subset })));

  const compared = rankings.filter((r) => r.persona.kind !== CAREER_CHANGER_SUBSET);
  const out: SuiteMeasure[] = [];
  for (const subset of SUBSETS) {
    const rows = compared.filter((r) => r.persona.subset === subset);
    for (const metric of METRICS) {
      if (!rows.length) {
        out.push(unmeasured(metric, 'no_fixture', `no ${subset} persona in the selected markets`, { market: 'all', subset }));
        continue;
      }
      const m = meanOf(rows.map((r) => (metric === 'ndcg_at_10' ? r.ndcg10 : r.ndcg20)));
      out.push({ metric, market: 'all', subset, value: m.value, n: m.n, labels: 'constructed' });
    }
  }
  return out;
}
