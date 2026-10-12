// @vitest-environment node
//
// The retrieval sweep (MKT-2H item 5): limits, dedupe keys and re-runs, the model switch, consent deletion. Fakes only.
//
// The queue double keeps the real conflict rule of platform/queue/enqueue.ts: an existing item is returned untouched
// ('keep', the default), and with `onConflict: 'requeue'` a finished or dead one is put back while a queued or leased
// one is left alone. `finish` plays the drain.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import type { EmbeddingAvailability } from '../../platform/embeddings/index.js';
import { getBrand } from '../../platform/brand/registry.js';
import { createBudget, type EnqueueOptions, type EnqueuedItem } from '../../platform/queue/index.js';
import { modelTagConfigKey } from './modelTag.js';
import type { IndexStats, UserEmbeddingMeta } from './repo.js';
import { RETRIEVAL_SWEEP_LIMITS, consentCursorConfigKey, createRetrievalSweep, jobIndexBatchDedupeKey, jobIndexDedupeKey, userEmbedDedupeKey, type RetrievalSweepDeps } from './sweep.js';

const NOW = new Date('2026-10-11T08:00:00Z');
const TAG = 'openai/text-embedding-3-small@1024';
const NEW_TAG = 'openai/text-embedding-3-large@1024';
const ENV = { OPENAI_API_KEY: 'sk-test' };

type ItemStatus = 'queued' | 'leased' | 'done' | 'dead';
interface QueueItem {
  kind: string;
  payload: unknown;
  options: EnqueueOptions;
  status: ItemStatus;
  /** How often the item was put in the queue (1 = created, 2 = run again once, …). */
  queuedTimes: number;
}

