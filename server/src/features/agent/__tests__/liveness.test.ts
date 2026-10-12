// @vitest-environment node
//
// MKT-5C (JI-10; MARKET_STRATEGY 1.5 "Closure"; D1): Ready to apply checks
// that a posting is still listed before a job enters the list and again
// before a kit is prepared. Fake database, fake seams, a faked check; the one
// test of the production seam runs the real jobs/liveness check over the
// in-memory database with a recording fetch. No network, no model.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { resetLivenessForTests } from '../../jobs/liveness/index.js';
import { MAX_ACTIVE_QUEUE_ITEMS } from '../contract.js';
import { defaultAgentDeps, type AgentDeps, type JobLiveState } from '../deps.js';
import type { AgentDb } from '../store.js';
import { NOW, feedItem, job, makeDb, makeDeps, seedItem } from './testkit.js';

type Db = ReturnType<typeof makeDb>;
const rows = async (db: Db, model: string, where: Record<string, unknown> = {}) =>
  (db as unknown as Record<string, { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> }>)[model]!.findMany({ where });

/** A faked check: answers per job id (default 'open') and records what it was asked. */
function checker(answers: Record<string, JobLiveState | Error> = {}) {
  const asked: string[] = [];
  const dbs: unknown[] = [];
  const checkJobLive: NonNullable<AgentDeps['checkJobLive']> = async (jobId, db) => {
    asked.push(jobId);
    dbs.push(db);
    const a = answers[jobId] ?? 'open';
    if (a instanceof Error) throw a;
    return a;
  };
  return { checkJobLive, asked, dbs };
}

