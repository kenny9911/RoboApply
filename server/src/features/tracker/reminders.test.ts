// @vitest-environment node
//
// WP-38: the tracker's `reminders` cron producer (F-NOTIF-08). Facts only,
// one reminder per fact (ledger), in-app message + email when WP-39a has
// registered the template, idle runs return at once.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { createBudget, type CronContext } from '../../platform/queue/index.js';
import { getBrand } from '../../platform/brand/index.js';
import { TRACKER_REMINDER_EMAIL_TEMPLATE } from './contract.js';
import { produceTrackerReminders, reminderFacts, reminderFallbackTitle, reminderKey, type ReminderCandidate, type ReminderDeps } from './reminders.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;

function candidate(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    id: 'e1',
    userId: 'u1',
    status: 'applied',
    dateApplied: null,
    followUpAt: null,
    interviewAt: null,
    deadline: null,
    companyName: 'Acme',
    title: 'Analyst',
    ...over,
  };
}

const ctx = (brand: 'roboapply' | 'goapply' = 'roboapply'): CronContext => ({ name: 'reminders', brand: getBrand(brand), budget: createBudget(240_000), now: NOW });

let fake = createFakePrisma();
let candidates: ReminderCandidate[] = [];
const enqueueEmail = vi.fn(async () => ({}));
let templateRegistered = true;

function deps(): ReminderDeps {
  return {
    getDb: async () => fake as never,
    loadCandidates: async () => candidates,
    enqueueEmail,
    emailTemplateRegistered: () => templateRegistered,
  };
}

beforeEach(() => {
  fake = createFakePrisma({ seed: { seekerProfile: [{ id: 'sp1', userId: 'u1' }] } });
  candidates = [];
  enqueueEmail.mockClear();
  templateRegistered = true;
});

describe('produceTrackerReminders', () => {
  it('returns no_work at once when nothing is due', async () => {
    expect(await produceTrackerReminders(ctx(), deps())).toEqual({ skipped: 'no_work', processed: 0 });
  });

  it('writes one in-app reminder + ledger row + email per fact, and never twice', async () => {
    candidates = [candidate({ dateApplied: new Date(NOW.getTime() - 11 * DAY) })];
    const first = await produceTrackerReminders(ctx(), deps());
    expect(first).toMatchObject({ processed: 1, emails: 1 });
    const [n] = fake.$rows('seekerNotification');
    expect(n).toMatchObject({
      seekerProfileId: 'sp1',
      userId: 'u1',
      brand: 'roboapply',
      category: 'reminder',
      templateKey: 'applications.reminders.no_reply',
      title: 'No reply from Acme for 11 days.',
      deepLink: '/applications?entry=e1',
      relatedEntityId: 'e1',
    });
    expect(n!.params).toMatchObject({ name: 'Acme', days: 11, reason: 'no_reply_10d' });
    expect(fake.$rows('rATrackerEvent')).toEqual([expect.objectContaining({ entryId: 'e1', kind: 'reminder', toValue: expect.stringMatching(/^no_reply:/) })]);
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ template: TRACKER_REMINDER_EMAIL_TEMPLATE, userId: 'u1' }),
      expect.objectContaining({ brand: 'roboapply', dedupeKey: expect.stringContaining('tracker.reminder:e1:') }),
    );

    const second = await produceTrackerReminders(ctx(), deps());
    expect(second).toMatchObject({ processed: 0 });
    expect(fake.$rows('seekerNotification')).toHaveLength(1);
  });

  it('stays in-app only until the email template is registered', async () => {
    templateRegistered = false;
    candidates = [candidate({ status: 'interviewing', interviewAt: new Date(NOW.getTime() + 3 * 3600_000) })];
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, emails: 0 });
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(fake.$rows('seekerNotification')[0]).toMatchObject({ templateKey: 'applications.reminders.interview_tomorrow' });
  });

  it('GoApply sends a 3-day and a 1-day 网申截止 reminder for the same deadline', async () => {
    const deadline = new Date(Date.UTC(2026, 9, 13));
    candidates = [candidate({ status: 'bookmarked', deadline })];
    await produceTrackerReminders(ctx('goapply'), deps());
    // Two days later the 1-day reminder is due.
    const later: CronContext = { ...ctx('goapply'), now: new Date(NOW.getTime() + 2 * DAY) };
    await produceTrackerReminders(later, deps());
    expect(fake.$rows('rATrackerEvent').map((e) => e.toValue)).toEqual(['deadline:2026-10-13:3d', 'deadline:2026-10-13:1d']);
    expect(fake.$rows('seekerNotification').every((n) => n.brand === 'goapply')).toBe(true);
  });

  it('skips the in-app row (but keeps the ledger) when the user has no seeker profile', async () => {
    candidates = [candidate({ userId: 'u9', dateApplied: new Date(NOW.getTime() - 10 * DAY) })];
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, inAppSkipped: 1 });
    expect(fake.$rows('seekerNotification')).toHaveLength(0);
  });
});

