// server/src/features/match/eval/metrics.ts
//
// Metric functions of the evaluation harness (MARKET_STRATEGY.md 2.6;
// SEARCH_RETRIEVE_MATCH.md 6.2). Pure: no I/O, no clock, no randomness. Every
// function answers `null` when the metric is undefined for its input (no
// relevant item, no variance, an empty sample) instead of inventing a number
// (D3): a report prints "n/a", never 0.
//
// Labels are graded 0-3: 0 not relevant, 1 related, 2 good match, 3 excellent
// match. "Relevant" for recall means grade 2 or better unless stated.

export type Grade = 0 | 1 | 2 | 3;
export type GradeLookup = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

function gradeOf(labels: GradeLookup, id: string): number {
  const v = labels instanceof Map ? labels.get(id) : (labels as Record<string, number>)[id];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function gradeEntries(labels: GradeLookup): Array<[string, number]> {
  const raw: Array<[string, number]> = labels instanceof Map ? [...labels.entries()] : Object.entries(labels as Record<string, number>);
  return raw.filter(([, g]) => typeof g === 'number' && Number.isFinite(g));
}

/** Each id once, in its first position (a ranking never counts an item twice). */
function uniqueRanked(ranked: readonly string[]): string[] {
  return [...new Set(ranked)];
}

export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Recall@k: the share of the relevant items (grade ≥ `minGrade`) that appear
 * in the first `k` of `ranked`. Null when nothing is relevant.
 */
export function recallAtK(ranked: readonly string[], labels: GradeLookup, k: number, minGrade = 2): number | null {
  const relevant = new Set(gradeEntries(labels).filter(([, g]) => g >= minGrade).map(([id]) => id));
  if (!relevant.size) return null;
  const top = uniqueRanked(ranked).slice(0, Math.max(0, k));
  return top.filter((id) => relevant.has(id)).length / relevant.size;
}

/** DCG with gain 2^grade − 1 and a log2 discount (position 1 is undiscounted). */
function dcg(grades: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < grades.length; i++) sum += (2 ** grades[i]! - 1) / Math.log2(i + 2);
  return sum;
}

/**
 * NDCG@k against graded labels. The ideal ranking is every labelled item,
 * best grade first; an unlabelled item in `ranked` counts as grade 0. Null
 * when no labelled item has a grade above 0.
 */
export function ndcgAtK(ranked: readonly string[], labels: GradeLookup, k: number): number | null {
  const kk = Math.max(0, Math.floor(k));
  const ideal = gradeEntries(labels)
    .map(([, g]) => Math.max(0, g))
    .sort((a, b) => b - a)
    .slice(0, kk);
  const idcg = dcg(ideal);
  if (idcg <= 0) return null;
  const got = uniqueRanked(ranked)
    .slice(0, kk)
    .map((id) => gradeOf(labels, id));
  return dcg(got) / idcg;
}

/**
 * Cohen's kappa with quadratic weights between two raters over ordered
 * categories (fit tiers; judge against human grades). `categories` lists the
 * categories in order; values outside it are ignored pairwise. Null with no
 * pair, or when the expected disagreement is 0 (both raters used one and the
 * same category for everything: agreement by chance cannot be separated).
 */
export function weightedKappa<T extends string | number>(a: readonly T[], b: readonly T[], categories: readonly T[]): number | null {
  const k = categories.length;
  if (k < 2 || a.length !== b.length) return null;
  const index = new Map<T, number>(categories.map((c, i) => [c, i]));
  const table: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const x = index.get(a[i]!);
    const y = index.get(b[i]!);
    if (x === undefined || y === undefined) continue;
    table[x]![y]! += 1;
    n += 1;
  }
  if (!n) return null;
  const rows = table.map((r) => r.reduce((s, v) => s + v, 0));
  const cols = categories.map((_, j) => table.reduce((s, r) => s + r[j]!, 0));
  let observed = 0;
  let expected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = ((i - j) * (i - j)) / ((k - 1) * (k - 1));
      observed += w * (table[i]![j]! / n);
      expected += w * ((rows[i]! * cols[j]!) / (n * n));
    }
  }
  if (expected === 0) return null;
  return 1 - observed / expected;
}

/**
 * Intraclass correlation ICC(2,1): two-way random effects, absolute
 * agreement, single measure (Shrout and Fleiss). `runs[r][i]` is the score
 * run `r` gave item `i`; every run scores the same items in the same order.
 * Identical runs give 1. Null with fewer than two runs or two items, or when
 * nothing varies at all.
 */
export function icc(runs: ReadonlyArray<readonly number[]>): number | null {
  const k = runs.length;
  const n = runs[0]?.length ?? 0;
  if (k < 2 || n < 2 || runs.some((r) => r.length !== n)) return null;
  const grand = runs.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0) / (n * k);
  const itemMeans = Array.from({ length: n }, (_, i) => runs.reduce((s, r) => s + r[i]!, 0) / k);
  const runMeans = runs.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const ssItems = k * itemMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  const ssRuns = n * runMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  let ssTotal = 0;
  for (const r of runs) for (const v of r) ssTotal += (v - grand) ** 2;
  const ssError = Math.max(0, ssTotal - ssItems - ssRuns);
  const msItems = ssItems / (n - 1);
  const msRuns = ssRuns / (k - 1);
  const msError = ssError / ((n - 1) * (k - 1));
  const denominator = msItems + (k - 1) * msError + (k * (msRuns - msError)) / n;
  if (!(denominator > 0)) return null;
  // Rounded to 12 decimals: identical runs are exactly 1, not 1 minus float noise.
  return Math.round(((msItems - msError) / denominator) * 1e12) / 1e12;
}