describe('a job enters the list only while its posting is still listed', () => {
  it('ACCEPT: adding a job whose posting is gone is refused with job_closed; nothing is added and no credit is touched', async () => {
    const db = makeDb();
    const c = checker({ j1: 'closed' });
    const { service, calls } = makeDeps(db, 'roboapply', { checkJobLive: c.checkJobLive });
    await expect(service.addToQueue('u1', { jobIds: ['j1'] })).rejects.toMatchObject({ code: 'gone', status: 410, details: { reason: 'job_closed' } });
    expect(await rows(db, 'rAAgentQueueItem')).toEqual([]);
    expect(await rows(db, 'rAAgentKitEvent')).toEqual([]);
    expect(calls.reserved).toEqual([]);
    expect(calls.enqueued).toEqual([]);
    // The check was handed the job's id and the database the service holds.
    expect(c.asked).toEqual(['j1']);
    expect(c.dbs[0]).toBe(db);
  });

  it('open, "cannot tell" and a failing check: the job is added exactly as before', async () => {
    for (const answer of ['open', 'unknown', new Error('check down')] as const) {
      const db = makeDb();
      const c = checker({ j1: answer });
      const { service } = makeDeps(db, 'roboapply', { checkJobLive: c.checkJobLive });
      const res = await service.addToQueue('u1', { jobIds: ['j1'] });
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({ jobId: 'j1', state: 'picked', job: { closed: false } });
      expect(c.asked).toEqual(['j1']);
    }
  });

  it('with no check wired the flow is unchanged', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'roboapply', { checkJobLive: undefined });
    expect((await service.addToQueue('u1', { jobIds: ['j1', 'j2'] })).items.map((i) => i.jobId)).toEqual(['j1', 'j2']);
  });

  it('several jobs at once: the ones still listed are added, the one that is gone is left out', async () => {
    const db = makeDb();
    const c = checker({ j2: 'closed' });
    const { service } = makeDeps(db, 'roboapply', { checkJobLive: c.checkJobLive });
    const res = await service.addToQueue('u1', { jobIds: ['j1', 'j2', 'j3'] });
    expect(res.items.map((i) => i.jobId)).toEqual(['j1', 'j3']);
    expect((await rows(db, 'rAAgentQueueItem')).map((r) => r.jobId).sort()).toEqual(['j1', 'j3']);
    expect(c.asked.sort()).toEqual(['j1', 'j2', 'j3']);
  });

  it('a job whose row is closed already does not enter either, and is not asked about', async () => {
    const db = makeDb({ rAJob: [job('j1', { closedAt: new Date('2026-10-10T00:00:00Z') }), job('j2', { archivedAt: new Date('2026-10-10T00:00:00Z') }), job('j3')] });
    const c = checker();
    const { service } = makeDeps(db, 'roboapply', { checkJobLive: c.checkJobLive });
    await expect(service.addToQueue('u1', { jobIds: ['j1'] })).rejects.toMatchObject({ code: 'gone', details: { reason: 'job_closed' } });
    await expect(service.addToQueue('u1', { jobIds: ['j1', 'j2'] })).rejects.toMatchObject({ code: 'gone', details: { reason: 'job_closed' } });
    expect(c.asked).toEqual([]);
    expect((await service.addToQueue('u1', { jobIds: ['j1', 'j3'] })).items.map((i) => i.jobId)).toEqual(['j3']);
    expect(c.asked).toEqual(['j3']);
  });

  it('a job already in the list is answered as it is, and is not asked about again', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'ready_for_review' });
    const c = checker({ j1: 'closed', j2: 'closed' });
    const { service } = makeDeps(db, 'roboapply', { checkJobLive: c.checkJobLive });
    const res = await service.addToQueue('u1', { jobIds: ['j1', 'j2'] });
    expect(res.items.map((i) => i.id)).toEqual([id]);
    expect(c.asked).toEqual(['j2']);
  });

  it('"closed" and "your list is full" are two different answers on the wire: 410 gone / job_closed and 409 conflict / queue_full', async () => {
    // Every caller of this route words a 409 as "your list is full"; a closed job must never read as that.
    const full = makeDb({ rAJob: Array.from({ length: MAX_ACTIVE_QUEUE_ITEMS + 2 }, (_, i) => job(`q${i}`)) });
    for (let i = 0; i < MAX_ACTIVE_QUEUE_ITEMS; i++) await seedItem(full, { jobId: `q${i}`, state: 'picked' });
    const c = checker({ [`q${MAX_ACTIVE_QUEUE_ITEMS + 1}`]: 'closed' });
    const { service } = makeDeps(full, 'roboapply', { checkJobLive: c.checkJobLive });
    const fullErr = await service.addToQueue('u1', { jobIds: [`q${MAX_ACTIVE_QUEUE_ITEMS}`] }).catch((e: unknown) => e);
    expect(fullErr).toMatchObject({ code: 'conflict', status: 409, details: { reason: 'queue_full' } });
    // A closed job is "closed" even when the list is also full: the list being full is not why it was refused.
    const closedErr = await service.addToQueue('u1', { jobIds: [`q${MAX_ACTIVE_QUEUE_ITEMS + 1}`] }).catch((e: unknown) => e);
    expect(closedErr).toMatchObject({ code: 'gone', status: 410, details: { reason: 'job_closed' } });
    expect((closedErr as { details: Record<string, unknown> }).details).not.toHaveProperty('room');
  });

  it('a job that does not exist is still "not found", not "closed"', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'roboapply', { checkJobLive: checker().checkJobLive });
    await expect(service.addToQueue('u1', { jobIds: ['nope'] })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('the weekly list: a posting that is gone is skipped and the next candidate takes its place', async () => {
    const db = makeDb();
    await (db as unknown as AgentDb).rAAgentSettings.create({ data: { userId: 'u1', weeklyTarget: 5, minTier: 'good', tailorEach: true, coverLetterMode: 'when_required', fileNameStyle: 'name_company_role' } as never });
    const c = checker({ j2: 'closed', j4: 'closed' });
    const { service } = makeDeps(db, 'roboapply', {
      checkJobLive: c.checkJobLive,
      feedPreview: async () => ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((id) => feedItem(id, 'great')),
    });
    const res = await service.generateList('u1', { source: 'cron' });
    expect(res.added).toBe(4);
    expect(res.items.map((i) => i.jobId)).toEqual(['j1', 'j3', 'j5', 'j6']);
    expect((await rows(db, 'rAAgentQueueItem')).map((r) => r.jobId).sort()).toEqual(['j1', 'j3', 'j5', 'j6']);
  });

  it('the weekly list stops asking once the target is met', async () => {
    const more = Array.from({ length: 20 }, (_, i) => job(`w${String(i).padStart(2, '0')}`));
    const big = makeDb({ rAJob: more });
    await (big as unknown as AgentDb).rAAgentSettings.create({ data: { userId: 'u1', weeklyTarget: 5, minTier: 'good', tailorEach: true, coverLetterMode: 'when_required', fileNameStyle: 'name_company_role' } as never });
    const c = checker();
    const { service } = makeDeps(big, 'roboapply', { checkJobLive: c.checkJobLive, feedPreview: async () => more.map((j) => feedItem(String(j.id), 'great')) });
    expect((await service.generateList('u1', { source: 'cron' })).added).toBe(5);
    // Five at a time, and no more than the first batch that filled the target.
    expect(c.asked).toHaveLength(5);
  });
});

