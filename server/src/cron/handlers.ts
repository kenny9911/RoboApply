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
//
// Platform crons (FND-3, TASK_PLAN.md §4.1.d): `PLATFORM_CRON_JOBS` below is
// the one table of the jobright-clone crons. Each runs once per brand this
// deployment serves (`ALLOWED_BRANDS`), inside `runWithBrand(brand, …)`, with
// one 240 s budget per invocation; the area tasks live in
// server/src/features/<area>/cron.ts (stubs until their WP fills them). The
// same table drives the node-cron mirrors in RoboApplyCronService and is
// checked against vercel.json by a test. Every run logs what it did and
// returns in under 2 s when there is nothing to do.

import { Router, type Request, type Response, type NextFunction } from 'express';
import prisma from '../lib/prisma.js';
import { logger } from '../services/LoggerService.js';
import { runRenewalReminderSweep } from '../roboapply/services/RoboApplyBillingReminderService.js';
import { interviewSessionService } from '../interview-engine/sessions/InterviewSessionService.js';
import { runAccountPurgeSweep } from '../roboapply/services/SeekerAccountPurgeService.js';
import crypto from 'node:crypto';
import { runWithBrand } from '../lib/requestContext.js';
import { allowedBrands } from '../platform/brand/runtime.js';
import { getBrand, type BrandId, type Market } from '../platform/brand/registry.js';
import {
  CRON_BUDGET_MS,
  createBudget,
  drain,
  pruneWorkItems,
  type Budget,
  type CronResult,
  type CronTask,
} from '../platform/queue/index.js';
import { pruneRateCounters } from '../platform/ratelimit/index.js';
import { creditService } from '../platform/credits/index.js';
import { runJobsIngest, runJobsMaintain, runJobsPlan } from '../features/jobs/ingest/cron.js';
import { runScorePrecompute } from '../features/match/cron.js';
import { runJobAlerts } from '../features/alerts/cron.js';
import { runLifecycleEmails } from '../features/lifecycle/cron.js';
import { produceReminders as produceTrackerReminders } from '../features/tracker/cron.js';
import { produceReminders as produceAgentReminders, runReadyWeekly } from '../features/agent/cron.js';
import { produceReminders as produceCampusReminders } from '../features/cn/campus/cron.js';
import { registerReminderProducer, runReminders } from '../features/alerts/reminders.js';
import { runSeoRebuild } from '../features/seo/cron.js';
import { runComplianceDaily } from '../features/compliance/cron.js';
import { runInterviewRetention } from '../features/interview/cron.js';
import { runToolsPurge } from '../features/tools/cron.js';
import { runContactsSync } from '../features/network/cron.js';
import { runAdminHealthEmail } from '../features/admin/index.js';
import { runAnonAlertDigests } from '../features/visitor/index.js';
import { pruneReferralSignals } from '../features/growth/index.js';
import { runWinbackSweep } from '../platform/billing/index.js';

const router = Router();

/**
 * Interview-engine expiry reconciliation: finalize-or-expire sessions stranded
 * past expiresAt so their ingested transcripts still become reports, and
 * expire 'preparing' rows whose prepare request was lost (> 30 min). Has its
 * own cron route (/interview-cleanup, every 15 min in vercel.json and in the
 * local node-cron service). Idempotent, cheap when nothing is stranded, and
 * best-effort — it never throws.
 */
