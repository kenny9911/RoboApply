// @vitest-environment node
//
// The retrieval suite of the match harness (MKT-4F; MARKET_STRATEGY 2.6):
//   - the in-memory legs and the SQL builders agree on which fixture rows a
//     query matches, with one segmentation function on both sides;
//   - the fusion under test is the function the feed uses, not a copy;
//   - proxy vectors are printed and never gated; recorded vectors are gated;
//   - live mode records vectors and times the real statements, with every
//     network and database dependency replaced by a fake.
// No network, no database, no model.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as feedRanking from '../../../feed/ranking.js';
import * as hybridSql from '../../../feed/hybridSql.js';
import { FakeFeedRepo, lexicalMatch, tsQueryTokens } from '../../../feed/testkit.js';
import { toTsQuery } from '../../../retrieval/index.js';
import { FIXTURES_DIR, loadMarketFixtures, type MarketFixtures } from '../fixtures/load.js';
import { CAREER_CHANGER_SUBSET, findGate, gateReads } from '../gates.js';
import { buildReport, type SuiteRun } from '../run.js';
import { EVAL_DIR, REPO_ROOT } from '../seams.js';
import type { SuiteContext, SuiteMeasure } from '../suite.js';
import { EVAL_NOW } from '../world.js';
import {
  LATENCY_OFFLINE_NOTE,
  PROXY_MODEL,
  PROXY_NOTE,
  RECALL_K,
  VECTORS_FILE,
  buildWorld,
  decodeVector,
  encodeVector,
  loadCode,
  measuresOf,
  percentile,
  personaQueryOf,
  proxyVector,
  readVectorsFile,
  recallAt,
  recallOfMarket,
  recordVectors,
  retrieveFor,
  run,
  textHash,
  textsOf,
  timeFirstWindow,
  vectorsFor,
  type PersonaRecall,
  type RetrievalWorld,
  type VectorsFile,
} from './retrieval.suite.js';

const tmpDirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'retrieval-suite-'));
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const ctx = (over: Partial<SuiteContext> = {}): SuiteContext => ({ markets: ['intl', 'cn'], live: false, repoRoot: REPO_ROOT, evalDir: EVAL_DIR, fixturesDir: FIXTURES_DIR, now: EVAL_NOW, ...over });
const suiteRun = (measures: SuiteMeasure[]): SuiteRun => ({ file: 'retrieval.suite.ts', name: 'retrieval', layer: 'retrieval', measures, error: null, notBuilt: null });
const report = (measures: SuiteMeasure[]) => buildReport({ enforce: 'all', live: false, invariants: [], suites: [suiteRun(measures)], baselines: {}, audit: null, listUnbuilt: false });

let code: Awaited<ReturnType<typeof loadCode>>;
let fx: Record<'intl' | 'cn', MarketFixtures>;
let worlds: Record<'intl' | 'cn', RetrievalWorld>;

beforeAll(async () => {
  code = await loadCode();
  fx = { intl: loadMarketFixtures('intl')!, cn: loadMarketFixtures('cn')! };
  worlds = { intl: buildWorld(fx.intl, code, null), cn: buildWorld(fx.cn, code, null) };
});

/** A recorded-vectors file whose vectors are the proxy's (the format and the hashes are real; only the model is not). */
function recordedFile(market: 'intl' | 'cn', model = 'test/embed@1024'): VectorsFile {
  const texts = textsOf(fx[market], code);
  const pack = (wanted: Map<string, string>) => Object.fromEntries([...wanted].map(([id, text]) => [id, { hash: textHash(text), v: encodeVector(proxyVector(text, code.segmentForSearch)) }]));
  return { _synthetic: true, _generatedBy: 'test', market, model, dimensions: 1024, encoding: 'f32le-base64', recordedAt: EVAL_NOW.toISOString(), postings: pack(texts.postings), personas: pack(texts.personas) };
}

