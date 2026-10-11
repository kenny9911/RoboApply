// @vitest-environment node
// MKT-2G item 4: the owner tooling. In-memory repo and files, SYNTHETIC
// fixture CSVs (__fixtures__/*.synthetic.*: invented strings, counts and
// identifiers), a fake model and a fake embeddings client. No command opens
// the network or a database.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaImports = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../lib/prisma.js', () => {
  prismaImports.count++;
  return { default: {} };
});

import { missingRowOf, rowOfRecord, SKILL_EMBED_DIMENSIONS } from './canonicalize.js';
import {
  buildNamingMessages,
  droppedDecisions,
  mergeSeedDecisions,
  DEFAULT_CLUSTERS_FILE,
  DEFAULT_REVIEW_FILE,
  DEFAULT_STRINGS_FILE,
  loadLabelEmbedder,
  parseMember,
  parseNamingReply,
  parseSkillsArgs,
  planAttachIds,
  planReviewImport,
  querySkillStrings,
  readStringsFile,
  REVIEW_HEADER,
  reviewedOverlay,
  runSkillsCommand,
  seedAdditions,
  SKILLS_COMMANDS,
  type CliIo,
  type ClusterNamer,
  type SkillsCliDeps,
} from './cli.js';
import { clusterSkillStrings, withinOneEdit, type SkillString } from './cluster.js';
import { formatCsv, guardCell, parseCsv, parseTable, splitList, unguardCell } from './csv.js';
import { aliasKey } from './keys.js';
import { createMemorySkillRepo, type MemorySkillRepo, type SkillWrite } from './repo.js';
import { buildSeed, parseAdditions, parseDropped, parseReviewed } from './seed/build.js';
import { SEED_SKILLS } from './seed/index.js';
import type { SkillRecord } from './types.js';
import { buildVocabulary, mergeOverSeed } from './vocabulary.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

function memoryIo(files: Record<string, string> = {}): CliIo & { files: Map<string, string>; writes: string[] } {
  const map = new Map(Object.entries(files));
  const writes: string[] = [];
  return {
    files: map,
    writes,
    exists: (f) => map.has(f),
    readFile: (f) => {
      const text = map.get(f);
      if (text === undefined) throw new Error(`no such file: ${f}`);
      return text;
    },
    writeFile: (f, text) => {
      writes.push(f);
      map.set(f, text);
    },
  };
}

function skill(over: Partial<SkillRecord> & { id: string; labelEn: string }): SkillRecord {
  return { kind: 'hard', labelZh: null, labelZhHant: null, aliases: [], parentId: null, esco: null, onet: null, status: 'reviewed', ...over };
}

function unreviewed(term: string, mentionCount: number): SkillWrite {
  const key = aliasKey(term);
  return { ...rowOfRecord(skill({ id: key, labelEn: term, status: 'unreviewed', aliasKeys: [key] })), mentionCount };
}

function setup(options: { files?: Record<string, string>; rows?: SkillWrite[] } = {}) {
  const io = memoryIo(options.files);
  const repo: MemorySkillRepo = createMemorySkillRepo(options.rows ?? []);
  const deps: SkillsCliDeps = { io, repo, seedPath: 'seed/skills.seed.json', reviewedPath: 'seed/reviewed.json', additionsPath: 'seed/additions.json', droppedPath: 'seed/dropped.json' };
  const run = (argv: string[], more: Partial<SkillsCliDeps> = {}) => runSkillsCommand(parseSkillsArgs(argv), { ...deps, ...more });
  return { io, repo, deps, run };
}

const SEED_FILES = ['seed/reviewed.json', 'seed/additions.json', 'seed/dropped.json', 'seed/skills.seed.json'];

const fetchSpy = vi.fn(async () => {
  throw new Error('network is off in tests');
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  // Nothing in this file may reach the network or import the database client.
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(prismaImports.count).toBe(0);
});

describe('command line', () => {
  it('is a dry run unless --apply is given', () => {
    expect(parseSkillsArgs(['propose']).apply).toBe(false);
    expect(parseSkillsArgs(['propose', '--apply']).apply).toBe(true);
    expect(parseSkillsArgs(['review-import', 'sheet.csv', '--apply'])).toMatchObject({ command: 'review-import', positional: ['sheet.csv'], apply: true });
    expect(parseSkillsArgs(['export-strings', '--market', 'cn', '--out', 'x.csv']).flags).toMatchObject({ market: 'cn', out: 'x.csv' });
  });

  it('refuses what it does not know', () => {
    expect(() => parseSkillsArgs([])).toThrow(/Name a command/);
    expect(() => parseSkillsArgs(['download-esco'])).toThrow(/Unknown command/);
    expect(() => parseSkillsArgs(['propose', '--force'])).toThrow(/Unknown option/);
    expect(() => parseSkillsArgs(['propose', '--top'])).toThrow(/needs a value/);
    expect(SKILLS_COMMANDS).toEqual(['export-strings', 'propose', 'review-export', 'review-import', 'attach-ids', 'embed-labels', 'export-seed']);
  });
});

describe('csv', () => {
  it('round-trips commas, quotes, line breaks and Chinese', () => {
    const rows = [['id', 'label', 'note'], ['a', 'data pipelines, batch', 'says "hi"'], ['b', '机器学习', 'two\nlines'], ['c', '', ' padded ']];
    expect(parseCsv(formatCsv(rows))).toEqual(rows);
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('x\ty\n1\t2\n', { delimiter: '\t' })).toEqual([['x', 'y'], ['1', '2']]);
    expect(parseTable('id, label\n1, Go\n').rows).toEqual([{ id: '1', label: 'Go' }]);
    expect(splitList('a | b|c\nd |  ')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a posting string that a spreadsheet would run as a formula is written as text, and read back as it was', () => {
    const hostile = ['=HYPERLINK("http://example.invalid","Python")', '+cmd|calc', '-2+3', '@SUM(A1)', '\t=1+1', '\r=1+1', "'=already quoted", "''-twice", '=', '+'];
    const harmless = ['Python', 'C++', 'a=b', 'e-mail', "'quoted'", '机器学习', '~Postgressql×2', '', ' =padded'];
    for (const value of hostile) {
      expect(guardCell(value).startsWith("'"), value).toBe(true);
      expect(guardCell(value)).toBe(`'${value}`);
      expect(unguardCell(guardCell(value)), value).toBe(value);
    }
    for (const value of harmless) {
      expect(guardCell(value), value).toBe(value);
      expect(unguardCell(value), value).toBe(value);
    }
    // No cell of the written file starts with a character a spreadsheet runs.
    const text = formatCsv([['term', 'mentions'], ...hostile.map((v) => [v, 3] as [string, number])]);
    const cells = parseCsv(text).slice(1).map((r) => r[0]!);
    for (const cell of cells) expect(cell, cell).not.toMatch(/^[=+\-@\t\r]/);
    // Reading the table back gives the strings that were written (cells are trimmed, as always).
    expect(parseTable(text).rows.map((r) => r.term)).toEqual(hostile.map((v) => v.trim()));
    expect(parseTable(text).rows.every((r) => r.mentions === '3')).toBe(true);
    // A number is written as a number, also a negative one.
    expect(formatCsv([['n'], [-5]])).toBe('n\n-5\n');
  });

  it('the files of the tooling carry hostile skill strings as text through the whole round', async () => {
    const term = '=HYPERLINK("http://example.invalid","Python")';
    const { run, io } = setup();
    await run(['export-strings', '--market', 'intl', '--apply'], { queryStrings: async () => [{ term, mentions: 4, kind: 'hard' }, { term: '+cmd', mentions: 2, kind: null }, { term: '@SUM(A1)', mentions: 1, kind: null }] });
    expect(readStringsFile(io.files.get(DEFAULT_STRINGS_FILE)!).map((x) => x.term)).toEqual([term, '+cmd', '@SUM(A1)']);
    await run(['propose', '--apply']);
    await run(['review-export', '--clusters', DEFAULT_CLUSTERS_FILE, '--apply']);
    for (const file of [DEFAULT_STRINGS_FILE, DEFAULT_CLUSTERS_FILE, DEFAULT_REVIEW_FILE]) {
      for (const cells of parseCsv(io.files.get(file)!)) for (const cell of cells) expect(cell, `${file}: ${cell}`).not.toMatch(/^[=+\-@\t\r]/);
    }
    // The review sheet still names the string as it was in the posting.
    const sheet = parseTable(io.files.get(DEFAULT_REVIEW_FILE)!);
    expect(sheet.rows.some((r) => r.labelEn === term)).toBe(true);
  });
});

