// @vitest-environment node
//
// The job.index and user.embed workers (MKT-2H items 3 and 4), with a database
// double that records SQL, a fake embeddings client and fake consent functions.
// Nothing here reaches a database, a model or a network.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { AI_CONSENT_TYPE, setConsentLookup } from '../../platform/consent/index.js';
import { DeferWorkError, PermanentWorkError, createBudget, type LeasedWorkItem } from '../../platform/queue/index.js';
import { jobContentHash } from '../match/index.js';
import { buildCardText, cardHash } from './cardText.js';
import { createRetrievalRepo } from './repo.js';
import { buildSearchDoc } from './searchDoc.js';
import { fakeDb, fakeEmbed, indexJob, vector } from './testkit.js';
import { intentText, redactResumeText, sourceHash } from './userText.js';
import {
  JOB_INDEX_MAX_IDS,
  RETRIEVAL_CONCURRENCY,
  RETRIEVAL_WORK_KINDS,
  defaultStrip,
  defaultUserEmbedDeps,
  embedUser,
  indexJobs,
  jobIndexWorker,
  loadSkillLabels,
  retrievalWorkers,
  setRetrievalDepsForTests,
  userEmbedWorker,
  userVectorGate,
  type JobIndexDeps,
  type UserEmbedDeps,
  type UserTextSource,
} from './workers.js';

const ENV = { OPENAI_API_KEY: 'sk-test' };
const TAG = 'openai/text-embedding-3-small@1024';
const ctx = { budget: createBudget(60_000), leaseOwner: 'test' };

function item(kind: string, payload: unknown, over: Partial<LeasedWorkItem<unknown>> = {}): LeasedWorkItem<unknown> {
  return { id: 'w1', kind, brand: 'roboapply', userId: null, payload, attempts: 1, maxAttempts: 5, dedupeKey: null, priority: 100, ...over };
}

// ── job.index ─────────────────────────────────────────────────────────────

function jobKit(options: { jobs?: ReturnType<typeof indexJob>[]; stored?: Record<string, { model: string; contentHash: string }>; embed?: Parameters<typeof fakeEmbed>[0]; env?: Record<string, string | undefined>; aiAllowed?: (userId: string) => boolean } = {}) {
  const jobs = options.jobs ?? [indexJob()];
  const f = fakeDb({
    jobs,
    respond: (s) => (s.kind === 'query' && s.text.includes('FROM "RAJobEmbedding" e WHERE') ? Object.entries(options.stored ?? {}).map(([jobId, m]) => ({ jobId, ...m })) : s.kind === 'execute' ? 1 : []),
  });
  const e = fakeEmbed(options.embed);
  const aiAllowed = vi.fn(async (userId: string) => (options.aiAllowed ? options.aiAllowed(userId) : true));
  const deps: JobIndexDeps = { repo: createRetrievalRepo(async () => f.db), embed: e.embed, contentHash: (row) => jobContentHash(row), aiAllowed, env: options.env ?? ENV };
  const writes = () => f.statements.filter((s) => s.text.startsWith('UPDATE "RAJob" SET'));
  const upserts = () => f.statements.filter((s) => s.text.startsWith('INSERT INTO "RAJobEmbedding"'));
  return { deps, statements: f.statements, embedCalls: e.calls, aiAllowed, writes, upserts };
}

