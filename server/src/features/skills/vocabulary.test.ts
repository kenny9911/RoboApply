// @vitest-environment node
// MKT-2G item 1: the vocabulary snapshot and its loader.
import { afterEach, describe, expect, it, vi } from 'vitest';

const prismaImports = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../lib/prisma.js', () => {
  prismaImports.count++;
  return { default: {} };
});

import * as skills from './index.js';
import { createMemorySkillRepo, type SkillRow } from './repo.js';
import { SEED_SKILLS } from './seed/index.js';
import type { SkillRecord } from './types.js';
import { buildVocabulary, createVocabularyLoader, mergeOverSeed, rememberAlias, rememberSkill, VOCABULARY_RETRY_MS, VOCABULARY_TTL_MS } from './vocabulary.js';

function skill(over: Partial<SkillRecord> & { id: string; labelEn: string }): SkillRecord {
  return { kind: 'hard', labelZh: null, labelZhHant: null, aliases: [], parentId: null, esco: null, onet: null, status: 'reviewed', ...over };
}

function row(over: Partial<SkillRow> & { id: string; labelEn: string }): SkillRow {
  return { kind: 'hard', labelZh: null, labelZhHant: null, aliases: [], parentId: null, esco: null, onet: null, status: 'reviewed', mentionCount: 0, ...over };
}

const FIXTURE: SkillRecord[] = [
  skill({ id: 'nodejs', labelEn: 'Node.js', aliases: ['node'] }),
  skill({ id: 'machine_learning', labelEn: 'Machine learning', labelZh: '机器学习', labelZhHant: '機器學習', aliases: ['ml'] }),
  skill({ id: 'relational_databases', labelEn: 'Relational databases', labelZh: '关系型数据库' }),
  skill({ id: 'sql', labelEn: 'SQL', parentId: 'relational_databases' }),
  skill({ id: 'postgresql', labelEn: 'PostgreSQL', aliases: ['postgres'], parentId: 'sql' }),
  skill({ id: 'mysql', labelEn: 'MySQL', parentId: 'sql' }),
  skill({ id: 'communication', kind: 'soft', labelEn: 'Communication', labelZh: '沟通能力', labelZhHant: '溝通能力' }),
  skill({ id: 'cpa', kind: 'certification', labelEn: 'CPA', labelZh: '注册会计师' }),
  skill({ id: 'foobar', labelEn: 'FooBar', status: 'unreviewed' }),
];

afterEach(() => {
  skills.resetVocabularyForTests();
});

