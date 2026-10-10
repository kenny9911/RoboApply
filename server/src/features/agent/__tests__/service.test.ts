// @vitest-environment node
//
// WP-52 acceptance over the service (fake database, fake seams; no network,
// no model): settings and setup, the weekly list (target, tier, exclusions,
// user-local week), the credit proposal before preparing, kit preparation,
// the state machine through review / open / undo, "I applied", the
// extension's "I submitted", and the answer bank.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { deriveKitEventKind, kitEventKind } from '../store.js';
import { NOW, feedItem, job, makeDb, makeDeps, seedItem, usageLine } from './testkit.js';

const NOW_MS = NOW.getTime();

type Db = ReturnType<typeof makeDb>;
const rows = async (db: Db, model: string, where: Record<string, unknown> = {}) =>
  (db as unknown as Record<string, { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> }>)[model]!.findMany({ where });

describe('settings', () => {
  it('returns the defaults before anything is saved, and saves a patch', async () => {
    const db = makeDb();
    const { service } = makeDeps(db);
    expect(await service.getSettings('u1')).toEqual({
      weeklyTarget: 10,
      minTier: 'good',
      tailorEach: true,
      coverLetterMode: 'when_required',
      baseVariantId: null,
      fileNameStyle: 'name_company_role',
      // Lists come from the active search with no changes of their own (SR-52-1).
      listFilters: { searchProfileId: null, overrides: null },
    });
    const saved = await service.putSettings('u1', { weeklyTarget: 5, minTier: 'great', baseVariantId: 'rv_base' });
    expect(saved).toMatchObject({ weeklyTarget: 5, minTier: 'great', baseVariantId: 'rv_base', tailorEach: true });
    expect(await service.getSettings('u1')).toMatchObject({ weeklyTarget: 5 });
  });

  it('refuses a base resume the user does not own', async () => {
    const db = makeDb({ rAResumeVariant: [{ id: 'rv_other', userId: 'u2', kind: 'base', isPrimary: true }] });
    const { service } = makeDeps(db);
    await expect(service.putSettings('u1', { baseVariantId: 'rv_other' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('setup (F-AGENT-02, C13)', () => {
  it('reports the checks: missing profile fields, calibration, answers, extension', async () => {
    const db = makeDb({ rAExtensionDevice: [{ id: 'd1', userId: 'u1', brand: 'roboapply', revokedAt: null }] });
    const { service } = makeDeps(db);
    const s = await service.setup('u1');
    expect(s.step).toBe('profile');
    expect(s.checks).toMatchObject({
      profileMissing: [{ key: 'phone', label: 'profile.missing.phone' }],
      calibrationDone: false,
      calibrationCount: 0,
      answersCount: 0,
      extensionConnected: true,
      extensionAvailable: true,
      reportReady: false,
    });
  });

  it('needs 3 verdicts before the calibration step completes, and keeps one verdict per job', async () => {
    const db = makeDb();
    const { service } = makeDeps(db);
    expect((await service.completeStep('u1', { step: 'profile', action: 'complete' })).step).toBe('calibrate');
    await expect(service.completeStep('u1', { step: 'calibrate', action: 'complete' })).rejects.toMatchObject({ details: { reason: 'calibration_incomplete' } });
    await service.calibrate('u1', { jobId: 'j1', verdict: 'up' });
    await service.calibrate('u1', { jobId: 'j1', verdict: 'down', reason: 'wrong_level' });
    await service.calibrate('u1', { jobId: 'j2', verdict: 'up' });
    let s = await service.calibrate('u1', { jobId: 'j3', verdict: 'up' });
    expect(s.checks.calibrationCount).toBe(3);
    expect(s.checks.calibrationDone).toBe(true);
    s = await service.completeStep('u1', { step: 'calibrate', action: 'complete' });
    expect(s.step).toBe('answers');
    await expect(service.calibrate('u1', { jobId: 'nope', verdict: 'up' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('steps are finished in order: a later step is 409 setup_step_out_of_order, an earlier one changes nothing', async () => {
    const db = makeDb();
    const { service } = makeDeps(db);
    for (const step of ['calibrate', 'answers', 'weekly'] as const) {
      await expect(service.completeStep('u1', { step, action: 'complete' })).rejects.toMatchObject({
        code: 'conflict',
        status: 409,
        details: { reason: 'setup_step_out_of_order', step: 'profile' },
      });
    }
    // Skipping "Get the extension" from the first step cannot jump past the others.
    await expect(service.completeStep('u1', { step: 'extension', action: 'skip' })).rejects.toMatchObject({
      status: 409,
      details: { reason: 'setup_step_out_of_order' },
    });
    expect((await service.setup('u1')).step).toBe('profile');
    await service.completeStep('u1', { step: 'profile', action: 'complete' });
    // Finishing the profile again never sends the user back.
    expect((await service.completeStep('u1', { step: 'profile', action: 'complete' })).step).toBe('calibrate');
  });

  async function walkTo(service: ReturnType<typeof makeDeps>['service'], last: 'weekly' | 'extension', action: 'complete' | 'skip' = 'complete') {
    await service.completeStep('u1', { step: 'profile', action: 'complete' });
    for (const jobId of ['j3', 'j4', 'j5']) await service.calibrate('u1', { jobId, verdict: 'up' });
    await service.completeStep('u1', { step: 'calibrate', action: 'complete' });
    await service.completeStep('u1', { step: 'answers', action: 'complete' });
    const afterWeekly = await service.completeStep('u1', { step: 'weekly', action: 'complete' });
    return last === 'weekly' ? afterWeekly : service.completeStep('u1', { step: 'extension', action });
  }

  it('only "Get the extension" can be skipped; finishing setup builds the first list', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'roboapply', { feedPreview: async () => [feedItem('j1', 'great'), feedItem('j2', 'good')] });
    await expect(service.completeStep('u1', { step: 'answers', action: 'skip' })).rejects.toMatchObject({ details: { reason: 'setup_step_not_skippable' } });
    const done = await walkTo(service, 'extension', 'skip');
    expect(done.step).toBe('done');
    expect(done.completedAt).toBeTruthy();
    expect(done.checks.weeklySaved).toBe(true);
    expect(done.firstList?.added).toBe(2);
  });

  it('without the extension capability, finishing weekly settings finishes setup', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'roboapply', { flag: async (key) => key !== 'extension' });
    const s = await walkTo(service, 'weekly');
    expect(s.step).toBe('done');
    expect(s.completedAt).toBeTruthy();
    expect(s.checks.extensionAvailable).toBe(false);
  });
});

describe('weekly list (F-AGENT-04)', () => {
  it('picks real fits at or above the minimum tier, up to the weekly target, in the user\'s week', async () => {
    const db = makeDb({ rAAgentSettings: [{ userId: 'u1', weeklyTarget: 5, minTier: 'good', tailorEach: true, coverLetterMode: 'when_required', baseVariantId: null, fileNameStyle: 'name_company_role', setupStep: 'done', calibration: [{ jobId: 'j5', verdict: 'down' }], setupCompletedAt: new Date() }] });
    const preview = vi.fn(async () => [
      feedItem('j1', 'great'),
      feedItem('j2', 'possible'), // below "Good fit"
      feedItem('j3', null), // unscored: never counts as a fit
      feedItem('j4', 'good', 'applied'), // already applied
      feedItem('j5', 'great'), // the user rated it down in setup
      feedItem('j6', 'good', 'bookmarked'), // saved only: fine
    ]);
    const { service } = makeDeps(db, 'roboapply', { feedPreview: preview });
    const r = await service.generateList('u1', { source: 'cron' });
    expect(r.reason).toBeNull();
    expect(r.items.map((i) => i.jobId)).toEqual(['j1', 'j6']);
    expect(r.weekKey).toBe('2026-W42');
    expect(r.items[0]).toMatchObject({ state: 'picked', addedVia: 'weekly', weekKey: '2026-W42', job: { title: 'Role j1', hasApplyUrl: true, closed: false } });
    expect(preview).toHaveBeenCalledWith('u1', expect.objectContaining({ sort: 'best_fit' }));
    // One audit row per new item (null → picked).
    const ev = await rows(db, 'rAAgentKitEvent');
    expect(ev.filter((e) => e.toState === 'picked' && e.fromState === null)).toHaveLength(2);
    // Running again tops up only: nothing new qualifies.
    expect((await service.generateList('u1', { source: 'cron' })).reason).toBe('no_matches');
  });

  it('stops at the target and at the 50 active items limit', async () => {
    const db = makeDb({ rAAgentSettings: [{ userId: 'u1', weeklyTarget: 5, minTier: 'possible', tailorEach: true, coverLetterMode: 'never', baseVariantId: null, fileNameStyle: 'name_role', setupStep: 'done', calibration: [], setupCompletedAt: new Date() }] });
    const { service } = makeDeps(db, 'roboapply', { feedPreview: async () => ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((j) => feedItem(j, 'good')) });
    expect((await service.generateList('u1', { source: 'cron' })).added).toBe(5);
    expect((await service.generateList('u1', { source: 'cron' })).reason).toBe('target_reached');
    for (let i = 0; i < 45; i += 1) await seedItem(db, { jobId: `x${i}` });
    expect((await service.generateList('u1', { source: 'user', more: true })).reason).toBe('queue_full');
  });

  it('asks "Use this for your main search too?" when the list used other filters, and saves them to the main search on yes (F-FILT-07)', async () => {
    const db = makeDb();
    const patch = vi.fn(async (_u: string, id: string, version: number) => ({ id, version: version + 1 }) as never);
    const { service } = makeDeps(db, 'roboapply', { feedPreview: async () => [feedItem('j1', 'great')], patchSearch: patch });
    const r = await service.generateList('u1', { source: 'user', overrides: { workModels: ['remote'] } });
    expect(r.filtersDiffer).toBe(true);
    // "No, only this list": the change is kept for Ready to apply's next lists (SR-52-1).
    expect((await service.getSettings('u1')).listFilters).toEqual({ searchProfileId: null, overrides: { workModels: ['remote'] } });
    expect((await service.generateList('u1', { source: 'user', more: true })).filtersDiffer).toBe(true);
    // "Yes": the main search takes the filters, and Ready to apply keeps none of its own.
    await service.saveToMain('u1', { filters: { workModels: ['remote'] }, version: 3 });
    expect(patch).toHaveBeenCalledWith('u1', 'sp_main', 3, { workModels: ['remote'] });
    expect((await service.getSettings('u1')).listFilters).toEqual({ searchProfileId: null, overrides: null });
    expect((await service.generateList('u1', { source: 'user', more: true })).filtersDiffer).toBe(false);
  });

  it('Ready-only filter changes are used for every later list, and can be removed (SR-52-1)', async () => {
    const db = makeDb();
    const previews: unknown[] = [];
    const { service } = makeDeps(db, 'roboapply', {
      feedPreview: async (_u, input) => {
        previews.push(input.filters);
        return [feedItem('j1', 'great'), feedItem('j2', 'great')];
      },
    });
    await service.putSettings('u1', { weeklyTarget: 5 });
    await service.generateList('u1', { source: 'user', overrides: { workModels: ['remote'], postedWithinDays: 7 }, more: true });
    // The weekly cron and an on-demand list without a body both use what was kept.
    await service.generateList('u1', { source: 'cron' });
    await service.generateList('u1', { source: 'user', more: true });
    expect(previews).toEqual([
      { workModels: ['remote'], postedWithinDays: 7 },
      { workModels: ['remote'], postedWithinDays: 7 },
      { workModels: ['remote'], postedWithinDays: 7 },
    ]);
    // New changes replace the kept ones; the cron never writes any.
    await service.generateList('u1', { source: 'user', overrides: { workModels: ['hybrid'] }, more: true });
    expect((await service.getSettings('u1')).listFilters?.overrides).toEqual({ workModels: ['hybrid'] });
    await service.generateList('u1', { source: 'cron', overrides: { workModels: ['onsite'] } });
    expect((await service.getSettings('u1')).listFilters?.overrides).toEqual({ workModels: ['hybrid'] });
    // "Use my main search only".
    const cleared = await service.putSettings('u1', { filterOverrides: null });
    expect(cleared).toMatchObject({ weeklyTarget: 5, listFilters: { searchProfileId: null, overrides: null } });
    await service.generateList('u1', { source: 'cron' });
    expect(previews.at(-1)).toBeUndefined();
  });

  it('a change that removes a filter of the main search is kept as null and applied as "not set"', async () => {
    const db = makeDb();
    const previews: unknown[] = [];
    const base = { id: 'sp_main', name: 'Main', isDefault: true, isActive: true, version: 3, schemaVersion: 1, filters: { q: 'designer', workModels: ['onsite'] }, alertInstantMax: 0, alertDigest: null, createdAt: '', updatedAt: '' };
    const { service } = makeDeps(db, 'roboapply', {
      activeSearch: async () => base as never,
      feedPreview: async (_u, input) => {
        previews.push(input.filters);
        return [feedItem('j1', 'great')];
      },
    });
    await service.generateList('u1', { source: 'user', overrides: { workModels: null, postedWithinDays: 7 }, more: true });
    expect(previews[0]).toEqual({ workModels: undefined, postedWithinDays: 7 });
    expect(Object.keys(previews[0] as object)).toContain('workModels');
    expect((await service.getSettings('u1')).listFilters?.overrides).toEqual({ workModels: null, postedWithinDays: 7 });
    await service.generateList('u1', { source: 'cron', more: true });
    expect(previews[1]).toEqual({ workModels: undefined, postedWithinDays: 7 });
  });

  it('filters the request carries are refused when they do not parse; kept ones that stopped parsing never block a list', async () => {
    const db = makeDb({ rAAgentSettings: [{ userId: 'u1', weeklyTarget: 5, minTier: 'good', tailorEach: true, coverLetterMode: 'never', baseVariantId: null, fileNameStyle: 'name_role', setupStep: 'done', calibration: [], setupCompletedAt: new Date(), filterOverrides: { salaryMin: 'lots' } }] });
    const previews: unknown[] = [];
    const { service } = makeDeps(db, 'roboapply', {
      filtersValid: async (_b, o) => typeof o.salaryMin !== 'string',
      feedPreview: async (_u, input) => {
        previews.push(input.filters);
        return [feedItem('j1', 'great')];
      },
    });
    const r = await service.generateList('u1', { source: 'cron' });
    expect(r).toMatchObject({ added: 1, filtersDiffer: false });
    expect(previews).toEqual([undefined]);
    await expect(service.generateList('u1', { source: 'user', overrides: { salaryMin: 'lots' } })).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'invalid_filters' } });
  });

  it('a saved search other than the active one replaces its filters (RAAgentSettings.searchProfileId)', async () => {
    const db = makeDb({ rAAgentSettings: [{ userId: 'u1', weeklyTarget: 5, minTier: 'good', tailorEach: true, coverLetterMode: 'never', baseVariantId: null, fileNameStyle: 'name_role', setupStep: 'done', calibration: [], setupCompletedAt: new Date(), searchProfileId: 'sp_other', filterOverrides: { postedWithinDays: 3 } }] });
    const previews: unknown[] = [];
    const base = { id: 'sp_main', name: 'Main', isDefault: true, isActive: true, version: 3, schemaVersion: 1, filters: { q: 'designer', workModels: ['onsite'] }, alertInstantMax: 0, alertDigest: null, createdAt: '', updatedAt: '' };
    const searchProfile = vi.fn(async (_u: string, id: string) => (id === 'sp_other' ? ({ ...base, id: 'sp_other', filters: { q: 'engineer' } } as never) : null));
    const { service } = makeDeps(db, 'roboapply', {
      activeSearch: async () => base as never,
      searchProfile,
      feedPreview: async (_u, input) => {
        previews.push(input.filters);
        return [feedItem('j1', 'great')];
      },
    });
    await service.generateList('u1', { source: 'cron' });
    // The other search's own keys, none of the active search's, then Ready to apply's changes.
    expect(previews[0]).toEqual({ q: 'engineer', workModels: undefined, postedWithinDays: 3 });
    expect(searchProfile).toHaveBeenCalledWith('u1', 'sp_other');
    expect((await service.getSettings('u1')).listFilters).toEqual({ searchProfileId: 'sp_other', overrides: { postedWithinDays: 3 } });
    // A saved search that is gone: the active search with the kept changes.
    searchProfile.mockResolvedValue(null);
    await service.generateList('u1', { source: 'cron', more: true });
    expect(previews[1]).toEqual({ postedWithinDays: 3 });
  });

  it('does nothing when the job feed is off (GoApply recruitment-info mode off)', async () => {
    const db = makeDb();
    const preview = vi.fn(async () => [feedItem('j1', 'great')]);
    const { service } = makeDeps(db, 'goapply', { flag: async (key) => key !== 'jobs.feed', feedPreview: preview });
    expect((await service.generateList('u1', { source: 'cron' })).reason).toBe('no_feed');
    expect((await service.suggestions('u1', {})).items).toEqual([]);
    expect(preview).not.toHaveBeenCalled();
  });

  it('suggestions leave out queued, rated and excluded jobs', async () => {
    const db = makeDb({ rAAgentSettings: [{ userId: 'u1', weeklyTarget: 10, minTier: 'good', tailorEach: true, coverLetterMode: 'never', baseVariantId: null, fileNameStyle: 'name_role', setupStep: 'calibrate', calibration: [{ jobId: 'j2', verdict: 'up' }], setupCompletedAt: null }] });
    await seedItem(db, { jobId: 'j1' });
    const { service } = makeDeps(db, 'roboapply', { feedPreview: async () => ['j1', 'j2', 'j3', 'j4', 'j5'].map((j) => feedItem(j, 'good')) });
    const s = await service.suggestions('u1', { limit: 3, exclude: 'j3' });
    expect(s.items.map((i) => i.jobId)).toEqual(['j4', 'j5']);
  });
});

describe('queue', () => {
  it('adds jobs the user can see, keeps one item per job, and holds at most 50 active', async () => {
    const db = makeDb({ rAJob: [job('j1'), job('jp', { visibility: 'private', ownerUserId: 'u2' }), job('jcn', { market: 'cn' })] });
    const { service } = makeDeps(db);
    const a = await service.addToQueue('u1', { jobIds: ['j1', 'jp', 'jcn'], addedVia: 'feed' });
    expect(a.items.map((i) => i.jobId)).toEqual(['j1']);
    const b = await service.addToQueue('u1', { jobIds: ['j1'] });
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.id).toBe(a.items[0]!.id);
    await expect(service.addToQueue('u1', { jobIds: ['jp'] })).rejects.toMatchObject({ code: 'not_found' });
    for (let i = 0; i < 49; i += 1) await seedItem(db, { jobId: `x${i}` });
    const db2 = db as unknown as { rAJob: { create: (a: unknown) => Promise<unknown> } };
    await db2.rAJob.create({ data: job('j9') });
    await expect(service.addToQueue('u1', { jobIds: ['j9'] })).rejects.toMatchObject({ details: { reason: 'queue_full', room: 0 } });
  });

  it('lists by tab with counts, and flags a closed post as expired', async () => {
    const db = makeDb({ rAJob: [job('j1'), job('j2', { closedAt: new Date('2026-10-10T00:00:00Z') }), job('j3')] });
    await seedItem(db, { jobId: 'j1', state: 'picked' });
    await seedItem(db, { jobId: 'j2', state: 'ready_for_review' });
    await seedItem(db, { jobId: 'j3', state: 'opened' });
    const { service } = makeDeps(db);
    const all = await service.listQueue('u1', {});
    expect(all.counts).toEqual({ to_prepare: 1, ready: 0, done: 2 });
    expect(all.items.find((i) => i.jobId === 'j2')).toMatchObject({ state: 'expired', job: { closed: true } });
    const ready = await service.listQueue('u1', { tab: 'to_prepare' });
    expect(ready.items.map((i) => i.jobId)).toEqual(['j1']);
    expect(all.weekKey).toBe('2026-W42');
    // No fit known: the summary carries none (the row shows none).
    expect(all.items.every((i) => i.job && !('fit' in i.job))).toBe(true);
  });

  it('list rows carry the fit when it is known, and none when it is not shown or cannot be read', async () => {
    const db = makeDb();
    await seedItem(db, { jobId: 'j1', state: 'picked' });
    await seedItem(db, { jobId: 'j2', state: 'picked' });
    const fitsFor = vi.fn(async (_u: string, ids: string[]) => new Map(ids.filter((id) => id === 'j1').map((id) => [id, { tier: 'good' as const, score: 72 }])));
    const { service } = makeDeps(db, 'roboapply', { fitsFor });
    const list = await service.listQueue('u1', {});
    expect(list.items.find((i) => i.jobId === 'j1')!.job).toMatchObject({ title: 'Role j1', fit: { tier: 'good', score: 72 } });
    expect(list.items.find((i) => i.jobId === 'j2')!.job).not.toHaveProperty('fit');
    expect(fitsFor).toHaveBeenCalledWith('u1', expect.arrayContaining(['j1', 'j2']));
    // GoApply without 个性化推荐 (the seam answers nothing), or a failing read: the list still loads.
    const none = makeDeps(db, 'roboapply', { fitsFor: async () => new Map() });
    expect((await none.service.listQueue('u1', {})).items.every((i) => !i.job?.fit)).toBe(true);
    const broken = makeDeps(db, 'roboapply', { fitsFor: async () => Promise.reject(new Error('down')) });
    expect((await broken.service.listQueue('u1', {})).items).toHaveLength(2);
  });

  it('the badge counts kits that are ready and not opened', async () => {
    const db = makeDb();
    await seedItem(db, { jobId: 'j1', state: 'ready_for_review' });
    await seedItem(db, { jobId: 'j2', state: 'approved' });
    await seedItem(db, { jobId: 'j3', state: 'opened' });
    const { service } = makeDeps(db);
    expect(await service.badge('u1')).toEqual({ readyNotOpened: 2 });
  });
});

describe('prepare: the credit proposal comes first (F-AGENT-10)', () => {
  it('shows the cost and what is left, and changes nothing without confirm', async () => {
    const db = makeDb();
    const ids: string[] = [];
    for (const j of ['j1', 'j2', 'j3', 'j4', 'j5']) ids.push(await seedItem(db, { jobId: j }));
    const { service, calls } = makeDeps(db, 'roboapply', {
      creditUsage: async () => ({ lines: { tailor: usageLine(2), cover_letter: usageLine(2), ready_kits: usageLine(30, 'week') }, upgradable: true }),
    });
    const p = await service.prepare('u1', ids, false);
    expect(p.confirmed).toBe(false);
    expect(p.aiAvailable).toBe(true);
    // "Uses 5 tailoring credits; you have 2 left today"
    expect(p.credits).toEqual([
      expect.objectContaining({ bucket: 'ready_kits', cost: 5, remaining: 30, window: 'week' }),
      expect.objectContaining({ bucket: 'tailor', cost: 5, remaining: 2, window: 'day' }),
      expect.objectContaining({ bucket: 'cover_letter', cost: 1, remaining: 2 }), // only j2's post asks for a letter
    ]);
    expect(p.enough).toBe(false);
    expect(calls.reserved).toEqual([]);
    expect((await rows(db, 'rAAgentQueueItem', { state: 'preparing' })).length).toBe(0);
    // Confirming anyway: 402 credits_exhausted for the short bucket, nothing reserved.
    await expect(service.prepare('u1', ids, true)).rejects.toMatchObject({ code: 'credits_exhausted', bucket: 'tailor', upgradable: true });
    expect(calls.reserved).toEqual([]);
  });

  it('on confirm reserves one ready_kits credit per job, moves it to preparing and queues the work', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j2' });
    const { service, calls } = makeDeps(db);
    const p = await service.prepare('u1', [id], true);
    expect(p).toMatchObject({ confirmed: true, enough: true, started: [id] });
    expect(calls.reserved).toEqual([`ready_kit:${id}:1`]);
    expect(calls.enqueued).toEqual([{ queueItemId: id, userId: 'u1', attempt: 1, reservationId: `res_ready_kit:${id}:1`, part: 'all' }]);
    const [item] = await rows(db, 'rAAgentQueueItem', { id });
    expect(item!.state).toBe('preparing');
    // Not preparable twice.
    expect((await service.prepare('u1', [id], false)).notPreparable).toEqual([id]);
    await expect(service.prepare('u1', [id], true)).rejects.toMatchObject({ details: { reason: 'kit_not_ready' } });
  });

  it('without AI (consent off) the proposal has no tailor or letter cost', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j2' });
    const { service } = makeDeps(db, 'goapply', { aiAvailable: async () => false });
    const p = await service.prepare('u1', [id], false);
    expect(p.aiAvailable).toBe(false);
    expect(p.credits.map((c) => c.bucket)).toEqual(['ready_kits']);
  });
});

describe('runPrepare (the agent.prepare worker)', () => {
  it('tailors through RES, writes the letter through CL when the post asks for one, and commits the kit credit', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j2', state: 'preparing' });
    const { service, calls } = makeDeps(db);
    expect(await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'res1', part: 'all' })).toBe('ready');
    expect(calls.tailor).toEqual([expect.objectContaining({ baseVariantId: 'rv_base', jobId: 'j2', idempotencyKey: `kit:${id}:1:tailor` })]);
    expect(calls.letters).toEqual(['j2']);
    expect(calls.committed).toEqual(['res1']);
    const [item] = await rows(db, 'rAAgentQueueItem', { id });
    expect(item).toMatchObject({ state: 'ready_for_review', resumeVariantId: 'rv_tailored1', tailorSessionId: 'ts1', coverLetterId: 'cl_j2', missingFields: [{ key: 'phone', label: 'profile.missing.phone' }] });
  });

  it('a failed tailor marks the kit failed with a code and releases the kit credit', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const err = Object.assign(new Error('no'), { code: 'credits_exhausted', details: { bucket: 'tailor' } });
    const { service, calls } = makeDeps(db, 'roboapply', { tailor: async () => Promise.reject(err) });
    expect(await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'res1', part: 'all' })).toBe('failed');
    const [item] = await rows(db, 'rAAgentQueueItem', { id });
    expect(item).toMatchObject({ state: 'failed', lastError: 'credits_exhausted:tailor' });
    expect(calls.released).toEqual(['res1']);
    expect(calls.committed).toEqual([]);
  });

  it('no resume → failed no_resume; a stale item releases its credit', async () => {
    const db = makeDb({ rAResumeVariant: [] });
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const { service, calls } = makeDeps(db);
    expect(await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' })).toBe('failed');
    expect((await rows(db, 'rAAgentQueueItem', { id }))[0]!.lastError).toBe('no_resume');
    const id2 = await seedItem(db, { jobId: 'j3', state: 'skipped' });
    expect(await service.runPrepare({ queueItemId: id2, userId: 'u1', attempt: 1, reservationId: 'r2', part: 'all' })).toBe('stale');
    expect(calls.released).toEqual(['r1', 'r2']);
  });

  it('AI consent off: no tailor, no letter — the kit is the user\'s own resume', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j2', state: 'preparing' });
    const { service, calls } = makeDeps(db, 'goapply', { aiAvailable: async () => false });
    expect(await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' })).toBe('ready');
    expect(calls.tailor).toEqual([]);
    expect(calls.letters).toEqual([]);
    expect((await rows(db, 'rAAgentQueueItem', { id }))[0]).toMatchObject({ state: 'ready_for_review', resumeVariantId: 'rv_base', tailorSessionId: null });
  });
});

