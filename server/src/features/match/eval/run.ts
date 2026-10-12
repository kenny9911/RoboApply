// server/src/features/match/eval/run.ts
//
// The evaluation harness of the match area (MARKET_STRATEGY.md 2.6;
// SEARCH_RETRIEVE_MATCH.md 6.5).
//
//   npm run eval:match                         fixture-only: no network, no database
//   npm run eval:match -- --enforce M1         what the orchestrator runs after the M1 merge
//   npm run eval:match -- --live               against the real index (needs EVAL_LIVE=1)
//
// Arguments:
//   --enforce M1|M2|M4|all   invariants due at or before this phase must pass (default all)
//   --market intl|cn|all     which market's fixtures and gates (default all)
//   --suite <name>           one suite only (`invariants` = the invariants only)
//   --json <file>            also write the report as JSON
//   --write-baseline         store this run's values as the "no regression" baseline (the first one
//                            was measured before the fit contract: baselineBeforeFit.ts)
//   --live                   read the real index and call models; refuses without EVAL_LIVE=1
//                            set in the shell (the switch is never read from .env)
//   --export-audit           (with --live) write the 10% recruiter audit sample as CSV
//   --import-audit <csv>     read recruiter grades back and store the judge-human kappa
//
// What a run does:
//   1. Without --live it installs the offline guard (fetch throws "network is
//      off in eval") and pins the database URLs to a closed port.
//   2. It runs the ten invariant specs through the Vitest node API with
//      vitest.eval.config.mts and collects one result per invariant.
//   3. It runs every suite found on disk under eval/suites/*.suite.ts.
//   4. It prints one table: layer, metric, value, gate, status. Status is one of
//      pass | fail | no_fixture | not_built | untrusted | skipped_offline
//      (`pending` for an invariant due after --enforce, `info` for a value no gate reads).
//   5. It exits 1 when an invariant due at or before --enforce fails, or a
//      suite that has fixtures misses its gate. Exit 2: bad arguments or a
//      refused --live.
//
// This file imports nothing of the code under test at load time: the server
// modules are loaded by the suites and the specs, after step 1.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { fixtureFilesHash, loadBaselines } from './fixtures/load.js';
import { BaselinesFileSchema, type BaselinesFile } from './fixtures/schema.js';
import { CAREER_CHANGER_SUBSET, GATES, findGate, gateReads, gateText, judgeDistrust, rowStatus, type Gate, type GateLayer, type GateStatus, type JudgeAudit, type JudgeUse } from './gates.js';
import { ENFORCE_VALUES, INVARIANT_LIST, isEnforce, isEnforced, type Enforce, type Stage } from './invariantList.js';
import { installOfflineGuard, pinOfflineEnv } from './offline.js';
import { isSeamMissing } from './seams.js';
import { isSuite, type Suite, type SuiteContext, type SuiteMarket, type SuiteMeasure } from './suite.js';

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EVAL_DIR, '../../../../..');
export const SUITES_DIR = path.join(EVAL_DIR, 'suites');
export const FIXTURES_DIR = path.join(EVAL_DIR, 'fixtures');
/** Live artefacts (snapshots, judge cache, audit, dated reports). Git-ignored; never committed. */
export const SNAPSHOTS_DIR = path.join(EVAL_DIR, '.snapshots');
export const EVAL_CONFIG = path.join(REPO_ROOT, 'vitest.eval.config.mts');
const INVARIANTS_ENTRY = 'invariants.entry.eval';

// ── Arguments ─────────────────────────────────────────────────────────────

export interface EvalArgs {
  live: boolean;
  enforce: Enforce;
  market: SuiteMarket | 'all';
  suite: string | null;
  json: string | null;
  writeBaseline: boolean;
  exportAudit: boolean;
  importAudit: string | null;
  help: boolean;
}

export class ArgError extends Error {}

