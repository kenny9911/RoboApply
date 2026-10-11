// @vitest-environment node
// MKT-1D — metric functions against hand-computed examples. Pure; no I/O.
import { describe, expect, it } from 'vitest';
import {
  icc,
  mean,
  ndcgAtK,
  percentile,
  precisionRecallByClass,
  recallAtK,
  reliabilityCurve,
  shareEstimateGreatAiBelowPossible,
  spearman,
  tierFlipRate,
  tierOfScore,
  weightedKappa,
} from './metrics.js';

const LABELS = { a: 3, b: 2, c: 1, d: 0 };

describe('recallAtK', () => {
  it('counts the relevant items (grade 2 or better) inside the first k', () => {
    expect(recallAtK(['a', 'b', 'c', 'd'], LABELS, 2)).toBe(1);
    expect(recallAtK(['d', 'c', 'b', 'a'], LABELS, 2)).toBe(0);
    expect(recallAtK(['d', 'c', 'b', 'a'], LABELS, 3)).toBe(0.5);
    expect(recallAtK(['d', 'c', 'b', 'a'], LABELS, 4)).toBe(1);
  });

  it('takes another relevance threshold', () => {
    expect(recallAtK(['a', 'd'], LABELS, 2, 3)).toBe(1);
    expect(recallAtK(['c', 'd'], LABELS, 2, 1)).toBeCloseTo(1 / 3, 10);
  });

  it('is null when nothing is relevant, and never counts an id twice', () => {
    expect(recallAtK(['a'], { a: 1, b: 0 }, 5)).toBeNull();
    expect(recallAtK(['a', 'a', 'a', 'b'], LABELS, 2)).toBe(1);
  });

  it('reads a Map as well as a record', () => {
    expect(recallAtK(['a'], new Map(Object.entries(LABELS)), 1)).toBe(0.5);
  });
});

describe('ndcgAtK', () => {
  it('is 1 for the perfect ranking', () => {
    expect(ndcgAtK(['a', 'b', 'c', 'd'], LABELS, 4)).toBe(1);
    expect(ndcgAtK(['a', 'b', 'c', 'd'], LABELS, 10)).toBe(1);
  });

  it('matches the hand-computed value for the reversed ranking', () => {
    // DCG  = 0/log2(2) + 1/log2(3) + 3/log2(4) + 7/log2(5) = 0 + 0.63093 + 1.5 + 3.01472 = 5.14565
    // IDCG = 7/log2(2) + 3/log2(3) + 1/log2(4) + 0         = 7 + 1.89279 + 0.5          = 9.39279
    expect(ndcgAtK(['d', 'c', 'b', 'a'], LABELS, 4)).toBeCloseTo(5.14565 / 9.39279, 4);
  });

  it('cuts both the ranking and the ideal at k', () => {
    // Top 2 of the reversed ranking hold grades 0 and 1: DCG = 1/log2(3) = 0.63093; IDCG@2 = 7 + 1.89279.
    expect(ndcgAtK(['d', 'c', 'b', 'a'], LABELS, 2)).toBeCloseTo(0.63093 / 8.89279, 4);
  });

  it('counts an unlabelled item as grade 0 and is null with no positive label', () => {
    expect(ndcgAtK(['zzz', 'a'], LABELS, 2)).toBeCloseTo(7 / Math.log2(3) / (7 + 3 / Math.log2(3)), 10);
    expect(ndcgAtK(['a'], { a: 0, b: 0 }, 5)).toBeNull();
  });
});

describe('weightedKappa (quadratic)', () => {
  /** Rows = rater A, columns = rater B. */
  function fromTable(table: number[][]): { a: number[]; b: number[] } {
    const a: number[] = [];
    const b: number[] = [];
    table.forEach((row, i) =>
      row.forEach((count, j) => {
        for (let n = 0; n < count; n++) {
          a.push(i);
          b.push(j);
        }
      }),
    );
    return { a, b };
  }

  it('matches a known 3x3 confusion table', () => {
    // n = 40. Observed weighted disagreement: (2 + 3 + 2 + 3) x 0.25 / 40 = 0.0625.
    // Row totals 12, 15, 13; column totals 13, 15, 12.
    // Expected: (0.25x12x15 + 1x12x12 + 0.25x15x13 + 0.25x15x12 + 1x13x13 + 0.25x13x15) / 1600 = 500.5 / 1600 = 0.3128125.
    // Kappa = 1 - 0.0625 / 0.3128125 = 0.8002.
    const { a, b } = fromTable([
      [10, 2, 0],
      [3, 10, 2],
      [0, 3, 10],
    ]);
    expect(weightedKappa(a, b, [0, 1, 2])).toBeCloseTo(0.8002, 4);
  });

  it('is 1 for full agreement and -1 for the full reversal of two categories', () => {
    expect(weightedKappa([0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3])).toBe(1);
    expect(weightedKappa(['lo', 'hi'], ['hi', 'lo'], ['lo', 'hi'])).toBe(-1);
  });

  it('works on tier names in order', () => {
    const tiers = ['unlikely', 'possible', 'good', 'great'] as const;
    const k = weightedKappa(['great', 'good', 'possible', 'unlikely'], ['good', 'good', 'possible', 'unlikely'], tiers);
    expect(k).not.toBeNull();
    expect(k!).toBeGreaterThan(0.8);
    expect(k!).toBeLessThan(1);
  });

  it('is null with no pair or when chance agreement cannot be separated', () => {
    expect(weightedKappa([], [], [0, 1])).toBeNull();
    expect(weightedKappa([1, 1, 1], [1, 1, 1], [0, 1, 2])).toBeNull();
    expect(weightedKappa([0, 1], [0], [0, 1])).toBeNull();
  });
});