describe('review, approve, open, undo (R-19, ruling C11)', () => {
  async function readyKit(overrides: Parameters<typeof makeDeps>[2] = {}) {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const kit = makeDeps(db, 'roboapply', overrides);
    await kit.service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' });
    return { db, id, ...kit };
  }

  it('cannot reach approved while the tailored resume has unverified claims', async () => {
    let pending = 2;
    const { service, id } = await readyKit({
      finalizeTailor: async () => Promise.reject(Object.assign(new Error('check'), { code: 'unverified_claims', status: 409, pending })),
      unverifiedClaims: async () => pending,
    });
    await expect(service.confirmPart('u1', id, { part: 'resume', decision: 'use' })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'kit_unverified_claims', pending: 2 },
    });
    await expect(service.open('u1', id)).rejects.toMatchObject({ details: { reason: 'kit_not_ready' } });
    pending = 0;
  });

  it('use → approved → Open application moves the tracker to Applied at once; Undo restores it', async () => {
    const { service, calls, id, db } = await readyKit();
    const approved = await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    expect(approved.state).toBe('approved');
    const opened = await service.open('u1', id);
    expect(opened).toMatchObject({
      applyUrl: 'https://jobs.example.test/j1',
      handoff: { jobId: 'j1', variantId: 'rv_tailored1', coverLetterId: null },
      trackerEntryId: 'trk_j1',
      alreadyApplied: false,
      item: { state: 'opened', trackerEntryId: 'trk_j1' },
    });
    expect(calls.applyClicks).toEqual(['j1']);
    // Opening again returns the URL without another move.
    expect((await service.open('u1', id)).item?.state).toBe('opened');
    const undone = await service.undoApplied('u1', id);
    expect(undone.state).toBe('approved');
    expect(calls.undoClicks).toEqual(['j1']);
    const history = await service.history('u1', id);
    expect(history.items.filter((e) => e.kind === 'transition').map((e) => `${e.fromState}→${e.toState}`)).toEqual([
      'preparing→ready_for_review',
      'ready_for_review→approved',
      'approved→opened',
      'opened→approved',
    ]);
    expect(history.items.some((e) => e.kind === 'decision' && e.detail?.part === 'resume')).toBe(true);
    void db;
  });

  it('Open application records the resume on the application (an artifact with the tracker entry) and answers alreadyApplied', async () => {
    const { service, calls, id } = await readyKit();
    await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    const opened = await service.open('u1', id);
    expect(opened).toMatchObject({ trackerEntryId: 'trk_j1', alreadyApplied: false });
    // Queued, never inline: opening the form does not wait for the export.
    expect(calls.files).toEqual([]);
    expect(calls.recordFiles).toEqual([{ queueItemId: id, userId: 'u1' }]);

    // The `agent.record-files` worker: the export carries the application's tracker entry.
    expect(await service.recordKitFiles(calls.recordFiles[0]!)).toBe('recorded');
    expect(calls.files).toEqual([{ variantId: 'rv_tailored1', trackerEntryId: 'trk_j1', nameStyle: 'name_company_role' }]);
    const history = await service.history('u1', id);
    const move = history.items.find((e) => e.toState === 'opened' && e.fromState === 'approved')!;
    expect(move.detail).toMatchObject({ via: 'apply_click', alreadyApplied: false, artifactId: 'art_1', fileName: 'Ana_Lima_Company_Role.pdf' });
    // A retried job, or opening the form again, records nothing twice.
    expect(await service.recordKitFiles(calls.recordFiles[0]!)).toBe('already');
    await service.open('u1', id);
    expect(calls.recordFiles).toHaveLength(1);
    expect(calls.files).toHaveLength(1);
  });

  it('a job that was already Applied still gets its file recorded; an undone kit, or a kit with no resume, records nothing', async () => {
    const applied = await readyKit({
      recordApplyClick: async (_u, jobId) => ({ applyUrl: 'https://x.test', atsType: null, extensionSupported: false, trackerEntryId: `trk_${jobId}`, alreadyApplied: true }),
    });
    await applied.service.confirmPart('u1', applied.id, { part: 'resume', decision: 'use' });
    expect((await applied.service.open('u1', applied.id)).alreadyApplied).toBe(true);
    expect(await applied.service.recordKitFiles(applied.calls.recordFiles[0]!)).toBe('recorded');
    expect(applied.calls.files[0]).toMatchObject({ trackerEntryId: 'trk_j1' });

    const undone = await readyKit();
    await undone.service.confirmPart('u1', undone.id, { part: 'resume', decision: 'use' });
    await undone.service.open('u1', undone.id);
    await undone.service.undoApplied('u1', undone.id);
    expect(await undone.service.recordKitFiles(undone.calls.recordFiles[0]!)).toBe('stale');
    expect(undone.calls.files).toEqual([]);
    expect(await undone.service.recordKitFiles({ queueItemId: 'nope', userId: 'u1' })).toBe('stale');
    expect(await undone.service.recordKitFiles({ queueItemId: undone.id, userId: 'u2' })).toBe('stale');
  });

  it('a queue that cannot take the file job never blocks opening the application', async () => {
    const { service, id } = await readyKit({ enqueueRecordFiles: async () => Promise.reject(new Error('queue down')) });
    await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    await expect(service.open('u1', id)).resolves.toMatchObject({ applyUrl: 'https://jobs.example.test/j1', item: { state: 'opened' } });
  });

  it('Undo does not touch the tracker when the job was already Applied before opening', async () => {
    const { service, calls, id } = await readyKit({
      recordApplyClick: async (_u, jobId) => ({ applyUrl: 'https://x.test', atsType: null, extensionSupported: false, trackerEntryId: `trk_${jobId}`, alreadyApplied: true }),
    });
    await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    expect((await service.open('u1', id)).alreadyApplied).toBe(true);
    await service.undoApplied('u1', id);
    expect(calls.undoClicks).toEqual([]);
  });

  it('a letter in the kit must be used too before approval', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j2', state: 'preparing' });
    const { service } = makeDeps(db);
    await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' });
    expect((await service.confirmPart('u1', id, { part: 'resume', decision: 'use' })).state).toBe('ready_for_review');
    expect((await service.confirmPart('u1', id, { part: 'letter', decision: 'use' })).state).toBe('approved');
    // Revising the letter sends the kit back for another look.
    expect((await service.confirmPart('u1', id, { part: 'letter', decision: 'revise', instruction: 'Shorter' })).state).toBe('ready_for_review');
  });

  it('revise resume re-queues tailoring with the instruction (no new kit credit)', async () => {
    const { service, calls, id } = await readyKit();
    const v = await service.confirmPart('u1', id, { part: 'resume', decision: 'revise', instruction: 'Lead with SQL' });
    expect(v.state).toBe('preparing');
    // The seeded kit skipped the picked → preparing step, so this is the first `preparing` transition on record.
    expect(calls.enqueued.at(-1)).toEqual({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: null, part: 'resume', instruction: 'Lead with SQL' });
    expect(calls.reserved).toEqual([]);
  });

  it('a failed revision keeps the kit the user had, back in review with the reason', async () => {
    let fail = false;
    const { service, calls, id, db } = await readyKit({
      tailor: async (_u, input) => {
        if (fail) throw Object.assign(new Error('x'), { code: 'ai_unavailable', details: { reason: 'ai_failed' } });
        return (await import('./testkit.js')).session('ts1', { jobId: input.jobId, resultVariantId: 'rv_tailored1' });
      },
    });
    fail = true;
    await service.confirmPart('u1', id, { part: 'resume', decision: 'revise', instruction: 'Shorter' });
    const payload = calls.enqueued.at(-1)!;
    expect(await service.runPrepare(payload)).toBe('failed');
    const [item] = await rows(db, 'rAAgentQueueItem', { id });
    expect(item).toMatchObject({ state: 'ready_for_review', resumeVariantId: 'rv_tailored1', lastError: 'ai_unavailable:ai_failed' });
  });

  it('revise is unavailable without AI', async () => {
    const { service, id } = await readyKit({ aiAvailable: async () => false });
    await expect(service.confirmPart('u1', id, { part: 'resume', decision: 'revise' })).rejects.toMatchObject({ code: 'ai_unavailable' });
  });

  it('a closed post turns the kit expired when opened', async () => {
    const closed = Object.assign(new Error('closed'), { code: 'conflict', status: 409, details: { code: 'job_closed' } });
    const { service, id } = await readyKit({ recordApplyClick: async () => Promise.reject(closed) });
    await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    await expect(service.open('u1', id)).rejects.toBe(closed);
    expect((await service.listQueue('u1', {})).items[0]!.state).toBe('expired');
  });

  it('"I applied" without a link uses the tracker mark, and Undo reverts exactly that mark', async () => {
    const { service, calls, id } = await readyKit();
    await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    const applied = await service.markApplied('u1', id);
    expect(applied).toMatchObject({ state: 'applied', trackerEntryId: 'trk_j1' });
    expect(calls.marks).toEqual(['j1']);
    expect((await service.undoApplied('u1', id)).state).toBe('approved');
    expect(calls.undoMarks).toEqual(['j1']);
    expect(calls.undoClicks).toEqual([]);
  });

  it('the extension\'s "I submitted" is the only way userMarkedSubmitted becomes true', async () => {
    const { service, id, db } = await readyKit();
    await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    await service.open('u1', id);
    expect((await rows(db, 'rAAgentQueueItem', { id }))[0]!.userMarkedSubmitted).toBe(false);
    await service.markUserSubmitted('u1', 'j1');
    const [item] = await rows(db, 'rAAgentQueueItem', { id });
    expect(item).toMatchObject({ state: 'applied', userMarkedSubmitted: true });
    const ev = await service.history('u1', id);
    expect(ev.items.at(-1)).toMatchObject({ actor: 'extension', fromState: 'opened', toState: 'applied' });
    await service.markUserSubmitted('u1', 'no-such-job'); // no item: nothing happens
  });

  it('skip, restore and remove; nothing changes while a kit is preparing', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1' });
    const busy = await seedItem(db, { jobId: 'j2', state: 'preparing' });
    const { service } = makeDeps(db);
    expect((await service.skip('u1', id)).state).toBe('skipped');
    expect((await service.restore('u1', id)).state).toBe('picked');
    await expect(service.skip('u1', busy)).rejects.toMatchObject({ details: { reason: 'kit_preparing' } });
    await expect(service.remove('u1', busy)).rejects.toMatchObject({ details: { reason: 'kit_preparing' } });
    await service.remove('u1', id);
    expect(await rows(db, 'rAAgentQueueItem', { id })).toEqual([]);
    await expect(service.skip('u2', busy)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('the kit review screen carries the resume, letter, answers, file name and history', async () => {
    const { service, id, db } = await readyKit();
    await (db as unknown as { rAAnswerBankItem: { create: (a: unknown) => Promise<unknown> } }).rAAnswerBankItem.create({
      data: { userId: 'u1', questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks', source: 'user', locale: 'en' },
    });
    const d = await service.detail('u1', id);
    expect(d.kit.resume).toMatchObject({ variantId: 'rv_tailored1', tailored: true, pendingClaims: 1, used: false });
    expect(d.kit.letter).toMatchObject({ coverLetterId: null, needed: false });
    expect(d.kit.answers.map((a) => a.questionKey)).toEqual(['notice_period']);
    expect(d.kit.fileName).toBe('Ana_Lima_Company_j1_Role_j1');
    expect(d.history.length).toBeGreaterThan(0);
  });
});

describe('answer bank (F-AGENT-03)', () => {
  it('saves, updates and deletes answers by canonical key; refuses unknown keys', async () => {
    const db = makeDb();
    const { service } = makeDeps(db);
    let r = await service.putAnswers('u1', [
      { questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks', locale: 'en' },
      { questionKey: 'salary_expectation:USD', questionText: 'Salary?', answer: '120,000 a year', locale: 'en' },
    ]);
    expect(r.items.map((a) => [a.questionKey, a.answer, a.source])).toEqual([
      ['notice_period', 'Two weeks', 'user'],
      ['salary_expectation:USD', '120,000 a year', 'user'],
    ]);
    r = await service.putAnswers('u1', [{ questionKey: 'notice_period', questionText: 'Notice period?', answer: 'One month', locale: 'en' }]);
    expect(r.items.find((a) => a.questionKey === 'notice_period')!.answer).toBe('One month');
    r = await service.putAnswers('u1', [{ questionKey: 'notice_period', questionText: 'Notice period?', answer: '  ', locale: 'en' }]);
    expect(r.items.map((a) => a.questionKey)).toEqual(['salary_expectation:USD']);
    r = await service.deleteAnswer('u1', 'salary_expectation:USD');
    expect(r.items).toEqual([]);
    await expect(service.putAnswers('u1', [{ questionKey: 'political_status', questionText: '政治面貌', answer: '群众', locale: 'zh' }])).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'invalid_question_key', keys: ['political_status'] },
    });
  });

  it('GoApply accepts the optional 家庭成员 / 政治面貌 keys; the extension can mark answers used', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'goapply');
    await service.putAnswers('u1', [{ questionKey: 'political_status', questionText: '政治面貌', answer: '群众', locale: 'zh' }]);
    await service.markAnswersUsed('u1', ['political_status']);
    const [a] = (await service.listAnswers('u1')).items;
    expect(a).toMatchObject({ questionKey: 'political_status', answer: '群众' });
    expect(a!.lastUsedAt).toBeTruthy();
    expect(service.questions().items.some((q) => q.key === 'family_members')).toBe(true);
  });
});

