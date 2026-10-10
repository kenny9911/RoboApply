// @vitest-environment node
//
// WP-38: the tracker core over the fake Prisma (no database). Covers the
// acceptance rules: every PATCH change writes an RATrackerEvent, a move to
// applied stamps dateApplied, the GoApply ladder, outcomes, undo, list
// filters, files sent and follow-up facts.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Prisma } from '../../generated/prisma/client.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { trackerEntryLockKey } from '../jobs/detail/service.js';
import { createTrackerCore, TrackerDuplicateError, TrackerInvalidInputError, TrackerNotFoundError, type TrackerDb } from './service.js';
import type { TrackerMarket } from './stages.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;

let fake = createFakePrisma();
let market: TrackerMarket = 'intl';

function makeFake() {
  return createFakePrisma({
    timestampFields: ['createdAt', 'updatedAt', 'dateSaved'],
    defaults: {
      rATrackerEntry: {
        excitementStars: 0,
        deletedAt: null,
        jobId: null,
        externalSnapshot: null,
        dateApplied: null,
        deadline: null,
        followUpAt: null,
        interviewAt: null,
        outcome: null,
        stageDetail: null,
        offer: null,
        appliedVia: null,
        linkedRunId: null,
        source: null,
        notesMarkdown: null,
        maxSalary: null,
        maxSalaryCurrency: null,
        tailoredVariantId: null,
        coverLetterId: null,
      },
      rATrackerEvent: { fromValue: null, toValue: null, payload: null },
    },
    seed: {
      rAJob: [
        {
          id: 'job1',
          title: 'Data Analyst',
          companyName: 'Acme',
          companyLogoUrl: null,
          location: 'Austin, TX',
          workType: 'hybrid',
          applyUrl: 'https://acme.example/jobs/1',
          closedAt: null,
          archivedAt: null,
          expiresAt: null,
          salaryMax: 90000,
          salaryCurrency: 'USD',
        },
        {
          id: 'job2',
          title: 'Product Manager',
          companyName: 'Globex',
          companyLogoUrl: null,
          location: null,
          workType: 'remote',
          applyUrl: 'https://globex.example/jobs/2',
          closedAt: new Date('2026-10-01T00:00:00Z'),
          archivedAt: null,
          expiresAt: null,
          salaryMax: null,
          salaryCurrency: null,
        },
      ],
    },
  });
}

const core = createTrackerCore({
  getDb: async () => fake as unknown as TrackerDb,
  now: () => NOW,
  market: () => market,
});

const events = (entryId?: string) =>
  fake.$rows('rATrackerEvent').filter((e) => !entryId || e.entryId === entryId) as Array<Record<string, unknown>>;

// The writers take the (user, job) advisory lock whose key lives in the job
// detail area; that module is loaded on first use. Load it once up front so no
// single test pays for the import.
beforeAll(async () => {
  await import('../jobs/detail/index.js');
}, 60_000);

beforeEach(() => {
  fake = makeFake();
  market = 'intl';
});

