// server/src/cron/handlers.ts
//
// Vercel Cron HTTP endpoints. On Vercel there is no always-on process to host
// node-cron, so each of the RoboApply scheduled sweeps is exposed as an HTTP
// endpoint that Vercel Cron invokes on a schedule (see vercel.json `crons`).
// The very same service functions the in-process node-cron scheduler calls are
// reused here — this file adds no business logic, only HTTP + auth framing.
//
// Security: Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET`
// when CRON_SECRET is set in the project env. Every route rejects anything else.

import { Router, type Request, type Response, type NextFunction } from 'express';
import prisma from '../lib/prisma.js';
import { logger } from '../services/LoggerService.js';
import { runDailyMatcherForAll } from '../roboapply/services/RoboApplyDailyMatcherService.js';
import { authorAllQueuedRuns } from '../roboapply/services/RoboApplyAuthorService.js';
import {
  submitDueRunsAll,
  catchupHardFailStaleRuns,
} from '../roboapply/services/RoboApplySubmitterService.js';
import { composeAndSendDigestsForLocalHour } from '../roboapply/services/RoboApplyDigestService.js';
import {
  runRenewalReminderSweep,
  runFridayNudgeSweep,
} from '../roboapply/services/RoboApplyBillingReminderService.js';
import { interviewSessionService } from '../interview-engine/sessions/InterviewSessionService.js';

const router = Router();

/**
 * Interview-engine expiry reconciliation, piggybacked on the existing frequent
 * jobs (no dedicated vercel.json cron entry): finalize-or-expire sessions
 * stranded past expiresAt so their ingested transcripts still become reports.
 * Rides BOTH the catchup sweep (every 15 min, but only 9-15 UTC) and the
 * hourly digest job, which covers the hours catchup doesn't run. Idempotent,
 * cheap when nothing is stranded (one indexed query), and best-effort — it
 * never fails the host job.
 */
async function reconcileInterviewSessions() {
  try {
    return await interviewSessionService.reconcileExpiredSessions();
  } catch (err) {
    logger.error('ROBOAPPLY_CRON', 'interview session reconcile threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function requireCron(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.CRON_SECRET;
  const expected = `Bearer ${secret}`;
  // Allow an explicit ?secret= for manual curl testing when header injection
  // is awkward, but the primary/automated path is the Authorization header.
  const provided = req.headers.authorization || `Bearer ${req.query.secret ?? ''}`;
  if (!secret || provided !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

router.use(requireCron);

/** Wrap a job so a throw becomes a logged 500 rather than an unhandled reject. */
function job(name: string, fn: () => Promise<unknown>) {
  return async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const result = await fn();
      logger.info('ROBOAPPLY_CRON', `${name} complete`, { ms: Date.now() - startedAt });
      res.json({ ok: true, job: name, result });
    } catch (err) {
      logger.error('ROBOAPPLY_CRON', `${name} threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ ok: false, job: name, error: 'job_failed' });
    }
  };
}

// 1. Daily matcher → chained author of everything it queued.
router.get(
  '/daily-matcher',
  job('daily-matcher', async () => {
    const matcher = await runDailyMatcherForAll({});
    const author = await authorAllQueuedRuns({});
    return { matcher, author };
  }),
);

// 2. Digest fanout (service filters by user-local 07:00). Also hosts the
//    interview-session reconciler for the hours the catchup sweep doesn't run.
router.get(
  '/digest',
  job('digest', async () => {
    const digests = await composeAndSendDigestsForLocalHour({});
    const interviewReconcile = await reconcileInterviewSessions();
    return { digests, interviewReconcile };
  }),
);

// 3. Submitter (service filters by user-local 09:00).
router.get('/submitter', job('submitter', () => submitDueRunsAll({})));

// 4. Catchup sweep — submit due + hard-fail stale previewing runs. The most
//    frequent cron (every 15 min in its window), so the interview-session
//    reconciler rides here too.
router.get(
  '/catchup',
  job('catchup', async () => {
    const submit = await submitDueRunsAll({});
    const hardFail = await catchupHardFailStaleRuns({});
    const interviewReconcile = await reconcileInterviewSessions();
    return { submit, hardFail, interviewReconcile };
  }),
);

// 5. Weekly cover-letter cache cleanup.
router.get(
  '/cache-cleanup',
  job('cache-cleanup', async () => {
    const { count } = await prisma.roboApplyCoverLetterCache.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return { deleted: count };
  }),
);

// 6. Billing: renewal reminder (T-5d).
router.get('/billing-renewal-reminder', job('billing-renewal-reminder', () => runRenewalReminderSweep({})));

// 7. Billing: Friday "prep for next week" nudge.
router.get('/billing-friday-nudge', job('billing-friday-nudge', () => runFridayNudgeSweep({})));

export default router;
