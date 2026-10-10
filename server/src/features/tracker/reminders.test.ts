// @vitest-environment node
//
// The tracker's `reminders` cron producer (F-NOTIF-08; WP-38, WP-93 #9).
// Facts only, one reminder per fact (ledger), delivered through `notifyUser`
// (features/alerts): one notify per due reminder, retried after quiet hours,
// dropped when there is nobody to tell, and the person's channel choices and
// unsubscribes honoured by the gate. Idle runs return at once.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { createBudget, type CronContext } from '../../platform/queue/index.js';
import { getBrand } from '../../platform/brand/index.js';
import { getEmailTemplate } from '../../platform/email/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import { deliverMessage, type DeliverDeps, type InAppRow } from '../alerts/deliver.js';
import { notifyUserWith, type NotifyUserInput, type NotifyUserResult } from '../alerts/notify.js';
import type { PreferenceFacts, StoredNotificationPrefs } from '../alerts/preferences.js';
import type { Recipient } from '../alerts/repo.js';
import { TRACKER_INBOX_TEMPLATES, TRACKER_NOTIFY_TEMPLATES } from './contract.js';
import { produceReminders } from './cron.js';
import {
  produceTrackerReminders,
  reminderDelivery,
  reminderFacts,
  reminderInboxTitle,
  reminderKey,
  type ReminderCandidate,
  type ReminderDeps,
  type ReminderInboxInput,
  type ReminderPerson,
} from './reminders.js';

/** 12:00 UTC: outside the default quiet hours (21:00–08:00) in UTC. */
const NOW = new Date('2026-10-10T12:00:00.000Z');
/** 23:30 UTC: inside them. */
const NIGHT = new Date('2026-10-10T23:30:00.000Z');
const DAY = 86_400_000;

