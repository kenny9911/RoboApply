// server/src/features/interview/cron.ts — interview area cron tasks (WP-63a).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and by
// RoboApplyCronService (node-cron) inside `runWithBrand(brand, …)` with a
// 240 s budget, once per allowed brand.

import type { CronTask } from '../../platform/queue/index.js';
import { purgeInterviewArtifacts } from './retention.js';

/**
 * Interview retention (run inside compliance-daily): deletes practice
 * recordings and transcripts older than INTERVIEW_RETENTION_DAYS (default 90),
 * on both brands, from each brand's own bucket. Returns quickly when nothing
 * is older than the window.
 */
export const runInterviewRetention: CronTask = async (ctx) => {
  const result = await purgeInterviewArtifacts({ brand: ctx.brand.id, now: ctx.now, budget: ctx.budget });
  if (result.processed === 0 && result.stoppedBy === 'idle') {
    return { skipped: 'no_work', processed: 0, retentionDays: result.retentionDays };
  }
  return { ...result };
};