describe('buildVocabulary: lookup', () => {
  const v = buildVocabulary(FIXTURE);

  it('gives one id to every spelling of a name', () => {
    expect(v.idOf('Node.js')).toBe('nodejs');
    expect(v.idOf('nodejs')).toBe('nodejs');
    expect(v.idOf('NodeJS')).toBe('nodejs');
    expect(v.idOf('  node.JS ')).toBe('nodejs');
    expect(v.idOf('node')).toBe('nodejs');
    expect(v.idOf('Postgres')).toBe('postgresql');
  });

  it('gives one id to a skill in three scripts', () => {
    expect(v.idOf('machine learning')).toBe('machine_learning');
    expect(v.idOf('机器学习')).toBe('machine_learning');
    expect(v.idOf('機器學習')).toBe('machine_learning');
    expect(v.idOf('ML')).toBe('machine_learning');
    expect(v.idOf('溝通能力')).toBe('communication');
    expect(v.idOf('沟通能力')).toBe('communication');
  });

  it('knows nothing it was not given', () => {
    expect(v.idOf('Kubernetes')).toBeNull();
    expect(v.idOf('')).toBeNull();
    expect(v.idOf('   ')).toBeNull();
    expect(v.kindOf('kubernetes')).toBeNull();
    expect(v.reviewed('kubernetes')).toBe(false);
    expect(v.parentOf('kubernetes')).toBeNull();
    expect(v.childrenOf('kubernetes')).toEqual([]);
    expect(v.record('kubernetes')).toBeNull();
  });

  it('answers kind, review status, parent, children and size', () => {
    expect(v.size).toBe(FIXTURE.length);
    expect(v.kindOf('postgresql')).toBe('hard');
    expect(v.kindOf('communication')).toBe('soft');
    expect(v.kindOf('cpa')).toBe('certification');
    expect(v.reviewed('postgresql')).toBe(true);
    expect(v.reviewed('foobar')).toBe(false);
    expect(v.parentOf('postgresql')).toBe('sql');
    expect(v.parentOf('sql')).toBe('relational_databases');
    expect(v.parentOf('relational_databases')).toBeNull();
    expect(v.childrenOf('sql')).toEqual(['mysql', 'postgresql']);
    expect(v.childrenOf('relational_databases')).toEqual(['sql']);
    expect(v.ids()).toEqual([...FIXTURE.map((r) => r.id)].sort());
  });

  it('an id is an alias of itself', () => {
    expect(v.idOf('relational_databases')).toBe('relational_databases');
    expect(v.idOf('machine_learning')).toBe('machine_learning');
  });

  it('is built from the records alone: no clock, no input order', () => {
    const reversed = buildVocabulary([...FIXTURE].reverse());
    for (const term of ['Node.js', '機器學習', 'postgres', 'CPA', 'nothing']) expect(reversed.idOf(term)).toBe(v.idOf(term));
    expect(reversed.ids()).toEqual(v.ids());
    expect(v.asOf).toBeNull();
    expect(v.source).toBe('seed');
    expect(v.conflicts).toEqual([]);
  });
});

describe('buildVocabulary: labels', () => {
  const v = buildVocabulary(FIXTURE);

  it('en reads the English label', () => {
    expect(v.label('machine_learning', 'en')).toBe('Machine learning');
    expect(v.label('machine_learning', 'en-US')).toBe('Machine learning');
  });

  it('zh reads the Simplified label, else the English one', () => {
    expect(v.label('machine_learning', 'zh')).toBe('机器学习');
    expect(v.label('machine_learning', 'zh-CN')).toBe('机器学习');
    expect(v.label('postgresql', 'zh')).toBe('PostgreSQL');
  });

  it('zh-TW reads the Traditional label, else the English one, never the Simplified one', () => {
    expect(v.label('machine_learning', 'zh-TW')).toBe('機器學習');
    expect(v.label('machine_learning', 'zh-Hant')).toBe('機器學習');
    expect(v.label('machine_learning', 'zh_TW')).toBe('機器學習');
    expect(v.label('machine_learning', 'zh-HK')).toBe('機器學習');
    // A skill with a Simplified label and no Traditional one: English, not 关系型数据库 or 注册会计师.
    expect(v.label('relational_databases', 'zh-TW')).toBe('Relational databases');
    expect(v.label('cpa', 'zh-TW')).toBe('CPA');
  });

  it('a label that is Chinese text standing in the English column is never shown to Taiwan: empty means "show the posting\'s own string"', () => {
    // What the write path makes of a Chinese posting string (canonicalize.ts): the string is the English label too.
    const w = buildVocabulary([
      skill({ id: '供应链管理', labelEn: '供应链管理', labelZh: '供应链管理', status: 'unreviewed' }),
      skill({ id: '数据仓库', labelEn: '數據倉庫', labelZhHant: '數據倉庫', status: 'unreviewed' }),
    ]);
    expect(w.label('供应链管理', 'zh')).toBe('供应链管理');
    expect(w.label('供应链管理', 'en')).toBe('供应链管理');
    expect(w.label('供应链管理', 'zh-TW')).toBe('');
    expect(w.label('供应链管理', 'zh-Hant')).toBe('');
    expect(w.label('数据仓库', 'zh-TW')).toBe('數據倉庫');
  });

  it('every other locale reads the English label; an unknown id comes back as it is', () => {
    for (const locale of ['ja', 'ko', 'de', 'es', 'fr', 'pt', '']) expect(v.label('machine_learning', locale)).toBe('Machine learning');
    expect(v.label('no_such_skill', 'en')).toBe('no_such_skill');
  });

  it('the committed seed never shows a Simplified-only label to Taiwan', () => {
    const seed = buildVocabulary(SEED_SKILLS);
    for (const r of SEED_SKILLS) {
      const shown = seed.label(r.id, 'zh-TW');
      expect([r.labelZhHant, r.labelEn], r.id).toContain(shown);
      if (!r.labelZhHant) expect(shown, r.id).toBe(r.labelEn);
    }
  });
});