function setup(
  o: {
    brand?: 'roboapply' | 'goapply';
    /** Ids the read returns: a list, or by whether vectors were asked for. */
    needing?: string[] | ((market: string, tag: string | null) => string[]);
    /** Live rows and rows per model tag (one row per job). */
    live?: number;
    withTag?: Record<string, number>;
    config?: Record<string, string>;
    env?: Record<string, string | undefined>;
    users?: string[];
    state?: Record<string, { resumeHash: string | null; searchProfileVersion: number | null }>;
    /** May throw: a consent record that cannot be read. */
    aiAllowed?: (userId: string) => boolean;
    personalized?: (userId: string) => boolean;
    embedded?: string[];
    /** Stored user vectors: model tags by user id. */
    vectors?: Record<string, string[]>;
    writable?: (carriesUserData: boolean) => EmbeddingAvailability;
    budgetMs?: number;
    failing?: Partial<Record<'jobsNeedingIndex' | 'activeUsers', boolean>>;
  } = {},
) {
  const config = new Map(Object.entries(o.config ?? {}));
  const items = new Map<string, QueueItem>();
  const deletedUserVectors: Array<[string, string]> = [];
  const deletedImportVectors: Array<[string, string]> = [];
  const vectors: Record<string, string[]> = { ...(o.vectors ?? {}) };
  const jobsNeedingIndex = vi.fn(async (market: string, tag: string | null, limit: number) => {
    if (o.failing?.jobsNeedingIndex) throw new Error('db down');
    const all = typeof o.needing === 'function' ? o.needing(market, tag) : (o.needing ?? []);
    return all.slice(0, limit);
  });
  const vectorsWritable = vi.fn(async (_brand: string, carriesUserData: boolean): Promise<EmbeddingAvailability> => (o.writable ? o.writable(carriesUserData) : 'ok'));
  const deps: RetrievalSweepDeps = {
    repo: {
      jobsNeedingIndex,
      indexStats: async (_market, tag): Promise<IndexStats> => ({ live: o.live ?? 100, missingDoc: 0, withTag: o.withTag?.[tag ?? ''] ?? 0, missingVector: 0, missingVectorChars: 0 }),
      getConfig: async (key) => config.get(key) ?? null,
      setConfig: async (key, value) => void config.set(key, value),
      embeddedUserIds: async (_market, after, limit) => (o.embedded ?? []).filter((id) => !after || id > after).slice(0, limit),
      deleteUserEmbeddings: async (userId, market) => {
        deletedUserVectors.push([userId, market]);
        const had = vectors[userId]?.length ?? 2;
        delete vectors[userId];
        return had;
      },
      deleteJobEmbeddingsOfOwner: async (userId, market) => {
        deletedImportVectors.push([userId, market]);
        return 1;
      },
      userEmbeddingMeta: async (userId): Promise<UserEmbeddingMeta[]> => (vectors[userId] ?? []).map((model) => ({ kind: 'intent', model, sourceHash: 'h' })),
    },
    enqueue: async (kind, payload, options): Promise<EnqueuedItem> => {
      const key = options.dedupeKey!;
      const existing = items.get(key);
      if (!existing) {
        items.set(key, { kind, payload, options, status: 'queued', queuedTimes: 1 });
        return { id: key, kind, status: 'queued', dedupeKey: key, created: true };
      }
      if (options.onConflict === 'requeue' && existing.status !== 'queued' && existing.status !== 'leased') {
        existing.status = 'queued';
        existing.queuedTimes += 1;
      }
      return { id: key, kind, status: existing.status, dedupeKey: key, created: false };
    },
    activeUsers: vi.fn(async (_brand, _since, limit) => {
      if (o.failing?.activeUsers) throw new Error('db down');
      return (o.users ?? []).slice(0, limit);
    }),
    userState: async (userId) => o.state?.[userId] ?? { resumeHash: `resume-${userId}`, searchProfileVersion: 1 },
    aiAllowed: async (userId) => (o.aiAllowed ? o.aiAllowed(userId) : true),
    personalized: async (userId) => (o.personalized ? o.personalized(userId) : true),
    vectorsWritable,
    env: o.env ?? ENV,
  };
  const sweep = createRetrievalSweep(async () => deps);
  const ctx = { brand: getBrand(o.brand ?? 'roboapply'), budget: createBudget(o.budgetMs ?? 240_000), now: NOW };
  const all = () => [...items.values()];
  const jobItems = () => all().filter((e) => e.kind === 'job.index');
  const userItems = () => all().filter((e) => e.kind === 'user.embed');
  /** The drain ran: every waiting item ends in `status`. */
  const finish = (status: ItemStatus = 'done', kind?: string) => {
    for (const item of all()) if (item.status === 'queued' && (!kind || item.kind === kind)) item.status = status;
  };
  return { sweep, ctx, deps, items, deletedUserVectors, deletedImportVectors, vectors, config, jobsNeedingIndex, vectorsWritable, jobItems, userItems, finish };
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `job_${String(i).padStart(4, '0')}`);
const jobIdsOf = (item: QueueItem): string[] => (item.payload as { jobIds: string[] }).jobIds;