describe('create', () => {
  it('creates a saved job with a created event and the job salary', async () => {
    const entry = await core.create('u1', { jobId: 'job1' });
    expect(entry.status).toBe('bookmarked');
    expect(entry.maxSalary).toBe(90000);
    expect(entry.source).toBe('feed');
    expect(entry.job?.companyName).toBe('Acme');
    expect(entry.job?.closed).toBe(false);
    expect(events(entry.id).map((e) => e.kind)).toEqual(['created']);
  });

  it('creates a manual entry at applied and stamps dateApplied', async () => {
    const entry = await core.create('u1', { externalSnapshot: { title: 'Analyst', companyName: 'Initech', applyUrl: null }, status: 'applied' });
    expect(entry.dateApplied).toBe(NOW.toISOString());
    expect(entry.appliedVia).toBe('manual');
    expect(entry.source).toBe('manual');
    expect(entry.externalSnapshot?.companyName).toBe('Initech');
  });

  it('refuses a duplicate live entry and an unknown job', async () => {
    await core.create('u1', { jobId: 'job1' });
    await expect(core.create('u1', { jobId: 'job1' })).rejects.toBeInstanceOf(TrackerDuplicateError);
    await expect(core.create('u1', { jobId: 'nope' })).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it('refuses a GoApply stage on RoboApply', async () => {
    await expect(core.create('u1', { jobId: 'job1', status: 'written_test' })).rejects.toBeInstanceOf(TrackerInvalidInputError);
  });
});

describe('patch writes an event for every change', () => {
  it('status → applied stamps dateApplied and records one status event', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    const out = await core.patch('u1', id, { status: 'applied' });
    expect(out.status).toBe('applied');
    expect(out.dateApplied).toBe(NOW.toISOString());
    const ev = events(id).filter((e) => e.kind === 'status');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fromValue: 'bookmarked', toValue: 'applied', payload: { stampedDateApplied: true } });
  });

  it('keeps an existing dateApplied when moving back to applied', async () => {
    const { id } = await core.create('u1', { jobId: 'job1', status: 'applied', dateApplied: '2026-09-01T00:00:00.000Z' });
    await core.patch('u1', id, { status: 'interviewing' });
    const out = await core.patch('u1', id, { status: 'applied' });
    expect(out.dateApplied).toBe('2026-09-01T00:00:00.000Z');
  });

  it('records interview, follow-up, offer, notes, deadline and salary edits', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    await core.patch('u1', id, {
      interviewAt: '2026-10-12T15:00:00.000Z',
      followUpAt: '2026-10-20T09:00:00.000Z',
      offer: { base: 100000, currency: 'USD', period: 'year' },
      notesMarkdown: 'Recruiter: Sam',
      deadline: '2026-10-30',
      maxSalary: 95000,
    });
    const kinds = events(id).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['interview', 'follow_up', 'offer', 'field']));
    const fields = events(id)
      .filter((e) => e.kind === 'field')
      .map((e) => (e.payload as { field: string }).field);
    expect(fields.sort()).toEqual(['deadline', 'maxSalary', 'notesMarkdown']);
    // The note text is never copied into the event.
    expect(JSON.stringify(events(id))).not.toContain('Recruiter: Sam');
  });

  it('writes nothing for a no-op patch', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    const before = events(id).length;
    await core.patch('u1', id, { status: 'bookmarked', excitementStars: 0 });
    expect(events(id)).toHaveLength(before);
  });

  it('an outcome moves the entry to its terminal status; leaving it clears the outcome', async () => {
    const { id } = await core.create('u1', { jobId: 'job1', status: 'applied' });
    const ended = await core.patch('u1', id, { outcome: 'i_withdrew' });
    expect(ended).toMatchObject({ status: 'withdrawn', outcome: 'i_withdrew' });
    const outcomeEvent = events(id).find((e) => e.kind === 'outcome');
    expect(outcomeEvent).toMatchObject({ toValue: 'i_withdrew', payload: { stage: 'applied' } });
    const back = await core.patch('u1', id, { status: 'interviewing' });
    expect(back.outcome).toBeNull();
    const rejected = await core.patch('u1', id, { status: 'rejected' });
    expect(rejected.outcome).toBe('they_said_no');
  });

  it('refuses an outcome that contradicts the status', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    await expect(core.patch('u1', id, { status: 'offer', outcome: 'job_pulled' })).rejects.toBeInstanceOf(TrackerInvalidInputError);
  });

  it('404s on another user’s entry', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    await expect(core.patch('u2', id, { status: 'applied' })).rejects.toBeInstanceOf(TrackerNotFoundError);
  });
});

describe('GoApply ladder', () => {
  beforeEach(() => {
    market = 'cn';
  });

  it('accepts 测评 / 笔试 / AI面试 / 三方 and interview rounds', async () => {
    const { id } = await core.create('u1', { jobId: 'job1', status: 'applied' });
    for (const status of ['assessment', 'written_test', 'ai_interview'] as const) {
      expect((await core.patch('u1', id, { status })).status).toBe(status);
    }
    const round = await core.patch('u1', id, { status: 'interviewing', stageDetail: 'mianshi_2' });
    expect(round.stageDetail).toBe('mianshi_2');
    const signed = await core.patch('u1', id, { status: 'signed' });
    expect(signed.status).toBe('signed');
    // The round no longer fits the stage, so it is dropped (with a `stage` event).
    expect(signed.stageDetail).toBeNull();
    expect(events(id).filter((e) => e.kind === 'stage').map((e) => e.toValue)).toEqual(['mianshi_2', null]);
  });

  it('refuses RoboApply-only stages and unknown rounds', async () => {
    const { id } = await core.create('u1', { jobId: 'job1', status: 'applied' });
    await expect(core.patch('u1', id, { status: 'first_call' })).rejects.toBeInstanceOf(TrackerInvalidInputError);
    await expect(core.patch('u1', id, { status: 'interviewing', stageDetail: 'onsite' })).rejects.toBeInstanceOf(TrackerInvalidInputError);
    await expect(core.patch('u1', id, { stageDetail: 'mianshi_1' })).rejects.toBeInstanceOf(TrackerInvalidInputError);
  });
});

