// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../services/LoggerService.js', () => ({ logger }));
// Nothing here may open a database: the port is given a fake one, and the vocabulary is pinned to a fixture.
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import * as skills from '../../skills/index.js';
import { EmbeddingsError, resolveEmbeddingConfig, type EmbedOptions, type EmbedResult } from '../../../platform/embeddings/index.js';
import { LABEL_VECTOR_RETRY_MS, buildSkillMap, createEnrichSkillsPort, enrichVocabularyOf, skillMapKey, type EnrichSkillsPortDeps } from './skills.js';
import { buildKeywords } from './keywords.js';
import { FIXTURE_SKILLS, fixtureEnrichVocabulary, fixtureVocabulary } from './__tests__/fixtures.js';

const DIMENSIONS = skills.SKILL_EMBED_DIMENSIONS;
/** An embedding key for the shared stack: the client is "available". */
const WITH_KEY = { OPENAI_API_KEY: 'test-key' };
const MODEL = resolveEmbeddingConfig('roboapply', WITH_KEY).modelTag!;

/** A unit vector that is all zeros but one place: the place says which text it stands for. */
function vectorAt(place: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[place] = 1;
  return v;
}

interface World {
  deps: EnrichSkillsPortDeps;
  /** Every embedding request: the texts and the options. */
  embedCalls: Array<{ brand: string; texts: string[]; options: EmbedOptions }>;
  /** Rows the port created in RASkill. */
  created: Array<Record<string, unknown>>;
  /** Every RASkill write that is not a creation (a learned alias would be one). */
  otherWrites: unknown[];
  mentionWrites: unknown[];
  neighbourQueries: number;
}

/**
 * The embeddings client and the database, faked. `neighbours` says what the
 * RASkill neighbour query answers for a text; a text it does not list has no
 * neighbour worth taking (a far one), unless `noLabelVectors` (the table holds
 * no vector at all).
 */
function world(
  options: {
    env?: Record<string, string | undefined>;
    neighbours?: Record<string, Array<{ id: string; cosine: number }>>;
    embed?: (texts: readonly string[]) => Promise<EmbedResult>;
    /** The table holds no label vector (a function: asked on every query, so a test can fill the table later). */
    noLabelVectors?: boolean | (() => boolean);
    queryFails?: boolean;
    /** The n-th creation of a skill (1-based) fails. */
    createFailsAt?: number;
    now?: () => number;
  } = {},
): World {
  const places = new Map<number, string>();
  let creations = 0;
  const w: World = { deps: {}, embedCalls: [], created: [], otherWrites: [], mentionWrites: [], neighbourQueries: 0 };
  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      w.neighbourQueries += 1;
      if (options.queryFails) throw new Error('connection reset');
      if (typeof options.noLabelVectors === 'function' ? options.noLabelVectors() : options.noLabelVectors) return [];
      const literal = String(values[0]);
      const place = literal.slice(1, -1).split(',').indexOf('1');
      const text = places.get(place) ?? '';
      return options.neighbours?.[text] ?? [{ id: 'python', cosine: 0.31 }];
    },
    $executeRaw: async () => 0,
    $transaction: async (ops: unknown[]) => ops,
    rASkill: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        creations += 1;
        if (creations === options.createFailsAt) throw new Error('RASkill write timed out');
        w.created.push(...args.data);
        return { count: args.data.length };
      },
      updateMany: async (args: unknown) => {
        w.mentionWrites.push(args);
        return { count: 1 };
      },
      update: async (args: unknown) => {
        w.otherWrites.push(args);
        return {};
      },
      findUnique: async () => null,
      findMany: async () => [],
      upsert: async (args: unknown) => {
        w.otherWrites.push(args);
        return {};
      },
    },
  };
  w.deps = {
    env: options.env ?? WITH_KEY,
    loadSkills: async () => skills,
    loadEmbeddings: async () => ({
      resolveEmbeddingConfig,
      embedTexts: async (brand, texts, embedOptions) => {
        w.embedCalls.push({ brand: String(brand), texts: [...texts], options: embedOptions });
        if (options.embed) return options.embed(texts);
        const vectors = texts.map((text, i) => {
          const place = places.size + i;
          places.set(place, text);
          return vectorAt(place);
        });
        return { vectors, model: MODEL, tokens: texts.length };
      },
    }),
    loadDb: async () => db as never,
    ...(options.now ? { now: options.now } : {}),
  };
  return w;
}

