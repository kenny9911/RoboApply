// server/src/features/match/eval/gates.ts
//
// The gate table of MARKET_STRATEGY.md 2.6 (SEARCH_RETRIEVE_MATCH.md 6.2) as
// data, and the one function that compares a measured value with its gate.
// run.ts prints one row per gate; a suite reports values and never decides
// pass or fail itself.
//
// Units: every share, recall, precision, NDCG, kappa, ICC and correlation is
// a number from 0 to 1 (kappa, ICC and correlation may be negative). "Points"
// in the strategy are percentage points: +15 points is +0.15 here. Latency is
// milliseconds.
//
// Label rule (strategy 2.6): a metric computed from LLM-judge labels is
// reported `untrusted` until an audit file says the judge agrees with human
// recruiters at quadratic-weighted kappa ≥ 0.6. The audit must be of the same
// judge (model and prompt version), hold at least JUDGE_TRUST_MIN_PAIRS graded
// pairs, and hold pairs of the market the value is reported for
// (`judgeDistrust`). Constructed labels (written by the fixture generator
// from how a posting was built), authored labels (written by hand by the
// engineer of the code under test, as the labelled title sets are) and human
// labels (graded by a recruiter) do not need the audit; a report always says
// which kind it used, and never calls authored labels human (D3).

export type GateLayer = 'retrieval' | 'ranking' | 'estimate_vs_ai' | 'scorer' | 'taxonomy' | 'skills' | 'language' | 'latency';

export const GATE_LAYERS: readonly GateLayer[] = ['retrieval', 'ranking', 'estimate_vs_ai', 'scorer', 'taxonomy', 'skills', 'language', 'latency'];

/** What a row of the report can say. */
export type GateStatus = 'pass' | 'fail' | 'no_fixture' | 'not_built' | 'untrusted' | 'skipped_offline';

/** Where the labels behind a value came from. Never mixed inside one value. */
export type LabelKind = 'constructed' | 'authored' | 'judged' | 'human' | 'none';

export type GateRule =
  /** value ≥ threshold */
  | { kind: 'min'; threshold: number }
  /** value < threshold (the strategy says "under") */
  | { kind: 'below'; threshold: number }
  /** value ≥ reference + points; the reference is another metric of the same run */
  | { kind: 'min_gain'; points: number; over: string }
  /** value ≥ stored baseline − tolerance */
  | { kind: 'no_regression'; tolerance: number }
  /** value ≥ reference × (1 − share); the reference is the same metric on another subset */
  | { kind: 'within_relative'; share: number; ofSubset: string }
  /** value ≤ stored baseline + amount */
  | { kind: 'max_increase'; amount: number };

export interface Gate {
  layer: GateLayer;
  /** Metric id a suite reports (`SuiteMeasure.metric`). */
  metric: string;
  rule: GateRule;
  /** Subsets the gate applies to (language layer); absent = every subset the suite reports. */
  subsets?: readonly string[];
  /** Subsets the gate never reads: their rows are printed as information (`gateReads`). */
  exceptSubsets?: readonly string[];
  /** Only measurable against the real index (`--live`). */
  liveOnly?: boolean;
  /** The sample the strategy asks for, as words for the report. */
  sample?: string;
}

/** Judge-human agreement a judge-labelled metric needs before it is trusted. */
export const JUDGE_TRUST_MIN_KAPPA = 0.6;

/**
 * Pairs a recruiter audit must grade before its kappa counts. Below this a
 * kappa is noise: three rows that happen to agree give 1.0.
 */
export const JUDGE_TRUST_MIN_PAIRS = 30;

/** Rounding noise allowed by "no regression" (baselines are stored to six decimals). */
export const NO_REGRESSION_TOLERANCE = 1e-6;

/** The subset every language comparison is made against. */
export const LANGUAGE_REFERENCE_SUBSET = 'en';
export const LANGUAGE_GATED_SUBSETS = ['zh-TW', 'zh-CN', 'cross'] as const;

/**
 * Career changers are measured and printed, never gated. Their labels follow
 * the role the person says they want. The fit must not read that (invariant 2:
 * a Role chip changes no fit), so a fit that is right cannot rank the wanted
 * role first, and a fit that leaks the chip would raise the value. The goal
 * may count in the feed order; until a suite measures that order, these rows
 * are information (`ndcg_at_10 [career_changer]`).
 */
export const CAREER_CHANGER_SUBSET = 'career_changer';

