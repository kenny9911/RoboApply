// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  pruneWorkItems: vi.fn(async () => ({ deleted: 3 })),
  pruneRateCounters: vi.fn(async () => ({ deleted: 7 })),
  reconcile: vi.fn(async () => ({ finalized: 0, expired: 0 })),
  releaseStale: vi.fn(async () => 2),
  coverLetterDelete: vi.fn(async (_args?: unknown) => ({ count: 4 })),
  accountPurge: vi.fn(async () => ({ scanned: 1, purged: 1 })),
  pruneReferralSignals: vi.fn(async () => ({ deleted: 5, nextAt: null })),
}));

// Area cron tasks are replaced by inert skips, so this file tests the cron
// framework (wiring, schedules, brand fan-out) and keeps passing when the
// owning WPs fill their cron.ts files (they test those themselves).
const skip = vi.hoisted(() => async () => ({ skipped: 'not_implemented' as const }));
vi.mock('../features/jobs/ingest/cron.js', () => ({ runJobsPlan: skip, runJobsIngest: skip, runJobsMaintain: skip }));
// The board sync (MKT-3D) is a platform step: it gets the cron's budget, not a brand.
const boards = vi.hoisted(() => ({ run: vi.fn(async (_budget: unknown): Promise<Record<string, unknown>> => ({ skipped: 'no_work' })) }));
vi.mock('../features/jobs/ingest/boards.js', () => ({ runJobsBoards: boards.run }));
vi.mock('../features/match/cron.js', () => ({ runScorePrecompute: skip }));
vi.mock('../features/alerts/cron.js', () => ({ runJobAlerts: skip }));
vi.mock('../features/lifecycle/cron.js', () => ({ runLifecycleEmails: skip }));
vi.mock('../features/tracker/cron.js', () => ({ produceReminders: skip }));
vi.mock('../features/agent/cron.js', () => ({ produceReminders: skip, runReadyWeekly: skip }));
vi.mock('../features/cn/campus/cron.js', () => ({ produceReminders: skip }));
vi.mock('../features/seo/cron.js', () => ({ runSeoRebuild: skip }));
vi.mock('../features/compliance/cron.js', () => ({ runComplianceDaily: skip }));
vi.mock('../features/interview/cron.js', () => ({ runInterviewRetention: skip }));
vi.mock('../features/tools/cron.js', () => ({ runToolsPurge: skip }));
vi.mock('../features/network/cron.js', () => ({ runContactsSync: skip }));
// Wave 5 gate wiring: admin health email, logged-out alerts, invite-signal prune, winback.
vi.mock('../features/admin/index.js', () => ({ runAdminHealthEmail: skip }));
vi.mock('../features/visitor/index.js', () => ({ runAnonAlertDigests: skip }));
vi.mock('../features/growth/index.js', () => ({ pruneReferralSignals: m.pruneReferralSignals }));
vi.mock('../platform/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/billing/index.js')>()),
  runWinbackSweep: skip,
}));
vi.mock('../platform/credits/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/credits/index.js')>()),
  creditService: { releaseStale: m.releaseStale },
}));

vi.mock('../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/prisma.js', () => ({ default: { roboApplyCoverLetterCache: { deleteMany: m.coverLetterDelete } } }));
vi.mock('../roboapply/services/RoboApplyBillingReminderService.js', () => ({
  runRenewalReminderSweep: vi.fn(async () => ({})),
}));
vi.mock('../roboapply/services/SeekerAccountPurgeService.js', () => ({ runAccountPurgeSweep: m.accountPurge }));
vi.mock('../interview-engine/sessions/InterviewSessionService.js', () => ({
  interviewSessionService: { reconcileExpiredSessions: m.reconcile },
}));
vi.mock('../platform/queue/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/queue/index.js')>()),
  pruneWorkItems: m.pruneWorkItems,
}));
vi.mock('../platform/ratelimit/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/ratelimit/index.js')>()),
  pruneRateCounters: m.pruneRateCounters,
}));

import cron from 'node-cron';
import router, { PLATFORM_CRON_JOBS, brandCronJob, purgeLegacyCoverLetterCache, runPlatformCron } from './handlers.js';
import { platformCronEnvName } from '../roboapply/schedulers/RoboApplyCronService.js';
import { getCurrentBrandId } from '../lib/requestContext.js';
import { startRouteHarness, type RouteHarness } from '../test/routeHarness.js';
import type { CronTask } from '../platform/queue/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };

const SECRET = 'cron-test-secret';
const LEGACY = ['billing-renewal-reminder', 'account-purge', 'interview-cleanup'];
// The V1 auto-apply crons and the retired Friday nudge (WP-75, ARCH §10.6 step 6).
const REMOVED = ['daily-matcher', 'digest', 'submitter', 'catchup', 'cache-cleanup', 'billing-friday-nudge'];
const PLANNED = [
  ['jobs-plan', '0 2 * * *'],
  ['jobs-ingest', '*/10 * * * *'],
  ['jobs-boards', '*/5 * * * *'],
  ['queue-drain', '*/5 * * * *'],
  ['jobs-maintain', '30 3 * * *'],
  ['score-precompute', '*/15 * * * *'],
  ['job-alerts', '*/15 * * * *'],
  ['reminders', '0 * * * *'],
  ['lifecycle-emails', '15 * * * *'],
  ['ready-weekly', '5 * * * *'],
  ['seo-rebuild', '0 4 * * *'],
  ['contacts-sync', '45 4 * * *'],
  ['compliance-daily', '0 5 * * *'],
];

describe('cron set (TASK_PLAN.md §4.1.d)', () => {
  it('declares every planned platform cron with its schedule', () => {
    expect(PLATFORM_CRON_JOBS.map((j) => [j.name, j.schedule])).toEqual(PLANNED);
  });

  it('vercel.json lists every platform cron with the same schedule and keeps every existing entry', () => {
    const byPath = new Map(vercel.crons.map((c) => [c.path, c.schedule]));
    for (const job of PLATFORM_CRON_JOBS) expect(byPath.get(`/api/v1/cron/${job.name}`), job.name).toBe(job.schedule);
    for (const name of LEGACY) expect(byPath.has(`/api/v1/cron/${name}`), name).toBe(true);
    expect(vercel.crons).toHaveLength(LEGACY.length + PLANNED.length);
  });

  it('vercel.json no longer schedules the V1 auto-apply crons or the Friday nudge (WP-75)', () => {
    const paths = new Set(vercel.crons.map((c) => c.path));
    for (const name of REMOVED) expect(paths.has(`/api/v1/cron/${name}`), name).toBe(false);
  });

  it('every schedule is valid for node-cron, with a per-job env override name', () => {
    for (const job of PLATFORM_CRON_JOBS) expect(cron.validate(job.schedule), job.name).toBe(true);
    expect(platformCronEnvName('queue-drain')).toBe('ROBOAPPLY_QUEUE_DRAIN_CRON');
    expect(platformCronEnvName('compliance-daily')).toBe('ROBOAPPLY_COMPLIANCE_DAILY_CRON');
  });
});

