// @vitest-environment node
// WP-58 reminders: 网申截止 3 days and 1 day before, once each per
// user/programme (overlapping runs too), facts only; follow-a-company notices
// once per user and programme; GoApply only; idle runs are cheap.

import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../../../platform/brand/index.js';
import type { CronContext } from '../../../../platform/queue/index.js';
import { calendarDaysLeft, deadlineText, formatClose, notifyFollowers, produceCampusReminders, reminderDue, reminderWindow, type CampusNotifyDeps } from '../notify.js';
import { DAY, NOW, eventRow, fakeCampusRepo, fakeNotifyRepo } from './testkit.js';

function ctx(now: Date, brand: 'goapply' | 'roboapply' = 'goapply'): CronContext {
  return { name: 'reminders', brand: getBrand(brand), now, budget: { exhausted: () => false, remainingMs: () => 200_000 } } as unknown as CronContext;
}

function setup(closesInMs: number, opts: { lock?: boolean } = {}) {
  const campus = fakeCampusRepo([eventRow({ id: 'ev', applyClosesAt: new Date(NOW.getTime() + closesInMs) })]);
  const repo = fakeNotifyRepo(campus, opts);
  repo.profileOf.set('u1', { locale: 'zh', timezone: null });
  const created: Array<{ userId: string; title: string; href?: string | null; params?: Record<string, unknown> | null; templateKey?: string | null; relatedEntityId?: string | null }> = [];
  const emails: Array<{ dedupeKey: string; params: Record<string, unknown> }> = [];
  const deps: CampusNotifyDeps = {
    repo,
    createNotification: async (input) => {
      await new Promise((r) => setTimeout(r, 0)); // a real write yields; lets overlapping callers interleave
      created.push(input);
      repo.inbox.push({ userId: input.userId, templateKey: input.templateKey ?? '', eventId: input.relatedEntityId ?? '' });
      return { id: `n${created.length}` };
    },
    enqueueEmail: async (payload, opts) => {
      emails.push({ dedupeKey: opts.dedupeKey, params: payload.params });
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