export const USAGE = [
  'Usage: npm run eval:match -- [--enforce M1|M2|M4|all] [--market intl|cn|all] [--suite <name>] [--json <file>] [--write-baseline]',
  '       npm run eval:match -- --live [--export-audit]     (needs EVAL_LIVE=1; reads the index read-only and calls models)',
  '       npm run eval:match -- --import-audit <csv>        (store the judge-human agreement of a recruiter audit)',
].join('\n');

export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { live: false, enforce: 'all', market: 'all', suite: null, json: null, writeBaseline: false, exportAudit: false, importAudit: null, help: false };
  const list = argv.filter((a) => a !== '--');
  for (let i = 0; i < list.length; i++) {
    const raw = list[i]!;
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const value = (): string => {
      const v = eq > 0 ? raw.slice(eq + 1) : list[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new ArgError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--live':
        args.live = true;
        break;
      case '--write-baseline':
        args.writeBaseline = true;
        break;
      case '--export-audit':
        args.exportAudit = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--enforce': {
        const v = value();
        if (!isEnforce(v)) throw new ArgError(`--enforce takes one of ${ENFORCE_VALUES.join(', ')} (got "${v}")`);
        args.enforce = v;
        break;
      }
      case '--market': {
        const v = value();
        if (v !== 'intl' && v !== 'cn' && v !== 'all') throw new ArgError(`--market takes intl, cn or all (got "${v}")`);
        args.market = v;
        break;
      }
      case '--suite':
        args.suite = value();
        break;
      case '--json':
        args.json = value();
        break;
      case '--import-audit':
        args.importAudit = value();
        break;
      default:
        throw new ArgError(`unknown argument ${raw}`);
    }
  }
  if (args.exportAudit && !args.live) throw new ArgError('--export-audit needs --live (the sample is drawn from the judged pairs of a live run)');
  return args;
}

export function marketsOf(market: EvalArgs['market']): SuiteMarket[] {
  return market === 'all' ? ['intl', 'cn'] : [market];
}

// ── Invariants through the Vitest node API ────────────────────────────────

export interface InvariantResult {
  id: string;
  due: Stage;
  title: string;
  /** `not_run`: Vitest reported no case for it (a file that failed to load, a renamed case). */
  outcome: 'pass' | 'fail' | 'not_run';
  reason: string | null;
}

interface TestCaseLike {
  name: string;
  meta(): Record<string, unknown>;
  result(): { state: string; errors?: ReadonlyArray<{ message?: string }> };
}
interface TestModuleLike {
  children: { allTests(): Iterable<TestCaseLike> };
  errors?(): ReadonlyArray<{ message?: string }>;
}

/** One result per invariant from what Vitest reported. Pure: the Vitest objects are passed in. */
export function collectInvariantResults(modules: Iterable<TestModuleLike>, loadErrors: string[] = []): InvariantResult[] {
  const byId = new Map<string, { outcome: 'pass' | 'fail'; reason: string | null }>();
  for (const mod of modules) {
    for (const t of mod.children.allTests()) {
      const meta = t.meta().evalInvariant as { id?: unknown; outcome?: unknown; reason?: unknown } | undefined;
      const id = typeof meta?.id === 'string' ? meta.id : (/^(INV-\d+)\b/.exec(t.name)?.[1] ?? null);
      if (!id) continue;
      if (meta && (meta.outcome === 'pass' || meta.outcome === 'fail')) {
        byId.set(id, { outcome: meta.outcome, reason: typeof meta.reason === 'string' ? meta.reason : null });
        continue;
      }
      // No meta (the case died before it could record): fall back to the case's own state.
      const r = t.result();
      byId.set(id, r.state === 'passed' ? { outcome: 'pass', reason: null } : { outcome: 'fail', reason: r.errors?.[0]?.message?.split('\n')[0] ?? `the case ended ${r.state}` });
    }
  }
  const why = loadErrors.length ? `the spec did not run: ${loadErrors.join(' | ')}` : 'the spec did not run';
  return INVARIANT_LIST.map((info) => {
    const got = byId.get(info.id);
    return { id: info.id, due: info.due, title: info.title, outcome: got?.outcome ?? 'not_run', reason: got ? got.reason : why };
  });
}

const VITEST_NODE = 'vitest/node';

