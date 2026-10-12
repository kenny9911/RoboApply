// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getCurrentBrandId, runWithBrand } from '../../lib/requestContext.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import {
  BACKOFF_BASE_MS,
  DeferWorkError,
  LEASE_MS,
  PermanentWorkError,
  backoffMs,
  createBudget,
  drain,
  enqueue,
  enqueueMany,
  kickDrain,
  leaseWorkItems,
  notImplementedCron,
  pruneWorkItems,
  registerWorker,
  registerWorkers,
  registeredKinds,
  resetWorkerRegistryForTests,
  retryDeadItem,
  runForBudget,
  type QueueDb,
} from './index.js';
import { BRANDS } from '../brand/registry.js';
import { setUserBrandLookup } from '../brand/userBrand.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const OWNER = 'test-owner';

type Row = Record<string, unknown>;

/** A fake DB whose lease query returns the queued rows it is given (marked leased, as the SQL would). */
function queueDb(batches: Row[][], extra: { seed?: Row[] } = {}) {
  const pending = batches.map((b) => b.map((r) => ({ ...r })));
  const fake = createFakePrisma({
    seed: { rAWorkItem: extra.seed ?? [] },
    uniqueFields: { rAWorkItem: ['dedupeKey'] },
    sql: {
      respond: (call) => {
        if (!call.text.includes('FOR UPDATE SKIP LOCKED')) return undefined;
        const batch = pending.shift() ?? [];
        for (const r of batch) {
          const row = { ...r, status: 'leased', leaseOwner: OWNER, attempts: Number(r.attempts ?? 0) + 1 };
          fake.$rows('rAWorkItem').push(row);
        }
        return batch.map((r) => ({
          id: r.id,
          kind: r.kind,
          brand: r.brand ?? null,
          userId: r.userId ?? null,
          payload: r.payload ?? {},
          attempts: Number(r.attempts ?? 0) + 1,
          maxAttempts: r.maxAttempts ?? 5,
          dedupeKey: r.dedupeKey ?? null,
          priority: r.priority ?? 100,
        }));
      },
    },
  });
  return fake;
}

const asDb = (f: unknown) => f as QueueDb;
const fixedClock = () => NOW.getTime();

afterEach(() => {
  resetWorkerRegistryForTests();
  vi.useRealTimers();
});