describe('job.index', () => {
  it('writes searchDoc, a searchTsv, contentHash and lang in one UPDATE, then one vector with the current model tag', async () => {
    const k = jobKit();
    const row = indexJob();
    const out = await indexJobs({ jobIds: ['job_1'] }, k.deps, { requestId: 'r1' });
    expect(out).toEqual({ indexed: 1, embedded: 1, unchanged: 0, unavailable: null, withoutConsent: 0 });

    // Exactly one statement for the four columns.
    expect(k.writes()).toHaveLength(1);
    const w = k.writes()[0]!;
    expect(w.text).toBe(`UPDATE "RAJob" SET "searchDoc" = $1, "searchTsv" = to_tsvector('simple', $2), "contentHash" = $3, "lang" = $4 WHERE "id" = $5`);
    expect(w.values).toEqual([buildSearchDoc(row), buildSearchDoc(row), jobContentHash(row), 'en', 'job_1']);

    // One embeddings call with the card text, as public job text.
    expect(k.embedCalls).toHaveLength(1);
    expect(k.embedCalls[0]).toMatchObject({ brand: 'roboapply', texts: [buildCardText(row)], options: { purpose: 'job', carriesUserData: false, requestId: 'r1' } });
    // One RAJobEmbedding row: the job's market, the model tag, the card hash, the vector.
    expect(k.upserts()).toHaveLength(1);
    expect(k.upserts()[0]!.values.slice(0, 4)).toEqual(['job_1', 'intl', TAG, cardHash(buildCardText(row))]);
    expect(k.upserts()[0]!.values[4]).toBe(`[${vector(1).join(',')}]`);
  });

  it('stores RAJob.contentHash = jobContentHash(row): the hash a fit depends on', async () => {
    const row = indexJob({ title: 'Staff Data Engineer', skills: ['Spark', 'SQL'] });
    const k = jobKit({ jobs: [row] });
    await indexJobs({ jobIds: [row.id] }, k.deps);
    expect(k.writes()[0]!.values[2]).toBe(jobContentHash({ title: row.title, qualifications: row.qualifications, descriptionPlain: row.descriptionPlain, skills: row.skills }));
  });

  it('with no embedding key writes the lexical columns, no embedding row, and raises no error', async () => {
    const k = jobKit({ env: {} });
    const out = await indexJobs({ jobIds: ['job_1'] }, k.deps);
    expect(out).toMatchObject({ indexed: 1, embedded: 0, unavailable: 'no_key' });
    expect(k.writes()).toHaveLength(1);
    expect(k.upserts()).toHaveLength(0);
    expect(k.embedCalls).toHaveLength(0);
  });

  it('succeeds with the lexical part when the client is unavailable (budget, policy): the vectors wait for the sweep', async () => {
    for (const reason of ['budget', 'policy'] as const) {
      const k = jobKit({ embed: { unavailable: reason } });
      const out = await indexJobs({ jobIds: ['job_1'] }, k.deps);
      expect(out).toMatchObject({ indexed: 1, embedded: 0, unavailable: reason });
      expect(k.writes()).toHaveLength(1);
      expect(k.upserts()).toHaveLength(0);
    }
  });

  it('makes no embeddings call on a second run with unchanged content', async () => {
    const row = indexJob();
    const k = jobKit({ stored: { job_1: { model: TAG, contentHash: cardHash(buildCardText(row)) } } });
    const out = await indexJobs({ jobIds: ['job_1'] }, k.deps);
    expect(out).toMatchObject({ indexed: 1, embedded: 0, unchanged: 1 });
    expect(k.embedCalls).toHaveLength(0);
    expect(k.upserts()).toHaveLength(0);
    // The lexical part is written again (it costs no model call) and the stored vector is marked as checked.
    expect(k.writes()).toHaveLength(1);
    expect(k.statements.some((s) => s.text.startsWith('UPDATE "RAJobEmbedding" SET "embeddedAt" = $1'))).toBe(true);
  });

  it('embeds again when the card text changed or the stored vector is of another model', async () => {
    const changed = jobKit({ stored: { job_1: { model: TAG, contentHash: 'an-older-card' } } });
    expect(await indexJobs({ jobIds: ['job_1'] }, changed.deps)).toMatchObject({ embedded: 1, unchanged: 0 });
    const otherModel = jobKit({ stored: { job_1: { model: 'old-model@1024', contentHash: cardHash(buildCardText(indexJob())) } } });
    expect(await indexJobs({ jobIds: ['job_1'] }, otherModel.deps)).toMatchObject({ embedded: 1, unchanged: 0 });
  });

  it('embeds a batch of 96 jobs in one call', async () => {
    const jobs = Array.from({ length: 96 }, (_, i) => indexJob({ id: `job_${i}`, title: `Engineer ${i}` }));
    const k = jobKit({ jobs });
    const out = await indexJobs({ jobIds: jobs.map((j) => j.id) }, k.deps);
    expect(out).toMatchObject({ indexed: 96, embedded: 96 });
    expect(k.embedCalls).toHaveLength(1);
    expect(k.embedCalls[0]!.texts).toHaveLength(96);
    expect(k.writes()).toHaveLength(96);
    expect(k.upserts()).toHaveLength(96);
    expect(JOB_INDEX_MAX_IDS).toBe(96);
  });

  it('indexes a private import lexically always, and gives it a vector only when its owner allows AI', async () => {
    const mine = indexJob({ id: 'imp_1', visibility: 'private', ownerUserId: 'u_no', market: 'cn' });
    const denied = jobKit({ jobs: [mine], aiAllowed: () => false });
    const out = await indexJobs({ jobIds: ['imp_1'] }, denied.deps);
    expect(out).toMatchObject({ indexed: 1, embedded: 0, withoutConsent: 1 });
    expect(denied.writes()).toHaveLength(1);
    expect(denied.embedCalls).toHaveLength(0);
    expect(denied.upserts()).toHaveLength(0);
    expect(denied.aiAllowed).toHaveBeenCalledWith('u_no');

    const allowed = jobKit({ jobs: [{ ...mine, ownerUserId: 'u_yes' }] });
    expect(await indexJobs({ jobIds: ['imp_1'] }, allowed.deps)).toMatchObject({ indexed: 1, embedded: 1 });
    // Its text came from the user: the call says so, and it runs as the job's own brand.
    expect(allowed.embedCalls[0]).toMatchObject({ brand: 'goapply', options: { purpose: 'job', carriesUserData: true } });
    expect(allowed.upserts()[0]!.values.slice(0, 2)).toEqual(['imp_1', 'cn']);
  });

  it('never asks about consent for a public posting', async () => {
    const k = jobKit();
    await indexJobs({ jobIds: ['job_1'] }, k.deps);
    expect(k.aiAllowed).not.toHaveBeenCalled();
  });

  it('skips archived and missing jobs and does nothing for none', async () => {
    const k = jobKit({ jobs: [indexJob({ id: 'gone', archivedAt: new Date() })] });
    expect(await indexJobs({ jobIds: ['gone', 'missing'] }, k.deps)).toEqual({ indexed: 0, embedded: 0, unchanged: 0, unavailable: null, withoutConsent: 0 });
    expect(k.statements).toHaveLength(0);
  });

  it('never mixes markets in one embeddings call', async () => {
    const k = jobKit({ jobs: [indexJob({ id: 'a', market: 'intl' }), indexJob({ id: 'b', market: 'cn' })] });
    await indexJobs({ jobIds: ['a', 'b'] }, k.deps);
    expect(k.embedCalls.map((c) => c.brand).sort()).toEqual(['goapply', 'roboapply']);
    expect(k.upserts().map((u) => u.values.slice(0, 2))).toEqual(expect.arrayContaining([['a', 'intl'], ['b', 'cn']]));
  });

  it('fails the item (the queue retries) when the embeddings call fails; the lexical part is already written', async () => {
    const k = jobKit();
    k.deps.embed = async () => {
      throw new Error('The embeddings endpoint answered 500.');
    };
    await expect(indexJobs({ jobIds: ['job_1'] }, k.deps)).rejects.toThrow(/500/);
    expect(k.writes()).toHaveLength(1);
    expect(k.upserts()).toHaveLength(0);
  });

  it('the worker refuses a payload that is not 1 to 96 ids, and runs a valid one', async () => {
    for (const bad of [null, {}, { jobIds: [] }, { jobIds: Array.from({ length: 97 }, (_, i) => `j${i}`) }, { jobIds: ['ok', 7] }]) {
      await expect(jobIndexWorker.handler(item('job.index', bad), ctx)).rejects.toBeInstanceOf(PermanentWorkError);
    }
    const k = jobKit();
    setRetrievalDepsForTests({ jobIndex: k.deps });
    await jobIndexWorker.handler(item('job.index', { jobIds: ['job_1'] }), ctx);
    expect(k.writes()).toHaveLength(1);
    expect(k.embedCalls[0]!.options.requestId).toBe('job-index-w1');
  });
});