/** Run the invariant entry with the eval config. Always offline: the specs are in-memory. */
export async function runInvariants(enforce: Enforce): Promise<InvariantResult[]> {
  const exitBefore = process.exitCode;
  const envBefore = process.env.EVAL_ENFORCE;
  process.env.EVAL_ENFORCE = enforce;
  const loadErrors: string[] = [];
  let modules: TestModuleLike[] = [];
  try {
    const { createVitest } = (await import(/* @vite-ignore */ VITEST_NODE)) as {
      createVitest(options: Record<string, unknown>): Promise<{
        start(filters?: string[]): Promise<{ testModules?: TestModuleLike[]; unhandledErrors?: unknown[] }>;
        close(): Promise<void>;
      }>;
    };
    // The result is read from the returned modules; Vitest's own output would only repeat the table.
    const vitest = await createVitest({ config: EVAL_CONFIG, root: REPO_ROOT, watch: false, reporters: [{}], silent: true });
    try {
      const run = await vitest.start([INVARIANTS_ENTRY]);
      modules = run.testModules ?? [];
      for (const mod of modules) for (const e of mod.errors?.() ?? []) loadErrors.push((e.message ?? 'load error').split('\n')[0]!);
      for (const e of run.unhandledErrors ?? []) loadErrors.push(String((e as { message?: unknown })?.message ?? e).split('\n')[0]!);
    } finally {
      await vitest.close();
    }
  } catch (err) {
    loadErrors.push(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  } finally {
    // The exit code is this command's decision, not Vitest's.
    process.exitCode = exitBefore;
    if (envBefore === undefined) delete process.env.EVAL_ENFORCE;
    else process.env.EVAL_ENFORCE = envBefore;
  }
  return collectInvariantResults(modules, loadErrors);
}

// ── Suites on disk ────────────────────────────────────────────────────────

const SUITE_FILE = /\.suite\.(ts|mts|js|mjs)$/;

/** Suite files of a folder, by name. A folder that does not exist has none. */
export function discoverSuites(dir: string = SUITES_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => SUITE_FILE.test(f) && !f.endsWith('.d.ts'))
    .sort()
    .map((f) => path.join(dir, f));
}

export function suiteNameOfFile(file: string): string {
  return path.basename(file).replace(SUITE_FILE, '');
}

export async function loadSuite(file: string): Promise<Suite> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
  for (const candidate of [mod, mod.default, mod.suite]) if (isSuite(candidate)) return { name: candidate.name, layer: candidate.layer, run: (ctx) => candidate.run(ctx) };
  throw new Error(`${path.basename(file)}: a suite exports name, layer and run(ctx)`);
}

export interface SuiteRun {
  file: string;
  name: string;
  layer: GateLayer | null;
  measures: SuiteMeasure[];
  /** The suite could not be loaded or threw: the command fails. */
  error: string | null;
  /** The suite stopped on a seam that does not exist yet: its gates are `not_built`. */
  notBuilt: string | null;
}

export async function runSuites(files: readonly string[], ctx: SuiteContext, only: string | null = null): Promise<SuiteRun[]> {
  const out: SuiteRun[] = [];
  for (const file of files) {
    const fileName = suiteNameOfFile(file);
    let suite: Suite;
    try {
      suite = await loadSuite(file);
    } catch (err) {
      if (only && fileName !== only) continue;
      out.push({ file, name: fileName, layer: null, measures: [], error: err instanceof Error ? err.message : String(err), notBuilt: null });
      continue;
    }
    if (only && suite.name !== only && fileName !== only) continue;
    try {
      out.push({ file, name: suite.name, layer: suite.layer, measures: await suite.run(ctx), error: null, notBuilt: null });
    } catch (err) {
      if (isSeamMissing(err)) out.push({ file, name: suite.name, layer: suite.layer, measures: [], error: null, notBuilt: err.message });
      else out.push({ file, name: suite.name, layer: suite.layer, measures: [], error: err instanceof Error ? err.message : String(err), notBuilt: null });
    }
  }
  return out;
}

