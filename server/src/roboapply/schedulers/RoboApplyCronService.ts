// backend/src/roboapply/schedulers/RoboApplyCronService.ts
//
// Per arch §4 — five scheduled jobs, all on the existing node-cron infra.
//
//   1. 0 5 * * *  UTC                 → daily matcher (loops all enabled+unpaused missions)
//                                       chained: matcher → author for queued runs
//   2. 0 7 * * *  user-local (per-TZ)  → digest fanout. Implemented as a UTC
//                                       hourly tick that picks missions whose
//                                       user-local hour matches 07.
//   3. 0 9 * * *  user-local (per-TZ)  → submitter (09:00 user-local).
//                                       Same UTC hourly tick + tz-fanout pattern.
//   4. */15 9-15 * * *  UTC            → catchup sweep (hard-fail `previewing`
//                                       runs past plannedSubmitAt + 6h).
//   5. 0 3 * * 0  UTC                  → weekly RoboApplyCoverLetterCache
//                                       cleanup (delete rows past expiresAt).
//   6. 0 6 * * *  UTC                  → billing renewal reminder (T-5d).
//   7. 0 16 * * 5 UTC                  → Friday "prep for next week" nudge.
//   8. 0 4 * * *  UTC                  → GDPR account purge (hard-delete
//                                       accounts soft-deleted past retention:
//                                       R2 artifacts first, then User rows).
//
// All cron expressions overridable via env (see DEFAULT_* constants below).
// Kill switch: ROBOAPPLY_CRON_DISABLED=true → no tasks register at all.
//
// Idempotent: startRoboApplyCron() is safe to call twice (a second call
// returns without re-registering). stopRoboApplyCron() drops all tasks
// for graceful shutdown / tests.

import cron, { type ScheduledTask } from 'node-cron';
import prisma from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { runDailyMatcherForAll } from '../services/RoboApplyDailyMatcherService.js';
import { authorAllQueuedRuns } from '../services/RoboApplyAuthorService.js';
import { submitDueRunsAll, catchupHardFailStaleRuns } from '../services/RoboApplySubmitterService.js';
import { composeAndSendDigestsForLocalHour } from '../services/RoboApplyDigestService.js';
import { runRenewalReminderSweep, runFridayNudgeSweep } from '../services/RoboApplyBillingReminderService.js';
import { runAccountPurgeSweep } from '../services/SeekerAccountPurgeService.js';

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_MATCHER_CRON = '0 5 * * *'; // 05:00 UTC daily
const DEFAULT_DIGEST_CRON = '0 * * * *'; // top of every UTC hour — service filters by user-local 07:00
const DEFAULT_SUBMITTER_CRON = '0 * * * *'; // top of every UTC hour — service filters by user-local 09:00
const DEFAULT_CATCHUP_CRON = '*/15 9-15 * * *'; // every 15 min from 09:15–15:45 UTC
const DEFAULT_CACHE_CLEANUP_CRON = '0 3 * * 0'; // Sunday 03:00 UTC
const DEFAULT_RENEWAL_REMINDER_CRON = '0 6 * * *'; // 06:00 UTC daily — T-5d renewal reminders
const DEFAULT_FRIDAY_NUDGE_CRON = '0 16 * * 5'; // Fri 16:00 UTC — weekly prep nudge
const DEFAULT_ACCOUNT_PURGE_CRON = '0 4 * * *'; // 04:00 UTC daily — GDPR hard-purge sweep

// In-memory dedup so a per-mission submitter doesn't race the catchup sweep
// already fired this hour. The submitter/digest services have their own
// per-mission mutexes; this set tracks whether the same UTC hour already
// kicked off the per-local-hour cron entry. Resets on process restart.
const firedThisHour = new Set<string>();
// Rotate the dedup set hourly.
let dedupCleanupInterval: NodeJS.Timeout | null = null;