describe('answer bank: an answer approved in the extension (F-EXT-04)', () => {
  it('saves it under the question as the form asked it, as ai_confirmed; the same question again replaces it', async () => {
    const db = makeDb();
    const { service } = makeDeps(db);
    const first = await service.saveApprovedAnswer('u1', { questionText: '  Why do you want to   work at Acme? ', answer: ' The mission. ' });
    expect(first.questionKey).toMatch(/^custom:[a-f0-9]{16}$/);
    let items = (await service.listAnswers('u1')).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ questionKey: first.questionKey, questionText: 'Why do you want to work at Acme?', answer: 'The mission.', source: 'ai_confirmed', locale: 'en' });
    const again = await service.saveApprovedAnswer('u1', { questionText: 'why do you want to work at acme?', answer: 'The team.', locale: 'en' });
    expect(again.questionKey).toBe(first.questionKey);
    items = (await service.listAnswers('u1')).items;
    expect(items.map((a) => a.answer)).toEqual(['The team.']);
    await expect(service.saveApprovedAnswer('u1', { questionText: '   ', answer: 'x' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.saveApprovedAnswer('u1', { questionText: 'Why us?', answer: '  ' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('GoApply saves in its own default language', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'goapply');
    await service.saveApprovedAnswer('u1', { questionText: '为什么想加入我们？', answer: '因为团队。' });
    expect((await service.listAnswers('u1')).items[0]).toMatchObject({ locale: 'zh', source: 'ai_confirmed' });
  });
});

describe('kit history kinds (SCHEMA-4, SR-52-3)', () => {
  it('every new row carries its kind: transition, decision and notice', async () => {
    const db = makeDb();
    const { service } = makeDeps(db, 'roboapply', { feedPreview: async () => [feedItem('j1', 'great')] });
    const list = await service.generateList('u1', { source: 'user' });
    const id = list.items[0]!.id;
    await (db as unknown as { rAAgentQueueItem: { update: (a: unknown) => Promise<unknown> } }).rAAgentQueueItem.update({ where: { id }, data: { state: 'preparing' } });
    await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' });
    await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    const stored = await rows(db, 'rAAgentKitEvent', { queueItemId: id });
    // null → picked, the "list ready" notice, preparing → ready, the "use" decision, ready → approved.
    expect(stored.map((e) => [e.fromState, e.toState, e.kind])).toEqual([
      [null, 'picked', 'transition'],
      ['picked', 'picked', 'notice'],
      ['preparing', 'ready_for_review', 'transition'],
      ['ready_for_review', 'ready_for_review', 'decision'],
      ['ready_for_review', 'approved', 'transition'],
    ]);
    expect(stored.every((e) => typeof e.kind === 'string')).toBe(true);
    expect((await service.history('u1', id)).items.map((e) => e.kind)).toEqual(['transition', 'notice', 'transition', 'decision', 'transition']);
  });

  it('a row from before the column (kind null) is derived, never read as a transition', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'ready_for_review' });
    const ev = (db as unknown as { rAAgentKitEvent: { create: (a: unknown) => Promise<unknown> } }).rAAgentKitEvent;
    const at = (n: number) => new Date(NOW_MS + n * 1000);
    await ev.create({ data: { userId: 'u1', queueItemId: id, fromState: 'preparing', toState: 'ready_for_review', actor: 'system', kind: null, detail: null, createdAt: at(1) } });
    await ev.create({ data: { userId: 'u1', queueItemId: id, fromState: 'ready_for_review', toState: 'ready_for_review', actor: 'user', kind: null, detail: { part: 'resume', decision: 'use' }, createdAt: at(2) } });
    await ev.create({ data: { userId: 'u1', queueItemId: id, fromState: 'ready_for_review', toState: 'ready_for_review', actor: 'system', kind: null, detail: { notice: 'kit_not_opened', sent: true }, createdAt: at(3) } });
    // A stored kind wins over what the states suggest; an unknown value is derived.
    await ev.create({ data: { userId: 'u1', queueItemId: id, fromState: 'ready_for_review', toState: 'ready_for_review', actor: 'system', kind: 'notice', detail: null, createdAt: at(4) } });
    await ev.create({ data: { userId: 'u1', queueItemId: id, fromState: 'ready_for_review', toState: 'ready_for_review', actor: 'user', kind: 'something_else', detail: null, createdAt: at(5) } });
    const { service } = makeDeps(db);
    expect((await service.history('u1', id)).items.map((e) => e.kind)).toEqual(['transition', 'decision', 'notice', 'notice', 'decision']);
    expect(kitEventKind({ fromState: 'approved', toState: 'approved', detail: null, kind: null })).toBe('decision');
    expect(kitEventKind({ fromState: 'approved', toState: 'approved', detail: null })).toBe('decision');
    expect(kitEventKind({ fromState: 'approved', toState: 'opened', detail: null, kind: null })).toBe('transition');
    expect(deriveKitEventKind('approved', 'approved', { notice: 'kit_not_opened' })).toBe('notice');
    // The legacy "use" decision still counts toward approving the kit.
    const approved = await service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    expect(approved.state).toBe('approved');
  });
});