export const GATES: readonly Gate[] = [
  // Retrieval: Recall@200 hybrid ≥ recency-only + 15 points; no persona more than 5 below its baseline.
  { layer: 'retrieval', metric: 'recall_at_200_hybrid', rule: { kind: 'min_gain', points: 0.15, over: 'recall_at_200_recency' }, sample: '40 personas per market' },
  { layer: 'retrieval', metric: 'recall_at_200_worst_persona_delta', rule: { kind: 'min', threshold: -0.05 }, sample: 'hybrid minus recency-only, worst persona' },
  // Ranking: NDCG@10 and @20 no regression.
  { layer: 'ranking', metric: 'ndcg_at_10', rule: { kind: 'no_regression', tolerance: NO_REGRESSION_TOLERANCE }, exceptSubsets: [CAREER_CHANGER_SUBSET] },
  { layer: 'ranking', metric: 'ndcg_at_20', rule: { kind: 'no_regression', tolerance: NO_REGRESSION_TOLERANCE }, exceptSubsets: [CAREER_CHANGER_SUBSET] },
  // Estimate against AI: tier kappa ≥ 0.5; "estimate Great, AI below Possible" under 5%.
  { layer: 'estimate_vs_ai', metric: 'tier_kappa', rule: { kind: 'min', threshold: 0.5 } },
  { layer: 'estimate_vs_ai', metric: 'estimate_great_ai_below_possible', rule: { kind: 'below', threshold: 0.05 } },
  // Scorer: ICC ≥ 0.85 over 3 runs; tier flips under 5%; Spearman with human grades ≥ 0.6.
  { layer: 'scorer', metric: 'icc_3_runs', rule: { kind: 'min', threshold: 0.85 }, sample: '3 runs on 100 pairs per market, drawn over every persona' },
  { layer: 'scorer', metric: 'tier_flip_rate', rule: { kind: 'below', threshold: 0.05 }, sample: '3 runs on 100 pairs per market, drawn over every persona' },
  { layer: 'scorer', metric: 'spearman_human', rule: { kind: 'min', threshold: 0.6 }, sample: 'audited pairs' },
  // Taxonomy: category precision ≥ 95% on 300 labelled titles per market.
  { layer: 'taxonomy', metric: 'category_precision', rule: { kind: 'min', threshold: 0.95 }, sample: '300 labelled titles per market' },
  // Skills: precision of "Not shown" ≥ 95%.
  { layer: 'skills', metric: 'precision_not_shown', rule: { kind: 'min', threshold: 0.95 }, sample: '100 labelled resume-job pairs' },
  // Language: zh-TW, zh-CN and cross-language subsets within 10% relative of the English subset.
  { layer: 'language', metric: 'ndcg_at_10', rule: { kind: 'within_relative', share: 0.1, ofSubset: LANGUAGE_REFERENCE_SUBSET }, subsets: LANGUAGE_GATED_SUBSETS },
  { layer: 'language', metric: 'ndcg_at_20', rule: { kind: 'within_relative', share: 0.1, ofSubset: LANGUAGE_REFERENCE_SUBSET }, subsets: LANGUAGE_GATED_SUBSETS },
  // Latency: feed p95 no worse than the stored baseline + 150 ms (live only).
  { layer: 'latency', metric: 'feed_p95_ms', rule: { kind: 'max_increase', amount: 150 }, liveOnly: true },
];

export function gatesOfLayer(layer: GateLayer): Gate[] {
  return GATES.filter((g) => g.layer === layer);
}

export function findGate(layer: GateLayer, metric: string): Gate | null {
  return GATES.find((g) => g.layer === layer && g.metric === metric) ?? null;
}

/** Does the gate read a value reported for this subset (or for no subset)? */
export function gateReads(gate: Gate, subset?: string | null): boolean {
  if (subset && gate.exceptSubsets?.includes(subset)) return false;
  return !gate.subsets || (!!subset && gate.subsets.includes(subset));
}

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function points(n: number): string {
  return `${Math.round(n * 1000) / 10} points`;
}

/** The gate as words for the report's "gate" column. */
export function gateText(gate: Gate): string {
  const r = gate.rule;
  switch (r.kind) {
    case 'min':
      return `>= ${r.threshold}`;
    case 'below':
      return `< ${r.threshold}`;
    case 'min_gain':
      return `>= ${r.over} + ${points(r.points)}`;
    case 'no_regression':
      return 'no regression against the stored baseline';
    case 'within_relative':
      return `within ${pct(r.share)} relative of the ${r.ofSubset} subset`;
    case 'max_increase':
      return `<= stored baseline + ${r.amount} ms`;
  }
}

export interface GateInput {
  value: number | null;
  /**
   * What the rule compares with: the other metric (`min_gain`), the stored
   * baseline (`no_regression`, `max_increase`) or the reference subset's value
   * (`within_relative`). Not read by `min` and `below`.
   */
  reference?: number | null;
}