describe('buildVocabulary: bad data does not break a lookup', () => {
  it('one key claimed by two skills goes to one of them, the same one every time, and is reported', () => {
    const records = [skill({ id: 'b_skill', labelEn: 'Beta', aliases: ['shared name'] }), skill({ id: 'a_skill', labelEn: 'Alpha', aliases: ['Shared Name'] })];
    const v = buildVocabulary(records);
    expect(v.idOf('shared name')).toBe('a_skill');
    expect(buildVocabulary([...records].reverse()).idOf('shared name')).toBe('a_skill');
    expect(v.conflicts).toEqual([{ key: 'sharedname', keptId: 'a_skill', lostId: 'b_skill' }]);
  });

  it('a reviewed skill keeps a name an unreviewed one also claims; a label beats an alias', () => {
    const v = buildVocabulary([skill({ id: 'a_new', labelEn: 'Kube', status: 'unreviewed', aliases: ['k8s'] }), skill({ id: 'kubernetes', labelEn: 'Kubernetes', aliases: ['k8s'] })]);
    expect(v.idOf('k8s')).toBe('kubernetes');
    const w = buildVocabulary([skill({ id: 'a_first', labelEn: 'First', aliases: ['Second'] }), skill({ id: 'b_second', labelEn: 'Second' })]);
    expect(w.idOf('second')).toBe('b_second');
  });

  it('a parent that does not exist, a skill that is its own parent and a loop are ignored', () => {
    const v = buildVocabulary([
      skill({ id: 'orphan', labelEn: 'Orphan', parentId: 'missing' }),
      skill({ id: 'selfish', labelEn: 'Selfish', parentId: 'selfish' }),
      skill({ id: 'loop_a', labelEn: 'Loop A', parentId: 'loop_b' }),
      skill({ id: 'loop_b', labelEn: 'Loop B', parentId: 'loop_a' }),
    ]);
    for (const id of ['orphan', 'selfish', 'loop_a', 'loop_b']) expect(v.parentOf(id), id).toBeNull();
    expect(v.childrenOf('loop_a')).toEqual([]);
  });

  it('stored keys are taken as they are, never keyed again', () => {
    const v = buildVocabulary([skill({ id: 'amazon_aws', labelEn: 'Amazon AWS suite', aliasKeys: ['amazonaws'] })]);
    expect(v.idOf('Amazon AWS')).toBe('amazon_aws');
    expect(v.idOfKey('amazonaws')).toBe('amazon_aws');
    expect(v.keysOf('amazon_aws')).toContain('amazonaws');
  });

  it('a dropped string is not a skill', () => {
    const v = buildVocabulary(FIXTURE, { droppedKeys: ['fastpacedenvironment', 'nodejs'] });
    expect(v.isDropped('Fast-paced environment')).toBe(true);
    expect(v.idOf('fast-paced environment')).toBeNull();
    // A key a real skill has is not dropped.
    expect(v.isDropped('Node.js')).toBe(false);
    expect(v.idOf('Node.js')).toBe('nodejs');
  });
});