describe('review findings: kit and tracker stay in agreement', () => {
  async function openedKit(overrides: Parameters<typeof makeDeps>[2] = {}) {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const kit = makeDeps(db, 'roboapply', overrides);
    await kit.service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' });
    await kit.service.confirmPart('u1', id, { part: 'resume', decision: 'use' });
    return { db, id, ...kit };
  }

  it('Undo the tracker can no longer revert: 409 kit_undo_expired, the kit stays opened as it was, every time', async () => {
    const undone: string[] = [];
    const { service, id, db } = await openedKit({
      undoApplyClick: async (_u, jobId) => {
        undone.push(jobId);
        return { reverted: false };
      },
    });
    await service.open('u1', id);
    const [before] = await rows(db, 'rAAgentQueueItem', { id });
    for (let i = 0; i < 2; i += 1) {
      await expect(service.undoApplied('u1', id)).rejects.toMatchObject({ code: 'conflict', status: 409, details: { reason: 'kit_undo_expired' } });
      const [item] = await rows(db, 'rAAgentQueueItem', { id });
      expect(item).toMatchObject({ state: 'opened', trackerEntryId: 'trk_j1' });
      expect((item!.openedAt as Date).getTime()).toBe((before!.openedAt as Date).getTime());
      const last = (await service.history('u1', id)).items.at(-1)!;
      expect(last).toMatchObject({ fromState: 'approved', toState: 'opened', actor: 'system' });
      expect(last.detail).toMatchObject({ via: 'undo_refused', error: 'kit_undo_expired', alreadyApplied: false });
    }
    expect(undone).toEqual(['j1', 'j1']);
  });

  it('a tracker undo that throws puts the kit back and rethrows; a later Undo still works', async () => {
    let broken = true;
    const undoMarks: string[] = [];
    const { service, id, db } = await openedKit({
      undoMarkApplied: async (_u, jobId) => {
        if (broken) throw new Error('tracker unavailable');
        undoMarks.push(jobId);
        return { reverted: true };
      },
    });
    await service.markApplied('u1', id);
    const [before] = await rows(db, 'rAAgentQueueItem', { id });
    await expect(service.undoApplied('u1', id)).rejects.toThrow('tracker unavailable');
    const [item] = await rows(db, 'rAAgentQueueItem', { id });
    expect(item).toMatchObject({ state: 'applied', trackerEntryId: 'trk_j1' });
    expect((item!.completedAt as Date).getTime()).toBe((before!.completedAt as Date).getTime());
    expect((await service.history('u1', id)).items.at(-1)!.detail).toMatchObject({ via: 'undo_refused', error: 'undo_failed', applyMark: { entryId: 'trk_j1' } });
    broken = false;
    expect((await service.undoApplied('u1', id)).state).toBe('approved');
    expect(undoMarks).toEqual(['j1']);
  });
});