describe('cron routes over HTTP', () => {
  let h: RouteHarness;
  const saved = process.env.CRON_SECRET;
  beforeAll(async () => {
    process.env.CRON_SECRET = SECRET;
    h = await startRouteHarness({ mounts: [['/api/v1/cron', router]] });
  });
  afterAll(async () => {
    await h.close();
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });
  const auth = { headers: { authorization: `Bearer ${SECRET}` } };

  it('rejects calls without the CRON_SECRET bearer', async () => {
    expect((await h.request('GET', '/api/v1/cron/queue-drain')).status).toBe(401);
    expect((await h.request('GET', '/api/v1/cron/queue-drain', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  // `reminders` goes through the WP-39a runner, which reports no_work (its own test below).
  it.each(PLANNED.filter(([n]) => n !== 'queue-drain' && n !== 'jobs-maintain' && n !== 'reminders' && n !== 'jobs-boards').map(([n]) => n))(
    '%s answers 200 {skipped: not_implemented} in under 2 s',
    async (name) => {
      const started = Date.now();
      const res = await h.request<{ ok: boolean; job: string; skipped: string; results: Record<string, unknown> }>('GET', `/api/v1/cron/${name}`, auth);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, job: name, skipped: 'not_implemented' });
      expect(Object.keys(res.body.results).sort()).toEqual(['goapply', 'roboapply']);
    },
  );

  it('jobs-boards (MKT-3D): the board sync runs once per call as a platform step, not once per brand, and gets the budget', async () => {
    boards.run.mockClear();
    boards.run.mockResolvedValueOnce({ processed: 3, boards: 3, inserted: 12 });
    const res = await h.request<{ ok: boolean; job: string; skipped?: string; results: Record<string, Record<string, unknown>> }>('GET', '/api/v1/cron/jobs-boards', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, job: 'jobs-boards' });
    expect(res.body.skipped).toBeUndefined();
    // One board feeds both brands: no brand step, one platform step.
    expect(res.body.results).toEqual({ roboapply: {}, goapply: {}, platform: { boards: { processed: 3, boards: 3, inserted: 12 } } });
    expect(boards.run).toHaveBeenCalledOnce();
    const budget = boards.run.mock.calls[0]![0] as { remainingMs(): number; exhausted(reserve?: number): boolean };
    expect(budget.remainingMs()).toBeGreaterThan(200_000);
    expect(budget.exhausted(20_000)).toBe(false);
  });

  it('jobs-boards reports skipped with the kill switch on, and no_work when nothing is due', async () => {
    boards.run.mockResolvedValueOnce({ skipped: 'kill_switch' });
    const off = await h.request<{ ok: boolean; skipped?: string }>('GET', '/api/v1/cron/jobs-boards', auth);
    expect(off.body).toMatchObject({ ok: true, skipped: 'kill_switch' });
    const idle = await h.request<{ ok: boolean; skipped?: string }>('GET', '/api/v1/cron/jobs-boards', auth);
    expect(idle.body).toMatchObject({ ok: true, skipped: 'no_work' });
  });

  it('jobs-boards answers 500 and says so when the sync throws (a database failure)', async () => {
    boards.run.mockRejectedValueOnce(new Error('db down'));
    const res = await h.request<{ ok: boolean; results: Record<string, Record<string, { error?: string }>> }>('GET', '/api/v1/cron/jobs-boards', auth);
    expect(res.status).toBe(500);
    expect(res.body.results.platform!.boards).toMatchObject({ error: 'step_failed' });
  });

  it('queue-drain returns at once with no workers registered', async () => {
    const res = await h.request<{ ok: boolean; skipped: string; results: { platform: { drain: { stoppedBy: string } } } }>(
      'GET',
      '/api/v1/cron/queue-drain',
      auth,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: 'no_handlers' });
    expect(res.body.results.platform.drain.stoppedBy).toBe('no_handlers');
  });

  it('jobs-maintain runs the area tasks per brand and the platform housekeeping once', async () => {
    const res = await h.request<{ ok: boolean; results: Record<string, Record<string, unknown>> }>('GET', '/api/v1/cron/jobs-maintain', auth);
    expect(res.status).toBe(200);
    expect(res.body.results.roboapply).toEqual({ maintain: { skipped: 'not_implemented' }, toolsPurge: { skipped: 'not_implemented' }, adminHealth: { skipped: 'not_implemented' } });
    expect(res.body.results.platform).toEqual({
      pruneRateCounters: { processed: 7 },
      pruneReferralSignals: { processed: 5 },
      pruneWorkItems: { processed: 3 },
      releaseStaleCredits: { processed: 2 },
    });
    expect(m.pruneReferralSignals).toHaveBeenCalledOnce();
    expect(m.pruneRateCounters).toHaveBeenCalledOnce();
    expect(m.pruneWorkItems).toHaveBeenCalledOnce();
    // §4.1.d: stale credit reservations are released once per run (no brand).
    expect(m.releaseStale).toHaveBeenCalledOnce();
  });

  it('reminders run the registered producers per brand through the WP-39a runner; campus only on the cn market', async () => {
    type Run = { reminders: { producers?: Record<string, { skipped?: string }> }; toolsPurge?: { skipped?: string } };
    const res = await h.request<{ ok: boolean; skipped?: string; results: Record<string, Run> }>('GET', '/api/v1/cron/reminders', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    // WP-57's 24 h free-tool purge also runs hourly here (Wave 4 gate), per brand.
    expect(res.body.results.roboapply!.toolsPurge).toEqual({ skipped: 'not_implemented' });
    expect(res.body.results.goapply!.toolsPurge).toEqual({ skipped: 'not_implemented' });
    expect(Object.keys(res.body.results.roboapply!.reminders.producers ?? {})).toEqual(['tracker', 'agent', 'winback']);
    expect(res.body.results.goapply!.reminders.producers).toEqual({
      tracker: { skipped: 'not_implemented' },
      agent: { skipped: 'not_implemented' },
      campus: { skipped: 'not_implemented' },
      winback: { skipped: 'not_implemented' },
    });
  });

  it.each(REMOVED)('the removed V1 cron /%s is no longer served', async (name) => {
    const res = await h.request('GET', `/api/v1/cron/${name}`, auth);
    expect(res.status).toBe(404);
  });

  it('the existing crons are still served', async () => {
    const res = await h.request<{ ok: boolean; job: string }>('GET', '/api/v1/cron/interview-cleanup', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, job: 'interview-cleanup' });
    expect(m.reconcile).toHaveBeenCalled();
  });

  it('account-purge also clears every row of the dead V1 cover-letter cache (WP-75 review)', async () => {
    m.coverLetterDelete.mockClear();
    const res = await h.request<{ ok: boolean; job: string; result: Record<string, unknown> }>('GET', '/api/v1/cron/account-purge', auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, job: 'account-purge', result: { purged: 1, legacyCoverLetterCache: { deleted: 4 } } });
    expect(m.coverLetterDelete).toHaveBeenCalledWith({});
    expect(m.accountPurge).toHaveBeenCalled();
  });
});

