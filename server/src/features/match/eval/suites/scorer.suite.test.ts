// @vitest-environment node
// MKT-4G — the scorer suite of the harness (strategy 2.6: ICC >= 0.85, tier flips under 5%, Spearman with human
// grades >= 0.6): the replay loader, the replay itself, the self-check and the recorder. No model is called: the
// "model" of the recorder tests is a function that writes hand-made answers. No network, no database.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), startStep: vi.fn(() => 0), endStep: vi.fn(), logAgentStart: vi.fn(), logAgentEnd: vi.fn(), pushAgent: vi.fn(), popAgent: vi.fn(), getRequestSnapshot: vi.fn(() => null), logLanguageDetection: vi.fn() },
}));

import type { FitPromptVersion } from '../../contract.js';
import type { RAJobMatchScorerV4Input } from '../../../../roboapply/v2/agents/RAJobMatchScorerAgent.js';
import { loadLabels, loadPersonas, loadPostings } from '../fixtures/load.js';
import { FIXTURE_FILES } from '../fixtures/schema.js';
import { JUDGE_TRUST_MIN_PAIRS, findGate } from '../gates.js';
import { icc } from '../metrics.js';
import { FIXTURES_DIR, buildReport } from '../run.js';
import { EVAL_DIR, REPO_ROOT, setFitModuleForTests } from '../seams.js';
import type { SuiteContext, SuiteMeasure } from '../suite.js';
import { fixtureWorld } from '../world.js';
import {
  MIN_MEASURED_SHARE,
  RECORD_SWITCH,
  SCORER_FILES,
  SCORER_FIXTURES,
  SCORER_MIN_PAIRS,
  SCORER_RUNS,
  importAuditMain,
  layer,
  loadRecording,
  loadScorerAudit,
  loadSelfcheck,
  name,
  recordMarket,
  replayRecording,
  run,
  runSelfcheck,
  scoreOnce,
  scorerAuditFromCsv,
  spearmanWithHuman,
  survivorBias,
  type RecordDeps,
  type Recording,
} from './scorer.suite.js';

afterEach(() => {
  setFitModuleForTests(null);
  delete process.env[RECORD_SWITCH];
});

const NOW = new Date('2026-10-01T12:00:00Z');
const tmp = (label: string) => mkdtempSync(path.join(tmpdir(), `eval-scorer-${label}-`));
const ctx = (over: Partial<SuiteContext> = {}): SuiteContext => ({ markets: ['intl', 'cn'], live: false, repoRoot: REPO_ROOT, evalDir: EVAL_DIR, fixturesDir: FIXTURES_DIR, now: NOW, ...over });
const row = (measures: SuiteMeasure[], metric: string, market: string) => measures.find((m) => m.metric === metric && m.market === market)!;
const scorerFolder = (dir: string) => path.join(dir, SCORER_FIXTURES);

/** A fixtures folder holding the committed intl fixtures (synthetic) and an empty scorer folder. */
function intlFixtures(label: string): string {
  const dir = tmp(label);
  for (const file of [FIXTURE_FILES.personas('intl'), FIXTURE_FILES.postings('intl'), FIXTURE_FILES.labels('intl')]) copyFileSync(path.join(FIXTURES_DIR, file), path.join(dir, file));
  mkdirSync(scorerFolder(dir), { recursive: true });
  return dir;
}

const POSTINGS = new Map(loadPostings('intl', FIXTURES_DIR)!.map((p) => [p.id, p]));
const PERSONAS = new Map(loadPersonas('intl', FIXTURES_DIR)!.map((p) => [p.id, p]));
type PairKey = { userId: string; jobId: string };
/** A sentence of the posting, as a model copies a requirement line (verbatim, without its full stop). */
function lineOf(jobId: string): string {
  const sentences = POSTINGS.get(jobId)!.description.split(/(?<=[.。])\s+/);
  return (sentences[1] ?? sentences[0]!).replace(/[.。]$/, '');
}
/** The skills line of the person's resume, as a model quotes it. */
const quoteOf = (userId: string): string => PERSONAS.get(userId)!.resumeMarkdown.trim().split('\n').at(-1)!;

/**
 * Hand-made answers, as a model writes them for a posting with no stored list: one requirement line copied from the
 * posting, with a resume quote when it is met. HIGH and LOW are far apart on purpose: whatever the logistics of a
 * pair, HIGH is Great and LOW is Unlikely.
 */
const v4Answer = (kind: 'high' | 'low', pair: PairKey): string =>
  JSON.stringify({
    requirements: [{ id: 'r1', kind: 'experience', text: lineOf(pair.jobId), importance: 'must', status: kind === 'high' ? 'met' : 'not_shown', evidence: kind === 'high' ? quoteOf(pair.userId) : '' }],
    level: kind === 'high' ? { post: 'senior', resume: 'senior', direction: 'match' } : { post: 'director_exec', resume: 'intern_newgrad', direction: 'post_higher' },
    domain: { status: kind === 'high' ? 'direct' : 'unrelated', evidence: '' },
    trajectory: { status: kind === 'high' ? 'toward' : 'away', evidence: '' },
    strengths: [],
    gaps: [],
    summary: '',
  });
const v3Answer = (kind: 'high' | 'low'): string => {
  const score = kind === 'high' ? 95 : 5;
  return JSON.stringify({ dimensions: { title_level: { score, evidence: [] }, skills: { score, evidence: [] }, industry: { score, evidence: [] }, career_path: { score, evidence: [] } }, strengths: [], gaps: [], keywordsMatched: [], keywordsMissing: [], summary: '' });
};

/**
 * A recorder "model": it answers what `write` says for a pair and a run, through the product's own path, so the
 * prompt hash of the recording is the real one. `null` models a call that failed.
 */