describe('review findings: preparation failures and credits', () => {
  it('an unexpected tailor fault is retried; on the last attempt the kit fails as internal and its credit is released', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const { service, calls } = makeDeps(db, 'roboapply', { tailor: async () => Promise.reject(new Error('socket hang up')) });
    const payload = { queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'res1', part: 'all' as const };
    await expect(service.runPrepare(payload)).rejects.toThrow('socket hang up');
    expect((await rows(db, 'rAAgentQueueItem', { id }))[0]).toMatchObject({ state: 'preparing' });
    expect(calls.released).toEqual([]);
    expect(await service.runPrepare(payload, { finalAttempt: true })).toBe('failed');
    expect((await rows(db, 'rAAgentQueueItem', { id }))[0]).toMatchObject({ state: 'failed', lastError: 'internal' });
    expect(calls.released).toEqual(['res1']);
    expect(calls.committed).toEqual([]);
  });

  it('two confirms at once (double click) share one reservation: the kit starts once and nothing is released', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1' });
    let n = 0;
    let bothIn!: () => void;
    const barrier = new Promise<void>((resolve) => (bothIn = resolve));
    const { service, calls } = makeDeps(db, 'roboapply', {
      reserveKit: async (_u, key) => {
        n += 1;
        const replayed = n > 1; // the credit service returns the same ledger row to the second caller
        if (n === 2) bothIn();
        await barrier;
        return { id: `res_${key}`, replayed };
      },
    });
    const results = await Promise.allSettled([service.prepare('u1', [id], true), service.prepare('u1', [id], true)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    for (const r of results) expect((r as PromiseFulfilledResult<{ started?: string[] }>).value.started).toEqual([id]);
    expect(calls.released).toEqual([]);
    expect(calls.enqueued).toHaveLength(1);
    expect((await rows(db, 'rAAgentQueueItem', { id }))[0]).toMatchObject({ state: 'preparing' });
  });

  it('a new reservation that could not start the kit is released (no twin holds it)', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1' });
    const { service, calls } = makeDeps(db, 'roboapply', {
      reserveKit: async (_u, key) => {
        // Another window skipped the job between the read and the move.
        await (db as unknown as { rAAgentQueueItem: { updateMany: (a: unknown) => Promise<unknown> } }).rAAgentQueueItem.updateMany({ where: { id }, data: { state: 'skipped' } });
        return { id: `res_${key}`, replayed: false };
      },
    });
    await expect(service.prepare('u1', [id], true)).rejects.toMatchObject({ code: 'conflict' });
    expect(calls.released).toEqual([`res_ready_kit:${id}:1`]);
  });

  it('the review screen shows what a revision costs; with no credits left Revise is 402 before any work', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const { service, calls } = makeDeps(db, 'roboapply', {
      creditUsage: async () => ({ lines: { tailor: usageLine(0), cover_letter: usageLine(4), ready_kits: usageLine(3, 'week') }, upgradable: true }),
    });
    await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' });
    const d = await service.detail('u1', id);
    expect(d.kit.revisionCost).toEqual({
      resume: expect.objectContaining({ bucket: 'tailor', cost: 1, remaining: 0, window: 'day' }),
      letter: expect.objectContaining({ bucket: 'cover_letter', cost: 1, remaining: 4 }),
    });
    const queued = calls.enqueued.length;
    await expect(service.confirmPart('u1', id, { part: 'resume', decision: 'revise', instruction: 'Shorter' })).rejects.toMatchObject({
      code: 'credits_exhausted',
      bucket: 'tailor',
      upgradable: true,
    });
    expect(calls.enqueued).toHaveLength(queued);
    expect((await rows(db, 'rAAgentQueueItem', { id }))[0]).toMatchObject({ state: 'ready_for_review' });
  });

  it('without AI the review screen offers no revision cost', async () => {
    const db = makeDb();
    const id = await seedItem(db, { jobId: 'j1', state: 'preparing' });
    const { service } = makeDeps(db, 'roboapply', { aiAvailable: async () => false });
    await service.runPrepare({ queueItemId: id, userId: 'u1', attempt: 1, reservationId: 'r1', part: 'all' });
    expect((await service.detail('u1', id)).kit.revisionCost).toBeNull();
  });
});

