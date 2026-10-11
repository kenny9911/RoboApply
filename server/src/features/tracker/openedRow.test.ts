// @vitest-environment node
//
// MKT-3C (JI-5; MARKET_STRATEGY §1.5 "Canonical row"; JOB_SOURCES_INTL §7.1):
// "The tracker stores the row the user opened, not the canonical one."
//
// Dedupe keeps duplicates as live alternates that point at one canonical row
// (`RAJob.isCanonical`, `canonicalJobId`), and from MKT-3C on it regroups more
// often: exact twins join one group (the posting key), priorities changed
// (GoHire bank 3, employer board 5), and a closed canonical hands over to the
// next row. None of that may move a user's saved or applied job to another
// row: the fuzzy key can merge two distinct requisitions with the same title
// in the same city, and the user applied to ONE of them.
//
// The tracker core over the fake Prisma (no database), with the tracker
// service's own fakes (service.test.ts): entries are created on a
// non-canonical alternate, the canonical flags are then changed the way
// `applyDedupe` changes them, and every read still names the opened row.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { createTrackerCore, type TrackerDb } from './service.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');

/** SYNTHETIC rows: one posting seen through three sources, in one dedupe group. */
const job = (id: string, over: Record<string, unknown>) => ({
  id,
  title: 'Backend Engineer',
  companyName: 'Acme',
  companyLogoUrl: null,
  location: 'Austin, TX',
  workType: 'hybrid',
  closedAt: null,
  archivedAt: null,
  expiresAt: null,
  salaryMax: null,
  salaryCurrency: null,
  market: 'intl',
  visibility: 'public',
  ownerUserId: null,
  dedupeKey: 'K_same_posting',
  atsPostingKey: 'greenhouse:acme:4012345',
  ...over,
});

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
        // The employer's board row: canonical (priority 5).
        job('board', { applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345', sourceBoard: 'greenhouse', sourcePriority: 5, isCanonical: true, canonicalJobId: null }),
        // The licensed feed's and JSearch's copies: live alternates pointing at it.
        job('feed', { applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345', sourceBoard: 'activejobs', sourcePriority: 10, isCanonical: false, canonicalJobId: 'board' }),
        job('jsearch', { applyUrl: 'https://www.totaljobs.com/job/9', sourceBoard: 'jsearch', sourcePriority: 30, isCanonical: false, canonicalJobId: 'board' }),
      ],
    },
  });
}

let fake = makeFake();
const core = createTrackerCore({ getDb: async () => fake as unknown as TrackerDb, now: () => NOW, market: () => 'intl' });

const entries = () => fake.$rows('rATrackerEntry') as Array<Record<string, unknown>>;
const jobRow = (id: string) => (fake.$rows('rAJob') as Array<Record<string, unknown>>).find((r) => r.id === id)!;

/** What `applyDedupe` writes when the canonical row of the group changes. */
function makeCanonical(id: string): void {
  for (const r of fake.$rows('rAJob') as Array<Record<string, unknown>>) {
    if (r.dedupeKey !== 'K_same_posting') continue;
    r.isCanonical = r.id === id;
    r.canonicalJobId = r.id === id ? null : id;
  }
}

// The writers take the (user, job) advisory lock whose key lives in the job detail area (loaded on first use).
beforeAll(async () => {
  await import('../jobs/detail/index.js');
}, 60_000);

beforeEach(() => {
  fake = makeFake();
});