describe('a kit is prepared only while its posting is still listed', () => {
  async function started(overrides: Partial<AgentDeps>) {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1' });
    const kit = makeDeps(db, 'roboapply', overrides);
    await kit.service.prepare('u1', [id], true);
    return { db, id, ...kit };
  }

  it('ACCEPT: a job that closes between queueing and preparation expires with job_closed and its reservation is released', async () => {
    // Listed when the kit was started, gone when the worker reaches it.
    const answers: Record<string, JobLiveState> = { j1: 'open' };
    const c = checker(answers);
    const { db, id, service, calls } = await started({ checkJobLive: c.checkJobLive });
    expect(calls.reserved).toEqual([`ready_kit:${id}:1`]);
    answers.j1 = 'closed';
    expect(await service.runPrepare(calls.enqueued[0]!)).toBe('expired');
    const [item] = await rows(db, 'rAAgentQueueItem', { id });
    expect(item).toMatchObject({ state: 'expired', lastError: 'job_closed' });
    expect(calls.released).toEqual([`res_ready_kit:${id}:1`]);
    expect(calls.committed).toEqual([]);
    // No tailoring and no letter were spent on it.
    expect(calls.tailor).toEqual([]);
    expect(calls.letters).toEqual([]);
    const events = await rows(db, 'rAAgentKitEvent', { queueItemId: id, toState: 'expired' });
    expect(events[0]!.detail).toMatchObject({ error: 'job_closed', attempt: 1 });
  });

  it('open, "cannot tell" and a failing check: the kit is prepared as before', async () => {
    for (const answer of ['open', 'unknown', new Error('check down')] as const) {
      const c = checker({ j1: answer });
      const { db, id, service, calls } = await started({ checkJobLive: c.checkJobLive });
      expect(await service.runPrepare(calls.enqueued[0]!)).toBe('ready');
      const [item] = await rows(db, 'rAAgentQueueItem', { id });
      expect(item!.state).toBe('ready_for_review');
      expect(calls.released).toEqual([]);
      expect(calls.tailor).toHaveLength(1);
      expect(c.asked).toEqual(['j1']);
    }
  });

  it('a row that is closed already expires as it always did, without asking', async () => {
    const db = makeDb({ rAJob: [job('j1')] });
    const id = await seedItem(db, { jobId: 'j1' });
    const c = checker();
    const { service, calls } = makeDeps(db, 'roboapply', { checkJobLive: c.checkJobLive });
    await service.prepare('u1', [id], true);
    await (db as unknown as { rAJob: { update: (a: unknown) => Promise<unknown> } }).rAJob.update({ where: { id: 'j1' }, data: { closedAt: NOW } });
    expect(await service.runPrepare(calls.enqueued[0]!)).toBe('expired');
    expect(c.asked).toEqual([]);
    expect(calls.released).toEqual([`res_ready_kit:${id}:1`]);
  });

  it('reading the list never asks: a list is not a moment to call an ATS', async () => {
    const db = makeDb();
    await seedItem(db, { jobId: 'j1', state: 'picked' });
    await seedItem(db, { jobId: 'j2', state: 'ready_for_review' });
    const c = checker({ j1: 'closed' });
    const { service } = makeDeps(db, 'roboapply', { checkJobLive: c.checkJobLive });
    const list = await service.listQueue('u1', {});
    expect(list.items).toHaveLength(2);
    expect(c.asked).toEqual([]);
  });
});