describe('retrieval sweep: postings', () => {
  it('queues nothing when every live row is indexed with the current model', async () => {
    const s = setup({ needing: [] });
    const out = await s.sweep(s.ctx);
    expect(out).toMatchObject({ jobBatches: 0, jobsQueued: 0, usersQueued: 0 });
    expect(s.items.size).toBe(0);
  });

  it('queues job.index items of 96 ids each, at most 10 a run', async () => {
    const s = setup({ needing: ids(2000) });
    const out = await s.sweep(s.ctx);
    expect(s.jobsNeedingIndex).toHaveBeenCalledWith('intl', TAG, 960);
    expect(out).toMatchObject({ jobBatches: 10, jobsQueued: 960 });
    expect(out.jobVectors).toBeUndefined();
    expect(s.jobItems()).toHaveLength(10);
    expect(s.jobItems().every((e) => jobIdsOf(e).length === 96)).toBe(true);
    expect(s.jobItems()[0]!.options).toMatchObject({ brand: 'roboapply' });
    expect(RETRIEVAL_SWEEP_LIMITS).toMatchObject({ jobsPerRun: 960, batchSize: 96, maxBatches: 10, activeDays: 7 });
  });

  it('keeps a short last batch, dedupes by the ids and the model tag, and never doubles an item that is still waiting or running', async () => {
    const s = setup({ needing: ids(100) });
    await s.sweep(s.ctx);
    expect(s.jobItems().map((e) => jobIdsOf(e).length)).toEqual([96, 4]);
    expect(s.jobItems()[0]!.options.dedupeKey).toBe(jobIndexBatchDedupeKey(ids(100).slice(0, 96), TAG));
    // A second run while the items wait, and a third while they run: the same two items, queued once each.
    await s.sweep(s.ctx);
    for (const item of s.jobItems()) item.status = 'leased';
    await s.sweep(s.ctx);
    expect(s.jobItems()).toHaveLength(2);
    expect(s.jobItems().map((e) => e.queuedTimes)).toEqual([1, 1]);
    expect(s.jobItems().map((e) => e.status)).toEqual(['leased', 'leased']);
  });

  it('queues the same rows again when their item finished without vectors (the client was unavailable when it ran)', async () => {
    // The worker ends such an item "done" (workers.ts: budget spent, policy, no key at that moment); the rows still lack a vector.
    const s = setup({ needing: ids(300) });
    expect(await s.sweep(s.ctx)).toMatchObject({ jobBatches: 4, jobsQueued: 300 });
    s.finish('done');
    const again = await s.sweep(s.ctx);
    expect(again).toMatchObject({ jobBatches: 4, jobsQueued: 300 });
    expect(s.jobItems()).toHaveLength(4);
    expect(s.jobItems().every((e) => e.status === 'queued' && e.queuedTimes === 2)).toBe(true);
  });

  it('queues the same rows again when their item died in an outage', async () => {
    const s = setup({ needing: ids(96) });
    await s.sweep(s.ctx);
    s.finish('dead');
    expect(await s.sweep(s.ctx)).toMatchObject({ jobBatches: 1, jobsQueued: 96 });
    expect(s.jobItems()[0]).toMatchObject({ status: 'queued', queuedTimes: 2 });
  });

  it('the batch key does not depend on the order of the ids and moves with the model', () => {
    expect(jobIndexBatchDedupeKey(['b', 'a'], TAG)).toBe(jobIndexBatchDedupeKey(['a', 'b'], TAG));
    expect(jobIndexBatchDedupeKey(['a', 'b'], TAG)).not.toBe(jobIndexBatchDedupeKey(['a', 'b'], NEW_TAG));
    expect(jobIndexBatchDedupeKey(['a', 'b'], TAG)).not.toBe(jobIndexBatchDedupeKey(['a', 'b'], null));
    expect(jobIndexBatchDedupeKey(['a'], TAG)).toMatch(/^job\.index\.batch:[0-9a-f]{40}$/);
    expect(jobIndexDedupeKey('job_1', new Date(1_700_000_000_000))).toBe('job.index:job_1:1700000000000');
    expect(jobIndexDedupeKey('job_1', null)).toBe('job.index:job_1:0');
  });

  it('with no embedding key still queues the rows that lack a search document, and asks nobody whether vectors can be written', async () => {
    const s = setup({ needing: ids(5), env: {} });
    const out = await s.sweep(s.ctx);
    expect(s.jobsNeedingIndex).toHaveBeenCalledWith('intl', null, 960);
    expect(out).toMatchObject({ jobBatches: 1, jobsQueued: 5, usersQueued: 0, jobVectors: 'no_key', userVectors: 'no_key', model: { writeTag: null } });
    expect(s.userItems()).toHaveLength(0);
    expect(s.vectorsWritable).not.toHaveBeenCalled();
  });

  it('runs for the market of the cron brand only', async () => {
    const s = setup({ brand: 'goapply', needing: ids(3) });
    await s.sweep(s.ctx);
    expect(s.jobsNeedingIndex).toHaveBeenCalledWith('cn', TAG, 960);
    expect(s.vectorsWritable).toHaveBeenCalledWith('goapply', false);
    expect(s.jobItems()[0]!.options.brand).toBe('goapply');
  });
});