describe('clustering', () => {
  const strings = readStringsFile(fixture('strings.synthetic.csv'));
  const vocabulary = buildVocabulary(SEED_SKILLS);
  const result = clusterSkillStrings(strings, { vocabulary });
  const by = new Map(result.clusters.map((c) => [c.id, c]));
  const members = (id: string) => by.get(id)!.members.map((m) => `${m.via}:${m.term}`);

  it('is deterministic: the same strings in any order give the same clusters', () => {
    const shuffled = [...strings].reverse();
    const rotated = [...strings.slice(7), ...strings.slice(0, 7)];
    expect(clusterSkillStrings(shuffled, { vocabulary })).toEqual(result);
    expect(clusterSkillStrings(rotated, { vocabulary })).toEqual(result);
    expect(clusterSkillStrings(strings, { vocabulary })).toEqual(result);
  });

  it('rule 1: one cluster per comparison key, both markets added up, labelled by the most frequent spelling', () => {
    expect(by.get('nodejs')).toMatchObject({ label: 'Node.js', knownId: 'nodejs', kind: 'hard' });
    expect(members('nodejs')).toEqual(['key:Node.js', 'key:nodejs', 'key:NodeJS']);
    // 机器学习 (35) and 機器學習 (4) are one key; PostgreSQL is counted in both markets.
    expect(by.get('machinelearning')!.members).toEqual(expect.arrayContaining([{ term: '机器学习', mentions: 35, via: 'key' }, { term: '機器學習', mentions: 4, via: 'key' }]));
    expect(by.get(aliasKey('PostgreSQL'))!.members[0]).toEqual({ term: 'PostgreSQL', mentions: 130, via: 'key' });
    // Two names the vocabulary already knows as one skill are one cluster, with the misspelling as a guess.
    expect(members(aliasKey('PostgreSQL'))).toEqual(['key:PostgreSQL', 'key:postgres', 'near:Postgressql']);
    expect(by.get(aliasKey('PostgreSQL'))).toMatchObject({ mentions: 172, knownId: 'postgresql' });
    // 机器学习 and "machine learning" are one skill, so one cluster, labelled by the most frequent spelling.
    expect(result.clusters.filter((c) => c.knownId === 'machine_learning')).toHaveLength(1);
    expect(by.get('supabase')).toMatchObject({ label: 'Supabase', mentions: 9, knownId: null });
  });

  it('rule 2: a string that lists skills listed on their own is no cluster; its mentions count for each part', () => {
    expect(by.has(aliasKey('typescript/node.js'))).toBe(false);
    expect(by.get('nodejs')!.mentions).toBe(90 + 30 + 5 + 12);
    expect(by.get('typescript')!.mentions).toBe(80 + 12);
    // "data pipelines, batch": its parts are not listed, so it stays one string.
    expect(by.has(aliasKey('data pipelines, batch'))).toBe(true);
  });

  it('rule 3: a one-letter misspelling joins its word, marked as a guess', () => {
    expect(members('terraform')).toEqual(['key:Terraform', 'near:Terraformm']);
    expect(by.get('terraform')!.mentions).toBe(26);
    expect(withinOneEdit('terraform', 'terraformm')).toBe(true);
    expect(withinOneEdit('terraform', 'terrafrom')).toBe(false);
    expect(withinOneEdit('nestjs', 'nextjs')).toBe(true);
    expect(withinOneEdit('same', 'same')).toBe(false);
  });

  it('rule 3 never joins two known skills, two versions or two Chinese words', () => {
    expect(by.get('nestjs')!.knownId).toBe('nestjs');
    expect(by.get('nextjs')!.knownId).toBe('next_js');
    expect(by.has('http2') && by.has('http3')).toBe(true);
    expect(by.has('前端开发工程') && by.has('后端开发工程')).toBe(true);
    expect(withinOneEdit('http2', 'http3')).toBe(true);
  });

  it('rule 4: a longer phrase that only adds words joins the listed phrase, marked as a guess', () => {
    expect(members('machinelearning')).toEqual(['key:machine learning', 'key:机器学习', 'key:機器學習', 'phrase:advanced machine learning techniques']);
    expect(by.get('machinelearning')).toMatchObject({ mentions: 60 + 35 + 4 + 3, knownId: 'machine_learning' });
  });

  it('proposes the kind enrichment gave most often, and the vocabulary kind for a known skill', () => {
    expect(by.get('communication')!.kind).toBe('soft');
    expect(by.get('communication')).toMatchObject({ kind: 'soft', knownId: 'communication', mentions: 72 });
    expect(by.get('supabase')!.kind).toBe('hard');
  });

  it('leaves a sentence out and orders clusters by mentions', () => {
    expect(result.skipped).toBe(1);
    const mentions = result.clusters.map((c) => c.mentions);
    expect(mentions).toEqual([...mentions].sort((a, b) => b - a));
    expect(result.clusters[0]!.id).toBe(aliasKey('PostgreSQL'));
  });
});

describe('export-strings', () => {
  const queryStrings = vi.fn(async (market: 'intl' | 'cn'): Promise<SkillString[]> => (market === 'intl' ? [{ term: 'PostgreSQL', mentions: 12, kind: 'hard' }, { term: 'data pipelines, batch', mentions: 2, kind: null }] : [{ term: '机器学习', mentions: 5, kind: 'hard' }]));

  it('a dry run counts and writes nothing', async () => {
    const { run, io, repo } = setup();
    const report = await run(['export-strings', '--market', 'all'], { queryStrings });
    expect(report).toMatchObject({ ok: true, apply: false, files: [], rows: 0 });
    expect(report.lines[0]).toContain('DRY RUN: nothing was written');
    expect(report.lines.join('\n')).toContain('Market intl: 2 distinct strings, 14 mentions');
    expect(report.lines.at(-1)).toBe('Run again with --apply to write this.');
    expect(io.writes).toEqual([]);
    expect(repo.writes).toBe(0);
  });

  it('--apply writes the local file and no row', async () => {
    const { run, io, repo } = setup();
    const report = await run(['export-strings', '--market', 'all', '--apply'], { queryStrings });
    expect(report.files).toEqual([DEFAULT_STRINGS_FILE]);
    expect(readStringsFile(io.files.get(DEFAULT_STRINGS_FILE)!)).toEqual([
      { term: 'PostgreSQL', mentions: 12, kind: 'hard' },
      { term: 'data pipelines, batch', mentions: 2, kind: null },
      { term: '机器学习', mentions: 5, kind: 'hard' },
    ]);
    expect(repo.writes).toBe(0);
  });

  it('needs a market, and says so when it has no reader', async () => {
    const { run } = setup();
    await expect(run(['export-strings'], { queryStrings })).rejects.toThrow(/--market must be/);
    expect((await run(['export-strings', '--market', 'cn'])).ok).toBe(false);
  });

  it('the count reads named columns of public, canonical, live postings of one market, and writes nothing', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?').replace(/\s+/g, ' '), values });
        return [{ term: 'PostgreSQL', mentions: 12n, soft: 0, hard: 9 }, { term: 'communication', mentions: 4, soft: 3, hard: 1 }, { term: 'Rust', mentions: 1, soft: 0, hard: 0 }] as T;
      },
    };
    expect(await querySkillStrings(db as never, 'cn')).toEqual([
      { term: 'PostgreSQL', mentions: 12, kind: 'hard' },
      { term: 'communication', mentions: 4, kind: 'soft' },
      { term: 'Rust', mentions: 1, kind: null },
    ]);
    const { sql, values } = calls[0]!;
    expect(values).toEqual(['cn']);
    expect(sql).toContain('SELECT j."id", j."skills", j."skillsDetail" FROM "RAJob" j');
    expect(sql).toContain(`j."market" = ? AND j."visibility" = 'public' AND j."isCanonical" = true AND j."archivedAt" IS NULL`);
    expect(sql).not.toMatch(/SELECT \*|searchTsv|INSERT|UPDATE|DELETE/i);
  });
});

describe('propose', () => {
  const files = { [DEFAULT_STRINGS_FILE]: fixture('strings.synthetic.csv') };
  const namer = (): ClusterNamer & { name: ReturnType<typeof vi.fn> } => ({
    model: 'fake-model',
    name: vi.fn(async (clusters: ReadonlyArray<{ id: string }>) => [
      { id: clusters[0]!.id, labelEn: 'PostgreSQL', labelZh: null, labelZhHant: null, aliases: ['Postgres database'] },
      { id: 'supabase', labelEn: 'Supabase', labelZh: null, labelZhHant: null, aliases: [] },
      { id: 'not-a-cluster-we-sent', labelEn: 'Invented', labelZh: null, labelZhHant: null, aliases: [] },
    ]),
  });

  it('a dry run writes nothing and does not call the model', async () => {
    const { run, io, repo } = setup({ files });
    const n = namer();
    const report = await run(['propose', '--with-model'], { namer: n });
    expect(report).toMatchObject({ ok: true, files: [], rows: 0 });
    expect(report.lines.join('\n')).toContain('would ask fake-model to name the top');
    expect(n.name).not.toHaveBeenCalled();
    expect(io.writes).toEqual([]);
    expect(repo.writes).toBe(0);
  });

  it('--apply writes clusters.csv: id, label, members, mentions, kind', async () => {
    const { run, io, repo } = setup({ files });
    const report = await run(['propose', '--apply']);
    expect(report.files).toEqual([DEFAULT_CLUSTERS_FILE]);
    const table = parseTable(io.files.get(DEFAULT_CLUSTERS_FILE)!);
    expect(table.header.slice(0, 6)).toEqual(['clusterId', 'label', 'members', 'mentions', 'kind', 'knownId']);
    const node = table.rows.find((r) => r.clusterId === 'nodejs')!;
    expect(node).toMatchObject({ label: 'Node.js', mentions: '137', kind: 'hard', knownId: 'nodejs', proposedBy: '' });
    expect(splitList(node.members!).map(parseMember)).toEqual([
      { term: 'Node.js', mentions: 90, via: 'key' },
      { term: 'nodejs', mentions: 30, via: 'key' },
      { term: 'NodeJS', mentions: 5, via: 'key' },
    ]);
    expect(table.rows.find((r) => r.clusterId === 'terraform')!.members).toBe('Terraform×25 | ~Terraformm×1');
    expect(table.rows.find((r) => r.clusterId === 'machinelearning')!.members).toContain('+advanced machine learning techniques×3');
    // Proposing never writes to the table.
    expect(repo.writes).toBe(0);
    // The same input gives the same bytes.
    const again = setup({ files });
    await again.run(['propose', '--apply']);
    expect(again.io.files.get(DEFAULT_CLUSTERS_FILE)).toBe(io.files.get(DEFAULT_CLUSTERS_FILE));
  });

  it('--with-model --apply: the model names the top N, its output is marked proposed and nothing reaches RASkill', async () => {
    const { run, io, repo } = setup({ files });
    const n = namer();
    const report = await run(['propose', '--with-model', '--top', '3', '--apply'], { namer: n });
    expect(n.name).toHaveBeenCalledTimes(1);
    expect((n.name.mock.calls[0]![0] as unknown[]).length).toBe(3);
    const table = parseTable(io.files.get(DEFAULT_CLUSTERS_FILE)!);
    const pg = table.rows.find((r) => r.clusterId === aliasKey('PostgreSQL'))!;
    expect(pg).toMatchObject({ proposedLabelEn: 'PostgreSQL', proposedAliases: 'Postgres database', proposedBy: 'proposed by fake-model, not reviewed' });
    // A cluster outside the top N and an id the model made up are not proposals.
    expect(table.rows.find((r) => r.clusterId === 'supabase')!.proposedBy).toBe('');
    expect(table.rows.some((r) => r.clusterId === 'not-a-cluster-we-sent')).toBe(false);
    expect(report.lines.join('\n')).toContain('only review-import writes to RASkill');
    expect(repo.writes).toBe(0);
  });

  it('says so when the strings file is missing or no model is configured', async () => {
    expect((await setup().run(['propose'])).ok).toBe(false);
    const report = await setup({ files }).run(['propose', '--with-model', '--apply'], { namer: null });
    expect(report.lines.join('\n')).toContain('no model is configured');
    expect(report.ok).toBe(true);
  });

  it('the prompt asks for names only and the reply is read leniently', () => {
    const messages = buildNamingMessages([{ id: 'supabase', label: 'Supabase', members: ['Supabase', 'supabase'] }]);
    expect(messages[0]!.content).toMatch(/Do not invent identifiers/);
    expect(messages[1]!.content).toContain('"id":"supabase"');
    expect(parseNamingReply('```json\n{"clusters":[{"id":"a","labelEn":"A","labelZh":"","labelZhHant":null,"aliases":["x",3,"y"]},{"id":"b","labelEn":null},{"labelEn":"C"}]}\n```')).toEqual([
      { id: 'a', labelEn: 'A', labelZh: null, labelZhHant: null, aliases: ['x', 'y'] },
    ]);
    expect(parseNamingReply('not json')).toEqual([]);
    expect(parseNamingReply('{"clusters":"no"}')).toEqual([]);
  });
});