describe('the code under test is the feed\'s own', () => {
  it('fuses with the feed\'s function and builds the statements with the feed\'s builders (loaded by path, not copied)', () => {
    expect(code.fuseByReciprocalRank).toBe(feedRanking.fuseByReciprocalRank);
    expect(code.recencyLegSql).toBe(hybridSql.recencyLegSql);
    expect(code.lexicalLegSql).toBe(hybridSql.lexicalLegSql);
    expect(code.denseLegSql).toBe(hybridSql.denseLegSql);
    expect(code.FakeFeedRepo).toBe(FakeFeedRepo);
    expect(code.toTsQuery).toBe(toTsQuery);
    const source = readFileSync(path.join(EVAL_DIR, 'suites', 'retrieval.suite.ts'), 'utf8');
    // Nothing of the feed or of the retrieval area is imported statically, and no fusion is written here.
    expect(source).not.toMatch(/from '\.\.\/\.\.\/\.\.\/(feed|retrieval)\//);
    expect(source).not.toMatch(/1 \/ \(/);
  });
});

describe('the in-memory legs and the SQL builders agree on which fixture rows match a query', () => {
  /** What `to_tsvector('simple', searchDoc)` holds: the document is stored as space-separated tokens. */
  const lexemesOf = (doc: string) => new Set(doc.split(' ').filter(Boolean));
  /** What `to_tsquery('simple', q)` asks for: the operands of the OR, unquoted (parsed here, not by the fake). */
  const operandsOf = (tsQuery: string) => tsQuery.split(' | ').map((t) => t.replace(/^'|'$/g, '').replace(/''/g, "'"));

  const cases: Array<['intl' | 'cn', string]> = [
    ['intl', 'kubernetes'],
    ['intl', 'Senior Backend Engineer Go PostgreSQL'],
    ['intl', '產品經理'],
    ['intl', 'node.js C++ .NET'],
    ['cn', '后端开发工程师'],
    ['cn', '产品 经理 数据分析'],
    ['cn', 'Java Redis'],
  ];

  it.each(cases)('%s: "%s"', async (market, text) => {
    const world = worlds[market];
    const tsQuery = toTsQuery(text)!;
    const scope = { market, userId: null, now: world.now, publicOnly: true, ignoreHidden: true };
    const sql = code.lexicalLegSql({ scope, filters: {}, ageFloor: new Date(world.now.getTime() - 120 * 86_400_000), limit: 100_000 }, tsQuery);
    // The builder binds the query the shared tokenizer made, twice (the match and the rank).
    expect(sql.values.filter((v) => v === tsQuery)).toHaveLength(2);
    expect(tsQueryTokens(tsQuery)).toEqual(operandsOf(tsQuery));
    const inMemory = (await world.repo.queryRows(sql)).map((r) => r.id);
    // Independently: the rows whose stored lexemes hold an operand of the query.
    const operands = operandsOf(tsQuery);
    const expected = fx[market].postings.filter((p) => operands.some((t) => lexemesOf(world.repo.searchDocs.get(p.id)!).has(t))).map((p) => p.id);
    expect(expected.length).toBeGreaterThan(0);
    expect([...inMemory].sort()).toEqual([...expected].sort());
    // Best rank first: the count of the query's lexemes in the document never rises down the list.
    const count = (id: string) => world.repo.searchDocs.get(id)!.split(' ').filter((t) => operands.includes(t)).length;
    const counts = inMemory.map(count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('the in-memory twin reads a stored document as PostgreSQL does: its own tokens, never segmented a second time', () => {
    const quote = (token: string) => `'${token.replace(/'/g, "''")}'`;
    let resegmentWouldDiffer = 0;
    for (const market of ['intl', 'cn'] as const) {
      for (const p of fx[market].postings.slice(0, 60)) {
        const doc = worlds[market].repo.searchDocs.get(p.id)!;
        const stored = doc.split(' ');
        // What indexing wrote is space-joined tokens with no empty piece.
        expect(stored.every((t) => t.length > 0 && !/\s/.test(t)), p.id).toBe(true);
        if (code.segmentForSearch(doc).length !== stored.length) resegmentWouldDiffer += 1;
        // Every stored token is found, with the count of its own occurrences as the rank.
        for (const token of new Set(stored.slice(0, 12))) {
          expect(lexicalMatch(doc, quote(token)), `${p.id} ${token}`).toEqual({ matches: true, rank: stored.filter((t) => t === token).length });
        }
        expect(lexicalMatch(doc, quote('no-such-token-zzz')).matches).toBe(false);
      }
    }
    // Segmenting a document again would add tokens (a long Chinese word yields its bigrams twice): the twin must not.
    expect(resegmentWouldDiffer).toBeGreaterThan(0);
  });

  it('a persona\'s lexical query is the feed\'s profile query: recent title, role names, top skills', () => {
    const persona = fx.intl.personas[0]!;
    const tsQuery = personaQueryOf(persona, code)!;
    const operands = operandsOf(tsQuery);
    for (const token of code.segmentForSearch(persona.recentTitles[0]!)) expect(operands).toContain(token);
    expect(operands.length).toBeLessThanOrEqual(24);
    // The Chinese market asks with the Chinese role name too.
    expect(personaQueryOf(fx.cn.personas[0]!, code)).toMatch(/[一-鿿]/);
  });

  it('the dense leg is the exact nearest neighbours by cosine distance, inside the model of the run', async () => {
    const world = worlds.intl;
    const persona = fx.intl.personas[0]!;
    const legs = await retrieveFor(world, persona);
    const q = world.vectors.personas.get(persona.id)!;
    const cos = (v: number[]) => {
      let dot = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < v.length; i += 1) {
        dot += v[i]! * q[i]!;
        a += v[i]! * v[i]!;
        b += q[i]! * q[i]!;
      }
      return 1 - dot / Math.sqrt(a * b);
    };
    const distances = legs.dense.map((id) => cos(world.vectors.postings.get(id)!));
    // The suite hands the vector over as the literal pgvector reads; six decimals are kept of the comparison.
    for (let i = 1; i < distances.length; i += 1) expect(distances[i]!).toBeGreaterThanOrEqual(distances[i - 1]! - 1e-6);
    expect(legs.dense).toHaveLength(200);
    // A statement of another model tag finds no vector: two models are never compared.
    const scope = { market: 'intl', userId: null, now: world.now, publicOnly: true, ignoreHidden: true };
    const other = code.denseLegSql({ scope, filters: {}, ageFloor: new Date(0), limit: 200 }, code.vectorLiteral(q), 'another/model@1024');
    expect(await world.repo.queryRows(other)).toEqual([]);
  });

  it('the legs of one persona: the recency leg is today\'s window, the fused list is cut at the feed\'s cap and leads with what several legs agree on', async () => {
    const world = worlds.intl;
    const legs = await retrieveFor(world, fx.intl.personas[0]!);
    expect(legs.recencyOnly).toHaveLength(RECALL_K);
    expect(legs.recency.length).toBeLessThanOrEqual(200);
    expect(legs.fused.length).toBeLessThanOrEqual(400);
    const inLegs = (id: string) => [legs.recency, legs.lexical, legs.dense].filter((l) => l.includes(id)).length;
    expect(inLegs(legs.fused[0]!)).toBeGreaterThanOrEqual(2);
    expect(new Set(legs.fused).size).toBe(legs.fused.length);
  });
});

describe('measures', () => {
  it('recallAt: the share of the relevant postings among the first k; nothing relevant is nothing to measure', () => {
    expect(recallAt(['a', 'b', 'c'], new Set(['a', 'c', 'z']))).toBeCloseTo(2 / 3, 10);
    expect(recallAt(['a', 'b', 'c'], new Set(['c']), 2)).toBe(0);
    expect(recallAt(['a'], new Set())).toBeNull();
    expect(RECALL_K).toBe(200);
  });

  it('percentile: the 95th of the timings (nearest rank); nothing timed is nothing', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
    expect(percentile([30, 10, 20], 0.95)).toBe(30);
  });

  it('the gated values leave career changers out, name the worst persona, and hand the recency value over as the reference', () => {
    const persona = (id: string, kind: string) => ({ ...fx.intl.personas[0]!, id, kind }) as PersonaRecall['persona'];
    const rows: PersonaRecall[] = [
      { persona: persona('a', 'standard'), relevant: 10, recency: 0.5, hybrid: 0.9 },
      { persona: persona('b', 'new_graduate'), relevant: 10, recency: 0.8, hybrid: 0.78 },
      { persona: persona('c', CAREER_CHANGER_SUBSET), relevant: 10, recency: 0.7, hybrid: 0.1 },
    ];
    const measures = measuresOf('intl', rows, { kind: 'recorded', model: 'test/embed@1024', missing: 0 });
    const by = (metric: string, subset?: string) => measures.find((m) => m.metric === metric && (m.subset ?? null) === (subset ?? null))!;
    expect(by('recall_at_200_recency').value).toBeCloseTo(0.65, 10);
    expect(by('recall_at_200_hybrid')).toMatchObject({ n: 2, reference: by('recall_at_200_recency').value, labels: 'constructed' });
    expect(by('recall_at_200_hybrid').value).toBeCloseTo(0.84, 10);
    expect(by('recall_at_200_worst_persona_delta').value).toBeCloseTo(-0.02, 10);
    expect(by('recall_at_200_worst_persona_delta').note).toContain('worst persona b');
    for (const m of measures.filter((x) => !x.subset)) expect(m.status).toBeUndefined();
    // Career changers: printed on rows no gate reads.
    expect(by('recall_at_200_recency', CAREER_CHANGER_SUBSET).value).toBe(0.7);
    expect(by('recall_at_200_fused', CAREER_CHANGER_SUBSET).value).toBe(0.1);
    expect(findGate('retrieval', 'recall_at_200_fused')).toBeNull();
    expect(findGate('retrieval', 'recall_at_200_recency')).toBeNull();
    expect(gateReads(findGate('retrieval', 'recall_at_200_hybrid')!, CAREER_CHANGER_SUBSET)).toBe(true);
    // With recorded vectors the gate is evaluated: +19 points passes, and −2 points for the worst persona is inside −5.
    const r = report(measures);
    expect(r.rows.filter((x) => x.status === 'pass').map((x) => x.metric)).toEqual(['recall_at_200_hybrid [intl]', 'recall_at_200_worst_persona_delta [intl]']);
    expect(r.exitCode).toBe(0);
    // And a miss fails the command: recorded vectors are the gate.
    const miss = measuresOf('intl', [{ persona: persona('a', 'standard'), relevant: 10, recency: 0.5, hybrid: 0.6 }], { kind: 'recorded', model: 'm', missing: 0 });
    expect(report(miss).exitCode).toBe(1);
  });
});

describe('vectors: recorded, else proxy', () => {
  it('the proxy is deterministic, 1024 numbers, never all zeros, and closer for texts that share tokens', () => {
    const seg = code.segmentForSearch;
    const a = proxyVector('backend engineer go postgresql', seg);
    expect(a).toHaveLength(1024);
    expect(proxyVector('backend engineer go postgresql', seg)).toEqual(a);
    expect(proxyVector('', seg).some((n) => n !== 0)).toBe(true);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0) / Math.sqrt(x.reduce((s, v) => s + v * v, 0) * y.reduce((s, v) => s + v * v, 0));
    expect(cos(a, proxyVector('backend engineer rust postgresql', seg))).toBeGreaterThan(cos(a, proxyVector('landscape architect planting plans', seg)));
  });

  it('a vector survives the file encoding; a malformed or zero entry does not decode', () => {
    const v = proxyVector('backend engineer', code.segmentForSearch);
    expect(decodeVector(encodeVector(v))).toEqual(v);
    expect(decodeVector(encodeVector(v.slice(0, 10)))).toBeNull();
    expect(decodeVector(encodeVector(new Array(1024).fill(0)))).toBeNull();
    expect(decodeVector('not base64 of the right length')).toBeNull();
  });

  it('recorded vectors are used only when they cover every text as it is now; otherwise the whole run is on the proxy', () => {
    const texts = textsOf(fx.cn, code);
    const file = recordedFile('cn');
    const all = vectorsFor(texts, file, code.segmentForSearch);
    expect(all).toMatchObject({ kind: 'recorded', model: 'test/embed@1024', missing: 0 });
    expect(all.postings.size).toBe(fx.cn.postings.length);
    expect(all.personas.size).toBe(fx.cn.personas.length);
    // One posting's text changed since the file was recorded (another hash): never a mix of model and proxy.
    const first = fx.cn.postings[0]!.id;
    const stale = { ...file, postings: { ...file.postings, [first]: { ...file.postings[first]!, hash: textHash('an older text') } } };
    expect(vectorsFor(texts, stale, code.segmentForSearch)).toMatchObject({ kind: 'proxy', model: PROXY_MODEL, missing: 1 });
    const { [first]: _gone, ...rest } = file.postings;
    expect(vectorsFor(texts, { ...file, postings: rest }, code.segmentForSearch).kind).toBe('proxy');
    expect(vectorsFor(texts, null, code.segmentForSearch).kind).toBe('proxy');
  });

  it('a file of another shape is refused loudly, a missing one is simply absent', () => {
    const dir = tmp();
    expect(readVectorsFile(dir, 'cn')).toBeNull();
    writeFileSync(path.join(dir, VECTORS_FILE('cn')), JSON.stringify({ _synthetic: true, market: 'intl', dimensions: 1024 }));
    expect(() => readVectorsFile(dir, 'cn')).toThrow(/recorded-vectors shape/);
  });
});

describe('the suite, fixtures only', () => {
  it('on proxy vectors: the values are printed with the note, no row is held against the gate, the command does not fail', async () => {
    const measures = await run(ctx(), { vectorsDir: tmp() });
    const gated = measures.filter((m) => (m.layer ?? 'retrieval') === 'retrieval' && !m.subset);
    expect(gated.map((m) => [m.metric, m.market])).toEqual([
      ['recall_at_200_recency', 'intl'],
      ['recall_at_200_hybrid', 'intl'],
      ['recall_at_200_worst_persona_delta', 'intl'],
      ['recall_at_200_recency', 'cn'],
      ['recall_at_200_hybrid', 'cn'],
      ['recall_at_200_worst_persona_delta', 'cn'],
    ]);
    for (const m of gated) {
      expect(m.status).toBe('no_fixture');
      expect(m.note).toBe(PROXY_NOTE);
      expect(typeof m.value).toBe('number');
      expect(m.labels).toBe('constructed');
    }
    // Career changers apart (3 intl, 4 cn), never in the gated n.
    expect(gated.filter((m) => m.metric === 'recall_at_200_hybrid').map((m) => m.n)).toEqual([37, 36]);
    expect(measures.filter((m) => m.subset === CAREER_CHANGER_SUBSET).map((m) => [m.metric, m.market, m.n])).toEqual([
      ['recall_at_200_recency', 'intl', 3],
      ['recall_at_200_fused', 'intl', 3],
      ['recall_at_200_recency', 'cn', 4],
      ['recall_at_200_fused', 'cn', 4],
    ]);
    // Per language subset, for the language comparison: printed in the language layer, where no gate reads them.
    const subsets = measures.filter((m) => m.layer === 'language');
    expect(new Set(subsets.map((m) => m.subset))).toEqual(new Set(['en', 'zh-TW', 'zh-CN', 'cross']));
    for (const m of subsets) expect(findGate('language', m.metric)).toBeNull();
    // Latency cannot be measured on in-memory rows: the row says it needs a live run, per market.
    expect(measures.filter((m) => m.metric === 'feed_p95_ms')).toEqual([
      { metric: 'feed_p95_ms', value: null, status: 'skipped_offline', note: LATENCY_OFFLINE_NOTE, layer: 'latency', market: 'intl' },
      { metric: 'feed_p95_ms', value: null, status: 'skipped_offline', note: LATENCY_OFFLINE_NOTE, layer: 'latency', market: 'cn' },
    ]);
    const r = report(measures);
    expect(r.exitCode).toBe(0);
    expect(r.failures).toEqual([]);
    expect(r.rows.filter((x) => x.layer === 'latency').map((x) => x.status)).toEqual(['skipped_offline', 'skipped_offline']);
    expect(r.rows.filter((x) => x.layer === 'retrieval' && !x.metric.includes(CAREER_CHANGER_SUBSET)).every((x) => x.status === 'no_fixture')).toBe(true);
    // The fused list finds what the newest 200 miss, on both markets, with the proxy alone.
    const value = (metric: string, market: string) => gated.find((m) => m.metric === metric && m.market === market)!.value!;
    for (const market of ['intl', 'cn']) expect(value('recall_at_200_hybrid', market)).toBeGreaterThan(value('recall_at_200_recency', market));
  });

  it('with recorded vectors the same rows carry no status: the gate is evaluated', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, VECTORS_FILE('cn')), JSON.stringify(recordedFile('cn')));
    const measures = await run(ctx({ markets: ['cn'] }), { vectorsDir: dir });
    const gated = measures.filter((m) => (m.layer ?? 'retrieval') === 'retrieval' && !m.subset);
    for (const m of gated) {
      expect(m.status).toBeUndefined();
      expect(m.note).toContain('recorded vectors of test/embed@1024');
    }
    const rows = report(measures).rows.filter((x) => x.layer === 'retrieval' && !x.metric.includes(CAREER_CHANGER_SUBSET));
    expect(rows.map((x) => x.status).every((s) => s === 'pass' || s === 'fail' || s === 'info')).toBe(true);
    expect(rows.find((x) => x.metric.startsWith('recall_at_200_hybrid'))!.status).toMatch(/^(pass|fail)$/);
  });

  it('no fixtures: every measure says so', async () => {
    const empty = tmp();
    const measures = await run(ctx({ fixturesDir: empty }));
    expect(measures).toHaveLength(6);
    for (const m of measures) expect(m).toMatchObject({ value: null, status: 'no_fixture' });
  });

  it('recall per persona is computed against the constructed labels graded 2 or 3', async () => {
    const rows = await recallOfMarket(fx.cn, worlds.cn);
    expect(rows).toHaveLength(40);
    for (const r of rows) {
      expect(r.relevant).toBeGreaterThanOrEqual(5);
      expect(r.recency).toBeGreaterThanOrEqual(0);
      expect(r.hybrid).toBeLessThanOrEqual(1);
    }
  });
});

