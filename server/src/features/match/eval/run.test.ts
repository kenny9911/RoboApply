// @vitest-environment node
// MKT-1D — the runner: arguments, suite discovery, the status of every row,
// the exit-code rules and the offline guard. No network, no database; Vitest
// is not started from inside Vitest (the collection of results is tested on
// plain objects).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BEFORE_FIT_COMMAND, BaselineRefused, writeBaselineBeforeFit } from './baselineBeforeFit.js';
import { fixtureFilesHash } from './fixtures/load.js';
import { INVARIANT_LIST, isEnforced, parseEnforce } from './invariantList.js';
import { INVARIANTS } from './invariantSpecs.js';
import { OFFLINE_MESSAGE, countNetworkAttempts, installOfflineGuard, offlineAttempts, offlineGuardInstalled, removeOfflineGuard, resetOfflineAttempts } from './offline.js';
import {
  ArgError,
  FIXTURES_DIR,
  SUITES_DIR,
  baselineKey,
  baselineValues,
  buildReport,
  collectInvariantResults,
  discoverSuites,
  loadLocalEnvForLive,
  loadSuite,
  main,
  marketsOf,
  parseArgs,
  readBaselines,
  renderTable,
  runSuites,
  staleBaselineReason,
  suiteNameOfFile,
  writeBaselines,
  type BuildReportInput,
  type InvariantResult,
  type SuiteRun,
} from './run.js';
import { EVAL_DIR, REPO_ROOT, SEAMS, SeamMissing, setFitModuleForTests } from './seams.js';
import type { SuiteContext } from './suite.js';
import { categoryPrecision, readLabelledTitles } from './suites/taxonomy.suite.js';

afterEach(() => {
  setFitModuleForTests(null);
  removeOfflineGuard();
});

const tmp = (name: string) => mkdtempSync(path.join(tmpdir(), `eval-${name}-`));
const ctx = (over: Partial<SuiteContext> = {}): SuiteContext => ({ markets: ['intl', 'cn'], live: false, repoRoot: REPO_ROOT, evalDir: EVAL_DIR, fixturesDir: FIXTURES_DIR, now: new Date('2026-10-01T12:00:00Z'), ...over });

const inv = (over: Partial<InvariantResult> & { id: string }): InvariantResult => {
  const info = INVARIANT_LIST.find((i) => i.id === over.id)!;
  return { due: info.due, title: info.title, outcome: 'pass', reason: null, ...over };
};
const allPass = (): InvariantResult[] => INVARIANT_LIST.map((i) => inv({ id: i.id }));
const report = (over: Partial<BuildReportInput>) => buildReport({ enforce: 'all', live: false, invariants: [], suites: [], baselines: {}, audit: null, listUnbuilt: false, ...over });
const suite = (over: Partial<SuiteRun>): SuiteRun => ({ file: 'x.suite.ts', name: 'x', layer: 'taxonomy', measures: [], error: null, notBuilt: null, ...over });