// ── user.embed ────────────────────────────────────────────────────────────

// SYNTHETIC person: the name and contact details are made up (the same as the match testkit's resume).
const SOURCE: UserTextSource = {
  intent: { targetTitles: ['Backend Engineer'], targetTaxonomyIds: ['backend_engineer'], targetSeniority: ['senior'], skills: ['Go', 'PostgreSQL'], industries: ['Fintech'], goal: 'more_senior' },
  resumeParsed: {
    candidateName: 'Ada Lovelace',
    contact: { email: 'ada@example.com', phone: '+49 151 2345 6789' },
    summary: 'Backend engineer in payments. Contact: ada@example.com, +49 151 2345 6789.',
    experience: [{ title: 'Senior Software Engineer', company: 'PayCo', highlights: ['Built payment APIs in Go serving 2M users.'] }],
    skills: ['Go', 'TypeScript'],
  },
  names: ['Ada', 'Lovelace', 'Ada Lovelace'],
};

function userKit(options: {
  source?: UserTextSource | null;
  stored?: Array<{ kind: string; model: string; sourceHash: string }>;
  /** An Error: the consent record cannot be read. */
  aiAllowed?: boolean | Error;
  personalized?: boolean | Error;
  /** Vectors of the person's own private imports. */
  importVectors?: number;
  embed?: Parameters<typeof fakeEmbed>[0];
  env?: Record<string, string | undefined>;
  queryTag?: string | null;
} = {}) {
  const f = fakeDb({
    respond: (s) =>
      s.kind === 'query' ? (options.stored ?? []) : s.text.startsWith('DELETE FROM "RAUserEmbedding"') ? (options.stored?.length ?? 0) : s.text.startsWith('DELETE FROM "RAJobEmbedding"') ? (options.importVectors ?? 0) : 1,
  });
  const e = fakeEmbed(options.embed);
  const answer = (v: boolean | Error | undefined) => async () => {
    if (v instanceof Error) throw v;
    return v ?? true;
  };
  const aiAllowed = vi.fn(answer(options.aiAllowed));
  const personalized = vi.fn(answer(options.personalized));
  const loadUser = vi.fn(async () => (options.source === undefined ? SOURCE : options.source));
  const deps: UserEmbedDeps = {
    repo: createRetrievalRepo(async () => f.db),
    embed: e.embed,
    aiAllowed,
    personalized,
    loadUser,
    strip: async () => redactResumeText,
    queryTag: async () => (options.queryTag === undefined ? TAG : options.queryTag),
    env: options.env ?? ENV,
  };
  const upserts = () => f.statements.filter((s) => s.text.startsWith('INSERT INTO "RAUserEmbedding"'));
  const deletes = () => f.statements.filter((s) => s.text.startsWith('DELETE FROM "RAUserEmbedding"'));
  const importDeletes = () => f.statements.filter((s) => s.text.startsWith('DELETE FROM "RAJobEmbedding"'));
  return { deps, statements: f.statements, embedCalls: e.calls, aiAllowed, personalized, loadUser, upserts, deletes, importDeletes };
}

