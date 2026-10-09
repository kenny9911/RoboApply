// server/src/features/tracker/cron.ts — STUB (FND-3). Owner: WP-38.
//
// Cron tasks for this area, called by server/src/cron/handlers.ts (Vercel Cron)
// and by RoboApplyCronService (node-cron) inside `runWithBrand(brand, …)` with a
// 240 s budget. Until the owner fills them they return `{ skipped: 'not_implemented' }`
// at once and never throw. A real task must return in under 2 s when nothing is due
// and report the work it did (`processed`, counts) so the runner can log it.

import { notImplementedCron, type CronTask } from '../../platform/queue/index.js';

/** reminders producer (hourly): follow-up (10 days after applied, respects followUpAt) and interview-date reminders. Writes SeekerNotification rows and enqueues `email.send`. */
export const produceReminders: CronTask = notImplementedCron('WP-38');
