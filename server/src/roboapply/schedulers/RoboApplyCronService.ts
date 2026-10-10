// backend/src/roboapply/schedulers/RoboApplyCronService.ts
//
// The in-process node-cron mirror of vercel.json `crons`. The V1 auto-apply
// jobs (matcher, digest, submitter, catchup, cover-letter cache cleanup) and
// the retired Friday nudge were removed in WP-75 (ARCH §10.6 step 6).
//
//   1. 0 6 * * *  UTC                  → billing renewal reminder (T-5d).
//   2. 0 4 * * *  UTC                  → GDPR account purge (hard-delete
//                                       accounts soft-deleted past retention:
//                                       R2 artifacts first, then User rows),
//                                       preceded by the dead V1 cover-letter
//                                       cache purge.
//   3. */15 * * * * UTC                → interview-session cleanup (finalize or
//                                       expire stranded sessions; expire stale
//                                       'preparing' rows).
//   4+. Platform crons (FND-3)         → every entry of PLATFORM_CRON_JOBS in
//                                       server/src/cron/handlers.ts (queue-drain,
//                                       jobs-ingest, reminders, …), the same
//                                       tasks Vercel Cron calls. Override one
//                                       schedule with ROBOAPPLY_<NAME>_CRON (e.g.
//                                       ROBOAPPLY_QUEUE_DRAIN_CRON); turn them all
//                                       off with ROBOAPPLY_PLATFORM_CRON_DISABLED=true.
//
// All cron expressions overridable via env (see DEFAULT_* constants below).
// Kill switch: ROBOAPPLY_CRON_DISABLED=true → no tasks register at all.
//
// Idempotent: startRoboApplyCron() is safe to call twice (a second call
// returns without re-registering). stopRoboApplyCron() drops all tasks
// for graceful shutdown / tests.

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../../services/LoggerService.js';
import { runRenewalReminderSweep } from '../services/RoboApplyBillingReminderService.js';
import { runAccountPurgeSweep } from '../services/SeekerAccountPurgeService.js';
import { interviewSessionService } from '../../interview-engine/sessions/InterviewSessionService.js';
import { PLATFORM_CRON_JOBS, purgeLegacyCoverLetterCache, runPlatformCron } from '../../cron/handlers.js';

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_RENEWAL_REMINDER_CRON = '0 6 * * *'; // 06:00 UTC daily — T-5d renewal reminders
const DEFAULT_ACCOUNT_PURGE_CRON = '0 4 * * *'; // 04:00 UTC daily — GDPR hard-purge sweep
const DEFAULT_INTERVIEW_CLEANUP_CRON = '*/15 * * * *'; // every 15 min — interview session cleanup

const tasks: ScheduledTask[] = [];
const platformRunning = new Set<string>();

/** `queue-drain` → `ROBOAPPLY_QUEUE_DRAIN_CRON`. */
export function platformCronEnvName(name: string): string {
  return `ROBOAPPLY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CRON`;
}

// ─── Public API ─────────────────────────────────────────────────────────