describe('the production seam: jobs/liveness over the database the service holds', () => {
  const realFetch = globalThis.fetch;
  let requests: string[];

  beforeEach(() => {
    resetLivenessForTests();
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  /** The ATS as a recording fake: every request is answered `status`. */
  const fakeAts = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: unknown) => {
      requests.push(String(url));
      return { status, ok: status === 200, text: async () => JSON.stringify(body) };
    }) as unknown as typeof fetch;
  };

  it('a row with no posting key is "cannot tell", and no request is made', async () => {
    fakeAts(404, { status: 404, error: 'Job not found' });
    const db = makeDb();
    const check = defaultAgentDeps().checkJobLive!;
    expect(await check('j1', db as unknown as AgentDb)).toBe('unknown');
    expect(await check('missing', db as unknown as AgentDb)).toBe('unknown');
    expect(requests).toEqual([]);
  });

  it('a keyed row whose ATS answers 404 is closed and archived in that same database; adding it is then refused', async () => {
    fakeAts(404, { status: 404, error: 'Job not found' });
    const lastSeenAt = new Date(Date.now() - 30 * 3_600_000);
    // SYNTHETIC row: no real board or posting.
    const db = makeDb({ rAJob: [job('j1', { sourceBoard: 'jsearch', externalId: 'x1', fromRecruiterBank: false, atsPostingKey: 'greenhouse:acme:1', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', sourceUrl: null, lastSeenAt, dedupeKey: 'dk1', closeReason: null })] });
    const { service, calls } = makeDeps(db, 'roboapply', { checkJobLive: defaultAgentDeps().checkJobLive });
    await expect(service.addToQueue('u1', { jobIds: ['j1'] })).rejects.toMatchObject({ code: 'gone', details: { reason: 'job_closed' } });
    expect(requests).toEqual(['https://boards-api.greenhouse.io/v1/boards/acme/jobs/1']);
    const [row] = await rows(db, 'rAJob', { id: 'j1' });
    // An aggregator's row: closed with the reason no re-listing by the aggregator undoes.
    expect(row).toMatchObject({ closeReason: 'ats_removed' });
    expect(row!.archivedAt).toBeInstanceOf(Date);
    expect(calls.reserved).toEqual([]);
    expect(await rows(db, 'rAAgentQueueItem')).toEqual([]);
  });

  it('LIVENESS_CHECK_DISABLED=true: no request, and the job is added as before', async () => {
    vi.stubEnv('LIVENESS_CHECK_DISABLED', 'true');
    fakeAts(404, { status: 404, error: 'Job not found' });
    const db = makeDb({ rAJob: [job('j1', { sourceBoard: 'jsearch', atsPostingKey: 'greenhouse:acme:1', lastSeenAt: new Date(Date.now() - 30 * 3_600_000) })] });
    const { service } = makeDeps(db, 'roboapply', { checkJobLive: defaultAgentDeps().checkJobLive });
    expect((await service.addToQueue('u1', { jobIds: ['j1'] })).items).toHaveLength(1);
    expect(requests).toEqual([]);
  });
});
