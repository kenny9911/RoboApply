// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../platform/brand/registry.js';
import { createBudget, type CronContext, type CronTask } from '../../platform/queue/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import type { NotifyMessage } from './deliver.js';
import { notifyUserWith, type NotifyUserDeps } from './notify.js';
import type { PreferenceFacts } from './preferences.js';
import { createRemindersRunner, registerReminderProducer, reminderProducers, resetReminderProducersForTests } from './reminders.js';
import type { Recipient } from './repo.js';

const recipient: Recipient = { userId: 'u1', brand: 'roboapply', email: 'u1@example.com', locale: 'en', timeZone: 'Europe/Berlin', seekerProfileId: 'sp1' };
const facts = (over: Partial<PreferenceFacts> = {}): PreferenceFacts => ({
  userId: 'u1',
  brand: 'roboapply',
  tipsGranted: null,
  marketingGranted: null,
  country: 'DE',
  prefs: {},
  timeZone: 'Europe/Berlin',
  quietHours: { start: '21:00', end: '08:00' },
  ...over,
});

function deps(f: PreferenceFacts | null = facts()): NotifyUserDeps & { sent: NotifyMessage[] } {
  const sent: NotifyMessage[] = [];
  return {
    sent,
    repo: { recipients: async (ids) => new Map(ids.includes('u1') ? [['u1', recipient]] : []) },
    prefs: { load: async () => f },
    deliver: async (msg) => (sent.push(msg), { notificationId: 'n1', email: null, channels: {} }),
  };
}

const input = {
  userId: 'u1',
  templateKey: NOTIFY_TEMPLATES.followUpReminder,
  params: { entryId: 'e1', title: 'Engineer', company: 'Acme', appliedAt: '2026-09-30T10:00:00Z', days: 10 },
  href: '/applications?entry=e1',
  category: 'reminder' as const,
};

describe('notifyUser', () => {
  it('delivers a reminder outside quiet hours', async () => {
    const d = deps();
    const r = await notifyUserWith({ ...input, now: new Date('2026-10-10T10:00:00Z') }, d); // 12:00 Berlin
    expect(r.status).toBe('delivered');
    expect(d.sent[0]).toMatchObject({ kind: 'reminder', category: 'reminder', templateKey: NOTIFY_TEMPLATES.followUpReminder, href: '/applications?entry=e1' });
  });

  it('defers inside quiet hours until they end', async () => {
    const d = deps();
    const r = await notifyUserWith({ ...input, now: new Date('2026-10-10T21:00:00Z') }, d); // 23:00 Berlin
    expect(r).toEqual({ status: 'deferred', retryAt: new Date('2026-10-11T06:00:00Z') }); // 08:00 Berlin
    expect(d.sent).toHaveLength(0);
  });

  it('a "Tips and reminders" message is never sent with the preference off', async () => {
    const tips = { ...input, templateKey: NOTIFY_TEMPLATES.tipsPractice, params: {}, category: 'tips' as const, now: new Date('2026-10-10T10:00:00Z') };
    const de = deps(facts({ country: 'DE' }));
    expect(await notifyUserWith(tips, de)).toEqual({ status: 'skipped', reason: 'preference_off' });
    expect(de.sent).toHaveLength(0);
    const us = deps(facts({ country: 'US' }));
    expect((await notifyUserWith(tips, us)).status).toBe('delivered');
  });

  it('skips unknown people and people of the other brand', async () => {
    expect(await notifyUserWith({ ...input, userId: 'nobody' }, deps())).toEqual({ status: 'skipped', reason: 'no_user' });
    expect(await notifyUserWith({ ...input, brand: 'goapply' }, deps())).toEqual({ status: 'skipped', reason: 'other_brand' });
  });
});

describe('reminders runner', () => {
  const ctx = (market: 'intl' | 'cn' = 'intl'): CronContext => ({
    name: 'reminders',
    brand: getBrand(market === 'cn' ? 'goapply' : 'roboapply'),
    budget: createBudget(240_000),
    now: new Date('2026-10-10T10:00:00Z'),
  });

  it('runs every registered producer for the market, isolates failures, then drains email.send', async () => {
    resetReminderProducersForTests();
    const tracker: CronTask = vi.fn(async () => ({ processed: 2 }));
    const campus: CronTask = vi.fn(async () => ({ processed: 1 }));
    const broken: CronTask = async () => {
      throw new Error('boom');
    };
    registerReminderProducer({ name: 'tracker', task: tracker });
    registerReminderProducer({ name: 'tracker', task: tracker }); // idempotent
    registerReminderProducer({ name: 'campus', task: campus, markets: ['cn'] });
    registerReminderProducer({ name: 'broken', task: broken });
    expect(() => registerReminderProducer({ name: 'tracker', task: async () => ({}) })).toThrow(/already registered/);
    const drainEmail = vi.fn(async () => 2);
    const run = createRemindersRunner(reminderProducers, { drainEmail });
    const r = await run(ctx('intl'));
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(campus).not.toHaveBeenCalled();
    expect(r).toMatchObject({ processed: 2, emailed: 2, producers: { tracker: { processed: 2 }, broken: { error: 'step_failed' } } });
    expect(drainEmail).toHaveBeenCalledTimes(1);
    await run(ctx('cn'));
    expect(campus).toHaveBeenCalledTimes(1);
    resetReminderProducersForTests();
  });

  it('answers no_work when nothing is registered or nothing was produced (no drain)', async () => {
    resetReminderProducersForTests();
    const drainEmail = vi.fn(async () => 0);
    expect(await createRemindersRunner(reminderProducers, { drainEmail })(ctx())).toEqual({ skipped: 'no_work', processed: 0 });
    registerReminderProducer({ name: 'idle', task: async () => ({ skipped: 'no_work', processed: 0 }) });
    const r = await createRemindersRunner(reminderProducers, { drainEmail })(ctx());
    expect(r.skipped).toBe('no_work');
    expect(drainEmail).not.toHaveBeenCalled();
    resetReminderProducersForTests();
  });
});