describe('review-export', () => {
  it('from the clusters file: the top N by mentions, no decision filled in', async () => {
    const first = setup({ files: { [DEFAULT_STRINGS_FILE]: fixture('strings.synthetic.csv') } });
    await first.run(['propose', '--apply']);
    const { run, io, repo } = setup({ files: { [DEFAULT_CLUSTERS_FILE]: first.io.files.get(DEFAULT_CLUSTERS_FILE)! } });

    const dry = await run(['review-export', '--clusters', DEFAULT_CLUSTERS_FILE, '--top', '5']);
    expect(dry.files).toEqual([]);
    expect(io.writes).toEqual([]);

    await run(['review-export', '--clusters', DEFAULT_CLUSTERS_FILE, '--top', '1000', '--apply']);
    const table = parseTable(io.files.get(DEFAULT_REVIEW_FILE)!);
    expect(table.header).toEqual(REVIEW_HEADER);
    expect(table.rows.every((r) => r.decision === '')).toBe(true);
    // A known skill keeps its id, labels and parent.
    expect(table.rows.find((r) => r.id === 'postgresql')).toMatchObject({ labelEn: 'PostgreSQL', parentId: 'sql', kind: 'hard', note: 'known: postgresql' });
    expect(table.rows.find((r) => r.id === 'machine_learning')).toMatchObject({ labelZh: '机器学习', labelZhHant: '機器學習' });
    // A new one takes the id the write path would give it, and its guesses as aliases to review.
    expect(table.rows.find((r) => r.id === 'supabase')).toMatchObject({ labelEn: 'Supabase', note: 'new', mentions: '9' });
    expect(table.rows.find((r) => r.id === 'terraform')!.aliases).toContain('Terraformm');
    // A Chinese string is not given an English label by a table.
    expect(table.rows.find((r) => r.id === '前端开发工程')).toMatchObject({ labelEn: '', labelZh: '前端开发工程', labelZhHant: '' });
    expect(repo.writes).toBe(0);
  });

  it('from RASkill: ordered by real mention count, reviewed rows pre-set to keep, dropped rows left out', async () => {
    const { run, io } = setup({
      rows: [
        unreviewed('Supabase', 40),
        unreviewed('Vitess', 90),
        { ...unreviewed('Fast-paced environment', 500), status: 'dropped' },
        { ...rowOfRecord(skill({ id: 'postgresql', labelEn: 'PostgreSQL', parentId: 'sql', aliasKeys: ['pgsql'] })), mentionCount: 70 },
      ],
    });
    await run(['review-export', '--top', '2', '--apply']);
    const table = parseTable(io.files.get(DEFAULT_REVIEW_FILE)!);
    expect(table.rows.map((r) => [r.id, r.decision, r.mentions, r.note])).toEqual([
      ['vitess', '', '90', 'unreviewed'],
      ['postgresql', 'keep', '70', 'reviewed'],
    ]);
    // Spellings from the seed, and a stored key no spelling gives as key:<key>.
    expect(splitList(table.rows[1]!.aliases!)).toEqual(expect.arrayContaining(['postgres', 'psql', 'key:pgsql']));
  });

  it('from RASkill: a `seed` row is not pre-set to keep (it is no decision), and the row of a skill the seed no longer has is left out', async () => {
    const kubernetes = SEED_SKILLS.find((r) => r.id === 'kubernetes')!;
    const { run, io } = setup({
      rows: [
        { ...missingRowOf(kubernetes), aliases: ['kube'], mentionCount: 50 },
        { ...missingRowOf(skill({ id: 'left_the_seed', labelEn: 'Left the seed' }), new Set(['left_the_seed'])), mentionCount: 99 },
        // The write path made this row before the seed had the skill.
        { ...unreviewed('Docker', 20) },
      ],
    });
    await run(['review-export', '--apply']);
    const table = parseTable(io.files.get(DEFAULT_REVIEW_FILE)!);
    expect(table.rows.map((r) => [r.id, r.decision, r.note])).toEqual([
      ['kubernetes', '', 'seed'],
      ['docker', '', 'unreviewed'],
    ]);
    // The line shows the skill as the seed has it, with what the row added.
    expect(table.rows[0]).toMatchObject({ labelEn: 'Kubernetes', parentId: 'containers' });
    expect(splitList(table.rows[0]!.aliases!)).toEqual(expect.arrayContaining(['k8s', 'key:kube']));
  });
});

