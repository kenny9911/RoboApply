// server/src/features/match/eval/suite.ts
//
// The contract between run.ts and a suite. A suite is a file
// `eval/suites/<name>.suite.ts` that exports `name`, `layer` and `run(ctx)`.
// run.ts finds suites on disk, so a later bundle adds a suite and its fixture
// folder without editing the runner.
//
// A suite MEASURES; it never decides pass or fail. It returns one
// `SuiteMeasure` per value, named with the metric id of the gate table
// (gates.ts), and run.ts holds each value against its gate. What a suite may
// decide is that it cannot measure: `no_fixture` (the fixture file is not on
// disk), `not_built` (a seam it reads does not exist yet) or `skipped_offline`
// (needs the real index).
//
// Fixtures are loaded by path with fs at run time (`ctx.fixturesDir`,
// `ctx.repoRoot`), never by a static import from outside eval/.

import type { GateLayer, LabelKind } from './gates.js';
import { isSeamMissing } from './seams.js';

export type SuiteMarket = 'intl' | 'cn';

export interface SuiteContext {
  /** The markets selected with --market (both by default). */
  markets: SuiteMarket[];
  /** True under --live: the suite may read the real index through `ctx.live`. */
  live: boolean;
  repoRoot: string;
  evalDir: string;
  /** eval/fixtures: the committed, synthetic fixtures. */
  fixturesDir: string;
  now: Date;
}

export interface SuiteMeasure {
  /** Metric id of gates.ts (`ndcg_at_10`, `category_precision`, …). A metric without a gate is printed as information. */
  metric: string;
  /** Defaults to the suite's layer. */
  layer?: GateLayer;
  market?: SuiteMarket | 'all';
  /** Language subset (`en`, `zh-TW`, `zh-CN`, `cross`), when the value is for one. */
  subset?: string;
  /** `live` for a value measured on the real index: it is never compared with a fixture value or baseline. */
  scope?: string;
  /** Null when nothing could be measured (printed "n/a", never 0). */
  value: number | null;
  /** Sample size behind the value (personas, titles, pairs). */
  n?: number;
  /** Where the labels came from. A `judged` value is untrusted until the audit passes. */
  labels?: LabelKind;
  /** The other metric of the same run a `min_gain` gate compares with (recency-only recall). */
  reference?: number | null;
  status?: 'no_fixture' | 'not_built' | 'skipped_offline';
  note?: string;
}

export interface Suite {
  name: string;
  layer: GateLayer;
  run(ctx: SuiteContext): Promise<SuiteMeasure[]>;
}

/** A measure that says "this could not be measured", with the reason. */
export function unmeasured(metric: string, status: NonNullable<SuiteMeasure['status']>, note: string, extra: Partial<SuiteMeasure> = {}): SuiteMeasure {
  return { metric, value: null, status, note, ...extra };
}

/** `not_built` for a missing seam; any other error is rethrown (a suite that crashes fails the command). */
export function notBuiltOrThrow(metric: string, err: unknown, extra: Partial<SuiteMeasure> = {}): SuiteMeasure {
  if (isSeamMissing(err)) return unmeasured(metric, 'not_built', err.message, extra);
  throw err;
}

export function isSuite(v: unknown): v is Suite {
  return !!v && typeof v === 'object' && typeof (v as Suite).name === 'string' && typeof (v as Suite).layer === 'string' && typeof (v as Suite).run === 'function';
}
