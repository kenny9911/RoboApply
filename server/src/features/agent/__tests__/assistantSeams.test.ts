// @vitest-environment node
//
// The applications agent's seams for the Assistant (docs/agent-driven/REDESIGN.md
// §1, §9): `jobPlaces` and `quoteJob` read where a job stands and what preparing
// it uses before anything is spent (the cost sheet's own lines), and `prepare`
// keys the kit reservation after the caller's idempotency key. Fake database,
// fake seams; no network, no model.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { MAX_ACTIVE_QUEUE_ITEMS } from '../contract.js';
import { job, makeDb, makeDeps, seedItem, usageLine } from './testkit.js';

type Db = ReturnType<typeof makeDb>;
const rows = async (db: Db, model: string, where: Record<string, unknown> = {}) =>
  (db as unknown as Record<string, { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> }>)[model]!.findMany({ where });

describe('jobPlaces: where jobs stand on the list (read only)', () => {
  it('a job off the list, a job on it, and a job this user cannot list', async () => {
    const db = makeDb({ rAJob: [job('j1'), job('j2'), job('jp', { visibility: 'private', ownerUserId: 'u2' }), job('jc', { closedAt: new Date('2026-10-10T00:00:00Z') })] });
    await seedItem(db, { jobId: 'j2', state: 'ready_for_review' });
    const { service, calls } = makeDeps(db);
    const res = await service.jobPlaces('u1', ['j1', 'j2', 'jp', 'jc', 'j1']);
    expect(res.listFull).toBe(false);
    expect(res.items.map((p) => p.jobId)).toEqual(['j1', 'j2', 'jp', 'jc']);
    expect(res.items[0]).toMatchObject({ job: { title: 'Role j1', companyName: 'Company j1', closed: false }, item: null });
    expect(res.items[1]).toMatchObject({ job: { title: 'Role j2' }, item: { jobId: 'j2', state: 'ready_for_review' } });
    expect(res.items[2]).toEqual({ jobId: 'jp', job: null, item: null });
    expect(res.items[3]).toMatchObject({ job: { closed: true }, item: null });
    // A read: nothing was added, expired or reserved.
    expect(await rows(db, 'rAAgentQueueItem')).toHaveLength(1);
    expect(calls.reserved).toEqual([]);
  });

  it('says when the list has no room for another job', async () => {
    const db = makeDb();
    for (let i = 0; i < MAX_ACTIVE_QUEUE_ITEMS; i += 1) await seedItem(db, { jobId: `x${i}` });
    const { service } = makeDeps(db);
    expect((await service.jobPlaces('u1', ['j1'])).listFull).toBe(true);
  });
});