describe('review-import', () => {
  const sheet = fixture('review.synthetic.csv');
  const rows = () => [unreviewed('Supabase', 9), unreviewed('Postgressql', 2), unreviewed('Vitess', 3)];

  it('a dry run prints what it would write and writes nothing', async () => {
    const { run, repo, io } = setup({ files: { 'sheet.csv': sheet }, rows: rows() });
    const before = JSON.stringify([...repo.rows.values()]);
    const report = await run(['review-import', 'sheet.csv']);
    expect(report).toMatchObject({ ok: true, apply: false, rows: 0, files: [] });
    expect(report.lines.join('\n')).toContain('Keep: 2 · merge: 1 · drop: 1 · no decision (skipped): 1');
    expect(report.lines.join('\n')).toContain('Would write');
    expect(repo.writes).toBe(0);
    expect(JSON.stringify([...repo.rows.values()])).toBe(before);
    expect(io.writes).toEqual([]);
  });

  it('--apply: keep is upserted reviewed, merge moves the names, drop blocks the string, no decision is skipped', async () => {
    const { run, repo } = setup({ files: { 'sheet.csv': sheet }, rows: rows() });
    const report = await run(['review-import', 'sheet.csv', '--apply']);
    expect(report.ok).toBe(true);
    expect(report.rows).toBeGreaterThan(0);

    expect(repo.rows.get('supabase')).toMatchObject({ status: 'reviewed', parentId: 'postgresql', labelEn: 'Supabase', mentionCount: 9 });
    expect(repo.rows.get('supabase')!.aliases).toEqual(expect.arrayContaining(['supabase', aliasKey('supabase db'), 'supabaseio']));
    expect(repo.rows.get('datapipeline')).toMatchObject({ status: 'reviewed', labelZh: '数据管道', kind: 'hard' });
    expect(repo.rows.get('vitess')!.status).toBe('unreviewed');
    expect(repo.rows.get('fastpacedenvironment')!.status).toBe('dropped');
    expect(repo.rows.get('postgressql')!.status).toBe('dropped');
    // The seed skill the merge goes to got a `seed` row that holds the merged name and nothing else: the merge
    // decided where a name goes, not what PostgreSQL is.
    expect(repo.rows.get('postgresql')).toMatchObject({ status: 'seed', labelEn: 'PostgreSQL', aliases: ['postgressql'] });

    // What the application then loads.
    const merged = mergeOverSeed(SEED_SKILLS, await repo.list());
    const v = buildVocabulary(merged.records, { droppedKeys: merged.droppedKeys });
    expect(v.conflicts).toEqual([]);
    expect(v.idOf('Postgressql')).toBe('postgresql');
    expect(v.idOf('supabase.io')).toBe('supabase');
    expect(v.reviewed('supabase')).toBe(true);
    expect(v.parentOf('supabase')).toBe('postgresql');
    expect(v.idOf('ETL pipelines')).toBe('datapipeline');
    expect(v.label('datapipeline', 'zh')).toBe('数据管道');
    expect(v.idOf('fast-paced environment')).toBeNull();
    expect(v.isDropped('Fast paced')).toBe(true);
    expect(v.reviewed('vitess')).toBe(false);
    expect(v.reviewed('postgresql')).toBe(true);
    expect(v.parentOf('postgresql')).toBe('sql');

    // Importing the same sheet again changes nothing.
    const snapshot = JSON.stringify([...repo.rows.values()]);
    await run(['review-import', 'sheet.csv', '--apply']);
    expect(JSON.stringify([...repo.rows.values()])).toBe(snapshot);
  });

  it('refuses a sheet that would make one alias key point at two ids, and writes nothing', async () => {
    const { run, repo } = setup({ files: { 'bad.csv': fixture('review-collision.synthetic.csv') }, rows: rows() });
    const report = await run(['review-import', 'bad.csv', '--apply']);
    expect(report.ok).toBe(false);
    expect(report.rows).toBe(0);
    expect(report.lines.join('\n')).toMatch(/REFUSED/);
    expect(report.lines.join('\n')).toContain(`The key "${aliasKey('postgres')}" would point at two ids: pg_tool and postgresql`);
    expect(repo.writes).toBe(0);
    expect(repo.rows.has('pg_tool')).toBe(false);
  });

  it('refuses two rows of one sheet that claim the same name', async () => {
    const table = parseTable(formatCsv([REVIEW_HEADER, ['alpha_tool', 'hard', 'Alpha tool', '', '', 'shared name', '', 'keep', '', ''], ['beta_tool', 'hard', 'Beta tool', '', '', 'Shared Name', '', 'keep', '', '']]));
    const plan = await planReviewImport(table, { seed: SEED_SKILLS, rows: [] });
    expect(plan.errors).toEqual([expect.stringContaining('"sharedname" would point at two ids: alpha_tool and beta_tool')]);
  });

  it('refuses a name a seed skill keeps: a row cannot take an alias away from the seed', async () => {
    // The sheet removes "postgres" from PostgreSQL and gives it to a new skill. The seed still says "postgres" is
    // PostgreSQL, so the application would load one key for two ids.
    const table = parseTable(formatCsv([REVIEW_HEADER, ['postgresql', 'hard', 'PostgreSQL', '', '', 'psql', 'sql', 'keep', '', ''], ['postgres_tool', 'hard', 'Postgres tool', '', '', 'postgres', '', 'keep', '', '']]));
    const plan = await planReviewImport(table, { seed: SEED_SKILLS, rows: [] });
    expect(plan.errors).toEqual([expect.stringContaining(`"${aliasKey('postgres')}" would point at two ids`)]);
  });

  it('refuses invalid rows: no label, unknown kind, unknown decision, twice the same id, a missing target or parent, a loop', async () => {
    const plan = async (rowsOf: string[][]) => (await planReviewImport(parseTable(formatCsv([REVIEW_HEADER, ...rowsOf])), { seed: SEED_SKILLS, rows: [] })).errors.join('\n');
    expect(await plan([['x_tool', 'hard', '', '', '', '', '', 'keep', '', '']])).toMatch(/needs a labelEn/);
    expect(await plan([['x_tool', 'tool', 'X tool', '', '', '', '', 'keep', '', '']])).toMatch(/kind "tool"/);
    expect(await plan([['x_tool', 'hard', 'X tool', '', '', '', '', 'maybe', '', '']])).toMatch(/not keep, drop or merge-into/);
    expect(await plan([['x_tool', 'hard', 'X tool', '', '', '', '', 'keep', '', ''], ['x_tool', 'hard', 'X tool', '', '', '', '', 'drop', '', '']])).toMatch(/appears twice/);
    expect(await plan([['', 'hard', 'X tool', '', '', '', '', 'keep', '', '']])).toMatch(/needs an id/);
    expect(await plan([['x_tool', 'hard', 'X tool', '', '', '', '', 'merge-into:nowhere', '', '']])).toMatch(/not a skill after this sheet/);
    expect(await plan([['x_tool', 'hard', 'X tool', '', '', '', '', 'merge-into:x_tool', '', '']])).toMatch(/into itself/);
    expect(await plan([['x_tool', 'hard', 'X tool', '', '', '', 'nowhere', 'keep', '', '']])).toMatch(/parent nowhere is not a skill/);
    expect(await plan([['x_tool', 'hard', 'X tool', '', '', '', 'y_tool', 'keep', '', ''], ['y_tool', 'hard', 'Y tool', '', '', '', 'x_tool', 'keep', '', '']])).toMatch(/makes a loop/);
    expect((await planReviewImport(parseTable('id,kind\nx,hard\n'), { seed: [], rows: [] })).errors[0]).toMatch(/no "labelEn" column/);
    // A valid sheet has no error.
    expect(await plan([['x_tool', 'certification', 'X tool', '', '', 'x', 'sql', 'keep', '', ''], ['y_tool', 'hard', 'Y tool', '', '', '', '', 'merge-into:x_tool', '', '']])).toBe('');
  });

  it('a merge into a row kept by the same sheet writes the names with that row', async () => {
    const table = parseTable(formatCsv([REVIEW_HEADER, ['x_tool', 'hard', 'X tool', '', '', '', '', 'keep', '', ''], ['y_tool', 'hard', 'Y tool', '', '', 'why tool', '', 'merge-into:x_tool', '', '']]));
    const plan = await planReviewImport(table, { seed: SEED_SKILLS, rows: [] });
    expect(plan.errors).toEqual([]);
    expect(plan.addKeys).toEqual([]);
    expect(plan.upserts.find((u) => u.id === 'x_tool')!.aliases).toEqual(expect.arrayContaining(['xtool', 'ytool', 'whytool']));
    expect(plan.upserts.find((u) => u.id === 'y_tool')).toMatchObject({ status: 'dropped' });
  });

  it('keep turns a `seed` row into a reviewed row; a string the seed lists as dropped can be kept again', async () => {
    const kubernetes = SEED_SKILLS.find((r) => r.id === 'kubernetes')!;
    const sheet = formatCsv([
      REVIEW_HEADER,
      ['kubernetes', 'hard', 'Kubernetes', '', '', 'k8s | key:kube', 'containers', 'keep', '', 'seed'],
      ['rockstar', 'soft', 'Rockstar', '', '', '', '', 'keep', '', ''],
    ]);
    const { run, repo } = setup({ files: { 'sheet.csv': sheet }, rows: [{ ...missingRowOf(kubernetes), aliases: ['kube'] }] });
    const report = await run(['review-import', 'sheet.csv', '--apply'], { seedDroppedKeys: ['rockstar'] });
    expect(report.ok).toBe(true);
    expect(repo.rows.get('kubernetes')).toMatchObject({ status: 'reviewed', parentId: 'containers' });
    expect(repo.rows.get('kubernetes')!.aliases).toEqual(expect.arrayContaining(['k8s', 'kube', aliasKey('Kubernetes')]));
    const merged = mergeOverSeed(SEED_SKILLS, await repo.list(), { seedDroppedKeys: ['rockstar'] });
    const v = buildVocabulary(merged.records, { droppedKeys: merged.droppedKeys });
    expect(v.idOf('Rockstar')).toBe('rockstar');
    expect(v.isDropped('rockstar')).toBe(false);
  });

  it('needs the path of an existing file', async () => {
    const { run } = setup();
    await expect(run(['review-import'])).rejects.toThrow(/needs the path/);
    expect((await run(['review-import', 'missing.csv'])).ok).toBe(false);
  });
});