/** Average ranks (1-based), ties share the mean of their positions. */
function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let m = i; m <= j; m++) out[order[m]!.i] = rank;
    i = j + 1;
  }
  return out;
}

function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation (ties get average ranks). Null when either side does not vary. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  return pearson(ranks(x), ranks(y));
}

export interface ClassScore {
  precision: number | null;
  recall: number | null;
  tp: number;
  fp: number;
  fn: number;
  /** Items whose expected class is this one. */
  support: number;
}

/**
 * Precision and recall per class (the keyword check's shown / related /
 * not_shown). `expected[i]` is the label, `actual[i]` what the code said.
 * Precision is null for a class the code never answered, recall for a class
 * no label has.
 */
export function precisionRecallByClass<T extends string>(expected: readonly T[], actual: readonly T[], classes?: readonly T[]): Record<T, ClassScore> {
  if (expected.length !== actual.length) throw new Error('precisionRecallByClass: expected and actual differ in length');
  const all = classes ?? ([...new Set([...expected, ...actual])] as T[]);
  const out = {} as Record<T, ClassScore>;
  for (const c of all) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i] === c;
      const a = actual[i] === c;
      if (e && a) tp += 1;
      else if (!e && a) fp += 1;
      else if (e && !a) fn += 1;
    }
    out[c] = { precision: tp + fp > 0 ? tp / (tp + fp) : null, recall: tp + fn > 0 ? tp / (tp + fn) : null, tp, fp, fn, support: tp + fn };
  }
  return out;
}

/**
 * Tier flip rate: the share of items whose tier is not the same in every
 * run. `runs[r][i]` is the tier run `r` gave item `i` (null = no tier). Null
 * with fewer than two runs or no item.
 */
export function tierFlipRate(runs: ReadonlyArray<ReadonlyArray<string | null>>): number | null {
  const n = runs[0]?.length ?? 0;
  if (runs.length < 2 || n === 0 || runs.some((r) => r.length !== n)) return null;
  let flips = 0;
  for (let i = 0; i < n; i++) {
    const first = runs[0]![i];
    if (runs.some((r) => r[i] !== first)) flips += 1;
  }
  return flips / n;
}

export interface EstimateAiPair {
  estimate: number;
  ai: number;
}

export interface ReliabilityBin {
  /** 1 = the lowest tenth of estimates. */
  decile: number;
  n: number;
  estimateMean: number;
  aiMean: number;
}

/**
 * Reliability curve: pairs sorted by estimate and cut into `bins` groups of
 * (nearly) equal size; per group the mean estimate and the mean AI score. A
 * calibrated estimate has the two means close in every group. Fewer pairs
 * than bins give one group per pair.
 */
export function reliabilityCurve(pairs: readonly EstimateAiPair[], bins = 10): ReliabilityBin[] {
  const clean = pairs.filter((p) => Number.isFinite(p.estimate) && Number.isFinite(p.ai)).sort((a, b) => a.estimate - b.estimate);
  if (!clean.length || bins < 1) return [];
  const groups = Math.min(bins, clean.length);
  const out: ReliabilityBin[] = [];
  for (let g = 0; g < groups; g++) {
    const from = Math.floor((g * clean.length) / groups);
    const to = Math.floor(((g + 1) * clean.length) / groups);
    const slice = clean.slice(from, to);
    if (!slice.length) continue;
    out.push({
      decile: g + 1,
      n: slice.length,
      estimateMean: slice.reduce((s, p) => s + p.estimate, 0) / slice.length,
      aiMean: slice.reduce((s, p) => s + p.ai, 0) / slice.length,
    });
  }
  return out;
}

export interface TierThresholds {
  great: number;
  good: number;
  possible: number;
}

export const EVAL_DEFAULT_TIERS: TierThresholds = { great: 80, good: 65, possible: 45 };

export function tierOfScore(score: number, tiers: TierThresholds = EVAL_DEFAULT_TIERS): 'great' | 'good' | 'possible' | 'unlikely' {
  if (score >= tiers.great) return 'great';
  if (score >= tiers.good) return 'good';
  if (score >= tiers.possible) return 'possible';
  return 'unlikely';
}

export interface OverclaimShare {
  /** Of the pairs whose estimate is Great, the share whose AI score is below Possible. Null when no estimate is Great. */
  share: number | null;
  /** The same count over every pair (reported beside it, never gated). */
  shareOfAll: number | null;
  count: number;
  estimateGreat: number;
  pairs: number;
}

/**
 * "Estimate says Great, AI says below Possible": the overclaim the gate keeps
 * under 5%. The gated share is conditional on the estimate being Great (a
 * system that never says Great has nothing to overclaim, and a share over all
 * pairs would hide a bad estimate behind a large sample).
 */
export function shareEstimateGreatAiBelowPossible(pairs: readonly EstimateAiPair[], tiers: TierThresholds = EVAL_DEFAULT_TIERS): OverclaimShare {
  const clean = pairs.filter((p) => Number.isFinite(p.estimate) && Number.isFinite(p.ai));
  const great = clean.filter((p) => p.estimate >= tiers.great);
  const count = great.filter((p) => p.ai < tiers.possible).length;
  return {
    share: great.length ? count / great.length : null,
    shareOfAll: clean.length ? count / clean.length : null,
    count,
    estimateGreat: great.length,
    pairs: clean.length,
  };
}

/** The p-th percentile (0-100) by linear interpolation; null for an empty sample. Used for feed p95 in live mode. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
