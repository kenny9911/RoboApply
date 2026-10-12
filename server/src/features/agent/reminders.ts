// server/src/features/agent/reminders.ts — Ready to apply's reminder producer
// (hourly `reminders` cron, registered as `agent`; TASK_PLAN.md §4.1.c–d;
// PRODUCT §7.3 row 9; WP-39a carry-over).
//
// Two facts, each sent once:
//   - kit_not_opened: a kit has been ready (or approved) for 24 h and the
//     user has not opened the application; fresh for 7 days. A kit whose post
//     has closed gets no reminder and is marked `expired` instead. Template
//     `notify.kit_not_opened` ("Your kit for {title} at {company} is ready").
//   - ready_list_ready: the cron built this week's list (the notice for a
//     list the user built on demand is recorded as handled when it is built).
//     Template `notify.ready_list_ready` with the real count (never sent for 0).
// Delivery goes through `notifyUser` (WP-39a): in-app first, then email and
// registered channels, with the user's preferences and quiet hours — a
// deferred send leaves no ledger row, so a later hour retries it.
// The ledger is a RAAgentKitEvent "notice" row (fromState = toState) on the
// item, which also shows in the kit's history.
// R-04: nothing is sent for a brand, or to a user, without the `agent`
// capability (the notice would link to a page that answers 404).
// Both scans walk their whole window in id order, page by page, until the
// time budget runs out (no page cap), so items already handled never crowd
// out the ones still due.
// Idle runs cost one indexed query per scan.

import type { ProductBrand } from '../../platform/brand/registry.js';
import type { CronContext, CronResult } from '../../platform/queue/index.js';
import { NOTIFY_TEMPLATES, type NotifyUserInput, type NotifyUserResult } from '../alerts/index.js';
import { READY_NOT_OPENED_STATES } from './contract.js';
import { isJobClosed, kitEventKind, readDetail, recordKitNote, transitionItem, QUEUE_SELECT, type AgentDb, type QueueRow } from './store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A kit counts as "not opened" after this long in a ready state. */
export const KIT_NOT_OPENED_AFTER_MS = DAY;
/** …and is reminded only while fresh. */
export const KIT_REMINDER_FRESH_MS = 7 * DAY;
/** The list notice looks at lists built in the last day. */
export const LIST_NOTICE_WINDOW_MS = DAY;
export const REMINDER_BATCH = 300;

export interface AgentReminderDeps {
  getDb?: () => Promise<AgentDb>;
  notify?: (input: NotifyUserInput) => Promise<NotifyUserResult>;
  /** The `agent` capability for the brand (`userId` null) or for one user of it. */
  enabled?: (brand: ProductBrand, userId: string | null) => Promise<boolean>;
}

/** Per-run cache of the per-user capability check. */
type UserAllowed = (userId: string) => Promise<boolean>;

function userAllowed(ctx: CronContext, enabled: NonNullable<AgentReminderDeps['enabled']>): UserAllowed {
  const cache = new Map<string, Promise<boolean>>();
  return (userId) => {
    let hit = cache.get(userId);
    if (!hit) {
      hit = enabled(ctx.brand, userId).catch(() => false);
      cache.set(userId, hit);
    }
    return hit;
  };
}

async function defaultEnabled(brand: ProductBrand, userId: string | null): Promise<boolean> {
  const { agentEnabled } = await import('./weekly.js');
  return agentEnabled(brand, userId);
}

async function defaultGetDb(): Promise<AgentDb> {
  return (await import('../../lib/prisma.js')).default;
}

async function defaultNotify(input: NotifyUserInput): Promise<NotifyUserResult> {
  const { notifyUser } = await import('../alerts/index.js');
  return notifyUser(input);
}

async function brandUsers(db: AgentDb, ids: string[], brand: string): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const users = await db.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, brand: true } });
  return new Set(users.filter((u) => u.brand === brand).map((u) => u.id));
}

async function noticesSent(db: AgentDb, itemIds: string[], notice: string): Promise<Set<string>> {
  if (!itemIds.length) return new Set();
  const rows = await db.rAAgentKitEvent.findMany({
    where: { queueItemId: { in: itemIds }, actor: 'system' },
    select: { queueItemId: true, fromState: true, toState: true, kind: true, detail: true },
  });
  // The `kind` column when the writer set it, else derived (rows from before the column).
  return new Set(rows.filter((r) => kitEventKind(r) === 'notice' && readDetail(r.detail).notice === notice).map((r) => r.queueItemId));
}

interface Outcome {
  sent: number;
  deferred: number;
  skipped: number;
  /** Not sent: the `agent` capability is off for that user. */
  disabled: number;
  /** Not sent: the post closed; the kit is marked `expired` instead. */
  expired: number;
}

