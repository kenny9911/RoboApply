// @vitest-environment node
// MKT-2G item 3: string → canonical skill id (exact alias, then a strict
// embedding neighbour, else a new unreviewed skill), and a person's canonical
// skills. Fake embed, nearest and create functions: no network, no database.
import { afterEach, describe, expect, it, vi } from 'vitest';

const prismaImports = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../lib/prisma.js', () => {
  prismaImports.count++;
  return { default: {} };
});

import {
  canonicalize,
  canonicalizeMany,
  missingRowOf,
  nearestSkills,
  otherModelSkillIds,
  rowOfRecord,
  SKILL_EMBED_DIMENSIONS,
  SKILL_EMBED_MATCH_MIN_DEFAULT,
  skillEmbedMatchMin,
  skillStoreDeps,
  userSkillIds,
  vectorLiteral,
  writeSkillEmbedding,
  type CanonicalizeDeps,
  type SkillNeighbour,
} from './canonicalize.js';
import { aliasKey } from './keys.js';
import { createMemorySkillRepo } from './repo.js';
import { SEED_SKILLS } from './seed/index.js';
import { skillIdsInText } from './text.js';
import type { SkillRecord, SkillSnapshot } from './types.js';
import { buildVocabulary, resetVocabularyForTests, setVocabularyForTests } from './vocabulary.js';

function skill(over: Partial<SkillRecord> & { id: string; labelEn: string }): SkillRecord {
  return { kind: 'hard', labelZh: null, labelZhHant: null, aliases: [], parentId: null, esco: null, onet: null, status: 'reviewed', ...over };
}

const RECORDS: SkillRecord[] = [
  skill({ id: 'postgresql', labelEn: 'PostgreSQL', aliases: ['postgres'] }),
  skill({ id: 'kubernetes', labelEn: 'Kubernetes', aliases: ['k8s'] }),
  skill({ id: 'machine_learning', labelEn: 'Machine learning', labelZh: '机器学习', labelZhHant: '機器學習' }),
  skill({ id: 'rest', labelEn: 'REST', aliases: ['rest api', 'restful'], everydayWord: true }),
  skill({ id: 'react', labelEn: 'React', aliases: ['react.js'], everydayWord: true }),
  skill({ id: 'go', labelEn: 'Go', aliases: ['golang'], everydayWord: true }),
  skill({ id: 'nodejs', labelEn: 'Node.js', aliases: ['node'] }),
  skill({ id: 'supabase', labelEn: 'Supabase', status: 'unreviewed' }),
];

/** A fresh vocabulary per test: the write path teaches the one it is given. */
function fresh(): SkillSnapshot {
  return buildVocabulary(RECORDS);
}

const VECTOR = [0.1, 0.2, 0.3];

function fakes(neighbours: Record<string, SkillNeighbour[]> = {}) {
  const texts: string[][] = [];
  const created: Array<SkillRecord & { mentionCount: number }> = [];
  const learned: Array<[string, string]> = [];
  const embed = vi.fn(async (batch: string[]) => {
    texts.push(batch);
    // The vector carries the index of its text, so `nearest` can tell them apart.
    return batch.map((_, i) => [...VECTOR, texts.length, i]);
  });
  const nearest = vi.fn(async (vector: number[], _limit: number) => {
    const batch = texts[vector[3]! - 1]!;
    return neighbours[batch[vector[4]!]!] ?? [];
  });
  const create = vi.fn(async (record: SkillRecord & { mentionCount: number }) => {
    created.push(record);
  });
  const learn = vi.fn(async (id: string, key: string) => {
    learned.push([id, key]);
  });
  return { embed, nearest, create, learn, texts, created, learned };
}

afterEach(() => {
  resetVocabularyForTests();
});

