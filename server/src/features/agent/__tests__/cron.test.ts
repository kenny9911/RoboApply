// @vitest-environment node
//
// WP-52: the `ready-weekly` cron (Monday 06:00 in each user's own time zone,
// built once a week) and the `agent` reminder producer (kit ready and not
// opened; this week's list is ready), over a fake database.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// No real database in unit tests: a seam left at its default fails loudly instead of reaching .env's DATABASE_URL.
vi.mock('../../../lib/prisma.js', () => ({
  default: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        throw new Error(`no real DB in unit tests (prisma.${String(prop)})`);
      },
    },
  ),
}));

import { getBrand } from '../../../platform/brand/registry.js';
import { createBudget, type CronContext } from '../../../platform/queue/index.js';
import { NOTIFY_TEMPLATES, type NotifyUserInput, type NotifyUserResult } from '../../alerts/index.js';
import { produceAgentReminders } from '../reminders.js';
import { runReadyWeeklyTask } from '../weekly.js';
import type { AgentDb } from '../store.js';
import { feedItem, job, makeDb, makeDeps, seedItem } from './testkit.js';

function ctx(now: Date, brand: 'roboapply' | 'goapply' = 'roboapply'): CronContext {
  return { name: 'test', brand: getBrand(brand), budget: createBudget(240_000), now };
}

/** Every seam that would otherwise reach the real database or the flag store. */
const sweep = vi.fn(async () => ({ swept: 0, scanned: 0 }));
const enabled = async () => true;
const seams = (db: ReturnType<typeof makeDb>) => ({ getDb: async () => db as unknown as AgentDb, sweep, enabled });

const settings = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId,
  weeklyTarget: 5,
  minTier: 'good',
  tailorEach: true,
  coverLetterMode: 'when_required',
  baseVariantId: null,
  fileNameStyle: 'name_company_role',
  setupStep: 'done',
  calibration: [],
  setupCompletedAt: new Date('2026-10-01T00:00:00Z'),
  ...extra,
});

function weeklyDb() {
  return makeDb({
    user: [
      { id: 'u_sh', brand: 'roboapply' },
      { id: 'u_la', brand: 'roboapply' },
      { id: 'u_ga', brand: 'goapply' },
      { id: 'u_new', brand: 'roboapply' },
    ],
    seekerProfile: [
      { id: 'p1', userId: 'u_sh', timezone: 'Asia/Shanghai' },
      { id: 'p2', userId: 'u_la', timezone: 'America/Los_Angeles' },
      { id: 'p3', userId: 'u_ga', timezone: 'Asia/Shanghai' },
      { id: 'p4', userId: 'u_new', timezone: 'Asia/Shanghai' },
    ],
    rAAgentSettings: [settings('u_sh'), settings('u_la'), settings('u_ga'), settings('u_new', { setupCompletedAt: null, setupStep: 'answers' })],
  });
}