describe('list', () => {
  it('counts every status, filters by status, source and q, and sorts by date', async () => {
    const a = await core.create('u1', { jobId: 'job1', status: 'applied', dateApplied: '2026-10-01T00:00:00.000Z' });
    const b = await core.create('u1', { externalSnapshot: { title: 'Backend Engineer', companyName: 'Initech' }, notesMarkdown: 'met at meetup' });
    const g = await core.create('u1', { jobId: 'job2', status: 'applied', dateApplied: '2026-10-05T00:00:00.000Z' });
    await core.create('u2', { jobId: 'job1' });

    const all = await core.list('u1');
    expect(all.total).toBe(3);
    expect(all.statusCounts).toMatchObject({ applied: 2, bookmarked: 1, first_call: 0, negotiating: 0 });

    expect((await core.list('u1', { status: 'bookmarked' })).entries.map((e) => e.id)).toEqual([b.id]);
    expect((await core.list('u1', { source: 'manual' })).entries.map((e) => e.id)).toEqual([b.id]);
    expect((await core.list('u1', { q: 'ACME' })).entries.map((e) => e.id)).toEqual([a.id]);
    expect((await core.list('u1', { q: 'meetup' })).entries.map((e) => e.id)).toEqual([b.id]);

    const byDate = await core.list('u1', { view: 'date' });
    // Applied date, else saved date, newest first (b was saved "today").
    expect(byDate.entries.map((e) => e.id)).toEqual([b.id, g.id, a.id]);
    expect(byDate.entries[1]!.job?.closed).toBe(true);
  });

  it('hides soft-deleted entries everywhere', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    await core.remove('u1', id);
    expect((await core.list('u1')).total).toBe(0);
    await expect(core.getById('u1', id)).rejects.toBeInstanceOf(TrackerNotFoundError);
    // The job can be saved again.
    await expect(core.create('u1', { jobId: 'job1' })).resolves.toBeTruthy();
  });
});

describe('bulk', () => {
  it('moves several entries with one event each and refuses foreign ids', async () => {
    const a = await core.create('u1', { jobId: 'job1' });
    const b = await core.create('u1', { jobId: 'job2' });
    const out = await core.bulk('u1', { ids: [a.id, b.id], patch: { status: 'applied' } });
    expect(out.entries.every((e) => e.status === 'applied' && e.dateApplied === NOW.toISOString())).toBe(true);
    expect(events().filter((e) => e.kind === 'status')).toHaveLength(2);
    const c = await core.create('u2', { jobId: 'job1' });
    await expect(core.bulk('u1', { ids: [a.id, c.id], patch: { status: 'offer' } })).rejects.toBeInstanceOf(TrackerInvalidInputError);
  });
});

describe('markApplied / undoApplied (ruling C11)', () => {
  it('moves a saved job to applied and undo with the token restores Saved with no applied date', async () => {
    const saved = await core.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    const mark = await core.markApplied('u1', 'job1', 'apply_click');
    expect(mark).toMatchObject({ entryId: saved.id, changed: true });
    expect(mark.eventId).toEqual(expect.any(String));
    expect((await core.getById('u1', mark.entryId)).appliedVia).toBe('apply_click');
    expect(await core.undoApplied('u1', 'job1', { mark })).toEqual({ undone: true });
    const after = await core.getById('u1', mark.entryId);
    expect(after).toMatchObject({ status: 'bookmarked', dateApplied: null, appliedVia: null });
    expect(events(mark.entryId).at(-1)).toMatchObject({ kind: 'status', toValue: 'bookmarked', payload: { undo: true } });
  });

  it('undo removes an entry that the apply click created', async () => {
    const mark = await core.markApplied('u1', 'job1', 'agent_open');
    expect((await core.getById('u1', mark.entryId)).source).toBe('agent');
    expect(await core.undoApplied('u1', 'job1', { mark })).toEqual({ undone: true });
    await expect(core.getById('u1', mark.entryId)).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it('saving never moves an entry backwards', async () => {
    await core.markApplied('u1', 'job1', 'manual');
    const again = await core.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    expect(again.status).toBe('applied');
  });

  it.each(['interviewing', 'offer', 'first_call'] as const)('applying never moves an entry at %s back to Applied', async (status) => {
    const saved = await core.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    await core.patch('u1', saved.id, { status });
    const before = events(saved.id).length;
    const mark = await core.markApplied('u1', 'job1', 'apply_click');
    // Nothing moved: every apply surface says so with `alreadyApplied` (no Undo is offered).
    expect(mark).toEqual({ entryId: saved.id, changed: false, eventId: null, alreadyApplied: true });
    expect((await core.getById('u1', saved.id)).status).toBe(status);
    expect(events(saved.id)).toHaveLength(before);
    const legacy = await core.upsertForJob('u1', 'job1', { status: 'applied', appliedVia: 'manual' });
    expect(legacy.status).toBe(status);
  });

  it('a no-op mark then undo leaves the entry untouched (never deletes an entry made by another action)', async () => {
    const first = await core.markApplied('u1', 'job1', 'manual');
    await core.addNote('u1', first.entryId, 'Spoke to the hiring manager.');
    const click = await core.markApplied('u1', 'job1', 'apply_click');
    expect(click.changed).toBe(false);
    expect(await core.undoApplied('u1', 'job1', { mark: click })).toEqual({ undone: false });
    expect(await core.undoApplied('u1', 'job1', { via: 'apply_click' })).toEqual({ undone: false });
    expect((await core.getById('u1', first.entryId)).status).toBe('applied');
  });

  it('undo without a token ignores a move the user made by hand', async () => {
    const saved = await core.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    await core.patch('u1', saved.id, { status: 'applied' });
    expect(await core.undoApplied('u1', 'job1')).toEqual({ undone: false });
    const after = await core.getById('u1', saved.id);
    expect(after.status).toBe('applied');
    expect(after.dateApplied).toBe(NOW.toISOString());
  });

  it('undo without a token only reverts a recent markApplied move', async () => {
    let t = NOW.getTime();
    const timed = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => new Date(t), market: () => market });
    await timed.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    await timed.markApplied('u1', 'job1', 'apply_click');
    t += 11 * 60_000;
    expect(await timed.undoApplied('u1', 'job1', { via: 'apply_click' })).toEqual({ undone: false });
    t = NOW.getTime() + 60_000;
    expect(await timed.undoApplied('u1', 'job1', { via: 'agent_open' })).toEqual({ undone: false });
    expect(await timed.undoApplied('u1', 'job1', { via: 'apply_click' })).toEqual({ undone: true });
  });

  it('a stale token does nothing once the entry has moved on', async () => {
    const saved = await core.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    const mark = await core.markApplied('u1', 'job1', 'apply_click');
    await core.patch('u1', saved.id, { status: 'first_call' });
    expect(await core.undoApplied('u1', 'job1', { mark })).toEqual({ undone: false });
    expect((await core.getById('u1', saved.id)).status).toBe('first_call');
  });

  it('undo keeps an entry the click created once the user has written notes into it', async () => {
    const mark = await core.markApplied('u1', 'job1', 'apply_click');
    await core.addNote('u1', mark.entryId, 'Referral from Sam.');
    expect(await core.undoApplied('u1', 'job1', { mark })).toEqual({ undone: true });
    expect(await core.getById('u1', mark.entryId)).toMatchObject({ status: 'bookmarked', dateApplied: null });
  });

  it('re-applying to an ended entry can be undone back to the ended stage and outcome', async () => {
    const saved = await core.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    await core.patch('u1', saved.id, { status: 'applied' });
    await core.patch('u1', saved.id, { outcome: 'i_withdrew' });
    const ended = await core.getById('u1', saved.id);
    const mark = await core.markApplied('u1', 'job1', 'apply_click');
    expect(mark.changed).toBe(true);
    expect(await core.getById('u1', saved.id)).toMatchObject({ status: 'applied', outcome: null });
    await core.undoApplied('u1', 'job1', { mark });
    expect(await core.getById('u1', saved.id)).toMatchObject({ status: ended.status, outcome: ended.outcome, dateApplied: ended.dateApplied });
  });
});