describe('icc (two-way random, absolute agreement, single measure)', () => {
  it('is 1 for identical runs', () => {
    const run = [62, 71, 48, 90, 33];
    expect(icc([run, [...run], [...run]])).toBe(1);
  });

  it('penalises a constant offset between runs (absolute agreement)', () => {
    // n = 3, k = 2. MS items = 2, MS runs = 1.5, MS error = 0.
    // ICC = 2 / (2 + 0 + 2 x (1.5 - 0) / 3) = 2 / 3.
    expect(icc([[1, 2, 3], [2, 3, 4]])).toBeCloseTo(2 / 3, 10);
  });

  it('is low when the runs disagree about the order', () => {
    const v = icc([[1, 2, 3, 4], [4, 3, 2, 1]]);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(0);
  });

  it('is null without two runs, two items, or any variance', () => {
    expect(icc([[1, 2, 3]])).toBeNull();
    expect(icc([[1], [1]])).toBeNull();
    expect(icc([[5, 5, 5], [5, 5, 5]])).toBeNull();
    expect(icc([[1, 2], [1, 2, 3]])).toBeNull();
  });
});

describe('spearman', () => {
  it('is 1 for a monotone relation and -1 for a monotone reversal', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 25, 70, 900])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('gives tied values their average rank', () => {
    // x ranks 1, 2.5, 2.5, 4; y ranks 1, 2, 3, 4. Pearson of the ranks = 4.5 / sqrt(4.5 x 5) = 0.94868.
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.94868, 4);
  });

  it('is null when one side does not vary', () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1], [1])).toBeNull();
  });
});

describe('precisionRecallByClass', () => {
  it('computes each class of shown / related / not_shown', () => {
    const expected = ['shown', 'shown', 'related', 'not_shown', 'not_shown', 'not_shown'] as const;
    const actual = ['shown', 'not_shown', 'related', 'not_shown', 'not_shown', 'shown'] as const;
    const r = precisionRecallByClass([...expected], [...actual], ['shown', 'related', 'not_shown']);
    expect(r.shown).toEqual({ precision: 0.5, recall: 0.5, tp: 1, fp: 1, fn: 1, support: 2 });
    expect(r.related).toEqual({ precision: 1, recall: 1, tp: 1, fp: 0, fn: 0, support: 1 });
    expect(r.not_shown.precision).toBeCloseTo(2 / 3, 10);
    expect(r.not_shown.recall).toBeCloseTo(2 / 3, 10);
  });

  it('answers null for a class the code never said, or no label has', () => {
    const r = precisionRecallByClass(['a', 'a'], ['a', 'a'], ['a', 'b']);
    expect(r.b).toEqual({ precision: null, recall: null, tp: 0, fp: 0, fn: 0, support: 0 });
  });
});

describe('tierFlipRate', () => {
  it('is the share of items whose tier differs in any run', () => {
    expect(
      tierFlipRate([
        ['great', 'good', 'possible', 'unlikely'],
        ['great', 'good', 'good', 'unlikely'],
        ['great', 'possible', 'possible', 'unlikely'],
      ]),
    ).toBe(0.5);
    expect(tierFlipRate([['good', null], ['good', null]])).toBe(0);
  });

  it('is null with one run or no item', () => {
    expect(tierFlipRate([['good']])).toBeNull();
    expect(tierFlipRate([[], []])).toBeNull();
  });
});

describe('reliabilityCurve', () => {
  it('reports the mean AI score per estimate decile', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ estimate: i * 5, ai: i * 3 }));
    const curve = reliabilityCurve(pairs);
    expect(curve).toHaveLength(10);
    expect(curve[0]).toEqual({ decile: 1, n: 2, estimateMean: 2.5, aiMean: 1.5 });
    expect(curve[9]).toEqual({ decile: 10, n: 2, estimateMean: 92.5, aiMean: 55.5 });
  });

  it('uses fewer groups than deciles for a small sample and none for an empty one', () => {
    expect(reliabilityCurve([{ estimate: 80, ai: 40 }, { estimate: 20, ai: 30 }])).toEqual([
      { decile: 1, n: 1, estimateMean: 20, aiMean: 30 },
      { decile: 2, n: 1, estimateMean: 80, aiMean: 40 },
    ]);
    expect(reliabilityCurve([])).toEqual([]);
  });
});

describe('shareEstimateGreatAiBelowPossible', () => {
  it('is the share of Great estimates whose AI score is below Possible', () => {
    const r = shareEstimateGreatAiBelowPossible([
      { estimate: 90, ai: 40 }, // overclaim
      { estimate: 85, ai: 70 },
      { estimate: 80, ai: 45 }, // exactly Possible: not below
      { estimate: 82, ai: 44 }, // overclaim
      { estimate: 60, ai: 10 }, // estimate is not Great
    ]);
    expect(r).toEqual({ share: 0.5, shareOfAll: 0.4, count: 2, estimateGreat: 4, pairs: 5 });
  });

  it('has no share when no estimate is Great', () => {
    expect(shareEstimateGreatAiBelowPossible([{ estimate: 50, ai: 10 }]).share).toBeNull();
    expect(shareEstimateGreatAiBelowPossible([]).shareOfAll).toBeNull();
  });
});

describe('helpers', () => {
  it('tierOfScore uses the published thresholds', () => {
    expect([80, 79, 65, 64, 45, 44].map((s) => tierOfScore(s))).toEqual(['great', 'good', 'good', 'possible', 'possible', 'unlikely']);
  });

  it('mean and percentile', () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 6])).toBe(3);
    expect(percentile([], 95)).toBeNull();
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([0, 100], 95)).toBeCloseTo(95, 10);
  });
});