describe('purgeLegacyCoverLetterCache', () => {
  it('never throws: a database error is logged and reported as null', async () => {
    m.coverLetterDelete.mockRejectedValueOnce(new Error('db down'));
    await expect(purgeLegacyCoverLetterCache()).resolves.toBeNull();
  });
});

describe('brandCronJob', () => {
  it('runs every step inside runWithBrand for each served brand and isolates failures', async () => {
    const seen: string[] = [];
    const record: CronTask = async (ctx) => {
      seen.push(`${ctx.name}:${ctx.brand.id}:${getCurrentBrandId()}`);
      return { processed: 1 };
    };
    const boom: CronTask = async () => {
      throw new Error('provider down');
    };
    const job = brandCronJob('test-job', '* * * * *', 'TEST', [
      { name: 'a', task: record },
      { name: 'b', task: boom },
      { name: 'c', task: record, markets: ['cn'] },
    ]);
    const report = await runPlatformCron(job, { brands: ['roboapply', 'goapply'] });
    expect(seen).toEqual(['test-job:roboapply:roboapply', 'test-job:goapply:goapply', 'test-job:goapply:goapply']);
    expect(report.ok).toBe(false);
    expect(report.results.roboapply).toEqual({
      a: { processed: 1 },
      b: { error: 'step_failed', message: 'provider down' },
      c: { skipped: 'not_for_market' },
    });
    expect(report.skipped).toBeUndefined();
  });

  it('runs only the brands this deployment serves', async () => {
    const seen: string[] = [];
    const job = brandCronJob('x', '* * * * *', 'TEST', [{ name: 'a', task: async (ctx) => (seen.push(ctx.brand.id), { skipped: 'no_work' }) }]);
    const report = await job.run({ brands: ['goapply'] });
    expect(seen).toEqual(['goapply']);
    expect(report).toMatchObject({ ok: true, skipped: 'no_work' });
  });

  it('stops starting steps when the budget is spent', async () => {
    let t = 0;
    const slow: CronTask = async () => {
      t += 239_000;
      return { processed: 1 };
    };
    const job = brandCronJob('slow', '* * * * *', 'TEST', [
      { name: 'a', task: slow },
      { name: 'b', task: slow },
    ]);
    const report = await job.run({ brands: ['roboapply'], now: () => t });
    expect(report.results.roboapply).toEqual({ a: { processed: 1 }, b: { skipped: 'budget' } });
  });

  it('gives each brand its own slice: a first brand that works to the end of its budget leaves the second brand half (D5)', async () => {
    // What a jobs-ingest tick does while a cursor source keeps answering "more" (the 台灣就業通 sweep):
    // it runs until 5 s of the budget it was handed are left.
    let t = 0;
    const seen: Array<{ brand: string; budgetMs: number }> = [];
    const greedy: CronTask = async (ctx) => {
      const mine = ctx.budget.remainingMs();
      seen.push({ brand: ctx.brand.id, budgetMs: mine });
      if (ctx.brand.id === 'roboapply') t += Math.max(0, mine - 5_000);
      return { processed: 1 };
    };
    const job = brandCronJob('greedy', '* * * * *', 'TEST', [{ name: 'ingest', task: greedy }]);
    const report = await job.run({ brands: ['roboapply', 'goapply'], now: () => t });
    expect(report.results.goapply).toEqual({ ingest: { processed: 1 } });
    expect(seen).toEqual([
      { brand: 'roboapply', budgetMs: 120_000 },
      // The rest: its own half plus the 5 s the first brand left.
      { brand: 'goapply', budgetMs: 125_000 },
    ]);
  });

  it('a brand with nothing to do hands its slice on, and a single brand gets the whole budget', async () => {
    let t = 0;
    const seen: Record<string, number> = {};
    const idle: CronTask = async (ctx) => {
      seen[ctx.brand.id] = ctx.budget.remainingMs();
      t += 100;
      return { skipped: 'no_work' };
    };
    await brandCronJob('idle', '* * * * *', 'TEST', [{ name: 'a', task: idle }]).run({ brands: ['roboapply', 'goapply'], now: () => t });
    expect(seen).toEqual({ roboapply: 120_000, goapply: 239_900 });
    t = 0;
    await brandCronJob('one', '* * * * *', 'TEST', [{ name: 'a', task: idle }]).run({ brands: ['goapply'], now: () => t });
    expect(seen.goapply).toBe(240_000);
  });
});