describe('quoteJob: the cost before anything is spent', () => {
  it('a job not on the list costs what the cost sheet shows once it is there (weekly allowance first)', async () => {
    const db = makeDb();
    const { service, calls } = makeDeps(db, 'roboapply', {
      creditUsage: async () => ({ lines: { tailor: usageLine(2), cover_letter: usageLine(4), ready_kits: usageLine(3, 'week') }, upgradable: true }),
    });
    const quote = await service.quoteJob('u1', 'j2');
    expect(quote).toMatchObject({ jobId: 'j2', item: null, listFull: false, tailorEach: true, job: { title: 'Role j2', asksForCoverLetter: true } });
    expect(quote.proposal).toMatchObject({ confirmed: false, enough: true, aiAvailable: true, itemIds: [] });
    expect(quote.proposal!.credits).toEqual([
      { bucket: 'ready_kits', cost: 1, remaining: 3, window: 'week', resetsAt: '2026-10-13T04:00:00.000Z' },
      { bucket: 'tailor', cost: 1, remaining: 2, window: 'day', resetsAt: '2026-10-13T04:00:00.000Z' },
      { bucket: 'cover_letter', cost: 1, remaining: 4, window: 'day', resetsAt: '2026-10-13T04:00:00.000Z' },
    ]);
    // Nothing was added or reserved by the quote.
    expect(await rows(db, 'rAAgentQueueItem')).toHaveLength(0);
    expect(calls.reserved).toEqual([]);
    // The same lines the list's own proposal answers for the job once it is on the list (PrepareSheet's source).
    const { items } = await service.addToQueue('u1', { jobIds: ['j2'], addedVia: 'copilot' });
    const sheet = await service.prepare('u1', [items[0]!.id], false);
    expect(sheet.credits).toEqual(quote.proposal!.credits);
    expect((await service.quoteJob('u1', 'j2')).proposal).toEqual(sheet);
  });

  it('short of a bucket: enough is false and the line says what is left', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'roboapply', {
      creditUsage: async () => ({ lines: { tailor: usageLine(0), cover_letter: usageLine(4), ready_kits: usageLine(3, 'week') }, upgradable: true }),
    });
    const quote = await service.quoteJob('u1', 'j1');
    expect(quote.proposal).toMatchObject({ enough: false, credits: [expect.objectContaining({ bucket: 'ready_kits' }), expect.objectContaining({ bucket: 'tailor', cost: 1, remaining: 0 })] });
  });

  it('no AI: only the weekly allowance; tailoring off in Settings: no tailoring line', async () => {
    const db = makeDb();
    const noAi = makeDeps(db, 'roboapply', { aiAvailable: async () => false });
    const q1 = await noAi.service.quoteJob('u1', 'j2');
    expect(q1.proposal).toMatchObject({ aiAvailable: false });
    expect(q1.proposal!.credits.map((c) => c.bucket)).toEqual(['ready_kits']);
    const { service } = makeDeps(db);
    await service.putSettings('u1', { tailorEach: false });
    const q2 = await service.quoteJob('u1', 'j1');
    expect(q2.tailorEach).toBe(false);
    expect(q2.proposal!.credits.map((c) => c.bucket)).toEqual(['ready_kits']);
  });

  it('a job past "To prepare", a closed post and a job this user cannot list get no cost (never prepared twice)', async () => {
    const db = makeDb({ rAJob: [job('j1'), job('jc', { closedAt: new Date('2026-10-10T00:00:00Z') }), job('jp', { visibility: 'private', ownerUserId: 'u2' }), job('jf')] });
    await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const failed = await seedItem(db, { jobId: 'jf', state: 'failed', coverLetterId: 'cl_old' });
    const { service } = makeDeps(db);
    const preparing = await service.quoteJob('u1', 'j1');
    expect(preparing).toMatchObject({ item: { state: 'preparing' }, proposal: null });
    expect((await service.quoteJob('u1', 'jc')).proposal).toBeNull();
    expect(await service.quoteJob('u1', 'jp')).toMatchObject({ job: null, item: null, proposal: null });
    // A failed kit can be prepared again: its own item is quoted.
    expect((await service.quoteJob('u1', 'jf')).proposal).toMatchObject({ itemIds: [failed] });
  });
});

describe('prepare: the caller’s idempotency key names the kit reservation', () => {
  it('with a key: `<key>:<item>:<attempt>`; without one: the list’s own key, as before', async () => {
    const db = makeDb();
    const a = await seedItem(db, { jobId: 'j1' });
    const b = await seedItem(db, { jobId: 'j3' });
    const { service, calls } = makeDeps(db);
    const res = await service.prepare('u1', [a], true, { idempotencyKey: 'copilot:prop_1' });
    expect(res).toMatchObject({ confirmed: true, started: [a] });
    expect(calls.reserved).toEqual([`copilot:prop_1:${a}:1`]);
    expect(calls.enqueued).toEqual([{ queueItemId: a, userId: 'u1', attempt: 1, reservationId: `res_copilot:prop_1:${a}:1`, part: 'all' }]);
    await service.prepare('u1', [b], true);
    expect(calls.reserved).toEqual([`copilot:prop_1:${a}:1`, `ready_kit:${b}:1`]);
    // Started: not prepared twice, whatever key is sent.
    await expect(service.prepare('u1', [a], true, { idempotencyKey: 'copilot:prop_1' })).rejects.toMatchObject({ details: { reason: 'kit_not_ready' } });
    expect(calls.reserved).toHaveLength(2);
  });

  it('a twin send of the same key reserves one kit and starts it once', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1' });
    let n = 0;
    let bothIn!: () => void;
    const barrier = new Promise<void>((resolve) => (bothIn = resolve));
    const { service, calls } = makeDeps(db, 'roboapply', {
      reserveKit: async (_u, key) => {
        n += 1;
        if (n === 2) bothIn();
        await barrier;
        // The credit service hands the same ledger row to the second send of one key.
        return { id: `res_${key}`, replayed: n > 1 };
      },
    });
    const results = await Promise.allSettled([
      service.prepare('u1', [id], true, { idempotencyKey: 'copilot:prop_9' }),
      service.prepare('u1', [id], true, { idempotencyKey: 'copilot:prop_9' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(calls.enqueued).toHaveLength(1);
    expect(calls.released).toEqual([]);
  });
});