describe('buildVocabulary: the words of a name, for reading a sentence', () => {
  const v = buildVocabulary([
    skill({ id: 'rest', labelEn: 'REST', aliases: ['rest api', 'rest apis', 'restful'] }),
    skill({ id: 'nodejs', labelEn: 'Node.js', aliases: ['node'] }),
    skill({ id: 'indesign', labelEn: 'InDesign', aliases: ['adobe indesign'] }),
    skill({ id: 'api_design', labelEn: 'API design', labelZh: 'API 设计' }),
    skill({ id: 'machine_learning', labelEn: 'Machine learning', labelZh: '机器学习', labelZhHant: '機器學習', aliasKeys: ['mlearning', '机器学习技术'] }),
    skill({ id: 'teacher', kind: 'certification', labelEn: 'Teacher qualification certificate (China)', aliases: ['teacher qualification certificate'] }),
  ]);

  it('a name is indexed by its own words, never by the collapsed key', () => {
    expect(v.idOfPhrase('rest api')).toBe('rest');
    expect(v.idOfPhrase('adobe indesign')).toBe('indesign');
    expect(v.idOfPhrase('indesign')).toBe('indesign');
    expect(v.idOfPhrase('in design')).toBeNull();
    expect(v.idOfPhrase('machine learning')).toBe('machine_learning');
    expect(v.idOfPhrase('machinelearning')).toBeNull();
    // The key lookup still joins: that is for comparing two names, not for reading a sentence.
    expect(v.idOf('in design')).toBe('indesign');
    expect(v.idOf('machinelearning')).toBe('machine_learning');
  });

  it('a name with an inner dot is also the two words; an id is its words; plural and singular are one phrase', () => {
    expect(v.idOfPhrase('nodejs')).toBe('nodejs');
    expect(v.idOfPhrase('node js')).toBe('nodejs');
    expect(v.idOfPhrase('api design')).toBe('api_design');
    expect(v.idOfPhrase('rest api')).toBe(v.idOf('REST APIs'));
  });

  it('Chinese names: the characters as written; a stored key gives a phrase only when it has Chinese in it', () => {
    expect(v.idOfPhrase('机器学习')).toBe('machine_learning');
    expect(v.idOfPhrase('api 设计')).toBe('api_design');
    expect(v.idOfPhrase('机器学习技术')).toBe('machine_learning');
    expect(v.idOfPhrase('mlearning')).toBeNull();
    expect(v.idOfKey('mlearning')).toBe('machine_learning');
  });

  it('a name with a bracket or a comma in it has no phrase; its plain alias has', () => {
    expect(v.idOfPhrase('teacher qualification certificate china')).toBeNull();
    expect(v.idOfPhrase('teacher qualification certificate')).toBe('teacher');
    expect(v.idOfPhrase('')).toBeNull();
  });
});

describe('the write path teaches a snapshot at once', () => {
  it('rememberSkill and rememberAlias', () => {
    const v = buildVocabulary(FIXTURE);
    expect(rememberAlias(v, 'postgresql', 'pgsql')).toBe(true);
    expect(v.idOf('PgSQL')).toBe('postgresql');
    // Another skill's key is not taken away.
    expect(rememberAlias(v, 'mysql', 'pgsql')).toBe(false);
    expect(v.idOf('pgsql')).toBe('postgresql');
    expect(v.conflicts).toEqual([]);
    expect(rememberAlias(v, 'no_such_skill', 'x')).toBe(false);

    expect(rememberSkill(v, skill({ id: 'supabase', labelEn: 'Supabase', status: 'unreviewed', parentId: 'sql' }))).toBe(true);
    expect(v.idOf('supabase')).toBe('supabase');
    expect(v.reviewed('supabase')).toBe(false);
    expect(v.childrenOf('sql')).toEqual(['mysql', 'postgresql', 'supabase']);
    expect(v.size).toBe(FIXTURE.length + 1);
    expect(rememberSkill(v, skill({ id: 'supabase', labelEn: 'Again' }))).toBe(false);
  });
});