describe('retrieval sweep: a market whose vectors cannot be written', () => {
  // 5,000 live rows have a search document and no vector; 1,500 OLDER rows have neither.
  const lackVector = ids(5000);
  const lackDocument = Array.from({ length: 1500 }, (_, i) => `old_${String(i).padStart(4, '0')}`);
  /** The repository's read: rows that lack the lexical part come first; rows that only lack a vector only when a tag is given. */
  const read = (done: Set<string>) => (_market: string, tag: string | null) => [...lackDocument.filter((id) => !done.has(id)), ...(tag ? lackVector : [])];

  it.each([
    ['the route policy refuses the endpoint (GoApply behind CN_LLM_DOMESTIC_ONLY on the shared endpoint)', 'policy'],
    ['the daily budget is 0 or spent', 'budget'],
  ] as const)('%s: search documents are still written for every row, past the first 960', async (_name, reason) => {
    const done = new Set<string>();
    const s = setup({ brand: 'goapply', needing: read(done), writable: () => reason });
    const seen = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      const out = await s.sweep(s.ctx);
      expect(out.jobVectors).toBe(reason);
      // Vectors were not asked for, so rows that cannot get one never fill the window.
      expect(s.jobsNeedingIndex).toHaveBeenLastCalledWith('cn', null, 960);
      for (const item of s.jobItems().filter((e) => e.status === 'queued')) for (const id of jobIdsOf(item)) seen.add(id);
      // The drain writes the search documents of what was queued.
      for (const id of seen) done.add(id);
      s.finish('done');
    }
    expect(seen.size).toBe(1500);
    expect([...seen].every((id) => id.startsWith('old_'))).toBe(true);
    // Nothing left to do: the next run queues nothing and puts no finished item back.
    const queuedBefore = s.jobItems().reduce((n, e) => n + e.queuedTimes, 0);
    expect(await s.sweep(s.ctx)).toMatchObject({ jobBatches: 0, jobsQueued: 0 });
    expect(s.jobItems().reduce((n, e) => n + e.queuedTimes, 0)).toBe(queuedBefore);
  });

  it('asks for vectors again as soon as they can be written', async () => {
    let reason: EmbeddingAvailability = 'budget';
    const s = setup({ needing: (_m, tag) => (tag ? ids(96) : []), writable: () => reason });
    expect(await s.sweep(s.ctx)).toMatchObject({ jobBatches: 0, jobVectors: 'budget' });
    reason = 'ok';
    const out = await s.sweep(s.ctx);
    expect(s.jobsNeedingIndex).toHaveBeenLastCalledWith('intl', TAG, 960);
    expect(out).toMatchObject({ jobBatches: 1, jobsQueued: 96 });
    expect(out.jobVectors).toBeUndefined();
  });

  it('asks for vectors when the availability read itself fails (the worker then decides)', async () => {
    const s = setup({ needing: ids(10) });
    s.vectorsWritable.mockRejectedValue(new Error('counter unreadable'));
    const out = await s.sweep(s.ctx);
    expect(s.jobsNeedingIndex).toHaveBeenCalledWith('intl', TAG, 960);
    expect(out).toMatchObject({ jobBatches: 1, jobsQueued: 10 });
    expect(out.failed).toBeUndefined();
  });

  it('queues no person while user text cannot be embedded (RoboApply never sends it to a mainland endpoint)', async () => {
    const s = setup({ users: ['u1', 'u2'], needing: ids(3), writable: (carriesUserData) => (carriesUserData ? 'policy' : 'ok') });
    const out = await s.sweep(s.ctx);
    expect(out).toMatchObject({ usersQueued: 0, userVectors: 'policy', jobBatches: 1 });
    expect(out.jobVectors).toBeUndefined();
    expect(s.userItems()).toHaveLength(0);
    expect(s.deps.activeUsers).not.toHaveBeenCalled();
  });
});