// ── The report ────────────────────────────────────────────────────────────

export type RowStatus = GateStatus | 'pending' | 'info';

export interface ReportRow {
  layer: string;
  metric: string;
  value: string;
  gate: string;
  status: RowStatus;
  note?: string;
  /** The number behind `value`, for --json and --write-baseline. */
  raw?: { value: number | null; reference: number | null; n: number | null; labels: string | null; market: string | null; subset: string | null; scope: string | null; metricId: string };
}

export interface Report {
  rows: ReportRow[];
  /** One line per reason the command fails. */
  failures: string[];
  exitCode: 0 | 1;
}

export function baselineKey(layer: string, metric: string, market?: string | null, subset?: string | null, scope?: string | null): string {
  return `${layer}/${metric}/${market ?? 'all'}/${subset ?? 'all'}${scope ? `/${scope}` : ''}`;
}

function formatValue(metric: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (/_ms$/.test(metric)) return `${Math.round(value)} ms`;
  return value.toFixed(4);
}

function metricLabel(m: Pick<SuiteMeasure, 'metric' | 'market' | 'subset' | 'scope'>): string {
  return [m.metric, m.scope ? `[${m.scope}]` : '', m.market && m.market !== 'all' ? `[${m.market}]` : '', m.subset ? `[${m.subset}]` : ''].filter(Boolean).join(' ');
}

function invariantRows(results: readonly InvariantResult[], enforce: Enforce, failures: string[]): ReportRow[] {
  return results.map((r) => {
    const enforced = isEnforced(r.due, enforce);
    // A spec that did not run is a failure whatever its phase: none is ever skipped.
    const status: RowStatus = r.outcome === 'pass' ? 'pass' : r.outcome === 'not_run' || enforced ? 'fail' : 'pending';
    if (status === 'fail') failures.push(`${r.id} (due ${r.due}): ${r.reason ?? 'failed'}`);
    return { layer: 'invariant', metric: `${r.id} ${r.title}`, value: r.outcome === 'pass' ? 'holds' : r.outcome === 'not_run' ? 'not run' : 'does not hold', gate: `due ${r.due}`, status, ...(r.reason ? { note: r.reason } : {}) };
  });
}

export interface BuildReportInput {
  enforce: Enforce;
  live: boolean;
  invariants: readonly InvariantResult[];
  suites: readonly SuiteRun[];
  baselines: Record<string, number>;
  audit: JudgeAudit | null;
  /** The judge of this run (a live run that judged): an audit of another judge, or of other markets, leaves its values untrusted. */
  judge?: JudgeUse | null;
  /** False under --suite: gates of layers that were not asked for are left out. */
  listUnbuilt: boolean;
}

function referenceFor(gate: Gate, m: SuiteMeasure, layer: GateLayer, all: ReadonlyArray<SuiteMeasure & { layer: GateLayer }>, baselines: Record<string, number>): { reference: number | null; missing: string | null } {
  const sameScope = (o: SuiteMeasure) => (o.market ?? 'all') === (m.market ?? 'all') && (o.scope ?? null) === (m.scope ?? null);
  switch (gate.rule.kind) {
    case 'min':
    case 'below':
      return { reference: null, missing: null };
    case 'min_gain': {
      const over = gate.rule.over;
      const other = typeof m.reference === 'number' ? m.reference : (all.find((o) => o.layer === layer && o.metric === over && sameScope(o) && (o.subset ?? null) === (m.subset ?? null))?.value ?? null);
      return { reference: other, missing: other === null ? `${over} was not measured in this run` : null };
    }
    case 'within_relative': {
      const ofSubset = gate.rule.ofSubset;
      const ref = all.find((o) => o.layer === layer && o.metric === m.metric && sameScope(o) && o.subset === ofSubset)?.value ?? null;
      return { reference: ref, missing: ref === null ? `no ${ofSubset} subset in this run to compare with` : null };
    }
    case 'no_regression':
    case 'max_increase': {
      const ref = baselines[baselineKey(layer, m.metric, m.market, m.subset, m.scope)];
      return typeof ref === 'number' ? { reference: ref, missing: null } : { reference: null, missing: 'no stored baseline yet (run with --write-baseline once the result is accepted)' };
    }
  }
}

