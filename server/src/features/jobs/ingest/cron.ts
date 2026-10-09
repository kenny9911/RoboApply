// server/src/features/jobs/ingest/cron.ts — STUB (FND-3). Owner: WP-16b.
//
// Cron tasks for this area, called by server/src/cron/handlers.ts (Vercel Cron)
// and by RoboApplyCronService (node-cron) inside `runWithBrand(brand, …)` with a
// 240 s budget. Until the owner fills them they return `{ skipped: 'not_implemented' }`
// at once and never throw. A real task must return in under 2 s when nothing is due
// and report the work it did (`processed`, counts) so the runner can log it.

import { notImplementedCron, type CronTask } from '../../../platform/queue/index.js';

/** jobs-plan (02:00 UTC daily): the demand-driven query planner (ARCH §4.3). */
export const runJobsPlan: CronTask = notImplementedCron('WP-16b');

/** jobs-ingest (every 10 min): fetch → normalize → upsert per brand, incl. ATS public sources (WP-42) (ARCH §4.4). */
export const runJobsIngest: CronTask = notImplementedCron('WP-16b');

/** jobs-maintain (03:30 UTC daily): expire/archive, dedupe repair (ARCH §4.6). The platform pruning steps run beside it in cron/handlers.ts. */
export const runJobsMaintain: CronTask = notImplementedCron('WP-16b');