describe('retrieval sweep: the model switch', () => {
  const env = { ...ENV, EMBED_MODEL: 'openai/text-embedding-3-large' };
  const stored = { [modelTagConfigKey('intl')]: TAG };

  it('re-embeds the market gradually and keeps the query tag while the previous model still covers more rows', async () => {
    const s = setup({ env, config: stored, live: 1000, withTag: { [NEW_TAG]: 300, [TAG]: 700 }, needing: ids(2000) });
    const out = await s.sweep(s.ctx);
    expect(out.model).toEqual({ writeTag: NEW_TAG, queryTag: TAG, switched: false, coverage: 0.3, previousCoverage: 0.7 });
    expect(s.config.get(modelTagConfigKey('intl'))).toBe(TAG);
    // 960 rows a run, with the new tag.
    expect(s.jobsNeedingIndex).toHaveBeenCalledWith('intl', NEW_TAG, 960);
    expect(out.jobsQueued).toBe(960);
  });

  it('moves the query tag at the crossover: one row per job, so the previous model has lost the rows the new one gained', async () => {
    const s = setup({ env, config: stored, live: 1000, withTag: { [NEW_TAG]: 500, [TAG]: 500 } });
    const out = await s.sweep(s.ctx);
    expect(out.model).toMatchObject({ queryTag: NEW_TAG, switched: true, coverage: 0.5, previousCoverage: 0.5 });
    expect(s.config.get(modelTagConfigKey('intl'))).toBe(NEW_TAG);
  });

  it('queues no person while the market is between two models, and queues them after the switch', async () => {
    const between = setup({ env, config: stored, live: 1000, withTag: { [NEW_TAG]: 300, [TAG]: 700 }, users: ['u1', 'u2'] });
    expect(await between.sweep(between.ctx)).toMatchObject({ usersQueued: 0, userVectors: 'between_models' });
    const after = setup({ env, config: stored, live: 1000, withTag: { [NEW_TAG]: 600, [TAG]: 400 }, users: ['u1', 'u2'] });
    expect((await after.sweep(after.ctx)).usersQueued).toBe(2);
  });
});