/** Start all RoboApply cron tasks. Idempotent. */
export function startRoboApplyCron(): void {
  if (tasks.length > 0) {
    logger.info('ROBOAPPLY_CRON', 'already started; reusing existing tasks');
    return;
  }
  if ((process.env.ROBOAPPLY_CRON_DISABLED ?? '').toLowerCase() === 'true') {
    logger.info('ROBOAPPLY_CRON', 'disabled via ROBOAPPLY_CRON_DISABLED env');
    return;
  }
  const tz = process.env.SCHEDULER_TZ || 'UTC';

  // ── 1. Billing: renewal reminder (T-5d) — daily 06:00 UTC ─────────────
  registerCron(
    'billing_renewal_reminder',
    process.env.ROBOAPPLY_RENEWAL_REMINDER_CRON || DEFAULT_RENEWAL_REMINDER_CRON,
    tz,
    async () => {
      const r = await runRenewalReminderSweep({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'renewal reminder threw', { error: err instanceof Error ? err.message : String(err) });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'renewal reminder cycle complete', {
        scanned: r?.scanned ?? 0,
        sent: r?.sent ?? 0,
        skipped: r?.skipped ?? 0,
        failed: r?.failed ?? 0,
      });
    },
  );

  // ── 2. Nightly GDPR account purge — daily 04:00 UTC ───────────────────
  registerCron(
    'account_purge',
    process.env.ROBOAPPLY_ACCOUNT_PURGE_CRON || DEFAULT_ACCOUNT_PURGE_CRON,
    tz,
    async () => {
      // Dead V1 cover-letter cache rows (WP-75); never throws.
      await purgeLegacyCoverLetterCache();
      const r = await runAccountPurgeSweep({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'account purge threw', { error: err instanceof Error ? err.message : String(err) });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'account purge cycle complete', {
        scanned: r?.scanned ?? 0,
        purged: r?.purged ?? 0,
        blocked: r?.blocked ?? 0,
        unsafeRole: r?.unsafeRole ?? 0,
        failed: r?.failed ?? 0,
      });
    },
  );

  // ── 3. Interview-session cleanup — every 15 min ───────────────────────
  registerCron(
    'interview_cleanup',
    process.env.ROBOAPPLY_INTERVIEW_CLEANUP_CRON || DEFAULT_INTERVIEW_CLEANUP_CRON,
    tz,
    async () => {
      const r = await interviewSessionService.reconcileExpiredSessions().catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'interview cleanup threw', { error: err instanceof Error ? err.message : String(err) });
        return null;
      });
      if (r && (r.finalized > 0 || r.expired > 0)) {
        logger.info('ROBOAPPLY_CRON', 'interview cleanup cycle complete', r);
      }
    },
  );

  // ── 4+. Platform crons (FND-3) — mirrors of the Vercel Cron entries ──
  if ((process.env.ROBOAPPLY_PLATFORM_CRON_DISABLED ?? '').toLowerCase() === 'true') {
    logger.info('ROBOAPPLY_CRON', 'platform crons disabled via ROBOAPPLY_PLATFORM_CRON_DISABLED');
  } else {
    for (const job of PLATFORM_CRON_JOBS) {
      registerCron(
        `platform_${job.name}`,
        process.env[platformCronEnvName(job.name)] || job.schedule,
        tz,
        async () => {
          // A run that outlives its interval is not started twice in one process.
          if (platformRunning.has(job.name)) {
            logger.info('ROBOAPPLY_CRON', `${job.name} still running; skipping this tick`);
            return;
          }
          platformRunning.add(job.name);
          try {
            await runPlatformCron(job);
          } finally {
            platformRunning.delete(job.name);
          }
        },
      );
    }
  }
}

/** Stop all RoboApply cron tasks. Tests + graceful shutdown. */
export function stopRoboApplyCron(): void {
  while (tasks.length > 0) {
    const t = tasks.shift();
    if (!t) continue;
    try {
      t.stop();
      if (typeof (t as unknown as { destroy?: () => void }).destroy === 'function') {
        (t as unknown as { destroy: () => void }).destroy();
      }
    } catch (err) {
      logger.warn('ROBOAPPLY_CRON', 'failed to stop task', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  platformRunning.clear();
}

// ─── Helpers ────────────────────────────────────────────────────────────

function registerCron(label: string, expr: string, tz: string, handler: () => Promise<void>): void {
  if (!cron.validate(expr)) {
    logger.error('ROBOAPPLY_CRON', `invalid cron expression for ${label} — skipping`, { expr });
    return;
  }
  const task = cron.schedule(
    expr,
    () => {
      void handler().catch((err) => {
        logger.error('ROBOAPPLY_CRON', `${label} handler outer-catch threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    { timezone: tz },
  );
  tasks.push(task);
  logger.info('ROBOAPPLY_CRON', `registered ${label} task "${expr}" (tz=${tz})`);
}

export const roboApplyCronService = {
  startRoboApplyCron,
  stopRoboApplyCron,
};

export const __test = {
  DEFAULT_RENEWAL_REMINDER_CRON,
  DEFAULT_ACCOUNT_PURGE_CRON,
  DEFAULT_INTERVIEW_CLEANUP_CRON,
};

export default roboApplyCronService;
