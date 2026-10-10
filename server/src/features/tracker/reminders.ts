// server/src/features/tracker/reminders.ts — the tracker's reminder producer
// (hourly `reminders` cron; ARCH §8.3; PRODUCT F-NOTIF-08; WP-38).
//
// For one brand, finds applications where a fact just became true:
//   - applied 10+ days ago and still at Applied (no follow-up date set),
//   - the follow-up date the user set has come,
//   - an interview within the next 24 hours,
//   - a saved job's deadline within 2 days (GoApply 网申截止: 3 days and 1 day).
// Each fact is sent once: a `reminder` RATrackerEvent (toValue = the reminder
// key) is the ledger. A reminder writes an in-app SeekerNotification
// (category `reminder`, `templateKey` under `applications.reminders.*`) and,
// when WP-39a has registered the email template, enqueues `email.send`; WP-39a
// delivers it and applies the user's channel preferences.
//
// Facts only: "No reply from Acme for 12 days", never "Acme is likely to…".
// Idle runs cost one indexed query and return in well under 2 s. Busy runs
// walk the candidates in id order, page by page, so rows whose reminder was
// already sent never crowd out the ones still due.

import type { Prisma } from '../../generated/prisma/client.js';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { EMAIL_SEND_KIND, getEmailTemplate, type EmailSendPayload } from '../../platform/email/index.js';
import { enqueue, type CronContext, type CronResult } from '../../platform/queue/index.js';
import type { BrandId } from '../../platform/brand/index.js';
import { CN_DEADLINE_REMINDER_DAYS } from '../cn/tracker/index.js';
import {
  AWAITING_REPLY_STATUSES,
  NO_REPLY_DAYS,
  TERMINAL_STATUSES,
  TRACKER_REMINDER_EMAIL_TEMPLATE,
  TRACKER_REMINDER_TEMPLATE_KEYS,
  type FollowUpView,
} from './contract.js';
import { computeFollowUps, DAY_MS, DEADLINE_WINDOW_DAYS, type FactEntry } from './facts.js';
import type { TrackerMarket } from './stages.js';

/** A reminder is sent only while its fact is fresh (a late first send is noise). */
export const REMINDER_FRESH_DAYS = 7;
/** Entries per page of the candidate query (pages are keyset-ordered by id). */
export const REMINDER_BATCH = 500;
/**
 * Pages per run. Entries whose reminder was already sent stay in the query
 * window for up to a week, so one page is not enough: the run walks the pages
 * in id order until it has seen every candidate or the budget runs out.
 */
export const REMINDER_MAX_PAGES = 40;

export interface ReminderCandidate extends FactEntry {
  userId: string;
}

export interface ReminderFact extends FollowUpView {
  userId: string;
  /** Ledger key: one reminder per key per entry. */
  key: string;
}

type ReminderDb = Pick<ExtendedPrismaClient, '$transaction' | 'rATrackerEntry' | 'rATrackerEvent' | 'seekerProfile' | 'seekerNotification' | 'rAJob'>;