function fakeModel(write: (pair: PairKey, runOfPair: number) => string | null): RecordDeps['score'] {
  const seen = new Map<string, number>();
  return async (world, input) => {
    const key = `${input.userId}::${input.jobId}`;
    const runOfPair = seen.get(key) ?? 0;
    seen.set(key, runOfPair + 1);
    const answer = write(input, runOfPair);
    const once = await scoreOnce(world, { userId: input.userId, jobId: input.jobId, locale: input.locale, prompt: input.prompt, answerer: { kind: 'replay', answer }, deps: { resolveModel: () => input.model } });
    return { ...once, trace: { inputHash: once.trace.inputHash, raw: answer } };
  };
}

/** Pairs of a test recording: over the 30 a gated value needs, so two of them may be lost without going under. */
const PAIRS = 32;

async function record(dir: string, write: Parameters<typeof fakeModel>[0], over: Partial<RecordDeps> = {}, prompt: FitPromptVersion = 'scorer_v4'): Promise<Recording> {
  const outcome = await recordMarket({
    market: 'intl',
    fixturesDir: dir,
    outDir: scorerFolder(dir),
    now: NOW,
    deps: { resolveModel: async () => 'vendor/scorer-model', pinnedPrompt: async () => prompt, score: fakeModel(write), maxPairs: PAIRS, ...over },
  });
  if ('skipped' in outcome) throw new Error(outcome.skipped);
  return outcome.recording;
}

/** The place of a pair in the order the recorder first asked for it: lets a test say "the second pair", "every third pair". */
function ordinals() {
  const order: string[] = [];
  const at = (pair: PairKey): number => {
    const key = `${pair.userId}::${pair.jobId}`;
    if (!order.includes(key)) order.push(key);
    return order.indexOf(key);
  };
  return { at, order };
}
/** Half of the pairs strong, half weak, so the pairs differ from each other and an ICC means something. */
const mixed = (at: (pair: PairKey) => number) => (pair: PairKey): string => v4Answer(at(pair) % 2 === 0 ? 'high' : 'low', pair);
const reportOf = (measures: SuiteMeasure[]) => buildReport({ enforce: 'all', live: false, invariants: [], suites: [{ file: 'scorer.suite.ts', name, layer, measures, error: null, notBuilt: null }], baselines: {}, audit: null, listUnbuilt: false });

describe('the suite as the runner finds it', () => {
  it('is the scorer suite of the scorer layer, and its three gated metrics are the ones of the gate table', () => {
    expect([name, layer]).toEqual(['scorer', 'scorer']);
    expect(findGate('scorer', 'icc_3_runs')!.rule).toEqual({ kind: 'min', threshold: 0.85 });
    expect(findGate('scorer', 'tier_flip_rate')!.rule).toEqual({ kind: 'below', threshold: 0.05 });
    expect(findGate('scorer', 'spearman_human')!.rule).toEqual({ kind: 'min', threshold: 0.6 });
    expect(SCORER_RUNS).toBe(3);
  });

  it('offline with the committed fixtures: the self-check gives ICC 1 and no flip; with no recording the gated rows read no_fixture', async () => {
    expect(existsSync(path.join(scorerFolder(FIXTURES_DIR), SCORER_FILES.recorded('intl')))).toBe(false);
    const measures = await run(ctx());
    expect(row(measures, 'selfcheck_icc_3_runs', 'all')).toMatchObject({ value: 1, n: 10, labels: 'none' });
    expect(row(measures, 'selfcheck_tier_flip_rate', 'all')).toMatchObject({ value: 0, n: 10 });
    for (const market of ['intl', 'cn']) {
      for (const metric of ['icc_3_runs', 'tier_flip_rate', 'spearman_human']) {
        expect(row(measures, metric, market), `${metric} ${market}`).toMatchObject({ value: null, status: 'no_fixture' });
      }
      expect(row(measures, 'icc_3_runs', market).note).toContain(`fixtures/scorer/recorded.${market}.json is not on disk yet`);
    }
    // Nothing fails and no number is invented: the report exits 0, and the self-check rows are information.
    const report = buildReport({ enforce: 'all', live: false, invariants: [], suites: [{ file: 'scorer.suite.ts', name, layer, measures, error: null, notBuilt: null }], baselines: {}, audit: null, listUnbuilt: false });
    expect(report.exitCode).toBe(0);
    expect(report.rows.filter((r) => r.metric.startsWith('selfcheck_')).map((r) => r.status)).toEqual(['info', 'info']);
    expect(report.rows.filter((r) => !r.metric.startsWith('selfcheck_')).every((r) => r.status === 'no_fixture')).toBe(true);
    // A live run without the record switch records nothing and reads the same.
    expect((await run(ctx({ live: true }))).map((m) => [m.metric, m.market, m.status ?? null])).toEqual(measures.map((m) => [m.metric, m.market, m.status ?? null]));
  });

  it('while the fit seam is missing every row is not_built; with no fixture folder every row is no_fixture', async () => {
    setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'noSuchFitModule.ts'));
    const unbuilt = await run(ctx());
    // Four gated rows a market (the comparison with scorer v3 is one of them) and the two self-check rows.
    expect(unbuilt.length).toBe(10);
    for (const m of unbuilt) expect(m, m.metric).toMatchObject({ value: null, status: 'not_built' });
    setFitModuleForTests(null);
    const empty = await run(ctx({ fixturesDir: tmp('nofix'), repoRoot: tmp('noroot') }));
    expect(empty.length).toBe(10);
    for (const m of empty) expect(m, m.metric).toMatchObject({ value: null, status: 'no_fixture' });
    // "Not below scorer v3" is reported per market with the command that records what it needs, like its siblings:
    // it never falls through to the report's market-less `not_built` ("the suite does not report this metric yet").
    for (const market of ['intl', 'cn']) {
      expect(row(empty, 'spearman_human_gain_over_v3', market)).toMatchObject({ value: null, status: 'no_fixture' });
      expect(row(empty, 'spearman_human_gain_over_v3', market).note).toContain(`fixtures/scorer/recorded.${market}.json is not on disk yet`);
    }
    const report = buildReport({ enforce: 'all', live: false, invariants: [], suites: [{ file: 'scorer.suite.ts', name, layer, measures: empty, error: null, notBuilt: null }], baselines: {}, audit: null, listUnbuilt: false });
    expect(report.rows.filter((r) => r.metric.startsWith('spearman_human_gain_over_v3')).map((r) => [r.metric, r.status])).toEqual([
      ['spearman_human_gain_over_v3 [intl]', 'no_fixture'],
      ['spearman_human_gain_over_v3 [cn]', 'no_fixture'],
    ]);
    expect(report.rows.some((r) => r.status === 'not_built')).toBe(false);
  });
});