function candidate(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    id: 'e1',
    userId: 'u1',
    jobId: 'job1',
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

const ctx = (brand: 'roboapply' | 'goapply' = 'roboapply', now: Date = NOW): CronContext => ({ name: 'reminders', brand: getBrand(brand), budget: createBudget(240_000), now });

let fake = createFakePrisma();
let candidates: ReminderCandidate[] = [];
const notify = vi.fn<(input: NotifyUserInput) => Promise<NotifyUserResult>>();
const createInbox = vi.fn<(input: ReminderInboxInput) => Promise<{ id: string } | null>>();
/** The person an inbox-only reminder is for (what the alerts readers would answer). */
let person: ReminderPerson | null = { brand: 'roboapply', locale: 'en', prefs: {} };
const loadPerson = vi.fn(async () => person);

const delivered = (notificationId: string | null = 'n1', email: 'sent' | 'suppressed' | null = 'sent'): NotifyUserResult => ({
  status: 'delivered',
  outcome: { notificationId, email: email ? { status: email } : null, channels: {} },
});

function deps(over: Partial<ReminderDeps> = {}): ReminderDeps {
  return { getDb: async () => fake as never, loadCandidates: async () => candidates, notify, createInbox, loadPerson, ...over };
}

const ledger = () => fake.$rows('rATrackerEvent');

beforeEach(() => {
  fake = createFakePrisma({ seed: { seekerNotification: [{ id: 'n1', userId: 'u1', templateKey: 'notify.follow_up_reminder' }] } });
  candidates = [];
  notify.mockReset().mockResolvedValue(delivered());
  createInbox.mockReset().mockResolvedValue({ id: 'n_inbox' });
  person = { brand: 'roboapply', locale: 'en', prefs: {} };
  loadPerson.mockClear();
});

// The preference check comes from the alerts area, loaded on the first inbox-only fact.
beforeAll(async () => {
  await import('../alerts/index.js');
}, 120_000);

describe('produceTrackerReminders', () => {
  it('returns no_work at once when nothing is due', async () => {
    expect(await produceTrackerReminders(ctx(), deps())).toEqual({ skipped: 'no_work', processed: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends one notify per due reminder (the follow-up template), writes the ledger row, and never sends twice', async () => {
    const appliedAt = new Date(NOW.getTime() - 11 * DAY);
    candidates = [candidate({ dateApplied: appliedAt })];
    const first = await produceTrackerReminders(ctx(), deps());
    expect(first).toMatchObject({ processed: 1, emails: 1, deferred: 0, dropped: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      userId: 'u1',
      templateKey: NOTIFY_TEMPLATES.followUpReminder,
      params: { entryId: 'e1', title: 'Analyst', company: 'Acme', appliedAt: appliedAt.toISOString(), days: 11 },
      href: '/applications?entry=e1',
      category: 'reminder',
      kind: 'reminder',
      relatedEntity: { type: 'tracker_entry', id: 'e1' },
      brand: 'roboapply',
      now: NOW,
    });
    expect(ledger()).toEqual([expect.objectContaining({ entryId: 'e1', userId: 'u1', kind: 'reminder', toValue: expect.stringMatching(/^no_reply:/), payload: { reason: 'no_reply_10d', inApp: true, channel: 'notify', email: 'sent' } })]);
    // The inbox row notifyUser wrote is labelled with the key the message center renders.
    expect(fake.$rows('seekerNotification')[0]).toMatchObject({ id: 'n1', templateKey: 'tracker.followUp' });
    // This producer writes no SeekerNotification of its own and queues no email itself.
    expect(fake.$rows('seekerNotification')).toHaveLength(1);
    expect(fake.$rows('rAWorkItem')).toHaveLength(0);

    const second = await produceTrackerReminders(ctx(), deps());
    expect(second).toMatchObject({ processed: 0, alreadySent: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('an interview within 24 hours uses the interview template and its inbox key', async () => {
    const interviewAt = new Date(NOW.getTime() + 3 * 3600_000);
    candidates = [candidate({ status: 'interviewing', interviewAt })];
    fake.$rows('seekerNotification')[0]!.templateKey = 'notify.interview_reminder';
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1 });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: NOTIFY_TEMPLATES.interviewReminder,
        params: { entryId: 'e1', jobId: 'job1', title: 'Analyst', company: 'Acme', interviewAt: interviewAt.toISOString() },
        category: 'reminder',
      }),
    );
    expect(fake.$rows('seekerNotification')[0]).toMatchObject({ templateKey: 'tracker.interview' });
    expect(ledger()[0]).toMatchObject({ toValue: `interview:${interviewAt.toISOString()}` });
  });

  it('deferred (quiet hours): nothing is written, and the same fact is sent on a later run', async () => {
    candidates = [candidate({ dateApplied: new Date(NOW.getTime() - 11 * DAY) })];
    notify.mockResolvedValueOnce({ status: 'deferred', retryAt: new Date(NOW.getTime() + 8 * 3600_000) });
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 0, deferred: 1 });
    expect(ledger()).toHaveLength(0);
    expect(await produceTrackerReminders(ctx('roboapply', new Date(NOW.getTime() + 9 * 3600_000)), deps())).toMatchObject({ processed: 1, deferred: 0 });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(ledger()).toHaveLength(1);
    // And never a third time.
    await produceTrackerReminders(ctx('roboapply', new Date(NOW.getTime() + 10 * 3600_000)), deps());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it.each(['no_user', 'other_brand', 'preference_off'] as const)('skipped (%s): dropped for good, not retried every hour', async (reason) => {
    candidates = [candidate({ dateApplied: new Date(NOW.getTime() - 11 * DAY) })];
    notify.mockResolvedValue({ status: 'skipped', reason });
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 0, dropped: 1, emails: 0 });
    expect(ledger()).toEqual([expect.objectContaining({ kind: 'reminder', payload: { reason: 'no_reply_10d', skipped: reason } })]);
    await produceTrackerReminders(ctx(), deps());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('counts a delivery with no inbox row or no email honestly', async () => {
    candidates = [candidate({ dateApplied: new Date(NOW.getTime() - 11 * DAY) })];
    notify.mockResolvedValue(delivered(null, 'suppressed'));
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, emails: 0, inAppSkipped: 1 });
    expect(ledger()[0]).toMatchObject({ payload: { inApp: false, email: 'suppressed' } });
  });

  it('a failed label never loses the reminder', async () => {
    candidates = [candidate({ dateApplied: new Date(NOW.getTime() - 11 * DAY) })];
    const labelInbox = vi.fn(async () => Promise.reject(new Error('db hiccup')));
    expect(await produceTrackerReminders(ctx(), deps({ labelInbox }))).toMatchObject({ processed: 1 });
    expect(labelInbox).toHaveBeenCalledWith(expect.anything(), 'n1', 'u1', 'tracker.followUp');
    expect(ledger()).toHaveLength(1);
  });

  it('GoApply sends a 3-day and a 1-day 网申截止 reminder for the same deadline, as inbox messages (there is no deadline email)', async () => {
    const deadline = new Date(Date.UTC(2026, 9, 13));
    candidates = [candidate({ status: 'bookmarked', deadline })];
    person = { brand: 'goapply', locale: null, prefs: {} };
    await produceTrackerReminders(ctx('goapply'), deps());
    // Two days later the 1-day reminder is due.
    await produceTrackerReminders(ctx('goapply', new Date(NOW.getTime() + 2 * DAY)), deps());
    expect(ledger().map((e) => e.toValue)).toEqual(['deadline:2026-10-13:3d', 'deadline:2026-10-13:1d']);
    expect(notify).not.toHaveBeenCalled();
    expect(createInbox).toHaveBeenCalledTimes(2);
    expect(createInbox.mock.calls[0]![0]).toEqual({
      userId: 'u1',
      brand: 'goapply',
      templateKey: 'tracker.deadline',
      params: { reason: 'deadline_soon', name: 'Acme', company: 'Acme', title: 'Analyst', at: '2026-10-13', days: 3 },
      // GoApply reads its own Simplified Chinese sentence from the server i18n loader.
      title: 'Acme 的网申还有 3 天截止。',
      href: '/applications?entry=e1',
      entryId: 'e1',
    });
    expect(createInbox.mock.calls[1]![0]).toMatchObject({ title: 'Acme 的网申明天截止。', params: { days: 1 } });
    expect(ledger().map((e) => e.payload)).toEqual([
      { reason: 'deadline_soon', inApp: true, channel: 'inbox' },
      { reason: 'deadline_soon', inApp: true, channel: 'inbox' },
    ]);
  });

  it('RoboApply stores the English sentence for a saved job\'s deadline, and the follow-up date the user set is an inbox sentence, never the "no reply" email', async () => {
    candidates = [
      candidate({ id: 'e1', status: 'bookmarked', deadline: new Date(Date.UTC(2026, 9, 11)) }),
      candidate({ id: 'e2', dateApplied: new Date(NOW.getTime() - 1 * DAY), followUpAt: new Date(NOW.getTime() - 3600_000) }),
    ];
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 2, emails: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(createInbox.mock.calls.map((c) => [c[0].templateKey, c[0].title])).toEqual([
      ['tracker.deadline', 'Applications for Acme close tomorrow.'],
      ['tracker.followUpDue', 'Your follow-up date for Acme is today.'],
    ]);
  });

  it.each([
    ['reminders set to email only', { brand: 'roboapply', locale: 'en', prefs: { channels: { reminder: ['email'] } } } as ReminderPerson, 'preference_off'],
    ['no in-app channel at all', { brand: 'roboapply', locale: 'en', prefs: { channels: { reminder: [] } } } as ReminderPerson, 'preference_off'],
    ['a person of the other brand', { brand: 'goapply', locale: 'zh', prefs: {} } as ReminderPerson, 'other_brand'],
    ['nobody to tell (deleted account)', null, 'no_user'],
  ])('an inbox-only reminder honours the same rules — %s: no inbox row, dropped for good', async (_name, who, reason) => {
    candidates = [candidate({ status: 'bookmarked', deadline: new Date(Date.UTC(2026, 9, 11)) })];
    person = who;
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 0, dropped: 1 });
    expect(createInbox).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(ledger()).toEqual([expect.objectContaining({ kind: 'reminder', toValue: 'deadline:2026-10-11', payload: { reason: 'deadline_soon', skipped: reason } })]);
    // Not asked again every hour.
    await produceTrackerReminders(ctx(), deps());
    expect(loadPerson).toHaveBeenCalledTimes(1);
  });

  it('an inbox-only reminder is written when reminders are set to in-app only', async () => {
    candidates = [candidate({ status: 'bookmarked', deadline: new Date(Date.UTC(2026, 9, 11)) })];
    person = { brand: 'roboapply', locale: 'en', prefs: { channels: { reminder: ['in_app'] }, unsubscribed: { reminders: '2026-10-01T00:00:00.000Z' } } };
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, dropped: 0 });
    expect(createInbox).toHaveBeenCalledTimes(1);
  });

  it('skips the inbox row (but keeps the ledger) when the user has no seeker profile', async () => {
    candidates = [candidate({ status: 'bookmarked', deadline: new Date(Date.UTC(2026, 9, 11)) })];
    createInbox.mockRejectedValueOnce(Object.assign(new Error('No seeker profile for this account.'), { code: 'not_found' }));
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, inAppSkipped: 1 });
    expect(ledger()[0]).toMatchObject({ payload: { inApp: false, channel: 'inbox' } });
  });

  it('the ledger row is written before the message goes out: a failure after the send never sends it again', async () => {
    candidates = [candidate({ dateApplied: new Date(NOW.getTime() - 11 * DAY) })];
    const seen: unknown[] = [];
    notify.mockImplementation(async () => {
      seen.push(...ledger().map((e) => ({ toValue: e.toValue, payload: e.payload })));
      return delivered();
    });
    // The result cannot be stored (a database blip right after the send).
    const store = fake;
    const blip = new Proxy(store, {
      get: (target, prop: string) =>
        prop === 'rATrackerEvent'
          ? { ...target.rATrackerEvent, update: async () => Promise.reject(new Error('db blip')) }
          : (target as unknown as Record<string, unknown>)[prop],
    });
    expect(await produceTrackerReminders(ctx(), deps({ getDb: async () => blip as never }))).toMatchObject({ processed: 1, emails: 1 });
    expect(seen).toEqual([{ toValue: expect.stringMatching(/^no_reply:/), payload: { reason: 'no_reply_10d', pending: true } }]);
    expect(ledger()).toHaveLength(1);
    // The next hourly run finds the row and sends nothing.
    expect(await produceTrackerReminders(ctx('roboapply', new Date(NOW.getTime() + 3600_000)), deps())).toMatchObject({ processed: 0, alreadySent: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('notifyUser throwing (part of the message may be out): the fact is kept in the ledger, never sent twice, and never blocks later runs', async () => {
    candidates = [candidate({ id: 'e1', dateApplied: new Date(NOW.getTime() - 11 * DAY) }), candidate({ id: 'e2', dateApplied: new Date(NOW.getTime() - 12 * DAY) })];
    notify.mockRejectedValueOnce(new Error('email could not be rendered'));
    await expect(produceTrackerReminders(ctx(), deps())).rejects.toThrow('email could not be rendered');
    const failedId = notify.mock.calls[0]![0].relatedEntity!.id;
    const otherId = failedId === 'e1' ? 'e2' : 'e1';
    expect(ledger()).toEqual([expect.objectContaining({ entryId: failedId, payload: { reason: 'no_reply_10d', failed: 'email could not be rendered', channel: 'notify' } })]);
    // Next run: the failed fact is not tried again, and the one after it goes out.
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, alreadySent: 1 });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toMatchObject({ relatedEntity: { type: 'tracker_entry', id: otherId } });
  });

  it('an inbox-only message whose write failed left nothing behind: released, the rest of the run goes on, and it is tried again', async () => {
    candidates = [
      candidate({ id: 'e1', status: 'bookmarked', deadline: new Date(Date.UTC(2026, 9, 11)) }),
      candidate({ id: 'e2', status: 'bookmarked', deadline: new Date(Date.UTC(2026, 9, 12)) }),
    ];
    createInbox.mockRejectedValueOnce(new Error('insert failed'));
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, failed: 1 });
    const failedId = createInbox.mock.calls[0]![0].entryId;
    expect(ledger().map((e) => e.entryId)).toEqual([failedId === 'e1' ? 'e2' : 'e1']);
    expect(await produceTrackerReminders(ctx(), deps())).toMatchObject({ processed: 1, failed: 0, alreadySent: 1 });
    expect(createInbox.mock.calls[2]![0].entryId).toBe(failedId);
    expect(createInbox).toHaveBeenCalledTimes(3);
    expect(ledger().map((e) => e.entryId).sort()).toEqual(['e1', 'e2']);
  });

  it('`produceReminders` is the one function the cron registers as "tracker"', () => {
    expect(typeof produceReminders).toBe('function');
    expect(TRACKER_NOTIFY_TEMPLATES).toEqual({ followUp: NOTIFY_TEMPLATES.followUpReminder, interview: NOTIFY_TEMPLATES.interviewReminder });
    expect(getEmailTemplate(TRACKER_NOTIFY_TEMPLATES.followUp)).toMatchObject({ list: 'reminders' });
    expect(getEmailTemplate(TRACKER_NOTIFY_TEMPLATES.interview)).toMatchObject({ list: 'reminders' });
    // The inbox keys rendered today (i18n/staging/inbox.en.json `inbox.templates.tracker.*`).
    expect(TRACKER_INBOX_TEMPLATES).toMatchObject({ followUp: 'tracker.followUp', interview: 'tracker.interview' });
    expect(Object.values(TRACKER_INBOX_TEMPLATES).some((k) => k.startsWith('applications.reminders'))).toBe(false);
  });
});