describe('step 1: an exact alias', () => {
  it('never calls embed', async () => {
    const f = fakes();
    const vocabulary = fresh();
    for (const term of ['PostgreSQL', 'postgres', ' POSTGRES ', 'k8s', '機器學習', '机器学习', 'machine learning']) {
      const out = await canonicalize(term, { ...f, vocabulary });
      expect(out.via, term).toBe('alias');
      expect(out.status, term).toBe('reviewed');
    }
    expect((await canonicalize('機器學習', { ...f, vocabulary })).skillId).toBe('machine_learning');
    expect(await canonicalize('Supabase', { ...f, vocabulary })).toEqual({ skillId: 'supabase', status: 'unreviewed', via: 'alias' });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.nearest).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe('step 2: a strict embedding neighbour', () => {
  it('a neighbour at 0.9 with a runner-up at 0.7 maps, and the alias is learned', async () => {
    const f = fakes({ 'Postgres DB': [{ id: 'postgresql', cosine: 0.9 }, { id: 'kubernetes', cosine: 0.7 }] });
    const vocabulary = fresh();
    expect(await canonicalize('Postgres DB', { ...f, vocabulary })).toEqual({ skillId: 'postgresql', status: 'reviewed', via: 'embedding' });
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.nearest).toHaveBeenCalledWith(expect.any(Array), 3);
    expect(f.learned).toEqual([['postgresql', aliasKey('Postgres DB')]]);
    expect(f.create).not.toHaveBeenCalled();
    // The next lookup is exact: no second embedding.
    expect(await canonicalize('postgres db', { ...f, vocabulary })).toEqual({ skillId: 'postgresql', status: 'reviewed', via: 'alias' });
    expect(f.embed).toHaveBeenCalledTimes(1);
  });

  it('a neighbour at 0.84 does not map: a new unreviewed skill is created', async () => {
    const f = fakes({ 'Postgres DB': [{ id: 'postgresql', cosine: 0.84 }, { id: 'kubernetes', cosine: 0.2 }] });
    const vocabulary = fresh();
    // The id of a new skill is its comparison key.
    expect(await canonicalize('Postgres DB', { ...f, vocabulary })).toEqual({ skillId: aliasKey('Postgres DB'), status: 'unreviewed', via: 'new' });
    expect(f.learned).toEqual([]);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ id: aliasKey('Postgres DB'), aliasKeys: [aliasKey('Postgres DB')], kind: 'hard', status: 'unreviewed', labelEn: 'Postgres DB', mentionCount: 1, parentId: null, esco: null, onet: null });
  });

  it('the margin rule: a runner-up closer than 0.03 means no match', async () => {
    const near = fakes({ Pgsql: [{ id: 'postgresql', cosine: 0.9 }, { id: 'kubernetes', cosine: 0.88 }] });
    expect((await canonicalize('Pgsql', { ...near, vocabulary: fresh() })).via).toBe('new');
    const exact = fakes({ Pgsql: [{ id: 'postgresql', cosine: 0.9 }, { id: 'kubernetes', cosine: 0.87 }] });
    expect((await canonicalize('Pgsql', { ...exact, vocabulary: fresh() })).via).toBe('embedding');
    const alone = fakes({ Pgsql: [{ id: 'postgresql', cosine: 0.86 }] });
    expect((await canonicalize('Pgsql', { ...alone, vocabulary: fresh() })).via).toBe('embedding');
    // The order `nearest` returns them in does not matter.
    const unordered = fakes({ Pgsql: [{ id: 'kubernetes', cosine: 0.5 }, { id: 'postgresql', cosine: 0.95 }] });
    expect((await canonicalize('Pgsql', { ...unordered, vocabulary: fresh() })).skillId).toBe('postgresql');
  });

  it('the threshold is 0.86, reads SKILL_EMBED_MATCH_MIN, and never goes below 0.8', async () => {
    expect(SKILL_EMBED_MATCH_MIN_DEFAULT).toBe(0.86);
    expect(skillEmbedMatchMin({})).toBe(0.86);
    expect(skillEmbedMatchMin({ SKILL_EMBED_MATCH_MIN: '0.9' })).toBe(0.9);
    expect(skillEmbedMatchMin({ SKILL_EMBED_MATCH_MIN: '0.5' })).toBe(0.8);
    expect(skillEmbedMatchMin({ SKILL_EMBED_MATCH_MIN: '7' })).toBe(1);
    expect(skillEmbedMatchMin({ SKILL_EMBED_MATCH_MIN: 'high' })).toBe(0.86);
    expect(skillEmbedMatchMin({ SKILL_EMBED_MATCH_MIN: '' })).toBe(0.86);
    const f = fakes({ Pgsql: [{ id: 'postgresql', cosine: 0.87 }] });
    expect((await canonicalize('Pgsql', { ...f, vocabulary: fresh(), minCosine: 0.9 })).via).toBe('new');
  });

  it('a neighbour the vocabulary does not know is not a match, and does not hide the real one behind it', async () => {
    const f = fakes({ Pgsql: [{ id: 'gone', cosine: 0.99 }] });
    expect((await canonicalize('Pgsql', { ...f, vocabulary: fresh() })).via).toBe('new');
    // The row of a skill the seed no longer has may still carry a vector: it is no neighbour at all.
    const behind = fakes({ Pgsql: [{ id: 'gone', cosine: 0.99 }, { id: 'postgresql', cosine: 0.93 }, { id: 'kubernetes', cosine: 0.4 }] });
    expect(await canonicalize('Pgsql', { ...behind, vocabulary: fresh() })).toEqual({ skillId: 'postgresql', status: 'reviewed', via: 'embedding' });
  });

  it('a one-character string and an everyday word are never embedded', async () => {
    const f = fakes();
    const vocabulary = fresh();
    for (const term of ['X', 'excel', 'Spring', 'node', 'net']) await canonicalize(term, { ...f, vocabulary });
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('a short abbreviation with more than one reading is never mapped by a neighbour', async () => {
    const f = fakes({ PM: [{ id: 'postgresql', cosine: 0.99 }], AR: [{ id: 'kubernetes', cosine: 0.99 }] });
    const vocabulary = fresh();
    expect(await canonicalizeMany(['PM', 'AR', 'GCP'], { ...f, vocabulary })).toEqual([
      { skillId: 'pm', status: 'unreviewed', via: 'new' },
      { skillId: 'ar', status: 'unreviewed', via: 'new' },
      { skillId: 'gcp', status: 'unreviewed', via: 'new' },
    ]);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('without an embed function nothing is embedded and nothing fails', async () => {
    const f = fakes();
    const vocabulary = fresh();
    expect(await canonicalize('Pgsql', { nearest: f.nearest, create: f.create, vocabulary })).toEqual({ skillId: 'pgsql', status: 'unreviewed', via: 'new' });
    expect(await canonicalize('Postgres', { nearest: f.nearest, vocabulary })).toMatchObject({ skillId: 'postgresql', via: 'alias' });
    expect(f.nearest).not.toHaveBeenCalled();
  });

  it('an embeddings client that is unavailable (null) or answers badly skips the step', async () => {
    const f = fakes();
    const unavailable: CanonicalizeDeps = { embed: vi.fn(async () => null), nearest: f.nearest, create: f.create, vocabulary: fresh() };
    expect((await canonicalize('Pgsql', unavailable)).via).toBe('new');
    const short: CanonicalizeDeps = { embed: vi.fn(async () => []), nearest: f.nearest, vocabulary: fresh() };
    expect(await canonicalize('Pgsql', short)).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    const junk: CanonicalizeDeps = { embed: vi.fn(async () => [[Number.NaN]]), nearest: f.nearest, vocabulary: fresh() };
    expect((await canonicalize('Pgsql', junk)).via).toBe('none');
    expect(f.nearest).not.toHaveBeenCalled();
  });
});

describe('step 3 and 4: a new unreviewed skill, or nothing', () => {
  it('with no dependencies the result is { skillId: null, via: "none" }', async () => {
    expect(await canonicalize('Pgsql', { vocabulary: fresh() })).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    expect(await canonicalize('', { vocabulary: fresh() })).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
  });

  it('a created skill is known at once, so the same string is not created twice', async () => {
    const f = fakes();
    const vocabulary = fresh();
    expect(await canonicalize('Deno', { create: f.create, vocabulary })).toEqual({ skillId: 'deno', status: 'unreviewed', via: 'new' });
    expect(await canonicalize('DENO', { create: f.create, vocabulary })).toEqual({ skillId: 'deno', status: 'unreviewed', via: 'alias' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(vocabulary.reviewed('deno')).toBe(false);
    expect(vocabulary.label('deno', 'zh')).toBe('Deno');
  });

  it('a Chinese string keeps its own words as the label and folds to one id in both scripts', async () => {
    const f = fakes();
    const vocabulary = fresh();
    expect(await canonicalize('供应链管理', { create: f.create, vocabulary })).toEqual({ skillId: '供应链管理', status: 'unreviewed', via: 'new' });
    // The string is the label of its own script only.
    expect(f.created[0]).toMatchObject({ labelEn: '供应链管理', labelZh: '供应链管理', labelZhHant: null });
    expect(await canonicalize('供應鏈管理', { create: f.create, vocabulary })).toEqual({ skillId: '供应链管理', status: 'unreviewed', via: 'alias' });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('label(id, "zh-TW") never returns the Simplified string of an unreviewed skill: it is empty, which means "show the posting\'s own string"', async () => {
    const f = fakes();
    const vocabulary = fresh();
    // First seen in Simplified script. A Traditional posting of the same skill maps to this id.
    const simplified = (await canonicalize('供应链管理', { create: f.create, vocabulary })).skillId!;
    expect((await canonicalize('供應鏈管理', { create: f.create, vocabulary })).skillId).toBe(simplified);
    expect(vocabulary.label(simplified, 'zh')).toBe('供应链管理');
    expect(vocabulary.label(simplified, 'en')).toBe('供应链管理');
    for (const locale of ['zh-TW', 'zh-Hant', 'zh-HK']) expect(vocabulary.label(simplified, locale), locale).toBe('');
    // First seen in Traditional script: Taiwan reads its own string; the mainland label stays unset.
    const traditional = (await canonicalize('數據倉庫', { create: f.create, vocabulary })).skillId!;
    expect(f.created[1]).toMatchObject({ labelEn: '數據倉庫', labelZh: null, labelZhHant: '數據倉庫' });
    expect(vocabulary.label(traditional, 'zh-TW')).toBe('數據倉庫');
    // An English string is unchanged for every locale.
    const english = (await canonicalize('Deno', { create: f.create, vocabulary })).skillId!;
    expect(f.created[2]).toMatchObject({ labelEn: 'Deno', labelZh: null, labelZhHant: null });
    expect(vocabulary.label(english, 'zh-TW')).toBe('Deno');
  });

  it('a sentence, a string a reviewer dropped and a string with no letter are never created', async () => {
    const f = fakes();
    const vocabulary = buildVocabulary(RECORDS, { droppedKeys: ['fastpacedenvironment'] });
    const sentence = 'Experience working across many teams in a large organisation with shifting priorities';
    expect(sentence.length).toBeGreaterThan(60);
    for (const term of [sentence, 'Fast-paced environment', '---', '  ']) expect(await canonicalize(term, { ...f, vocabulary }), term).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    expect(f.create).not.toHaveBeenCalled();
    // Neither a dropped string nor a sentence is sent to the embeddings endpoint: a sentence is never created, so
    // it would be paid for again on every posting that carries it.
    expect(f.texts.flat()).not.toContain('Fast-paced environment');
    expect(f.texts.flat()).not.toContain(sentence);
    expect(f.embed).not.toHaveBeenCalled();
    // Exactly 60 characters is still a name.
    const sixty = 'x'.repeat(60);
    await canonicalize(sixty, { ...f, vocabulary });
    expect(f.texts.flat()).toEqual([sixty]);
  });
});

describe('canonicalizeMany', () => {
  it('batches the embedding call: one call for every string that needs it', async () => {
    const f = fakes({
      'Postgres DB': [{ id: 'postgresql', cosine: 0.93 }, { id: 'kubernetes', cosine: 0.4 }],
      'Kube': [{ id: 'kubernetes', cosine: 0.91 }],
      'Brand new thing': [{ id: 'kubernetes', cosine: 0.3 }],
    });
    const vocabulary = fresh();
    const out = await canonicalizeMany(['PostgreSQL', 'Postgres DB', 'Kube', 'Brand new thing', 'postgres db', 'excel', ''], { ...f, vocabulary });
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.texts).toEqual([['Postgres DB', 'Kube', 'Brand new thing']]);
    expect(out.map((o) => [o.skillId, o.via])).toEqual([
      ['postgresql', 'alias'],
      ['postgresql', 'embedding'],
      ['kubernetes', 'embedding'],
      ['brandnewthing', 'new'],
      ['postgresql', 'embedding'],
      ['excel', 'new'],
      [null, 'none'],
    ]);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it('with only exact aliases it calls nothing', async () => {
    const f = fakes();
    await canonicalizeMany(['postgres', 'k8s'], { ...f, vocabulary: fresh() });
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('by default it uses the process-wide vocabulary, loaded first', async () => {
    setVocabularyForTests(RECORDS);
    expect(await canonicalizeMany(['postgres', 'unknown thing'])).toEqual([
      { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
      { skillId: null, status: 'unreviewed', via: 'none' },
    ]);
    expect(prismaImports.count).toBe(0);
  });
});

describe('skillIdsInText', () => {
  const vocabulary = buildVocabulary(SEED_SKILLS);
  const ids = (text: string, listOnlyWords = false) => skillIdsInText(text, { vocabulary, listOnlyWords });

  it('finds whole words in any spelling, in order of appearance', () => {
    expect(ids('Tuned PostgreSQL queries and wrote REST APIs in Node.js on AWS.')).toEqual(['postgresql', 'rest', 'api_design', 'nodejs', 'aws']);
    expect(ids('ci/cd with GitHub Actions; PL/SQL and T-SQL; scikit-learn')).toEqual(['ci_cd', 'github', 'github_actions', 'pl_sql', 'sql', 't_sql', 'scikit_learn']);
  });

  it('a word inside another word is not found', () => {
    expect(ids('javascripting and postgresqlish')).toEqual([]);
    expect(ids('JavaScript')).toEqual(['javascript']);
  });

  it('an everyday word is not taken from a sentence, its unmistakable forms are', () => {
    expect(ids('handed the rest of the migration to the team')).toEqual([]);
    expect(ids('she excels at swift decisions and will go far')).toEqual([]);
    expect(ids('Account manager at Oracle')).toEqual([]);
    expect(ids('a 5-node cluster with net revenue impact, TS/SCI clearance')).toEqual([]);
    expect(ids('RESTful services, Spring Boot, React Native and Oracle DB')).toEqual(['rest', 'spring_boot', 'react_native', 'oracle']);
    expect(ids('React', true)).toEqual(['react']);
  });

  it('names do not join across a comma or a full stop', () => {
    expect(ids('What comes next. JS skills are solid')).toEqual(['javascript']);
    expect(ids('Spring, Boot camp')).toEqual([]);
    expect(ids('power, bi-weekly reports')).toEqual([]);
    expect(ids('Power BI dashboards')).toEqual(['power_bi']);
  });

  it('finds a Latin name next to Chinese text, and Chinese names inside a sentence', () => {
    expect(ids('熟悉Java和Python，了解机器学习与关系型数据库')).toEqual(['java', 'python', 'machine_learning', 'relational_databases']);
    expect(ids('熟悉機器學習，具備溝通能力')).toEqual(['machine_learning', 'communication']);
    expect(ids('持有注册会计师证书，通过大学英语六级')).toEqual(['cpa', 'cet_6']);
  });

  it('a Chinese name of two characters must stand alone', () => {
    expect(ids('负责统一建设标准的制定')).toEqual([]);
    expect(ids('关注会员增长')).toEqual([]);
    expect(ids('证书：一建、PMP')).toEqual(['first_class_constructor', 'pmp']);
  });

  it('has nothing to say about an empty text', () => {
    expect(ids('')).toEqual([]);
    expect(skillIdsInText(null, { vocabulary })).toEqual([]);
    expect(ids('... + # ---')).toEqual([]);
  });
});

describe('skillIdsInText: several words name a skill only when the skill is written as those words', () => {
  const vocabulary = buildVocabulary(SEED_SKILLS);
  const ids = (text: string, listOnlyWords = false) => skillIdsInText(text, { vocabulary, listOnlyWords });

  it('two ordinary words whose letters spell a tool are not that tool', () => {
    // I am ≠ IAM, in design ≠ InDesign
    expect(ids('I am a product designer with 6 years of experience in design and research.')).toEqual([]);
    // work day ≠ Workday, open shift ≠ OpenShift, air flow ≠ Airflow, post man ≠ Postman, super set ≠ Superset, hub spot ≠ HubSpot
    expect(ids('8-hour work day; open shift schedule; air flow testing; post man; super set; hub spot')).toEqual([]);
    // power point ≠ PowerPoint, word press ≠ WordPress, red shift ≠ Redshift
    expect(ids('power point of contact; word press; red shift')).toEqual([]);
    // red is ≠ Redis, no SQL ≠ NoSQL, sales force ≠ Salesforce. The word SQL itself is there: the scan does not read "no".
    expect(ids('The colour red is used; no SQL experience; managed a sales force of 20')).toEqual(['sql']);
    expect(ids('data bricks, snow flake, big query, click house, type script, word press')).toEqual([]);
    // A whole word that is a name is still found beside another word: "java script" names Java, not JavaScript.
    expect(ids('java script')).toEqual(['java']);
  });

  it('the same holds across a hyphen, a slash and an underscore', () => {
    expect(ids('re-act, ex-cel, work-day, air-flow, red-shift, open/shift, snow_flake, sales-force')).toEqual([]);
    expect(ids('re-act ex-cel work-day', true)).toEqual([]);
  });

  it('a name written as several words is found as those words, whatever joins them', () => {
    expect(ids('REST APIs')).toEqual(['rest', 'api_design']);
    expect(ids('React Native')).toEqual(['react_native']);
    expect(ids('Spring Boot')).toEqual(['spring_boot']);
    expect(ids('pl/sql')).toEqual(['pl_sql', 'sql']);
    expect(ids('CI/CD, ci-cd, CI / CD')).toEqual(['ci_cd']);
    expect(ids('scikit-learn and scikit learn')).toEqual(['scikit_learn']);
    expect(ids('SQL Server, Power BI, Ruby on Rails, GitHub Actions, Hugging Face')).toEqual(['sql', 'sql_server', 'power_bi', 'ruby_on_rails', 'github', 'github_actions', 'hugging_face']);
    expect(ids('relational database, Relational Databases')).toEqual(['relational_databases']);
  });

  it('one word is found in any spelling of the name, and a name with an inner dot also with a space or a hyphen there', () => {
    expect(ids('NodeJS')).toEqual(['nodejs']);
    expect(ids('node.js')).toEqual(['nodejs']);
    expect(ids('Node JS')).toEqual(['nodejs', 'javascript']);
    expect(ids('Node-JS')).toEqual(['nodejs', 'javascript']);
    expect(ids('React JS')).toEqual(['react', 'javascript']);
    expect(ids('ASP.NET Core and asp net')).toEqual(['asp_net']);
    expect(ids('springboot, restapi, powerbi')).toEqual(['spring_boot', 'rest', 'power_bi']);
  });

  it('a stored alias key that has no spelling is found as one word only', () => {
    const v = buildVocabulary([
      { id: 'postgresql', kind: 'hard', labelEn: 'PostgreSQL', labelZh: null, labelZhHant: null, aliases: [], aliasKeys: ['postgresdb', '波斯特格雷', 'pg数据库'], parentId: null, esco: null, onet: null, status: 'reviewed' },
    ]);
    expect(skillIdsInText('ran postgresdb in production', { vocabulary: v })).toEqual(['postgresql']);
    expect(skillIdsInText('ran a postgres db in production', { vocabulary: v })).toEqual([]);
    expect(skillIdsInText('ran postgres-db in production', { vocabulary: v })).toEqual([]);
    // A key with Chinese in it is its own spelling: Chinese is written without spaces.
    expect(skillIdsInText('熟悉波斯特格雷的使用', { vocabulary: v })).toEqual(['postgresql']);
    expect(skillIdsInText('熟悉PG数据库', { vocabulary: v })).toEqual(['postgresql']);
    expect(v.idOfPhrase('postgres db')).toBeNull();
    expect(v.idOfPhrase('pg 数据库')).toBe('postgresql');
  });

  it('an alias learned or a skill created a moment ago follows the same rule at once', async () => {
    const v = buildVocabulary(RECORDS);
    const f = fakes({ 'Kube Ctl': [{ id: 'kubernetes', cosine: 0.95 }] });
    expect((await canonicalize('Kube Ctl', { ...f, vocabulary: v })).via).toBe('embedding');
    // The learned alias is a key with no spelling: one word, never two.
    expect(skillIdsInText('scripted kubectl rollouts', { vocabulary: v })).toEqual(['kubernetes']);
    expect(skillIdsInText('a kube ctl thing', { vocabulary: v })).toEqual([]);
    await canonicalize('Apache Iceberg', { create: f.create, vocabulary: v });
    expect(skillIdsInText('tables in Apache Iceberg format', { vocabulary: v })).toEqual(['apacheiceberg']);
    expect(skillIdsInText('an apache, an iceberg', { vocabulary: v })).toEqual([]);
  });

  it('Chinese characters on two sides of a space are two words', () => {
    // 数据库 is a name of relational databases; 数据 库存 is "data" and "stock".
    expect(ids('负责数据库维护')).toEqual(['relational_databases']);
    expect(ids('负责数据 库存管理')).toEqual([]);
    // A name written with a space is found with and without it.
    expect(ids('负责API设计与API 设计评审')).toEqual(['api_design']);
  });

  it('a short abbreviation with another reading is not taken from prose', () => {
    const sentences = [
      'Administered 500 ml IV fluids', // millilitres, not machine learning
      'Mixed 30 mL of reagent',
      'Reduced CPA by 30% across paid social campaigns', // cost per acquisition, not the certificate
      'P.S. I am available from March',
      'PS: references on request',
      'Lifelong fan of the Red Sox',
      'Used a rag to clean the equipment',
      'Worked with Ai Weiwei studio on the exhibition',
      'Revenue up 12% vs PY',
      'ICH-GCP trained clinical research associate', // good clinical practice, not Google Cloud
      'Trained in CBT and DBT for adolescents', // dialectical behaviour therapy, not dbt
      'LL.M. in tax law; LLM, Leiden', // the law degree, not large language models
      'Certified NLP practitioner and life coach', // neuro-linguistic programming
      'Processed CPP and EI deductions', // Canada Pension Plan, not C++
      'IFR rated commercial pilot', // instrument flight rules, not IFRS
      'Iam a hard working person',
      'Managed AR and AP; 40 hr week; available 2 pm',
    ];
    for (const sentence of sentences) expect(ids(sentence), sentence).toEqual([]);
    // From a person's skill list each of them counts.
    expect(userSkillIds(['ML', 'AI', 'CPA', 'PS', 'RAG', 'SOX', 'IAM', 'GCP', 'dbt', 'LLM', 'NLP'], null, vocabulary).sort()).toEqual(
      ['artificial_intelligence', 'cpa', 'dbt', 'google_cloud', 'iam', 'llm', 'machine_learning', 'natural_language_processing', 'photoshop', 'rag', 'sox'].sort(),
    );
    // The long forms and the Chinese names count from text.
    expect(ids('machine learning, artificial intelligence, certified public accountant, Photoshop, Google Cloud Platform')).toEqual(['machine_learning', 'artificial_intelligence', 'cpa', 'photoshop', 'google_cloud', 'cloud_infrastructure']);
    expect(ids('熟悉机器学习，持有注册会计师证书')).toEqual(['machine_learning', 'cpa']);
    // And the direct check of one skill (listOnlyWords) still sees the abbreviation.
    expect(ids('Built ML pipelines', true)).toEqual(['machine_learning']);
    // A short name with one reading counts from prose.
    expect(ids('AWS, SQL, CSS, PHP, iOS, SEO and a CFA charter')).toEqual(['aws', 'sql', 'css', 'php', 'ios', 'seo', 'cfa']);
    // The word as written decides: IFRS and LLMs are not short.
    expect(ids('IFRS reporting; fine-tuned LLMs')).toEqual(['ifrs', 'llm']);
  });

  it('every short name of the seed is either cleared for prose or counts from the skill list only', () => {
    const listOnly: string[] = [];
    for (const id of vocabulary.ids()) for (const key of vocabulary.keysOf(id)) if (/^[a-z]{1,3}$/.test(key) && skillIdsInText(key, { vocabulary }).length === 0) listOnly.push(key);
    // Adding a short alias to the seed changes this list: decide whether it has one reading (keys.ts).
    expect(listOnly.sort()).toEqual(['ai', 'c', 'cpa', 'cpp', 'dbt', 'gcp', 'go', 'iam', 'ifr', 'jax', 'llm', 'ml', 'nat', 'net', 'nlp', 'ps', 'py', 'r', 'rag', 'sap', 'sox', 'ts']);
  });
});

describe('userSkillIds', () => {
  const vocabulary = buildVocabulary(SEED_SKILLS);
  const ids = (skills: string[], text: string | null = null) => userSkillIds(skills, text, vocabulary).sort();

  it('ordinary prose shows no skill', () => {
    expect(ids([], 'I am a product designer with 6 years of experience in design and research. P.S. I work an 8-hour work day.')).toEqual([]);
  });

  it('finds PostgreSQL in "tuned PostgreSQL queries"', () => {
    expect(ids([], 'tuned PostgreSQL queries')).toEqual(['postgresql']);
  });

  it('does not find REST in "the rest of the migration"', () => {
    expect(ids([], 'handed over the rest of the migration')).toEqual([]);
  });

  it('an everyday word counts from the skill list', () => {
    expect(ids(['REST', 'Go', 'Excel'])).toEqual(['excel', 'go', 'rest']);
    expect(ids(['Go-to-market strategy', 'Rest and recovery coaching'])).toEqual([]);
  });

  it('a listed skill counts whole, by its parts and by the names inside it', () => {
    expect(ids(['TypeScript/Node.js'])).toEqual(['nodejs', 'typescript']);
    expect(ids(['React and Redux'])).toEqual(['react', 'redux']);
    // One unknown part: the entry is read like a sentence, where an everyday word does not count.
    expect(ids(['React and friends', 'PostgreSQL and data wrangling'])).toEqual(['postgresql']);
    expect(ids(['Advanced PostgreSQL tuning'])).toEqual(['postgresql']);
    expect(ids(['k8s', 'Amazon Web Services', 'NodeJS'])).toEqual(['aws', 'kubernetes', 'nodejs']);
    expect(ids(['', '   ', 'Underwater basket weaving'])).toEqual([]);
  });

  it('works in Chinese, Simplified and Traditional', () => {
    expect(ids(['机器学习', '注册会计师'], '熟悉Java，负责数据可视化')).toEqual(['cpa', 'data_visualization', 'java', 'machine_learning']);
    expect(ids(['機器學習'], '具備團隊合作精神')).toEqual(['machine_learning', 'teamwork']);
  });

  it('a listed skill may be unreviewed; from the text only reviewed skills count', () => {
    const v = buildVocabulary([...RECORDS]);
    expect(userSkillIds(['Supabase'], null, v)).toEqual(['supabase']);
    expect(userSkillIds([], 'built on Supabase and PostgreSQL', v)).toEqual(['postgresql']);
  });

  it('by default it reads the process-wide vocabulary', () => {
    setVocabularyForTests(RECORDS);
    expect(userSkillIds(['k8s'], 'postgres everywhere')).toEqual(['kubernetes', 'postgresql']);
  });
});

describe('the database functions', () => {
  const vector = Array.from({ length: SKILL_EMBED_DIMENSIONS }, (_, i) => (i % 7) / 10);

  function fakeDb(rows: unknown[] = []) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => statements.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return {
      statements,
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => (tag(strings, ...values), rows)),
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => (tag(strings, ...values), 1)),
    };
  }

  it('vectorLiteral refuses a wrong length and a value that is not a number', () => {
    expect(vectorLiteral(vector).startsWith('[0,0.1,0.2')).toBe(true);
    expect(() => vectorLiteral([1, 2, 3])).toThrow(/1024 dimensions/);
    expect(() => vectorLiteral([...vector.slice(1), Number.NaN])).toThrow(/finite/);
  });

  it('nearestSkills orders by cosine distance over reviewed rows of one model, by name, never SELECT *', async () => {
    const db = fakeDb([{ id: 'postgresql', cosine: '0.91' }, { id: 'mysql', cosine: 0.7 }]);
    const out = await nearestSkills(db as never, vector, { model: 'm@1024', limit: 3 });
    expect(out).toEqual([{ id: 'postgresql', cosine: 0.91 }, { id: 'mysql', cosine: 0.7 }]);
    const { sql, values } = db.statements[0]!;
    expect(sql).toContain('FROM "RASkill"');
    expect(sql).toContain('"embedding" <=> ?::halfvec');
    // A reviewed skill is a reviewed row or the `seed` row of a seed skill; never an unreviewed or dropped row.
    expect(sql).toContain(`s."status" IN ('reviewed', 'seed')`);
    expect(sql).toContain('s."embeddingModel" = ?');
    expect(sql).not.toContain('*');
    expect(values).toEqual([vectorLiteral(vector), 'm@1024', vectorLiteral(vector), 3]);
  });

  it('writeSkillEmbedding writes the vector and its model in one statement', async () => {
    const db = fakeDb();
    expect(await writeSkillEmbedding(db as never, 'postgresql', vector, 'm@1024')).toBe(true);
    expect(db.statements[0]!.sql).toContain('UPDATE "RASkill" SET "embedding" = ?::halfvec, "embeddingModel" = ?');
    expect(db.statements[0]!.values).toEqual([vectorLiteral(vector), 'm@1024', 'postgresql']);
    await expect(writeSkillEmbedding(db as never, 'postgresql', [1], 'm@1024')).rejects.toThrow(/dimensions/);
  });

  it('otherModelSkillIds reads the rows whose vector another model made, by name', async () => {
    const db = fakeDb([{ id: 'postgresql', model: 'other@1024' }, { id: 'mysql', model: null }]);
    expect(await otherModelSkillIds(db as never, 'm@1024')).toEqual([{ id: 'postgresql', model: 'other@1024' }, { id: 'mysql', model: '' }]);
    const { sql, values } = db.statements[0]!;
    expect(sql).toContain('FROM "RASkill"');
    expect(sql).toContain('s."embedding" IS NOT NULL AND s."embeddingModel" IS DISTINCT FROM ?');
    expect(sql).not.toContain('*');
    expect(values).toEqual(['m@1024']);
  });

  it('missingRowOf: the row made for a seed skill is a marker of status seed with no keys of its own; any other skill is written as it is', () => {
    const pg = skill({ id: 'postgresql', labelEn: 'PostgreSQL', aliases: ['postgres'], parentId: 'sql' });
    expect(missingRowOf(pg)).toMatchObject({ id: 'postgresql', status: 'seed', aliases: [], labelEn: 'PostgreSQL' });
    expect(missingRowOf(pg, new Set())).toEqual(rowOfRecord(pg));
    const own = skill({ id: 'not_in_the_seed', labelEn: 'Not in the seed', status: 'unreviewed' });
    expect(missingRowOf(own)).toEqual(rowOfRecord(own));
  });

  it('rowOfRecord stores every label and alias as a key', () => {
    const r = rowOfRecord(skill({ id: 'machine_learning', labelEn: 'Machine learning', labelZh: '机器学习', labelZhHant: '機器學習', aliases: ['ML'], aliasKeys: ['machinelearning', 'mlearning'] }));
    expect(r.aliases).toEqual(['machinelearning', 'ml', 'mlearning', '机器学习']);
    expect(r.status).toBe('reviewed');
  });

  it('skillStoreDeps: create is safe to repeat; learn makes the row of a seed skill before it adds the key', async () => {
    const repo = createMemorySkillRepo();
    const vocabulary = fresh();
    const db = fakeDb([{ id: 'postgresql', cosine: 0.95 }]);
    const deps = skillStoreDeps(db as never, { model: 'm@1024', repo, vocabulary: () => vocabulary });

    const record = { ...skill({ id: 'deno', labelEn: 'Deno', status: 'unreviewed', aliasKeys: ['deno'] }), mentionCount: 1 };
    await deps.create(record);
    await deps.create(record);
    expect(repo.rows.get('deno')).toMatchObject({ status: 'unreviewed', mentionCount: 1, aliases: ['deno'] });

    expect(repo.rows.has('postgresql')).toBe(false);
    await deps.learn('postgresql', 'pgsql');
    // The row of a seed skill is a `seed` row: it holds what was learned and decides nothing about the skill.
    expect(repo.rows.get('postgresql')).toMatchObject({ status: 'seed', labelEn: 'PostgreSQL', aliases: ['pgsql'] });
    await deps.learn('postgresql', 'pgsql');
    expect(repo.rows.get('postgresql')!.aliases).toEqual(['pgsql']);
    await deps.learn('no_such_skill', 'x');
    expect(repo.rows.has('no_such_skill')).toBe(false);
    // A skill the seed does not have keeps its own status and names.
    const local = skillStoreDeps(db as never, { model: 'm@1024', repo, vocabulary: () => vocabulary, seedIds: new Set() });
    await local.learn('kubernetes', 'kube');
    expect(repo.rows.get('kubernetes')).toMatchObject({ status: 'reviewed' });
    expect(repo.rows.get('kubernetes')!.aliases).toEqual(expect.arrayContaining([aliasKey('Kubernetes'), 'k8s', 'kube']));

    expect(await deps.nearest(vector, 3)).toEqual([{ id: 'postgresql', cosine: 0.95 }]);
  });

  it('end to end with the store: an embedding match is stored and exact for the next process', async () => {
    const repo = createMemorySkillRepo();
    const vocabulary = fresh();
    const db = fakeDb([{ id: 'kubernetes', cosine: 0.92 }, { id: 'postgresql', cosine: 0.31 }]);
    const deps = { embed: async (texts: string[]) => texts.map(() => vector), ...skillStoreDeps(db as never, { model: 'm@1024', repo, vocabulary: () => vocabulary }), vocabulary };
    expect(await canonicalize('Kube', deps)).toEqual({ skillId: 'kubernetes', status: 'reviewed', via: 'embedding' });
    expect(repo.rows.get('kubernetes')!.aliases).toContain('kube');
  });
});