async function deliver(db: AgentDb, item: QueueRow, notice: string, input: NotifyUserInput, send: AgentReminderDeps['notify'], extra: Record<string, unknown>, out: Outcome) {
  const result = await send!(input);
  if (result.status === 'deferred') {
    out.deferred += 1;
    return;
  }
  await recordKitNote(db, item, 'system', { notice, sent: result.status === 'delivered', ...extra });
  if (result.status === 'delivered') out.sent += 1;
  else out.skipped += 1;
}

/**
 * Kits ready for a day and not opened. Walks the candidates in id order, page
 * by page, so kits already reminded (they stay in the window for a week) never
 * crowd out the ones still due.
 */
async function kitNotOpened(db: AgentDb, ctx: CronContext, send: AgentReminderDeps['notify'], out: Outcome, allowed: UserAllowed): Promise<number> {
  let cursor: string | null = null;
  let scanned = 0;
  for (let page = 0; ; page += 1) {
    if (page > 0 && ctx.budget.exhausted(5_000)) break;
    const { rows, last } = await kitNotOpenedPage(db, ctx, send, out, cursor, allowed);
    scanned += rows;
    if (rows < REMINDER_BATCH || !last) break;
    cursor = last;
  }
  return scanned;
}

async function kitNotOpenedPage(
  db: AgentDb,
  ctx: CronContext,
  send: AgentReminderDeps['notify'],
  out: Outcome,
  afterId: string | null,
  allowed: UserAllowed,
): Promise<{ rows: number; last: string | null }> {
  const now = ctx.now.getTime();
  const rows = (await db.rAAgentQueueItem.findMany({
    where: {
      ...(afterId ? { id: { gt: afterId } } : {}),
      state: { in: [...READY_NOT_OPENED_STATES] },
      updatedAt: { lte: new Date(now - KIT_NOT_OPENED_AFTER_MS), gt: new Date(now - KIT_REMINDER_FRESH_MS) },
    },
    select: QUEUE_SELECT,
    orderBy: { id: 'asc' },
    take: REMINDER_BATCH,
  })) as QueueRow[];
  if (!rows.length) return { rows: 0, last: null };
  const last = rows[rows.length - 1]!.id;
  const mine = await brandUsers(
    db,
    rows.map((r) => r.userId),
    ctx.brand.id,
  );
  const candidates = rows.filter((r) => mine.has(r.userId));
  const done = await noticesSent(
    db,
    candidates.map((r) => r.id),
    'kit_not_opened',
  );
  const due = candidates.filter((r) => !done.has(r.id));
  if (!due.length) return { rows: rows.length, last };
  const jobs = await db.rAJob.findMany({
    where: { id: { in: due.map((d) => d.jobId) } },
    select: { id: true, title: true, companyName: true, closedAt: true, archivedAt: true },
  });
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  for (const item of due) {
    if (ctx.budget.exhausted(5_000)) break;
    const job = jobOf.get(item.jobId);
    if (!job) continue;
    if (isJobClosed(job)) {
      // Never nudge the user toward a post that is no longer listed: the kit expires instead
      // (the same move the list makes when it is read), so the badge and the reminders agree.
      await transitionItem(db, item, 'expired', { actor: 'system', detail: { error: 'job_closed' } }).then(
        () => {
          out.expired += 1;
        },
        () => undefined, // moved meanwhile (opened, or expired by a list read)
      );
      continue;
    }
    if (!(await allowed(item.userId))) {
      out.disabled += 1;
      continue;
    }
    await deliver(
      db,
      item,
      'kit_not_opened',
      {
        userId: item.userId,
        templateKey: NOTIFY_TEMPLATES.kitNotOpened,
        params: { jobId: item.jobId, title: job.title, company: job.companyName },
        href: `/ready/${encodeURIComponent(item.jobId)}`,
        category: 'reminder',
        relatedEntity: { type: 'agent_queue_item', id: item.id },
        brand: ctx.brand.id,
        now: ctx.now,
      },
      send,
      {},
      out,
    );
  }
  return { rows: rows.length, last };
}

/**
 * "This week's list is ready", once per (user, week) list built by the cron
 * in the last day. Walks every weekly item of the window in id order, page by
 * page; a list met again on a later page (or already handled this run) is
 * skipped.
 */
