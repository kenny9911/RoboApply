// server/src/features/tracker/cron.ts — cron tasks of the tracker area (WP-38).
//
// Called by server/src/cron/handlers.ts (`reminders`, hourly) and by
// RoboApplyCronService (node-cron) inside `runWithBrand(brand, …)` with a
// 240 s budget. Idle runs return `{ skipped: 'no_work' }` after one query.

import type { CronTask } from '../../platform/queue/index.js';
import { produceTrackerReminders } from './reminders.js';

/** reminders producer (hourly): no reply in 10 days, follow-up date due, interview within 24 h, saved-job deadline soon. Writes SeekerNotification rows and enqueues `email.send`. */
export const produceReminders: CronTask = (ctx) => produceTrackerReminders(ctx);
