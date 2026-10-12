// server/src/features/alerts/reminders.ts
//
// The `reminders` runner (hourly; TASK_PLAN.md §4.1.c–d). Producers —
// WP-38 tracker (follow-ups, interview dates), WP-52 (kit not opened),
// WP-58 (网申截止, GoApply) and any later area — register a CronTask here
// with `registerReminderProducer`. The runner calls each one for the brand
// (skipping producers not meant for the brand's market), isolates failures,
// then spends what is left of its budget draining `email.send` for that
// brand so reminder emails leave in the same tick instead of waiting for
// the next `queue-drain`.
//
// Wiring: `server/src/cron/handlers.ts` (hot file) lists the three Wave 1
// producers as steps today; INT switches the `reminders` entry to the single
// step `runReminders` and registers those producers (see the WP-39a handoff).

import type { Market } from '../../platform/brand/registry.js';
import type { CronContext, CronResult, CronTask } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';

export interface ReminderProducer {
  /** Stable name, e.g. 'tracker', 'agent', 'campus'. */
  name: string;
  task: CronTask;
  /** Markets the producer serves (default: every market). */
  markets?: readonly Market[];
}

const producers = new Map<string, ReminderProducer>();

/** Register (or re-register the same) producer. A different producer under a taken name throws. */
export function registerReminderProducer(producer: ReminderProducer): void {
  const existing = producers.get(producer.name);
  if (existing && existing.task !== producer.task) throw new Error(`reminders: a producer "${producer.name}" is already registered`);
  producers.set(producer.name, producer);
}

export function reminderProducers(): ReminderProducer[] {
  return [...producers.values()];
}

/** Tests only. */
export function resetReminderProducersForTests(): void {
  producers.clear();
}

export interface RemindersRunnerDeps {
  /** Drain `email.send` for one brand within `budgetMs`; returns items done. */
  drainEmail?: (ctx: CronContext, budgetMs: number) => Promise<number>;
}

/** Leave this much of the budget unspent. */
const RESERVE_MS = 5_000;
/** Do not start a drain with less than this. */
const MIN_DRAIN_MS = 10_000;

export function createRemindersRunner(list: () => readonly ReminderProducer[], deps: RemindersRunnerDeps = {}): CronTask {
  return async (ctx): Promise<CronResult> => {
    const results: Record<string, CronResult> = {};
    let processed = 0;
    const mine = list().filter((p) => !p.markets || p.markets.includes(ctx.brand.market));
    if (!mine.length) return { skipped: 'no_work', processed: 0 };
    for (const p of mine) {
      if (ctx.budget.exhausted(RESERVE_MS)) {
        results[p.name] = { skipped: 'budget' };
        continue;
      }
      try {
        const r = await p.task(ctx);
        results[p.name] = r;
        processed += typeof r.processed === 'number' ? r.processed : 0;
      } catch (err) {
        logger.error('REMINDERS', `producer ${p.name} threw`, { error: err instanceof Error ? err.message : String(err) });
        results[p.name] = { error: 'step_failed' };
      }
    }
    let emailed = 0;
    const left = ctx.budget.remainingMs() - RESERVE_MS;
    if (processed > 0 && left >= MIN_DRAIN_MS) {
      try {
        emailed = await (deps.drainEmail ?? defaultDrainEmail)(ctx, left);
      } catch (err) {
        logger.warn('REMINDERS', 'email drain failed; queue-drain will send them', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!processed && Object.values(results).every((r) => r.skipped)) return { skipped: 'no_work', processed: 0, producers: results };
    return { processed, emailed, producers: results };
  };
}

async function defaultDrainEmail(ctx: CronContext, budgetMs: number): Promise<number> {
  const { drain } = await import('../../platform/queue/index.js');
  const { EMAIL_SEND_KIND } = await import('../../platform/email/index.js');
  const r = await drain([EMAIL_SEND_KIND], { budgetMs, brands: [ctx.brand.id] });
  return r.done;
}

/** The runner over every registered producer. */
export const runReminders: CronTask = createRemindersRunner(reminderProducers);