describe('the self-check: ten hand-written pairs, three hand-written answers each', () => {
  it('the fixture is synthetic, holds ten pairs with three answers, and no two answers of a pair are the same text', () => {
    const file = path.join(scorerFolder(FIXTURES_DIR), SCORER_FILES.selfcheck);
    expect(readFileSync(file, 'utf8').replace(/\s+/g, '').startsWith('{"_synthetic":true')).toBe(true);
    const pairs = loadSelfcheck(FIXTURES_DIR)!;
    expect(pairs).toHaveLength(10);
    for (const pair of pairs) {
      expect(pair.answers).toHaveLength(3);
      expect(new Set(pair.answers).size, pair.id).toBe(3);
      // The second spelling carries numbers nobody asked for, the third an invented line and a summary with a score.
      expect(pair.answers[1], pair.id).toMatch(/"score": 93/);
      expect(pair.answers[2], pair.id).toMatch(/85\/100/);
    }
    expect(new Set(pairs.map((p) => p.market))).toEqual(new Set(['intl', 'cn']));
    expect(pairs.filter((p) => p.posting.requirements).length).toBeGreaterThanOrEqual(2);
    // The totals differ from pair to pair, so an ICC of 1 means something.
    expect(new Set(pairs.map((p) => p.expected.total)).size).toBe(10);
  });

  it('the pipeline is stable and right for identical input: ICC 1, no flip, every hand-computed number met', async () => {
    const result = await runSelfcheck(loadSelfcheck(FIXTURES_DIR)!);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result).toMatchObject({ icc: 1, tierFlipRate: 0, pairs: 10 });
  });

  it('a wrong expectation, or an answer that is refused, fails the command with the pair named', async () => {
    const pairs = loadSelfcheck(FIXTURES_DIR)!;
    const wrong = pairs.map((p, i) => (i === 0 ? { ...p, expected: { ...p.expected, total: p.expected.total + 1 } } : p));
    const result = await runSelfcheck(wrong);
    expect(result.problems).toHaveLength(3);
    expect(result.problems[0]).toMatch(/^sc01, answer 1: total 79, worked out by hand as 80$/);

    const dir = tmp('badcheck');
    mkdirSync(scorerFolder(dir), { recursive: true });
    const file = JSON.parse(readFileSync(path.join(scorerFolder(FIXTURES_DIR), SCORER_FILES.selfcheck), 'utf8'));
    file.pairs[3].answers[1] = '{"requirements": [], "level": {"post": "principal", "resume": "senior"}}';
    writeFileSync(path.join(scorerFolder(dir), SCORER_FILES.selfcheck), JSON.stringify(file));
    await expect(run(ctx({ fixturesDir: dir }))).rejects.toThrow(/scorer self-check failed: sc04, answer 2: no score/);
    // A fixture that is not ten pairs of three answers is refused before anything is scored.
    file.pairs[0].answers.pop();
    writeFileSync(path.join(scorerFolder(dir), SCORER_FILES.selfcheck), JSON.stringify(file));
    expect(() => loadSelfcheck(dir)).toThrow(/selfcheck\.json does not match its shape: pairs\.0\.answers/);
  });
});