/** Every row of the table and the exit code. Pure. */
export function buildReport(input: BuildReportInput): Report {
  const failures: string[] = [];
  const rows: ReportRow[] = invariantRows(input.invariants, input.enforce, failures);
  const measures = input.suites.flatMap((s) => (s.layer ? s.measures.map((m) => ({ ...m, layer: m.layer ?? s.layer! })) : []));

  for (const s of input.suites) {
    if (s.error) {
      failures.push(`suite ${s.name}: ${s.error}`);
      rows.push({ layer: s.layer ?? 'suite', metric: `${s.name} suite`, value: 'error', gate: '-', status: 'fail', note: s.error });
    }
  }

  // A judged value is trusted only by an audit of the judge that graded it, covering the market it is reported for.
  const judgeOf = (m: SuiteMeasure): JudgeUse => ({ judgeModel: input.judge?.judgeModel ?? null, promptVersion: input.judge?.promptVersion ?? null, market: m.market ?? 'all', markets: input.judge?.markets ?? [] });
  const distrust = (m: SuiteMeasure): string | null => judgeDistrust(input.audit, judgeOf(m));

  for (const m of measures) {
    const gate = findGate(m.layer, m.metric);
    const applies = !!gate && gateReads(gate, m.subset);
    const details = [formatValue(m.metric, m.value), typeof m.n === 'number' ? `n=${m.n}` : '', m.labels && m.labels !== 'none' ? `${m.labels} labels` : ''].filter(Boolean).join('  ');
    const raw = { value: m.value, reference: null as number | null, n: m.n ?? null, labels: m.labels ?? null, market: m.market ?? null, subset: m.subset ?? null, scope: m.scope ?? null, metricId: m.metric };
    if (!gate || !applies) {
      // No gate reads this value; one computed from judge labels is still marked until the audit passes.
      const why = m.labels === 'judged' ? distrust(m) : null;
      const status: RowStatus = m.status ?? (why ? 'untrusted' : 'info');
      const notGated = !!gate && m.subset === CAREER_CHANGER_SUBSET;
      const notes = [m.note, status === 'untrusted' ? `judge labels are untrusted: ${why}` : null].filter(Boolean);
      rows.push({ layer: m.layer, metric: metricLabel(m), value: details, gate: !gate ? '-' : notGated ? 'not gated' : 'reference subset', status, ...(notes.length ? { note: notes.join('; ') } : {}), raw });
      continue;
    }
    const ref = referenceFor(gate, m, m.layer, measures, input.baselines);
    raw.reference = ref.reference;
    const status = rowStatus(gate, { value: m.value, reference: ref.reference, status: m.status, labels: m.labels }, { live: input.live, audit: input.audit, judge: judgeOf(m) });
    const notes = [m.note, status === 'no_fixture' && !m.status ? ref.missing : null, status === 'untrusted' ? `judge labels are untrusted: ${distrust(m)}` : null].filter(Boolean);
    if (status === 'fail') failures.push(`${m.layer} ${metricLabel(m)} = ${formatValue(m.metric, m.value)} misses its gate (${gateText(gate)}${ref.reference !== null ? `; compared with ${formatValue(m.metric, ref.reference)}` : ''})`);
    rows.push({ layer: m.layer, metric: metricLabel(m), value: details, gate: gateText(gate), status, ...(notes.length ? { note: notes.join('; ') } : {}), raw });
  }

  if (input.listUnbuilt) {
    const builtLayers = new Map<GateLayer, SuiteRun>();
    for (const s of input.suites) if (s.layer) builtLayers.set(s.layer, s);
    for (const gate of GATES) {
      if (measures.some((m) => m.layer === gate.layer && m.metric === gate.metric)) continue;
      const suite = builtLayers.get(gate.layer);
      if (suite?.error) continue;
      const note = !suite ? 'no suite for this layer yet' : (suite.notBuilt ?? `the ${suite.name} suite does not report this metric yet`);
      rows.push({ layer: gate.layer, metric: gate.metric, value: 'n/a', gate: gateText(gate), status: 'not_built', note });
    }
  }
  return { rows, failures, exitCode: failures.length ? 1 : 0 };
}

