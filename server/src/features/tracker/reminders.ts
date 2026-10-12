// server/src/features/tracker/reminders.ts — the tracker's reminder producer
// (hourly `reminders` cron; ARCH §8.3; PRODUCT F-NOTIF-08; WP-38, WP-93 #9).
//
// For one brand, finds applications where a fact just became true:
//   - applied 10+ days ago and still at Applied (no follow-up date set),
//   - the follow-up date the user set has come,
//   - an interview within the next 24 hours,
//   - a saved job's deadline within 2 days (GoApply 网申截止: 3 days and 1 day).
// Each fact is sent once: a `reminder` RATrackerEvent (toValue = the reminder
// key) is the ledger.
//
// Delivery goes through `notifyUser` (features/alerts), never a direct
// SeekerNotification write or `email.send` here. notifyUser applies the shared
// rules (the person exists and belongs to the brand, quiet hours, the
// message-center channel choices and unsubscribes, the email preference gate)
// and fans out in-app → email → registered channels:
//   - applied 10+ days ago with no reply (both names known)
//       → NOTIFY_TEMPLATES.followUpReminder ("No reply from … for N days", N ≥ 10)
//   - interview within 24 hours
//       → NOTIFY_TEMPLATES.interviewReminder
//   - `delivered` → the inbox row is labelled with the key the message center
//     renders (`inbox.templates.tracker.followUp` / `tracker.interview`), so it
//     reads in the person's language;
//   - `deferred` (quiet hours) → nothing is kept; the fact is tried again on a
//     later run while it is still fresh;
//   - `skipped` (no such person, another brand, reminders turned off) → the
//     ledger row stays so the fact is dropped, not retried every hour.
// Facts with no reminder email (a saved job's deadline; the follow-up date the
// user set; any fact missing a company or a title) get an inbox message only,
// through the message center's `create()`. The same rules are checked here
// first: the person exists and belongs to the brand, and their "reminder"
// in-app channel is on (alerts `channelAllowed`); otherwise the fact is dropped
// like a `skipped` notify. The stored sentence comes from the server i18n
// loader (`tracker.inbox.*`; GoApply: `tracker.inboxCn.*`), never from here.
//
// Sent at most once: the ledger row is written BEFORE the message goes out
// (`pending`), then updated with the result, or removed when the send was
// deferred. A failure after the message left can therefore never send it again
// on the next run. When notifyUser itself throws, part of the message may
// already be out (the inbox row is written before the email), so the row is
// kept and the run stops: that one fact is not retried, and it cannot block
// the facts after it on every later run. An inbox-only message whose single
// write failed left nothing behind: it is released and tried again next run.
//
// Facts only: "No reply from Acme for 12 days", never "Acme is likely to…".
// GoApply with CN_RECRUITMENT_INFO_MODE=off: an application whose job is a
// third-party posting gets no reminder (its name must not reach the inbox).
// Idle runs cost one indexed query and return in well under 2 s. Busy runs
// walk the candidates in id order, page by page, so rows whose reminder was
// already sent never crowd out the ones still due.

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { CronContext, CronResult } from '../../platform/queue/index.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/index.js';
import { createEmailTranslator, type EmailTranslator } from '../../platform/email/i18n.js';
import { logger } from '../../services/LoggerService.js';
import type { NotifyUserInput, NotifyUserResult, StoredNotificationPrefs } from '../alerts/index.js';
import { CN_DEADLINE_REMINDER_DAYS } from '../cn/tracker/index.js';
import {
  AWAITING_REPLY_STATUSES,
  NO_REPLY_DAYS,
  TERMINAL_STATUSES,
  TRACKER_INBOX_TEMPLATES,
  TRACKER_NOTIFY_TEMPLATES,
  type FollowUpView,
} from './contract.js';
import { isSimplifiedChinese } from './csv.js';
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
  /** The entry's job, when it has one (the interview reminder links "Practice for this job"). */
  jobId?: string | null;
}

export interface ReminderFact extends FollowUpView {
  userId: string;
  /** Ledger key: one reminder per key per entry. */
  key: string;
}

