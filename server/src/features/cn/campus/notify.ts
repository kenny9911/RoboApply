// server/src/features/cn/campus/notify.ts — the campus calendar's two
// producers (WP-58; PRODUCT F-NOTIF-08 cn), run by the hourly `reminders`
// cron for GoApply (registered as `campus`, markets ['cn']):
//
//   1. 网申截止 reminders: for each deadline subscription (kind 'event') of a
//      published programme closing within 3 days, one reminder 3 days before
//      and one 1 day before the stated close. The subscription row is the
//      ledger: `lastNotifiedAt` is claimed atomically (updateMany where it is
//      still before the window start), so each user/programme/window is sent
//      once even when two runs overlap. A reminder writes an inbox row
//      (category 'reminder'); the `notify.campus_deadline` email is enqueued
//      only when the subscription's channel is 'email', or when the user has
//      no seeker profile and so no inbox (WP-39a still applies the user's
//      channel/quiet-hour checks). 'in_app' and 'wechat' get the inbox row.
//      The relative phrase ("明天截止", "3天后截止") is the real number of
//      Beijing calendar days left, not the window label.
//   2. Follow a company: when a programme of a followed company and the
//      followed 届别 is published, each follower gets one inbox notice
//      (deduplicated per user and programme by the inbox row itself, read and
//      written under a per-programme Postgres advisory lock so a publish and
//      the hourly run cannot both send it). Run right after publish (service
//      onPublished) and again hourly for programmes verified in the last 7
//      days, so a failed run catches up.
//
// Inbox links open the company's page (/campus/{slug}), where the programme is
// listed with its official link.
//
// Facts only: the company, the programme and the close date the official page
// states ("网申将于 10月31日 23:59（北京时间）截止"), never "you are likely to…".
// Idle runs cost one indexed query.

import type prismaClient from '../../../lib/prisma.js';
import type { BrandId } from '../../../platform/brand/index.js';
import { EMAIL_SEND_KIND, getEmailTemplate, type EmailSendPayload } from '../../../platform/email/index.js';
import { NOTIFY_TEMPLATES } from '../../../platform/email/templates/notify/index.js';
import { enqueue, type CronContext, type CronResult } from '../../../platform/queue/index.js';
import { logger } from '../../../services/LoggerService.js';
import type { CreateNotificationInput } from '../../notifications/index.js';
import { CAMPUS_FOLLOW_WINDOW_DAYS, CAMPUS_REMINDER_DAYS, CAMPUS_TIME_ZONE, campusCompanySlug, normalizeCampusCompany } from './contract.js';
import { CAMPUS_EVENT_SELECT, DAY_MS, type CampusEventRow } from './views.js';

type Db = typeof prismaClient;

/** Inbox template keys (client-rendered under `inbox.templates.*` once INT adds them; the stored title/body are the fallback). */
export const CAMPUS_INBOX_TEMPLATES = {
  deadline: 'campus.deadline',
  followed: 'campus.followed',
} as const;

export const REMINDER_BATCH = 300;
export const REMINDER_MAX_PAGES = 20;

export interface DueReminder {
  subscriptionId: string;
  userId: string;
  lastNotifiedAt: Date | null;
  /** The channel the user picked ('in_app' | 'email' | 'wechat'). */
  channel: string;
  event: CampusEventRow;
}

export interface CampusNotifyRepository {
  /** Event subscriptions of the brand's users whose published programme closes in (now, now + 3 days], by subscription id. */
  dueReminders(brand: BrandId, market: string, now: Date, afterId: string | null, take: number): Promise<DueReminder[]>;
  /** Atomically mark the subscription as reminded for the window starting at `windowStart`; false when another run did. */
  claimReminder(subscriptionId: string, windowStart: Date, now: Date): Promise<boolean>;
  /** Published programmes of the market verified since `since` and not yet closed. */
  recentlyPublished(market: string, since: Date, now: Date, take: number): Promise<CampusEventRow[]>;
  /** Users of the brand following this company (normalized) for this 届别. */
  followers(brand: BrandId, companyNameNormalized: string, graduationClass: string): Promise<string[]>;
  /** Users among `userIds` who already have a follow notice for this programme. */
  alreadyNotified(userIds: string[], eventId: string): Promise<Set<string>>;
  /** Run `fn` while holding the programme's follow-notice lock (one sender at a time per programme). */
  withFollowLock<T>(eventId: string, fn: () => Promise<T>): Promise<T>;
  /** Seeker locale and time zone per user (absent = no seeker profile). */
  profiles(userIds: string[]): Promise<Map<string, { locale: string | null; timezone: string | null }>>;
}