describe('the gate: quiet hours, channel choices and unsubscribes (real notifyUser + deliver over fakes)', () => {
  /** The alerts area's own notifyUser and deliverMessage, with a recording inbox and mailer. */
  function gate(opts: { prefs?: StoredNotificationPrefs; recipient?: Partial<Recipient> | null; facts?: Partial<PreferenceFacts> | null } = {}) {
    const inApp: InAppRow[] = [];
    const sendEmail = vi.fn(async () => ({ status: 'sent' as const }));
    const recipient: Recipient | null =
      opts.recipient === null ? null : { userId: 'u1', brand: 'roboapply', email: 'jamie@example.test', locale: 'en', timeZone: 'UTC', seekerProfileId: 'sp1', ...opts.recipient };
    const facts: PreferenceFacts | null =
      opts.facts === null
        ? null
        : { userId: 'u1', brand: 'roboapply', tipsGranted: null, marketingGranted: null, country: null, prefs: opts.prefs ?? {}, timeZone: 'UTC', quietHours: { start: '21:00', end: '08:00' }, ...opts.facts };
    const deliverDeps: DeliverDeps = {
      createInApp: async (row) => {
        inApp.push(row);
        const id = `n_${inApp.length}`;
        fake.$rows('seekerNotification').push({ id, userId: row.userId, templateKey: row.templateKey, title: row.title, category: row.category, deepLink: row.deepLink });
        return { id };
      },
      markEmailed: async () => undefined,
      sendEmail,
      channels: () => [],
      emailEnabled: () => true,
      now: () => NOW,
    };
    const run = (input: NotifyUserInput) =>
      notifyUserWith(input, {
        repo: { recipients: async () => new Map(recipient ? [[recipient.userId, recipient]] : []) },
        prefs: { load: async () => facts },
        deliver: (msg) => deliverMessage(msg, deliverDeps),
      });
    return { inApp, sendEmail, run: vi.fn(run) };
  }

  beforeEach(() => {
    fake = createFakePrisma();
    candidates = [candidate({ dateApplied: new Date(NOW.getTime() - 11 * DAY) })];
  });

  it('delivers in-app and by email in the person\'s language, and the inbox row carries the rendered key', async () => {
    const g = gate();
    expect(await produceTrackerReminders(ctx(), deps({ notify: g.run }))).toMatchObject({ processed: 1, emails: 1 });
    expect(g.inApp).toEqual([
      expect.objectContaining({ userId: 'u1', category: 'reminder', title: 'No reply from Acme for 11 days', deepLink: '/applications?entry=e1', relatedEntityType: 'tracker_entry', relatedEntityId: 'e1' }),
    ]);
    expect(g.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ template: 'notify.follow_up_reminder', to: 'jamie@example.test', userId: 'u1' }));
    expect(fake.$rows('seekerNotification')[0]).toMatchObject({ templateKey: 'tracker.followUp' });
  });

  it('quiet hours: deferred by the gate, nothing sent or recorded; sent once they end', async () => {
    const g = gate();
    expect(await produceTrackerReminders(ctx('roboapply', NIGHT), deps({ notify: g.run }))).toMatchObject({ processed: 0, deferred: 1 });
    expect(g.inApp).toHaveLength(0);
    expect(g.sendEmail).not.toHaveBeenCalled();
    expect(ledger()).toHaveLength(0);
    const morning = new Date('2026-10-11T09:00:00.000Z');
    expect(await produceTrackerReminders(ctx('roboapply', morning), deps({ notify: g.run }))).toMatchObject({ processed: 1, deferred: 0 });
    expect(g.inApp).toHaveLength(1);
    expect(g.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('the person\'s own quiet hours are used', async () => {
    const g = gate({ facts: { quietHours: { start: '11:00', end: '13:00' } } });
    expect(await produceTrackerReminders(ctx(), deps({ notify: g.run }))).toMatchObject({ deferred: 1 });
    expect(g.sendEmail).not.toHaveBeenCalled();
  });

  it('unsubscribed from reminder emails: the inbox message still arrives, no email is sent', async () => {
    const g = gate({ prefs: { unsubscribed: { reminders: '2026-10-01T00:00:00.000Z' } } });
    expect(await produceTrackerReminders(ctx(), deps({ notify: g.run }))).toMatchObject({ processed: 1, emails: 0 });
    expect(g.sendEmail).not.toHaveBeenCalled();
    expect(g.inApp).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({ payload: { inApp: true, email: null } });
  });

  it('reminders set to email only: no inbox row; set to in-app only: no email', async () => {
    const emailOnly = gate({ prefs: { channels: { reminder: ['email'] } } });
    expect(await produceTrackerReminders(ctx(), deps({ notify: emailOnly.run }))).toMatchObject({ processed: 1, emails: 1, inAppSkipped: 1 });
    expect(emailOnly.inApp).toHaveLength(0);

    fake = createFakePrisma();
    const inAppOnly = gate({ prefs: { channels: { reminder: ['in_app'] } } });
    expect(await produceTrackerReminders(ctx(), deps({ notify: inAppOnly.run }))).toMatchObject({ processed: 1, emails: 0 });
    expect(inAppOnly.sendEmail).not.toHaveBeenCalled();
    expect(inAppOnly.inApp).toHaveLength(1);
  });

  it('nobody to tell (deleted account) or a person of the other brand: dropped, nothing sent', async () => {
    const gone = gate({ recipient: null });
    expect(await produceTrackerReminders(ctx(), deps({ notify: gone.run }))).toMatchObject({ processed: 0, dropped: 1 });
    expect(gone.sendEmail).not.toHaveBeenCalled();
    expect(ledger()[0]).toMatchObject({ payload: { skipped: 'no_user' } });

    fake = createFakePrisma();
    const other = gate({ recipient: { brand: 'goapply' } });
    expect(await produceTrackerReminders(ctx(), deps({ notify: other.run }))).toMatchObject({ dropped: 1 });
    expect(other.inApp).toHaveLength(0);
    expect(ledger()[0]).toMatchObject({ payload: { skipped: 'other_brand' } });
  });
});

describe('default candidate query', () => {
  // The GoApply mode check lives in the cn jobs area, loaded on first use.
  beforeAll(async () => {
    await import('../cn/jobs/index.js');
  }, 60_000);


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
    fake = createFakePrisma();
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
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', relatedEntity: { type: 'tracker_entry', id: 'z0001' }, params: expect.objectContaining({ company: 'Initech', title: 'Analyst', days: 11 }) }));
  });

  it('GoApply, mode off: an application whose job is a third-party posting gets no reminder; the user\'s own import does', async () => {
    const applied = new Date(NOW.getTime() - 11 * DAY);
    const seed = {
      rATrackerEntry: [
        { id: 'e_gh', userId: 'u1', status: 'applied', dateApplied: applied, followUpAt: null, interviewAt: null, deadline: null, jobId: 'job_gh', externalSnapshot: null, deletedAt: null },
        { id: 'e_own', userId: 'u1', status: 'applied', dateApplied: applied, followUpAt: null, interviewAt: null, deadline: null, jobId: 'job_own', externalSnapshot: null, deletedAt: null },
      ],
      rAJob: [
        { id: 'job_gh', title: '产品经理', companyName: '示例科技有限公司', market: 'cn', visibility: 'public', ownerUserId: null },
        { id: 'job_own', title: '数据分析师', companyName: '我的导入公司', market: 'cn', visibility: 'private', ownerUserId: 'u1' },
      ],
    };
    // The fake does not model the `user: { brand }` relation filter; every seeded row is this brand's.
    const brandless = (db: ReturnType<typeof createFakePrisma>) =>
      new Proxy(db, {
        get: (target, prop: string) =>
          prop === 'rATrackerEntry'
            ? { ...target.rATrackerEntry, findMany: (args: { where: Record<string, unknown> }) => { const { user: _u, ...where } = args.where; return target.rATrackerEntry.findMany({ ...args, where }); } }
            : (target as unknown as Record<string, unknown>)[prop],
      });

    fake = createFakePrisma({ seed });
    await produceTrackerReminders(ctx('goapply'), { ...deps(), getDb: async () => brandless(fake) as never, loadCandidates: undefined, env: {} });
    expect(notify.mock.calls.map((c) => c[0].params.company)).toEqual(['我的导入公司']);
    expect(JSON.stringify(notify.mock.calls)).not.toContain('示例科技');
    expect(ledger().map((e) => e.entryId)).toEqual(['e_own']);

    notify.mockClear();
    fake = createFakePrisma({ seed });
    await produceTrackerReminders(ctx('goapply'), { ...deps(), getDb: async () => brandless(fake) as never, loadCandidates: undefined, env: { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' } });
    expect(notify.mock.calls.map((c) => c[0].params.company).sort()).toEqual(['我的导入公司', '示例科技有限公司'].sort());
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

  it('keys are facts, and the stored sentences come from the server i18n loader', () => {
    const f = { entryId: 'e', reason: 'deadline_soon' as const, at: '2026-10-11', days: 1, companyName: null, title: 'Analyst' };
    expect(reminderKey(f, 'intl')).toBe('deadline:2026-10-11');
    expect(reminderKey({ ...f, days: 3 }, 'cn')).toBe('deadline:2026-10-11:3d');
    const robo = getBrand('roboapply');
    const go = getBrand('goapply');
    expect(reminderInboxTitle(f, robo, 'en')).toBe('Applications for Analyst close tomorrow.');
    expect(reminderInboxTitle({ ...f, days: 2 }, robo, 'en')).toBe('Applications for Analyst close in 2 days.');
    expect(reminderInboxTitle({ ...f, days: 0 }, robo, 'en')).toBe('Applications for Analyst close today.');
    expect(reminderInboxTitle({ ...f, reason: 'no_reply_10d', days: 12, companyName: 'Acme' }, robo, 'en')).toBe('No reply from Acme for 12 days.');
    expect(reminderInboxTitle({ ...f, reason: 'follow_up_due', days: null, companyName: 'Acme' }, robo, 'en')).toBe('Your follow-up date for Acme is today.');
    expect(reminderInboxTitle({ ...f, reason: 'interview_tomorrow', days: null, companyName: 'Acme' }, robo, 'en')).toBe('Interview with Acme within 24 hours.');
    expect(reminderInboxTitle({ ...f, title: null }, robo, 'en')).toBe('Applications for this application close tomorrow.');
    // GoApply in Simplified Chinese (its default when no language was saved): its own sentences.
    for (const locale of ['zh', null, 'ja']) {
      expect(reminderInboxTitle({ ...f, days: 3 }, go, locale)).toBe('Analyst 的网申还有 3 天截止。');
    }
    // A GoApply person who chose English reads English.
    expect(reminderInboxTitle({ ...f, days: 3 }, go, 'en')).toBe('Applications for Analyst close in 3 days.');
    expect(reminderInboxTitle({ ...f, days: 0 }, go, 'zh')).toBe('Analyst 的网申今天截止。');
    expect(reminderInboxTitle({ ...f, reason: 'no_reply_10d', days: 12 }, go, 'zh')).toBe('Analyst 已 12 天没有回复。');
    expect(reminderInboxTitle({ ...f, reason: 'follow_up_due', days: null }, go, 'zh')).toBe('今天是你为 Analyst 设定的跟进日期。');
    expect(reminderInboxTitle({ ...f, reason: 'interview_tomorrow', days: null }, go, 'zh')).toBe('Analyst 的面试将在 24 小时内开始。');
    // RoboApply in Traditional Chinese (Taiwan) never gets the mainland words: English until WP-92 translates `tracker.inbox`.
    expect(reminderInboxTitle(f, robo, 'zh-TW')).toBe('Applications for Analyst close tomorrow.');
  });

  it('a reminder email is used only when every value it states is real for the entry', () => {
    const fact = (over: Partial<Parameters<typeof reminderDelivery>[0]>) => ({ entryId: 'e1', userId: 'u1', key: 'k', reason: 'no_reply_10d' as const, at: NOW.toISOString(), days: 12, companyName: 'Acme', title: 'Analyst', ...over });
    const applied = new Date(NOW.getTime() - 12 * DAY);
    // Applied 10+ days ago with no reply: the "no reply for N days" email (N is never below 10).
    expect(reminderDelivery(fact({ at: applied.toISOString() }), candidate({ dateApplied: applied }))).toMatchObject({
      via: 'notify',
      templateKey: 'notify.follow_up_reminder',
      inboxKey: 'tracker.followUp',
      params: { appliedAt: applied.toISOString(), days: 12 },
    });
    // The follow-up date the user set: the tracker knows the date came, not that there was no reply.
    for (const c of [candidate({ dateApplied: applied, followUpAt: NOW }), candidate({ status: 'interviewing', dateApplied: applied }), candidate({ status: 'bookmarked' }), candidate({ dateApplied: NOW })]) {
      const plan = reminderDelivery(fact({ reason: 'follow_up_due', days: null }), c);
      expect(plan).toMatchObject({ via: 'inbox', inboxKey: 'tracker.followUpDue', params: { company: 'Acme' } });
      expect(plan.params).not.toHaveProperty('days');
    }
    // No company or no title to name in the email: the plain inbox sentence instead.
    expect(reminderDelivery(fact({ companyName: null }), candidate({ dateApplied: applied }))).toMatchObject({
      via: 'inbox',
      inboxKey: 'tracker.followUp',
      params: { company: 'Analyst', days: 12 },
    });
    expect(reminderDelivery(fact({ reason: 'interview_tomorrow', title: null }), candidate({}))).toMatchObject({ via: 'inbox', inboxKey: 'tracker.interview' });
    // An entry the user typed in has no job to practise for.
    expect(reminderDelivery(fact({ reason: 'interview_tomorrow' }), candidate({ jobId: null }))).toMatchObject({ via: 'notify', params: { jobId: null } });
  });
});