describe('attach-ids', () => {
  const files = { 'esco.csv': fixture('esco.synthetic.csv'), 'onet.tsv': fixture('onet.synthetic.tsv') };
  const argv = ['attach-ids', '--esco', 'esco.csv', '--esco-alt-column', 'altLabels', '--onet', 'onet.tsv', '--onet-id-column', 'code', '--onet-label-column', 'title'];

  it('attaches an identifier only where a file label equals one of our labels or aliases exactly', () => {
    const plan = planAttachIds(SEED_SKILLS, {
      esco: { table: parseTable(files['esco.csv']), idColumn: 'id', labelColumn: 'label', altColumn: 'altLabels' },
      onet: { table: parseTable(files['onet.tsv'], { delimiter: '\t' }), idColumn: 'code', labelColumn: 'title' },
    });
    expect(plan.set).toEqual([
      // "machine learning" is our label; "ML" is our alias (case-insensitive).
      { id: 'machine_learning', source: 'esco', value: 'synthetic:esco/0002', label: 'machine learning' },
      { id: 'postgresql', source: 'esco', value: 'synthetic:esco/0001', label: 'PostgreSQL' },
      { id: 'terraform', source: 'esco', value: 'synthetic:esco/0007', label: 'TERRAFORM' },
      { id: 'docker', source: 'onet', value: 'synthetic:onet/A3', label: 'Docker' },
      { id: 'python', source: 'onet', value: 'synthetic:onet/A1', label: 'Python' },
    ]);
    // Two identifiers of one file match Kubernetes: never guessed.
    expect(plan.ambiguous).toEqual([{ id: 'kubernetes', source: 'esco', values: ['synthetic:esco/0003', 'synthetic:esco/0004'] }]);
    // Close is not equal: "manage relational database systems", "Spreadsheet software", "Supabase" (not ours) attach nothing.
    const ids = plan.set.map((s) => s.id);
    for (const id of ['relational_databases', 'spreadsheets', 'excel', 'supabase']) expect(ids).not.toContain(id);
    // Every value written is a value of the file.
    const inFiles = new Set([...parseTable(files['esco.csv']).rows.map((r) => r.id), ...parseTable(files['onet.tsv'], { delimiter: '\t' }).rows.map((r) => r.code)]);
    for (const s of plan.set) expect(inFiles.has(s.value)).toBe(true);
  });

  it('without the alt column only the label column is compared', () => {
    const plan = planAttachIds([skill({ id: 'pg', labelEn: 'Postgres DB' })], { esco: { table: parseTable(files['esco.csv']), idColumn: 'id', labelColumn: 'label' } });
    expect(plan.set).toEqual([]);
  });

  it('leaves a skill that already has another identifier, and skips one that has this one', () => {
    const records = [skill({ id: 'postgresql', labelEn: 'PostgreSQL', esco: 'other:1' }), skill({ id: 'terraform', labelEn: 'Terraform', esco: 'synthetic:esco/0007' })];
    const plan = planAttachIds(records, { esco: { table: parseTable(files['esco.csv']), idColumn: 'id', labelColumn: 'label' } });
    expect(plan.set).toEqual([]);
    expect(plan.different).toEqual([{ id: 'postgresql', source: 'esco', has: 'other:1', file: 'synthetic:esco/0001' }]);
  });

  it('a dry run writes nothing; --apply sets the columns and creates the row of a seed skill first', async () => {
    const { run, repo } = setup({ files });
    const dry = await run(argv);
    expect(dry).toMatchObject({ ok: true, rows: 0 });
    expect(dry.lines.join('\n')).toContain('Identifiers that would be set: 5');
    expect(repo.writes).toBe(0);
    expect(repo.rows.size).toBe(0);

    const report = await run([...argv, '--apply']);
    expect(report.rows).toBe(5);
    // The row of a seed skill holds the identifier and decides nothing else about the skill.
    expect(repo.rows.get('postgresql')).toMatchObject({ esco: 'synthetic:esco/0001', onet: null, status: 'seed', labelEn: 'PostgreSQL', aliases: [] });
    expect(repo.rows.get('python')).toMatchObject({ onet: 'synthetic:onet/A1', esco: null, status: 'seed' });
    const merged = mergeOverSeed(SEED_SKILLS, await repo.list());
    expect(merged.records.find((r) => r.id === 'postgresql')).toMatchObject({ esco: 'synthetic:esco/0001', status: 'reviewed', parentId: 'sql' });
    expect(repo.rows.has('kubernetes')).toBe(false);
    // No identifier in the table that is not in a supplied file.
    const written = [...repo.rows.values()].flatMap((r) => [r.esco, r.onet]).filter(Boolean);
    expect(written.sort()).toEqual(['synthetic:esco/0001', 'synthetic:esco/0002', 'synthetic:esco/0007', 'synthetic:onet/A1', 'synthetic:onet/A3']);
    // A second run has nothing left to set.
    expect((await run([...argv, '--apply'])).rows).toBe(0);
  });

  it('needs a file, an existing one, with the named columns', async () => {
    const { run } = setup({ files });
    await expect(run(['attach-ids'])).rejects.toThrow(/needs --esco/);
    expect((await run(['attach-ids', '--esco', 'missing.csv'])).ok).toBe(false);
    await expect(run(['attach-ids', '--onet', 'onet.tsv'])).rejects.toThrow(/has no "id" column \(it has: code, title\)/);
  });
});

describe('embed-labels', () => {
  const vector = (seed: number) => Array.from({ length: SKILL_EMBED_DIMENSIONS }, (_, i) => ((i + seed) % 5) / 10);

  function fakes(have: string[] = [], other: Array<{ id: string; model: string }> = []) {
    const written: Array<{ id: string; model: string; length: number }> = [];
    const embedder = { model: 'fake-embed@1024', embed: vi.fn(async (texts: string[]) => texts.map((_, i) => vector(i))) };
    const vectors = {
      embeddedIds: vi.fn(async () => have),
      otherModels: vi.fn(async () => other),
      write: vi.fn(async (id: string, v: number[], model: string) => {
        written.push({ id, model, length: v.length });
        return true;
      }),
    };
    return { embedder, vectors, written };
  }

  const seed = [skill({ id: 'postgresql', labelEn: 'PostgreSQL' }), skill({ id: 'kubernetes', labelEn: 'Kubernetes' }), skill({ id: 'docker', labelEn: 'Docker' })];

  it('says so when the embeddings client is not available, and writes nothing', async () => {
    const { run, repo } = setup();
    const report = await run(['embed-labels', '--apply'], { seed });
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toContain('no label was embedded and no vector was written');
    expect(repo.writes).toBe(0);
  });

  it('a dry run counts and calls nothing', async () => {
    const { run, repo } = setup({ rows: [unreviewed('Supabase', 3)] });
    const f = fakes(['docker']);
    const report = await run(['embed-labels'], { seed, embedder: f.embedder, vectors: f.vectors });
    expect(report.lines.join('\n')).toContain('1 skills have a label vector, 2 reviewed skills lack one');
    expect(report.lines.join('\n')).toContain('Would embed 2 English labels in 1 batch(es)');
    expect(f.embedder.embed).not.toHaveBeenCalled();
    expect(f.vectors.write).not.toHaveBeenCalled();
    expect(repo.writes).toBe(0);
  });

  it('--apply embeds the labels of reviewed skills that lack a vector, in batches, and creates the rows of seed skills first', async () => {
    const { run, repo } = setup({ rows: [unreviewed('Supabase', 3)] });
    const f = fakes(['docker']);
    const report = await run(['embed-labels', '--batch', '1', '--apply'], { seed, embedder: f.embedder, vectors: f.vectors });
    expect(report).toMatchObject({ ok: true, rows: 2 });
    expect(f.embedder.embed.mock.calls.map((c) => c[0])).toEqual([['Kubernetes'], ['PostgreSQL']]);
    expect(f.written).toEqual([
      { id: 'kubernetes', model: 'fake-embed@1024', length: SKILL_EMBED_DIMENSIONS },
      { id: 'postgresql', model: 'fake-embed@1024', length: SKILL_EMBED_DIMENSIONS },
    ]);
    // The row made for a seed skill only carries the vector: status seed, no keys of its own.
    expect(repo.rows.get('kubernetes')).toMatchObject({ status: 'seed', labelEn: 'Kubernetes', aliases: [] });
    expect(repo.rows.has('docker')).toBe(false);
    // An unreviewed skill is embedded only with --all.
    expect(f.written.some((w) => w.id === 'supabase')).toBe(false);
    const all = fakes(['docker', 'kubernetes', 'postgresql']);
    await run(['embed-labels', '--all', '--apply'], { seed, embedder: all.embedder, vectors: all.vectors });
    expect(all.written.map((w) => w.id)).toEqual(['supabase']);
  });

  it('refuses to write over the label vectors of another model, in a dry run and with --apply, and says how many', async () => {
    // The international model wrote two vectors; the command now runs for a second model.
    const other = [{ id: 'kubernetes', model: 'intl-embed@1024' }, { id: 'postgresql', model: 'intl-embed@1024' }, { id: 'not_on_the_list', model: 'intl-embed@1024' }];
    for (const argv of [['embed-labels'], ['embed-labels', '--apply']]) {
      const { run, repo } = setup();
      const f = fakes([], other);
      const report = await run(argv, { seed, embedder: f.embedder, vectors: f.vectors });
      expect(report.ok, argv.join(' ')).toBe(false);
      const text = report.lines.join('\n');
      expect(text).toContain('Model fake-embed@1024: 0 skills have a label vector, 3 reviewed skills lack one.');
      expect(text).toContain('2 of them carry a label vector of another model (intl-embed@1024: 2)');
      expect(text).toContain('REFUSED: no label was embedded and no vector was written. Pass --replace-model');
      expect(text).not.toContain('Run again with --apply');
      expect(f.embedder.embed).not.toHaveBeenCalled();
      expect(f.vectors.write).not.toHaveBeenCalled();
      expect(repo.writes).toBe(0);
    }
  });

  it('--replace-model: the dry run says what would be replaced, --apply replaces', async () => {
    const other = [{ id: 'kubernetes', model: 'intl-embed@1024' }, { id: 'postgresql', model: '' }];
    const { run, repo } = setup();
    const dryFakes = fakes([], other);
    const dry = await run(['embed-labels', '--replace-model'], { seed, embedder: dryFakes.embedder, vectors: dryFakes.vectors });
    expect(dry.ok).toBe(true);
    expect(dry.lines.join('\n')).toContain('2 of them carry a label vector of another model (an unrecorded model: 1, intl-embed@1024: 1); this run would replace them (--replace-model).');
    expect(dry.lines.at(-1)).toBe('Run again with --apply to write this.');
    expect(dryFakes.vectors.write).not.toHaveBeenCalled();
    expect(repo.writes).toBe(0);

    const f = fakes([], other);
    const report = await run(['embed-labels', '--replace-model', '--apply'], { seed, embedder: f.embedder, vectors: f.vectors });
    expect(report).toMatchObject({ ok: true, rows: 3 });
    expect(report.lines.join('\n')).toContain('this run replaces them (--replace-model).');
    expect(f.written.map((w) => w.id)).toEqual(['docker', 'kubernetes', 'postgresql']);
  });

  it('vectors of another model on skills that are not on the list do not stop the run', async () => {
    const { run } = setup();
    const f = fakes(['docker', 'kubernetes'], [{ id: 'an_unreviewed_row', model: 'intl-embed@1024' }]);
    const report = await run(['embed-labels', '--apply'], { seed, embedder: f.embedder, vectors: f.vectors });
    expect(report).toMatchObject({ ok: true, rows: 1 });
    expect(f.written.map((w) => w.id)).toEqual(['postgresql']);
  });

  it('stops without making anything up when the client gives no usable answer', async () => {
    const { run } = setup();
    for (const answer of [null, [], [[0.1, 0.2]]] as const) {
      const f = fakes();
      f.embedder.embed.mockResolvedValueOnce(answer as never);
      const report = await run(['embed-labels', '--apply'], { seed, embedder: f.embedder, vectors: f.vectors });
      expect(report.ok).toBe(false);
      expect(report.lines.join('\n')).toContain('Nothing was made up');
      expect(f.vectors.write).not.toHaveBeenCalled();
    }
  });

  it('reads the embeddings client by its contract, with a safe default when it is absent', async () => {
    expect(await loadLabelEmbedder('roboapply', async () => Promise.reject(new Error('Cannot find module')))).toBeNull();
    expect(await loadLabelEmbedder('roboapply', async () => ({}))).toBeNull();
    const noKey = { resolveEmbeddingConfig: () => ({ modelTag: 'm@1024', apiKey: '' }), embedTexts: vi.fn() };
    expect(await loadLabelEmbedder('roboapply', async () => noKey)).toBeNull();
    const embedTexts = vi.fn(async (_brand: string, texts: string[], _opts: unknown) => ({ vectors: texts.map(() => [1, 2]), model: 'm', tokens: 3 }));
    const ok = { resolveEmbeddingConfig: (brand: string) => ({ modelTag: `${brand}-m@1024`, apiKey: 'k' }), embedTexts };
    const embedder = (await loadLabelEmbedder('goapply', async () => ok))!;
    expect(embedder.model).toBe('goapply-m@1024');
    expect(await embedder.embed(['PostgreSQL'])).toEqual([[1, 2]]);
    // Labels are not user data, and the purpose is "skill".
    expect(embedTexts).toHaveBeenCalledWith('goapply', ['PostgreSQL'], { purpose: 'skill', carriesUserData: false });
    const unavailable = { resolveEmbeddingConfig: () => ({ modelTag: 'm@1024', apiKey: 'k' }), embedTexts: async () => ({ unavailable: 'no_key' }) };
    expect(await (await loadLabelEmbedder('roboapply', async () => unavailable))!.embed(['x'])).toBeNull();
  });
});

