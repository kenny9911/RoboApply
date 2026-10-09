// server/src/features/agent/cron.ts — STUB (FND-3). Owner: WP-52.
//
// Cron tasks for this area, called by server/src/cron/handlers.ts (Vercel Cron)
// and by RoboApplyCronService (node-cron) inside `runWithBrand(brand, …)` with a
// 240 s budget. Until the owner fills them they return `{ skipped: 'not_implemented' }`
// at once and never throw. A real task must return in under 2 s when nothing is due
// and report the work it did (`processed`, counts) so the runner can log it.

import { notImplementedCron, type CronTask } from '../../platform/queue/index.js';

/** ready-weekly (hourly at :05): builds the Monday 06:00 user-local Ready-to-apply list. */
export const runReadyWeekly: CronTask = notImplementedCron('WP-52');

/** reminders producer (hourly): "your kit is ready and not opened" reminders. Writes SeekerNotification rows and enqueues `email.send`. */
export const produceReminders: CronTask = notImplementedCron('WP-52');