describe('mergeOverSeed', () => {
  const seed = [
    skill({ id: 'postgresql', labelEn: 'PostgreSQL', aliases: ['postgres'], parentId: 'sql', everydayWord: false }),
    skill({ id: 'machine_learning', labelEn: 'Machine learning', labelZh: '机器学习', labelZhHant: '機器學習' }),
    skill({ id: 'excel', labelEn: 'Excel', everydayWord: true }),
  ];

  it('keeps a seed skill the table does not have', () => {
    const { records } = mergeOverSeed(seed, []);
    expect(records.map((r) => r.id).sort()).toEqual(['excel', 'machine_learning', 'postgresql']);
  });

  it("a REVIEWED row's kind, parent, status and identifiers win; a label the row lacks comes from the seed; alias keys are the union", () => {
    const { records } = mergeOverSeed(seed, [
      row({ id: 'postgresql', labelEn: 'PostgreSQL', aliases: ['pgsql'], parentId: 'relational_databases', esco: 'esco:1' }),
      row({ id: 'machine_learning', labelEn: 'Machine Learning (ML)', labelZh: null, labelZhHant: null, kind: 'soft' }),
      row({ id: 'excel', labelEn: 'Excel', kind: 'not-a-kind' }),
    ]);
    const by = new Map(records.map((r) => [r.id, r]));
    expect(by.get('postgresql')).toMatchObject({ parentId: 'relational_databases', esco: 'esco:1', aliases: ['postgres'], aliasKeys: ['pgsql'], status: 'reviewed' });
    expect(by.get('machine_learning')).toMatchObject({ labelEn: 'Machine Learning (ML)', labelZh: '机器学习', labelZhHant: '機器學習', kind: 'soft', status: 'reviewed' });
    expect(by.get('excel')).toMatchObject({ kind: 'hard', everydayWord: true });
    const v = buildVocabulary(records);
    expect(v.idOf('postgres')).toBe('postgresql');
    expect(v.idOf('pgsql')).toBe('postgresql');
  });

  it('an unreviewed row that carries the id of a seed skill decides nothing: the seed skill stays reviewed, with its parent', () => {
    // The write path made the row "postgresql" for a posting string before the seed had the skill.
    const stale = row({ id: 'postgresql', labelEn: 'Postgresql', kind: 'soft', parentId: null, status: 'unreviewed', aliases: ['postgresql', 'pgsql'], onet: 'onet:7' });
    const { records } = mergeOverSeed([...seed, skill({ id: 'sql', labelEn: 'SQL' })], [stale]);
    const pg = records.find((r) => r.id === 'postgresql')!;
    expect(pg).toMatchObject({ status: 'reviewed', kind: 'hard', labelEn: 'PostgreSQL', parentId: 'sql', aliases: ['postgres'], onet: 'onet:7' });
    const v = buildVocabulary(records);
    expect(v.reviewed('postgresql')).toBe(true);
    expect(v.parentOf('postgresql')).toBe('sql');
    // What the row adds still counts.
    expect(v.idOf('pgsql')).toBe('postgresql');
  });

  it('a `seed` row is the copy an automatic step made: the skill is read from the seed as it is NOW; only added keys and identifiers count', () => {
    // The copy was made when the seed had no alias "postgres", no parent and another label.
    const copy = row({ id: 'postgresql', labelEn: 'Postgres (old label)', kind: 'soft', parentId: null, status: 'seed', aliases: ['learnedkey'], esco: 'esco:9' });
    const { records } = mergeOverSeed(seed, [copy]);
    expect(records.find((r) => r.id === 'postgresql')).toMatchObject({ status: 'reviewed', kind: 'hard', labelEn: 'PostgreSQL', parentId: 'sql', aliases: ['postgres'], aliasKeys: ['learnedkey'], esco: 'esco:9' });
    const v = buildVocabulary(records);
    expect(v.idOf('postgres')).toBe('postgresql');
    expect(v.idOf('learnedkey')).toBe('postgresql');
    expect(v.label('postgresql', 'en')).toBe('PostgreSQL');
  });

  it('a `seed` row whose skill the seed no longer has is not a skill', () => {
    const { records } = mergeOverSeed(seed, [row({ id: 'left_the_seed', labelEn: 'Left the seed', status: 'seed', aliases: ['somekey'] })]);
    expect(records.map((r) => r.id).sort()).toEqual(['excel', 'machine_learning', 'postgresql']);
  });

  it('a string the seed lists as dropped is no skill, also where the table still has its unreviewed row; a reviewed row wins', () => {
    const rows = [
      row({ id: 'fastpacedenvironment', labelEn: 'Fast-paced environment', aliases: ['fastpacedenvironment'], status: 'unreviewed' }),
      row({ id: 'selfstarter', labelEn: 'Self-starter', aliases: ['selfstarter'], status: 'reviewed' }),
    ];
    const merged = mergeOverSeed(seed, rows, { seedDroppedKeys: ['fastpacedenvironment', 'selfstarter', 'rockstar'] });
    expect(merged.records.map((r) => r.id).sort()).toEqual(['excel', 'machine_learning', 'postgresql', 'selfstarter']);
    const v = buildVocabulary(merged.records, { droppedKeys: merged.droppedKeys });
    expect(v.isDropped('Fast-paced environment')).toBe(true);
    expect(v.isDropped('rockstar')).toBe(true);
    // A reviewer kept this one later: it is a skill again.
    expect(v.isDropped('self-starter')).toBe(false);
    expect(v.idOf('Self-starter')).toBe('selfstarter');
    // Without the list the unreviewed row is a skill, as before.
    expect(mergeOverSeed(seed, rows).records.map((r) => r.id)).toContain('fastpacedenvironment');
  });

  it('adds a skill that exists only in the table, and removes one a reviewer dropped', () => {
    const { records, droppedKeys } = mergeOverSeed(seed, [
      row({ id: 'supabase', labelEn: 'Supabase', aliases: ['supabase'], status: 'unreviewed' }),
      row({ id: 'fastpacedenvironment', labelEn: 'Fast-paced environment', aliases: ['fastpacedenvironment'], status: 'dropped' }),
      row({ id: 'excel', labelEn: 'Excel', aliases: ['excel'], status: 'dropped' }),
    ]);
    expect(records.map((r) => r.id).sort()).toEqual(['machine_learning', 'postgresql', 'supabase']);
    const v = buildVocabulary(records, { droppedKeys });
    expect(v.idOf('Excel')).toBeNull();
    expect(v.isDropped('excel')).toBe(true);
    expect(v.isDropped('fast paced environment')).toBe(true);
    expect(v.idOf('Supabase')).toBe('supabase');
  });
});