export interface ReminderDeps {
  getDb?: () => Promise<ReminderDb>;
  /**
   * Candidate loader (default: a Prisma query filtered by `User.brand`). Returns
   * up to `limit` candidates with `id > afterId`, in ascending id order.
   */
  loadCandidates?: (db: ReminderDb, brand: BrandId, market: TrackerMarket, now: Date, limit: number, afterId: string | null) => Promise<ReminderCandidate[]>;
  enqueueEmail?: (payload: EmailSendPayload, opts: { brand: BrandId; userId: string; dedupeKey: string }) => Promise<unknown>;
  emailTemplateRegistered?: (key: string) => boolean;
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The ledger key for a fact (GoApply deadlines get a 3-day and a 1-day key). */
export function reminderKey(f: FollowUpView, market: TrackerMarket): string {
  switch (f.reason) {
    case 'no_reply_10d':
      return `no_reply:${f.at}`;
    case 'follow_up_due':
      return `follow_up:${f.at}`;
    case 'interview_tomorrow':
      return `interview:${f.at}`;
    case 'deadline_soon': {
      if (market !== 'cn') return `deadline:${f.at}`;
      const bucket = [...CN_DEADLINE_REMINDER_DAYS].sort((a, b) => a - b).find((d) => (f.days ?? 0) <= d) ?? CN_DEADLINE_REMINDER_DAYS[0];
      return `deadline:${f.at}:${bucket}d`;
    }
  }
}

/** Facts worth a reminder now: `computeFollowUps` limited to fresh ones. */
export function reminderFacts(candidates: readonly ReminderCandidate[], now: Date, market: TrackerMarket): ReminderFact[] {
  const owner = new Map(candidates.map((c) => [c.id, c.userId]));
  const freshAfter = now.getTime() - REMINDER_FRESH_DAYS * DAY_MS;
  return computeFollowUps(candidates, now, market)
    .filter((f) => {
      if (f.reason === 'no_reply_10d') return (f.days ?? 0) < NO_REPLY_DAYS + REMINDER_FRESH_DAYS;
      if (f.reason === 'follow_up_due') return Date.parse(f.at) > freshAfter;
      return true;
    })
    .map((f) => ({ ...f, userId: owner.get(f.entryId)!, key: reminderKey(f, market) }));
}

/** Plain English fallback stored on the notification (the client renders `templateKey`). */
export function reminderFallbackTitle(f: FollowUpView): string {
  const name = f.companyName || f.title || 'This application';
  switch (f.reason) {
    case 'no_reply_10d':
      return `No reply from ${name} for ${f.days ?? NO_REPLY_DAYS} days.`;
    case 'follow_up_due':
      return `Your follow-up date for ${name} is today.`;
    case 'interview_tomorrow':
      return `Interview with ${name} within 24 hours.`;
    case 'deadline_soon':
      if (f.days === 0) return `Applications for ${name} close today.`;
      if (f.days === 1) return `Applications for ${name} close tomorrow.`;
      return `Applications for ${name} close in ${f.days} days.`;
  }
}

const defaultGetDb = async (): Promise<ReminderDb> => (await import('../../lib/prisma.js')).default;

async function defaultLoadCandidates(
  db: ReminderDb,
  brand: BrandId,
  market: TrackerMarket,
  now: Date,
  limit: number,
  afterId: string | null,
): Promise<ReminderCandidate[]> {
  const today = utcMidnight(now);
  const rows = await db.rATrackerEntry.findMany({
    where: {
      ...(afterId ? { id: { gt: afterId } } : {}),
      deletedAt: null,
      status: { notIn: [...TERMINAL_STATUSES] },
      user: { brand },
      OR: [
        {
          status: { in: [...AWAITING_REPLY_STATUSES] },
          followUpAt: null,
          dateApplied: { lte: new Date(now.getTime() - NO_REPLY_DAYS * DAY_MS), gt: new Date(now.getTime() - (NO_REPLY_DAYS + REMINDER_FRESH_DAYS) * DAY_MS) },
        },
        { followUpAt: { lte: now, gt: new Date(now.getTime() - REMINDER_FRESH_DAYS * DAY_MS) } },
        { interviewAt: { gt: now, lte: new Date(now.getTime() + DAY_MS) } },
        { status: 'bookmarked', deadline: { gte: today, lte: new Date(today.getTime() + DEADLINE_WINDOW_DAYS[market] * DAY_MS) } },
      ],
    },
    select: {
      id: true,
      userId: true,
      status: true,
      dateApplied: true,
      followUpAt: true,
      interviewAt: true,
      deadline: true,
      jobId: true,
      externalSnapshot: true,
    },
    orderBy: { id: 'asc' },
    take: limit,
  });
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => Boolean(x)))];
  const jobs = jobIds.length ? await db.rAJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, companyName: true } }) : [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return rows.map((r) => {
    const job = r.jobId ? byId.get(r.jobId) : undefined;
    const snap = (r.externalSnapshot && typeof r.externalSnapshot === 'object' ? r.externalSnapshot : {}) as { title?: unknown; companyName?: unknown };
    return {
      id: r.id,
      userId: r.userId,
      status: r.status,
      dateApplied: r.dateApplied,
      followUpAt: r.followUpAt,
      interviewAt: r.interviewAt,
      deadline: r.deadline,
      companyName: job?.companyName ?? (typeof snap.companyName === 'string' ? snap.companyName : null),
      title: job?.title ?? (typeof snap.title === 'string' ? snap.title : null),
    };
  });
}