describe('default candidate query', () => {
  it('is one brand-scoped query over live, open entries', async () => {
    const findMany = vi.fn(async () => []);
    const out = await produceTrackerReminders(ctx('goapply'), { getDb: async () => ({ rATrackerEntry: { findMany } }) as never });
    expect(out).toEqual({ skipped: 'no_work', processed: 0 });
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; take: number }])[0];
    expect(where.where).toMatchObject({ deletedAt: null, user: { brand: 'goapply' }, status: { notIn: ['rejected', 'withdrawn', 'closed'] } });
    expect((where.where.OR as unknown[]).length).toBe(4);
    expect(where.take).toBe(500);
    expect(where).toMatchObject({ orderBy: { id: 'asc' } });
  });

  it('500 already-reminded candidates ahead of a due one do not starve it', async () => {
    const sentAt = NOW.getTime() - 2 * DAY;
    const reminded = Array.from({ length: 500 }, (_, i) => ({
      id: `a${String(i).padStart(4, '0')}`,
      userId: 'u1',
      status: 'applied',
      dateApplied: new Date(NOW.getTime() - 12 * DAY),
      followUpAt: null,
      interviewAt: null,
      deadline: null,
      jobId: null,
      externalSnapshot: { companyName: 'Initech', title: 'Analyst' },
      deletedAt: null,
    }));
    const due = { ...reminded[0]!, id: 'z0001', userId: 'u2', dateApplied: new Date(NOW.getTime() - 11 * DAY) };
    // Unordered on purpose: the loader must sort by id and page with a cursor.
    const rows = [due, ...reminded];
    fake = createFakePrisma({ seed: { seekerProfile: [{ id: 'sp1', userId: 'u1' }, { id: 'sp2', userId: 'u2' }] } });
    const findMany = vi.fn(async (args: { where: { id?: { gt: string } }; orderBy: { id: 'asc' }; take: number }) => {
      const after = args.where.id?.gt;
      return [...rows].sort((a, b) => a.id.localeCompare(b.id)).filter((r) => !after || r.id > after).slice(0, args.take);
    });
    const overrides: Record<string, unknown> = { rATrackerEntry: { findMany }, rAJob: { findMany: async () => [] } };
    const store = fake;
    const db = new Proxy(store, { get: (target, prop: string) => overrides[prop] ?? (target as unknown as Record<string, unknown>)[prop] });
    // Every one of the 500 has had its no-reply reminder already.
    const facts = reminderFacts(reminded.map((r) => candidate({ id: r.id, dateApplied: r.dateApplied })), NOW, 'intl');
    expect(facts).toHaveLength(500);
    for (const f of facts) {
      fake.$rows('rATrackerEvent').push({ id: `ev-${f.entryId}`, entryId: f.entryId, userId: 'u1', kind: 'reminder', toValue: f.key, fromValue: null, payload: null, createdAt: new Date(sentAt) });
    }
    const out = await produceTrackerReminders(ctx(), { ...deps(), getDb: async () => db as never, loadCandidates: undefined });
    expect(out).toMatchObject({ processed: 1, alreadySent: 500, candidates: 501, pages: 2 });
    expect(fake.$rows('seekerNotification')).toEqual([expect.objectContaining({ userId: 'u2', relatedEntityId: 'z0001' })]);
  });
});

describe('reminder rules', () => {
  it('a stale fact is not sent late', () => {
    const facts = reminderFacts(
      [candidate({ id: 'old', dateApplied: new Date(NOW.getTime() - 40 * DAY) }), candidate({ id: 'stale', followUpAt: new Date(NOW.getTime() - 9 * DAY) })],
      NOW,
      'intl',
    );
    expect(facts).toEqual([]);
  });

  it('keys and fallback titles are facts', () => {
    const f = { entryId: 'e', reason: 'deadline_soon' as const, at: '2026-10-11', days: 1, companyName: null, title: 'Analyst' };
    expect(reminderKey(f, 'intl')).toBe('deadline:2026-10-11');
    expect(reminderKey({ ...f, days: 3 }, 'cn')).toBe('deadline:2026-10-11:3d');
    expect(reminderFallbackTitle(f)).toBe('Applications for Analyst close tomorrow.');
    expect(reminderFallbackTitle({ ...f, days: 2 })).toBe('Applications for Analyst close in 2 days.');
    expect(reminderFallbackTitle({ ...f, days: 0 })).toBe('Applications for Analyst close today.');
  });
});