describe('the replay loader', () => {
  const valid = (over: Partial<Recording> = {}): Recording => ({
    _synthetic: true,
    _recordedBy: 'a test',
    market: 'intl',
    scorer: { prompt: 'scorer_v4', rubric: 'fit_v4', model: 'vendor/scorer-model' },
    recordedAt: NOW.toISOString(),
    runs: 3,
    pairs: [{ personaId: 'p1', postingId: 'j1', inputHash: 'a'.repeat(40), answers: ['{}', null, '{}'] }],
    ...over,
  });
  const put = (dir: string, file: string, content: unknown) => writeFileSync(path.join(scorerFolder(dir), file), JSON.stringify(content));

  it('reads a recording of the market and prompt asked for; a file that is not there is null', () => {
    const dir = tmp('loader');
    mkdirSync(scorerFolder(dir), { recursive: true });
    expect(loadRecording(dir, 'intl')).toBeNull();
    put(dir, 'recorded.intl.json', valid());
    expect(loadRecording(dir, 'intl')).toEqual(valid());
    expect(loadRecording(dir, 'cn')).toBeNull();
    expect(loadRecording(dir, 'intl', 'scorer_v3')).toBeNull();
    expect(SCORER_FILES.recorded('cn')).toBe('recorded.cn.json');
    expect(SCORER_FILES.recorded('cn', 'scorer_v3')).toBe('recorded.v3.cn.json');
  });

  it('refuses a wrong shape: not synthetic, not three answers per pair, an unknown key, no pair', () => {
    const dir = tmp('shape');
    mkdirSync(scorerFolder(dir), { recursive: true });
    const bad: Array<[unknown, RegExp]> = [
      [{ ...valid(), _synthetic: false }, /_synthetic/],
      [{ ...valid(), pairs: [{ personaId: 'p1', postingId: 'j1', inputHash: null, answers: ['{}', '{}'] }] }, /pairs\.0\.answers/],
      [{ ...valid(), pairs: [{ personaId: 'p1', postingId: 'j1', inputHash: null, answers: ['{}', '{}', '{}', '{}'] }] }, /pairs\.0\.answers/],
      [{ ...valid(), pairs: [{ personaId: 'p1', postingId: 'j1', inputHash: 'short', answers: ['{}', '{}', '{}'] }] }, /pairs\.0\.inputHash/],
      [{ ...valid(), pairs: [] }, /pairs/],
      [{ ...valid(), runs: 2 }, /runs/],
      [{ ...valid(), score: 0.9 }, /\(file\)/],
      [{ ...valid(), scorer: { prompt: 'scorer_v9', rubric: 'fit_v4', model: 'm' } }, /scorer\.prompt/],
    ];
    for (const [content, why] of bad) {
      put(dir, 'recorded.intl.json', content);
      expect(() => loadRecording(dir, 'intl'), String(why)).toThrow(why);
    }
  });

  it('refuses a market tag or a prompt that is not the one of the file name, and a pair listed twice', () => {
    const dir = tmp('tags');
    mkdirSync(scorerFolder(dir), { recursive: true });
    put(dir, 'recorded.cn.json', valid());
    expect(() => loadRecording(dir, 'cn')).toThrow(/recorded\.cn\.json is tagged market intl, not cn/);
    put(dir, 'recorded.v3.intl.json', valid());
    expect(() => loadRecording(dir, 'intl', 'scorer_v3')).toThrow(/recorded with scorer_v4, not scorer_v3/);
    const pair = valid().pairs[0]!;
    put(dir, 'recorded.intl.json', valid({ pairs: [pair, { ...pair, answers: [null, null, null] }] }));
    expect(() => loadRecording(dir, 'intl')).toThrow(/lists the pair p1::j1 twice/);
    put(dir, 'audit.cn.json', { _synthetic: true, market: 'intl', labels: 'human', gradedAt: NOW.toISOString(), grades: { 'p1::j1': 2 } });
    expect(() => loadScorerAudit(dir, 'cn')).toThrow(/tagged market intl, not cn/);
    put(dir, 'audit.intl.json', { _synthetic: true, market: 'intl', labels: 'judged', gradedAt: NOW.toISOString(), grades: {} });
    expect(() => loadScorerAudit(dir, 'intl')).toThrow(/labels/);
    put(dir, 'audit.intl.json', { _synthetic: true, market: 'intl', labels: 'human', gradedAt: NOW.toISOString(), grades: { 'p1::j1': 4 } });
    expect(() => loadScorerAudit(dir, 'intl')).toThrow(/grades/);
  });
});

