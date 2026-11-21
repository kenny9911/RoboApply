// @vitest-environment node
//
// "Prepare my weekly list automatically" (docs/agent-driven/REDESIGN.md §9),
// over the service with a fake database and fake seams (no network, no
// database, no model):
//   - off by default: a list build prepares nothing;
//   - on: each newly picked job goes through `prepare` (the Prepare button's
//     path and `ready_kits` gate), in pick order, one reservation per job
//     keyed `autoprep:<itemId>:<attempt>`, as the system's move;
//   - it stops cleanly where a credit runs out (planned, or a 402 from the
//     gate itself) and never skips ahead; nothing past "To prepare" is touched;
//   - a second build prepares nothing twice; the `agent` capability, AI
//     availability and "Tailor my resume for each job" are respected;
//   - off again stops later runs and undoes nothing; the run is reported with
//     its real counts; the generic UI-state PATCH cannot switch it.

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
import { CreditsExhaustedError } from '../../../platform/credits/index.js';
import { createBudget } from '../../../platform/queue/index.js';
import { UiStatePatchSchema, isServerOwnedValueKey } from '../../uistate/contract.js';
import { AUTO_PREPARE_KEYS, autoPrepareRunValues, autoPrepareSwitchValues, autoPrepareView, planAutoPrepare, readAutoPrepare } from '../autoPrepare.js';
import type { AgentDeps } from '../deps.js';
import { kitCost } from '../service.js';
import type { AgentDb } from '../store.js';
import { runReadyWeeklyTask } from '../weekly.js';
import { NOW, feedItem, makeDb, makeDeps, usageLine } from './testkit.js';

type Db = ReturnType<typeof makeDb>;
const rows = async (db: Db, model: string, where: Record<string, unknown> = {}) =>
  (db as unknown as Record<string, { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> }>)[model]!.findMany({ where });