export interface CampusNotifyDeps {
  repo?: CampusNotifyRepository;
  createNotification?: (input: CreateNotificationInput) => Promise<{ id: string }>;
  enqueueEmail?: (payload: EmailSendPayload, opts: { brand: BrandId; userId: string; dedupeKey: string }) => Promise<unknown>;
  emailTemplateRegistered?: (key: string) => boolean;
}

/** The reminder window a subscription is in now (3 or 1 days before close), or null. */
export function reminderWindow(closesAt: Date, now: Date): { days: number; start: Date } | null {
  const left = closesAt.getTime() - now.getTime();
  if (left <= 0) return null;
  const days = [...CAMPUS_REMINDER_DAYS].sort((a, b) => a - b).find((d) => left <= d * DAY_MS);
  if (days === undefined) return null;
  return { days, start: new Date(closesAt.getTime() - days * DAY_MS) };
}

// Asia/Shanghai has had no daylight saving since 1991: a fixed UTC+8.
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const beijingDay = (d: Date) => Math.floor((d.getTime() + BEIJING_OFFSET_MS) / DAY_MS);

/** Beijing calendar days from `now` to the close: 0 = closes today, 1 = tomorrow, n = in n days. */
export function calendarDaysLeft(closesAt: Date, now: Date): number {
  return Math.max(0, beijingDay(closesAt) - beijingDay(now));
}

/** Is a reminder for this window still to be sent? */
export function reminderDue(lastNotifiedAt: Date | null, windowStart: Date): boolean {
  return !lastNotifiedAt || lastNotifiedAt.getTime() < windowStart.getTime();
}

const isEnglish = (locale: string | null | undefined) => !!locale && locale.toLowerCase().startsWith('en');

