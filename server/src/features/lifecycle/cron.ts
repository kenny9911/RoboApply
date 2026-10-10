// server/src/features/lifecycle/cron.ts — lifecycle-emails cron (WP-39a).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and RoboApplyCronService
// (node-cron) inside `runWithBrand(brand, …)` with a 240 s budget. Returns
// `{ skipped: 'no_work' }` at once when nobody is new or idle on the brand.

import type { CronTask } from '../../platform/queue/index.js';
import { installEmailPreferenceGate } from '../alerts/index.js';
import { createLifecycleTask, defaultLifecycleDeps } from './service.js';
import '../../platform/email/templates/notify/index.js';

installEmailPreferenceGate();

/** lifecycle-emails (hourly at :15): the PRODUCT §7.3 sequence, one lifecycle message per user per day, quiet hours, "Tips and reminders" preference. */
export const runLifecycleEmails: CronTask = createLifecycleTask(defaultLifecycleDeps);