export interface GateOutcome {
  /** `no_reference`: the rule needs a reference this run does not have (no baseline yet, no English subset). */
  status: 'pass' | 'fail' | 'no_value' | 'no_reference';
  /** The bound the value was held against, when there is one. */
  bound: number | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Compare one measured value with its gate. The only place a threshold is applied. */
export function compareWithGate(gate: Gate, input: GateInput): GateOutcome {
  if (!isNum(input.value)) return { status: 'no_value', bound: null };
  const v = input.value;
  const r = gate.rule;
  const needsRef = r.kind === 'min_gain' || r.kind === 'no_regression' || r.kind === 'within_relative' || r.kind === 'max_increase';
  if (needsRef && !isNum(input.reference)) return { status: 'no_reference', bound: null };
  const ref = input.reference as number;
  let ok: boolean;
  let bound: number;
  switch (r.kind) {
    case 'min':
      bound = r.threshold;
      ok = v >= bound;
      break;
    case 'below':
      bound = r.threshold;
      ok = v < bound;
      break;
    case 'min_gain':
      bound = ref + r.points;
      // A float sum (0.5 + 0.15) must not fail a value that is exactly on the line.
      ok = v >= bound - 1e-12;
      break;
    case 'no_regression':
      bound = ref - r.tolerance;
      ok = v >= bound;
      break;
    case 'within_relative':
      bound = ref * (1 - r.share);
      ok = v >= bound - 1e-12;
      break;
    case 'max_increase':
      bound = ref + r.amount;
      ok = v <= bound;
      break;
  }
  return { status: ok ? 'pass' : 'fail', bound };
}

/** The audit of the LLM judge against human recruiters (`live/audit.ts` writes it). */
export interface JudgeAudit {
  /** Quadratic-weighted kappa of judge against human grades; null when it could not be computed. */
  kappa: number | null;
  pairs: number;
  /** The judge whose grades were audited: a model id and a prompt version. Absent in an audit stored before these were recorded. */
  judgeModel?: string | null;
  promptVersion?: string | null;
  /** Graded pairs per market. An audit says nothing about a market it holds no pair of. */
  markets?: Record<string, number>;
}

/** The judge a value was graded by, and the market it is reported for. */
export interface JudgeUse {
  judgeModel: string | null;
  promptVersion: string | null;
  /** `intl`, `cn`, or `all` for a value over every market of the run (then `markets` lists them). */
  market?: string | null;
  markets?: readonly string[];
}

const sameModel = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Why a value computed from judge labels is not trusted, or null when it is.
 * The audit must be of THIS judge (same model, same prompt version), must
 * hold enough graded pairs, must reach the kappa, and must cover the market
 * of the value. Without `use` only the agreement itself is checked (what
 * `--import-audit` prints).
 */
export function judgeDistrust(audit: JudgeAudit | null | undefined, use?: JudgeUse | null): string | null {
  if (!audit) return 'no recruiter audit has been imported';
  if (!isNum(audit.kappa)) return 'the audit has no kappa (too few graded pairs, or one grade only)';
  if (audit.pairs < JUDGE_TRUST_MIN_PAIRS) return `the audit holds ${audit.pairs} graded pairs; ${JUDGE_TRUST_MIN_PAIRS} are needed`;
  if (audit.kappa < JUDGE_TRUST_MIN_KAPPA) return `the judge-human kappa is ${audit.kappa.toFixed(3)}; ${JUDGE_TRUST_MIN_KAPPA} is needed`;
  if (!use) return null;
  if (!sameModel(audit.judgeModel, use.judgeModel)) return `the audit is of judge model ${audit.judgeModel ?? 'unknown'}, this run used ${use.judgeModel ?? 'none'}`;
  if (!audit.promptVersion || audit.promptVersion !== use.promptVersion) return `the audit is of judge prompt ${audit.promptVersion ?? 'unknown'}, this run used ${use.promptVersion ?? 'none'}`;
  const wanted = use.market && use.market !== 'all' ? [use.market] : [...(use.markets ?? [])];
  const missing = wanted.filter((m) => !(audit.markets?.[m] ?? 0));
  if (missing.length) return `the audit holds no graded pair of market ${missing.join(', ')}`;
  return null;
}

/** May a metric computed from judge labels be trusted? */
export function judgeTrusted(audit: JudgeAudit | null | undefined, use?: JudgeUse | null): boolean {
  return judgeDistrust(audit, use) === null;
}

export interface RowInput extends GateInput {
  /** A status the suite decided itself (no fixture on disk, a seam that is not built, offline). */
  status?: 'no_fixture' | 'not_built' | 'skipped_offline';
  labels?: LabelKind;
}

/**
 * The status of one report row. Order: what the suite said, then live-only,
 * then the judge-trust rule, then the comparison. A value that cannot be
 * compared (no baseline yet, no reference subset, nothing measured) is
 * `no_fixture`: it is printed and does not fail the command.
 */
export function rowStatus(gate: Gate, row: RowInput, ctx: { live: boolean; audit: JudgeAudit | null; judge?: JudgeUse | null }): GateStatus {
  if (row.status) return row.status;
  if (gate.liveOnly && !ctx.live) return 'skipped_offline';
  // A judged value with no judge named is never trusted: an audit vouches for one judge, not for any.
  if (row.labels === 'judged' && !judgeTrusted(ctx.audit, ctx.judge ?? { judgeModel: null, promptVersion: null })) return 'untrusted';
  const outcome = compareWithGate(gate, row);
  if (outcome.status === 'no_value' || outcome.status === 'no_reference') return 'no_fixture';
  return outcome.status;
}
