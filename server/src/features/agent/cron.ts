// server/src/features/agent/cron.ts — cron tasks of Ready to apply (WP-52).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and RoboApplyCronService
// (node-cron) inside `runWithBrand(brand, …)` with a 240 s budget. Idle runs
// return `{ skipped: 'no_work' }` quickly (the weekly task without a query
// outside Sunday 16:00 – Tuesday 00:00 UTC).

import type { CronTask } from '../../platform/queue/index.js';
import { produceAgentReminders } from './reminders.js';
import { runReadyWeeklyTask } from './weekly.js';

/** ready-weekly (hourly at :05): builds the Monday 06:00 user-local Ready-to-apply list. */
export const runReadyWeekly: CronTask = (ctx) => runReadyWeeklyTask(ctx);

/** reminders producer (hourly): "your kit is ready and not opened" and "this week's list is ready". */
export const produceReminders: CronTask = (ctx) => produceAgentReminders(ctx);