describe('retrieval sweep: people', () => {
  it('queues user.embed for people active in the last 7 days, deduped by person, hashes and model tag', async () => {
    const s = setup({ users: ['u1', 'u2'] });
    const out = await s.sweep(s.ctx);
    expect(out.usersQueued).toBe(2);
    expect(s.deps.activeUsers).toHaveBeenCalledWith('roboapply', new Date(NOW.getTime() - 7 * 86_400_000), 200);
    expect(s.vectorsWritable).toHaveBeenCalledWith('roboapply', true);
    expect(s.userItems()[0]).toMatchObject({ payload: { userId: 'u1', market: 'intl' }, options: { userId: 'u1', brand: 'roboapply' } });
    expect(s.userItems()[0]!.options.dedupeKey).toBe(userEmbedDedupeKey('u1', 'intl', { resumeHash: 'resume-u1', searchProfileVersion: 1 }, TAG));
    // The items ran and wrote the vectors: an unchanged person is never queued again.
    s.finish('done');
    s.vectors.u1 = [TAG];
    s.vectors.u2 = [TAG];
    expect((await s.sweep(s.ctx)).usersQueued).toBe(0);
    expect(s.userItems().map((e) => [e.status, e.queuedTimes])).toEqual([['done', 1], ['done', 1]]);
  });

  it('queues a person again when the resume hash or the search-profile version changed', () => {
    const base = userEmbedDedupeKey('u1', 'intl', { resumeHash: 'a', searchProfileVersion: 1 }, TAG);
    expect(userEmbedDedupeKey('u1', 'intl', { resumeHash: 'b', searchProfileVersion: 1 }, TAG)).not.toBe(base);
    expect(userEmbedDedupeKey('u1', 'intl', { resumeHash: 'a', searchProfileVersion: 2 }, TAG)).not.toBe(base);
    expect(userEmbedDedupeKey('u1', 'intl', { resumeHash: 'a', searchProfileVersion: 1 }, NEW_TAG)).not.toBe(base);
    expect(userEmbedDedupeKey('u1', 'cn', { resumeHash: 'a', searchProfileVersion: 1 }, TAG)).not.toBe(base);
    expect(base).toMatch(/^user\.embed:u1:intl:[0-9a-f]{16}$/);
  });

  it('runs the item of an unchanged person again when they have no vector of the current model', async () => {
    // u_dead: the item died in an outage. u_back: withdrew a consent (vectors deleted) and granted it again. u_old: vector of another model.
    const s = setup({ users: ['u_dead', 'u_back', 'u_old', 'u_fine'], vectors: { u_old: [NEW_TAG], u_fine: [TAG] } });
    await s.sweep(s.ctx);
    s.finish('done');
    s.userItems().find((e) => e.options.userId === 'u_dead')!.status = 'dead';
    const out = await s.sweep(s.ctx);
    expect(out.usersQueued).toBe(3);
    const byUser = Object.fromEntries(s.userItems().map((e) => [e.options.userId, [e.status, e.queuedTimes]]));
    expect(byUser).toEqual({ u_dead: ['queued', 2], u_back: ['queued', 2], u_old: ['queued', 2], u_fine: ['done', 1] });
  });

  it('GoApply: queues only people with the AI consent and a live 个性化推荐 grant', async () => {
    const s = setup({ brand: 'goapply', users: ['u_ok', 'u_no_ai', 'u_no_rec'], aiAllowed: (u) => u !== 'u_no_ai', personalized: (u) => u !== 'u_no_rec' });
    const out = await s.sweep(s.ctx);
    expect(out.usersQueued).toBe(1);
    expect(s.userItems().map((e) => (e.payload as { userId: string }).userId)).toEqual(['u_ok']);
  });

  it('GoApply: a consent record that cannot be read queues nobody for that person (no definite yes), and the others still run', async () => {
    const s = setup({
      brand: 'goapply',
      users: ['u_err', 'u_ok'],
      aiAllowed: (u) => {
        if (u === 'u_err') throw new Error('consent store down');
        return true;
      },
    });
    const out = await s.sweep(s.ctx);
    expect(out.usersQueued).toBe(1);
    expect(s.userItems().map((e) => e.options.userId)).toEqual(['u_ok']);
    expect(s.deletedUserVectors).toEqual([]);
  });

  it('goes on with the next person when one cannot be read', async () => {
    const s = setup({ users: ['u1', 'u2'] });
    s.deps.userState = async (userId) => {
      if (userId === 'u1') throw new Error('profile missing');
      return { resumeHash: 'r', searchProfileVersion: 1 };
    };
    expect((await s.sweep(s.ctx)).usersQueued).toBe(1);
  });
});

