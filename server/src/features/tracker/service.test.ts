// @vitest-environment node
//
// WP-38: the tracker core over the fake Prisma (no database). Covers the
// acceptance rules: every PATCH change writes an RATrackerEvent, a move to
// applied stamps dateApplied, the GoApply ladder, outcomes, undo, list
// filters, files sent and follow-up facts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Prisma } from '../../generated/prisma/client.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
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
    expect(mark).toEqual({ entryId: saved.id, changed: false, eventId: null });
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