const PUBLIC = { brand: 'roboapply' as const, write: true };
const IMPORT = { brand: 'roboapply' as const, write: false };

describe('the vocabulary port of enrichment (SM-6 write path)', () => {
  beforeEach(() => {
    skills.setVocabularyForTests(fixtureVocabulary());
    vi.clearAllMocks();
  });
  afterEach(() => {
    skills.resetVocabularyForTests();
  });

  it('a public posting: exact alias, then ONE embedding request for the unknown strings, a strict neighbour, else a new unreviewed skill', async () => {
    const w = world({ neighbours: { 'postgres db': [{ id: 'postgresql', cosine: 0.93 }, { id: 'mysql', cosine: 0.71 }] } });
    const port = createEnrichSkillsPort(w.deps);
    const terms = ['postgres', 'PostgreSQL', 'communication', 'postgres db', 'vector clocks', 'postgres'];
    const results = await port.canonicalize(terms, { ...PUBLIC, requestId: 'job-enrich-1' });
    expect(results).toEqual([
      { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
      { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
      { skillId: 'communication', status: 'reviewed', via: 'alias' },
      { skillId: 'postgresql', status: 'reviewed', via: 'embedding' },
      { skillId: 'vectorclock', status: 'unreviewed', via: 'new' },
      { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
    ]);
    // One request for the two strings no alias knows, as vocabulary text and never as user data.
    expect(w.embedCalls).toEqual([{ brand: 'roboapply', texts: ['postgres db', 'vector clocks'], options: { purpose: 'skill', carriesUserData: false, requestId: 'job-enrich-1' } }]);
    expect(w.neighbourQueries).toBe(2);
    // The unknown string is stored as an unreviewed skill that counts one mention.
    expect(w.created).toEqual([expect.objectContaining({ id: 'vectorclock', status: 'unreviewed', kind: 'hard', labelEn: 'Vector clocks', mentionCount: 1 })]);
    // A machine guess is never written to RASkill as an alias (it would read as a reviewed one).
    expect(w.otherWrites).toEqual([]);
  });

  it('a string mapped by a neighbour stays a machine guess for as long as the vocabulary that took the alias is loaded', async () => {
    const w = world({ neighbours: { 'postgres db': [{ id: 'postgresql', cosine: 0.93 }] } });
    const port = createEnrichSkillsPort(w.deps);
    expect((await port.canonicalize(['postgres db'], PUBLIC))[0]).toEqual({ skillId: 'postgresql', status: 'reviewed', via: 'embedding' });
    // The loaded vocabulary now knows the key as an alias; the port still says how it was found.
    expect(skills.current().idOf('Postgres DB')).toBe('postgresql');
    expect((await port.canonicalize(['Postgres DB', 'postgres'], PUBLIC))).toEqual([
      { skillId: 'postgresql', status: 'reviewed', via: 'embedding' },
      { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
    ]);
    expect((await port.canonicalize(['postgres db'], IMPORT))[0]!.via).toBe('embedding');
    // Not embedded a second time.
    expect(w.embedCalls).toHaveLength(1);

    // The vocabulary is read again from the table (every ten minutes): the guess was never stored, so it is gone.
    // An import gets no id for the string; a public posting embeds it again and it is a guess again.
    skills.setVocabularyForTests(fixtureVocabulary());
    expect((await port.canonicalize(['postgres db'], IMPORT))[0]).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    expect((await port.canonicalize(['postgres db'], PUBLIC))[0]!.via).toBe('embedding');
    expect(w.embedCalls).toHaveLength(2);
    // A reviewer stored the alias meanwhile: the reloaded vocabulary knows it as a reviewed name, and so does the port.
    skills.setVocabularyForTests(fixtureVocabulary(FIXTURE_SKILLS.map((r) => (r.id === 'postgresql' ? { ...r, aliases: [...r.aliases, 'postgres db'] } : r))));
    expect((await port.canonicalize(['postgres db'], PUBLIC))[0]).toEqual({ skillId: 'postgresql', status: 'reviewed', via: 'alias' });
    expect(w.embedCalls).toHaveLength(2);
  });

  it('a guessed alias is not a name of the skill for the keyword list: another posting whose text has the string gets no keyword from it (review probe)', async () => {
    const w = world({ neighbours: { pgsqldb: [{ id: 'postgresql', cosine: 0.91 }] } });
    const port = createEnrichSkillsPort(w.deps);
    // Job 1 lists the string; a neighbour maps it.
    expect((await port.canonicalize(['pgsqldb'], PUBLIC))[0]).toEqual({ skillId: 'postgresql', status: 'reviewed', via: 'embedding' });
    // The snapshot the whole process shares now answers the string like a reviewed alias...
    expect(skills.current().idOf('pgsqldb')).toBe('postgresql');
    expect(skills.skillIdsInText('We migrated pgsqldb to Kafka.')).toEqual(['postgresql', 'kafka']);
    // ...the vocabulary enrichment hands to its keyword list does not.
    const vocabulary = await port.vocabulary();
    expect(vocabulary.idOf('pgsqldb')).toBeNull();
    expect(vocabulary.idOf('PgSqlDB')).toBeNull();
    expect(vocabulary.idOf('postgres')).toBe('postgresql');
    expect(vocabulary.idsInText('pgsqldb')).toEqual([]);
    expect(vocabulary.idsInText('We migrated pgsqldb to Kafka.')).toEqual(['kafka']);
    // A name the vocabulary really knows still finds the skill, next to the guess or without it.
    expect(vocabulary.idsInText('We migrated pgsqldb (Postgres) to Kafka.')).toEqual(['postgresql', 'kafka']);
    expect(vocabulary.idsInText('PostgreSQL and psql daily.')).toEqual(['postgresql']);
    // Job 2 never lists the string, but its text has the word: no keyword for the guessed skill.
    const text = 'You will keep pgsqldb healthy. pgsqldb backups run nightly. We also use Kafka.';
    expect(buildKeywords(text, [], vocabulary).map((k) => [k.keyword, k.skillId])).toEqual([['kafka', 'kafka']]);
    // A view handed out BEFORE a guess (the service asks for the vocabulary first, then maps the job's strings)
    // reads the port's memory when it is asked, so that guess counts too.
    const later = world({ neighbours: { 'kafka streams api': [{ id: 'kafka', cosine: 0.95 }] } });
    const laterPort = createEnrichSkillsPort(later.deps);
    const before = await laterPort.vocabulary();
    await laterPort.canonicalize(['kafka streams api'], PUBLIC);
    expect(skills.current().idOf('kafka streams api')).toBe('kafka');
    expect(before.idOf('kafka streams api')).toBeNull();
    // Without the port's memory (a caller that passes no guesses) the view is the plain snapshot.
    expect(enrichVocabularyOf(skills.current(), skills.skillIdsInText).idOf('pgsqldb')).toBe('postgresql');
  });

  it('a user\'s own import: the exact-alias step only. Nothing is embedded, created or written', async () => {
    const w = world();
    const port = createEnrichSkillsPort(w.deps);
    expect(await port.canonicalize(['k8s', 'vector clocks', '沟通能力'], IMPORT)).toEqual([
      { skillId: 'kubernetes', status: 'reviewed', via: 'alias' },
      { skillId: null, status: 'unreviewed', via: 'none' },
      { skillId: 'communication', status: 'reviewed', via: 'alias' },
    ]);
    expect(w.embedCalls).toEqual([]);
    expect(w.neighbourQueries).toBe(0);
    expect(w.created).toEqual([]);
    expect(skills.current().idOf('vector clocks')).toBeNull();
  });

  it('ACCEPT: with no embedding key the alias path still fills ids, and nothing is created', async () => {
    for (const env of [{}, { EMBED_BASE_URL: 'https://embed.example.test/v1' }]) {
      const w = world({ env });
      const port = createEnrichSkillsPort(w.deps);
      expect(await port.canonicalize(['postgres', 'vector clocks'], PUBLIC)).toEqual([
        { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
        { skillId: null, status: 'unreviewed', via: 'none' },
      ]);
      expect(w.embedCalls).toEqual([]);
      expect(w.created).toEqual([]);
    }
    // GoApply reads its own key, else the shared one (D5): the same rule for both brands.
    const cn = world({ env: WITH_KEY });
    await createEnrichSkillsPort(cn.deps).canonicalize(['向量时钟'], { brand: 'goapply', write: true });
    expect(cn.embedCalls.map((c) => c.brand)).toEqual(['goapply']);
  });

  it('the embeddings client answers unavailable (policy, budget): the exact-alias answer, nothing created', async () => {
    for (const unavailable of ['policy', 'budget', 'no_key'] as const) {
      const w = world({ embed: async () => ({ unavailable }) });
      const port = createEnrichSkillsPort(w.deps);
      expect(await port.canonicalize(['postgres', 'vector clocks'], PUBLIC)).toEqual([
        { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
        { skillId: null, status: 'unreviewed', via: 'none' },
      ]);
      expect(w.embedCalls).toHaveLength(1);
      expect(w.created).toEqual([]);
      expect(skills.current().idOf('vector clocks')).toBeNull();
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a failed embedding call or a skills-table error never fails the job: the exact-alias answer, a warning, nothing created', async () => {
    const failing = world({ embed: async () => Promise.reject(new EmbeddingsError('http', 'embeddings endpoint answered 503', 503)) });
    expect(await createEnrichSkillsPort(failing.deps).canonicalize(['postgres', 'vector clocks'], PUBLIC)).toEqual([
      { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
      { skillId: null, status: 'unreviewed', via: 'none' },
    ]);
    expect(failing.created).toEqual([]);
    // The warning names the work item (its id is in the request id) and how many strings were asked.
    expect(logger.warn).toHaveBeenCalledWith('JOB_ENRICH', expect.stringContaining('canonical skill step failed'), { brand: 'roboapply', requestId: null, terms: 2, created: 0, error: 'embeddings endpoint answered 503' });
    await createEnrichSkillsPort(failing.deps).canonicalize(['vector clocks'], { ...PUBLIC, requestId: 'job-enrich-77' });
    expect(logger.warn).toHaveBeenLastCalledWith('JOB_ENRICH', expect.stringContaining('canonical skill step failed'), expect.objectContaining({ requestId: 'job-enrich-77', terms: 1 }));

    vi.clearAllMocks();
    const broken = world({ queryFails: true });
    expect((await createEnrichSkillsPort(broken.deps).canonicalize(['vector clocks'], PUBLIC))[0]).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    expect(broken.created).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // The modules themselves cannot be loaded: still an answer.
    vi.clearAllMocks();
    const unloadable = world();
    unloadable.deps.loadEmbeddings = async () => Promise.reject(new Error('module not found'));
    expect((await createEnrichSkillsPort(unloadable.deps).canonicalize(['postgres'], PUBLIC))[0]!.skillId).toBe('postgresql');
    expect(logger.warn).toHaveBeenCalledWith('JOB_ENRICH', expect.stringContaining('canonical skill step unavailable'), expect.objectContaining({ requestId: null, terms: 1 }));
  });

  it('a skills-table error part of the way: the skills stored before it are still answered as created by this job (review: no second mention)', async () => {
    const w = world({ createFailsAt: 2 });
    const results = await createEnrichSkillsPort(w.deps).canonicalize(['postgres', 'vector clocks', 'lamport clocks', 'paxos'], { ...PUBLIC, requestId: 'job-enrich-9' });
    expect(results).toEqual([
      { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
      // Stored before the failure: `via: 'new'`, so the service does not count this posting for it a second time.
      { skillId: 'vectorclock', status: 'unreviewed', via: 'new' },
      // The write that failed, and what came after it: no id on this pass.
      { skillId: null, status: 'unreviewed', via: 'none' },
      { skillId: null, status: 'unreviewed', via: 'none' },
    ]);
    expect(w.created.map((r) => r.id)).toEqual(['vectorclock']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('JOB_ENRICH', expect.stringContaining('canonical skill step failed'), { brand: 'roboapply', requestId: 'job-enrich-9', terms: 4, created: 1, error: 'RASkill write timed out' });
  });

  it('RASkill holds no label vector for the model in use: no skill is created, it is said once, and nothing is embedded again until the pause is over', async () => {
    let clock = 1_000_000;
    let empty = true;
    const w = world({ noLabelVectors: () => empty, now: () => clock });
    const port = createEnrichSkillsPort(w.deps);
    for (let i = 0; i < 3; i++) {
      expect(await port.canonicalize(['postgres', `vector clocks ${i}`, `lamport clocks ${i}`], PUBLIC)).toEqual([
        { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
        { skillId: null, status: 'unreviewed', via: 'none' },
        { skillId: null, status: 'unreviewed', via: 'none' },
      ]);
    }
    expect(w.created).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.warn).mock.calls[0]![1])).toMatch(/embed-labels/);
    expect(vi.mocked(logger.warn).mock.calls[0]![2]).toEqual({ model: MODEL, retryInMs: LABEL_VECTOR_RETRY_MS });
    // The first job found out (one embedding request, and the first empty answer stopped the step); the two after
    // it made no request at all. A table without vectors costs one request per pause, not one per job.
    expect(w.embedCalls).toHaveLength(1);
    expect(w.neighbourQueries).toBe(1);

    // The pause is over and the table is still empty: one more try, no second warning.
    clock += LABEL_VECTOR_RETRY_MS;
    expect((await port.canonicalize(['vector clocks 7'], PUBLIC))[0]).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    expect(w.embedCalls).toHaveLength(2);
    await port.canonicalize(['vector clocks 8'], PUBLIC);
    expect(w.embedCalls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // `embed-labels` has run: after the pause strings with no close neighbour are created as unreviewed skills.
    empty = false;
    expect((await port.canonicalize(['vector clocks 8'], PUBLIC))[0]).toEqual({ skillId: null, status: 'unreviewed', via: 'none' });
    clock += LABEL_VECTOR_RETRY_MS;
    expect((await port.canonicalize(['vector clocks 8'], PUBLIC))[0]).toMatchObject({ status: 'unreviewed', via: 'new' });
    expect(w.created).toHaveLength(1);
    // A string that is never embedded (a short word with several readings) is created without the neighbour step.
    expect((await port.canonicalize(['QX'], PUBLIC))[0]).toMatchObject({ skillId: 'qx', via: 'new' });
    // The pause is per model, not per process: an import and the exact-alias step were never held back.
    expect((await port.canonicalize(['k8s'], IMPORT))[0]).toEqual({ skillId: 'kubernetes', status: 'reviewed', via: 'alias' });
  });

  it('a runner-up that is too close, or a neighbour under the threshold, is not a match', async () => {
    const w = world({
      neighbours: {
        'database engines': [{ id: 'postgresql', cosine: 0.9 }, { id: 'mysql', cosine: 0.89 }],
        'stream platform': [{ id: 'kafka', cosine: 0.8 }],
      },
    });
    const results = await createEnrichSkillsPort(w.deps).canonicalize(['database engines', 'stream platform'], PUBLIC);
    expect(results.map((r) => r.via)).toEqual(['new', 'new']);
    expect(results.every((r) => r.status === 'unreviewed')).toBe(true);
  });

  it('counts one mention per id in one statement; nothing for an empty list', async () => {
    const w = world();
    const port = createEnrichSkillsPort(w.deps);
    await port.countMentions([]);
    expect(w.mentionWrites).toEqual([]);
    await port.countMentions(['postgresql', 'kafka', 'postgresql', '']);
    expect(w.mentionWrites).toEqual([{ where: { id: { in: ['postgresql', 'kafka'] } }, data: { mentionCount: { increment: 1 } } }]);
  });

  it('answers an empty list without loading anything but the vocabulary', async () => {
    const w = world();
    expect(await createEnrichSkillsPort(w.deps).canonicalize([], PUBLIC)).toEqual([]);
    expect(w.embedCalls).toEqual([]);
  });

  it('vocabulary(): the loaded snapshot with the sentence rule of features/skills', async () => {
    const vocabulary = await createEnrichSkillsPort(world().deps).vocabulary();
    expect(vocabulary.idOf('k8s')).toBe('kubernetes');
    expect(vocabulary.kindOf('cpa')).toBe('certification');
    expect(vocabulary.reviewed('featureflag')).toBe(false);
    expect(vocabulary.label('machine_learning', 'zh-TW')).toBe('機器學習');
    expect(vocabulary.idsInText('We use Kafka and REST APIs; go the extra mile for our sales force.')).toEqual(['kafka', 'rest_apis']);
  });
});

describe('buildSkillMap', () => {
  const vocabulary = fixtureEnrichVocabulary(fixtureVocabulary(undefined, ['fastpacedenvironment']));

  it('keys by the stored spelling and carries id, vocabulary kind, status, how it was found and the skill\'s own names', () => {
    const terms = ['postgres', 'Communication', 'feature flags', 'vector clocks', 'Fast-paced environment', '机器学习'];
    const map = buildSkillMap(
      terms,
      [
        { skillId: 'postgresql', status: 'reviewed', via: 'alias' },
        { skillId: 'communication', status: 'reviewed', via: 'alias' },
        { skillId: 'featureflag', status: 'unreviewed', via: 'alias' },
        { skillId: null, status: 'unreviewed', via: 'none' },
        { skillId: null, status: 'unreviewed', via: 'none' },
        { skillId: 'machine_learning', status: 'reviewed', via: 'embedding' },
      ],
      vocabulary,
    );
    expect(Object.fromEntries(map)).toEqual({
      postgres: { skillId: 'postgresql', kind: 'hard', status: 'reviewed', via: 'alias', labels: ['postgresql'] },
      communication: { skillId: 'communication', kind: 'soft', status: 'reviewed', via: 'alias', labels: ['communication', '沟通能力', '溝通能力'] },
      'feature flags': { skillId: 'featureflag', kind: 'hard', status: 'unreviewed', via: 'alias', labels: ['feature flags'] },
      'vector clocks': { skillId: null, kind: null, status: 'unreviewed', via: 'none', labels: [] },
      // A reviewer ruled it is not a skill: it is not stored.
      'fast-paced environment': { skillId: null, kind: null, status: 'dropped', via: 'none', labels: [] },
      机器学习: { skillId: 'machine_learning', kind: 'hard', status: 'reviewed', via: 'embedding', labels: ['machine learning', '机器学习', '機器學習'] },
    });
    expect(skillMapKey('Fast-paced  Environment')).toBe('fast-paced environment');
  });

  it('the status is the vocabulary\'s, never the answer\'s alone, and a missing answer is no skill', () => {
    const map = buildSkillMap(['feature flags', 'kafka', ''], [{ skillId: 'featureflag', status: 'reviewed', via: 'alias' }], vocabulary);
    expect(map.get('feature flags')!.status).toBe('unreviewed');
    expect(map.get('kafka')).toEqual({ skillId: null, kind: null, status: 'unreviewed', via: 'none', labels: [] });
    expect(map.size).toBe(2);
  });
});