describe('timeline, files sent, offer seam', () => {
  it('lists events newest first without the reminder ledger, and adds notes', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    fake.$rows('rATrackerEvent').push({ id: 'r1', entryId: id, userId: 'u1', kind: 'reminder', toValue: 'k', fromValue: null, payload: null, createdAt: new Date(NOW.getTime() + 1) });
    const note = await core.addNote('u1', id, 'Called the recruiter.');
    expect(note).toMatchObject({ kind: 'note', payload: { text: 'Called the recruiter.' } });
    const list = await core.events('u1', id);
    expect(list.map((e) => e.kind)).not.toContain('reminder');
    await expect(core.events('u2', id)).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it('lists the exact files sent for the entry', async () => {
    const { id } = await core.create('u1', { jobId: 'job1' });
    fake.$rows('rAApplicationArtifact').push(
      { id: 'a1', userId: 'u1', trackerEntryId: id, kind: 'resume', fileName: 'Jane-Doe-Resume.pdf', format: 'pdf', fileSha256: 'abc', channel: 'download', variantId: 'v1', coverLetterId: null, createdAt: NOW },
      { id: 'a2', userId: 'u2', trackerEntryId: id, kind: 'resume', fileName: 'other.pdf', format: 'pdf', fileSha256: 'def', channel: 'download', variantId: null, coverLetterId: null, createdAt: NOW },
    );
    expect(await core.artifacts('u1', id)).toEqual([
      { id: 'a1', kind: 'resume', fileName: 'Jane-Doe-Resume.pdf', format: 'pdf', sha256: 'abc', via: 'download', variantId: 'v1', coverLetterId: null, createdAt: NOW.toISOString() },
    ]);
  });

  it('updateOffer writes the offer and an offer event', async () => {
    const { id } = await core.create('u1', { jobId: 'job1', status: 'offer' });
    await core.updateOffer('u1', id, { base: 120000, currency: 'USD', period: 'year' });
    expect((await core.getById('u1', id)).offer).toMatchObject({ base: 120000 });
    await core.updateOffer('u1', id, null);
    expect((await core.getById('u1', id)).offer).toBeNull();
    expect(events(id).filter((e) => e.kind === 'offer').map((e) => e.toValue)).toEqual(['set', 'cleared']);
  });
});

describe('follow-ups and summary', () => {
  it('reports facts from the user’s own rows', async () => {
    await core.create('u1', { jobId: 'job1', status: 'applied', dateApplied: new Date(NOW.getTime() - 12 * DAY).toISOString() });
    await core.create('u1', { externalSnapshot: { title: 'Analyst', companyName: 'Initech' }, status: 'applied', dateApplied: new Date(NOW.getTime() - 3 * DAY).toISOString() });
    const items = await core.followUps('u1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'no_reply_10d', days: 12, companyName: 'Acme' });
    const summary = await core.summary('u1');
    expect(summary.byStatus).toEqual({ applied: 2 });
    expect(summary.followUps).toHaveLength(1);
  });

  it('weekly facts count this week’s moves', async () => {
    const { id } = await core.create('u1', { jobId: 'job1', status: 'applied', dateApplied: NOW.toISOString() });
    await core.patch('u1', id, { status: 'first_call' });
    const facts = await core.weeklyFacts('u1', '2026-10-04');
    expect(facts).toMatchObject({ weekStart: '2026-10-04', weekEnd: '2026-10-10', applied: 1, interviews: 1, offers: 0, ended: 0 });
  });
});

describe('FIX-3: "this week" in the user\'s time zone', () => {
  it('an application marked at 02:25 on Sunday in Taipei counts in the week that starts that Sunday', async () => {
    const fake = createFakePrisma({ seed: { rAJob: [{ id: 'job1', title: 'Analyst', companyName: 'Acme', market: 'intl', visibility: 'public', ownerUserId: null }], rATrackerEntry: [], rATrackerEvent: [] } });
    const at = new Date('2026-10-10T18:25:07.412Z');
    const zoned = (timeZone: string) => createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => at, market: () => 'intl', timeZone: async () => timeZone });
    const taipei = zoned('Asia/Taipei');
    const { id } = await taipei.create('u1', { jobId: 'job1', status: 'applied', dateApplied: at.toISOString() });
    await taipei.patch('u1', id, { status: 'first_call' });
    expect(await taipei.timeZone('u1')).toBe('Asia/Taipei');
    expect(await taipei.weeklyFacts('u1', '2026-10-11')).toMatchObject({ weekStart: '2026-10-11', weekEnd: '2026-10-17', applied: 1, interviews: 1 });
    expect(await taipei.weeklyFacts('u1', '2026-10-04')).toMatchObject({ applied: 0, interviews: 0 });
    // The same rows for someone in UTC belong to the week of Oct 4.
    expect(await zoned('UTC').weeklyFacts('u1', '2026-10-04')).toMatchObject({ applied: 1, interviews: 1 });
  });

  it('the zone the browser reports wins over the stored one; an unknown name falls back', async () => {
    // An account with no stored zone (older and seeded accounts), read from Taipei.
    const fake = createFakePrisma({ seed: { rAJob: [{ id: 'job1', title: 'Analyst', companyName: 'Acme', market: 'intl', visibility: 'public', ownerUserId: null }], rATrackerEntry: [], rATrackerEvent: [] } });
    const at = new Date('2026-10-10T18:25:07.412Z');
    const c = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => at, market: () => 'intl' });
    const { id } = await c.create('u1', { jobId: 'job1', status: 'applied', dateApplied: at.toISOString() });
    await c.patch('u1', id, { status: 'first_call' });
    expect(await c.timeZone('u1')).toBe('UTC');
    expect(await c.timeZone('u1', ' Asia/Taipei ')).toBe('Asia/Taipei');
    for (const bad of ['Mars/Olympus', '', '   ', 'x'.repeat(200), null, undefined]) expect(await c.timeZone('u1', bad)).toBe('UTC');
    // The page groups this move under Sunday Oct 11 in Taipei; so does the count.
    expect(await c.weeklyFacts('u1', '2026-10-11', 'Asia/Taipei')).toMatchObject({ weekStart: '2026-10-11', applied: 1, interviews: 1 });
    expect(await c.weeklyFacts('u1', '2026-10-04', 'Asia/Taipei')).toMatchObject({ applied: 0, interviews: 0 });
    expect(await c.weeklyFacts('u1', '2026-10-04')).toMatchObject({ applied: 1, interviews: 1 });
    expect(await c.weeklyFacts('u1', '2026-10-04', 'Mars/Olympus')).toMatchObject({ applied: 1, interviews: 1 });
  });

  it('without a stored zone the brand fallback is used and nothing throws', async () => {
    const fake = createFakePrisma({ seed: { rAJob: [], rATrackerEntry: [], rATrackerEvent: [] } });
    const c = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => NOW, market: () => 'intl' });
    expect(await c.timeZone('u1')).toBe('UTC');
  });
});