describe('leaseWorkItems', () => {
  it('leases with FOR UPDATE SKIP LOCKED, a 5-minute lease and only registered kinds/brands', async () => {
    const db = queueDb([[]]);
    await leaseWorkItems({ kinds: ['job.enrich'], brands: ['roboapply'], limit: 4, owner: OWNER, now: NOW, db: asDb(db) });
    const call = db.$sql.last()!;
    expect(call.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(call.text).toMatch(/WITH picked AS \( SELECT id FROM "RAWorkItem"/);
    expect(call.text).toContain(`(status = 'queued' AND "runAfter" <= $`);
    expect(call.text).toContain(`(status = 'leased' AND "leasedUntil" < $`);
    expect(call.text).toContain('ORDER BY priority ASC, "runAfter" ASC');
    expect(call.text).toContain('attempts = w.attempts + 1');
    expect(call.values).toEqual(
      expect.arrayContaining([['job.enrich'], ['roboapply'], true, NOW, 4, OWNER, new Date(NOW.getTime() + LEASE_MS)]),
    );
  });

  it('does not query at all with no kinds or brands', async () => {
    const db = queueDb([]);
    expect(await leaseWorkItems({ kinds: [], brands: ['roboapply'], limit: 4, owner: OWNER, now: NOW, db: asDb(db) })).toEqual([]);
    expect(await leaseWorkItems({ kinds: ['a.b'], brands: [], limit: 4, owner: OWNER, now: NOW, db: asDb(db) })).toEqual([]);
    expect(db.$sql.calls).toHaveLength(0);
  });

  it('claims unbranded rows only when the deployment serves the default brand', async () => {
    const db = queueDb([[]]);
    await leaseWorkItems({ kinds: ['a.b'], brands: ['goapply'], limit: 1, owner: OWNER, now: NOW, db: asDb(db) });
    expect(db.$sql.last()!.values).toContain(false);
  });
});

describe('drain', () => {
  it('returns at once without touching the database when no worker is registered', async () => {
    const db = queueDb([]);
    const result = await drain(null, { db: asDb(db), brands: ['roboapply'] });
    expect(result.stoppedBy).toBe('no_handlers');
    expect(db.$sql.calls).toHaveLength(0);
  });

  it('costs one query when the queue is empty', async () => {
    registerWorker({ kind: 'job.enrich', handler: async () => undefined });
    const db = queueDb([[]]);
    const started = Date.now();
    const result = await drain(['job.enrich'], { db: asDb(db), brands: ['roboapply'], owner: OWNER });
    expect(result).toMatchObject({ stoppedBy: 'empty', leased: 0 });
    expect(db.$sql.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('runs each item inside its brand and marks it done', async () => {
    const seen: Array<{ brand: string | undefined; payload: unknown }> = [];
    registerWorker({
      kind: 'job.enrich',
      handler: async (item) => {
        seen.push({ brand: getCurrentBrandId(), payload: item.payload });
      },
    });
    const db = queueDb([
      [
        { id: 'w1', kind: 'job.enrich', brand: 'goapply', payload: { jobId: 'j1' } },
        { id: 'w2', kind: 'job.enrich', brand: 'roboapply', payload: { jobId: 'j2' } },
      ],
      [],
    ]);
    const result = await drain(['job.enrich'], { db: asDb(db), brands: ['roboapply', 'goapply'], owner: OWNER, now: fixedClock });
    expect(result).toMatchObject({ leased: 2, done: 2, batches: 1, stoppedBy: 'empty' });
    expect(seen).toEqual([
      { brand: 'goapply', payload: { jobId: 'j1' } },
      { brand: 'roboapply', payload: { jobId: 'j2' } },
    ]);
    expect(db.$rows('rAWorkItem').map((r) => r.status)).toEqual(['done', 'done']);
  });

  it('retries a failure with exponential backoff', async () => {
    registerWorker({
      kind: 'job.score',
      handler: async () => {
        throw new Error('provider 502');
      },
    });
    const db = queueDb([[{ id: 'w1', kind: 'job.score', brand: 'roboapply', attempts: 1, maxAttempts: 5 }], []]);
    const result = await drain(['job.score'], { db: asDb(db), brands: ['roboapply'], owner: OWNER, now: fixedClock });
    expect(result).toMatchObject({ retried: 1, dead: 0 });
    const row = db.$rows('rAWorkItem')[0]!;
    // This run was attempt 2 → next try after base × 2.
    expect(row).toMatchObject({ status: 'queued', leaseOwner: null, lastError: 'Error: provider 502' });
    expect((row.runAfter as Date).getTime()).toBe(NOW.getTime() + 2 * BACKOFF_BASE_MS);
  });

  it('marks an item dead after maxAttempts, and at once on PermanentWorkError', async () => {
    registerWorkers([
      { kind: 'a.fail', handler: async () => Promise.reject(new Error('still broken')) },
      { kind: 'a.perm', handler: async () => Promise.reject(new PermanentWorkError('bad payload')) },
    ]);
    const db = queueDb([
      [
        { id: 'last', kind: 'a.fail', brand: 'roboapply', attempts: 4, maxAttempts: 5 },
        { id: 'perm', kind: 'a.perm', brand: 'roboapply', attempts: 0, maxAttempts: 5 },
      ],
      [],
    ]);
    const result = await drain(null, { db: asDb(db), brands: ['roboapply'], owner: OWNER, now: fixedClock });
    expect(result).toMatchObject({ dead: 2, retried: 0 });
    expect(db.$rows('rAWorkItem').map((r) => [r.id, r.status])).toEqual([
      ['last', 'dead'],
      ['perm', 'dead'],
    ]);
  });

  it('DeferWorkError requeues without spending an attempt', async () => {
    registerWorker({ kind: 'a.defer', handler: async () => Promise.reject(new DeferWorkError(60_000, 'budget spent')) });
    const db = queueDb([[{ id: 'd', kind: 'a.defer', brand: 'roboapply', attempts: 2 }], []]);
    const result = await drain(['a.defer'], { db: asDb(db), brands: ['roboapply'], owner: OWNER, now: fixedClock });
    expect(result.deferred).toBe(1);
    const row = db.$rows('rAWorkItem')[0]!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(2); // leased as 3, decremented back
    expect((row.runAfter as Date).getTime()).toBe(NOW.getTime() + 60_000);
  });

  it('never overwrites an item whose lease was taken by another drain', async () => {
    registerWorker({ kind: 'a.slow', handler: async () => undefined });
    const db = queueDb([[{ id: 'x', kind: 'a.slow', brand: 'roboapply' }], []]);
    // Another drain took the lease while ours ran.
    const original = db.rAWorkItem.updateMany;
    db.rAWorkItem.updateMany = async (args) => {
      db.$rows('rAWorkItem')[0]!.leaseOwner = 'someone-else';
      return original(args);
    };
    const result = await drain(['a.slow'], { db: asDb(db), brands: ['roboapply'], owner: OWNER, now: fixedClock });
    expect(result).toMatchObject({ lost: 1, done: 0 });
    expect(db.$rows('rAWorkItem')[0]!.status).toBe('leased');
  });

  it('stops leasing when the budget is spent', async () => {
    let t = NOW.getTime();
    registerWorker({
      kind: 'a.work',
      handler: async () => {
        t += 30_000;
      },
    });
    const batches = Array.from({ length: 50 }, (_, i) => [{ id: `i${i}`, kind: 'a.work', brand: 'roboapply' }]);
    const db = queueDb(batches);
    const result = await drain(['a.work'], {
      db: asDb(db),
      brands: ['roboapply'],
      owner: OWNER,
      concurrency: 1,
      budgetMs: 240_000,
      reserveMs: 15_000,
      now: () => t,
    });
    expect(result.stoppedBy).toBe('budget');
    expect(result.done).toBe(8); // 7 × 30 s leaves 30 s > 15 s reserve; the 8th leaves 0.
  });

  it('backoff doubles and is capped', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(30)).toBe(6 * 60 * 60_000);
  });
});

describe('enqueue', () => {
  it('stamps the current brand and is idempotent per dedupe key', async () => {
    const db = createFakePrisma({ uniqueFields: { rAWorkItem: ['dedupeKey'] }, defaults: { rAWorkItem: { status: 'queued', attempts: 0 } } });
    const first = await runWithBrand('goapply', () =>
      enqueue('job.enrich', { jobId: 'j1' }, { dedupeKey: 'job.enrich:j1:v3', db: asDb(db) }),
    );
    const second = await enqueue('job.enrich', { jobId: 'j1' }, { dedupeKey: 'job.enrich:j1:v3', db: asDb(db), brand: 'roboapply' });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ id: first.id, created: false, status: 'queued' });
    expect(db.$rows('rAWorkItem')).toHaveLength(1);
    expect(db.$rows('rAWorkItem')[0]).toMatchObject({ brand: 'goapply', kind: 'job.enrich', priority: 100, maxAttempts: 5 });
  });

  it("requeues a finished item with onConflict 'requeue', never a leased one", async () => {
    const db = createFakePrisma({
      seed: {
        rAWorkItem: [
          { id: 'done1', kind: 'seo.rebuild', status: 'done', dedupeKey: 'seo:a', attempts: 3 },
          { id: 'busy', kind: 'seo.rebuild', status: 'leased', dedupeKey: 'seo:b', attempts: 1 },
        ],
      },
    });
    const a = await enqueue('seo.rebuild', { page: 'a' }, { dedupeKey: 'seo:a', onConflict: 'requeue', db: asDb(db), brand: 'roboapply' });
    const b = await enqueue('seo.rebuild', { page: 'b' }, { dedupeKey: 'seo:b', onConflict: 'requeue', db: asDb(db), brand: 'roboapply' });
    expect(a.status).toBe('queued');
    expect(db.$rows('rAWorkItem')[0]).toMatchObject({ status: 'queued', attempts: 0, payload: { page: 'a' } });
    expect(b.status).toBe('leased');
    expect(db.$rows('rAWorkItem')[1]).toMatchObject({ status: 'leased', attempts: 1 });
  });

  it('rejects malformed kinds and supports delays and bulk inserts', async () => {
    const db = createFakePrisma({ uniqueFields: { rAWorkItem: ['dedupeKey'] } });
    await expect(enqueue('Bad Kind', {}, { db: asDb(db) })).rejects.toThrow(/invalid work kind/);
    await enqueue('email.send', { template: 'x' }, { db: asDb(db), delayMs: 1000, now: () => NOW, brand: 'roboapply' });
    expect((db.$rows('rAWorkItem')[0]!.runAfter as Date).getTime()).toBe(NOW.getTime() + 1000);
    const { inserted } = await enqueueMany(
      [
        { kind: 'email.send', payload: { n: 1 }, options: { dedupeKey: 'k1', brand: 'roboapply' } },
        { kind: 'email.send', payload: { n: 2 }, options: { dedupeKey: 'k1', brand: 'roboapply' } },
      ],
      { db: asDb(db) },
    );
    expect(inserted).toBe(1);
  });
});

describe('enqueue outside a brand context', () => {
  afterEach(() => setUserBrandLookup(null));

  it("a user's item takes the stored User.brand, never the default brand", async () => {
    setUserBrandLookup(async (userId) => (userId === 'go_user' ? 'goapply' : userId === 'robo_user' ? 'roboapply' : null));
    const db = createFakePrisma({ uniqueFields: { rAWorkItem: ['dedupeKey'] } });
    expect(getCurrentBrandId()).toBeUndefined();
    await enqueue('resume.parse', { r: 1 }, { db: asDb(db), userId: 'go_user' });
    await enqueueMany([{ kind: 'resume.parse', payload: { r: 2 }, options: { userId: 'go_user' } }], { db: asDb(db) });
    await enqueue('resume.parse', { r: 3 }, { db: asDb(db), userId: 'robo_user' });
    await enqueue('seo.rebuild', { page: 'x' }, { db: asDb(db) }); // unowned system work
    expect(db.$rows('rAWorkItem').map((r) => r.brand)).toEqual(['goapply', 'goapply', 'roboapply', 'roboapply']);
    // A context or an explicit brand still wins (no lookup).
    await runWithBrand('goapply', () => enqueue('resume.parse', { r: 4 }, { db: asDb(db), userId: 'robo_user' }));
    expect(db.$rows('rAWorkItem')[4]!.brand).toBe('goapply');
  });

  it('refuses a user item whose brand cannot be established', async () => {
    setUserBrandLookup(async () => null);
    const db = createFakePrisma({ uniqueFields: { rAWorkItem: ['dedupeKey'] } });
    await expect(enqueue('resume.parse', {}, { db: asDb(db), userId: 'ghost' })).rejects.toThrow(/without a brand/);
    expect(db.$rows('rAWorkItem')).toHaveLength(0);
  });
});

describe('maintenance', () => {
  it('prunes old settled items and retries dead ones', async () => {
    const old = new Date(NOW.getTime() - 40 * 86_400_000);
    const db = createFakePrisma({
      seed: {
        rAWorkItem: [
          { id: 'd1', status: 'done', updatedAt: old },
          { id: 'x1', status: 'dead', updatedAt: old },
          { id: 'q1', status: 'queued', updatedAt: old },
          { id: 'd2', status: 'done', updatedAt: NOW },
        ],
      },
    });
    expect(await pruneWorkItems({ db: asDb(db), now: NOW })).toEqual({ deleted: 2 });
    expect(db.$rows('rAWorkItem').map((r) => r.id)).toEqual(['q1', 'd2']);
    const db2 = createFakePrisma({ seed: { rAWorkItem: [{ id: 'x', status: 'dead', attempts: 5 }] } });
    expect(await retryDeadItem('x', { db: asDb(db2), now: NOW })).toBe(true);
    expect(db2.$rows('rAWorkItem')[0]).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('kickDrain never throws', async () => {
    registerWorker({ kind: 'a.kick', handler: async () => undefined });
    const broken = { $queryRaw: async () => Promise.reject(new Error('db down')) };
    await expect(kickDrain(['a.kick'], { db: broken as unknown as QueueDb, brands: ['roboapply'] })).resolves.toBeNull();
    expect(registeredKinds()).toEqual(['a.kick']);
  });

  it('refuses a second, different handler for the same kind', () => {
    registerWorker({ kind: 'a.one', handler: async () => undefined });
    expect(() => registerWorker({ kind: 'a.one', handler: async () => undefined })).toThrow(/already registered/);
  });
});

describe('runForBudget', () => {
  it('stops at the budget', async () => {
    let t = 0;
    const result = await runForBudget(
      async () => {
        t += 50_000;
        return { processed: 1 };
      },
      { budgetMs: 240_000, reserveMs: 2_000, now: () => t },
    );
    expect(result.stoppedBy).toBe('budget');
    expect(result.steps).toBe(5);
    expect(result.processed).toBe(5);
  });

  it('stops when a step reports no more work, and honours maxSteps', async () => {
    let calls = 0;
    expect(
      await runForBudget(async () => {
        calls += 1;
        return calls < 3 ? { processed: 2 } : { processed: 0 };
      }),
    ).toMatchObject({ stoppedBy: 'idle', steps: 3, processed: 4 });
    expect(await runForBudget(async () => ({ processed: 1, more: true }), { maxSteps: 4 })).toMatchObject({
      stoppedBy: 'max_steps',
      steps: 4,
    });
  });

  it('createBudget reports remaining time; stub cron tasks skip at once', async () => {
    let t = 1_000;
    const b = createBudget(10_000, () => t);
    t += 4_000;
    expect(b.remainingMs()).toBe(6_000);
    expect(b.exhausted(6_000)).toBe(true);
    const task = notImplementedCron('WP-x');
    expect(await task({ name: 'x', brand: BRANDS.roboapply, budget: b, now: NOW })).toEqual({ skipped: 'not_implemented' });
  });
});
