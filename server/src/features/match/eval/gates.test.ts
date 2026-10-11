// @vitest-environment node
// MKT-1D — the gate table of strategy 2.6 and the one comparison function.
import { describe, expect, it } from 'vitest';
import { CAREER_CHANGER_SUBSET, GATES, GATE_LAYERS, JUDGE_TRUST_MIN_KAPPA, JUDGE_TRUST_MIN_PAIRS, compareWithGate, findGate, gateReads, gateText, gatesOfLayer, judgeDistrust, judgeTrusted, rowStatus, type Gate } from './gates.js';

const gate = (layer: Gate['layer'], metric: string): Gate => {
  const g = findGate(layer, metric);
  if (!g) throw new Error(`no gate ${layer}/${metric}`);
  return g;
};

describe('the gate table (strategy 2.6)', () => {
  it('has at least one gate for every layer', () => {
    for (const layer of GATE_LAYERS) expect(gatesOfLayer(layer).length, layer).toBeGreaterThan(0);
    expect(new Set(GATES.map((g) => g.layer))).toEqual(new Set(GATE_LAYERS));
  });

  it('carries the thresholds of the strategy', () => {
    expect(gate('retrieval', 'recall_at_200_hybrid').rule).toEqual({ kind: 'min_gain', points: 0.15, over: 'recall_at_200_recency' });
    expect(gate('retrieval', 'recall_at_200_worst_persona_delta').rule).toEqual({ kind: 'min', threshold: -0.05 });
    expect(gate('ranking', 'ndcg_at_10').rule.kind).toBe('no_regression');
    expect(gate('ranking', 'ndcg_at_20').rule.kind).toBe('no_regression');
    expect(gate('estimate_vs_ai', 'tier_kappa').rule).toEqual({ kind: 'min', threshold: 0.5 });
    expect(gate('estimate_vs_ai', 'estimate_great_ai_below_possible').rule).toEqual({ kind: 'below', threshold: 0.05 });
    expect(gate('scorer', 'icc_3_runs').rule).toEqual({ kind: 'min', threshold: 0.85 });
    expect(gate('scorer', 'tier_flip_rate').rule).toEqual({ kind: 'below', threshold: 0.05 });
    expect(gate('scorer', 'spearman_human').rule).toEqual({ kind: 'min', threshold: 0.6 });
    expect(gate('taxonomy', 'category_precision').rule).toEqual({ kind: 'min', threshold: 0.95 });
    expect(gate('skills', 'precision_not_shown').rule).toEqual({ kind: 'min', threshold: 0.95 });
    expect(gate('language', 'ndcg_at_10').rule).toEqual({ kind: 'within_relative', share: 0.1, ofSubset: 'en' });
    expect(gate('language', 'ndcg_at_10').subsets).toEqual(['zh-TW', 'zh-CN', 'cross']);
    expect(gate('latency', 'feed_p95_ms').rule).toEqual({ kind: 'max_increase', amount: 150 });
    expect(gate('latency', 'feed_p95_ms').liveOnly).toBe(true);
    expect(JUDGE_TRUST_MIN_KAPPA).toBe(0.6);
  });

  it('has no two gates for one layer and metric', () => {
    const keys = GATES.map((g) => `${g.layer}/${g.metric}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('describes each gate in words', () => {
    for (const g of GATES) expect(gateText(g).length).toBeGreaterThan(3);
    expect(gateText(gate('retrieval', 'recall_at_200_hybrid'))).toBe('>= recall_at_200_recency + 15 points');
    expect(gateText(gate('language', 'ndcg_at_10'))).toBe('within 10% relative of the en subset');
  });
});

describe('compareWithGate', () => {
  it('min: at the threshold passes, under it fails', () => {
    const g = gate('taxonomy', 'category_precision');
    expect(compareWithGate(g, { value: 0.95 }).status).toBe('pass');
    expect(compareWithGate(g, { value: 0.9499 }).status).toBe('fail');
    expect(compareWithGate(g, { value: null }).status).toBe('no_value');
  });

  it('below: "under 5%" is strict', () => {
    const g = gate('estimate_vs_ai', 'estimate_great_ai_below_possible');
    expect(compareWithGate(g, { value: 0.049 }).status).toBe('pass');
    expect(compareWithGate(g, { value: 0.05 }).status).toBe('fail');
  });

  it('the "+15 points" rule compares with the recency-only recall of the same run', () => {
    const g = gate('retrieval', 'recall_at_200_hybrid');
    expect(compareWithGate(g, { value: 0.65, reference: 0.5 })).toEqual({ status: 'pass', bound: 0.65 });
    expect(compareWithGate(g, { value: 0.649, reference: 0.5 }).status).toBe('fail');
    expect(compareWithGate(g, { value: 0.9, reference: 0.5 }).status).toBe('pass');
    expect(compareWithGate(g, { value: 0.9 }).status).toBe('no_reference');
    expect(compareWithGate(g, { value: 0.9, reference: null }).status).toBe('no_reference');
  });

  it('no persona more than 5 points below its baseline', () => {
    const g = gate('retrieval', 'recall_at_200_worst_persona_delta');
    expect(compareWithGate(g, { value: -0.05 }).status).toBe('pass');
    expect(compareWithGate(g, { value: -0.051 }).status).toBe('fail');
    expect(compareWithGate(g, { value: 0.2 }).status).toBe('pass');
  });

  it('no regression: equal to the baseline passes, lower fails, no baseline is not a failure', () => {
    const g = gate('ranking', 'ndcg_at_10');
    expect(compareWithGate(g, { value: 0.8123, reference: 0.8123 }).status).toBe('pass');
    expect(compareWithGate(g, { value: 0.9, reference: 0.8123 }).status).toBe('pass');
    expect(compareWithGate(g, { value: 0.8122, reference: 0.8123 }).status).toBe('fail');
    expect(compareWithGate(g, { value: 0.8 }).status).toBe('no_reference');
  });

  it('the "within 10% relative" rule compares with the English subset', () => {
    const g = gate('language', 'ndcg_at_10');
    expect(compareWithGate(g, { value: 0.72, reference: 0.8 })).toEqual({ status: 'pass', bound: 0.8 * 0.9 });
    expect(compareWithGate(g, { value: 0.719, reference: 0.8 }).status).toBe('fail');
    // A subset that does better than English is not a failure: the gate guards against a loss.
    expect(compareWithGate(g, { value: 0.95, reference: 0.8 }).status).toBe('pass');
    expect(compareWithGate(g, { value: 0.7 }).status).toBe('no_reference');
  });

  it('latency: baseline + 150 ms', () => {
    const g = gate('latency', 'feed_p95_ms');
    expect(compareWithGate(g, { value: 550, reference: 400 }).status).toBe('pass');
    expect(compareWithGate(g, { value: 551, reference: 400 }).status).toBe('fail');
  });
});

describe('judge trust and row status', () => {
  const audit = { kappa: 0.7, pairs: 80, judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: { intl: 50, cn: 30 } };
  const use = { judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', market: 'intl' };

  it('the agreement itself: kappa 0.6 or better on enough graded pairs', () => {
    expect(JUDGE_TRUST_MIN_PAIRS).toBe(30);
    expect(judgeTrusted(null)).toBe(false);
    expect(judgeTrusted({ kappa: null, pairs: 40 })).toBe(false);
    expect(judgeTrusted({ kappa: 0.59, pairs: 40 })).toBe(false);
    expect(judgeTrusted({ kappa: 0.6, pairs: 0 })).toBe(false);
    // Three rows that agree are not an audit.
    expect(judgeTrusted({ kappa: 1, pairs: 3 })).toBe(false);
    expect(judgeDistrust({ kappa: 1, pairs: 29 })).toBe('the audit holds 29 graded pairs; 30 are needed');
    expect(judgeTrusted({ kappa: 0.6, pairs: 30 })).toBe(true);
    expect(judgeDistrust(null)).toBe('no recruiter audit has been imported');
  });

  it('an audit vouches for one judge: the same model, the same prompt version, the markets it holds pairs of', () => {
    expect(judgeDistrust(audit, use)).toBeNull();
    expect(judgeTrusted(audit, { ...use, judgeModel: 'Vendor/Judge-Large ' })).toBe(true);
    expect(judgeDistrust(audit, { ...use, judgeModel: 'vendor/judge-other' })).toContain('this run used vendor/judge-other');
    expect(judgeDistrust(audit, { ...use, promptVersion: 'judge_v2' })).toContain('this run used judge_v2');
    expect(judgeTrusted(audit, { ...use, market: 'cn' })).toBe(true);
    expect(judgeDistrust({ ...audit, markets: { intl: 80 } }, { ...use, market: 'cn' })).toBe('the audit holds no graded pair of market cn');
    // A value over every market of the run needs every one of them in the audit.
    expect(judgeTrusted(audit, { ...use, market: 'all', markets: ['intl', 'cn'] })).toBe(true);
    expect(judgeTrusted({ ...audit, markets: { intl: 80 } }, { ...use, market: 'all', markets: ['intl', 'cn'] })).toBe(false);
    // An audit stored without its judge, or a run that names no judge, trusts nothing.
    expect(judgeTrusted({ kappa: 0.9, pairs: 80 }, use)).toBe(false);
    expect(judgeTrusted(audit, { judgeModel: null, promptVersion: null })).toBe(false);
  });

  it('a judge-labelled value is untrusted without the audit of its judge, whatever its value', () => {
    const g = gate('estimate_vs_ai', 'tier_kappa');
    const live = { live: true, judge: use };
    expect(rowStatus(g, { value: 0.9, labels: 'judged' }, { ...live, audit: null })).toBe('untrusted');
    expect(rowStatus(g, { value: 0.9, labels: 'judged' }, { ...live, audit: { ...audit, kappa: 0.4 } })).toBe('untrusted');
    expect(rowStatus(g, { value: 0.9, labels: 'judged' }, { ...live, audit })).toBe('pass');
    expect(rowStatus(g, { value: 0.2, labels: 'judged' }, { ...live, audit })).toBe('fail');
    // The judge changed since the audit, or no judge is named: the value is not trusted, so it cannot pass or fail.
    expect(rowStatus(g, { value: 0.9, labels: 'judged' }, { live: true, audit, judge: { ...use, judgeModel: 'vendor/judge-other' } })).toBe('untrusted');
    expect(rowStatus(g, { value: 0.2, labels: 'judged' }, { live: true, audit })).toBe('untrusted');
    // Constructed and human labels do not wait for the audit.
    expect(rowStatus(g, { value: 0.9, labels: 'constructed' }, { live: false, audit: null })).toBe('pass');
    expect(rowStatus(g, { value: 0.9, labels: 'human' }, { live: false, audit: null })).toBe('pass');
    // Authored labels (written by the engineer of the code under test) are named as such and gate like constructed ones.
    expect(rowStatus(g, { value: 0.9, labels: 'authored' }, { live: false, audit: null })).toBe('pass');
    expect(rowStatus(g, { value: 0.2, labels: 'authored' }, { live: false, audit: null })).toBe('fail');
  });

  it('career changers are outside the ranking gates; language gates read their three subsets only', () => {
    expect(CAREER_CHANGER_SUBSET).toBe('career_changer');
    for (const metric of ['ndcg_at_10', 'ndcg_at_20']) {
      const ranking = gate('ranking', metric);
      expect(gateReads(ranking)).toBe(true);
      expect(gateReads(ranking, null)).toBe(true);
      expect(gateReads(ranking, 'career_changer')).toBe(false);
      const language = gate('language', metric);
      expect(gateReads(language, 'zh-TW')).toBe(true);
      expect(gateReads(language, 'en')).toBe(false);
      expect(gateReads(language)).toBe(false);
    }
    expect(gateReads(gate('taxonomy', 'category_precision'), 'anything')).toBe(true);
  });

  it('keeps what the suite said, skips live-only gates offline, and never fails on a missing reference', () => {
    const ranking = gate('ranking', 'ndcg_at_10');
    expect(rowStatus(ranking, { value: null, status: 'not_built' }, { live: false, audit: null })).toBe('not_built');
    expect(rowStatus(ranking, { value: null, status: 'no_fixture' }, { live: false, audit: null })).toBe('no_fixture');
    expect(rowStatus(ranking, { value: 0.8 }, { live: false, audit: null })).toBe('no_fixture');
    expect(rowStatus(ranking, { value: null }, { live: false, audit: null })).toBe('no_fixture');
    const latency = gate('latency', 'feed_p95_ms');
    expect(rowStatus(latency, { value: 500, reference: 400 }, { live: false, audit: null })).toBe('skipped_offline');
    expect(rowStatus(latency, { value: 500, reference: 400 }, { live: true, audit: null })).toBe('pass');
  });
});