describe('updateOffer (WP-64 seam)', () => {
  it('writes Prisma.DbNull, never a literal null, when the offer is cleared (REQ-64-05)', async () => {
    const entry = await core.create('u1', { jobId: 'job1' });
    await core.updateOffer('u1', entry.id, { base: 100000, currency: 'USD', period: 'year' });
    const update = vi.spyOn(fake.rATrackerEntry, 'update');
    await core.updateOffer('u1', entry.id, null);
    const data = (update.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data;
    expect(data.offer).toBe(Prisma.DbNull);
    expect(events(entry.id).map((e) => [e.kind, e.toValue])).toContainEqual(['offer', 'cleared']);
  });
});

// ── WP-93 #5 / #24: one lock for every writer, `via: 'tracker'`, feed affinity ──

/**
 * The fake database with pg_advisory_xact_lock emulated: a transaction that
 * runs the lock statement waits until every earlier holder of that key has
 * finished its transaction (the fake itself has no isolation, so without this
 * two concurrent writers interleave freely — which is what the lock prevents).
 */
function withAdvisoryLocks(db: ReturnType<typeof createFakePrisma>) {
  const tails = new Map<string, Promise<void>>();
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== '$transaction') return Reflect.get(target, prop);
      return async (fn: (tx: unknown) => Promise<unknown>) => {
        const releases: Array<() => void> = [];
        const tx = new Proxy(target, {
          get(t, p) {
            if (p !== '$executeRaw') return Reflect.get(t, p);
            return async (first: unknown, ...values: unknown[]) => {
              const out = await (t.$sql.client.$executeRaw as (f: unknown, ...v: unknown[]) => Promise<unknown>)(first, ...values);
              if (Array.isArray(first) && first.join('?').includes('pg_advisory_xact_lock')) {
                const key = String(values[0]);
                const prev = tails.get(key) ?? Promise.resolve();
                let release: () => void = () => undefined;
                const held = new Promise<void>((r) => (release = r));
                tails.set(key, prev.then(() => held));
                await prev;
                releases.push(release);
              }
              return out;
            };
          },
        });
        try {
          return await fn(tx);
        } finally {
          for (const r of releases) r();
        }
      };
    },
  });
}