/** The cron task body (`features/tracker/cron.ts` exports it as `produceReminders`). */
export async function produceTrackerReminders(ctx: CronContext, deps: ReminderDeps = {}): Promise<CronResult> {
  const db = await (deps.getDb ?? defaultGetDb)();
  const market = ctx.brand.market as TrackerMarket;
  const brand = ctx.brand.id as BrandId;
  const load = deps.loadCandidates ?? defaultLoadCandidates;
  const emailReady = (deps.emailTemplateRegistered ?? ((k: string) => Boolean(getEmailTemplate(k))))(TRACKER_REMINDER_EMAIL_TEMPLATE);
  const sendEmail = deps.enqueueEmail ?? ((payload, opts) => enqueue(EMAIL_SEND_KIND, payload, opts));

  let cursor: string | null = null;
  let scanned = 0;
  let alreadySent = 0;
  let processed = 0;
  let emails = 0;
  let inAppSkipped = 0;
  let pages = 0;
  let outOfTime = false;

  while (pages < REMINDER_MAX_PAGES && !outOfTime) {
    if (pages > 0 && ctx.budget.exhausted(5_000)) break;
    const candidates = await load(db, brand, market, ctx.now, REMINDER_BATCH, cursor);
    pages += 1;
    if (pages === 1 && candidates.length === 0) return { skipped: 'no_work', processed: 0 };
    scanned += candidates.length;

    const facts = reminderFacts(candidates, ctx.now, market);
    if (facts.length > 0) {
      // The ledger: facts already reminded are skipped (they do not use up the run).
      const sent = await db.rATrackerEvent.findMany({
        where: { entryId: { in: [...new Set(facts.map((f) => f.entryId))] }, kind: 'reminder', toValue: { in: facts.map((f) => f.key) } },
        select: { entryId: true, toValue: true },
      });
      const done = new Set(sent.map((s) => `${s.entryId}|${s.toValue}`));
      const due = facts.filter((f) => !done.has(`${f.entryId}|${f.key}`));
      alreadySent += facts.length - due.length;

      if (due.length > 0) {
        const profiles = await db.seekerProfile.findMany({ where: { userId: { in: [...new Set(due.map((f) => f.userId))] } }, select: { id: true, userId: true } });
        const profileOf = new Map(profiles.map((p) => [p.userId, p.id]));
        for (const f of due) {
          if (ctx.budget.exhausted(2_000)) {
            outOfTime = true;
            break;
          }
          const href = `/applications?entry=${encodeURIComponent(f.entryId)}`;
          const params = { reason: f.reason, name: f.companyName || f.title || '', company: f.companyName, title: f.title, days: f.days, at: f.at, href };
          const profileId = profileOf.get(f.userId);
          await db.$transaction(async (tx) => {
            if (profileId) {
              await tx.seekerNotification.create({
                data: {
                  seekerProfileId: profileId,
                  userId: f.userId,
                  brand,
                  type: 'tracker_reminder',
                  category: 'reminder',
                  templateKey: TRACKER_REMINDER_TEMPLATE_KEYS[f.reason],
                  params: params as Prisma.InputJsonValue,
                  title: reminderFallbackTitle(f),
                  deepLink: href,
                  relatedEntityType: 'tracker_entry',
                  relatedEntityId: f.entryId,
                },
              });
            }
            await tx.rATrackerEvent.create({
              data: { entryId: f.entryId, userId: f.userId, kind: 'reminder', toValue: f.key, payload: { reason: f.reason, inApp: Boolean(profileId) } },
            });
          });
          if (!profileId) inAppSkipped += 1;
          if (emailReady) {
            await sendEmail(
              { template: TRACKER_REMINDER_EMAIL_TEMPLATE, userId: f.userId, params },
              { brand, userId: f.userId, dedupeKey: `tracker.reminder:${f.entryId}:${f.key}` },
            );
            emails += 1;
          }
          processed += 1;
        }
      }
    }

    if (candidates.length < REMINDER_BATCH) break;
    const next = candidates[candidates.length - 1]!.id;
    if (cursor !== null && next <= cursor) break; // a loader that ignores the cursor must not loop
    cursor = next;
  }
  return { processed, emails, inAppSkipped, alreadySent, candidates: scanned, pages };
}