describe('export-seed', () => {
  const generated = buildSeed({ reviewed: [] }).skills;

  it('exports only what differs from the generated seed', () => {
    const same = rowOfRecord(generated.find((s) => s.id === 'postgresql')!);
    const changed = { ...rowOfRecord(generated.find((s) => s.id === 'kubernetes')!), labelZh: '库伯内特斯', esco: 'synthetic:esco/0003' };
    const rows = [
      { ...same, mentionCount: 5 },
      { ...changed, mentionCount: 1 },
      { ...rowOfRecord(skill({ id: 'supabase', labelEn: 'Supabase', parentId: 'postgresql', aliases: [], aliasKeys: ['supabaseio'] })), mentionCount: 9 },
      { ...unreviewed('Vitess', 3) },
      { ...unreviewed('Fast-paced environment', 9), status: 'dropped' },
    ].map((r) => ({ mentionCount: 0, ...r }));
    const overlay = reviewedOverlay(rows, generated);
    expect(overlay.map((e) => e.id)).toEqual(['kubernetes', 'supabase']);
    expect(overlay[0]).toMatchObject({ labelZh: '库伯内特斯', esco: 'synthetic:esco/0003', aliases: ['k8s'], status: 'reviewed' });
    expect(overlay[1]).toMatchObject({ parentId: 'postgresql', aliasKeys: ['supabaseio'], aliases: [] });
  });

  it('a `seed` row is never a review decision: only the keys and identifiers it adds are exported, as additions', () => {
    const docker = generated.find((s) => s.id === 'docker')!;
    const python = generated.find((s) => s.id === 'python')!;
    const mysql = generated.find((s) => s.id === 'mysql')!;
    const rows = [
      // A copy with stale fields and nothing added: says nothing.
      { ...missingRowOf(docker), labelEn: 'Docker (old label)', kind: 'soft', parentId: null },
      // A copy that got a learned key and an identifier.
      { ...missingRowOf(python), aliases: ['pythonlang', aliasKey('Python')], onet: 'synthetic:onet/A1' },
      // An unreviewed row that carries a seed id: the same rule.
      { ...rowOfRecord(skill({ id: 'mysql', labelEn: 'Mysql', status: 'unreviewed', aliasKeys: ['mysql', 'mysqldb'] })) },
      // A copy of a skill the seed no longer has.
      { ...missingRowOf(skill({ id: 'left_the_seed', labelEn: 'Left the seed' }), new Set(['left_the_seed'])), aliases: ['somekey'] },
    ].map((r) => ({ mentionCount: 0, ...r }));
    expect(reviewedOverlay(rows, generated)).toEqual([]);
    expect(seedAdditions(rows, generated)).toEqual([
      { id: 'mysql', aliasKeys: ['mysqldb'], esco: null, onet: null },
      { id: 'python', aliasKeys: ['pythonlang'], esco: null, onet: 'synthetic:onet/A1' },
    ]);
    // On top of the generated entry, which stays generated.
    const file = buildSeed({ reviewed: [], additions: seedAdditions(rows, generated), dropped: { ids: [], keys: [] } });
    expect(file.skills.find((s) => s.id === 'python')).toEqual({ ...python, aliasKeys: ['pythonlang'], onet: 'synthetic:onet/A1' });
    expect(file.skills.find((s) => s.id === 'mysql')).toEqual({ ...mysql, aliasKeys: ['mysqldb'] });
    expect(file.skills.find((s) => s.id === 'docker')).toEqual(docker);
    expect(() => buildSeed({ reviewed: [], additions: [{ id: 'left_the_seed', aliasKeys: ['x'], esco: null, onet: null }], dropped: { ids: [], keys: [] } })).toThrow(/no seed skill/);
  });

  it('embed-labels, then a change to the seed, then export-seed: the change is kept', async () => {
    // The seed as it was when the labels were embedded: PostgreSQL had no alias "psql", Spring Boot had no parent.
    const old = SEED_SKILLS.map((r) => (r.id === 'postgresql' ? { ...r, aliases: r.aliases.filter((a) => a !== 'psql') } : r.id === 'spring_boot' ? { ...r, parentId: null } : r));
    expect(SEED_SKILLS.find((r) => r.id === 'postgresql')!.aliases).toContain('psql');
    expect(SEED_SKILLS.find((r) => r.id === 'spring_boot')!.parentId).toBe('spring');
    const { run, repo, io } = setup();
    const embedder = { model: 'fake-embed@1024', embed: async (texts: string[]) => texts.map(() => Array.from({ length: SKILL_EMBED_DIMENSIONS }, () => 0.1)) };
    const vectors = { embeddedIds: async () => [], otherModels: async () => [], write: async () => true };
    const embedded = await run(['embed-labels', '--apply'], { seed: old, embedder, vectors });
    expect(embedded.rows).toBe(SEED_SKILLS.length);
    expect(repo.rows.size).toBe(SEED_SKILLS.length);
    expect([...repo.rows.values()].every((r) => r.status === 'seed' && r.aliases.length === 0)).toBe(true);
    // attach-ids and a learned alias on the same rows.
    await repo.setExternalIds('postgresql', { esco: 'synthetic:esco/0001' });
    await repo.addAliasKeys('spring_boot', ['sboot']);

    // The application, running the CURRENT seed over those rows, sees the change.
    const merged = mergeOverSeed(SEED_SKILLS, await repo.list());
    const live = buildVocabulary(merged.records, { droppedKeys: merged.droppedKeys });
    expect(live.conflicts).toEqual([]);
    expect(live.idOf('psql')).toBe('postgresql');
    expect(live.parentOf('spring_boot')).toBe('spring');
    expect(live.idOfKey('sboot')).toBe('spring_boot');
    for (const r of SEED_SKILLS) expect(live.reviewed(r.id), r.id).toBe(true);

    // And export-seed does not write the old copies back as decisions.
    const report = await run(['export-seed', '--apply']);
    expect(report.ok).toBe(true);
    expect(io.files.get('seed/reviewed.json')).toBe('[]\n');
    expect(parseAdditions(JSON.parse(io.files.get('seed/additions.json')!))).toEqual([
      { id: 'postgresql', aliasKeys: [], esco: 'synthetic:esco/0001', onet: null },
      { id: 'spring_boot', aliasKeys: ['sboot'], esco: null, onet: null },
    ]);
    const fresh = buildVocabulary((JSON.parse(io.files.get('seed/skills.seed.json')!) as { skills: SkillRecord[] }).skills);
    expect(fresh.idOf('psql')).toBe('postgresql');
    expect(fresh.parentOf('spring_boot')).toBe('spring');
    expect(fresh.idOfKey('sboot')).toBe('spring_boot');
    expect(fresh.record('postgresql')).toMatchObject({ esco: 'synthetic:esco/0001', aliases: SEED_SKILLS.find((r) => r.id === 'postgresql')!.aliases });
  });

  it('drop decisions travel: a dropped string and a dropped seed skill stay dropped in an environment with an empty table', async () => {
    const sheet = formatCsv([
      REVIEW_HEADER,
      ['fastpacedenvironment', 'soft', 'Fast-paced environment', '', '', 'fast paced', '', 'drop', '31', 'new'],
      // A seed skill a reviewer drops, and one merged into another seed skill.
      ['jax', 'hard', 'JAX', '', '', '', 'machine_learning_frameworks', 'drop', '', ''],
      ['opensearch', 'hard', 'OpenSearch', '', '', '', '', 'merge-into:elasticsearch', '', ''],
      // A skill whose parent is dropped by the same sheet's first seed row.
      ['spring', 'hard', 'Spring', '', '', 'spring framework', '', 'drop', '', ''],
    ]);
    const { run, repo, io } = setup({ files: { 'sheet.csv': sheet }, rows: [unreviewed('Fast-paced environment', 31)] });
    expect((await run(['review-import', 'sheet.csv', '--apply'])).ok).toBe(true);

    const dry = await run(['export-seed']);
    expect(dry).toMatchObject({ ok: true, files: [] });
    expect(io.writes).toEqual([]);
    expect(dry.lines.join('\n')).toContain('3 seed skills and 5 strings are dropped');
    expect(dry.lines.join('\n')).toContain('spring_boot');

    const report = await run(['export-seed', '--apply']);
    expect(report.files).toEqual(SEED_FILES);
    const dropped = parseDropped(JSON.parse(io.files.get('seed/dropped.json')!));
    expect(dropped.ids).toEqual(['jax', 'opensearch', 'spring']);
    // Keys no live skill holds: the dropped string and the names of the two dropped seed skills. The names of
    // OpenSearch live on in Elasticsearch, so they are not dropped.
    const keys = [aliasKey('fast paced'), 'fastpacedenvironment', 'jax', 'spring', aliasKey('spring framework')].sort();
    expect(dropped.keys).toEqual(keys);
    expect(parseAdditions(JSON.parse(io.files.get('seed/additions.json')!))).toEqual([{ id: 'elasticsearch', aliasKeys: ['opensearch'], esco: null, onet: null }]);

    // A fresh environment: the exported seed, an empty table.
    const seedFile = JSON.parse(io.files.get('seed/skills.seed.json')!) as { skills: SkillRecord[]; dropped: string[] };
    expect(seedFile.dropped).toEqual(keys);
    // The generator alone (dropped.json edited by hand, ids only) blocks the names of a dropped seed skill too.
    expect(buildSeed({ reviewed: [], additions: [], dropped: { ids: ['jax'], keys: [] } }).dropped).toEqual(['jax']);
    const freshMerge = mergeOverSeed(seedFile.skills, [], { seedDroppedKeys: seedFile.dropped });
    const fresh = buildVocabulary(freshMerge.records, { droppedKeys: freshMerge.droppedKeys });
    const liveMerge = mergeOverSeed(SEED_SKILLS, await repo.list());
    const live = buildVocabulary(liveMerge.records, { droppedKeys: liveMerge.droppedKeys });
    expect(fresh.conflicts).toEqual([]);
    expect(fresh.size).toBe(SEED_SKILLS.length - 3);
    for (const v of [fresh, live]) {
      expect(v.isDropped('Fast-paced environment')).toBe(true);
      expect(v.isDropped('fast paced')).toBe(true);
      expect(v.idOf('fast-paced environment')).toBeNull();
      expect(v.record('jax')).toBeNull();
      expect(v.idOf('JAX')).toBeNull();
      expect(v.isDropped('JAX')).toBe(true);
      expect(v.record('spring')).toBeNull();
      expect(v.isDropped('Spring Framework')).toBe(true);
      // The skill under a dropped one stays, without a parent.
      expect(v.reviewed('spring_boot')).toBe(true);
      expect(v.parentOf('spring_boot')).toBeNull();
      // The merged skill is gone and its name leads to the target.
      expect(v.record('opensearch')).toBeNull();
      expect(v.idOf('OpenSearch')).toBe('elasticsearch');
      expect(v.isDropped('OpenSearch')).toBe(false);
    }
    // In the fresh environment the write path neither creates nor embeds the dropped string again.
    const create = vi.fn(async () => {});
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1]));
    const { canonicalize } = await import('./canonicalize.js');
    expect(await canonicalize('Fast-paced environment', { vocabulary: fresh, create, embed, nearest: async () => [] })).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    expect(create).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    // Another deployment whose table still has the unreviewed row of that string: not a skill there either.
    const elsewhere = mergeOverSeed(seedFile.skills, [{ ...unreviewed('Fast-paced environment', 4), mentionCount: 4 }], { seedDroppedKeys: seedFile.dropped });
    expect(elsewhere.records.some((r) => r.id === 'fastpacedenvironment')).toBe(false);

    // Exporting again gives the same bytes.
    const first = SEED_FILES.map((f) => io.files.get(f));
    await run(['export-seed', '--apply']);
    expect(SEED_FILES.map((f) => io.files.get(f))).toEqual(first);
  });

  it('the export adds to the committed files: a decision made in another database is kept unless this table says otherwise', async () => {
    // What a review of the international database committed last month.
    const committedFiles = {
      'seed/reviewed.json': JSON.stringify([
        { id: 'supabase', kind: 'hard', labelEn: 'Supabase', labelZh: null, labelZhHant: null, aliases: [], aliasKeys: ['supabaseio'], parentId: 'postgresql', esco: null, onet: null, status: 'reviewed' },
        { id: 'vitess', kind: 'hard', labelEn: 'Vitess', labelZh: null, labelZhHant: null, aliases: [], parentId: 'mysql', esco: null, onet: null, status: 'reviewed' },
        { id: 'neon', kind: 'hard', labelEn: 'Neon', labelZh: null, labelZhHant: null, aliases: [], parentId: 'postgresql', esco: null, onet: null, status: 'reviewed' },
      ]),
      'seed/additions.json': JSON.stringify([{ id: 'docker', aliasKeys: ['dockr'], esco: null, onet: null }, { id: 'postgresql', aliasKeys: ['postgressql'], esco: 'synthetic:esco/0001', onet: null }]),
      'seed/dropped.json': JSON.stringify({ ids: ['jax', 'spring'], keys: ['fastpacedenvironment', 'jax', 'spring', 'springframework'] }),
    };
    // An empty table (a fresh deployment) loses nothing.
    const empty = setup({ files: committedFiles });
    expect((await empty.run(['export-seed', '--apply'])).ok).toBe(true);
    expect(parseReviewed(JSON.parse(empty.io.files.get('seed/reviewed.json')!)).map((e) => e.id)).toEqual(['neon', 'supabase', 'vitess']);
    expect(parseAdditions(JSON.parse(empty.io.files.get('seed/additions.json')!))).toEqual(parseAdditions(JSON.parse(committedFiles['seed/additions.json'])));
    expect(parseDropped(JSON.parse(empty.io.files.get('seed/dropped.json')!))).toEqual(parseDropped(JSON.parse(committedFiles['seed/dropped.json'])));
    const emptySeed = JSON.parse(empty.io.files.get('seed/skills.seed.json')!) as { skills: SkillRecord[]; dropped: string[] };
    expect(emptySeed.skills).toHaveLength(SEED_SKILLS.length + 3 - 2);
    expect(emptySeed.dropped).toEqual(['fastpacedenvironment', 'jax', 'spring', 'springframework']);

    // The mainland table, reviewed later: it changes one committed skill, drops another, revives a dropped seed
    // skill, reviews PostgreSQL itself and learns a key for Docker. Neon it does not mention.
    const generatedSpring = generated.find((s) => s.id === 'spring')!;
    const generatedPg = generated.find((s) => s.id === 'postgresql')!;
    const { run, io } = setup({
      files: committedFiles,
      rows: [
        { ...rowOfRecord(skill({ id: 'supabase', labelEn: 'Supabase', labelZh: '苏帕贝斯', parentId: 'postgresql' })) },
        { ...rowOfRecord(skill({ id: 'vitess', labelEn: 'Vitess' })), status: 'dropped' },
        { ...rowOfRecord(generatedSpring) },
        { ...rowOfRecord({ ...generatedPg, labelZh: '波斯特格雷' }) },
        { ...missingRowOf(generated.find((s) => s.id === 'docker')!), aliases: ['dokcer'], onet: 'synthetic:onet/A3' },
      ],
    });
    const report = await run(['export-seed', '--apply']);
    expect(report.ok).toBe(true);
    const reviewed = parseReviewed(JSON.parse(io.files.get('seed/reviewed.json')!));
    expect(reviewed.map((e) => e.id)).toEqual(['neon', 'postgresql', 'supabase']);
    expect(reviewed.find((e) => e.id === 'supabase')).toMatchObject({ labelZh: '苏帕贝斯' });
    expect(reviewed.find((e) => e.id === 'postgresql')).toMatchObject({ labelZh: '波斯特格雷', parentId: 'sql' });
    // Docker's addition is joined. PostgreSQL's stays on top of its reviewed entry: the key was learned elsewhere.
    expect(parseAdditions(JSON.parse(io.files.get('seed/additions.json')!))).toEqual([
      { id: 'docker', aliasKeys: ['dockr', 'dokcer'], esco: null, onet: 'synthetic:onet/A3' },
      { id: 'postgresql', aliasKeys: ['postgressql'], esco: 'synthetic:esco/0001', onet: null },
    ]);
    // Spring is a skill again (a reviewed row, the generated entry); JAX stays dropped; Vitess is dropped now.
    const dropped = parseDropped(JSON.parse(io.files.get('seed/dropped.json')!));
    expect(dropped.ids).toEqual(['jax']);
    expect(dropped.keys).toEqual(['fastpacedenvironment', 'jax', 'vitess']);
    const seedFile = JSON.parse(io.files.get('seed/skills.seed.json')!) as { skills: SkillRecord[]; dropped: string[] };
    const fresh = buildVocabulary(seedFile.skills, { droppedKeys: seedFile.dropped });
    expect(fresh.conflicts).toEqual([]);
    expect(fresh.reviewed('spring')).toBe(true);
    expect(fresh.parentOf('spring_boot')).toBe('spring');
    expect(fresh.reviewed('neon')).toBe(true);
    expect(fresh.record('vitess')).toBeNull();
    expect(fresh.isDropped('Vitess')).toBe(true);
    expect(fresh.record('jax')).toBeNull();
    expect(fresh.idOfKey('dockr')).toBe('docker');
    expect(fresh.idOfKey('dokcer')).toBe('docker');
    expect(fresh.idOfKey('postgressql')).toBe('postgresql');
    expect(fresh.record('postgresql')).toMatchObject({ labelZh: '波斯特格雷', esco: 'synthetic:esco/0001' });
    // The same export again changes no byte.
    const first = SEED_FILES.map((f) => io.files.get(f));
    await run(['export-seed', '--apply']);
    expect(SEED_FILES.map((f) => io.files.get(f))).toEqual(first);

    // A committed file that is not in the written form refuses the export.
    const broken = setup({ files: { ...committedFiles, 'seed/dropped.json': '[]' } });
    const refused = await broken.run(['export-seed', '--apply']);
    expect(refused.ok).toBe(false);
    expect(refused.lines.join('\n')).toMatch(/REFUSED/);
    expect(broken.io.writes).toEqual([]);
  });

  it('mergeSeedDecisions with nothing committed is what the table says', () => {
    const rows = [{ ...rowOfRecord(skill({ id: 'supabase', labelEn: 'Supabase', parentId: 'postgresql' })), mentionCount: 0 }];
    const merged = mergeSeedDecisions({ reviewed: [], additions: [], dropped: { ids: [], keys: [] } }, rows, generated);
    expect(merged.reviewed.map((e) => e.id)).toEqual(['supabase']);
    expect(merged.additions).toEqual([]);
    expect(merged.dropped).toEqual({ ids: [], keys: [] });
  });

  it('droppedDecisions lists the seed skills among the dropped rows and every key those rows hold', () => {
    const rows = [
      { ...unreviewed('Fast-paced environment', 9), status: 'dropped' },
      { ...rowOfRecord(generated.find((s) => s.id === 'jax')!), status: 'dropped' },
      { ...unreviewed('Vitess', 3) },
    ].map((r) => ({ mentionCount: 0, ...r }));
    expect(droppedDecisions(rows, generated)).toEqual({ ids: ['jax'], keys: ['fastpacedenvironment', 'jax'] });
  });

  it('round trip: a reviewed sheet, imported, exported, is what a fresh environment starts with', async () => {
    const { run, repo, io } = setup({ files: { 'sheet.csv': fixture('review.synthetic.csv') }, rows: [unreviewed('Supabase', 9), unreviewed('Postgressql', 2)] });
    await run(['review-import', 'sheet.csv', '--apply']);

    const dry = await run(['export-seed']);
    expect(dry).toMatchObject({ ok: true, files: [] });
    expect(io.writes).toEqual([]);

    const report = await run(['export-seed', '--apply']);
    expect(report.files).toEqual(SEED_FILES);
    const reviewed = parseReviewed(JSON.parse(io.files.get('seed/reviewed.json')!));
    // PostgreSQL only received a merged name: it is an addition to the seed skill, not a reviewed copy of it.
    expect(reviewed.map((r) => r.id)).toEqual(['datapipeline', 'supabase']);
    expect(parseAdditions(JSON.parse(io.files.get('seed/additions.json')!))).toEqual([{ id: 'postgresql', aliasKeys: ['postgressql'], esco: null, onet: null }]);
    expect(parseDropped(JSON.parse(io.files.get('seed/dropped.json')!))).toEqual({ ids: [], keys: [aliasKey('fast paced'), 'fastpacedenvironment'] });
    // The seed file is exactly what the generator makes of the three files.
    const seedFile = JSON.parse(io.files.get('seed/skills.seed.json')!) as { skills: SkillRecord[]; dropped: string[] };
    expect(seedFile.skills).toHaveLength(SEED_SKILLS.length + 2);
    expect(seedFile.skills.find((s) => s.id === 'postgresql')).toEqual({ ...JSON.parse(JSON.stringify(SEED_SKILLS.find((s) => s.id === 'postgresql'))), aliasKeys: ['postgressql'] });
    expect(seedFile.dropped).toEqual([aliasKey('fast paced'), 'fastpacedenvironment']);

    // A fresh environment (no table) answers like the one that holds the reviewed rows.
    const fresh = buildVocabulary(seedFile.skills, { droppedKeys: seedFile.dropped });
    const merged = mergeOverSeed(SEED_SKILLS, await repo.list());
    const live = buildVocabulary(merged.records, { droppedKeys: merged.droppedKeys });
    expect(fresh.conflicts).toEqual([]);
    for (const term of ['Supabase', 'supabase.io', 'supabase db', 'Postgressql', 'postgres', 'ETL pipelines', '数据管道', 'Data pipelines', 'Kubernetes', '機器學習']) {
      expect(fresh.idOf(term), term).toBe(live.idOf(term));
      expect(fresh.idOf(term), term).not.toBeNull();
    }
    for (const id of ['supabase', 'datapipeline', 'postgresql']) {
      expect(fresh.reviewed(id)).toBe(true);
      expect(fresh.parentOf(id)).toBe(live.parentOf(id));
      expect(fresh.label(id, 'zh')).toBe(live.label(id, 'zh'));
    }
    // A dropped string stays dropped with an empty table.
    for (const v of [fresh, live]) {
      expect(v.isDropped('Fast-paced environment')).toBe(true);
      expect(v.idOf('fast-paced environment')).toBeNull();
      // The merged misspelling is a name of PostgreSQL, not a dropped string.
      expect(v.isDropped('Postgressql')).toBe(false);
    }
    // Exporting again gives the same bytes.
    const first = SEED_FILES.map((f) => io.files.get(f));
    await run(['export-seed', '--apply']);
    expect(SEED_FILES.map((f) => io.files.get(f))).toEqual(first);
  });

  it('with an empty table the export is the committed seed and an empty overlay', async () => {
    const { run, io } = setup();
    await run(['export-seed', '--apply']);
    expect(io.files.get('seed/reviewed.json')).toBe('[]\n');
    expect(io.files.get('seed/additions.json')).toBe('[]\n');
    expect(JSON.parse(io.files.get('seed/dropped.json')!)).toEqual({ ids: [], keys: [] });
    expect(JSON.parse(io.files.get('seed/skills.seed.json')!).skills).toEqual(JSON.parse(JSON.stringify(SEED_SKILLS)));
    expect(JSON.parse(io.files.get('seed/skills.seed.json')!).dropped).toEqual([]);
  });

  it('refuses reviewed rows that do not make a valid seed', async () => {
    const { run, io } = setup({ rows: [{ ...rowOfRecord(skill({ id: 'orphan_tool', labelEn: 'Orphan tool', parentId: 'an_unreviewed_parent' })), mentionCount: 0 }] });
    const report = await run(['export-seed', '--apply']);
    expect(report.ok).toBe(false);
    expect(report.lines.join('\n')).toMatch(/REFUSED/);
    expect(io.writes).toEqual([]);
  });
});