describe('live mode, with every dependency a fake', () => {
  const liveCtx = (over: Partial<SuiteContext> = {}) => ctx({ markets: ['cn'], live: true, ...over });

  function fakes(model = 'live/embed@1024', answer: 'vectors' | 'unavailable' = 'vectors') {
    const embedCalls: Array<{ brand: string; n: number; options: { purpose: string; carriesUserData: boolean } }> = [];
    const statements: Array<{ text: string; values: unknown[] }> = [];
    let t = 0;
    return {
      embedCalls,
      statements,
      deps: {
        embed: async (brand: 'roboapply' | 'goapply', texts: readonly string[], options: { purpose: 'job' | 'user'; carriesUserData: boolean }) => {
          embedCalls.push({ brand, n: texts.length, options });
          if (answer === 'unavailable') return { unavailable: 'no_key' };
          return { vectors: texts.map((text) => proxyVector(text, code.segmentForSearch)), model };
        },
        withReadOnly: async <T,>(fn: (query: <R>(sql: { text: string; values: unknown[] }) => Promise<R[]>) => Promise<T>) =>
          fn(async (sql) => {
            statements.push({ text: sql.text, values: sql.values });
            t += 7;
            return [];
          }),
        queryModelTag: async () => model,
        clock: () => t,
        env: {} as Record<string, string | undefined>,
      },
    };
  }

  it('records the vectors of the synthetic texts once, as job and user texts with no user data, and reuses them on the next run', async () => {
    const dir = tmp();
    const f = fakes();
    const logs: string[] = [];
    const first = await run(liveCtx(), { ...f.deps, vectorsDir: dir, log: (l) => logs.push(l) });
    expect(f.embedCalls).toEqual([
      { brand: 'goapply', n: fx.cn.postings.length, options: { purpose: 'job', carriesUserData: false } },
      { brand: 'goapply', n: fx.cn.personas.length, options: { purpose: 'user', carriesUserData: false } },
    ]);
    const file = readVectorsFile(dir, 'cn')!;
    expect(file).toMatchObject({ _synthetic: true, market: 'cn', model: 'live/embed@1024', dimensions: 1024, encoding: 'f32le-base64' });
    expect(Object.keys(file.postings)).toHaveLength(fx.cn.postings.length);
    expect(Object.keys(file.personas)).toHaveLength(fx.cn.personas.length);
    expect(readFileSync(path.join(dir, VECTORS_FILE('cn')), 'utf8').startsWith('{"_synthetic":true')).toBe(true);
    expect(logs[0]).toContain('embedded with live/embed@1024');
    // The run that recorded them is already gated on them.
    expect(first.find((m) => m.metric === 'recall_at_200_hybrid' && !m.subset)!.status).toBeUndefined();
    // Nothing changed: the next live run embeds nothing.
    const again = fakes();
    await run(liveCtx(), { ...again.deps, vectorsDir: dir });
    expect(again.embedCalls).toEqual([]);
    // Another model: nothing of the old file is reused.
    const moved = fakes('live/other@1024');
    const before = readVectorsFile(dir, 'cn')!;
    const stale = { ...before, postings: { ...before.postings } };
    delete stale.postings[fx.cn.postings[0]!.id];
    writeFileSync(path.join(dir, VECTORS_FILE('cn')), JSON.stringify(stale));
    await run(liveCtx(), { ...moved.deps, vectorsDir: dir });
    expect(readVectorsFile(dir, 'cn')!.model).toBe('live/other@1024');
    expect(moved.embedCalls.reduce((n, c) => n + c.n, 0)).toBe(fx.cn.postings.length + fx.cn.personas.length);
  });

  it('an unavailable client records nothing and leaves the run on proxy vectors', async () => {
    const dir = tmp();
    const f = fakes('live/embed@1024', 'unavailable');
    const logs: string[] = [];
    const measures = await run(liveCtx(), { ...f.deps, vectorsDir: dir, log: (l) => logs.push(l) });
    expect(readVectorsFile(dir, 'cn')).toBeNull();
    expect(logs[0]).toContain('no vectors recorded for cn');
    expect(measures.find((m) => m.metric === 'recall_at_200_hybrid' && !m.subset)).toMatchObject({ status: 'no_fixture', note: PROXY_NOTE });
  });

  it('times the first-window statements read-only, one run per persona, and reports the 95th percentile as a live latency value', async () => {
    const dir = tmp();
    const f = fakes();
    const measures = await run(liveCtx(), { ...f.deps, vectorsDir: dir });
    const latency = measures.find((m) => m.metric === 'feed_p95_ms')!;
    expect(latency).toMatchObject({ layer: 'latency', market: 'cn', scope: 'live', n: 40, labels: 'none' });
    // Three statements a persona, 7 ms each on the fake clock.
    expect(latency.value).toBe(21);
    expect(f.statements).toHaveLength(120);
    expect(f.statements.filter((s) => /JOIN "RAJobEmbedding" e/.test(s.text))).toHaveLength(40);
    expect(f.statements.filter((s) => /ORDER BY ts_rank_cd/.test(s.text))).toHaveLength(40);
    // Only SELECT statements, under the persona's role and place, in the market of the run.
    for (const s of f.statements) {
      expect(s.text.startsWith('SELECT ')).toBe(true);
      expect(s.text).toContain('j."taxonomyIds" && ');
      expect(s.values).toContain('cn');
    }
    expect(findGate('latency', 'feed_p95_ms')).toMatchObject({ liveOnly: true, rule: { kind: 'max_increase', amount: 150 } });
  });

  it('FEED_HYBRID=off times the single recency statement (how the baseline of "today" is written); without the query model the dense leg is left out', async () => {
    const texts = textsOf(fx.cn, code);
    const vectors = vectorsFor(texts, recordedFile('cn', 'live/embed@1024'), code.segmentForSearch);
    const timed = async (env: Record<string, string>, tag: string | null) => {
      const f = fakes();
      const out = await timeFirstWindow({ market: 'cn', personas: fx.cn.personas.slice(0, 5), code, vectors, now: EVAL_NOW, deps: { withReadOnly: f.deps.withReadOnly as never, clock: f.deps.clock, queryModelTag: async () => tag, env } });
      return { out, statements: f.statements };
    };
    const off = await timed({ FEED_HYBRID: 'off' }, 'live/embed@1024');
    expect(off.out).toMatchObject({ hybrid: false, dense: false, n: 5, p95: 7 });
    expect(off.statements).toHaveLength(5);
    expect(off.statements.every((s) => /ORDER BY j\."postedAt" DESC NULLS LAST/.test(s.text) && s.values.at(-1) === 400)).toBe(true);
    const otherModel = await timed({}, 'previous/model@1024');
    expect(otherModel.out).toMatchObject({ hybrid: true, dense: false, p95: 14 });
    expect(otherModel.statements.some((s) => /RAJobEmbedding/.test(s.text))).toBe(false);
    const on = await timed({}, 'live/embed@1024');
    expect(on.out).toMatchObject({ hybrid: true, dense: true, p95: 21 });
  });

  it('recordVectors answers why nothing was recorded, and never writes a partial file', async () => {
    const dir = tmp();
    const texts = textsOf(fx.cn, code);
    let calls = 0;
    const flaky = await recordVectors({
      market: 'cn',
      texts,
      dir,
      now: EVAL_NOW,
      embed: async (_b, list) => {
        calls += 1;
        return calls === 1 ? { vectors: list.map((t) => proxyVector(t, code.segmentForSearch)), model: 'a@1024' } : { unavailable: 'budget' };
      },
    });
    expect(flaky).toMatchObject({ file: null, reason: 'the embeddings client is unavailable (budget)' });
    expect(readVectorsFile(dir, 'cn')).toBeNull();
  });
});