export function renderTable(rows: readonly ReportRow[]): string {
  const head = ['layer', 'metric', 'value', 'gate', 'status'];
  const cells = rows.map((r) => [r.layer, r.metric, r.value, r.gate, r.status]);
  const width = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((x, i) => x.padEnd(width[i]!)).join('  ').trimEnd();
  const out = [line(head), width.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)];
  // Failing rows are listed with their reasons under "Failing"; rows that share a note are said once.
  const grouped = new Map<string, { status: string; layer: string; note: string; metrics: string[] }>();
  for (const r of rows) {
    if (!r.note || r.status === 'fail') continue;
    const key = `${r.status}|${r.layer}|${r.note}`;
    const g = grouped.get(key) ?? { status: r.status, layer: r.layer, note: r.note, metrics: [] };
    g.metrics.push(r.layer === 'invariant' ? (r.metric.split(' ')[0] ?? r.metric) : r.metric);
    grouped.set(key, g);
  }
  if (grouped.size) {
    out.push('', 'Notes');
    for (const g of grouped.values()) out.push(`- [${g.status}] ${g.layer} ${g.metrics.join(', ')}: ${g.note}`);
  }
  return out.join('\n');
}

// ── Baselines and the audit file ──────────────────────────────────────────

export const LIVE_BASELINES_FILE = 'baselines.live.json';
export const AUDIT_FILE = 'audit.json';

function readJsonIfThere(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Why the committed fixture baseline cannot be compared with this run, or
 * null. A baseline records the hash of the fixtures it was measured on; after
 * the fixtures are regenerated its values are for other labels.
 */
export function staleBaselineReason(fixturesDir: string = FIXTURES_DIR): string | null {
  const file = loadBaselines(fixturesDir);
  if (!file?.fixturesHash) return null;
  const now = fixtureFilesHash(fixturesDir);
  return now === file.fixturesHash ? null : 'fixtures/baselines.json was measured on other fixtures (the fixture files changed since): its values are not compared. Write it again with --write-baseline once the result is accepted.';
}

/** Fixture baselines (committed) and, under --live, the live baselines of this machine (git-ignored). */
export function readBaselines(live: boolean, fixturesDir: string = FIXTURES_DIR, snapshotsDir: string = SNAPSHOTS_DIR): Record<string, number> {
  const values: Record<string, number> = staleBaselineReason(fixturesDir) ? {} : { ...(loadBaselines(fixturesDir)?.values ?? {}) };
  if (live) {
    const parsed = BaselinesFileSchema.safeParse(readJsonIfThere(path.join(snapshotsDir, LIVE_BASELINES_FILE)));
    if (parsed.success) Object.assign(values, parsed.data.values);
  }
  return values;
}

export function readAudit(snapshotsDir: string = SNAPSHOTS_DIR): JudgeAudit | null {
  const raw = readJsonIfThere(path.join(snapshotsDir, AUDIT_FILE)) as { kappa?: unknown; pairs?: unknown; judgeModel?: unknown; promptVersion?: unknown; markets?: unknown } | null;
  if (!raw || typeof raw !== 'object') return null;
  const markets: Record<string, number> = {};
  if (raw.markets && typeof raw.markets === 'object') for (const [k, v] of Object.entries(raw.markets as Record<string, unknown>)) if (typeof v === 'number' && v > 0) markets[k] = v;
  return {
    kappa: typeof raw.kappa === 'number' ? raw.kappa : null,
    pairs: typeof raw.pairs === 'number' ? raw.pairs : 0,
    // An audit stored without these says nothing about which judge it audited: it trusts no judge.
    judgeModel: typeof raw.judgeModel === 'string' ? raw.judgeModel : null,
    promptVersion: typeof raw.promptVersion === 'string' ? raw.promptVersion : null,
    markets,
  };
}

/** The values a baseline file stores: every measured value whose gate compares with a stored baseline. */
export function baselineValues(rows: readonly ReportRow[], live: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.raw || typeof r.raw.value !== 'number' || !Number.isFinite(r.raw.value)) continue;
    const gate = findGate(r.layer as GateLayer, r.raw.metricId);
    if (!gate || !gateReads(gate, r.raw.subset) || (gate.rule.kind !== 'no_regression' && gate.rule.kind !== 'max_increase')) continue;
    // A live run stores its own values only; a fixture run never stores a live one.
    if ((r.raw.scope === 'live') !== live) continue;
    out[baselineKey(r.layer, r.raw.metricId, r.raw.market, r.raw.subset, r.raw.scope)] = Math.round(r.raw.value * 1e6) / 1e6;
  }
  return out;
}