/** "10月31日 23:59（北京时间）" / "31 Oct, 23:59 (Beijing time)". */
export function formatClose(closesAt: Date, locale: string | null | undefined): string {
  const en = isEnglish(locale);
  const fmt = new Intl.DateTimeFormat(en ? 'en-GB' : 'zh-CN', {
    timeZone: CAMPUS_TIME_ZONE,
    month: en ? 'short' : 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return en ? `${fmt.format(closesAt)} (Beijing time)` : `${fmt.format(closesAt)}（北京时间）`;
}

/** `days` is the real number of Beijing calendar days left (see `calendarDaysLeft`). */
export function deadlineText(event: Pick<CampusEventRow, 'companyName' | 'title' | 'applyClosesAt'>, days: number, locale: string | null | undefined): { title: string; body: string } {
  const when = formatClose(event.applyClosesAt!, locale);
  if (isEnglish(locale)) {
    const rel = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    return {
      title: `${event.companyName}: applications close ${rel}`,
      body: `${event.title} closes ${when}, as stated on the official page.`,
    };
  }
  const rel = days <= 0 ? '今天' : days === 1 ? '明天' : `${days}天后`;
  return {
    title: `${event.companyName}：网申${rel}截止`,
    body: `${event.title} 网申将于 ${when} 截止（以官网为准）。`,
  };
}

export function followedText(event: Pick<CampusEventRow, 'companyName' | 'title' | 'graduationClass'>, locale: string | null | undefined): { title: string; body: string } {
  if (isEnglish(locale)) {
    return { title: `${event.companyName} posted a ${event.graduationClass} programme`, body: `${event.title} is now on the campus calendar, with its official link.` };
  }
  return { title: `你关注的${event.companyName}发布了${event.graduationClass}项目`, body: `${event.title} 已加入校招日历，附官网链接。` };
}

/** The message center's create(), loaded on first use (keeps the router import light). */
const defaultCreate = async (input: CreateNotificationInput): Promise<{ id: string }> =>
  (await import('../../notifications/index.js')).notificationCenterService.create(input);

/** The company's page, which lists the programme with its official link. */
const href = (companyName: string) => `/campus/${encodeURIComponent(campusCompanySlug(companyName))}`;

async function tryCreate(create: NonNullable<CampusNotifyDeps['createNotification']>, input: CreateNotificationInput): Promise<boolean> {
  try {
    await create(input);
    return true;
  } catch (err) {
    // No seeker profile (404) or a write failure: the email (when allowed) still goes.
    logger.warn('CAMPUS', 'inbox row not written', { userId: input.userId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Follow-a-company notices for one published programme. Returns how many users were notified. */
export async function notifyFollowers(event: CampusEventRow, brand: BrandId, deps: CampusNotifyDeps = {}): Promise<number> {
  if (event.status !== 'published' || !event.verifiedAt) return 0;
  const repo = deps.repo ?? defaultCampusNotifyRepository();
  const create = deps.createNotification ?? defaultCreate;
  const userIds = await repo.followers(brand, normalizeCampusCompany(event.companyName), event.graduationClass);
  if (!userIds.length) return 0;
  // Read-then-write under the programme's lock: a publish and an overlapping
  // hourly run wait for each other, and the second sees the first one's rows.
  return repo.withFollowLock(event.id, async () => {
    const done = await repo.alreadyNotified(userIds, event.id);
    const todo = userIds.filter((u) => !done.has(u));
    if (!todo.length) return 0;
    const profiles = await repo.profiles(todo);
    let sent = 0;
    for (const userId of todo) {
      const profile = profiles.get(userId);
      if (!profile) continue; // no seeker profile → no inbox to write to (and no ledger): skipped
      const text = followedText(event, profile.locale);
      const ok = await tryCreate(create, {
        userId,
        brand,
        category: 'reminder',
        templateKey: CAMPUS_INBOX_TEMPLATES.followed,
        params: { eventId: event.id, company: event.companyName, program: event.title, graduationClass: event.graduationClass },
        title: text.title,
        body: text.body,
        href: href(event.companyName),
        relatedEntityType: 'campus_event',
        relatedEntityId: event.id,
      });
      if (ok) sent += 1;
    }
    return sent;
  });
}

/** The `campus` reminders producer (hourly, GoApply). */
export async function produceCampusReminders(ctx: CronContext, deps: CampusNotifyDeps = {}): Promise<CronResult> {
  if (ctx.brand.market !== 'cn') return { skipped: 'not_for_market', processed: 0 };
  const repo = deps.repo ?? defaultCampusNotifyRepository();
  const brand = ctx.brand.id as BrandId;
  const market = ctx.brand.market;
  const create = deps.createNotification ?? defaultCreate;
  const emailReady = (deps.emailTemplateRegistered ?? ((k: string) => Boolean(getEmailTemplate(k))))(NOTIFY_TEMPLATES.campusDeadline);
  const sendEmail = deps.enqueueEmail ?? ((payload, opts) => enqueue(EMAIL_SEND_KIND, payload, opts));

  let reminders = 0;
  let inApp = 0;
  let emails = 0;
  let alreadySent = 0;
  let scanned = 0;
  let cursor: string | null = null;
  for (let page = 0; page < REMINDER_MAX_PAGES; page += 1) {
    if (page > 0 && ctx.budget.exhausted(5_000)) break;
    const due = await repo.dueReminders(brand, market, ctx.now, cursor, REMINDER_BATCH);
    scanned += due.length;
    const profiles = due.length ? await repo.profiles([...new Set(due.map((d) => d.userId))]) : new Map();
    for (const d of due) {
      const closes = d.event.applyClosesAt;
      const window = closes ? reminderWindow(closes, ctx.now) : null;
      if (!closes || !window) continue;
      if (!reminderDue(d.lastNotifiedAt, window.start)) {
        alreadySent += 1;
        continue;
      }
      if (ctx.budget.exhausted(2_000)) break;
      if (!(await repo.claimReminder(d.subscriptionId, window.start, ctx.now))) {
        alreadySent += 1;
        continue;
      }
      const profile = profiles.get(d.userId) as { locale: string | null; timezone: string | null } | undefined;
      const daysLeft = calendarDaysLeft(closes, ctx.now);
      const text = deadlineText(d.event, daysLeft, profile?.locale);
      const params = {
        eventId: d.event.id,
        company: d.event.companyName,
        companySlug: campusCompanySlug(d.event.companyName),
        program: d.event.title,
        closesAt: closes.toISOString(),
        officialUrl: d.event.officialUrl,
        timeZone: CAMPUS_TIME_ZONE,
        days: daysLeft,
      };
      if (profile) {
        const ok = await tryCreate(create, {
          userId: d.userId,
          brand,
          category: 'reminder',
          templateKey: CAMPUS_INBOX_TEMPLATES.deadline,
          params,
          title: text.title,
          body: text.body,
          href: href(d.event.companyName),
          relatedEntityType: 'campus_event',
          relatedEntityId: d.event.id,
        });
        if (ok) inApp += 1;
      }
      // Email only when the user chose it, or when there is no inbox to write to.
      if (emailReady && (d.channel === 'email' || !profile)) {
        await sendEmail(
          { template: NOTIFY_TEMPLATES.campusDeadline, userId: d.userId, params },
          { brand, userId: d.userId, dedupeKey: `campus.deadline:${d.subscriptionId}:${window.days}d:${closes.toISOString()}` },
        );
        emails += 1;
      }
      reminders += 1;
    }
    if (due.length < REMINDER_BATCH) break;
    const next = due[due.length - 1]!.subscriptionId;
    if (cursor !== null && next <= cursor) break;
    cursor = next;
  }

  // Follow-a-company catch-up (publish already tried once).
  let followNotices = 0;
  if (!ctx.budget.exhausted(5_000)) {
    const since = new Date(ctx.now.getTime() - CAMPUS_FOLLOW_WINDOW_DAYS * DAY_MS);
    const recent = await repo.recentlyPublished(market, since, ctx.now, 200);
    for (const ev of recent) {
      if (ctx.budget.exhausted(2_000)) break;
      followNotices += await notifyFollowers(ev, brand, { repo, createNotification: create });
    }
  }

  const processed = reminders + followNotices;
  if (!processed && !scanned && !alreadySent) return { skipped: 'no_work', processed: 0, followNotices: 0 };
  return { processed, reminders, inApp, emails, alreadySent, followNotices, candidates: scanned };
}

// ── Prisma repository ──

export function createCampusNotifyRepository(getDb: () => Promise<Db>): CampusNotifyRepository {
  return {
    async dueReminders(brand, market, now, afterId, take) {
      const db = await getDb();
      const horizon = new Date(now.getTime() + Math.max(...CAMPUS_REMINDER_DAYS) * DAY_MS);
      const rows = await db.rACampusSubscription.findMany({
        where: {
          ...(afterId ? { id: { gt: afterId } } : {}),
          kind: 'event',
          user: { brand },
          event: { market, status: 'published', verifiedAt: { not: null }, applyClosesAt: { gt: now, lte: horizon } },
        },
        orderBy: { id: 'asc' },
        take,
        select: { id: true, userId: true, lastNotifiedAt: true, channel: true, event: { select: CAMPUS_EVENT_SELECT } },
      });
      return rows
        .filter((r) => r.event)
        .map((r) => ({ subscriptionId: r.id, userId: r.userId, lastNotifiedAt: r.lastNotifiedAt, channel: r.channel, event: r.event! }));
    },
    async claimReminder(subscriptionId, windowStart, now) {
      const db = await getDb();
      const r = await db.rACampusSubscription.updateMany({
        where: { id: subscriptionId, OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: windowStart } }] },
        data: { lastNotifiedAt: now },
      });
      return r.count === 1;
    },
    async recentlyPublished(market, since, now, take) {
      const db = await getDb();
      return db.rACampusEvent.findMany({
        where: { market, status: 'published', verifiedAt: { gte: since }, OR: [{ applyClosesAt: null }, { applyClosesAt: { gte: now } }] },
        orderBy: { verifiedAt: 'desc' },
        take,
        select: CAMPUS_EVENT_SELECT,
      });
    },
    async followers(brand, companyNameNormalized, graduationClass) {
      const db = await getDb();
      const rows = await db.rACampusSubscription.findMany({
        where: { kind: 'company', companyNameNormalized, graduationClass, user: { brand } },
        select: { userId: true },
        take: 5000,
      });
      return [...new Set(rows.map((r) => r.userId))];
    },
    async alreadyNotified(userIds, eventId) {
      if (!userIds.length) return new Set();
      const db = await getDb();
      const rows = await db.seekerNotification.findMany({
        where: { userId: { in: userIds }, relatedEntityType: 'campus_event', relatedEntityId: eventId, templateKey: CAMPUS_INBOX_TEMPLATES.followed },
        select: { userId: true },
      });
      return new Set(rows.map((r) => r.userId).filter((x): x is string => !!x));
    },
    async withFollowLock(eventId, fn) {
      const db = await getDb();
      // The lock is held until this transaction ends; the inbox rows commit on
      // their own connections inside `fn`, before the unlock, so the next
      // holder's alreadyNotified() sees them.
      return db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campus.followed:${eventId}`}))`;
          return fn();
        },
        { maxWait: 15_000, timeout: 60_000 },
      );
    },
    async profiles(userIds) {
      const out = new Map<string, { locale: string | null; timezone: string | null }>();
      if (!userIds.length) return out;
      const db = await getDb();
      const rows = await db.seekerProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true, locale: true, timezone: true } });
      for (const r of rows) out.set(r.userId, { locale: r.locale, timezone: r.timezone });
      return out;
    },
  };
}

const defaultGetDb = async (): Promise<Db> => (await import('../../../lib/prisma.js')).default;

export const defaultCampusNotifyRepository = (): CampusNotifyRepository => createCampusNotifyRepository(defaultGetDb);