describe('user.embed', () => {
  it('RoboApply: a person with a primary resume gets two rows, intent and resume', async () => {
    const k = userKit();
    const out = await embedUser({ userId: 'u1', market: 'intl' }, k.deps, { requestId: 'r9' });
    expect(out).toEqual({ status: 'done', embedded: ['intent', 'resume'], unchanged: [], removed: [] });
    expect(k.embedCalls).toHaveLength(1);
    expect(k.embedCalls[0]).toMatchObject({ brand: 'roboapply', options: { purpose: 'user', carriesUserData: true, userId: 'u1', requestId: 'r9' } });
    expect(k.embedCalls[0]!.texts).toHaveLength(2);
    expect(k.upserts().map((u) => u.values.slice(0, 4))).toEqual([
      ['u1', 'intl', 'intent', TAG],
      ['u1', 'intl', 'resume', TAG],
    ]);
    // The stored hash is sha1(text + model tag).
    expect(k.upserts()[0]!.values[4]).toBe(sourceHash(intentText(SOURCE.intent), TAG));
    // RoboApply has no consent gate.
    expect(k.aiAllowed).not.toHaveBeenCalled();
    expect(k.personalized).not.toHaveBeenCalled();
  });

  it('the text sent holds no name, e-mail address or phone number of the person', async () => {
    const k = userKit();
    await embedUser({ userId: 'u1', market: 'intl' }, k.deps);
    const sent = k.embedCalls[0]!.texts.join('\n');
    expect(sent).toContain('Senior Software Engineer');
    expect(sent).not.toMatch(/Ada|Lovelace/);
    expect(sent).not.toContain('ada@example.com');
    expect(sent).not.toMatch(/\+49|2345 6789/);
    expect(sent).not.toMatch(/PayCo/);
  });

  it('without a resume only the intent row is written; a resume vector left from before is removed', async () => {
    const k = userKit({ source: { ...SOURCE, resumeParsed: null }, stored: [{ kind: 'resume', model: TAG, sourceHash: 'old' }] });
    const out = await embedUser({ userId: 'u1', market: 'intl' }, k.deps);
    expect(out).toEqual({ status: 'done', embedded: ['intent'], unchanged: [], removed: ['resume'] });
    expect(k.embedCalls[0]!.texts).toHaveLength(1);
    expect(k.upserts().map((u) => u.values[2])).toEqual(['intent']);
    expect(k.deletes()[0]!.values).toEqual(['u1', 'intl', ['resume']]);
  });

  it('changing nothing makes no embeddings call', async () => {
    const first = userKit();
    await embedUser({ userId: 'u1', market: 'intl' }, first.deps);
    const stored = first.upserts().map((u) => ({ kind: String(u.values[2]), model: String(u.values[3]), sourceHash: String(u.values[4]) }));
    const second = userKit({ stored });
    expect(await embedUser({ userId: 'u1', market: 'intl' }, second.deps)).toEqual({ status: 'done', embedded: [], unchanged: ['intent', 'resume'], removed: [] });
    expect(second.embedCalls).toHaveLength(0);
    expect(second.upserts()).toHaveLength(0);
  });

  it('embeds only the kind whose text changed', async () => {
    const first = userKit();
    await embedUser({ userId: 'u1', market: 'intl' }, first.deps);
    const stored = first.upserts().map((u) => ({ kind: String(u.values[2]), model: String(u.values[3]), sourceHash: String(u.values[4]) }));
    const second = userKit({ stored, source: { ...SOURCE, intent: { ...SOURCE.intent, goal: 'management' } } });
    expect(await embedUser({ userId: 'u1', market: 'intl' }, second.deps)).toMatchObject({ embedded: ['intent'], unchanged: ['resume'] });
    expect(second.embedCalls[0]!.texts).toHaveLength(1);
  });

  describe('GoApply gates', () => {
    it('with the AI consent and a live 个性化推荐 grant the person gets vectors, as GoApply', async () => {
      const k = userKit();
      expect(await embedUser({ userId: 'u1', market: 'cn' }, k.deps)).toMatchObject({ status: 'done', embedded: ['intent', 'resume'] });
      expect(k.embedCalls[0]!.brand).toBe('goapply');
      expect(k.upserts().every((u) => u.values[1] === 'cn')).toBe(true);
      expect(k.aiAllowed).toHaveBeenCalledWith('u1');
      expect(k.personalized).toHaveBeenCalledWith('u1');
    });

    it('without the AI consent: no model call, no text is built, and existing rows are deleted, with the vectors of the private imports', async () => {
      const k = userKit({ aiAllowed: false, stored: [{ kind: 'intent', model: TAG, sourceHash: 'x' }], importVectors: 2 });
      expect(await embedUser({ userId: 'u1', market: 'cn' }, k.deps)).toEqual({ status: 'deleted', reason: 'no_ai_consent', rows: 3 });
      // A private import was embedded under the AI consent: its vector goes with it.
      expect(k.importDeletes()).toHaveLength(1);
      expect(k.importDeletes()[0]!.values).toEqual(['u1', 'cn']);
      expect(k.embedCalls).toHaveLength(0);
      expect(k.loadUser).not.toHaveBeenCalled();
      expect(k.upserts()).toHaveLength(0);
      expect(k.deletes()).toHaveLength(1);
      expect(k.deletes()[0]!.text).toBe('DELETE FROM "RAUserEmbedding" WHERE "userId" = $1 AND "market" = $2');
      expect(k.deletes()[0]!.values).toEqual(['u1', 'cn']);
    });

    it('without 个性化推荐: none, and existing rows are deleted on the next run', async () => {
      const k = userKit({ personalized: false, stored: [{ kind: 'intent', model: TAG, sourceHash: 'x' }, { kind: 'resume', model: TAG, sourceHash: 'y' }] });
      expect(await embedUser({ userId: 'u1', market: 'cn' }, k.deps)).toEqual({ status: 'deleted', reason: 'no_personalization', rows: 2 });
      expect(k.embedCalls).toHaveLength(0);
      expect(k.loadUser).not.toHaveBeenCalled();
      expect(k.deletes()).toHaveLength(1);
      // The AI consent is live: the vectors of the private imports stay.
      expect(k.importDeletes()).toHaveLength(0);
    });

    it('a consent record that cannot be read is not a withdrawal: nothing is deleted or embedded, and the item fails so the queue retries', async () => {
      for (const failing of [{ aiAllowed: new Error('consent store down') }, { personalized: new Error('consent store down') }]) {
        const k = userKit({ ...failing, stored: [{ kind: 'intent', model: TAG, sourceHash: 'x' }], importVectors: 1 });
        await expect(embedUser({ userId: 'u1', market: 'cn' }, k.deps)).rejects.toThrow('consent store down');
        expect(k.deletes()).toHaveLength(0);
        expect(k.importDeletes()).toHaveLength(0);
        expect(k.embedCalls).toHaveLength(0);
        expect(k.loadUser).not.toHaveBeenCalled();
        // Through the worker: an ordinary failure (retried with backoff), not a permanent one and not a deferral.
        setRetrievalDepsForTests({ userEmbed: k.deps });
        const run = userEmbedWorker.handler(item('user.embed', { userId: 'u1', market: 'cn' }, { brand: 'goapply' }), ctx);
        await expect(run).rejects.toThrow('consent store down');
        await expect(run).rejects.not.toBeInstanceOf(PermanentWorkError);
        await expect(run).rejects.not.toBeInstanceOf(DeferWorkError);
        expect(k.deletes()).toHaveLength(0);
      }
    });

    it('the default gates are strict: they answer what the record says and throw when it cannot be read', async () => {
      const deps = defaultUserEmbedDeps();
      const types: string[][] = [];
      setConsentLookup(async (_userId, spellings) => {
        types.push(spellings as string[]);
        return { consentType: spellings[0]!, granted: true, createdAt: new Date() };
      });
      try {
        await expect(deps.aiAllowed('u1')).resolves.toBe(true);
        await expect(deps.personalized('u1')).resolves.toBe(true);
        expect(types[0]).toContain(AI_CONSENT_TYPE);
        expect(types[1]).toContain('personalized_recommendation');
        setConsentLookup(async () => ({ consentType: AI_CONSENT_TYPE, granted: false, createdAt: new Date() }));
        await expect(deps.aiAllowed('u1')).resolves.toBe(false);
        setConsentLookup(async () => null);
        await expect(deps.personalized('u1')).resolves.toBe(false);
        setConsentLookup(async () => {
          throw new Error('db down');
        });
        // Not the fail-closed `aiAllowed`: a "no" here deletes vectors.
        await expect(deps.aiAllowed('u1')).rejects.toThrow('db down');
        await expect(deps.personalized('u1')).rejects.toThrow('db down');
      } finally {
        setConsentLookup(null);
      }
    });

    it('the gate is the same function the sweep uses', async () => {
      const yes = { aiAllowed: async () => true, personalized: async () => true };
      expect(await userVectorGate('u1', 'cn', yes)).toBe('ok');
      expect(await userVectorGate('u1', 'cn', { ...yes, aiAllowed: async () => false })).toBe('no_ai_consent');
      expect(await userVectorGate('u1', 'cn', { ...yes, personalized: async () => false })).toBe('no_personalization');
      // RoboApply: none beyond the account existing.
      expect(await userVectorGate('u1', 'intl', { aiAllowed: async () => false, personalized: async () => false })).toBe('ok');
    });
  });

  it('deletes the rows of an account that is gone', async () => {
    const k = userKit({ source: null });
    expect(await embedUser({ userId: 'gone', market: 'intl' }, k.deps)).toMatchObject({ status: 'deleted', reason: 'no_account' });
    expect(k.embedCalls).toHaveLength(0);
  });

  it('with no key, or an unavailable client, writes nothing and raises no error', async () => {
    const noKey = userKit({ env: {} });
    expect(await embedUser({ userId: 'u1', market: 'intl' }, noKey.deps)).toEqual({ status: 'unavailable', reason: 'no_key' });
    expect(noKey.embedCalls).toHaveLength(0);
    const policy = userKit({ embed: { unavailable: 'policy' } });
    expect(await embedUser({ userId: 'u1', market: 'cn' }, policy.deps)).toEqual({ status: 'unavailable', reason: 'policy' });
    expect(policy.upserts()).toHaveLength(0);
  });

  it('while the market moves to another model, a vector of the model queries still use is kept as long as its text is unchanged', async () => {
    const OLD = 'old-model@1024';
    const intent = intentText(SOURCE.intent);
    const k = userKit({ queryTag: OLD, stored: [{ kind: 'intent', model: OLD, sourceHash: sourceHash(intent, OLD) }] });
    const out = await embedUser({ userId: 'u1', market: 'intl' }, k.deps);
    // The intent vector of the old model stays (queries still filter on it); the resume has no vector yet and is embedded with the new one.
    expect(out).toEqual({ status: 'done', embedded: ['resume'], unchanged: ['intent'], removed: [] });
    expect(k.upserts().map((u) => u.values.slice(2, 4))).toEqual([['resume', TAG]]);
    // After the switch (queries use the new tag) the old vector is replaced.
    const after = userKit({ queryTag: TAG, stored: [{ kind: 'intent', model: OLD, sourceHash: sourceHash(intent, OLD) }] });
    expect(await embedUser({ userId: 'u1', market: 'intl' }, after.deps)).toMatchObject({ embedded: ['intent', 'resume'] });
  });

  it('the worker refuses a bad payload and a market that is not the item brand\'s, and defers on a spent budget', async () => {
    await expect(userEmbedWorker.handler(item('user.embed', { market: 'intl' }), ctx)).rejects.toBeInstanceOf(PermanentWorkError);
    await expect(userEmbedWorker.handler(item('user.embed', { userId: 'u1', market: 'tw' }), ctx)).rejects.toBeInstanceOf(PermanentWorkError);
    // A GoApply market in a RoboApply item would embed a person under the wrong brand's rules.
    await expect(userEmbedWorker.handler(item('user.embed', { userId: 'u1', market: 'cn' }, { brand: 'roboapply' }), ctx)).rejects.toBeInstanceOf(PermanentWorkError);

    const budget = userKit({ embed: { unavailable: 'budget' } });
    setRetrievalDepsForTests({ userEmbed: budget.deps });
    await expect(userEmbedWorker.handler(item('user.embed', { userId: 'u1', market: 'intl' }), ctx)).rejects.toBeInstanceOf(DeferWorkError);

    const ok = userKit();
    setRetrievalDepsForTests({ userEmbed: ok.deps });
    await userEmbedWorker.handler(item('user.embed', { market: 'cn' }, { brand: 'goapply', userId: 'u7' }), ctx);
    expect(ok.upserts().every((u) => u.values[0] === 'u7' && u.values[1] === 'cn')).toBe(true);
  });
});