type ReminderDb = Pick<ExtendedPrismaClient, 'rATrackerEntry' | 'rATrackerEvent' | 'rAJob' | 'seekerNotification'>;

/** What the inbox-only path needs to know about the person (the same facts notifyUser reads). */
export interface ReminderPerson {
  brand: BrandId;
  /** The person's saved language, or null when they never chose one. */
  locale: string | null;
  /** Their stored notification choices (message center: channels per category). */
  prefs: StoredNotificationPrefs;
}

/** An inbox-only message (a fact with no reminder email). */
export interface ReminderInboxInput {
  userId: string;
  brand: BrandId;
  templateKey: string;
  params: Record<string, unknown>;
  title: string;
  href: string;
  entryId: string;
}

export interface ReminderDeps {
  getDb?: () => Promise<ReminderDb>;
  /**
   * Candidate loader (default: a Prisma query filtered by `User.brand`). Returns
   * up to `limit` candidates with `id > afterId`, in ascending id order.
   */
  loadCandidates?: (db: ReminderDb, brand: BrandId, market: TrackerMarket, now: Date, limit: number, afterId: string | null) => Promise<ReminderCandidate[]>;
  /** features/alerts `notifyUser` (quiet hours, preferences, in-app + email + channels). */
  notify?: (input: NotifyUserInput) => Promise<NotifyUserResult>;
  /**
   * The person an inbox-only reminder is for (default: the alerts area's
   * recipient and stored-preference readers). Null: no live account.
   */
  loadPerson?: (userId: string) => Promise<ReminderPerson | null>;
  /** Message-center row for a fact with no reminder email (default: `notificationCenterService.create`). */
  createInbox?: (input: ReminderInboxInput) => Promise<{ id: string } | null>;
  /**
   * Label the inbox row notifyUser wrote with the key the message center
   * renders (default: one `updateMany` on that row). Soft.
   */
  labelInbox?: (db: ReminderDb, notificationId: string, userId: string, templateKey: string) => Promise<void>;
  /** Env the GoApply recruitment-info mode is read from (tests). */
  env?: EnvSource;
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

/** The sentence an inbox-only reminder stores (a key under `tracker.inbox` / `tracker.inboxCn`). */
export type ReminderSentence = 'noReply' | 'followUpDue' | 'interview' | 'deadline';

const SENTENCE_FOR: Record<FollowUpView['reason'], ReminderSentence> = {
  no_reply_10d: 'noReply',
  follow_up_due: 'followUpDue',
  interview_tomorrow: 'interview',
  deadline_soon: 'deadline',
};

/** The two key groups in the `tracker` email-i18n namespace (see csv.ts for the same split). */
export const INBOX_GROUP = { shared: 'tracker.inbox', goapply: 'tracker.inboxCn' } as const;

/**
 * The sentence stored on an inbox-only reminder, in the person's language,
 * from the server i18n loader (English source:
 * server/src/i18n/email/staging/tracker.en.json). The message center shows it
 * whenever the `inbox` namespace has no key for the row's `templateKey`.
 * GoApply (mainland, Simplified Chinese) reads `tracker.inboxCn`; every other
 * brand and locale reads `tracker.inbox` (English until it is translated).
 * States only what the tracker knows: a name the user saved, a date, a count of days.
 */
export function reminderInboxTitle(f: FollowUpView, brand: ProductBrand, locale: string | null | undefined, t: EmailTranslator = createEmailTranslator(brand, locale)): string {
  const group = brand.market === 'cn' && isSimplifiedChinese(t.locale) ? INBOX_GROUP.goapply : INBOX_GROUP.shared;
  const name = f.companyName?.trim() || f.title?.trim() || t(`${group}.unnamed`);
  const days = f.reason === 'no_reply_10d' ? (f.days ?? NO_REPLY_DAYS) : (f.days ?? 0);
  return t(`${group}.${SENTENCE_FOR[f.reason]}`, { name, days });
}

/** How one fact reaches the person. */
export type ReminderDelivery =
  | { via: 'notify'; templateKey: string; inboxKey: string; params: Record<string, unknown>; href: string }
  | { via: 'inbox'; inboxKey: string; params: Record<string, unknown>; href: string };

/**
 * Pick the channel for a fact. A reminder email is used only when every value
 * its text states is a real one for this entry (title, company, the applied
 * date and at least 10 days with no reply, or the interview time); otherwise
 * the fact goes to the inbox with its own plain sentence. Pure.
 *
 * The follow-up date the user set is always an inbox sentence ("Your follow-up
 * date for Acme is today"): the tracker knows the date came, not that there
 * was no reply, and there is no email that says only that.
 */
export function reminderDelivery(f: ReminderFact, c: ReminderCandidate | undefined): ReminderDelivery {
  const href = `/applications?entry=${encodeURIComponent(f.entryId)}`;
  const company = f.companyName?.trim() || '';
  const title = f.title?.trim() || '';
  const name = company || title;
  const named = Boolean(company && title);
  const inbox = (inboxKey: string, params: Record<string, unknown>): ReminderDelivery => ({
    via: 'inbox',
    inboxKey,
    params: { reason: f.reason, name, company: company || name, title: title || null, at: f.at, ...params },
    href,
  });
  switch (f.reason) {
    case 'no_reply_10d':
      // Without both names there is no sentence for the email; the inbox key still holds ({company}, {days}).
      if (!named) return inbox(TRACKER_INBOX_TEMPLATES.followUp, { days: f.days ?? NO_REPLY_DAYS });
      return {
        via: 'notify',
        templateKey: TRACKER_NOTIFY_TEMPLATES.followUp,
        inboxKey: TRACKER_INBOX_TEMPLATES.followUp,
        params: { entryId: f.entryId, title, company, appliedAt: f.at, days: f.days ?? NO_REPLY_DAYS },
        href,
      };
    case 'follow_up_due':
      return inbox(TRACKER_INBOX_TEMPLATES.followUpDue, {});
    case 'interview_tomorrow':
      if (!named) return inbox(TRACKER_INBOX_TEMPLATES.interview, {});
      return {
        via: 'notify',
        templateKey: TRACKER_NOTIFY_TEMPLATES.interview,
        inboxKey: TRACKER_INBOX_TEMPLATES.interview,
        params: { entryId: f.entryId, jobId: c?.jobId ?? null, title, company, interviewAt: f.at },
        href,
      };
    case 'deadline_soon':
      return inbox(TRACKER_INBOX_TEMPLATES.deadline, { days: f.days ?? 0 });
  }
}

const defaultGetDb = async (): Promise<ReminderDb> => (await import('../../lib/prisma.js')).default;

const defaultNotify = async (input: NotifyUserInput): Promise<NotifyUserResult> => (await import('../alerts/index.js')).notifyUser(input);

const defaultLoadPerson = async (userId: string): Promise<ReminderPerson | null> => {
  const { createPrismaAlertsRepo, createPrismaPreferencesRepo } = await import('../alerts/index.js');
  const [recipients, facts] = await Promise.all([createPrismaAlertsRepo().recipients([userId]), createPrismaPreferencesRepo().load(userId)]);
  const recipient = recipients.get(userId);
  if (!recipient || !facts) return null;
  return { brand: recipient.brand, locale: recipient.locale, prefs: facts.prefs };
};

const defaultCreateInbox = async (input: ReminderInboxInput): Promise<{ id: string } | null> => {
  const { notificationCenterService } = await import('../notifications/index.js');
  return notificationCenterService.create({
    userId: input.userId,
    brand: input.brand,
    category: 'reminder',
    templateKey: input.templateKey,
    params: input.params,
    title: input.title,
    href: input.href,
    relatedEntityType: 'tracker_entry',
    relatedEntityId: input.entryId,
  });
};

const defaultLabelInbox = async (db: ReminderDb, notificationId: string, userId: string, templateKey: string): Promise<void> => {
  await db.seekerNotification.updateMany({ where: { id: notificationId, userId }, data: { templateKey } });
};

async function defaultLoadCandidates(
  db: ReminderDb,
  brand: BrandId,
  market: TrackerMarket,
  now: Date,
  limit: number,
  afterId: string | null,
  env: EnvSource = process.env,
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
  const jobs = jobIds.length
    ? await db.rAJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, companyName: true, market: true, visibility: true, ownerUserId: true } })
    : [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  // GoApply, mode off: an application whose job is a third-party posting gets no reminder
  // (the user's own imports and jobs they typed in keep theirs). R-14, R41-1b.
  const hidden = new Set<string>();
  if (market === 'cn' && jobs.some((j) => j.market === 'cn')) {
    const { cnPostingVisible } = await import('../cn/jobs/index.js');
    const ownerOf = new Map(rows.filter((r) => r.jobId).map((r) => [r.jobId as string, r.userId]));
    for (const j of jobs) if (j.market === 'cn' && !cnPostingVisible(j, ownerOf.get(j.id) ?? null, env)) hidden.add(j.id);
  }
  // The page keeps its id order and its last id (the cursor), even when rows are dropped.
  return rows.map((r) => {
    const job = r.jobId ? byId.get(r.jobId) : undefined;
    const snap = (r.externalSnapshot && typeof r.externalSnapshot === 'object' ? r.externalSnapshot : {}) as { title?: unknown; companyName?: unknown };
    if (r.jobId && hidden.has(r.jobId)) {
      // No fact can hold for this row: nothing is computed, sent or named.
      return { id: r.id, userId: r.userId, jobId: r.jobId, status: 'closed', dateApplied: null, followUpAt: null, interviewAt: null, deadline: null, companyName: null, title: null };
    }
    return {
      id: r.id,
      userId: r.userId,
      jobId: r.jobId,
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
  const load = deps.loadCandidates ?? ((d, b, m, n, limit, after) => defaultLoadCandidates(d, b, m, n, limit, after, deps.env ?? process.env));
  const notify = deps.notify ?? defaultNotify;
  const createInbox = deps.createInbox ?? defaultCreateInbox;
  const loadPerson = deps.loadPerson ?? defaultLoadPerson;
  const labelInbox = deps.labelInbox ?? defaultLabelInbox;
  const productBrand = getBrand(brand);

  let cursor: string | null = null;
  let scanned = 0;
  let alreadySent = 0;
  let processed = 0;
  let emails = 0;
  let inAppSkipped = 0;
  let deferred = 0;
  let dropped = 0;
  let failed = 0;
  let pages = 0;
  let outOfTime = false;
  /** alerts `channelAllowed`, loaded on the first inbox-only fact (idle runs import nothing). */
  let inAppAllowed: ((prefs: StoredNotificationPrefs, category: 'reminder', channel: 'in_app') => boolean) | undefined;

  const warn = (what: string, f: ReminderFact, err: unknown) =>
    logger.warn('TRACKER', what, { entryId: f.entryId, key: f.key, error: err instanceof Error ? err.message : String(err) });

  // The ledger row: one per fact per entry. It is written before anything is
  // sent (`pending`), so a failure after the send cannot send the same fact
  // again on the next run; `settle` then stores the result, `release` removes
  // the row when nothing went out and the fact must be tried again.
  const reserve = async (f: ReminderFact): Promise<string> =>
    (await db.rATrackerEvent.create({ data: { entryId: f.entryId, userId: f.userId, kind: 'reminder', toValue: f.key, payload: { reason: f.reason, pending: true } }, select: { id: true } })).id;
  const settle = async (id: string, f: ReminderFact, payload: Record<string, unknown>): Promise<void> => {
    // The message is out (or dropped for good) and the row exists: a failed update only loses the detail.
    await db.rATrackerEvent
      .update({ where: { id }, data: { payload: { reason: f.reason, ...payload } } })
      .catch((err: unknown) => warn('could not store the reminder result', f, err));
  };
  const release = async (id: string, f: ReminderFact): Promise<void> => {
    const remove = () => db.rATrackerEvent.delete({ where: { id } });
    await remove()
      .catch(() => remove())
      .catch((err: unknown) => warn('could not release a reminder that was not sent', f, err));
  };
  /** A fact dropped for good (nobody to tell, another brand, reminders turned off). */
  const drop = async (f: ReminderFact, reason: string): Promise<void> => {
    dropped += 1;
    await db.rATrackerEvent.create({ data: { entryId: f.entryId, userId: f.userId, kind: 'reminder', toValue: f.key, payload: { reason: f.reason, skipped: reason } } });
  };

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
      const candidateOf = new Map(candidates.map((c) => [c.id, c]));

      for (const f of due) {
        if (ctx.budget.exhausted(2_000)) {
          outOfTime = true;
          break;
        }
        const plan = reminderDelivery(f, candidateOf.get(f.entryId));

        if (plan.via === 'inbox') {
          // The same rules notifyUser applies, for the one channel this message has.
          const person = await loadPerson(f.userId);
          inAppAllowed ??= (await import('../alerts/index.js')).channelAllowed;
          const skip = !person ? 'no_user' : person.brand !== brand ? 'other_brand' : !inAppAllowed(person.prefs, 'reminder', 'in_app') ? 'preference_off' : null;
          if (!person || skip) {
            await drop(f, skip ?? 'no_user');
            continue;
          }
          const title = reminderInboxTitle(f, productBrand, person.locale);
          const ledgerId = await reserve(f);
          let inApp = false;
          try {
            inApp = Boolean(await createInbox({ userId: f.userId, brand, templateKey: plan.inboxKey, params: plan.params, title, href: plan.href, entryId: f.entryId }));
          } catch (err) {
            // No seeker profile (not_found): there is no inbox to write to. Anything else is a real
            // failure of the one write: nothing is out, so the fact is released and tried again on
            // the next run. The facts after it still go out now.
            if ((err as { code?: unknown } | null)?.code !== 'not_found') {
              failed += 1;
              logger.error('TRACKER', 'reminder inbox write failed (will retry)', { entryId: f.entryId, key: f.key, error: err instanceof Error ? err.message : String(err) });
              await release(ledgerId, f);
              continue;
            }
          }
          if (!inApp) inAppSkipped += 1;
          await settle(ledgerId, f, { inApp, channel: 'inbox' });
          processed += 1;
          continue;
        }

        // One notify per due reminder. notifyUser checks the brand, the preferences and quiet hours.
        const ledgerId = await reserve(f);
        let result: NotifyUserResult;
        try {
          result = await notify({
            userId: f.userId,
            templateKey: plan.templateKey,
            params: plan.params,
            href: plan.href,
            category: 'reminder',
            kind: 'reminder',
            relatedEntity: { type: 'tracker_entry', id: f.entryId },
            brand,
            now: ctx.now,
          });
        } catch (err) {
          // notifyUser reports a failed channel in its outcome, so a throw is unexpected, and part of
          // the message may already be out. Keep the row (never send this fact twice) and stop the run.
          await settle(ledgerId, f, { failed: err instanceof Error ? err.message.slice(0, 200) : 'error', channel: 'notify' });
          throw err;
        }
        if (result.status === 'deferred') {
          // Quiet hours: nothing went out. Remove the row and try again on a later run.
          deferred += 1;
          await release(ledgerId, f);
          continue;
        }
        if (result.status === 'skipped') {
          // No such person, another brand, or reminders turned off: drop it for good.
          dropped += 1;
          await settle(ledgerId, f, { skipped: result.reason });
          continue;
        }
        const notificationId = result.outcome.notificationId;
        if (notificationId) {
          // The inbox renders `inbox.templates.<key>` in the person's language.
          await labelInbox(db, notificationId, f.userId, plan.inboxKey).catch((err: unknown) =>
            logger.warn('TRACKER', 'could not label the reminder inbox row', { notificationId, error: err instanceof Error ? err.message : String(err) }),
          );
        } else {
          inAppSkipped += 1;
        }
        if (result.outcome.email?.status === 'sent') emails += 1;
        await settle(ledgerId, f, { inApp: Boolean(notificationId), channel: 'notify', email: result.outcome.email?.status ?? null });
        processed += 1;
      }
    }

    if (candidates.length < REMINDER_BATCH) break;
    const next = candidates[candidates.length - 1]!.id;
    if (cursor !== null && next <= cursor) break; // a loader that ignores the cursor must not loop
    cursor = next;
  }
  return { processed, emails, inAppSkipped, alreadySent, deferred, dropped, failed, candidates: scanned, pages };
}