describe('createVocabularyLoader', () => {
  const seed = [skill({ id: 'postgresql', labelEn: 'PostgreSQL' })];

  it('current() is the seed before the first load, never empty', () => {
    const repo = createMemorySkillRepo([row({ id: 'supabase', labelEn: 'Supabase' })]);
    const loader = createVocabularyLoader({ repo, seed });
    const before = loader.current();
    expect(before.size).toBe(1);
    expect(before.idOf('postgresql')).toBe('postgresql');
    expect(before.idOf('supabase')).toBeNull();
    expect(before.source).toBe('seed');
    expect(before.asOf).toBeNull();
    expect(repo.reads).toBe(0);
  });

  it('ready() reads the table once and current() is then the table over the seed', async () => {
    const repo = createMemorySkillRepo([row({ id: 'supabase', labelEn: 'Supabase', aliases: ['supabase'] })]);
    const loader = createVocabularyLoader({ repo, seed, now: () => 1_000 });
    await Promise.all([loader.ready(), loader.ready(), loader.ready()]);
    expect(repo.reads).toBe(1);
    const v = loader.current();
    expect(v.idOf('Supabase')).toBe('supabase');
    expect(v.idOf('postgresql')).toBe('postgresql');
    expect(v.source).toBe('database');
    expect(v.asOf).toEqual(new Date(1_000));
    await loader.ready();
    expect(repo.reads).toBe(1);
  });

  it('keeps a snapshot for 10 minutes; after that current() refreshes in the background and ready() waits for it', async () => {
    let at = 0;
    const repo = createMemorySkillRepo([]);
    const loader = createVocabularyLoader({ repo, seed, now: () => at });
    await loader.ready();
    expect(repo.reads).toBe(1);

    await repo.upsert([row({ id: 'supabase', labelEn: 'Supabase', aliases: ['supabase'] })]);
    at = VOCABULARY_TTL_MS - 1;
    expect(loader.current().idOf('supabase')).toBeNull();
    await loader.ready();
    expect(repo.reads).toBe(1);

    at = VOCABULARY_TTL_MS;
    // The caller gets the snapshot it has; the read starts behind it.
    expect(loader.current().idOf('supabase')).toBeNull();
    await loader.ready();
    expect(repo.reads).toBe(2);
    expect(loader.current().idOf('supabase')).toBe('supabase');
  });

  it('a table that cannot be read never rejects and never empties the vocabulary; the read is tried again later', async () => {
    let at = 0;
    let fail = true;
    const errors: unknown[] = [];
    const inner = createMemorySkillRepo([row({ id: 'supabase', labelEn: 'Supabase', aliases: ['supabase'] })]);
    const repo = {
      list: vi.fn(async () => {
        if (fail) throw new Error('connection refused');
        return inner.list();
      }),
    };
    const loader = createVocabularyLoader({ repo, seed, now: () => at, onError: (e) => errors.push(e) });
    await expect(loader.ready()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(loader.current().idOf('postgresql')).toBe('postgresql');
    expect(loader.current().source).toBe('seed');

    // Not tried again on every call.
    await loader.ready();
    expect(repo.list).toHaveBeenCalledTimes(1);

    fail = false;
    at = VOCABULARY_RETRY_MS;
    await loader.ready();
    expect(repo.list).toHaveBeenCalledTimes(2);
    expect(loader.current().idOf('supabase')).toBe('supabase');

    // A later failure keeps the last good snapshot.
    fail = true;
    at += VOCABULARY_TTL_MS;
    await loader.ready();
    expect(loader.current().idOf('supabase')).toBe('supabase');
  });

  it('a row that breaks the merge never rejects ready(): the last good snapshot stays, the error is reported and the read waits for the retry time', async () => {
    let at = 0;
    let broken = true;
    const errors: unknown[] = [];
    const good = row({ id: 'supabase', labelEn: 'Supabase', aliases: ['supabase'] });
    const repo = { list: vi.fn(async () => (broken ? [{ ...good, aliases: null as unknown as string[] }] : [good])) };
    const loader = createVocabularyLoader({ repo, seed, now: () => at, onError: (e) => errors.push(e) });
    await expect(loader.ready()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(loader.current().source).toBe('seed');
    expect(loader.current().idOf('postgresql')).toBe('postgresql');
    // Not tried again on every call, and current() starts no read before the retry time.
    await loader.ready();
    loader.current();
    expect(repo.list).toHaveBeenCalledTimes(1);

    // After the retry time current() starts the read in the background; a throw there is no unhandled rejection.
    at = VOCABULARY_RETRY_MS;
    loader.current();
    await loader.ready();
    expect(repo.list).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);

    broken = false;
    at += VOCABULARY_RETRY_MS;
    await loader.ready();
    expect(loader.current().idOf('supabase')).toBe('supabase');
  });

  it('a reporter that throws does not reject ready() either', async () => {
    const repo = { list: async (): Promise<SkillRow[]> => Promise.reject(new Error('connection refused')) };
    const loader = createVocabularyLoader({
      repo,
      seed,
      onError: () => {
        throw new Error('logger down');
      },
    });
    await expect(loader.ready()).resolves.toBeUndefined();
    expect(loader.current().size).toBe(1);
  });

  it('the keys the seed lists as dropped are dropped before the first load and after it', async () => {
    const repo = createMemorySkillRepo([row({ id: 'rockstar', labelEn: 'Rockstar', aliases: ['rockstar'], status: 'unreviewed' })]);
    const loader = createVocabularyLoader({ repo, seed, seedDroppedKeys: ['rockstar'] });
    expect(loader.current().isDropped('Rockstar')).toBe(true);
    await loader.ready();
    expect(loader.current().isDropped('Rockstar')).toBe(true);
    expect(loader.current().idOf('rockstar')).toBeNull();
  });

  it('refresh() reads now, whatever the cache says; a null repo reads nothing', async () => {
    const repo = createMemorySkillRepo([]);
    const loader = createVocabularyLoader({ repo, seed, now: () => 0 });
    await loader.ready();
    await repo.upsert([row({ id: 'supabase', labelEn: 'Supabase', aliases: ['supabase'] })]);
    expect((await loader.refresh()).idOf('supabase')).toBe('supabase');

    const seedOnly = createVocabularyLoader({ repo: null, seed });
    await seedOnly.ready();
    expect(seedOnly.current().size).toBe(1);
  });
});

describe('the process-wide vocabulary (index.ts)', () => {
  it('importing the module opens no database connection, and current() before ready() is the committed seed', () => {
    expect(prismaImports.count).toBe(0);
    const v = skills.current();
    expect(v.size).toBe(SEED_SKILLS.length);
    expect(v.size).toBeGreaterThan(100);
    expect(v.source).toBe('seed');
    expect(prismaImports.count).toBe(0);
  });

  it('the acceptance lines hold on the committed seed', () => {
    const v = skills.current();
    const id = v.idOf('Node.js');
    expect(id).not.toBeNull();
    expect(v.idOf('nodejs')).toBe(id);
    expect(v.idOf('NodeJS')).toBe(id);
    expect(v.idOf('a string no vocabulary knows 12345')).toBeNull();
    expect(new Set([v.idOf('機器學習'), v.idOf('机器学习'), v.idOf('machine learning')]).size).toBe(1);
    expect(v.idOf('機器學習')).not.toBeNull();
  });

  it('loadVocabulary({ repo }) reads through the injected repo; ready() and current() follow it', async () => {
    const repo = createMemorySkillRepo([row({ id: 'supabase', labelEn: 'Supabase', aliases: ['supabase'], status: 'unreviewed' })]);
    const loaded = await skills.loadVocabulary({ repo });
    expect(loaded.idOf('Supabase')).toBe('supabase');
    await skills.ready();
    expect(repo.reads).toBe(1);
    expect(skills.current()).toBe(loaded);
    expect(skills.current().size).toBe(SEED_SKILLS.length + 1);
    expect(prismaImports.count).toBe(0);

    await repo.upsert([row({ id: 'neon', labelEn: 'Neon', aliases: ['neon'], status: 'unreviewed' })]);
    expect((await skills.loadVocabulary({ force: true })).idOf('Neon')).toBe('neon');
  });

  it('the test seam pins a fixture and gives the loader back', async () => {
    skills.setVocabularyForTests(FIXTURE);
    expect(skills.current().size).toBe(FIXTURE.length);
    await skills.ready();
    expect((await skills.loadVocabulary()).size).toBe(FIXTURE.length);
    const built = buildVocabulary(FIXTURE.slice(0, 2));
    skills.setVocabularyForTests(built);
    expect(skills.current()).toBe(built);
    skills.setVocabularyForTests(null);
    expect(skills.current().size).toBe(SEED_SKILLS.length);
    expect(prismaImports.count).toBe(0);
  });
});