describe('every command', () => {
  it('prints a dry-run header and writes nothing without --apply', async () => {
    const files = {
      [DEFAULT_STRINGS_FILE]: fixture('strings.synthetic.csv'),
      'sheet.csv': fixture('review.synthetic.csv'),
      'esco.csv': fixture('esco.synthetic.csv'),
    };
    const { run, repo, io } = setup({ files, rows: [unreviewed('Supabase', 9)] });
    const before = JSON.stringify([...repo.rows.values()]);
    const embed = vi.fn(async () => null);
    const name = vi.fn(async () => []);
    const more: Partial<SkillsCliDeps> = {
      queryStrings: async () => [{ term: 'Go', mentions: 1 }],
      namer: { model: 'fake-model', name },
      embedder: { model: 'fake-embed@1024', embed },
      vectors: { embeddedIds: async () => [], otherModels: async () => [], write: vi.fn(async () => true) },
    };
    const commands: string[][] = [
      ['export-strings', '--market', 'intl'],
      ['propose', '--with-model'],
      ['review-export'],
      ['review-import', 'sheet.csv'],
      ['attach-ids', '--esco', 'esco.csv'],
      ['embed-labels'],
      ['export-seed'],
    ];
    expect(commands.map((c) => c[0])).toEqual([...SKILLS_COMMANDS]);
    for (const argv of commands) {
      const report = await run(argv, more);
      expect(report.ok, argv[0]).toBe(true);
      expect(report.lines[0], argv[0]).toContain('DRY RUN: nothing was written');
      expect(report.lines.at(-1), argv[0]).toBe('Run again with --apply to write this.');
      expect(report.files, argv[0]).toEqual([]);
      expect(report.rows, argv[0]).toBe(0);
    }
    expect(repo.writes).toBe(0);
    expect(JSON.stringify([...repo.rows.values()])).toBe(before);
    expect(io.writes).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(name).not.toHaveBeenCalled();
    expect((more.vectors!.write as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