describe('the tracker keeps the row the user opened (JI-5)', () => {
  it('saving a non-canonical alternate stores that row\'s own job id, not its canonical row\'s', async () => {
    expect(jobRow('jsearch')).toMatchObject({ isCanonical: false, canonicalJobId: 'board' });
    const entry = await core.create('u1', { jobId: 'jsearch' });
    expect(entry.jobId).toBe('jsearch');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ userId: 'u1', jobId: 'jsearch', status: 'bookmarked' });
    // The card shows the row that was opened: its own apply link.
    expect(entry.job?.applyUrl).toBe('https://www.totaljobs.com/job/9');
    // The save from a job card (the feed's seam) is the same rule.
    const viaCard = await core.upsertForJob('u2', 'feed', { status: 'bookmarked' });
    expect(viaCard.jobId).toBe('feed');
    expect(entries().map((e) => e.jobId).sort()).toEqual(['feed', 'jsearch']);
  });

  it("marking 'applied' on a non-canonical alternate stores that row's own job id", async () => {
    const mark = await core.markApplied('u1', 'feed', 'apply_click');
    expect(mark.changed).toBe(true);
    const entry = await core.getById('u1', mark.entryId);
    expect(entry).toMatchObject({ jobId: 'feed', status: 'applied', appliedVia: 'apply_click', dateApplied: NOW.toISOString() });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.jobId).toBe('feed');
    // The canonical row has no entry: applying to the alternate did not apply to it.
    expect(entries().some((e) => e.jobId === 'board')).toBe(false);
    // Moving a saved alternate to applied by hand: the same row.
    const saved = await core.create('u2', { jobId: 'jsearch' });
    const patched = await core.patch('u2', saved.id, { status: 'applied' });
    expect(patched.jobId).toBe('jsearch');
  });

  it('a later change of the canonical row leaves every entry pointing at the row the user opened', async () => {
    const saved = await core.create('u1', { jobId: 'jsearch' });
    const applied = await core.markApplied('u1', 'feed', 'apply_click');
    const onCanonical = await core.create('u2', { jobId: 'board' });

    // Dedupe regroups: the board closes its posting and the feed's row becomes canonical.
    Object.assign(jobRow('board'), { archivedAt: NOW, closedAt: NOW, closeReason: 'source_removed' });
    makeCanonical('feed');
    expect(jobRow('jsearch')).toMatchObject({ isCanonical: false, canonicalJobId: 'feed' });

    expect((await core.getById('u1', saved.id)).jobId).toBe('jsearch');
    expect((await core.getById('u1', applied.entryId)).jobId).toBe('feed');
    // The user who saved the row that has now closed still has THAT row, shown as closed; never silently swapped for the live twin.
    const closed = await core.getById('u2', onCanonical.id);
    expect(closed.jobId).toBe('board');
    expect(closed.job?.closed).toBe(true);
    const list = await core.list('u1');
    expect(list.entries.map((e) => e.jobId).sort()).toEqual(['feed', 'jsearch']);

    // And once more the other way: a new best row arrives (a GoHire-style priority 3 row) and takes the group.
    (fake.$rows('rAJob') as Array<Record<string, unknown>>).push(job('bank', { applyUrl: 'https://example.test/p/1', sourceBoard: 'robohire', sourcePriority: 3, isCanonical: false, canonicalJobId: 'feed' }));
    makeCanonical('bank');
    expect(entries().map((e) => e.jobId).sort()).toEqual(['board', 'feed', 'jsearch']);
    expect((await core.getById('u1', saved.id)).job?.applyUrl).toBe('https://www.totaljobs.com/job/9');
  });

  it('later actions on an entry keep its row: status moves, notes, undo and a second save of the same row', async () => {
    makeCanonical('feed');
    const saved = await core.create('u1', { jobId: 'jsearch' });
    await core.patch('u1', saved.id, { status: 'applied' });
    await core.addNote('u1', saved.id, 'Applied through the board listing.');
    await core.patch('u1', saved.id, { status: 'interviewing', interviewAt: '2026-10-12T15:00:00.000Z' });
    makeCanonical('board');
    const again = await core.upsertForJob('u1', 'jsearch', { status: 'bookmarked' });
    expect(again.id).toBe(saved.id);
    expect(again.jobId).toBe('jsearch');
    const mark = await core.markApplied('u1', 'board', 'apply_click');
    // Applying on the canonical twin is its own entry (two rows the user opened), and undoing it leaves the first alone.
    expect(mark.entryId).not.toBe(saved.id);
    expect(await core.undoApplied('u1', 'board', { mark })).toEqual({ undone: true });
    expect((await core.getById('u1', saved.id))).toMatchObject({ jobId: 'jsearch', status: 'interviewing' });
    // No write of the tracker ever changed a job id.
    expect(entries().find((e) => e.id === saved.id)!.jobId).toBe('jsearch');
  });

  it('the tracker never asks which row is canonical: it reads and writes by the id it was given', async () => {
    const asked: unknown[] = [];
    const spy = fake as unknown as { rAJob: Record<string, (args: unknown) => unknown> };
    for (const method of ['findUnique', 'findFirst', 'findMany'] as const) {
      const original = spy.rAJob[method]!.bind(spy.rAJob);
      spy.rAJob[method] = (args: unknown) => {
        asked.push(args);
        return original(args);
      };
    }
    const entry = await core.create('u1', { jobId: 'jsearch' });
    await core.markApplied('u1', 'feed', 'apply_click');
    await core.getById('u1', entry.id);
    await core.list('u1');
    expect(asked.length).toBeGreaterThan(0);
    const text = JSON.stringify(asked);
    expect(text).not.toContain('canonicalJobId');
    expect(text).not.toContain('isCanonical');
    expect(text).not.toContain('dedupeKey');
    expect(text).not.toContain('atsPostingKey');
  });
});