/** A core over ONE locking view of the current fake database (the lock table lives in that view). */
function lockedCore() {
  const db = withAdvisoryLocks(fake) as unknown as TrackerDb;
  return createTrackerCore({ getDb: async () => db, now: () => NOW, market: () => market });
}

const lockCalls = () => fake.$sql.calls.filter((c) => c.text.includes('pg_advisory_xact_lock'));
const liveEntries = (jobId: string) => fake.$rows('rATrackerEntry').filter((r) => r.jobId === jobId && r.deletedAt == null);

describe('every writer takes the (user, job) advisory lock', () => {
  it('uses the job page\'s key, so both seams serialize on it', async () => {
    await core.markApplied('u1', 'job1', 'manual');
    expect(lockCalls().length).toBeGreaterThanOrEqual(1);
    expect(lockCalls()[0]!.text).toContain('pg_advisory_xact_lock(hashtext(');
    expect(lockCalls()[0]!.values).toEqual([trackerEntryLockKey('u1', 'job1')]);
    expect(trackerEntryLockKey('u1', 'job1')).toBe('ra_tracker_entry:u1:job1');
  });

  it('create, patch, bulk, upsertForJob, markApplied and undoApplied each take it', async () => {
    const count = () => lockCalls().length;
    const saved = await core.create('u1', { jobId: 'job1' });
    expect(count()).toBe(1);
    const mark = await core.markApplied('u1', 'job1', 'apply_click');
    expect(count()).toBe(2);
    expect(await core.undoApplied('u1', 'job1', { mark })).toEqual({ undone: true });
    expect(count()).toBe(3);
    await core.patch('u1', saved.id, { status: 'applied' });
    expect(count()).toBe(4);
    const other = await core.upsertForJob('u1', 'job2', { status: 'bookmarked' });
    expect(count()).toBe(5);
    await core.bulk('u1', { ids: [saved.id, other.id], patch: { status: 'interviewing' } });
    // One statement per job, in sorted key order (two bulk writes cannot deadlock).
    expect(lockCalls().slice(5).map((c) => c.values[0])).toEqual([trackerEntryLockKey('u1', 'job1'), trackerEntryLockKey('u1', 'job2')]);
    expect(count()).toBe(7);
    // An entry the user typed in has no job: nothing to serialize against.
    const manual = await core.create('u1', { externalSnapshot: { title: 'Analyst', companyName: 'Initech', applyUrl: null } });
    await core.patch('u1', manual.id, { status: 'applied' });
    expect(count()).toBe(7);
  });

  it('concurrent first saves and applies create one live entry', async () => {
    const locked = lockedCore();
    const out = await Promise.allSettled([
      locked.markApplied('u1', 'job1', 'apply_click'),
      locked.markApplied('u1', 'job1', 'manual'),
      locked.upsertForJob('u1', 'job1', { status: 'bookmarked' }),
      locked.create('u1', { jobId: 'job1' }),
    ]);
    expect(liveEntries('job1')).toHaveLength(1);
    // Exactly one of the two applies moved the entry; the manual add lost to whoever came first.
    const marks = out.slice(0, 2).map((r) => (r.status === 'fulfilled' ? (r.value as { changed: boolean }).changed : null));
    expect(marks.filter(Boolean)).toHaveLength(1);
    expect(out[3]!.status).toBe('rejected');
  });

  it('without the lock the same race leaves two live entries (what the lock is for)', async () => {
    await Promise.allSettled([core.markApplied('u1', 'job1', 'apply_click'), core.markApplied('u1', 'job1', 'manual')]);
    expect(liveEntries('job1').length).toBeGreaterThan(1);
  });

  it('concurrent markApplied + undo cannot double-move: one move is undone at most once', async () => {
    const locked = lockedCore();
    const saved = await locked.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    const mark = await locked.markApplied('u1', 'job1', 'apply_click');
    expect(mark).toMatchObject({ changed: true, alreadyApplied: false });
    // Two undo clicks, a re-apply and an undo-by-channel all at once.
    const results = await Promise.all([
      locked.undoApplied('u1', 'job1', { mark }),
      locked.undoApplied('u1', 'job1', { mark }),
      locked.markApplied('u1', 'job1', 'apply_click'),
      locked.undoApplied('u1', 'job1', { via: 'apply_click' }),
    ]);
    const undoEvents = events(saved.id).filter((e) => e.kind === 'status' && (e.payload as { undo?: boolean } | null)?.undo === true);
    const applyEvents = events(saved.id).filter((e) => e.kind === 'status' && e.toValue === 'applied');
    // Every undo reverted a different apply: never two undos of one move, never an undo without an apply.
    expect(undoEvents.length).toBe(applyEvents.length - (liveEntries('job1')[0]!.status === 'applied' ? 1 : 0));
    expect(results.slice(0, 2).filter((r) => (r as { undone: boolean }).undone)).toHaveLength(1);
    expect(liveEntries('job1')).toHaveLength(1);
    // The row and its history agree: the stage is where the newest move says it is.
    const newest = events(saved.id)
      .filter((e) => e.kind === 'status')
      .at(-1)!;
    expect(liveEntries('job1')[0]!.status).toBe(newest.toValue);
  });

  it('a stage move in the drawer and an apply click on the job page settle in one order', async () => {
    const locked = lockedCore();
    const saved = await locked.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    await Promise.all([locked.patch('u1', saved.id, { status: 'interviewing' }), locked.markApplied('u1', 'job1', 'apply_click')]);
    const moves = events(saved.id).filter((e) => e.kind === 'status');
    // Each move starts where the one before it ended (no move planned against a stale row).
    for (let i = 1; i < moves.length; i += 1) expect(moves[i]!.fromValue).toBe(moves[i - 1]!.toValue);
    expect(liveEntries('job1')[0]!.status).toBe(moves.at(-1)!.toValue);
  });
});