describe('review findings: the stale-preparing sweep', () => {
  it('moves kits stuck in preparing for 30+ minutes to failed (a revision back to review), releases their credit, and leaves other brands alone', async () => {
    const at = (min: number) => new Date(NOW_MS - min * 60_000);
    const db = makeDb({ user: [{ id: 'u1', brand: 'roboapply' }, { id: 'u2', brand: 'goapply' }] });
    const kit = await seedItem(db, { jobId: 'j1', state: 'preparing', updatedAt: at(31) });
    const revision = await seedItem(db, { jobId: 'j2', state: 'preparing', resumeVariantId: 'rv_t', updatedAt: at(45) });
    const fresh = await seedItem(db, { jobId: 'j3', state: 'preparing', updatedAt: at(10) });
    const other = await seedItem(db, { userId: 'u2', jobId: 'j4', state: 'preparing', updatedAt: at(60) });
    const ev = (db as unknown as { rAAgentKitEvent: { create: (a: unknown) => Promise<unknown> } }).rAAgentKitEvent;
    await ev.create({ data: { userId: 'u1', queueItemId: kit, fromState: 'picked', toState: 'preparing', actor: 'user', detail: { attempt: 1, creditLedgerId: 'led_kit' } } });
    await ev.create({ data: { userId: 'u1', queueItemId: revision, fromState: 'ready_for_review', toState: 'preparing', actor: 'user', detail: { attempt: 2, part: 'resume', decision: 'revise' } } });
    await ev.create({ data: { userId: 'u1', queueItemId: fresh, fromState: 'picked', toState: 'preparing', actor: 'user', detail: { attempt: 1, creditLedgerId: 'led_fresh' } } });
    await ev.create({ data: { userId: 'u2', queueItemId: other, fromState: 'picked', toState: 'preparing', actor: 'user', detail: { attempt: 1, creditLedgerId: 'led_other' } } });
    const { service, calls } = makeDeps(db);
    expect(await service.sweepStalePreparing({ brand: 'roboapply', now: new Date(NOW_MS) })).toEqual({ swept: 2, scanned: 3 });
    const state = async (id: string) => (await rows(db, 'rAAgentQueueItem', { id }))[0]!;
    expect(await state(kit)).toMatchObject({ state: 'failed', lastError: 'prepare_timeout' });
    expect(await state(revision)).toMatchObject({ state: 'ready_for_review', resumeVariantId: 'rv_t', lastError: 'prepare_timeout' });
    expect(await state(fresh)).toMatchObject({ state: 'preparing' });
    expect(await state(other)).toMatchObject({ state: 'preparing' });
    expect(calls.released).toEqual(['led_kit']);
  });
});

describe('review findings: list pages and tab counts', () => {
  it('filters by tab before the page limit, pages with a cursor, and counts every item per tab', async () => {
    const db = makeDb();
    const t = (min: number) => new Date(NOW_MS - min * 60_000);
    for (const [i, j] of ['j1', 'j2', 'j3', 'j4', 'j5'].entries()) await seedItem(db, { jobId: j, state: 'picked', updatedAt: t(i + 1) });
    await seedItem(db, { jobId: 'j6', state: 'opened', updatedAt: t(0) });
    const { service } = makeDeps(db);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const r = await service.listQueue('u1', { tab: 'to_prepare', limit: 2, cursor });
      expect(r.counts).toEqual({ to_prepare: 5, ready: 0, done: 1 });
      seen.push(...r.items.map((i) => i.jobId));
      cursor = r.nextCursor ?? undefined;
      if (page < 2) expect(cursor).toBeTruthy();
    }
    expect(seen).toEqual(['j1', 'j2', 'j3', 'j4', 'j5']);
    expect(cursor).toBeUndefined();
    await expect(service.listQueue('u1', { cursor: 'bm90LWEtY3Vyc29y' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