afterEach(() => setRetrievalDepsForTests({ jobIndex: null, userEmbed: null }));

describe('the default resume strip', () => {
  it("is the scorer's own stripResumeForScoring when the match area exports it, and the self-sufficient fallback otherwise", async () => {
    const match = (await import('../match/index.js')) as unknown as { stripResumeForScoring?: unknown };
    const strip = await defaultStrip();
    expect(strip).toBe(typeof match.stripResumeForScoring === 'function' ? match.stripResumeForScoring : redactResumeText);
    // Whichever it is, a sensitive-field line and a profile link never pass.
    const out = strip('Senior Engineer\n- 性别：男 | 出生年月：1995.03 | 政治面貌：中共党员 | 籍贯：湖南长沙\n- Built APIs. See https://github.com/ada-example', { names: ['Ada'] });
    expect(out).toContain('Senior Engineer');
    expect(out).not.toMatch(/性别|出生|政治面貌|中共党员|籍贯|湖南/);
    expect(out).not.toContain('github.com');
  });
});

describe('registration', () => {
  it('exports the two kinds with concurrency 4', () => {
    expect(retrievalWorkers.map((w) => w.kind)).toEqual(['job.index', 'user.embed']);
    expect(RETRIEVAL_WORK_KINDS).toEqual({ jobIndex: 'job.index', userEmbed: 'user.embed' });
    expect(retrievalWorkers.every((w) => w.concurrency === RETRIEVAL_CONCURRENCY)).toBe(true);
    expect(RETRIEVAL_CONCURRENCY).toBe(4);
  });
});

describe('loadSkillLabels', () => {
  it('answers null when the skills area is absent or does not load, never an error', async () => {
    expect(await loadSkillLabels('./no-such-module.js')).toBeNull();
  });
});
