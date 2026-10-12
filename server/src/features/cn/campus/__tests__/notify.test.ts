// @vitest-environment node
// WP-58 reminders: 网申截止 3 days and 1 day before, once each per
// user/programme (overlapping runs too), facts only; follow-a-company notices
// once per user and programme; GoApply only; idle runs are cheap.

import { describe, expect, it, vi } from 'vitest';

// The WeChat service pulls in the notify-cn area, which reaches the Prisma client module.
vi.mock('../../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import { getBrand } from '../../../../platform/brand/index.js';
import type { CronContext } from '../../../../platform/queue/index.js';
import { NOTIFY_TEMPLATES } from '../../../../platform/email/templates/notify/index.js';
import { registerReminderProducer, reminderProducers, resetReminderProducersForTests } from '../../../alerts/index.js';
import type { NotificationPreferencesView } from '../../../notifications/index.js';
import { NotifyCnService, type NotifyCnRepo, type WechatNoticeInput } from '../../../notify-cn/index.js';
import { produceReminders } from '../cron.js';
import { calendarDaysLeft, deadlineText, formatClose, notifyFollowers, produceCampusReminders, reminderDue, reminderWindow, wechatReminderWaits, type CampusNotifyDeps } from '../notify.js';
import { DAY, NOW, eventRow, fakeCampusRepo, fakeNotifyRepo } from './testkit.js';

function ctx(now: Date, brand: 'goapply' | 'roboapply' = 'goapply'): CronContext {
  return { name: 'reminders', brand: getBrand(brand), now, budget: { exhausted: () => false, remainingMs: () => 200_000 } } as unknown as CronContext;
}

function setup(closesInMs: number, opts: { lock?: boolean } = {}) {
  const campus = fakeCampusRepo([eventRow({ id: 'ev', applyClosesAt: new Date(NOW.getTime() + closesInMs) })]);
  const repo = fakeNotifyRepo(campus, opts);
  repo.profileOf.set('u1', { locale: 'zh', timezone: null });
  const created: Array<{ userId: string; title: string; href?: string | null; params?: Record<string, unknown> | null; templateKey?: string | null; relatedEntityId?: string | null }> = [];
  const emails: Array<{ dedupeKey: string; params: Record<string, unknown>; template?: string; userId?: string | null }> = [];
  const deps: CampusNotifyDeps = {
    repo,
    createNotification: async (input) => {
      await new Promise((r) => setTimeout(r, 0)); // a real write yields; lets overlapping callers interleave
      created.push(input);
      repo.inbox.push({ userId: input.userId, templateKey: input.templateKey ?? '', eventId: input.relatedEntityId ?? '' });
      return { id: `n${created.length}` };
    },
    enqueueEmail: async (payload, opts) => {
      emails.push({ dedupeKey: opts.dedupeKey, params: payload.params, template: payload.template, userId: payload.userId });
    },
    emailTemplateRegistered: () => true,
  };
  return { campus, repo, deps, created, emails };
}

describe('reminder windows', () => {
  const close = new Date(NOW.getTime() + 10 * DAY);
  it('3-day window, then 1-day window, nothing outside', () => {
    expect(reminderWindow(close, new Date(close.getTime() - 4 * DAY))).toBeNull();
    expect(reminderWindow(close, new Date(close.getTime() - 2.5 * DAY))?.days).toBe(3);
    expect(reminderWindow(close, new Date(close.getTime() - 0.5 * DAY))?.days).toBe(1);
    expect(reminderWindow(close, new Date(close.getTime() + 1))).toBeNull();
  });
  it('a window is due once', () => {
    const start = new Date(close.getTime() - 3 * DAY);
    expect(reminderDue(null, start)).toBe(true);
    expect(reminderDue(new Date(start.getTime() + 1), start)).toBe(false);
    expect(reminderDue(new Date(start.getTime() - 1), start)).toBe(true);
  });
});

describe('produceCampusReminders', () => {
  it('sends the 3-day reminder once, then the 1-day reminder once', async () => {
    const s = setup(2.5 * DAY);
    s.campus.subs.push({ id: 'sub1', userId: 'u1', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'email', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    const r1 = await produceCampusReminders(ctx(NOW), s.deps);
    expect(r1).toMatchObject({ reminders: 1, inApp: 1, emails: 1 });
    expect(s.created[0]).toMatchObject({ userId: 'u1', templateKey: 'campus.deadline', relatedEntityId: 'ev', href: '/campus/%E7%A4%BA%E4%BE%8B%E7%A7%91%E6%8A%80' });
    expect(s.created[0]!.title).toBe('示例科技：网申3天后截止');
    expect(s.emails[0]!.params).toMatchObject({ eventId: 'ev', officialUrl: 'https://campus.example.cn/2027', timeZone: 'Asia/Shanghai' });

    // Same window, next hour: nothing new.
    const r2 = await produceCampusReminders(ctx(new Date(NOW.getTime() + 60 * 60 * 1000)), s.deps);
    expect(r2.reminders ?? 0).toBe(0);
    expect(s.created).toHaveLength(1);

    // Inside the 1-day window: one more.
    const later = new Date(NOW.getTime() + 1.8 * DAY);
    await produceCampusReminders(ctx(later), s.deps);
    await produceCampusReminders(ctx(new Date(later.getTime() + 60 * 60 * 1000)), s.deps);
    expect(s.created.map((c) => c.title)).toEqual(['示例科技：网申3天后截止', '示例科技：网申明天截止']);
    expect(new Set(s.emails.map((e) => e.dedupeKey)).size).toBe(2);
  });

  it('two overlapping runs send one reminder (atomic claim)', async () => {
    const s = setup(2 * DAY);
    s.campus.subs.push({ id: 'sub1', userId: 'u1', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'email', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    await Promise.all([produceCampusReminders(ctx(NOW), s.deps), produceCampusReminders(ctx(NOW), s.deps)]);
    expect(s.created).toHaveLength(1);
    expect(s.emails).toHaveLength(1);
  });

  it('skips other brands’ users, closed, unpublished and far-off programmes; idle is no_work', async () => {
    const s = setup(10 * DAY);
    s.campus.subs.push({ id: 'sub1', userId: 'u1', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    expect(await produceCampusReminders(ctx(NOW), s.deps)).toMatchObject({ skipped: 'no_work', processed: 0 });
    expect(await produceCampusReminders(ctx(NOW, 'roboapply'), s.deps)).toMatchObject({ skipped: 'not_for_market' });
    s.campus.events.get('ev')!.applyClosesAt = new Date(NOW.getTime() + DAY);
    s.campus.events.get('ev')!.status = 'draft';
    s.campus.subs.push({ id: 'sub2', userId: 'u9', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand: 'roboapply' });
    await produceCampusReminders(ctx(NOW), s.deps);
    expect(s.created).toHaveLength(0);
  });

  it('in-app subscribers get the inbox row and no email', async () => {
    const s = setup(2 * DAY);
    s.campus.subs.push({ id: 'sub1', userId: 'u1', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    const r = await produceCampusReminders(ctx(NOW), s.deps);
    expect(r).toMatchObject({ reminders: 1, inApp: 1, emails: 0 });
    expect(s.emails).toHaveLength(0);
  });

  it('says the real time left, in Beijing calendar days, whenever it runs', async () => {
    // NOW is 2026-10-10 12:00 Beijing. Subscribed 1.5 days before a 23:59 close the next day.
    const s = setup(new Date('2026-10-11T15:59:00.000Z').getTime() - NOW.getTime());
    s.campus.subs.push({ id: 'sub1', userId: 'u1', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    await produceCampusReminders(ctx(NOW), s.deps);
    expect(s.created[0]!.title).toBe('示例科技：网申明天截止');
    expect(s.created[0]!.params).toMatchObject({ days: 1 });

    // Subscribed 6 hours before an 18:00 close the same day.
    const t = setup(6 * 60 * 60 * 1000);
    t.campus.subs.push({ id: 'sub1', userId: 'u1', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    await produceCampusReminders(ctx(NOW), t.deps);
    expect(t.created[0]!.title).toBe('示例科技：网申今天截止');
    expect(t.created[0]!.params).toMatchObject({ days: 0 });
  });

  it('a user without a seeker profile gets the email only', async () => {
    const s = setup(DAY / 2);
    s.campus.subs.push({ id: 'sub1', userId: 'u2', kind: 'event', eventId: 'ev', companyNameNormalized: null, graduationClass: null, channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    const r = await produceCampusReminders(ctx(NOW), s.deps);
    expect(r).toMatchObject({ reminders: 1, inApp: 0, emails: 1 });
  });
});

// ── WeChat (WP-93 #22): the final reminder mirrors to the 公众号 ──

const WECHAT_ENV = { WECHAT_MP_APP_ID: 'wx_mp_app', WECHAT_MP_APP_SECRET: 'mp_secret', WECHAT_MP_TOKEN: 'mp_token', WECHAT_MP_TEMPLATE_DEADLINE: 'Tpl_Deadline_01', CN_CANONICAL_ORIGIN: 'https://www.goapply.top' };

/**
 * The real WeChat notice service over an in-memory grant store: `grants` are
 * the prompts the person accepted (one message each), keyed by the event the
 * tap was for. The WeChat API is a recorder; nothing leaves the process.
 */
function wechatWorld(opts: { grants?: Array<{ userId: string; eventId: string | null }>; wechatOn?: boolean } = {}) {
  const grants = (opts.grants ?? []).map((g, i) => ({ ...g, id: `g${i + 1}`, used: false }));
  const delivered: string[] = [];
  const sentMessages: Array<{ touser: string; template_id: string; page?: string; data: Record<string, { value: string }> }> = [];
  const repo: NotifyCnRepo = {
    mpOpenId: async (userId) => (userId === 'u1' ? 'openid_u1' : null),
    userForOpenId: async () => null,
    addGrants: async () => ({}),
    claimGrant: async (userId, _brand, _key, _now, eventId) => {
      const mine = grants.filter((g) => g.userId === userId && !g.used);
      const g = (eventId ? mine.find((x) => x.eventId === eventId) : undefined) ?? mine[0];
      if (!g) return null;
      g.used = true;
      return { id: g.id, templateId: 'Tpl_Deadline_01' };
    },
    releaseGrant: async (id) => {
      const g = grants.find((x) => x.id === id);
      if (g) g.used = false;
    },
    revokeGrants: async () => 0,
    markDelivered: async (id) => {
      delivered.push(id);
    },
  };
  const service = new NotifyCnService({
    repo,
    env: WECHAT_ENV,
    now: () => NOW,
    api: {
      accessToken: async () => 'AT',
      jsapiTicket: async () => 'TICKET',
      sendSubscribeMessage: async (_app, message) => {
        sentMessages.push(message as (typeof sentMessages)[number]);
        return `m${sentMessages.length}`;
      },
    },
    preferences: async () => ({ channels: { reminder: opts.wechatOn === false ? ['in_app'] : ['in_app', 'wechat'] } }) as unknown as NotificationPreferencesView,
    optInWechat: async () => 'already',
  });
  const calls: WechatNoticeInput<'deadline_reminder'>[] = [];
  const sendWechat: NonNullable<CampusNotifyDeps['sendWechat']> = async (input) => (calls.push(input), service.sendNotice(input));
  return { sendWechat, calls, sentMessages, delivered, grants };
}

const wechatSub = (over: Record<string, unknown> = {}) => ({
  id: 'sub1',
  userId: 'u1',
  kind: 'event' as const,
  eventId: 'ev',
  companyNameNormalized: null,
  graduationClass: null,
  channel: 'wechat',
  createdAt: NOW,
  lastNotifiedAt: null,
  brand: 'goapply',
  ...over,
});

describe('截止提醒 → WeChat (final window only)', () => {
  it('none in the 3-day window, exactly one with the 1-day reminder, mirroring the inbox row', async () => {
    const s = setup(2.5 * DAY);
    const w = wechatWorld({ grants: [{ userId: 'u1', eventId: 'ev' }] });
    s.campus.subs.push(wechatSub());
    const deps = { ...s.deps, sendWechat: w.sendWechat };

    // 3 days before: the inbox reminder goes out, WeChat is not asked (the one permission is kept for the last reminder).
    expect(await produceCampusReminders(ctx(NOW), deps)).toMatchObject({ reminders: 1, inApp: 1, wechat: 0, emails: 0 });
    expect(w.calls).toHaveLength(0);
    expect(w.sentMessages).toHaveLength(0);

    // Inside the final window (09:36 Beijing time, outside quiet hours): one WeChat notice, about this programme, for the row just written.
    const later = new Date(NOW.getTime() + 1.9 * DAY);
    const r = await produceCampusReminders(ctx(later), deps);
    expect(r).toMatchObject({ reminders: 1, inApp: 1, wechat: 1 });
    expect(w.calls).toEqual([
      {
        userId: 'u1',
        template: 'deadline_reminder',
        params: { company: '示例科技', program: s.campus.events.get('ev')!.title, closesAt: s.campus.events.get('ev')!.applyClosesAt!.toISOString(), days: 1 },
        href: '/campus/%E7%A4%BA%E4%BE%8B%E7%A7%91%E6%8A%80',
        notificationId: 'n2',
        eventId: 'ev',
      },
    ]);
    expect(w.sentMessages).toHaveLength(1);
    expect(w.sentMessages[0]).toMatchObject({ touser: 'openid_u1', template_id: 'Tpl_Deadline_01', page: 'https://www.goapply.top/campus/%E7%A4%BA%E4%BE%8B%E7%A7%91%E6%8A%80' });
    // The inbox row it mirrors is stamped as delivered.
    expect(w.delivered).toEqual(['n2']);

    // Later runs in the same window: the reminder was claimed once, so nothing more is sent anywhere.
    await produceCampusReminders(ctx(new Date(later.getTime() + 60 * 60 * 1000)), deps);
    expect(w.sentMessages).toHaveLength(1);
    expect(s.created).toHaveLength(2);
  });

  it('none without a subscription: no accepted prompt, WeChat turned off, or a reminder not saved from WeChat', async () => {
    // No accepted prompt left: the service is asked and answers "no subscription"; the inbox row still goes out.
    const noGrant = setup(DAY / 2);
    const a = wechatWorld({ grants: [] });
    noGrant.campus.subs.push(wechatSub());
    expect(await produceCampusReminders(ctx(NOW), { ...noGrant.deps, sendWechat: a.sendWechat })).toMatchObject({ reminders: 1, inApp: 1, wechat: 0 });
    expect(a.calls).toHaveLength(1);
    expect(a.sentMessages).toHaveLength(0);

    // The person turned WeChat off for reminders in Settings: not sent, and the accepted prompt is not used up.
    const off = setup(DAY / 2);
    const b = wechatWorld({ grants: [{ userId: 'u1', eventId: 'ev' }], wechatOn: false });
    off.campus.subs.push(wechatSub());
    expect(await produceCampusReminders(ctx(NOW), { ...off.deps, sendWechat: b.sendWechat })).toMatchObject({ reminders: 1, inApp: 1, wechat: 0 });
    expect(b.sentMessages).toHaveLength(0);
    expect(b.grants[0]!.used).toBe(false);

    // A reminder saved outside WeChat (in_app / email) never spends a permission given for another programme.
    for (const channel of ['in_app', 'email']) {
      const other = setup(DAY / 2);
      const c = wechatWorld({ grants: [{ userId: 'u1', eventId: 'another_event' }] });
      other.campus.subs.push(wechatSub({ channel }));
      expect(await produceCampusReminders(ctx(NOW), { ...other.deps, sendWechat: c.sendWechat })).toMatchObject({ reminders: 1, wechat: 0 });
      expect(c.calls).toHaveLength(0);
      expect(c.grants[0]!.used).toBe(false);
    }
  });

  it('no inbox row, no WeChat notice (it mirrors the row); a WeChat failure never fails the run', async () => {
    // No seeker profile: there is no inbox to mirror.
    const s = setup(DAY / 2);
    const w = wechatWorld({ grants: [{ userId: 'u2', eventId: 'ev' }] });
    s.campus.subs.push(wechatSub({ userId: 'u2' }));
    expect(await produceCampusReminders(ctx(NOW), { ...s.deps, sendWechat: w.sendWechat })).toMatchObject({ reminders: 1, inApp: 0, wechat: 0 });
    expect(w.calls).toHaveLength(0);

    const t = setup(DAY / 2);
    t.campus.subs.push(wechatSub());
    const boom = vi.fn(async () => {
      throw new Error('wechat down');
    });
    expect(await produceCampusReminders(ctx(NOW), { ...t.deps, sendWechat: boom })).toMatchObject({ reminders: 1, inApp: 1, wechat: 0 });
    expect(boom).toHaveBeenCalledTimes(1);
    expect(t.created).toHaveLength(1);
  });

  it('spends the permission given for this programme, not one given for another', async () => {
    const s = setup(DAY / 2);
    const w = wechatWorld({ grants: [{ userId: 'u1', eventId: 'another_event' }, { userId: 'u1', eventId: 'ev' }] });
    s.campus.subs.push(wechatSub());
    await produceCampusReminders(ctx(NOW), { ...s.deps, sendWechat: w.sendWechat });
    expect(w.grants.map((g) => [g.eventId, g.used])).toEqual([['another_event', false], ['ev', true]]);
  });

  it('quiet hours: a 23:59 close is not pushed at midnight; the first run after 08:00 writes the row and sends the notice', async () => {
    const close = new Date('2026-10-11T15:59:00.000Z'); // 23:59 Beijing time, 11 Oct
    const s = setup(close.getTime() - NOW.getTime());
    const w = wechatWorld({ grants: [{ userId: 'u1', eventId: 'ev' }] });
    s.campus.subs.push(wechatSub());
    const deps = { ...s.deps, sendWechat: w.sendWechat };

    // 00:10 Beijing time: the final window opened 11 minutes ago. Nothing is claimed, written or sent.
    const midnight = new Date('2026-10-10T16:10:00.000Z');
    expect(await produceCampusReminders(ctx(midnight), deps)).toMatchObject({ reminders: 0, inApp: 0, wechat: 0, deferred: 1 });
    expect(s.campus.subs[0]!.lastNotifiedAt).toBeNull();
    expect(s.created).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
    // Still quiet at 07:10: the hourly runs in between change nothing.
    expect(await produceCampusReminders(ctx(new Date('2026-10-10T23:10:00.000Z')), deps)).toMatchObject({ reminders: 0, deferred: 1 });
    expect(s.created).toHaveLength(0);

    // 08:05: one inbox row and one WeChat notice, about 16 hours before the close ("closes today").
    const morning = new Date('2026-10-11T00:05:00.000Z');
    expect(await produceCampusReminders(ctx(morning), deps)).toMatchObject({ reminders: 1, inApp: 1, wechat: 1, deferred: 0 });
    expect(s.created).toHaveLength(1);
    expect(w.sentMessages).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ notificationId: 'n1', eventId: 'ev', params: { days: 0 } });
    // And only once.
    await produceCampusReminders(ctx(new Date(morning.getTime() + 60 * 60 * 1000)), deps);
    expect(s.created).toHaveLength(1);
    expect(w.sentMessages).toHaveLength(1);
  });

  it('quiet hours: sent at night when the programme closes before the morning run; inbox-only reminders never wait', async () => {
    // Closes 07:30 Beijing time: waiting for 08:00 would mean no reminder at all.
    const early = new Date('2026-10-10T23:30:00.000Z');
    const s = setup(early.getTime() - NOW.getTime());
    const w = wechatWorld({ grants: [{ userId: 'u1', eventId: 'ev' }] });
    s.campus.subs.push(wechatSub());
    const midnight = new Date('2026-10-10T16:10:00.000Z');
    expect(await produceCampusReminders(ctx(midnight), { ...s.deps, sendWechat: w.sendWechat })).toMatchObject({ reminders: 1, inApp: 1, wechat: 1, deferred: 0 });

    // An in-app subscription is an inbox row, not a push: written as soon as the window opens.
    const close = new Date('2026-10-11T15:59:00.000Z');
    const t = setup(close.getTime() - NOW.getTime());
    const v = wechatWorld({ grants: [{ userId: 'u1', eventId: 'ev' }] });
    t.campus.subs.push(wechatSub({ channel: 'in_app' }));
    expect(await produceCampusReminders(ctx(midnight), { ...t.deps, sendWechat: v.sendWechat })).toMatchObject({ reminders: 1, inApp: 1, wechat: 0, deferred: 0 });
    expect(v.calls).toHaveLength(0);
  });

  it('quiet hours follow the person: their own hours and time zone, else 21:00–08:00 Beijing time', () => {
    const close = new Date('2026-10-11T15:59:00.000Z');
    const at = (iso: string) => new Date(iso);
    // Default hours, Beijing time.
    expect(wechatReminderWaits(close, at('2026-10-10T16:10:00.000Z'), { timezone: null })).toBe(true); // 00:10
    expect(wechatReminderWaits(close, at('2026-10-11T00:05:00.000Z'), { timezone: null })).toBe(false); // 08:05
    expect(wechatReminderWaits(close, at('2026-10-11T13:30:00.000Z'), { timezone: null })).toBe(false); // 21:30, closes 23:59: send now
    // Their own hours (23:00–07:00): 07:05 is no longer quiet.
    expect(wechatReminderWaits(close, at('2026-10-10T23:05:00.000Z'), { timezone: null, quietHours: { start: '23:00', end: '07:00' } })).toBe(false);
    expect(wechatReminderWaits(close, at('2026-10-10T22:30:00.000Z'), { timezone: null, quietHours: { start: '23:00', end: '07:00' } })).toBe(true); // 06:30
    // Their own time zone: 00:10 in Beijing is 01:10 in Tokyo (quiet) and 16:10 in London (not quiet).
    expect(wechatReminderWaits(close, at('2026-10-10T16:10:00.000Z'), { timezone: 'Asia/Tokyo' })).toBe(true);
    expect(wechatReminderWaits(close, at('2026-10-10T16:10:00.000Z'), { timezone: 'Europe/London' })).toBe(false);
    // An unreadable zone falls back to Beijing time.
    expect(wechatReminderWaits(close, at('2026-10-10T16:10:00.000Z'), { timezone: 'Not/AZone' })).toBe(true);
  });

  it('produceReminders stays the one registered function reference', async () => {
    resetReminderProducersForTests();
    try {
      registerReminderProducer({ name: 'campus', task: produceReminders, markets: ['cn'] });
      // Registering it again (another import path, a second boot step) is the same producer, not a clash.
      const again = (await import('../cron.js')).produceReminders;
      expect(again).toBe(produceReminders);
      expect(() => registerReminderProducer({ name: 'campus', task: again, markets: ['cn'] })).not.toThrow();
      expect(reminderProducers().filter((p) => p.name === 'campus')).toHaveLength(1);
      expect(reminderProducers()[0]!.task).toBe(produceReminders);
    } finally {
      resetReminderProducersForTests();
    }
  });
});

describe('follow a company', () => {
  it('notifies followers of the company and 届别 once per programme', async () => {
    const s = setup(20 * DAY);
    const ev = s.campus.events.get('ev')!;
    s.repo.profileOf.set('u2', { locale: 'en', timezone: null });
    s.repo.profileOf.set('u3', { locale: 'zh', timezone: null });
    const follow = (id: string, userId: string, cls: string, brand = 'goapply') =>
      s.campus.subs.push({ id, userId, kind: 'company', eventId: null, companyNameNormalized: '示例科技', graduationClass: cls, channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand });
    follow('f1', 'u1', '2027届');
    follow('f2', 'u2', '2027届');
    follow('f3', 'u3', '2028届');
    follow('f4', 'u4', '2027届', 'roboapply');

    expect(await notifyFollowers(ev, 'goapply', s.deps)).toBe(2);
    expect(s.created.map((c) => [c.userId, c.title])).toEqual([
      ['u1', '你关注的示例科技发布了2027届项目'],
      ['u2', '示例科技 posted a 2027届 programme'],
    ]);
    // The hourly catch-up and a second publish do not repeat it.
    await produceCampusReminders(ctx(NOW), s.deps);
    expect(await notifyFollowers(ev, 'goapply', s.deps)).toBe(0);
    expect(s.created).toHaveLength(2);
  });

  it('a publish and an overlapping hourly run notify each follower once (per-programme lock)', async () => {
    const run = async (lock: boolean) => {
      const s = setup(20 * DAY, { lock });
      s.repo.profileOf.set('u2', { locale: 'zh', timezone: null });
      for (const [id, userId] of [['f1', 'u1'], ['f2', 'u2']] as const) {
        s.campus.subs.push({ id, userId, kind: 'company', eventId: null, companyNameNormalized: '示例科技', graduationClass: '2027届', channel: 'in_app', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
      }
      const ev = s.campus.events.get('ev')!;
      const counts = await Promise.all([notifyFollowers(ev, 'goapply', s.deps), produceCampusReminders(ctx(NOW), s.deps).then((r) => r.followNotices ?? 0)]);
      return { created: s.created, counts };
    };
    // Without the lock the two callers interleave and both send.
    expect((await run(false)).created).toHaveLength(4);
    const locked = await run(true);
    expect(locked.created.map((c) => c.userId).sort()).toEqual(['u1', 'u2']);
    expect(locked.counts[0] + locked.counts[1]).toBe(2);
    expect(locked.created[0]!.href).toBe('/campus/%E7%A4%BA%E4%BE%8B%E7%A7%91%E6%8A%80');
  });

  it('stores the template key and params the inbox renders, and emails only followers who chose email', async () => {
    const s = setup(20 * DAY);
    const ev = s.campus.events.get('ev')!;
    s.repo.profileOf.set('u2', { locale: 'zh', timezone: null });
    const follow = (id: string, userId: string, channel: string) =>
      s.campus.subs.push({ id, userId, kind: 'company', eventId: null, companyNameNormalized: '示例科技', graduationClass: '2027届', channel, createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    follow('f1', 'u1', 'in_app');
    follow('f2', 'u2', 'email');
    expect(await notifyFollowers(ev, 'goapply', s.deps)).toBe(2);
    expect(s.created[0]).toMatchObject({
      templateKey: 'campus.followed',
      params: { eventId: 'ev', company: '示例科技', companySlug: '示例科技', program: ev.title, graduationClass: '2027届' },
    });
    // One email, to the follower who asked for email; the platform's gates decide whether it is sent.
    expect(s.emails).toEqual([
      { template: NOTIFY_TEMPLATES.campusFollowed, userId: 'u2', dedupeKey: 'campus.followed:ev:u2', params: s.created[1]!.params },
    ]);
    // A second publish or the hourly catch-up repeats neither.
    await produceCampusReminders(ctx(NOW), s.deps);
    expect(s.emails).toHaveLength(1);
    // Without the template registered (e.g. a worker that has not loaded it), no email is queued.
    const t = setup(20 * DAY);
    t.campus.subs.push({ id: 'f1', userId: 'u1', kind: 'company', eventId: null, companyNameNormalized: '示例科技', graduationClass: '2027届', channel: 'email', createdAt: NOW, lastNotifiedAt: null, brand: 'goapply' });
    expect(await notifyFollowers(t.campus.events.get('ev')!, 'goapply', { ...t.deps, emailTemplateRegistered: () => false })).toBe(1);
    expect(t.emails).toHaveLength(0);
  });

  it('drafts never notify', async () => {
    const s = setup(20 * DAY);
    const create = vi.fn();
    expect(await notifyFollowers(eventRow({ status: 'draft' }), 'goapply', { ...s.deps, createNotification: create })).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('copy', () => {
  it('states the official close time in Beijing time', () => {
    const close = new Date('2026-10-31T15:59:00.000Z');
    expect(formatClose(close, 'zh')).toContain('23:59');
    expect(formatClose(close, 'zh')).toContain('北京时间');
    expect(formatClose(close, 'en')).toContain('Beijing time');
    expect(deadlineText({ companyName: 'Acme', title: 'P', applyClosesAt: close }, 1, 'en').title).toBe('Acme: applications close tomorrow');
    expect(deadlineText({ companyName: 'Acme', title: 'P', applyClosesAt: close }, 0, 'en').title).toBe('Acme: applications close today');
    expect(deadlineText({ companyName: 'Acme', title: 'P', applyClosesAt: close }, 2, 'zh').title).toBe('Acme：网申2天后截止');
  });

  it('counts Beijing calendar days, not 24-hour blocks', () => {
    const close = new Date('2026-10-31T15:59:00.000Z'); // 31 Oct 23:59 Beijing
    expect(calendarDaysLeft(close, new Date('2026-10-31T01:00:00.000Z'))).toBe(0); // 31 Oct 09:00
    expect(calendarDaysLeft(close, new Date('2026-10-30T16:30:00.000Z'))).toBe(0); // 31 Oct 00:30
    expect(calendarDaysLeft(close, new Date('2026-10-30T15:30:00.000Z'))).toBe(1); // 30 Oct 23:30
    expect(calendarDaysLeft(close, new Date('2026-10-29T16:00:00.000Z'))).toBe(1); // 30 Oct 00:00
    expect(calendarDaysLeft(close, new Date('2026-10-28T10:00:00.000Z'))).toBe(3); // 28 Oct 18:00
  });
});