describe('parseArgs', () => {
  it('defaults: offline, every invariant enforced, both markets', () => {
    expect(parseArgs([])).toEqual({ live: false, enforce: 'all', market: 'all', suite: null, json: null, writeBaseline: false, exportAudit: false, importAudit: null, help: false });
  });

  it('reads every argument, in both spellings, and ignores the npm separator', () => {
    expect(parseArgs(['--', '--enforce', 'M1'])).toMatchObject({ enforce: 'M1' });
    expect(parseArgs(['--enforce=M4', '--market=cn', '--suite', 'ranking', '--json', 'out/r.json', '--write-baseline'])).toMatchObject({
      enforce: 'M4',
      market: 'cn',
      suite: 'ranking',
      json: 'out/r.json',
      writeBaseline: true,
    });
    expect(parseArgs(['--live', '--export-audit'])).toMatchObject({ live: true, exportAudit: true });
    expect(parseArgs(['--import-audit', 'graded.csv']).importAudit).toBe('graded.csv');
    expect(parseArgs(['-h']).help).toBe(true);
    expect(marketsOf('all')).toEqual(['intl', 'cn']);
    expect(marketsOf('cn')).toEqual(['cn']);
  });

  it('refuses what it does not know', () => {
    expect(() => parseArgs(['--enforce', 'M3'])).toThrow(ArgError);
    expect(() => parseArgs(['--enforce'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--market', 'tw'])).toThrow(/intl, cn or all/);
    expect(() => parseArgs(['--suite', '--live'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--export-audit'])).toThrow(/needs --live/);
  });

  it('the stage order is M1, M2, M4', () => {
    expect(isEnforced('M1', 'M1')).toBe(true);
    expect(isEnforced('M2', 'M1')).toBe(false);
    expect(isEnforced('M4', 'M2')).toBe(false);
    expect(isEnforced('M2', 'M4')).toBe(true);
    expect(isEnforced('M4', 'all')).toBe(true);
    expect(parseEnforce('M2')).toBe('M2');
    expect(parseEnforce(undefined)).toBe('all');
    expect(parseEnforce('nonsense')).toBe('all');
  });
});

describe('the invariant list', () => {
  it('names ten invariants with the due phases of the plan', () => {
    expect(INVARIANT_LIST.map((i) => i.id)).toEqual(Array.from({ length: 10 }, (_, i) => `INV-${i + 1}`));
    const due = (stage: string) => INVARIANT_LIST.filter((i) => i.due === stage).map((i) => Number(i.id.slice(4)));
    expect(due('M1')).toEqual([1, 2, 4, 5, 6, 8, 9, 10]);
    expect(due('M2')).toEqual([3]);
    expect(due('M4')).toEqual([7]);
    expect(INVARIANTS.map((i) => i.id)).toEqual(INVARIANT_LIST.map((i) => i.id));
    for (const i of INVARIANTS) expect(typeof i.run).toBe('function');
  });

  it('collects one result per invariant from what Vitest reported', () => {
    const test = (name: string, meta: Record<string, unknown>, state = 'passed', message?: string) => ({ name, meta: () => meta, result: () => ({ state, errors: message ? [{ message }] : [] }) });
    const modules = [
      {
        children: {
          allTests: () => [
            test('INV-1 a', { evalInvariant: { id: 'INV-1', outcome: 'fail', reason: 'SeamMissing: x#y' } }, 'failed', 'ignored'),
            // Pending: the case passed for Vitest, the recorded outcome is what counts.
            test('INV-3 b [pending until M2]', { evalInvariant: { id: 'INV-3', outcome: 'fail', reason: 'feed_card missing' } }),
            test('INV-5 c', { evalInvariant: { id: 'INV-5', outcome: 'pass', reason: null } }),
            // No meta: the case's own state is used.
            test('INV-6 d', {}, 'failed', 'boom\nstack'),
            test('INV-9 e', {}),
            test('something else', {}),
          ],
        },
      },
    ];
    const results = collectInvariantResults(modules);
    expect(results).toHaveLength(10);
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(by['INV-1']).toMatchObject({ outcome: 'fail', reason: 'SeamMissing: x#y', due: 'M1' });
    expect(by['INV-3']).toMatchObject({ outcome: 'fail', reason: 'feed_card missing', due: 'M2' });
    expect(by['INV-5']).toMatchObject({ outcome: 'pass', reason: null });
    expect(by['INV-6']).toMatchObject({ outcome: 'fail', reason: 'boom' });
    expect(by['INV-9']).toMatchObject({ outcome: 'pass' });
    // Never skipped silently: an invariant Vitest did not report is "not run", with the load error.
    expect(by['INV-2']).toMatchObject({ outcome: 'not_run' });
    expect(collectInvariantResults([], ['cannot load entry'])[0]!.reason).toContain('cannot load entry');
  });
});

describe('suite discovery', () => {
  it('finds *.suite files of a folder by name and nothing else', () => {
    const dir = tmp('suites');
    for (const f of ['b.suite.ts', 'a.suite.mjs', 'helper.ts', 'c.suite.d.ts', 'notes.md', 'd.suite.json']) writeFileSync(path.join(dir, f), '');
    expect(discoverSuites(dir).map((f) => path.basename(f))).toEqual(['a.suite.mjs', 'b.suite.ts']);
    expect(discoverSuites(path.join(dir, 'missing'))).toEqual([]);
    expect(suiteNameOfFile('/x/retrieval.suite.ts')).toBe('retrieval');
  });

  it('the shipped suites are taxonomy, ranking and language', () => {
    expect(discoverSuites(SUITES_DIR).map(suiteNameOfFile)).toEqual(['language', 'ranking', 'taxonomy']);
  });

  it('loads a suite a later bundle drops in, and runs it without editing the runner', async () => {
    const dir = tmp('dropin');
    writeFileSync(path.join(dir, 'skills.suite.mjs'), "export const name = 'skills';\nexport const layer = 'skills';\nexport async function run(ctx) { return [{ metric: 'precision_not_shown', value: 0.97, n: 100, labels: 'human', market: ctx.markets[0] }]; }\n");
    writeFileSync(path.join(dir, 'viaDefault.suite.mjs'), "export default { name: 'viaDefault', layer: 'scorer', run: async () => [] };\n");
    writeFileSync(path.join(dir, 'broken.suite.mjs'), 'export const name = 1;\n');
    writeFileSync(path.join(dir, 'throws.suite.mjs'), "export const name = 'throws';\nexport const layer = 'retrieval';\nexport async function run() { throw new Error('index out of range'); }\n");
    const files = discoverSuites(dir);
    expect((await loadSuite(files.find((f) => f.includes('skills'))!)).name).toBe('skills');
    const runs = await runSuites(files, ctx());
    const by = Object.fromEntries(runs.map((r) => [r.name, r]));
    expect(by.skills).toMatchObject({ layer: 'skills', error: null, measures: [{ metric: 'precision_not_shown', value: 0.97, market: 'intl' }] });
    expect(by.viaDefault).toMatchObject({ layer: 'scorer', measures: [] });
    expect(by.broken!.error).toMatch(/exports name, layer and run/);
    expect(by.throws!.error).toBe('index out of range');
    // --suite keeps one.
    expect((await runSuites(files, ctx(), 'skills')).map((r) => r.name)).toEqual(['skills']);
    // A suite that fails to load or throws fails the command.
    expect(report({ suites: runs }).exitCode).toBe(1);
    expect(report({ suites: [by.skills!] })).toMatchObject({ exitCode: 0 });
    expect(report({ suites: [by.skills!] }).rows[0]).toMatchObject({ layer: 'skills', status: 'pass', gate: '>= 0.95' });
  });

  it('a suite that stops on a missing seam is not_built, not an error', async () => {
    const run: SuiteRun = suite({ name: 'retrieval', layer: 'retrieval', notBuilt: new SeamMissing('server/src/features/feed/hybridSql.ts#lexicalLegSql').message });
    const r = report({ suites: [run], listUnbuilt: true });
    expect(r.exitCode).toBe(0);
    const row = r.rows.find((x) => x.layer === 'retrieval')!;
    expect(row.status).toBe('not_built');
    expect(row.note).toContain('hybridSql.ts#lexicalLegSql');
  });
});

describe('exit-code rules', () => {
  it('an enforced failing invariant exits 1 and is named with its reason', () => {
    const r = report({ enforce: 'M1', invariants: [...allPass().filter((i) => i.id !== 'INV-1'), inv({ id: 'INV-1', outcome: 'fail', reason: 'SeamMissing: server/src/features/match/fit.ts#getFits' })] });
    expect(r.exitCode).toBe(1);
    expect(r.failures).toEqual(['INV-1 (due M1): SeamMissing: server/src/features/match/fit.ts#getFits']);
    expect(r.rows.find((x) => x.metric.startsWith('INV-1 '))).toMatchObject({ layer: 'invariant', status: 'fail', gate: 'due M1', value: 'does not hold' });
  });

  it('an invariant due after --enforce is pending: reported, exit 0', () => {
    const invariants = [...allPass().filter((i) => !['INV-3', 'INV-7'].includes(i.id)), inv({ id: 'INV-3', outcome: 'fail', reason: 'feed_card not wired' }), inv({ id: 'INV-7', outcome: 'fail', reason: 'no state' })];
    const m1 = report({ enforce: 'M1', invariants });
    expect(m1.exitCode).toBe(0);
    expect(m1.rows.filter((x) => x.status === 'pending').map((x) => x.metric.split(' ')[0])).toEqual(['INV-3', 'INV-7']);
    expect(m1.rows.find((x) => x.metric.startsWith('INV-3 '))!.note).toBe('feed_card not wired');
    // After M2 the same result fails for INV-3 and INV-7 is still pending.
    const m2 = report({ enforce: 'M2', invariants });
    expect(m2.exitCode).toBe(1);
    expect(m2.failures).toEqual(['INV-3 (due M2): feed_card not wired']);
    expect(report({ enforce: 'all', invariants }).failures).toHaveLength(2);
  });

  it('an invariant that did not run fails whatever its phase (none is ever skipped)', () => {
    const r = report({ enforce: 'M1', invariants: [inv({ id: 'INV-7', outcome: 'not_run', reason: 'the spec did not run' })] });
    expect(r.exitCode).toBe(1);
    expect(r.rows[0]).toMatchObject({ status: 'fail', value: 'not run' });
  });

  it('a suite without its fixture is no_fixture and exits 0', () => {
    const r = report({ invariants: allPass(), suites: [suite({ name: 'taxonomy', measures: [{ metric: 'category_precision', market: 'intl', value: null, status: 'no_fixture', note: 'labelledTitles.intl.json is not on disk yet' }] })] });
    expect(r.exitCode).toBe(0);
    expect(r.rows.at(-1)).toMatchObject({ layer: 'taxonomy', metric: 'category_precision [intl]', value: 'n/a', status: 'no_fixture' });
  });

  it('a suite that has fixtures and misses its gate exits 1; at the gate it passes', () => {
    const miss = report({ suites: [suite({ name: 'taxonomy', measures: [{ metric: 'category_precision', market: 'cn', value: 0.9312, n: 290, labels: 'human' }] })] });
    expect(miss.exitCode).toBe(1);
    expect(miss.failures[0]).toBe('taxonomy category_precision [cn] = 0.9312 misses its gate (>= 0.95)');
    expect(miss.rows[0]).toMatchObject({ value: '0.9312  n=290  human labels', status: 'fail' });
    expect(report({ suites: [suite({ measures: [{ metric: 'category_precision', market: 'cn', value: 0.95 }] })] }).exitCode).toBe(0);
  });

  it('a gate whose layer has no suite yet prints not_built and does not fail', () => {
    const r = report({ invariants: allPass(), listUnbuilt: true });
    expect(r.exitCode).toBe(0);
    const layers = new Set(r.rows.filter((x) => x.status === 'not_built').map((x) => x.layer));
    expect(layers).toEqual(new Set(['retrieval', 'ranking', 'estimate_vs_ai', 'scorer', 'taxonomy', 'skills', 'language', 'latency']));
    expect(r.rows.find((x) => x.layer === 'skills')!.note).toBe('no suite for this layer yet');
    // Under --suite the other layers are left out.
    expect(report({ invariants: [], listUnbuilt: false }).rows).toEqual([]);
  });

  it('ranking: no baseline yet is not a failure; a regression against the stored baseline is', () => {
    const ranking = (value: number): SuiteRun => suite({ name: 'ranking', layer: 'ranking', measures: [{ metric: 'ndcg_at_10', market: 'intl', value, n: 40, labels: 'constructed' }] });
    const first = report({ suites: [ranking(0.8)] });
    expect(first.exitCode).toBe(0);
    expect(first.rows[0]).toMatchObject({ status: 'no_fixture' });
    expect(first.rows[0]!.note).toContain('no stored baseline yet');
    const key = baselineKey('ranking', 'ndcg_at_10', 'intl');
    expect(key).toBe('ranking/ndcg_at_10/intl/all');
    expect(report({ suites: [ranking(0.8)], baselines: { [key]: 0.8 } }).rows[0]!.status).toBe('pass');
    expect(report({ suites: [ranking(0.85)], baselines: { [key]: 0.8 } }).exitCode).toBe(0);
    const worse = report({ suites: [ranking(0.79)], baselines: { [key]: 0.8 } });
    expect(worse.exitCode).toBe(1);
    expect(worse.failures[0]).toContain('compared with 0.8000');
  });

  it('language: each gated subset is held against the English subset of the same run', () => {
    const lang = (values: Record<string, number>): SuiteRun =>
      suite({ name: 'language', layer: 'language', measures: Object.entries(values).map(([subset, value]) => ({ metric: 'ndcg_at_10', market: 'all' as const, subset, value, labels: 'constructed' as const })) });
    const ok = report({ suites: [lang({ en: 0.8, 'zh-TW': 0.75, 'zh-CN': 0.72, cross: 0.9 })] });
    expect(ok.exitCode).toBe(0);
    expect(ok.rows.map((r) => [r.metric, r.status])).toEqual([
      ['ndcg_at_10 [en]', 'info'],
      ['ndcg_at_10 [zh-TW]', 'pass'],
      ['ndcg_at_10 [zh-CN]', 'pass'],
      ['ndcg_at_10 [cross]', 'pass'],
    ]);
    const bad = report({ suites: [lang({ en: 0.8, 'zh-CN': 0.7 })] });
    expect(bad.exitCode).toBe(1);
    expect(bad.failures[0]).toContain('language ndcg_at_10 [zh-CN] = 0.7000');
    // Only GoApply selected: there is no English subset, so nothing can be compared and nothing fails.
    const alone = report({ suites: [lang({ 'zh-CN': 0.7 })] });
    expect(alone.exitCode).toBe(0);
    expect(alone.rows[0]).toMatchObject({ status: 'no_fixture' });
    expect(alone.rows[0]!.note).toContain('no en subset');
  });

  it('a live-only gate is skipped offline, and judge labels are untrusted without the audit', () => {
    const latency = suite({ name: 'latency', layer: 'latency', measures: [{ metric: 'feed_p95_ms', market: 'intl', scope: 'live', value: 900 }] });
    expect(report({ suites: [latency] }).rows[0]).toMatchObject({ status: 'skipped_offline', value: '900 ms' });
    const judged = suite({ name: 'live ranking', layer: 'ranking', measures: [{ metric: 'ndcg_at_10', market: 'intl', scope: 'live', value: 0.1, labels: 'judged' }] });
    const liveBaseline = { [baselineKey('ranking', 'ndcg_at_10', 'intl', null, 'live')]: 0.9 };
    const untrusted = report({ live: true, suites: [judged], baselines: liveBaseline });
    expect(untrusted.exitCode).toBe(0);
    expect(untrusted.rows[0]).toMatchObject({ metric: 'ndcg_at_10 [live] [intl]', status: 'untrusted' });
    expect(untrusted.rows[0]!.note).toContain('no recruiter audit has been imported');
    const audit = { kappa: 0.7, pairs: 50, judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: { intl: 50 } };
    const judge = { judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: ['intl'] };
    const trusted = report({ live: true, suites: [judged], audit, judge, baselines: liveBaseline });
    expect(trusted.exitCode).toBe(1);
    // A live value is never compared with a fixture baseline.
    expect(report({ live: true, suites: [judged], audit, judge, baselines: { [baselineKey('ranking', 'ndcg_at_10', 'intl')]: 0.9 } }).rows[0]!.status).toBe('no_fixture');
  });

  it('an audit trusts only the judge it audited, in the markets it holds pairs of', () => {
    const judged = (market: 'intl' | 'cn' | 'all', subset?: string) =>
      suite({ name: 'live ranking', layer: subset ? 'language' : 'ranking', measures: [{ metric: 'ndcg_at_10', market, ...(subset ? { subset } : {}), scope: 'live', value: 0.5, labels: 'judged' }] });
    const audit = { kappa: 0.8, pairs: 60, judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: { intl: 60 } };
    const judge = { judgeModel: 'vendor/judge-large', promptVersion: 'judge_v1', markets: ['intl', 'cn'] };
    const status = (over: Partial<BuildReportInput>) => {
      const row = report({ live: true, suites: [judged('intl')], audit, judge, ...over }).rows[0]!;
      return [row.status, row.note ?? ''] as const;
    };
    // The same judge, its market: trusted (no baseline yet, so the value is printed, not failed).
    expect(status({})[0]).toBe('no_fixture');
    // Another judge model, or the prompt changed since the audit: the old agreement says nothing.
    expect(status({ judge: { ...judge, judgeModel: 'vendor/judge-other' } })).toEqual(['untrusted', expect.stringContaining('the audit is of judge model vendor/judge-large, this run used vendor/judge-other')]);
    expect(status({ judge: { ...judge, promptVersion: 'judge_v2' } })).toEqual(['untrusted', expect.stringContaining('the audit is of judge prompt judge_v1, this run used judge_v2')]);
    // An audit of RoboApply pairs does not trust a GoApply value, nor a value over both markets.
    expect(status({ suites: [judged('cn')] })).toEqual(['untrusted', expect.stringContaining('no graded pair of market cn')]);
    expect(status({ suites: [judged('all', 'zh-CN')] })).toEqual(['untrusted', expect.stringContaining('no graded pair of market cn')]);
    expect(status({ suites: [judged('all', 'zh-CN')], audit: { ...audit, markets: { intl: 30, cn: 30 } } })[0]).not.toBe('untrusted');
    // Too few graded pairs, a low kappa, an audit that does not say whose grades it checked, no judge named by the run.
    expect(status({ audit: { ...audit, pairs: 3, kappa: 1 } })).toEqual(['untrusted', expect.stringContaining('3 graded pairs; 30 are needed')]);
    expect(status({ audit: { ...audit, kappa: 0.59 } })).toEqual(['untrusted', expect.stringContaining('0.590; 0.6 is needed')]);
    expect(status({ audit: { kappa: 0.9, pairs: 80 } })[0]).toBe('untrusted');
    expect(status({ judge: null })[0]).toBe('untrusted');
    // The English reference row of the language layer has no gate; it is still marked.
    expect(report({ live: true, suites: [judged('all', 'en')], audit, judge }).rows[0]).toMatchObject({ gate: 'reference subset', status: 'untrusted' });
  });

  it('career changers are printed and never gated or stored as a baseline', () => {
    const ranking = suite({
      name: 'ranking',
      layer: 'ranking',
      measures: [
        { metric: 'ndcg_at_10', market: 'intl', value: 0.95, n: 37, labels: 'constructed' },
        { metric: 'ndcg_at_10', market: 'intl', subset: 'career_changer', value: 0.3, n: 3, labels: 'constructed', note: 'reported, not gated' },
      ],
    });
    // A baseline under the career-changer key is never read: the row cannot fail.
    const r = report({ suites: [ranking], baselines: { 'ranking/ndcg_at_10/intl/all': 0.94, 'ranking/ndcg_at_10/intl/career_changer': 0.99 } });
    expect(r.exitCode).toBe(0);
    expect(r.rows.map((x) => [x.metric, x.gate, x.status])).toEqual([
      ['ndcg_at_10 [intl]', 'no regression against the stored baseline', 'pass'],
      ['ndcg_at_10 [intl] [career_changer]', 'not gated', 'info'],
    ]);
    expect(baselineValues(r.rows, false)).toEqual({ 'ranking/ndcg_at_10/intl/all': 0.95 });
    // The gated value still fails on its own.
    expect(report({ suites: [ranking], baselines: { 'ranking/ndcg_at_10/intl/all': 0.96 } }).exitCode).toBe(1);
  });

  it('prints one table with the five columns, and groups repeated notes', () => {
    const r = report({ enforce: 'M1', invariants: [inv({ id: 'INV-3', outcome: 'fail', reason: 'pending reason' })], listUnbuilt: true });
    const text = renderTable(r.rows);
    expect(text.split('\n')[0]).toMatch(/^layer\s+metric\s+value\s+gate\s+status$/);
    expect(text).toContain('pending');
    expect(text).toContain('- [not_built] scorer icc_3_runs, tier_flip_rate, spearman_human: no suite for this layer yet');
    expect(text).toContain('- [pending] invariant INV-3: pending reason');
  });
});

describe('baselines', () => {
  it('stores the values compared with a baseline, rounded, and merges with what is there', () => {
    const r = report({
      suites: [
        suite({ name: 'ranking', layer: 'ranking', measures: [{ metric: 'ndcg_at_10', market: 'intl', value: 0.81234567 }, { metric: 'ndcg_at_20', market: 'intl', value: null, status: 'not_built' }] }),
        suite({ name: 'taxonomy', layer: 'taxonomy', measures: [{ metric: 'category_precision', market: 'intl', value: 0.99 }] }),
        suite({ name: 'live', layer: 'ranking', measures: [{ metric: 'ndcg_at_10', market: 'intl', scope: 'live', value: 0.5 }] }),
      ],
    });
    expect(baselineValues(r.rows, false)).toEqual({ 'ranking/ndcg_at_10/intl/all': 0.812346 });
    expect(baselineValues(r.rows, true)).toEqual({ 'ranking/ndcg_at_10/intl/all/live': 0.5 });
    const dir = tmp('baseline');
    const file = path.join(dir, 'baselines.json');
    writeBaselines(file, { 'ranking/ndcg_at_10/cn/all': 0.7 }, new Date('2026-10-01T00:00:00Z'));
    const written = writeBaselines(file, baselineValues(r.rows, false), new Date('2026-10-02T00:00:00Z'));
    expect(written.values).toEqual({ 'ranking/ndcg_at_10/cn/all': 0.7, 'ranking/ndcg_at_10/intl/all': 0.812346 });
    expect(JSON.parse(readFileSync(file, 'utf8')).writtenAt).toBe('2026-10-02T00:00:00.000Z');
    expect(readBaselines(false, dir, dir)).toEqual(written.values);
    // Live baselines live with the snapshots and are read only in live mode.
    const snap = tmp('snap');
    writeBaselines(path.join(snap, 'baselines.live.json'), { 'latency/feed_p95_ms/intl/all/live': 420 }, new Date());
    expect(readBaselines(false, dir, snap)).toEqual(written.values);
    expect(readBaselines(true, dir, snap)).toMatchObject({ 'latency/feed_p95_ms/intl/all/live': 420 });
  });

  it('a baseline says which fixtures it was measured on, and is not compared with others', () => {
    const dir = tmp('stamp');
    const file = path.join(dir, 'baselines.json');
    const hash = fixtureFilesHash(dir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    writeBaselines(file, { 'ranking/ndcg_at_10/intl/all': 0.9 }, new Date('2026-10-01T00:00:00Z'), { source: 'the order before', fixturesHash: hash });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ _generatedBy: 'npm run eval:match -- --write-baseline', source: 'the order before', fixturesHash: hash });
    expect(staleBaselineReason(dir)).toBeNull();
    expect(readBaselines(false, dir, dir)).toEqual({ 'ranking/ndcg_at_10/intl/all': 0.9 });
    // The same fixtures: a second write merges.
    expect(writeBaselines(file, { 'ranking/ndcg_at_10/cn/all': 0.8 }, new Date(), { fixturesHash: hash }).values).toEqual({ 'ranking/ndcg_at_10/cn/all': 0.8, 'ranking/ndcg_at_10/intl/all': 0.9 });
    // The fixtures change (a file appears): the stored values are for other labels.
    writeFileSync(path.join(dir, 'personas.intl.json'), '{}');
    expect(staleBaselineReason(dir)).toContain('measured on other fixtures');
    expect(readBaselines(false, dir, dir)).toEqual({});
    // Writing for the new fixtures drops the old values instead of mixing them.
    expect(writeBaselines(file, { 'ranking/ndcg_at_20/cn/all': 0.7 }, new Date(), { fixturesHash: fixtureFilesHash(dir) }).values).toEqual({ 'ranking/ndcg_at_20/cn/all': 0.7 });
    expect(staleBaselineReason(dir)).toBeNull();
  });

  it('the committed baseline is for the committed fixtures and holds the gated ranking values of both markets', () => {
    expect(staleBaselineReason()).toBeNull();
    const stored = readBaselines(false);
    expect(Object.keys(stored).sort()).toEqual(['ranking/ndcg_at_10/cn/all', 'ranking/ndcg_at_10/intl/all', 'ranking/ndcg_at_20/cn/all', 'ranking/ndcg_at_20/intl/all']);
    for (const v of Object.values(stored)) {
      expect(v).toBeGreaterThan(0.5);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('the first baseline is the list read before the fit contract, and cannot be rewritten once the contract exists', async () => {
    const out = path.join(tmp('before-fit'), 'baselines.json');
    await expect(writeBaselineBeforeFit({ outFile: out, fitContractExists: true })).rejects.toBeInstanceOf(BaselineRefused);
    await expect(writeBaselineBeforeFit({ outFile: out, fitContractExists: true })).rejects.toThrow(/--write-baseline/);
    const written = await writeBaselineBeforeFit({ outFile: out, fitContractExists: false, now: new Date('2026-10-01T00:00:00Z') });
    expect(written).toMatchObject({ _generatedBy: BEFORE_FIT_COMMAND, writtenAt: '2026-10-01T00:00:00.000Z', fixturesHash: fixtureFilesHash() });
    expect(written.source).toContain('before the fit contract');
    // The gated values only: no career-changer row is stored.
    expect(Object.keys(written.values).sort()).toEqual(['ranking/ndcg_at_10/cn/all', 'ranking/ndcg_at_10/intl/all', 'ranking/ndcg_at_20/cn/all', 'ranking/ndcg_at_20/intl/all']);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(written);
  });
});

describe('the offline guard', () => {
  it('makes fetch throw "network is off in eval" and counts the attempt', async () => {
    const before = globalThis.fetch;
    installOfflineGuard();
    installOfflineGuard();
    resetOfflineAttempts();
    expect(offlineGuardInstalled()).toBe(true);
    await expect(fetch('https://api.example.test/v1/chat?key=secret')).rejects.toThrow(OFFLINE_MESSAGE);
    await expect(fetch(new URL('https://embeddings.example.test/embeddings'))).rejects.toThrow('network is off in eval');
    expect(offlineAttempts()).toBe(2);
    removeOfflineGuard();
    expect(offlineGuardInstalled()).toBe(false);
    expect(globalThis.fetch).toBe(before);
  });

  it('counts the calls a piece of work attempted, keeping only the host', async () => {
    const quiet = await countNetworkAttempts(async () => 'nothing');
    expect(quiet).toEqual({ result: 'nothing', attempts: 0, hosts: [] });
    const noisy = await countNetworkAttempts(async () => {
      await fetch('https://models.example.test/score?token=abc').catch(() => undefined);
    });
    expect(noisy.attempts).toBe(1);
    expect(noisy.hosts).toEqual(['models.example.test']);
    expect(offlineGuardInstalled()).toBe(false);
  });
});

describe('the shipped suites', () => {
  // Review finding (M1 gate): the report printed "human labels" for the two labelled-title sets, which the
  // engineer of the matcher wrote (MKT-1E handoff: "SYNTHETIC … The labels are mine, not a recruiter's").
  // A report never states a source the labels do not have (D3).
  it('the taxonomy suite says its labels are authored, never human, and files a title the way ingest does', async () => {
    const [taxonomy] = await runSuites(discoverSuites(SUITES_DIR).filter((f) => f.includes('taxonomy')), ctx());
    expect(taxonomy!.error).toBeNull();
    const measured = taxonomy!.measures.filter((m) => m.value !== null);
    expect(measured.map((m) => [m.metric, m.market])).toEqual([
      ['category_precision', 'intl'],
      ['deterministic_match_share', 'intl'],
      ['category_precision', 'cn'],
      ['deterministic_match_share', 'cn'],
    ]);
    for (const m of measured) expect(m.labels, `${m.metric} ${m.market}`).toBe('authored');
    const rows = report({ suites: [taxonomy!] }).rows;
    for (const row of rows.filter((r) => r.layer === 'taxonomy')) {
      expect(row.value).toContain('authored labels');
      expect(row.value).not.toContain('human');
    }
    // The gate still reads the value: authored labels do not wait for the judge audit.
    expect(rows.find((r) => r.metric === 'category_precision [intl]')!.status).toBe('pass');
    // The suite files a title through ingest's own function, not through a copy of its order.
    expect(SEAMS.taxonomyIdsForTitle).toBe('server/src/features/jobs/normalize/index.ts#taxonomyIdsForTitle');
    const source = readFileSync(path.join(SUITES_DIR, 'taxonomy.suite.ts'), 'utf8');
    expect(source).toContain('SEAMS.taxonomyIdsForTitle');
    expect(source).not.toContain('SEAMS.foldTwToCn');
  });

  it('ranking and language are not_built while the fit seam is missing', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'noSuchFitModule.ts'));
    const runs = await runSuites(discoverSuites(SUITES_DIR).filter((f) => !f.includes('taxonomy')), ctx({ fixturesDir: path.join(FIXTURES_DIR) }));
    for (const run of runs) {
      expect(run.error).toBeNull();
      expect(run.measures.length).toBeGreaterThan(0);
      for (const m of run.measures) expect(m).toMatchObject({ value: null, status: 'not_built' });
    }
    expect(report({ suites: runs }).exitCode).toBe(0);
  });

  it('ranking and language measure NDCG through the seam once it exists (a stand-in here)', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitShim.ts'));
    // A copy of the folder path makes a fresh cache entry for this test.
    const runs = await runSuites(discoverSuites(SUITES_DIR).filter((f) => !f.includes('taxonomy')), ctx({ fixturesDir: `${FIXTURES_DIR}${path.sep}` }));
    const ranking = runs.find((r) => r.name === 'ranking')!;
    // The gated value leaves career changers out; they are reported on their own rows.
    expect(ranking.measures.map((m) => [m.metric, m.market, m.subset ?? null, m.n])).toEqual([
      ['ndcg_at_10', 'intl', null, 37],
      ['ndcg_at_20', 'intl', null, 37],
      ['ndcg_at_10', 'intl', 'career_changer', 3],
      ['ndcg_at_20', 'intl', 'career_changer', 3],
      ['ndcg_at_10', 'cn', null, 36],
      ['ndcg_at_20', 'cn', null, 36],
      ['ndcg_at_10', 'cn', 'career_changer', 4],
      ['ndcg_at_20', 'cn', 'career_changer', 4],
    ]);
    for (const m of ranking.measures) {
      expect(m.labels).toBe('constructed');
      expect(typeof m.value).toBe('number');
      expect(m.value).toBeLessThanOrEqual(1);
      if (!m.subset) expect(m.value).toBeGreaterThan(0.5);
    }
    const rows = report({ suites: [ranking] }).rows;
    expect(rows.filter((r) => r.gate === 'not gated').map((r) => r.status)).toEqual(['info', 'info', 'info', 'info']);
    expect(Object.keys(baselineValues(rows, false))).toHaveLength(4);
    const language = runs.find((r) => r.name === 'language')!;
    expect(new Set(language.measures.map((m) => m.subset))).toEqual(new Set(['en', 'zh-TW', 'zh-CN', 'cross']));
    for (const m of language.measures) expect(typeof m.value).toBe('number');
    // Career changers are left out of the language comparison.
    expect(language.measures.find((m) => m.subset === 'en' && m.metric === 'ndcg_at_10')!.n).toBe(23);
    const one = await runSuites(discoverSuites(SUITES_DIR), ctx({ markets: ['cn'], fixturesDir: `${FIXTURES_DIR}${path.sep}` }), 'language');
    expect(one[0]!.measures.filter((m) => m.subset === 'en').every((m) => m.status === 'no_fixture')).toBe(true);
  });

  it('with no fixture folder every suite says no_fixture', async () => {
    const empty = tmp('nofix');
    const runs = await runSuites(discoverSuites(SUITES_DIR), ctx({ fixturesDir: empty, repoRoot: empty }));
    for (const run of runs) for (const m of run.measures) expect(m.status, `${run.name} ${m.metric}`).toBe('no_fixture');
    expect(report({ suites: runs }).exitCode).toBe(0);
  });

  it('taxonomy reads the labelled titles by path when they exist and gates the category precision', async () => {
    const root = tmp('titles');
    const dir = path.join(root, 'server/src/features/jobs/taxonomy/__fixtures__');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'labelledTitles.intl.json'),
      JSON.stringify({
        _synthetic: true,
        titles: [
          { title: 'Backend Engineer', categoryId: 'software_engineering', roleId: 'backend_engineer' },
          { title: 'Registered Nurse', categoryId: 'healthcare', roleId: 'registered_nurse' },
          { title: 'Landscape Architect', categoryId: 'design', roleId: 'architect' },
          // Labelled into the wrong category on purpose: one miss in four matched titles.
          { title: 'Data Analyst', categoryId: 'finance', roleId: null },
          { title: 'Zzyzx Qwfp', categoryId: null, roleId: null },
        ],
      }),
    );
    const runs = await runSuites(discoverSuites(SUITES_DIR), ctx({ repoRoot: root, markets: ['intl', 'cn'] }), 'taxonomy');
    const [intl, share, cn] = runs[0]!.measures;
    expect(intl).toMatchObject({ metric: 'category_precision', market: 'intl', value: 0.75, n: 4 });
    expect(intl!.note).toContain('"Data Analyst" → data_ai (labelled finance)');
    expect(share).toMatchObject({ metric: 'deterministic_match_share', value: 0.8 });
    expect(cn).toMatchObject({ market: 'cn', status: 'no_fixture' });
    const r = report({ suites: runs });
    expect(r.exitCode).toBe(1);
    expect(r.rows.map((x) => x.status)).toEqual(['fail', 'info', 'no_fixture']);
  });

  it('category precision counts a forced unknown title as wrong and leaves unmatched titles out', () => {
    const rows = readLabelledTitles([{ title: 'A', categoryId: 'x' }, { title: 'B', categoryId: null }, { title: 'C', categoryId: 'y' }, { nope: true }]);
    expect(rows).toHaveLength(3);
    const got: Record<string, string | null> = { A: 'x', B: 'z', C: null };
    expect(categoryPrecision(rows, (t) => got[t] ?? null)).toMatchObject({ precision: 0.5, matched: 2, correct: 1, total: 3, misses: [{ title: 'B', expected: null, got: 'z' }] });
    expect(categoryPrecision([], () => null).precision).toBeNull();
    expect(() => readLabelledTitles({ nothing: 1 })).toThrow(/expected an array/);
  });
});

describe('main', () => {
  const io = (env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l), env, now: () => new Date('2026-10-01T12:00:00Z') } };
  };

  it('prints the usage for --help and exits 2 on a bad argument', async () => {
    const help = io();
    expect(await main(['--help'], help.io)).toBe(0);
    expect(help.out.join('\n')).toContain('npm run eval:match');
    const bad = io();
    expect(await main(['--enforce', 'M9'], bad.io)).toBe(2);
    expect(bad.err[0]).toContain('--enforce takes one of M1, M2, M4, all');
  });

  it('refuses --live without EVAL_LIVE=1 before anything is read', async () => {
    const t = io({});
    expect(await main(['--live'], t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('set EVAL_LIVE=1 in the shell');
    expect(t.err.join('\n')).toContain('It is not read from .env');
    expect(t.err.join('\n')).toContain('Nothing was read');
    expect(t.out).toEqual([]);
    const zero = io({ EVAL_LIVE: '0' });
    expect(await main(['--live'], zero.io)).toBe(2);
  });

  it('live mode loads the local .env files itself, after the switch: the shell wins, then server/.env, then .env', () => {
    const root = tmp('dotenv');
    mkdirSync(path.join(root, 'server'));
    writeFileSync(path.join(root, 'server', '.env'), 'EVAL_TEST_FROM_SERVER=server\nEVAL_TEST_BOTH=server\n');
    writeFileSync(path.join(root, '.env'), 'EVAL_TEST_BOTH=root\nEVAL_TEST_FROM_ROOT=root\nEVAL_TEST_SHELL=file\n');
    const names = ['EVAL_TEST_FROM_SERVER', 'EVAL_TEST_BOTH', 'EVAL_TEST_FROM_ROOT', 'EVAL_TEST_SHELL'];
    process.env.EVAL_TEST_SHELL = 'shell';
    try {
      loadLocalEnvForLive(root);
      expect(names.map((n) => process.env[n])).toEqual(['server', 'server', 'root', 'shell']);
      // A folder with no .env is not an error.
      expect(() => loadLocalEnvForLive(path.join(root, 'nothing-here'))).not.toThrow();
    } finally {
      for (const n of names) delete process.env[n];
    }
  });

  it('runs one suite offline, prints the table and the mode, and exits 0 when nothing fails', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'noSuchFitModule.ts'));
    const t = io({});
    const json = path.join(tmp('json'), 'report.json');
    expect(await main(['--suite', 'ranking', '--json', json], t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('fixtures only');
    expect(text).toContain('no network, no database');
    expect(text).toMatch(/ranking\s+ndcg_at_10 \[intl\]\s+n\/a\s+no regression against the stored baseline\s+not_built/);
    expect(text).toContain('OK: exit 0.');
    expect(offlineGuardInstalled()).toBe(true);
    expect(t.io.env.DATABASE_URL).toBe('postgresql://ci@127.0.0.1:1/ci');
    const saved = JSON.parse(readFileSync(json, 'utf8'));
    expect(saved).toMatchObject({ mode: 'fixtures', enforce: 'all', exitCode: 0 });
    expect(saved.rows).toHaveLength(4);
    const none = io({});
    expect(await main(['--suite', 'nope'], none.io)).toBe(2);
    expect(none.err[0]).toContain('No suite named "nope"');
  });
});