async function listReady(db: AgentDb, ctx: CronContext, send: AgentReminderDeps['notify'], out: Outcome, allowed: UserAllowed): Promise<number> {
  const since = new Date(ctx.now.getTime() - LIST_NOTICE_WINDOW_MS);
  const handled = new Set<string>();
  let cursor: string | null = null;
  let scanned = 0;
  for (let page = 0; ; page += 1) {
    if (page > 0 && ctx.budget.exhausted(5_000)) break;
    const rows = (await db.rAAgentQueueItem.findMany({
      where: { addedVia: 'weekly', createdAt: { gte: since }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: QUEUE_SELECT,
      orderBy: { id: 'asc' },
      take: REMINDER_BATCH,
    })) as QueueRow[];
    if (!rows.length) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1]!.id;
    await listReadyPage(db, ctx, send, out, rows, handled, allowed);
    if (rows.length < REMINDER_BATCH) break;
  }
  return scanned;
}

async function listReadyPage(
  db: AgentDb,
  ctx: CronContext,
  send: AgentReminderDeps['notify'],
  out: Outcome,
  recent: QueueRow[],
  handled: Set<string>,
  allowed: UserAllowed,
): Promise<void> {
  const mine = await brandUsers(
    db,
    recent.map((r) => r.userId),
    ctx.brand.id,
  );
  // One list per (user, week): the first item met carries the ledger row.
  const lists = new Map<string, QueueRow>();
  for (const r of recent) {
    if (!mine.has(r.userId)) continue;
    const key = `${r.userId}|${r.weekKey}`;
    if (!handled.has(key) && !lists.has(key)) lists.set(key, r);
  }
  if (!lists.size) return;
  const userIds = [...new Set([...lists.values()].map((r) => r.userId))];
  const weekKeys = [...new Set([...lists.values()].map((r) => r.weekKey))];
  const all = (await db.rAAgentQueueItem.findMany({
    where: { userId: { in: userIds }, addedVia: 'weekly', weekKey: { in: weekKeys } },
    select: { id: true, userId: true, weekKey: true },
  })) as Array<{ id: string; userId: string; weekKey: string }>;
  const ledger = await db.rAAgentKitEvent.findMany({
    where: { queueItemId: { in: all.map((a) => a.id) }, actor: 'system' },
    select: { queueItemId: true, fromState: true, toState: true, kind: true, detail: true },
  });
  const itemKey = new Map(all.map((a) => [a.id, `${a.userId}|${a.weekKey}`]));
  const notified = new Set(
    ledger
      .filter((e) => kitEventKind(e) === 'notice' && readDetail(e.detail).notice === 'ready_list_ready')
      .map((e) => itemKey.get(e.queueItemId))
      .filter((k): k is string => Boolean(k)),
  );
  const sizes = new Map<string, number>();
  for (const a of all) sizes.set(`${a.userId}|${a.weekKey}`, (sizes.get(`${a.userId}|${a.weekKey}`) ?? 0) + 1);
  for (const [key, first] of lists) {
    if (ctx.budget.exhausted(5_000)) break;
    handled.add(key);
    if (notified.has(key)) continue;
    const count = sizes.get(key) ?? 0;
    if (count <= 0) continue;
    if (!(await allowed(first.userId))) {
      out.disabled += 1;
      continue;
    }
    await deliver(
      db,
      first,
      'ready_list_ready',
      {
        userId: first.userId,
        templateKey: NOTIFY_TEMPLATES.readyListReady,
        params: { count },
        href: '/ready',
        category: 'reminder',
        relatedEntity: { type: 'agent_week', id: first.weekKey },
        brand: ctx.brand.id,
        now: ctx.now,
      },
      send,
      { weekKey: first.weekKey },
      out,
    );
  }
}

/** The producer body (`cron.ts` exports it as `produceReminders`). */
export async function produceAgentReminders(ctx: CronContext, deps: AgentReminderDeps = {}): Promise<CronResult> {
  const enabled = deps.enabled ?? defaultEnabled;
  if (!(await enabled(ctx.brand, null))) return { skipped: 'disabled' };
  const db = await (deps.getDb ?? defaultGetDb)();
  const send = deps.notify ?? defaultNotify;
  const allowed = userAllowed(ctx, enabled);
  const out: Outcome = { sent: 0, deferred: 0, skipped: 0, disabled: 0, expired: 0 };
  const scannedKits = await kitNotOpened(db, ctx, send, out, allowed);
  const scannedLists = ctx.budget.exhausted(5_000) ? 0 : await listReady(db, ctx, send, out, allowed);
  if (!scannedKits && !scannedLists) return { skipped: 'no_work', processed: 0 };
  return {
    processed: out.sent,
    sent: out.sent,
    deferred: out.deferred,
    skippedByPreference: out.skipped,
    skippedDisabled: out.disabled,
    expiredClosed: out.expired,
    scannedKits,
    scannedLists,
  };
}