describe('recording (live) and replay (offline) of three runs', () => {
  it('the recorder writes model id, date, sample size, the prompt hash and three raw answers per pair, and a sheet for the recruiters', async () => {
    const dir = intlFixtures('record');
    const recording = await record(dir, (pair) => v4Answer('high', pair));
    expect(recording).toMatchObject({ _synthetic: true, market: 'intl', scorer: { prompt: 'scorer_v4', rubric: 'fit_v4', model: 'vendor/scorer-model' }, recordedAt: NOW.toISOString(), runs: 3 });
    expect(recording.pairs).toHaveLength(PAIRS);
    // Every persona gives one pair before any gives a second.
    expect(new Set(recording.pairs.map((p) => p.personaId)).size).toBe(PAIRS);
    for (const pair of recording.pairs) {
      const answer = v4Answer('high', { userId: pair.personaId, jobId: pair.postingId });
      expect(pair.answers).toEqual([answer, answer, answer]);
      expect(pair.inputHash).toMatch(/^[0-9a-f]{40}$/);
    }
    // The file on disk is the recording, and it loads as one.
    expect(loadRecording(dir, 'intl')).toEqual(recording);
    const sheet = readFileSync(path.join(scorerFolder(dir), SCORER_FILES.auditSheet('intl')), 'utf8');
    expect(sheet.split('\r\n')[0]).toBe('pair_id,persona_id,posting_id,persona_summary,persona_resume,posting_title,posting_text,human_grade_0_to_3');
    expect(sheet).toContain(`${recording.pairs[0]!.personaId}::${recording.pairs[0]!.postingId}`);
  });

  it('identical answers replay to ICC 1 and no flip; the report prints them against their gates', async () => {
    const dir = intlFixtures('stable');
    const recording = await record(dir, mixed(ordinals().at));
    const result = (await replayRecording(recording, dir))!;
    expect(result).toMatchObject({ usable: PAIRS, dropped: 0, changed: 0, unknown: 0, total: PAIRS, tierFlipRate: 0, icc: 1 });
    expect(result.kept).toHaveLength(PAIRS);
    for (const pair of result.kept) {
      expect(new Set(pair.scores).size).toBe(1);
      expect(new Set(pair.tiers).size).toBe(1);
    }
    // The copied line and its quote were verified by the product's own path: the strong pairs are Great, the weak ones Unlikely.
    expect(new Set(result.kept.map((p) => p.tiers[0]))).toEqual(new Set(['great', 'unlikely']));

    const measures = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    expect(row(measures, 'tier_flip_rate', 'intl')).toMatchObject({ value: 0, n: PAIRS, labels: 'none' });
    expect(row(measures, 'icc_3_runs', 'intl')).toMatchObject({ value: 1, n: PAIRS, labels: 'none' });
    expect(row(measures, 'tier_flip_rate', 'intl').note).toMatch(/recorded 2026-10-01 with vendor\/scorer-model \(scorer_v4\); 3 runs on 32 synthetic pairs; 32 scored in every run/);
    expect(row(measures, 'spearman_human', 'intl')).toMatchObject({ status: 'no_fixture' });
    const report = reportOf(measures);
    expect(report.rows.find((r) => r.metric === 'tier_flip_rate [intl]')).toMatchObject({ gate: '< 0.05', status: 'pass' });
    expect(report.rows.find((r) => r.metric === 'icc_3_runs [intl]')).toMatchObject({ gate: '>= 0.85', status: 'pass' });
    expect(report.exitCode).toBe(0);
  });

  it('a run that judges a pair differently is a flip; a failed call and an answer that does not parse are flips too, never pairs that quietly disappear', async () => {
    const dir = intlFixtures('noisy');
    const { at, order } = ordinals();
    const recording = await record(dir, (pair, runOfPair) => {
      const i = at(pair);
      if (i === 1 && runOfPair === 2) return v4Answer('high', pair); // the third run reads this weak pair the other way
      if (i === 2 && runOfPair === 0) return null; // the call failed
      if (i === 3 && runOfPair === 1) return 'I cannot help with that.'; // not a checklist
      return mixed(at)(pair);
    });
    const byKey = new Map(recording.pairs.map((p) => [`${p.personaId}::${p.postingId}`, p]));
    expect(byKey.get(order[2]!)!.answers[0]).toBeNull();
    expect(byKey.get(order[3]!)!.answers[1]).toBe('I cannot help with that.');

    const result = (await replayRecording(recording, dir))!;
    expect(result).toMatchObject({ usable: PAIRS, dropped: 2, changed: 0, total: PAIRS });
    expect(result.kept).toHaveLength(PAIRS - 2);
    const flipped = result.kept.find((p) => `${p.personaId}::${p.postingId}` === order[1])!;
    expect(flipped.tiers).toEqual(['unlikely', 'unlikely', 'great']);
    // One pair with two tiers and two pairs with a run that gave nothing: three of 32 did not get one tier.
    expect(result.tierFlipRate).toBeCloseTo(3 / PAIRS, 10);
    expect(result.icc).toBe(icc([0, 1, 2].map((r) => result.kept.map((p) => p.scores[r]!))));

    const measures = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    expect(row(measures, 'tier_flip_rate', 'intl')).toMatchObject({ value: 3 / PAIRS, n: PAIRS });
    // 30 of 32 pairs were scored in every run (93.75%): enough for the ICC to be read, over those 30.
    expect(row(measures, 'icc_3_runs', 'intl')).toMatchObject({ value: result.icc, n: PAIRS - 2 });
    expect(row(measures, 'icc_3_runs', 'intl').note).toContain('2 with a run that gave no usable answer (6.3% of the pairs; each counts as a tier flip)');
    const report = reportOf(measures);
    expect(report.rows.find((r) => r.metric === 'tier_flip_rate [intl]')).toMatchObject({ status: 'fail' });
    expect(report.exitCode).toBe(1);
  });

  it('a scorer whose totals move between runs misses both gates', async () => {
    const dir = intlFixtures('unstable');
    const { at } = ordinals();
    // Every third pair is read the other way in the third run.
    const recording = await record(dir, (pair, runOfPair) => (at(pair) % 3 === 0 && runOfPair === 2 ? v4Answer(at(pair) % 2 === 0 ? 'low' : 'high', pair) : mixed(at)(pair)));
    const result = (await replayRecording(recording, dir))!;
    expect(result).toMatchObject({ usable: PAIRS, dropped: 0 });
    expect(result.tierFlipRate).toBeCloseTo(11 / PAIRS, 10);
    expect(result.icc!).toBeLessThan(0.85);
    const report = reportOf(await run(ctx({ markets: ['intl'], fixturesDir: dir })));
    expect(report.rows.filter((r) => r.status === 'fail').map((r) => r.metric).sort()).toEqual(['icc_3_runs [intl]', 'tier_flip_rate [intl]']);
    expect(report.exitCode).toBe(1);
  });

  it('a third of the pairs have one unusable run: the flip rate fails the command, and no ICC or correlation is read off the survivors', async () => {
    const dir = intlFixtures('refused');
    const { at } = ordinals();
    // The scorer is perfectly stable on the pairs it answers, and answers nothing in one run of every third pair
    // (a refused checklist, a failed call, an answer cut short): the instability a person sees as an estimate.
    const recording = await record(dir, (pair, runOfPair) => (at(pair) % 3 === 0 && runOfPair === 1 ? (at(pair) % 2 ? null : JSON.stringify({ requirements: [] })) : mixed(at)(pair)));
    const result = (await replayRecording(recording, dir))!;
    expect(result).toMatchObject({ usable: PAIRS, dropped: 11, changed: 0 });
    expect(result.kept).toHaveLength(PAIRS - 11);
    // Among the survivors nothing ever moved: over them alone the scorer would pass both stability gates.
    expect(result.icc).toBe(1);
    expect(result.kept.every((p) => new Set(p.tiers).size === 1)).toBe(true);
    expect(result.tierFlipRate).toBeCloseTo(11 / PAIRS, 10);
    expect(survivorBias(result)).toMatch(/only 21 of 32 pairs \(65\.6%\) were scored in every run/);

    // Recruiters' grades of every pair: the correlation is not read off the survivors either.
    const grades = Object.fromEntries(recording.pairs.map((p, i) => [`${p.personaId}::${p.postingId}`, i % 2 === 0 ? 3 : 0]));
    writeFileSync(path.join(scorerFolder(dir), SCORER_FILES.audit('intl')), JSON.stringify({ _synthetic: true, market: 'intl', labels: 'human', gradedAt: '2026-10-05T00:00:00.000Z', grades }));
    const measures = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    expect(row(measures, 'tier_flip_rate', 'intl')).toMatchObject({ value: 11 / PAIRS, n: PAIRS });
    expect(row(measures, 'icc_3_runs', 'intl')).toMatchObject({ value: null, status: 'no_fixture' });
    expect(row(measures, 'icc_3_runs', 'intl').note).toMatch(/under 90% a value over them describes the survivors, not the scorer/);
    expect(row(measures, 'spearman_human', 'intl')).toMatchObject({ value: null, status: 'no_fixture', labels: 'human' });
    const report = reportOf(measures);
    expect(report.rows.filter((r) => r.status === 'fail').map((r) => r.metric)).toEqual(['tier_flip_rate [intl]']);
    expect(report.exitCode).toBe(1);

    // All three runs of a pair unusable is the same: no tier at all is not "one tier".
    const silent = await record(intlFixtures('silent'), (pair) => (at(pair) % 4 === 0 ? null : mixed(at)(pair)));
    const none = (await replayRecording(silent, dir))!;
    expect(none.dropped).toBe(8);
    expect(none.tierFlipRate).toBeCloseTo(8 / PAIRS, 10);
    // The bounds themselves.
    expect([SCORER_MIN_PAIRS, MIN_MEASURED_SHARE]).toEqual([JUDGE_TRUST_MIN_PAIRS, 0.9]);
    expect(survivorBias({ ...result, usable: 100, kept: result.kept.slice(0, 1).concat(Array(89).fill(result.kept[0]!)) })).toBeNull();
    expect(survivorBias({ ...result, usable: 31, kept: Array(29).fill(result.kept[0]!) })).toMatch(/29 pairs were scored in every run; 30 are needed/);
  });

  it('a recording is for the inputs it was made on: a pair whose prompt changed is left out, and a recording that is mostly stale is no fixture', async () => {
    const dir = intlFixtures('stale');
    const recording = await record(dir, (pair) => v4Answer('high', pair));
    const file = path.join(scorerFolder(dir), SCORER_FILES.recorded('intl'));
    const one = { ...recording, pairs: recording.pairs.map((p, i) => (i === 0 ? { ...p, inputHash: 'f'.repeat(40) } : p)) };
    writeFileSync(file, JSON.stringify(one));
    const some = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    expect(row(some, 'tier_flip_rate', 'intl')).toMatchObject({ value: 0, n: PAIRS - 1 });
    expect(row(some, 'tier_flip_rate', 'intl').note).toContain('1 left out because their prompt would be another today');

    const most = { ...recording, pairs: recording.pairs.map((p, i) => (i < 17 ? { ...p, inputHash: 'f'.repeat(40) } : p)) };
    writeFileSync(file, JSON.stringify(most));
    const stale = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    for (const metric of ['icc_3_runs', 'tier_flip_rate', 'spearman_human']) expect(row(stale, metric, 'intl'), metric).toMatchObject({ value: null, status: 'no_fixture' });
    expect(row(stale, 'icc_3_runs', 'intl').note).toContain('the recording is for other inputs');

    // A pair of a posting the fixtures no longer have is counted apart.
    const gone = { ...recording, pairs: [...recording.pairs.slice(0, PAIRS - 1), { ...recording.pairs[PAIRS - 1]!, postingId: 'no-such-posting' }] };
    expect((await replayRecording(gone, dir))!).toMatchObject({ unknown: 1, total: PAIRS, usable: PAIRS - 1 });
  });

  it('fewer than 30 pairs on today\'s inputs is too small a sample: every row reads no_fixture and nothing fails', async () => {
    const dir = intlFixtures('small');
    const { at } = ordinals();
    // Eight pairs, one of them flipping: over eight pairs that is 12.5%, and it says nothing.
    await record(dir, (pair, runOfPair) => (at(pair) === 1 && runOfPair === 2 ? v4Answer('low', pair) : v4Answer('high', pair)), { maxPairs: 8 });
    const measures = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    for (const metric of ['icc_3_runs', 'tier_flip_rate', 'spearman_human']) expect(row(measures, metric, 'intl'), metric).toMatchObject({ value: null, status: 'no_fixture' });
    expect(row(measures, 'tier_flip_rate', 'intl').note).toContain("8 pairs on today's inputs; 30 are needed before a value is held against its gate");
    expect(reportOf(measures).exitCode).toBe(0);
    // Three stale pairs of 32 leave 29: the same.
    const recording = await record(dir, (pair) => v4Answer('high', pair));
    writeFileSync(path.join(scorerFolder(dir), SCORER_FILES.recorded('intl')), JSON.stringify({ ...recording, pairs: recording.pairs.map((p, i) => (i < 3 ? { ...p, inputHash: 'f'.repeat(40) } : p)) }));
    expect(row(await run(ctx({ markets: ['intl'], fixturesDir: dir })), 'tier_flip_rate', 'intl').note).toContain("29 pairs on today's inputs; 30 are needed");
  });

  it('every score of the suite is a first score: a repository that stores requirement lists is never written to, so the order of two people on one posting cannot matter', async () => {
    const personas = loadPersonas('intl', FIXTURES_DIR)!;
    const postings = loadPostings('intl', FIXTURES_DIR)!;
    const labels = loadLabels('intl', FIXTURES_DIR)!.labels;
    // A posting two personas are both paired with.
    const byPosting = new Map<string, string[]>();
    for (const [personaId, row] of Object.entries(labels)) for (const postingId of Object.keys(row)) byPosting.set(postingId, [...(byPosting.get(postingId) ?? []), personaId]);
    const [jobId, people] = [...byPosting.entries()].find(([, ids]) => ids.length >= 2)!;
    const [a, b] = people as [string, string];

    /** A world whose repository stores a posting's list like production does (first writer wins). */
    const storingWorld = () => {
      const world = fixtureWorld('intl', personas, postings);
      const saveJobRequirements = vi.fn(async (id: string, doc: unknown) => {
        const job = world.repo.state.jobs.find((j) => j.id === id);
        if (!job || job.requirements) return false;
        job.requirements = doc;
        return true;
      });
      Object.assign(world.repo, { saveJobRequirements });
      return { world, saveJobRequirements };
    };
    const score = (world: ReturnType<typeof storingWorld>['world'], userId: string) =>
      scoreOnce(world, { userId, jobId, locale: PERSONAS.get(userId)!.locale, prompt: 'scorer_v4', answerer: { kind: 'replay', answer: v4Answer('high', { userId, jobId }) }, deps: { resolveModel: () => 'vendor/scorer-model' } });
    /** The person scored in `world`, and the same person scored alone in a world nobody else was scored in. */
    const once = async (world: ReturnType<typeof storingWorld>['world'], userId: string) => ({ result: await score(world, userId), alone: await score(fixtureWorld('intl', personas, postings), userId) });

    // a then b in one storing world, and b then a in another: recording and replay may meet either order.
    const first = storingWorld();
    const ab = [await once(first.world, a), await once(first.world, b)];
    const second = storingWorld();
    const ba = [await once(second.world, b), await once(second.world, a)];
    for (const { world, saveJobRequirements } of [first, second]) {
      // Nothing was written to the posting, so no later pair was handed an earlier pair's lines.
      expect(saveJobRequirements).not.toHaveBeenCalled();
      expect(world.repo.state.jobs.find((j) => j.id === jobId)!.requirements ?? null).toBeNull();
    }
    // The prompt of each person is the same in both orders, and the same as when they are scored alone.
    expect(ab[0]!.result.trace.inputHash).toBe(ba[1]!.result.trace.inputHash);
    expect(ab[1]!.result.trace.inputHash).toBe(ba[0]!.result.trace.inputHash);
    expect(ab[0]!.result.trace.inputHash).toBe(ab[0]!.alone.trace.inputHash);
    expect(ab[1]!.result.trace.inputHash).toBe(ab[1]!.alone.trace.inputHash);
    // And so is what their answer means.
    expect([ab[0]!.result.score, ab[1]!.result.score]).toEqual([ba[1]!.result.score, ba[0]!.result.score]);
    expect(ab[0]!.result.score).not.toBeNull();
    // The service the suite builds is not the reason: handed the same repository as it is, the first score DOES store
    // its lines and the second person is handed them (another prompt, so a recording would not replay).
    const control = storingWorld();
    const direct = (userId: string) =>
      scoreOnce(control.world, { userId, jobId, locale: PERSONAS.get(userId)!.locale, prompt: 'scorer_v4', answerer: { kind: 'replay', answer: v4Answer('high', { userId, jobId }) }, deps: { resolveModel: () => 'vendor/scorer-model', repo: control.world.repo } });
    await direct(a);
    expect(control.saveJobRequirements).toHaveBeenCalledTimes(1);
    const handed: Array<RAJobMatchScorerV4Input['requirements']> = [];
    await scoreOnce(control.world, { userId: b, jobId, locale: PERSONAS.get(b)!.locale, prompt: 'scorer_v4', answerer: { kind: 'replay', answer: v4Answer('high', { userId: b, jobId }) }, deps: { resolveModel: () => 'vendor/scorer-model', repo: control.world.repo, scorerV4: { run: async (input) => (handed.push(input.requirements), Promise.reject(new Error('stop'))) } } });
    expect(handed[0]).toHaveLength(1);
  });

  it('with recruiters\' grades the Spearman correlation is printed as a human-labelled value; scorer v3 recorded the same way is printed next to it', async () => {
    const dir = intlFixtures('audit');
    const order: string[] = [];
    const strong = (key: string) => {
      if (!order.includes(key)) order.push(key);
      return order.indexOf(key) % 2 === 0;
    };
    const recording = await record(dir, (pair) => v4Answer(strong(`${pair.userId}::${pair.jobId}`) ? 'high' : 'low', pair));
    // SYNTHETIC grades for the test: a "recruiter" who agrees with the scorer (3 for the strong pairs, 0 for the weak ones).
    const grades = Object.fromEntries(recording.pairs.map((p) => [`${p.personaId}::${p.postingId}`, strong(`${p.personaId}::${p.postingId}`) ? 3 : 0]));
    const auditFile = path.join(scorerFolder(dir), SCORER_FILES.audit('intl'));
    const writeAudit = (g: Record<string, number>) => writeFileSync(auditFile, JSON.stringify({ _synthetic: true, market: 'intl', labels: 'human', gradedAt: '2026-10-05T00:00:00.000Z', grades: g }));
    writeAudit(grades);
    const replayed = (await replayRecording(recording, dir))!;
    const agree = spearmanWithHuman(replayed, loadScorerAudit(dir, 'intl')!);
    expect(agree.n).toBe(PAIRS);
    expect(agree.value!).toBeGreaterThan(0.6);
    const disagree = spearmanWithHuman(replayed, { _synthetic: true, market: 'intl', labels: 'human', gradedAt: 'x', grades: Object.fromEntries(Object.entries(grades).map(([k, g]) => [k, g === 3 ? 0 : 3])) as never });
    expect(disagree.value!).toBeLessThan(-0.6);
    // Pairs with no grade are not part of it.
    expect(spearmanWithHuman(replayed, { _synthetic: true, market: 'intl', labels: 'human', gradedAt: 'x', grades: {} })).toEqual({ value: null, n: 0 });

    const measures = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    expect(row(measures, 'spearman_human', 'intl')).toMatchObject({ value: agree.value, n: PAIRS, labels: 'human' });
    expect(row(measures, 'spearman_human', 'intl').note).toContain('recruiter grades of 2026-10-05');
    expect(measures.some((m) => m.metric === 'spearman_human_v3')).toBe(false);
    // The v4 recording and the audit are on disk and `spearman_human` is measured (it passes); the comparison with
    // scorer v3 is NOT, and its row says which file is missing and the command that records it (M4 cross-review).
    const missingV3 = row(measures, 'spearman_human_gain_over_v3', 'intl');
    expect(missingV3).toMatchObject({ value: null, status: 'no_fixture' });
    expect(missingV3.note).toContain('fixtures/scorer/recorded.v3.intl.json is not on disk');
    expect(missingV3.note).toContain('MATCH_SCORER_RUBRIC=fit_v3 EVAL_LIVE=1 EVAL_SCORER_RECORD=1 npm run eval:match -- --live');
    const withoutV3 = reportOf(measures);
    expect(withoutV3.rows.find((r) => r.metric === 'spearman_human [intl]')).toMatchObject({ status: 'pass' });
    expect(withoutV3.rows.find((r) => r.metric === 'spearman_human_gain_over_v3 [intl]')).toMatchObject({ gate: '>= 0', status: 'no_fixture' });

    // Scorer v3, recorded the same way (the rollback switch set), on the same pairs.
    const v3 = await record(dir, (pair) => v3Answer(strong(`${pair.userId}::${pair.jobId}`) ? 'high' : 'low'), {}, 'scorer_v3');
    expect(v3.scorer).toEqual({ prompt: 'scorer_v3', rubric: 'fit_v3', model: 'vendor/scorer-model' });
    expect(existsSync(path.join(scorerFolder(dir), 'recorded.v3.intl.json'))).toBe(true);
    const both = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    expect(row(both, 'spearman_human_v3', 'intl')).toMatchObject({ n: PAIRS, labels: 'human' });
    expect(row(both, 'spearman_human_v3', 'intl').note).toContain('(scorer_v3)');
    const gain = row(both, 'spearman_human_gain_over_v3', 'intl');
    expect(gain.value).toBeCloseTo(row(both, 'spearman_human', 'intl').value! - row(both, 'spearman_human_v3', 'intl').value!, 10);
    const report = reportOf(both);
    expect(report.rows.find((r) => r.metric === 'spearman_human [intl]')).toMatchObject({ gate: '>= 0.6', status: 'pass' });
    expect(report.rows.find((r) => r.metric === 'spearman_human [intl]')!.value).toContain('human labels');

    // Two graded pairs always correlate at +1 or -1: under 30 graded pairs the row is no gated value, and nothing is compared with v3.
    const two = Object.fromEntries(Object.entries(grades).slice(0, 2));
    expect(Math.abs(spearmanWithHuman(replayed, { _synthetic: true, market: 'intl', labels: 'human', gradedAt: 'x', grades: two as never }).value!)).toBe(1);
    writeAudit(Object.fromEntries(Object.entries(grades).slice(0, 29)));
    const few = await run(ctx({ markets: ['intl'], fixturesDir: dir }));
    expect(row(few, 'spearman_human', 'intl')).toMatchObject({ value: null, status: 'no_fixture', n: 29, labels: 'human' });
    expect(row(few, 'spearman_human', 'intl').note).toContain('29 graded pairs were scored in every run; 30 are needed');
    // Nothing is compared with v3 then: no v3 value is printed, and the comparison reads `no_fixture` for the same reason.
    expect(few.some((m) => m.metric === 'spearman_human_v3')).toBe(false);
    expect(row(few, 'spearman_human_gain_over_v3', 'intl')).toMatchObject({ value: null, status: 'no_fixture', n: 29 });
    expect(row(few, 'spearman_human_gain_over_v3', 'intl').note).toContain('29 graded pairs were scored in every run; 30 are needed');
    expect(reportOf(few).rows.find((r) => r.metric === 'spearman_human [intl]')).toMatchObject({ status: 'no_fixture' });
    // The stability rows do not depend on the audit.
    expect(row(few, 'tier_flip_rate', 'intl')).toMatchObject({ value: 0, n: PAIRS });
  });

  it('nothing is written when there is no scorer model, no fixture or no answer at all', async () => {
    const dir = intlFixtures('skip');
    const out = scorerFolder(dir);
    const deps = { pinnedPrompt: async () => 'scorer_v4' as const, maxPairs: 4 };
    expect(await recordMarket({ market: 'intl', fixturesDir: dir, outDir: out, now: NOW, deps: { ...deps, resolveModel: async () => null, score: fakeModel((pair) => v4Answer('high', pair)) } })).toEqual({ skipped: 'no scorer model is configured for intl' });
    expect(await recordMarket({ market: 'cn', fixturesDir: dir, outDir: out, now: NOW, deps: { ...deps, resolveModel: async () => 'm', score: fakeModel((pair) => v4Answer('high', pair)) } })).toEqual({ skipped: 'no personas, postings or labels for cn in fixtures/' });
    const silent = await recordMarket({ market: 'intl', fixturesDir: dir, outDir: out, now: NOW, deps: { ...deps, resolveModel: async () => 'm', score: async () => Promise.reject(new Error('route refused')) } });
    expect(silent).toMatchObject({ skipped: expect.stringContaining('the scorer gave no answer for intl') });
    expect(existsSync(path.join(out, SCORER_FILES.recorded('intl')))).toBe(false);
  });
});

