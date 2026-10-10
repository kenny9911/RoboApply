// server/src/features/alerts/cron.ts — job-alerts cron (WP-39a).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and RoboApplyCronService
// (node-cron) inside `runWithBrand(brand, …)` with a 240 s budget. Returns
// `{ skipped: 'no_work' }` at once when no saved search has alerts on, and
// `{ skipped: 'disabled' }` on a brand where `jobs.alerts` is off (GoApply
// with recruitment-info mode `off`).

import type { CronTask } from '../../platform/queue/index.js';
import { installEmailPreferenceGate } from './preferences.js';
import { createJobAlertsTask, defaultJobAlertsDeps } from './service.js';
import '../../platform/email/templates/notify/index.js';

// Alert and reminder emails are non-transactional: without the gate the
// platform suppresses them all.
installEmailPreferenceGate();

/** job-alerts (every 15 min): instant and digest job alerts per brand (ARCH §8.2, PRODUCT §7.2). */
export const runJobAlerts: CronTask = createJobAlertsTask(defaultJobAlertsDeps);