describe('payload.via', () => {
  it('moves made in the tracker carry via "tracker"; the apply channels keep their own', async () => {
    const saved = await core.create('u1', { jobId: 'job1' });
    expect(events(saved.id)[0]).toMatchObject({ kind: 'created', payload: { via: 'tracker', source: 'feed' } });
    await core.patch('u1', saved.id, { status: 'applied' });
    await core.bulk('u1', { ids: [saved.id], patch: { status: 'interviewing' } });
    const moves = events(saved.id).filter((e) => e.kind === 'status');
    expect(moves.map((e) => (e.payload as { via: string }).via)).toEqual(['tracker', 'tracker']);
    expect(moves[0]).toMatchObject({ payload: { via: 'tracker', stampedDateApplied: true } });

    const clicked = await core.markApplied('u1', 'job2', 'apply_click');
    expect(events(clicked.entryId)[0]).toMatchObject({ kind: 'created', payload: { via: 'apply_click', applyMark: true } });
  });

  it('"Undo · I didn\'t apply" never reverts a move made in the tracker', async () => {
    const saved = await core.create('u1', { jobId: 'job1' });
    await core.patch('u1', saved.id, { status: 'applied' });
    expect(await core.undoApplied('u1', 'job1')).toEqual({ undone: false });
    expect(await core.undoApplied('u1', 'job1', { via: 'apply_click' })).toEqual({ undone: false });
    expect((await core.getById('u1', saved.id)).status).toBe('applied');
  });
});

