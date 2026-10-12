// server/src/features/cn/campus/cron.ts — cron tasks of the campus calendar (WP-58).
//
// Called by server/src/cron/handlers.ts (`reminders`, hourly; registered as the
// `campus` producer for the cn market) and by RoboApplyCronService inside
// `runWithBrand(brand, …)` with a 240 s budget. Idle runs return
// `{ skipped: 'no_work' }` after one indexed query.

import type { CronTask } from '../../../platform/queue/index.js';
import { produceCampusReminders } from './notify.js';

/** reminders producer (hourly, GoApply only): 网申截止 reminders 3 days and 1 day before a saved programme closes, plus follow-a-company notices. Writes SeekerNotification rows and enqueues `email.send`. */
export const produceReminders: CronTask = (ctx) => produceCampusReminders(ctx);