export const BASELINE_COMMAND = 'npm run eval:match -- --write-baseline';

export interface BaselineStamp {
  /** The command that wrote the file. */
  generatedBy?: string;
  /** What the values were measured on, in words. */
  source?: string;
  /** Hash of the fixture files the values were measured on (fixture baselines only). */
  fixturesHash?: string;
}

export function writeBaselines(file: string, values: Record<string, number>, now: Date, stamp: BaselineStamp = {}): BaselinesFile {
  const before = BaselinesFileSchema.safeParse(readJsonIfThere(file));
  // Values measured on other fixtures are for other labels: they are dropped, never merged.
  const keep = before.success && (before.data.fixturesHash ?? null) === (stamp.fixturesHash ?? null) ? before.data.values : {};
  const merged = { ...keep, ...values };
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]!]));
  const data: BaselinesFile = {
    _generatedBy: stamp.generatedBy ?? BASELINE_COMMAND,
    writtenAt: now.toISOString(),
    ...(stamp.source ? { source: stamp.source } : {}),
    ...(stamp.fixturesHash ? { fixturesHash: stamp.fixturesHash } : {}),
    values: sorted,
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

// ── main ──────────────────────────────────────────────────────────────────

export interface MainIo {
  log: (line: string) => void;
  error: (line: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

/** The switch is read from the command's own environment before anything is loaded; an `.env` entry does not turn live mode on. */
export const LIVE_REFUSAL =
  'Refusing --live: set EVAL_LIVE=1 in the shell for this command (EVAL_LIVE=1 npm run eval:match -- --live). It is not read from .env. Live mode reads the database (read-only) and calls models. Nothing was read.';

/**
 * Live mode only. Model keys, the database URL and EVAL_JUDGE_MODEL may live
 * in the local .env files: they are loaded here, in one place, before anything
 * reads them (server/.env, then the repository's .env, as lib/prisma.ts does;
 * a value already set in the shell wins). EVAL_LIVE was checked before this
 * and is never read from a file.
 */
export function loadLocalEnvForLive(root: string = REPO_ROOT): void {
  dotenv.config({ path: path.join(root, 'server', '.env'), override: false, quiet: true });
  dotenv.config({ path: path.join(root, '.env'), override: false, quiet: true });
}

const defaultIo: MainIo = { log: (l) => console.log(l), error: (l) => console.error(l), env: process.env, now: () => new Date() };

export async function main(argv: readonly string[], io: MainIo = defaultIo): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.error(err instanceof ArgError ? err.message : String(err));
    io.error(USAGE);
    return 2;
  }
  if (args.help) {
    io.log(USAGE);
    return 0;
  }
  if (args.live && io.env.EVAL_LIVE !== '1') {
    io.error(LIVE_REFUSAL);
    return 2;
  }
  if (!args.live) {
    pinOfflineEnv(io.env);
    installOfflineGuard();
  } else if (io.env === process.env) loadLocalEnvForLive();
  const now = io.now();

  // The recruiter audit comes back as a file: no database and no model is needed to read it.
  if (args.importAudit) {
    const { importAudit } = await import('./live/audit.js');
    const result = importAudit({ csvFile: path.resolve(args.importAudit), snapshotsDir: SNAPSHOTS_DIR, now });
    const marketsText = Object.entries(result.markets).map(([m, n]) => `${m} ${n}`).join(', ') || 'no market recorded';
    io.log(`Audit stored: ${result.pairs} graded pairs (${marketsText}) of judge ${result.judgeModel ?? 'unknown'}, prompt ${result.promptVersion ?? 'unknown'}; judge-human quadratic-weighted kappa ${result.kappa === null ? 'n/a' : result.kappa.toFixed(3)}.`);
    io.log(result.trusted ? 'Values this judge grades in those markets are trusted.' : `Judge labels stay untrusted: ${result.distrust}.`);
    return 0;
  }

  const ctx: SuiteContext = { markets: marketsOf(args.market), live: args.live, repoRoot: REPO_ROOT, evalDir: EVAL_DIR, fixturesDir: FIXTURES_DIR, now };
  const wantInvariants = !args.suite || args.suite === 'invariants';
  const invariants = wantInvariants ? await runInvariants(args.enforce) : [];
  const suites = args.suite === 'invariants' ? [] : await runSuites(discoverSuites(SUITES_DIR), ctx, args.suite);
  if (args.suite && args.suite !== 'invariants' && !suites.length) {
    io.error(`No suite named "${args.suite}" under eval/suites/ (found: ${discoverSuites(SUITES_DIR).map(suiteNameOfFile).join(', ') || 'none'}).`);
    return 2;
  }

  let liveNote: string | null = null;
  let liveFinish: ((report: Report, audit: JudgeAudit | null) => string) | null = null;
  let judge: JudgeUse | null = null;
  if (args.live) {
    const { runLive } = await import('./live/index.js');
    const live = await runLive({ exportAudit: args.exportAudit, ctx, snapshotsDir: SNAPSHOTS_DIR, env: io.env, log: io.log });
    suites.push(...live.suites);
    liveFinish = live.finish;
    liveNote = live.note;
    judge = live.judge;
  }

  const audit = readAudit();
  const stale = staleBaselineReason();
  const report = buildReport({ enforce: args.enforce, live: args.live, invariants, suites, baselines: readBaselines(args.live), audit, judge, listUnbuilt: !args.suite });
  io.log(`Match evaluation: ${args.live ? 'LIVE (real index, models called)' : 'fixtures only (synthetic personas and postings, constructed labels; no network, no database)'}; invariants enforced through ${args.enforce}; market ${args.market}.`);
  io.log('');
  io.log(renderTable(report.rows));
  if (stale) io.log(`\n${stale}`);
  if (liveNote) io.log(`\n${liveNote}`);
  if (liveFinish) io.log(`Dated report: ${path.relative(REPO_ROOT, liveFinish(report, audit))}`);

  if (args.writeBaseline) {
    const file = args.live ? path.join(SNAPSHOTS_DIR, LIVE_BASELINES_FILE) : path.join(FIXTURES_DIR, 'baselines.json');
    const values = baselineValues(report.rows, args.live);
    if (Object.keys(values).length) {
      writeBaselines(file, values, now, args.live ? { source: 'a live run on this machine' } : { source: 'the fit order of this checkout (getFits) on the committed fixtures', fixturesHash: fixtureFilesHash(FIXTURES_DIR) });
      io.log(`\nBaseline written: ${Object.keys(values).length} value(s) to ${path.relative(REPO_ROOT, file)}.`);
    } else io.log('\nNo baseline written: this run measured no value that is compared with a stored baseline.');
  }
  if (args.json) {
    const file = path.resolve(args.json);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: now.toISOString(), mode: args.live ? 'live' : 'fixtures', enforce: args.enforce, market: args.market, exitCode: report.exitCode, failures: report.failures, invariants, rows: report.rows }, null, 2)}\n`);
  }
  if (report.failures.length) {
    io.log('\nFailing');
    for (const f of report.failures) io.log(`- ${f}`);
  }
  io.log(`\n${report.exitCode === 0 ? 'OK' : 'FAILED'}: exit ${report.exitCode}.`);
  return report.exitCode;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return !!entry && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