export async function reconcileInterviewSessions() {
  try {
    return await interviewSessionService.reconcileExpiredSessions();
  } catch (err) {
    logger.error('ROBOAPPLY_CRON', 'interview session reconcile threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Retention for the retired V1 cover-letter cache (`RoboApplyCoverLetterCache`).
 * WP-75 deleted its only writer and reader (RoboApplyAuthorService), so every
 * row left is dead: a generated cover letter built from a user's resume, with
 * no `User` relation, so neither the account-purge cascade nor the data wipe
 * reaches it. The old weekly `/cache-cleanup` cron only removed expired rows;
 * this sweep removes all of them and rides on the nightly account purge. The
 * table itself stays in the schema (no DDL). Best-effort: never throws.
 */
export async function purgeLegacyCoverLetterCache(): Promise<{ deleted: number } | null> {
  try {
    const { count } = await prisma.roboApplyCoverLetterCache.deleteMany({});
    if (count > 0) {
      logger.info('ROBOAPPLY_CRON', 'legacy cover-letter cache purged', { deleted: count });
    }
    return { deleted: count };
  } catch (err) {
    logger.error('ROBOAPPLY_CRON', 'legacy cover-letter cache purge threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function requireCron(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.CRON_SECRET;
  const expected = `Bearer ${secret}`;
  // Allow an explicit ?secret= for manual curl testing when header injection
  // is awkward, but the primary/automated path is the Authorization header.
  const provided = req.headers.authorization || `Bearer ${req.query.secret ?? ''}`;
  if (!secret || !safeEqual(String(provided), expected)) {
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

// The V1 auto-apply crons (daily-matcher, digest, submitter, catchup,
// cache-cleanup) and the retired billing-friday-nudge were removed in WP-75
// (ARCH §10.6 step 6; TASK_PLAN.md §4.1.d). Interview reconciliation already
// runs on its own /interview-cleanup cron; the cover-letter cache retention
// that /cache-cleanup did now runs inside /account-purge (see
// purgeLegacyCoverLetterCache above).
// scripts/gen-cn-cronjobs.mjs still names five of them in EXCLUDED_CRONS on
// purpose: __tests__/deploy/cronParity.test.ts asserts the auto-submit sweeps
// can never be mirrored to the mainland stack, even if a route came back.

// 1. Billing: renewal reminder (T-5d).
router.get('/billing-renewal-reminder', job('billing-renewal-reminder', () => runRenewalReminderSweep({})));

// 2. Nightly GDPR account purge — R2 interview artifacts + resume originals
//    first, then the User row (cascades), for accounts soft-deleted past the
//    retention window. See SeekerAccountPurgeService. Also clears the dead V1
//    cover-letter cache first, so an account-purge throw cannot skip it.
router.get(
  '/account-purge',
  job('account-purge', async () => {
    const legacyCoverLetterCache = await purgeLegacyCoverLetterCache();
    const purge = await runAccountPurgeSweep({});
    return { ...purge, legacyCoverLetterCache };
  }),
);

// 3. Interview-session cleanup (every 15 min): finalize/expire stranded
//    sessions past expiresAt + expire stale 'preparing' rows.
router.get('/interview-cleanup', job('interview-cleanup', () => reconcileInterviewSessions()));

// ─── Platform crons (FND-3) ─────────────────────────────────────────────

/** One unit of a platform cron: an area task, run per brand (or once, for platform housekeeping). */
export interface PlatformCronStep {
  name: string;
  task: CronTask;
  /** Run only for brands in these markets (e.g. the GoApply campus producer). */
  markets?: Market[];
}

export interface PlatformCronRunOptions {
  /** Brands to run (default: ALLOWED_BRANDS of this deployment). */
  brands?: BrandId[];
  budgetMs?: number;
  now?: () => number;
}

export interface PlatformCronReport {
  job: string;
  ok: boolean;
  /** Set when every step that ran returned the same `skipped` reason (e.g. 'not_implemented'). */
  skipped?: string;
  /** Per brand (or 'platform') → per step → result. */
  results: Record<string, Record<string, CronResult>>;
  ms: number;
}

export interface PlatformCronJob {
  /** Path under /api/v1/cron and the vercel.json entry. */
  name: string;
  /** Vercel Cron / node-cron schedule (UTC). */
  schedule: string;
  /** WP that fills the area task(s). */
  owner: string;
  run(options?: PlatformCronRunOptions): Promise<PlatformCronReport>;
}

const STEP_RESERVE_MS = 2_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runStep(
  job: string,
  step: PlatformCronStep,
  brandId: BrandId,
  budget: Budget,
  now: Date,
): Promise<{ result: CronResult; failed: boolean }> {
  const brand = getBrand(brandId);
  if (step.markets && !step.markets.includes(brand.market)) return { result: { skipped: 'not_for_market' }, failed: false };
  if (budget.exhausted(STEP_RESERVE_MS)) return { result: { skipped: 'budget' }, failed: false };
  try {
    const result = await runWithBrand(brandId, () => step.task({ name: job, brand, budget, now }));
    return { result: result ?? {}, failed: false };
  } catch (err) {
    logger.error('ROBOAPPLY_CRON', `${job}/${step.name} threw`, { brand: brandId, error: errMessage(err) });
    return { result: { error: 'step_failed', message: errMessage(err) }, failed: true };
  }
}

function commonSkip(results: PlatformCronReport['results']): string | undefined {
  const reasons = new Set<string>();
  let ran = 0;
  for (const perStep of Object.values(results)) {
    for (const r of Object.values(perStep)) {
      if (r.skipped === 'not_for_market') continue;
      ran += 1;
      reasons.add(typeof r.skipped === 'string' ? r.skipped : '');
    }
  }
  if (ran === 0 || reasons.size !== 1) return undefined;
  const [only] = [...reasons];
  return only || undefined;
}

/**
 * A cron that runs `steps` for every served brand inside `runWithBrand`, then
 * the optional `platformSteps` once (housekeeping with no brand), all within
 * one budget. A step that throws is logged and reported; the others still run.
 */
export function brandCronJob(
  name: string,
  schedule: string,
  owner: string,
  steps: PlatformCronStep[],
  platformSteps: Array<{ name: string; run: (budget: Budget) => Promise<CronResult> }> = [],
): PlatformCronJob {
  return {
    name,
    schedule,
    owner,
    async run(options: PlatformCronRunOptions = {}): Promise<PlatformCronReport> {
      const clock = options.now ?? Date.now;
      const budget = createBudget(options.budgetMs ?? CRON_BUDGET_MS, clock);
      const now = new Date(clock());
      const results: PlatformCronReport['results'] = {};
      let failed = false;
      for (const brandId of options.brands ?? allowedBrands()) {
        const perStep: Record<string, CronResult> = {};
        for (const step of steps) {
          const r = await runStep(name, step, brandId, budget, now);
          perStep[step.name] = r.result;
          failed ||= r.failed;
        }
        results[brandId] = perStep;
      }
      if (platformSteps.length) {
        const perStep: Record<string, CronResult> = {};
        for (const step of platformSteps) {
          if (budget.exhausted(STEP_RESERVE_MS)) {
            perStep[step.name] = { skipped: 'budget' };
            continue;
          }
          try {
            perStep[step.name] = await step.run(budget);
          } catch (err) {
            failed = true;
            logger.error('ROBOAPPLY_CRON', `${name}/${step.name} threw`, { error: errMessage(err) });
            perStep[step.name] = { error: 'step_failed', message: errMessage(err) };
          }
        }
        results.platform = perStep;
      }
      const report: PlatformCronReport = { job: name, ok: !failed, results, ms: budget.elapsedMs() };
      const skipped = commonSkip(results);
      if (skipped) report.skipped = skipped;
      return report;
    },
  };
}

/** queue-drain: drains every registered worker kind for the served brands (items carry their brand). */
const queueDrainJob: PlatformCronJob = {
  name: 'queue-drain',
  schedule: '*/5 * * * *',
  owner: 'FND-3',
  async run(options: PlatformCronRunOptions = {}): Promise<PlatformCronReport> {
    const clock = options.now ?? Date.now;
    const started = clock();
    try {
      const result = await drain(null, { budgetMs: options.budgetMs ?? CRON_BUDGET_MS, brands: options.brands, now: clock });
      const report: PlatformCronReport = {
        job: 'queue-drain',
        ok: true,
        results: { platform: { drain: { ...result, processed: result.done } } },
        ms: clock() - started,
      };
      if (result.stoppedBy === 'no_handlers') report.skipped = 'no_handlers';
      return report;
    } catch (err) {
      logger.error('ROBOAPPLY_CRON', 'queue-drain threw', { error: errMessage(err) });
      return {
        job: 'queue-drain',
        ok: false,
        results: { platform: { drain: { error: 'step_failed', message: errMessage(err) } } },
        ms: clock() - started,
      };
    }
  },
};

// The hourly `reminders` runner (WP-39a) calls every registered producer for
// the brand (skipping producers not meant for its market), isolates failures,
// then drains `email.send` in the same tick. Wave 3 gate wiring (WP-39a
// request): the area producers are registered here by name; an area that
// registers itself must pass the same function reference (a different task
// under a taken name throws).
registerReminderProducer({ name: 'tracker', task: produceTrackerReminders });
registerReminderProducer({ name: 'agent', task: produceAgentReminders });
registerReminderProducer({ name: 'campus', task: produceCampusReminders, markets: ['cn'] });
// Wave 5 gate (WP-79 request): the winback email 30 days after a paid Stripe
// plan ended, marketing consent only (platform/billing/winback.ts).
registerReminderProducer({ name: 'winback', task: runWinbackSweep });

/** Every platform cron (TASK_PLAN.md §4.1.d). vercel.json must list each with the same schedule. */
export const PLATFORM_CRON_JOBS: readonly PlatformCronJob[] = [
  brandCronJob('jobs-plan', '0 2 * * *', 'WP-16b', [{ name: 'plan', task: runJobsPlan }]),
  brandCronJob('jobs-ingest', '*/10 * * * *', 'WP-16b', [{ name: 'ingest', task: runJobsIngest }]),
  queueDrainJob,
  brandCronJob(
    'jobs-maintain',
    '30 3 * * *',
    'WP-16b',
    [
      { name: 'maintain', task: runJobsMaintain },
      { name: 'toolsPurge', task: runToolsPurge },
      // Wave 5 gate (WP-74 request): the daily admin health email. A brand step,
      // so it reads yesterday's day counters before pruneRateCounters below
      // deletes them.
      { name: 'adminHealth', task: runAdminHealthEmail },
    ],
    [
      { name: 'pruneRateCounters', run: async () => ({ processed: (await pruneRateCounters()).deleted }) },
      // Wave 5 gate (WP-60, optional backup to the growth.referralSignalPrune
      // worker): invite risk signals older than 30 days, every brand.
      { name: 'pruneReferralSignals', run: async () => ({ processed: (await pruneReferralSignals()).deleted }) },
      { name: 'pruneWorkItems', run: async () => ({ processed: (await pruneWorkItems()).deleted }) },
      // §4.1.d: reservations stuck in `reserved` (a request that died between
      // reserve and commit/release) stop counting against the user's window.
      { name: 'releaseStaleCredits', run: async () => ({ processed: await creditService.releaseStale() }) },
    ],
  ),
  brandCronJob('score-precompute', '*/15 * * * *', 'WP-18', [{ name: 'precompute', task: runScorePrecompute }]),
  // visitor-alerts (WP-78, Wave 5 gate): logged-out alert digests and their
  // purge; runs in the same process as runJobAlerts, which installs the
  // email preference gate.
  brandCronJob('job-alerts', '*/15 * * * *', 'WP-39a', [
    { name: 'alerts', task: runJobAlerts },
    { name: 'visitor-alerts', task: runAnonAlertDigests },
  ]),
  // toolsPurge also runs hourly here (WP-57 request, Wave 4 gate) so a free-tool
  // result never outlives its published 24 h by more than an hour.
  brandCronJob('reminders', '0 * * * *', 'WP-39a', [
    { name: 'reminders', task: runReminders },
    { name: 'toolsPurge', task: runToolsPurge },
  ]),
  brandCronJob('lifecycle-emails', '15 * * * *', 'WP-39a', [{ name: 'lifecycle', task: runLifecycleEmails }]),
  brandCronJob('ready-weekly', '5 * * * *', 'WP-52', [{ name: 'readyWeekly', task: runReadyWeekly }]),
  brandCronJob('seo-rebuild', '0 4 * * *', 'WP-56', [{ name: 'seo', task: runSeoRebuild }]),
  brandCronJob('contacts-sync', '45 4 * * *', 'WP-54', [{ name: 'contacts', task: runContactsSync }]),
  brandCronJob('compliance-daily', '0 5 * * *', 'WP-13', [
    { name: 'compliance', task: runComplianceDaily },
    { name: 'interviewRetention', task: runInterviewRetention },
  ]),
];

function summarize(report: PlatformCronReport): Record<string, unknown> {
  return { ms: report.ms, ok: report.ok, skipped: report.skipped, results: report.results };
}

/** Run one platform cron and log what it did (used by the HTTP route and node-cron). */
export async function runPlatformCron(job: PlatformCronJob, options?: PlatformCronRunOptions): Promise<PlatformCronReport> {
  const report = await job.run(options);
  if (report.ok) logger.info('ROBOAPPLY_CRON', `${job.name} complete`, summarize(report));
  else logger.error('ROBOAPPLY_CRON', `${job.name} finished with errors`, summarize(report));
  return report;
}

for (const platformJob of PLATFORM_CRON_JOBS) {
  router.get(`/${platformJob.name}`, async (_req: Request, res: Response) => {
    const report = await runPlatformCron(platformJob);
    const body: Record<string, unknown> = { ok: report.ok, job: report.job, results: report.results, ms: report.ms };
    if (report.skipped) body.skipped = report.skipped;
    res.status(report.ok ? 200 : 500).json(body);
  });
}

export default router;