describe('feed affinity (recordInteraction)', () => {
  function withFeed(record = vi.fn(async () => undefined)) {
    const c = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => NOW, market: () => market, recordInteraction: record });
    return { c, record };
  }

  it('once per change: a new save, a move to Applied, a manual add; never for a no-op', async () => {
    const { c, record } = withFeed();
    const saved = await c.upsertForJob('u1', 'job1', { status: 'bookmarked' });
    expect(record.mock.calls).toEqual([['u1', 'job1', 'save']]);
    await c.upsertForJob('u1', 'job1', { status: 'bookmarked' }); // already saved
    await c.patch('u1', saved.id, { notesMarkdown: 'note' }); // not a stage move
    expect(record).toHaveBeenCalledTimes(1);

    const mark = await c.markApplied('u1', 'job1', 'apply_click');
    expect(mark.alreadyApplied).toBe(false);
    expect(record.mock.calls.at(-1)).toEqual(['u1', 'job1', 'applied']);
    expect((await c.markApplied('u1', 'job1', 'manual')).alreadyApplied).toBe(true); // nothing moved
    expect(record).toHaveBeenCalledTimes(2);

    await c.create('u1', { jobId: 'job2', status: 'applied' }); // "Add a job" at Applied
    expect(record.mock.calls.at(-1)).toEqual(['u1', 'job2', 'applied']);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('stage moves in the drawer and bulk moves count once each; later stages and jobs typed in do not', async () => {
    const { c, record } = withFeed();
    const a = await c.create('u1', { jobId: 'job1' });
    const b = await c.create('u1', { jobId: 'job2' });
    record.mockClear();
    await c.patch('u1', a.id, { status: 'applied' });
    expect(record.mock.calls).toEqual([['u1', 'job1', 'applied']]);
    await c.patch('u1', a.id, { status: 'interviewing' });
    expect(record).toHaveBeenCalledTimes(1);
    await c.bulk('u1', { ids: [a.id, b.id], patch: { status: 'applied' } });
    expect(record.mock.calls.slice(1).sort()).toEqual([
      ['u1', 'job1', 'applied'],
      ['u1', 'job2', 'applied'],
    ]);
    const manual = await c.create('u1', { externalSnapshot: { title: 'Analyst', companyName: 'Initech', applyUrl: null }, status: 'applied' });
    await c.patch('u1', manual.id, { status: 'bookmarked' });
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('a failure in the feed is swallowed: the move is kept and the caller gets its answer', async () => {
    const { c, record } = withFeed(vi.fn(async () => Promise.reject(new Error('feed is down'))));
    const mark = await c.markApplied('u1', 'job1', 'agent_open');
    expect(mark).toMatchObject({ changed: true, alreadyApplied: false });
    expect(record).toHaveBeenCalledTimes(1);
    expect((await c.getById('u1', mark.entryId)).status).toBe('applied');
    const saved = await c.create('u1', { jobId: 'job2' });
    expect(saved.status).toBe('bookmarked');
    await expect(c.patch('u1', saved.id, { status: 'applied' })).resolves.toMatchObject({ status: 'applied' });
  });

  it('a slow feed never holds the answer back: the write answers after the timeout, and a late failure is still swallowed', async () => {
    let fail: (err: Error) => void = () => undefined;
    const record = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const c = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => NOW, market: () => market, recordInteraction: record, feedSignalTimeoutMs: 20 });
    const started = Date.now();
    const mark = await c.markApplied('u1', 'job1', 'manual');
    expect(mark).toMatchObject({ changed: true, alreadyApplied: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(record).toHaveBeenCalledTimes(1);
    // The feed call fails long after the answer: no unhandled rejection.
    fail(new Error('feed timed out'));
    await new Promise((r) => setTimeout(r, 5));
    expect((await c.getById('u1', mark.entryId)).status).toBe('applied');
  });

  it('a reader that throws at once is swallowed too', async () => {
    const record = vi.fn(() => {
      throw new Error('not wired');
    });
    const c = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => NOW, market: () => market, recordInteraction: record as never });
    await expect(c.markApplied('u1', 'job1', 'manual')).resolves.toMatchObject({ changed: true });
  });

  it('a bulk move sends its feed signals side by side, after the write, and stops waiting on a slow feed', async () => {
    const { c, record } = withFeed();
    const made = [];
    for (const jobId of ['job1', 'job2']) made.push(await c.create('u1', { jobId }));
    record.mockClear();
    let running = 0;
    let most = 0;
    record.mockImplementation(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return undefined;
    });
    await c.bulk('u1', { ids: made.map((m) => m.id), patch: { status: 'applied' } });
    expect(record).toHaveBeenCalledTimes(2);
    expect(most).toBe(2);

    // A feed that never answers: the bulk move still answers, with every entry moved.
    const never = vi.fn(() => new Promise<void>(() => undefined));
    const slow = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => NOW, market: () => market, recordInteraction: never, feedSignalTimeoutMs: 20 });
    const out = await slow.bulk('u1', { ids: made.map((m) => m.id), patch: { status: 'bookmarked' } });
    expect(out.entries.map((e) => e.status)).toEqual(['bookmarked', 'bookmarked']);
    expect(never).toHaveBeenCalledTimes(2);
  });

  it('the extension channel is left to the extension service, which records its own signal', async () => {
    const { c, record } = withFeed();
    await c.upsertForJob('u1', 'job1', { status: 'bookmarked', source: 'extension' });
    await c.markApplied('u1', 'job1', 'extension');
    expect(record).not.toHaveBeenCalled();
  });

  it('nothing is recorded when no reader is wired (the default for tests and scripts)', async () => {
    await expect(core.markApplied('u1', 'job1', 'manual')).resolves.toMatchObject({ changed: true });
  });
});
