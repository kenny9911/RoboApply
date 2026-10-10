// server/src/features/agent/weekly.ts — the `ready-weekly` cron (hourly at
// :05; TASK_PLAN.md §4.1.d; PRODUCT F-AGENT-04).
//
// For one brand: every user who finished Ready to apply setup gets this
// week's list on Monday from 06:00 in their own time zone (the window stays
// open until noon, so a missed tick still builds it). A user whose list for
// the week already exists (built by the cron, at setup or on demand) is
// skipped. Outside Sunday 16:00 – Tuesday 00:00 UTC no time zone is in that
// window, so the list part returns at once without a query.
//
// Every run first sweeps kits stuck in `preparing` (service
// sweepStalePreparing: older than 30 min → failed, kit credit released).
// R-04: nothing is built for a brand, or a user, without the `agent`
// capability (the cron would otherwise fill a list the user cannot open).
// Users are walked page by page until the time budget runs out (no page cap):
// users whose list exists are skipped cheaply, so a later hourly run reaches
// the users a busy run did not.
//
// The "your list is ready" notice is sent by the hourly `reminders` producer
// (reminders.ts), which also respects quiet hours.

import type { ProductBrand } from '../../platform/brand/registry.js';
import type { CronContext, CronResult } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';
import { resolveTimeZone } from '../alerts/index.js';
import { inWeeklyWindow, weekKeyFor, weeklyWindowOpenAnywhere } from './stateMachine.js';
import type { AgentDb } from './store.js';
import type { AgentServiceImpl, GenerateListOptions } from './service.js';

export const WEEKLY_BATCH = 200;

export interface WeeklyDeps {
  getDb?: () => Promise<AgentDb>;
  generate?: (userId: string, options: GenerateListOptions) => ReturnType<AgentServiceImpl['generateList']>;
  /** The `agent` capability for the brand (`userId` null) or for one user of it. */
  enabled?: (brand: ProductBrand, userId: string | null) => Promise<boolean>;
  sweep?: AgentServiceImpl['sweepStalePreparing'];
}

interface Candidate {
  userId: string;
  timeZone: string;
}

async function defaultGetDb(): Promise<AgentDb> {
  return (await import('../../lib/prisma.js')).default;
}

async function defaultGenerate(userId: string, options: GenerateListOptions) {
  const { getAgentService } = await import('./service.js');
  return getAgentService().generateList(userId, options);
}

/** `isEnabled('agent', …)` (shared with the reminder producer). */
export async function agentEnabled(brand: ProductBrand, userId: string | null): Promise<boolean> {
  const { isEnabled } = await import('../../platform/flags.js');
  return isEnabled('agent', userId ? { brand, userId } : { brand });
}

async function defaultSweep(input: Parameters<AgentServiceImpl['sweepStalePreparing']>[0]) {
  const { getAgentService } = await import('./service.js');
  return getAgentService().sweepStalePreparing(input);
}

/** One page of set-up users of this brand whose local time is Monday 06:00–11:59. */
async function loadPage(db: AgentDb, ctx: CronContext, afterUserId: string | null): Promise<{ due: Candidate[]; scanned: number; last: string | null }> {
  const rows = await db.rAAgentSettings.findMany({
    where: { setupCompletedAt: { not: null }, ...(afterUserId ? { userId: { gt: afterUserId } } : {}) },
    select: { userId: true },
    orderBy: { userId: 'asc' },
    take: WEEKLY_BATCH,
  });
  if (!rows.length) return { due: [], scanned: 0, last: null };
  const ids = rows.map((r) => r.userId);
  const [users, profiles] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, brand: true } }),
    db.seekerProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, timezone: true } }),
  ]);
  const brandOf = new Map(users.map((u) => [u.id, u.brand]));
  const tzOf = new Map(profiles.map((p) => [p.userId, p.timezone]));
  const due: Candidate[] = [];
  for (const id of ids) {
    if (brandOf.get(id) !== ctx.brand.id) continue;
    const timeZone = resolveTimeZone(tzOf.get(id) ?? null, ctx.brand.id);
    if (inWeeklyWindow(ctx.now, timeZone)) due.push({ userId: id, timeZone });
  }
  return { due, scanned: rows.length, last: ids[ids.length - 1]! };
}

/** The cron task body (`cron.ts` exports it as `runReadyWeekly`). */
export async function runReadyWeeklyTask(ctx: CronContext, deps: WeeklyDeps = {}): Promise<CronResult> {
  // Stuck kits first: their credits come back even where the list is not due (or the capability is off).
  let swept = 0;
  try {
    swept = (await (deps.sweep ?? defaultSweep)({ brand: ctx.brand.id, now: ctx.now, stop: () => ctx.budget.exhausted(5_000) })).swept;
  } catch (err) {
    logger.warn('AGENT', 'stale-preparing sweep failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const sweptOnly = (): CronResult => (swept ? { processed: 0, swept } : { skipped: 'no_work', processed: 0 });
  if (!weeklyWindowOpenAnywhere(ctx.now)) return sweptOnly();
  const enabled = deps.enabled ?? agentEnabled;
  if (!(await enabled(ctx.brand, null))) return swept ? { skipped: 'disabled', swept } : { skipped: 'disabled' };
  const db = await (deps.getDb ?? defaultGetDb)();
  const generate = deps.generate ?? defaultGenerate;
  let cursor: string | null = null;
  let pages = 0;
  let scanned = 0;
  let processed = 0;
  let added = 0;
  let alreadyBuilt = 0;
  let disabled = 0;
  let failed = 0;
  let outOfTime = false;

  while (!outOfTime) {
    if (pages > 0 && ctx.budget.exhausted(5_000)) break;
    const page = await loadPage(db, ctx, cursor);
    pages += 1;
    if (pages === 1 && page.scanned === 0) return sweptOnly();
    scanned += page.scanned;
    if (page.due.length) {
      const weekKeys = new Map(page.due.map((c) => [c.userId, weekKeyFor(ctx.now, c.timeZone)]));
      const existing = await db.rAAgentQueueItem.findMany({
        where: { userId: { in: page.due.map((c) => c.userId) }, addedVia: 'weekly', weekKey: { in: [...new Set(weekKeys.values())] } },
        select: { userId: true, weekKey: true },
      });
      const built = new Set(existing.filter((e) => weekKeys.get(e.userId) === e.weekKey).map((e) => e.userId));
      for (const c of page.due) {
        if (built.has(c.userId)) {
          alreadyBuilt += 1;
          continue;
        }
        if (ctx.budget.exhausted(5_000)) {
          outOfTime = true;
          break;
        }
        // R-04: the capability can be off for one user (an entitlement override).
        if (!(await enabled(ctx.brand, c.userId).catch(() => false))) {
          disabled += 1;
          continue;
        }
        try {
          const r = await generate(c.userId, { source: 'cron' });
          processed += 1;
          added += r.added;
        } catch (err) {
          failed += 1;
          logger.warn('AGENT', 'weekly list failed for a user', { userId: c.userId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    if (page.scanned < WEEKLY_BATCH || !page.last) break;
    cursor = page.last;
  }
  if (!processed && !failed) return { skipped: 'no_work', processed: 0, scanned, alreadyBuilt, disabled, swept };
  return { processed, added, alreadyBuilt, disabled, failed, scanned, pages, swept };
}