describe('the recruiters\' sheet comes back as the audit fixture', () => {
  const CSV = ['pair_id,persona_id,posting_id,persona_summary,persona_resume,posting_title,posting_text,human_grade_0_to_3', 'p1::j1,p1,j1,s,r,t,x,3', "p1::j2,p1,j2,s,r,t,x,'0", 'p2::j1,p2,j1,s,r,t,x,', 'p2::j3,p2,j3,s,r,t,x,great'].join('\r\n');

  it('grades 0 to 3 are kept, an empty or unreadable cell is left out, and the file says the labels are human', () => {
    expect(scorerAuditFromCsv(CSV, 'intl', NOW)).toEqual({ _synthetic: true, market: 'intl', labels: 'human', gradedAt: NOW.toISOString(), grades: { 'p1::j1': 3, 'p1::j2': 0 } });
  });

  it('the import command writes audit.<market>.json into the scorer fixtures and refuses a call without a market', () => {
    const dir = tmp('import');
    const csv = path.join(dir, 'graded.csv');
    writeFileSync(csv, CSV);
    const log: string[] = [];
    const io = { log: (line: string) => log.push(line), now: () => NOW, fixturesDir: dir };
    expect(importAuditMain(['--import-audit', csv], io)).toBe(2);
    expect(importAuditMain(['--import-audit', csv, '--market', 'tw'], io)).toBe(2);
    expect(log[0]).toMatch(/^Usage: /);
    expect(importAuditMain(['--import-audit', csv, '--market', 'cn'], io)).toBe(0);
    expect(loadScorerAudit(dir, 'cn')).toEqual({ _synthetic: true, market: 'cn', labels: 'human', gradedAt: NOW.toISOString(), grades: { 'p1::j1': 3, 'p1::j2': 0 } });
    expect(log.at(-1)).toContain('Stored 2 recruiter grades for cn');
  });
});