describe('retrieval sweep: consent (GoApply)', () => {
  it('deletes the vectors of people without a live grant, and of nobody else', async () => {
    const s = setup({ brand: 'goapply', embedded: ['u_a', 'u_b', 'u_c'], aiAllowed: (u) => u !== 'u_a', personalized: (u) => u !== 'u_c' });
    const out = await s.sweep(s.ctx);
    expect(out.vectorsRemovedFor).toBe(2);
    expect(s.deletedUserVectors).toEqual([['u_a', 'cn'], ['u_c', 'cn']]);
  });

  it('with the AI consent gone also deletes the vectors of the private imports; without 个性化推荐 only the person vectors', async () => {
    const s = setup({ brand: 'goapply', embedded: ['u_no_ai', 'u_no_rec'], aiAllowed: (u) => u !== 'u_no_ai', personalized: (u) => u !== 'u_no_rec' });
    await s.sweep(s.ctx);
    expect(s.deletedUserVectors).toEqual([['u_no_ai', 'cn'], ['u_no_rec', 'cn']]);
    // The import was embedded under the AI consent alone: the recommendation grant does not touch it.
    expect(s.deletedImportVectors).toEqual([['u_no_ai', 'cn']]);
  });

  it('a failed consent read is not a withdrawal: nothing is deleted, the walk stops there and the step is reported', async () => {
    const s = setup({
      brand: 'goapply',
      embedded: ['u_a', 'u_b', 'u_c'],
      aiAllowed: (u) => {
        if (u === 'u_b') throw new Error('consent store down');
        return true;
      },
    });
    const out = await s.sweep(s.ctx);
    expect(s.deletedUserVectors).toEqual([]);
    expect(s.deletedImportVectors).toEqual([]);
    expect(out.vectorsRemovedFor).toBe(0);
    expect(out.failed).toEqual(['consent']);
    // u_a was read; the next run starts at u_b again.
    expect(s.config.get(consentCursorConfigKey('cn'))).toBe('u_a');
  });

  it('a whole run of failed reads deletes nothing (a short database fault)', async () => {
    const s = setup({
      brand: 'goapply',
      embedded: ['u_a', 'u_b'],
      users: ['u_a', 'u_b'],
      vectors: { u_a: [TAG], u_b: [TAG] },
      aiAllowed: () => {
        throw new Error('db down');
      },
    });
    const out = await s.sweep(s.ctx);
    expect(s.deletedUserVectors).toEqual([]);
    expect(s.vectors).toEqual({ u_a: [TAG], u_b: [TAG] });
    expect(out).toMatchObject({ usersQueued: 0, vectorsRemovedFor: 0, failed: ['consent'] });
    expect(s.config.has(consentCursorConfigKey('cn'))).toBe(false);
  });

  it('walks the people who have vectors in windows and starts again at the end', async () => {
    const many = Array.from({ length: 450 }, (_, i) => `u_${String(i).padStart(3, '0')}`);
    const s = setup({ brand: 'goapply', embedded: many, aiAllowed: () => true });
    await s.sweep(s.ctx);
    expect(s.config.get(consentCursorConfigKey('cn'))).toBe('u_199');
    await s.sweep(s.ctx);
    expect(s.config.get(consentCursorConfigKey('cn'))).toBe('u_399');
    await s.sweep(s.ctx);
    // The last, short window: the cursor is cleared so the next run starts from the first person.
    expect(s.config.get(consentCursorConfigKey('cn'))).toBe('');
  });

  it('RoboApply has no consent step', async () => {
    const s = setup({ embedded: ['u_a'], aiAllowed: () => false });
    const out = await s.sweep(s.ctx);
    expect(out.vectorsRemovedFor).toBeUndefined();
    expect(s.deletedUserVectors).toEqual([]);
  });
});

describe('retrieval sweep: time and failures', () => {
  it('does nothing when the time budget is gone', async () => {
    const s = setup({ needing: ids(10), users: ['u1'], budgetMs: 1_000 });
    expect(await s.sweep(s.ctx)).toEqual({ skipped: 'no_time' });
    expect(s.items.size).toBe(0);
  });

  it('a failing step is reported and the others still run', async () => {
    const s = setup({ needing: ids(5), users: ['u1'], failing: { jobsNeedingIndex: true } });
    const out = await s.sweep(s.ctx);
    expect(out.failed).toEqual(['jobs']);
    expect(out.usersQueued).toBe(1);
  });
});