const settingsRow = (extra: Record<string, unknown> = {}) => ({
  userId: 'u1',
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

const usage = (kits: number, tailor = 10, letters = 10) => async () => ({
  lines: { tailor: usageLine(tailor), cover_letter: usageLine(letters), ready_kits: usageLine(kits, 'week') },
  upgradable: true,
});

/** u1 with a set-up list of 5 a week; the search returns j1…j6 best first (j2's post asks for a cover letter). */
function world(over: Partial<AgentDeps> = {}, settings: Record<string, unknown> = {}) {
  const db = makeDb({ rAAgentSettings: [settingsRow(settings)] });
  const fakes = makeDeps(db, 'roboapply', {
    feedPreview: async () => ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((j) => feedItem(j, 'great')),
    creditUsage: usage(10),
    ...over,
  });
  return { db, ...fakes };
}

const exhausted = (bucket = 'ready_kits') => new CreditsExhaustedError({ bucket, resetsAt: new Date('2026-10-19T04:00:00Z'), upgradable: true, cap: 3, window: 'week' });

describe('the option', () => {
  it('is off by default: a list build prepares nothing and records no run', async () => {
    const { service, calls, db } = world();
    expect(await service.getAutoPrepare('u1')).toEqual({ on: false, since: null, lastRun: null, aiAvailable: true });
    const r = await service.generateList('u1', { source: 'cron' });
    expect(r.added).toBe(5);
    expect(r).not.toHaveProperty('autoPrepared');
    expect(calls.reserved).toEqual([]);
    expect(calls.enqueued).toEqual([]);
    expect(calls.uiWrites).toEqual([]);
    expect((await rows(db, 'rAAgentQueueItem')).map((i) => i.state)).toEqual(['picked', 'picked', 'picked', 'picked', 'picked']);
  });

  it('turning it on is stored with its time; turning it on again keeps that time and writes nothing', async () => {
    const { service, calls, ui } = world();
    expect(await service.setAutoPrepare('u1', { on: true })).toEqual({ on: true, since: NOW.toISOString(), lastRun: null, aiAvailable: true });
    expect(ui.get('u1')).toEqual({ [AUTO_PREPARE_KEYS.on]: true, [AUTO_PREPARE_KEYS.since]: NOW.toISOString() });
    const later = makeDeps(world().db, 'roboapply', { now: () => new Date(NOW.getTime() + 3_600_000), uiValues: async () => ({ ...ui.get('u1') }) });
    expect((await later.service.setAutoPrepare('u1', { on: true })).since).toBe(NOW.toISOString());
    expect(later.calls.uiWrites).toEqual([]);
    expect(calls.uiWrites).toHaveLength(1);
  });

  it('says whether AI is available for this account (as a tapped Prepare reads it); a read that fails is "not known", never false', async () => {
    expect((await world({ aiAvailable: async () => false }).service.getAutoPrepare('u1')).aiAvailable).toBe(false);
    expect((await world({ aiAvailable: async () => Promise.reject(new Error('down')) }).service.getAutoPrepare('u1')).aiAvailable).toBeNull();
  });

  it('a store that cannot be read counts as off: the list is built and nothing is prepared', async () => {
    const { service, calls } = world({ uiValues: async () => Promise.reject(new Error('db down')) });
    const r = await service.generateList('u1', { source: 'cron' });
    expect(r.added).toBe(5);
    expect(r).not.toHaveProperty('autoPrepared');
    expect(calls.reserved).toEqual([]);
  });
});

describe('an automatic run', () => {
  it('prepares each newly picked job in pick order through the Prepare path, one reservation key per job, as the system\'s move', async () => {
    const { service, calls, db } = world();
    await service.setAutoPrepare('u1', { on: true });
    const r = await service.generateList('u1', { source: 'cron' });
    const ids = r.items.map((i) => i.id);
    expect(r.items.map((i) => i.jobId)).toEqual(['j1', 'j2', 'j3', 'j4', 'j5']);
    // The answer shows the jobs as they are now.
    expect(r.items.map((i) => i.state)).toEqual(['preparing', 'preparing', 'preparing', 'preparing', 'preparing']);
    expect(r.autoPrepared).toEqual({ started: ids, left: 0, stoppedBy: null });
    expect(calls.reserved).toEqual(ids.map((id) => `autoprep:${id}:1`));
    expect(calls.enqueued.map((p) => [p.queueItemId, p.attempt, p.part])).toEqual(ids.map((id) => [id, 1, 'all']));
    const moves = (await rows(db, 'rAAgentKitEvent')).filter((e) => e.toState === 'preparing');
    expect(moves).toHaveLength(5);
    for (const e of moves) expect(e).toMatchObject({ fromState: 'picked', actor: 'system', detail: { attempt: 1, auto: true } });
    // Nothing is submitted (D1): the work items only prepare.
    expect(calls.applyClicks).toEqual([]);
    expect(calls.marks).toEqual([]);
    // The run, with its real counts, for the Getting ready page and the Dashboard.
    expect((await service.getAutoPrepare('u1')).lastRun).toEqual({ at: NOW.toISOString(), weekKey: '2026-W42', started: 5, left: 0, stoppedBy: null, thisWeek: true });
  });

  it('stops cleanly where the weekly allowance runs out: the first jobs start, the rest stay in To prepare, nothing more is reserved', async () => {
    const { service, calls } = world({ creditUsage: usage(2) });
    await service.setAutoPrepare('u1', { on: true });
    const r = await service.generateList('u1', { source: 'cron' });
    const [a, b, ...rest] = r.items;
    expect(r.autoPrepared).toEqual({ started: [a!.id, b!.id], left: 3, stoppedBy: 'ready_kits' });
    expect(calls.reserved).toEqual([`autoprep:${a!.id}:1`, `autoprep:${b!.id}:1`]);
    expect(rest.map((i) => i.state)).toEqual(['picked', 'picked', 'picked']);
    expect((await service.getAutoPrepare('u1')).lastRun).toMatchObject({ started: 2, left: 3, stoppedBy: 'ready_kits', thisWeek: true });
  });

  it('never goes beyond the weekly allowance: bonus applications are not counted, and the gate is told not to use them', async () => {
    // 1 application left in the week, 5 bonus ones: the run starts 1 job and stops at the allowance.
    const { service, calls } = world({
      creditUsage: async () => ({
        lines: { tailor: usageLine(10), cover_letter: usageLine(10), ready_kits: { ...usageLine(6, 'week'), windowRemaining: 1 } },
        upgradable: true,
      }),
    });
    await service.setAutoPrepare('u1', { on: true });
    const r = await service.generateList('u1', { source: 'cron' });
    expect(r.autoPrepared).toEqual({ started: [r.items[0]!.id], left: 4, stoppedBy: 'ready_kits' });
    expect(calls.reserveOptions).toEqual([{ useGrants: false }]);
    // A tapped Prepare is unchanged: it may still use them.
    await service.prepare('u1', [r.items[1]!.id], true);
    expect(calls.reserveOptions).toEqual([{ useGrants: false }, undefined]);
  });

  it('counts tailoring and letters together across the run, and never skips ahead to a cheaper job', async () => {
    // Tailoring credits: 3 left for 5 jobs.
    const tailor = world({ creditUsage: usage(10, 3) });
    await tailor.service.setAutoPrepare('u1', { on: true });
    const t = await tailor.service.generateList('u1', { source: 'cron' });
    expect(t.autoPrepared).toMatchObject({ left: 2, stoppedBy: 'tailor' });
    expect(t.autoPrepared!.started).toEqual(t.items.slice(0, 3).map((i) => i.id));
    // No cover letter credit left: j2's post asks for one, so the run stops there; j3 (no letter) is not started either.
    const letters = world({ creditUsage: usage(10, 10, 0) });
    await letters.service.setAutoPrepare('u1', { on: true });
    const l = await letters.service.generateList('u1', { source: 'cron' });
    expect(l.items.map((i) => i.jobId)).toEqual(['j1', 'j2', 'j3', 'j4', 'j5']);
    expect(l.autoPrepared).toEqual({ started: [l.items[0]!.id], left: 4, stoppedBy: 'cover_letter' });
    expect(letters.calls.reserved).toHaveLength(1);
  });

  it('stops at a 402 from the credit gate itself (another request used the last application): what started stays, nothing else is reserved', async () => {
    const reserved: string[] = [];
    const { service, calls } = world({
      reserveKit: async (_u, key) => {
        if (reserved.length >= 2) throw exhausted('ready_kits');
        reserved.push(key);
        return { id: `res_${key}`, replayed: false };
      },
    });
    await service.setAutoPrepare('u1', { on: true });
    const r = await service.generateList('u1', { source: 'cron' });
    expect(r.autoPrepared).toEqual({ started: r.items.slice(0, 2).map((i) => i.id), left: 3, stoppedBy: 'ready_kits' });
    expect(r.items.map((i) => i.state)).toEqual(['preparing', 'preparing', 'picked', 'picked', 'picked']);
    expect(calls.enqueued).toHaveLength(2);
    expect(calls.released).toEqual([]);

    // The gate refusing the very first job: nothing starts, the list is still built.
    const none = world({ reserveKit: async () => Promise.reject(exhausted('ready_kits')) });
    await none.service.setAutoPrepare('u1', { on: true });
    const n = await none.service.generateList('u1', { source: 'cron' });
    expect(n.added).toBe(5);
    expect(n.autoPrepared).toEqual({ started: [], left: 5, stoppedBy: 'ready_kits' });
    expect(none.calls.enqueued).toEqual([]);
    expect((await none.service.getAutoPrepare('u1')).lastRun).toMatchObject({ started: 0, left: 5, stoppedBy: 'ready_kits' });
  });

  it('is idempotent: a second build of the week prepares nothing twice, and a later build prepares only its own new jobs', async () => {
    const { service, calls } = world();
    await service.setAutoPrepare('u1', { on: true });
    const first = await service.generateList('u1', { source: 'cron' });
    const runAfterFirst = (await service.getAutoPrepare('u1')).lastRun;
    // The cron again (or a retry): the list is full for the week, nothing new is picked, nothing is reserved again.
    const again = await service.generateList('u1', { source: 'cron' });
    expect(again.reason).toBe('target_reached');
    expect(again).not.toHaveProperty('autoPrepared');
    expect(calls.reserved).toHaveLength(5);
    expect((await service.getAutoPrepare('u1')).lastRun).toEqual(runAfterFirst);
    // Sending the same automatic start again for a job already started is refused before any reservation.
    await expect(service.prepare('u1', [first.items[0]!.id], true, { idempotencyKey: 'autoprep', auto: true })).rejects.toMatchObject({ details: { reason: 'kit_not_ready' } });
    expect(calls.reserved).toHaveLength(5);
    // "Add more jobs" on demand: only the new job is prepared, with its own key.
    const more = await service.generateList('u1', { source: 'user', more: true });
    expect(more.items.map((i) => i.jobId)).toEqual(['j6']);
    expect(more.autoPrepared).toEqual({ started: [more.items[0]!.id], left: 0, stoppedBy: null });
    expect(calls.reserved).toEqual([...first.items.map((i) => `autoprep:${i.id}:1`), `autoprep:${more.items[0]!.id}:1`]);
  });

  it('with the `agent` capability off for the user nothing is prepared, even with the option on', async () => {
    const { service, calls } = world({ flag: async (key) => key !== 'agent' });
    await service.setAutoPrepare('u1', { on: true });
    const r = await service.generateList('u1', { source: 'cron' });
    expect(r.added).toBe(5);
    expect(r).not.toHaveProperty('autoPrepared');
    expect(calls.reserved).toEqual([]);
    expect(calls.enqueued).toEqual([]);
  });

  it('follows AI availability and "Tailor my resume for each job" exactly as a tapped Prepare does', async () => {
    // AI off (consent or the brand's model): no tailoring or letter credit is counted or needed.
    const noAi = world({ aiAvailable: async () => false, creditUsage: usage(10, 0, 0) });
    await noAi.service.setAutoPrepare('u1', { on: true });
    expect((await noAi.service.generateList('u1', { source: 'cron' })).autoPrepared).toMatchObject({ left: 0, stoppedBy: null });
    expect(noAi.calls.reserved).toHaveLength(5);
    // Tailoring switched off in Settings: no tailoring credit is needed.
    const asIs = world({ creditUsage: usage(10, 0) }, { tailorEach: false, coverLetterMode: 'never' });
    await asIs.service.setAutoPrepare('u1', { on: true });
    expect((await asIs.service.generateList('u1', { source: 'cron' })).autoPrepared).toMatchObject({ left: 0, stoppedBy: null });
    // Tailoring on with no tailoring credit left: nothing starts and nothing is reserved.
    const tailored = world({ creditUsage: usage(10, 0) });
    await tailored.service.setAutoPrepare('u1', { on: true });
    expect((await tailored.service.generateList('u1', { source: 'cron' })).autoPrepared).toEqual({ started: [], left: 5, stoppedBy: 'tailor' });
    expect(tailored.calls.reserved).toEqual([]);
  });

  it('turned off, later builds prepare nothing; what was prepared stays as it is and the last run is still reported', async () => {
    const { service, calls, db } = world({}, { weeklyTarget: 5 });
    await service.setAutoPrepare('u1', { on: true });
    await service.generateList('u1', { source: 'cron' });
    const off = await service.setAutoPrepare('u1', { on: false });
    expect(off).toMatchObject({ on: false, since: null, lastRun: { started: 5, left: 0, thisWeek: true } });
    const more = await service.generateList('u1', { source: 'user', more: true });
    expect(more.added).toBe(1);
    expect(more).not.toHaveProperty('autoPrepared');
    expect(calls.reserved).toHaveLength(5);
    expect(calls.released).toEqual([]);
    const states = (await rows(db, 'rAAgentQueueItem')).map((i) => i.state);
    expect(states.filter((s) => s === 'preparing')).toHaveLength(5);
    expect(states.filter((s) => s === 'picked')).toHaveLength(1);
  });

  it('a run from an earlier week is reported as not this week\'s', async () => {
    const { service, ui } = world();
    await service.setAutoPrepare('u1', { on: true });
    await service.generateList('u1', { source: 'cron' });
    const nextWeek = makeDeps(world().db, 'roboapply', { now: () => new Date(NOW.getTime() + 7 * 86_400_000), uiValues: async () => ({ ...ui.get('u1') }) });
    expect((await nextWeek.service.getAutoPrepare('u1')).lastRun).toMatchObject({ weekKey: '2026-W42', started: 5, thisWeek: false });
  });

  it('the weekly cron counts the applications its builds started', async () => {
    const { service, db } = world({ now: () => new Date('2026-10-12T13:05:00Z') });
    await service.setAutoPrepare('u1', { on: true });
    const ctx = { name: 'test', brand: getBrand('roboapply'), budget: createBudget(240_000), now: new Date('2026-10-12T13:05:00Z') };
    const r = await runReadyWeeklyTask(ctx, {
      getDb: async () => db as unknown as AgentDb,
      generate: (userId, o) => service.generateList(userId, o),
      enabled: async () => true,
      sweep: async () => ({ swept: 0, scanned: 0 }),
    });
    expect(r).toMatchObject({ processed: 1, added: 5, autoPrepared: 5 });
  });
});

describe('autoPrepare.ts (pure)', () => {
  it('reads the stored values tolerantly: only `true` is on, a run needs its time, week and count', () => {
    expect(readAutoPrepare(undefined)).toEqual({ on: false, since: null, lastRun: null });
    expect(readAutoPrepare({ [AUTO_PREPARE_KEYS.on]: 'true', [AUTO_PREPARE_KEYS.since]: NOW.toISOString() })).toEqual({ on: false, since: null, lastRun: null });
    expect(readAutoPrepare({ [AUTO_PREPARE_KEYS.on]: true, [AUTO_PREPARE_KEYS.since]: 'yesterday' })).toEqual({ on: true, since: null, lastRun: null });
    const run = autoPrepareRunValues({ at: NOW, weekKey: '2026-W42', started: 2, left: 3, stoppedBy: 'tailor' });
    expect(readAutoPrepare(run).lastRun).toEqual({ at: NOW.toISOString(), weekKey: '2026-W42', started: 2, left: 3, stoppedBy: 'tailor' });
    expect(readAutoPrepare({ ...run, [AUTO_PREPARE_KEYS.runStarted]: -1 }).lastRun).toBeNull();
    expect(readAutoPrepare({ ...run, [AUTO_PREPARE_KEYS.runWeek]: 'last week' }).lastRun).toBeNull();
    // Jobs left with no readable reason are said as "could not be started", never as a credit that ran out.
    expect(readAutoPrepare({ ...run, [AUTO_PREPARE_KEYS.runStop]: 'nonsense' }).lastRun?.stoppedBy).toBe('error');
    expect(readAutoPrepare(autoPrepareRunValues({ at: NOW, weekKey: '2026-W42', started: 5, left: 0, stoppedBy: null })).lastRun?.stoppedBy).toBeNull();
    expect(autoPrepareView(readAutoPrepare(run), '2026-W43', null)).toMatchObject({ lastRun: { thisWeek: false }, aiAvailable: null });
    expect(autoPrepareSwitchValues(false, NOW)).toEqual({ [AUTO_PREPARE_KEYS.on]: null, [AUTO_PREPARE_KEYS.since]: null });
  });

  it('plans the longest prefix that fits every bucket, and stops at the first job that does not', () => {
    const c = (id: string, tailor = 1, letter = 0) => ({ id, tailor, letter });
    expect(planAutoPrepare([c('a'), c('b'), c('c')], { ready_kits: 2, tailor: 5 })).toEqual({ ids: ['a', 'b'], stoppedBy: 'ready_kits' });
    expect(planAutoPrepare([c('a', 1, 1), c('b', 1, 0), c('c', 1, 1)], { ready_kits: 9, tailor: 9, cover_letter: 1 })).toEqual({ ids: ['a', 'b'], stoppedBy: 'cover_letter' });
    expect(planAutoPrepare([c('a', 1, 1), c('b', 1, 0)], { ready_kits: 9, cover_letter: 0 })).toEqual({ ids: [], stoppedBy: 'cover_letter' });
    // A bucket whose count is not known is left to the credit gate itself.
    expect(planAutoPrepare([c('a'), c('b')], {})).toEqual({ ids: ['a', 'b'], stoppedBy: null });
    expect(planAutoPrepare([], { ready_kits: 0 })).toEqual({ ids: [], stoppedBy: null });
  });

  it('one cost rule for a kit: tailoring with AI and the setting, a letter only when the post asks (or always) and none is there', () => {
    const job = { descriptionPlain: 'Please include a cover letter.', qualifications: null };
    const plain = { descriptionPlain: 'We build things.', qualifications: null };
    expect(kitCost({ tailorEach: true, coverLetterMode: 'when_required' }, true, { coverLetterId: null, job })).toEqual({ tailor: 1, letter: 1 });
    expect(kitCost({ tailorEach: true, coverLetterMode: 'when_required' }, true, { coverLetterId: null, job: plain })).toEqual({ tailor: 1, letter: 0 });
    expect(kitCost({ tailorEach: false, coverLetterMode: 'always' }, true, { coverLetterId: null, job: plain })).toEqual({ tailor: 0, letter: 1 });
    expect(kitCost({ tailorEach: true, coverLetterMode: 'always' }, true, { coverLetterId: 'cl1', job })).toEqual({ tailor: 1, letter: 0 });
    expect(kitCost({ tailorEach: true, coverLetterMode: 'always' }, false, { coverLetterId: null, job })).toEqual({ tailor: 0, letter: 0 });
  });

  it('every stored key is server-owned: the generic UI-state PATCH refuses them, and still takes other values', () => {
    for (const key of Object.values(AUTO_PREPARE_KEYS)) {
      expect(isServerOwnedValueKey(key)).toBe(true);
      expect(UiStatePatchSchema.safeParse({ values: { [key]: true } }).success).toBe(false);
      expect(UiStatePatchSchema.safeParse({ values: { [key]: null } }).success).toBe(false);
    }
    expect(UiStatePatchSchema.safeParse({ values: { 'applyIntercept.never': true } }).success).toBe(true);
    expect(isServerOwnedValueKey('agent.autoPrepared')).toBe(false);
  });
});
