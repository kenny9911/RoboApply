// server/src/features/cn/campus/cron.ts — STUB (FND-3). Owner: WP-58.
//
// Cron tasks for this area, called by server/src/cron/handlers.ts (Vercel Cron)
// and by RoboApplyCronService (node-cron) inside `runWithBrand(brand, …)` with a
// 240 s budget. Until the owner fills them they return `{ skipped: 'not_implemented' }`
// at once and never throw. A real task must return in under 2 s when nothing is due
// and report the work it did (`processed`, counts) so the runner can log it.

import { notImplementedCron, type CronTask } from '../../../platform/queue/index.js';

/** reminders producer (hourly, GoApply only): 网申截止 reminders 3 days and 1 day before a saved programme closes. Writes SeekerNotification rows and enqueues `email.send`. */
export const produceReminders: CronTask = notImplementedCron('WP-58');