const tasks: ScheduledTask[] = [];

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

  // ── 1. Matcher (05:00 UTC daily) ──────────────────────────────────────
  registerCron(
    'matcher',
    process.env.ROBOAPPLY_MATCHER_CRON || DEFAULT_MATCHER_CRON,
    tz,
    async () => {
      const matcherResult = await runDailyMatcherForAll({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'matcher cycle threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'matcher cycle complete', {
        scanned: matcherResult?.scanned ?? 0,
        missionsRan: matcherResult?.missionsRan ?? 0,
        totalQueued: matcherResult?.totalQueued ?? 0,
      });

      // Chained: author covers for everything the matcher just queued.
      // Failures inside the author are non-fatal — each mission's author
      // pass catches its own errors per-run.
      const authorResult = await authorAllQueuedRuns({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'chained author cycle threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'chained author cycle complete', {
        missionsScanned: authorResult?.missionsScanned ?? 0,
        authored: authorResult?.authored ?? 0,
        cacheHits: authorResult?.cacheHits ?? 0,
        failed: authorResult?.failed ?? 0,
      });
    },
  );

  // ── 2. Digest fanout (UTC hourly tick; service filters by local 07:00)
  registerCron(
    'digest',
    process.env.ROBOAPPLY_DIGEST_CRON || DEFAULT_DIGEST_CRON,
    tz,
    async () => {
      const hourKey = `digest:${new Date().toISOString().slice(0, 13)}`;
      if (firedThisHour.has(hourKey)) {
        logger.info('ROBOAPPLY_CRON', 'digest cron already fired this UTC hour; skipping');
        return;
      }
      firedThisHour.add(hourKey);
      const result = await composeAndSendDigestsForLocalHour({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'digest cycle threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'digest cycle complete', {
        missionsTargeted: result?.missionsTargeted ?? 0,
        sent: result?.sent ?? 0,
        persistedNoEmail: result?.persistedNoEmail ?? 0,
        failed: result?.failed ?? 0,
      });
    },
  );

  // ── 3. Submitter (UTC hourly tick; service filters by local 09:00) ────
  registerCron(
    'submitter',
    process.env.ROBOAPPLY_SUBMITTER_CRON || DEFAULT_SUBMITTER_CRON,
    tz,
    async () => {
      const hourKey = `submitter:${new Date().toISOString().slice(0, 13)}`;
      if (firedThisHour.has(hourKey)) {
        logger.info('ROBOAPPLY_CRON', 'submitter cron already fired this UTC hour; skipping');
        return;
      }
      firedThisHour.add(hourKey);
      const result = await submitDueRunsAll({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'submitter cycle threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'submitter cycle complete', {
        missionsScanned: result?.missionsScanned ?? 0,
        submitted: result?.submitted ?? 0,
        failed: result?.failed ?? 0,
        manualLinks: result?.manualLinks ?? 0,
      });
    },
  );

  // ── 4. Catchup sweep ──────────────────────────────────────────────────
  registerCron(
    'catchup',
    process.env.ROBOAPPLY_CATCHUP_CRON || DEFAULT_CATCHUP_CRON,
    tz,
    async () => {
      const submitResult = await submitDueRunsAll({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'catchup submit cycle threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      const hardFail = await catchupHardFailStaleRuns({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'catchup hard-fail cycle threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'catchup cycle complete', {
        submitted: submitResult?.submitted ?? 0,
        failed: submitResult?.failed ?? 0,
        marked_stale: hardFail?.marked ?? 0,
      });
    },
  );

  // ── 5. Weekly cover-letter cache cleanup ──────────────────────────────
  registerCron(
    'cache_cleanup',
    process.env.ROBOAPPLY_CACHE_CLEANUP_CRON || DEFAULT_CACHE_CLEANUP_CRON,
    tz,
    async () => {
      try {
        const { count } = await prisma.roboApplyCoverLetterCache.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        logger.info('ROBOAPPLY_CRON', 'cache cleanup complete', { deleted: count });
      } catch (err) {
        logger.error('ROBOAPPLY_CRON', 'cache cleanup threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── 6. Billing: renewal reminder (T-5d) — daily 06:00 UTC ─────────────
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

  // ── 7. Billing: Friday "prep for next week" nudge — Fri 16:00 UTC ─────
  registerCron(
    'billing_friday_nudge',
    process.env.ROBOAPPLY_FRIDAY_NUDGE_CRON || DEFAULT_FRIDAY_NUDGE_CRON,
    tz,
    async () => {
      const r = await runFridayNudgeSweep({}).catch((err) => {
        logger.error('ROBOAPPLY_CRON', 'friday nudge threw', { error: err instanceof Error ? err.message : String(err) });
        return null;
      });
      logger.info('ROBOAPPLY_CRON', 'friday nudge cycle complete', {
        scanned: r?.scanned ?? 0,
        sent: r?.sent ?? 0,
        skipped: r?.skipped ?? 0,
        failed: r?.failed ?? 0,
      });
    },
  );

  // ── 8. Nightly GDPR account purge — daily 04:00 UTC ───────────────────
  registerCron(
    'account_purge',
    process.env.ROBOAPPLY_ACCOUNT_PURGE_CRON || DEFAULT_ACCOUNT_PURGE_CRON,
    tz,
    async () => {
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

  // Rotate the per-hour dedup set every hour so it doesn't grow unbounded.
  dedupCleanupInterval = setInterval(() => {
    const currentHour = new Date().toISOString().slice(0, 13);
    for (const key of Array.from(firedThisHour)) {
      if (!key.endsWith(currentHour)) firedThisHour.delete(key);
    }
  }, 60 * 60 * 1000);
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
  if (dedupCleanupInterval) {
    clearInterval(dedupCleanupInterval);
    dedupCleanupInterval = null;
  }
  firedThisHour.clear();
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
  DEFAULT_MATCHER_CRON,
  DEFAULT_DIGEST_CRON,
  DEFAULT_SUBMITTER_CRON,
  DEFAULT_CATCHUP_CRON,
  DEFAULT_CACHE_CLEANUP_CRON,
};

export default roboApplyCronService;