describe('ready-weekly cron', () => {
  it('builds the list at Monday 06:00 in each user\'s own time zone, once a week, for set-up users of this brand', async () => {
    const db = weeklyDb();
    const generated: string[] = [];
    const generate = async (userId: string) => {
      generated.push(userId);
      return { weekKey: 'x', added: 1, items: [], filtersDiffer: false, reason: null };
    };
    const deps = { ...seams(db), generate };
    // Sunday 22:00 UTC = Monday 06:00 Shanghai, Sunday 15:00 Los Angeles.
    const r1 = await runReadyWeeklyTask(ctx(new Date('2026-10-11T22:05:00Z')), deps);
    expect(generated).toEqual(['u_sh']);
    expect(r1).toMatchObject({ processed: 1, added: 1 });
    // Monday 13:05 UTC = Monday 06:05 Los Angeles, 21:05 Shanghai.
    await runReadyWeeklyTask(ctx(new Date('2026-10-12T13:05:00Z')), deps);
    expect(generated).toEqual(['u_sh', 'u_la']);
    // GoApply's run sees only GoApply users.
    await runReadyWeeklyTask(ctx(new Date('2026-10-11T22:05:00Z'), 'goapply'), deps);
    expect(generated).toEqual(['u_sh', 'u_la', 'u_ga']);
  });

  it('skips a user whose list for this week already exists', async () => {
    const db = weeklyDb();
    const { service } = makeDeps(db, 'roboapply', { feedPreview: async () => [feedItem('j1', 'great')] });
    const generate = vi.fn((userId: string, o: Parameters<typeof service.generateList>[1]) => service.generateList(userId, o));
    // The service reads the zone of its own fake user u1; give u_sh's list the right week by seeding directly.
    await seedItem(db, { userId: 'u_sh', jobId: 'j1', addedVia: 'weekly', weekKey: '2026-W42' });
    const r = await runReadyWeeklyTask(ctx(new Date('2026-10-11T23:05:00Z')), { ...seams(db), generate });
    expect(generate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skipped: 'no_work', alreadyBuilt: 1 });
  });

  it('sweeps stuck kits on every run, for this brand, and skips a user whose capability is off', async () => {
    const db = weeklyDb();
    const generated: string[] = [];
    const generate = async (userId: string) => {
      generated.push(userId);
      return { weekKey: 'x', added: 1, items: [], filtersDiffer: false, reason: null };
    };
    const ownSweep = vi.fn(async () => ({ swept: 2, scanned: 2 }));
    const perUser = vi.fn(async (_b: unknown, userId: string | null) => userId !== 'u_sh');
    const r = await runReadyWeeklyTask(ctx(new Date('2026-10-11T22:05:00Z')), { getDb: async () => db as unknown as AgentDb, generate, sweep: ownSweep, enabled: perUser });
    expect(ownSweep).toHaveBeenCalledWith(expect.objectContaining({ brand: 'roboapply' }));
    expect(generated).toEqual([]);
    expect(r).toMatchObject({ skipped: 'no_work', disabled: 1, swept: 2 });
  });

  it('returns at once, without a query, outside Sunday 16:00 – Tuesday 00:00 UTC', async () => {
    const getDb = vi.fn();
    expect(await runReadyWeeklyTask(ctx(new Date('2026-10-14T10:00:00Z')), { getDb, sweep, enabled })).toEqual({ skipped: 'no_work', processed: 0 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it('with no set-up users it reports no work', async () => {
    const db = makeDb();
    expect(await runReadyWeeklyTask(ctx(new Date('2026-10-12T08:00:00Z')), seams(db))).toMatchObject({ skipped: 'no_work' });
  });
});

describe('agent reminders producer', () => {
  const NOW = new Date('2026-10-14T10:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

  function notifier(status: NotifyUserResult['status'] = 'delivered') {
    const sent: NotifyUserInput[] = [];
    const notify = async (input: NotifyUserInput): Promise<NotifyUserResult> => {
      sent.push(input);
      if (status === 'deferred') return { status: 'deferred', retryAt: new Date(NOW.getTime() + 3_600_000) };
      if (status === 'skipped') return { status: 'skipped', reason: 'preference_off' };
      return { status: 'delivered', outcome: { notificationId: 'n', email: null, channels: {} } };
    };
    return { sent, notify };
  }

  it('reminds once about a kit that has been ready for a day and not opened', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'ready_for_review', updatedAt: hoursAgo(30), createdAt: hoursAgo(100) });
    await seedItem(db, { jobId: 'j2', state: 'approved', updatedAt: hoursAgo(2), createdAt: hoursAgo(100) }); // too fresh
    await seedItem(db, { jobId: 'j3', state: 'opened', updatedAt: hoursAgo(30), createdAt: hoursAgo(100) }); // opened
    const { sent, notify } = notifier();
    const deps = { ...seams(db), notify };
    const r = await produceAgentReminders(ctx(NOW), deps);
    expect(r).toMatchObject({ sent: 1 });
    expect(sent).toEqual([
      expect.objectContaining({
        userId: 'u1',
        templateKey: NOTIFY_TEMPLATES.kitNotOpened,
        params: { jobId: 'j1', title: 'Role j1', company: 'Company j1' },
        href: '/ready/j1',
        category: 'reminder',
        relatedEntity: { type: 'agent_queue_item', id },
      }),
    ]);
    await produceAgentReminders(ctx(NOW), deps);
    expect(sent).toHaveLength(1);
  });

  it('never reminds about a kit whose post has closed: the kit expires instead', async () => {
    const db = makeDb({ rAJob: [job('j1', { closedAt: new Date('2026-10-13T00:00:00Z') }), job('j2', { archivedAt: new Date('2026-10-13T00:00:00Z') }), job('j3')] });
    const closed = await seedItem(db, { jobId: 'j1', state: 'ready_for_review', updatedAt: hoursAgo(30) });
    const archived = await seedItem(db, { jobId: 'j2', state: 'approved', updatedAt: hoursAgo(30) });
    await seedItem(db, { jobId: 'j3', state: 'approved', updatedAt: hoursAgo(30) });
    const { sent, notify } = notifier();
    const r = await produceAgentReminders(ctx(NOW), { ...seams(db), notify });
    expect(sent.map((s) => (s.params as { jobId: string }).jobId)).toEqual(['j3']);
    expect(r).toMatchObject({ sent: 1, expiredClosed: 2 });
    const items = await (db as unknown as AgentDb).rAAgentQueueItem.findMany({ where: { id: { in: [closed, archived] } } });
    expect(items.map((i) => i.state)).toEqual(['expired', 'expired']);
    await produceAgentReminders(ctx(NOW), { ...seams(db), notify });
    expect(sent).toHaveLength(1);
  });

  it('a send deferred by quiet hours is retried on a later run', async () => {
    const db = makeDb();
    await seedItem(db, { jobId: 'j1', state: 'approved', updatedAt: hoursAgo(30) });
    const quiet = notifier('deferred');
    expect(await produceAgentReminders(ctx(NOW), { ...seams(db), notify: quiet.notify })).toMatchObject({ deferred: 1, sent: 0 });
    const later = notifier();
    await produceAgentReminders(ctx(NOW), { ...seams(db), notify: later.notify });
    expect(later.sent).toHaveLength(1);
  });

  it('tells the user this week\'s list is ready, with the real count, once', async () => {
    const db = makeDb();
    for (const j of ['j1', 'j2', 'j3']) await seedItem(db, { jobId: j, addedVia: 'weekly', weekKey: '2026-W42', createdAt: hoursAgo(3), updatedAt: hoursAgo(3) });
    const { sent, notify } = notifier();
    await produceAgentReminders(ctx(NOW), { ...seams(db), notify });
    expect(sent).toEqual([expect.objectContaining({ templateKey: NOTIFY_TEMPLATES.readyListReady, params: { count: 3 }, href: '/ready' })]);
    await produceAgentReminders(ctx(NOW), { ...seams(db), notify });
    expect(sent).toHaveLength(1);
  });

  it('a list the user built on demand gets no "list ready" notice', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'roboapply', { feedPreview: async () => [feedItem('j1', 'great')], now: () => NOW });
    await service.generateList('u1', { source: 'user' });
    const { sent, notify } = notifier();
    await produceAgentReminders(ctx(NOW), { ...seams(db), notify });
    expect(sent.filter((s) => s.templateKey === NOTIFY_TEMPLATES.readyListReady)).toEqual([]);
  });

  it('other brands\' users are left to their own brand run; idle runs report no work', async () => {
    const db = makeDb({ user: [{ id: 'u1', brand: 'goapply' }] });
    await seedItem(db, { jobId: 'j1', state: 'approved', updatedAt: hoursAgo(30) });
    const { sent, notify } = notifier();
    await produceAgentReminders(ctx(NOW, 'roboapply'), { ...seams(db), notify });
    expect(sent).toEqual([]);
    const empty = makeDb();
    expect(await produceAgentReminders(ctx(NOW), { ...seams(empty), notify })).toEqual({ skipped: 'no_work', processed: 0 });
  });
});
