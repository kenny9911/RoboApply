// @vitest-environment node
//
// FND-3: every area `workers.ts` / `cron.ts` listed in TASK_PLAN.md §4.1.c
// exists and has the agreed shape (exported names, valid and unique kinds).
// Whether an area is still a stub is NOT asserted, so an owner filling its
// workers.ts / cron.ts never has to edit this shared file.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/prisma.js', () => ({ default: {} }));

import { assertValidKind, type CronTask, type WorkerDefinition } from '../platform/queue/index.js';

const WORKERS: Record<string, () => Promise<Record<string, unknown>>> = {
  'jobs/ingest': () => import('../features/jobs/ingest/workers.js'),
  'jobs/enrich': () => import('../features/jobs/enrich/workers.js'),
  match: () => import('../features/match/workers.js'),
  agent: () => import('../features/agent/workers.js'),
  seo: () => import('../features/seo/workers.js'),
  compliance: () => import('../features/compliance/workers.js'),
  'cn/jobs': () => import('../features/cn/jobs/workers.js'),
  resume: () => import('../features/resume/workers.js'),
  notifications: () => import('../features/notifications/workers.js'),
  onboarding: () => import('../features/onboarding/workers.js'),
  push: () => import('../features/push/workers.js'),
  extension: () => import('../features/extension/workers.js'),
  copilot: () => import('../features/copilot/workers.js'),
  growth: () => import('../features/growth/workers.js'),
};

const CRONS: Record<string, [() => Promise<Record<string, unknown>>, string[]]> = {
  'jobs/ingest': [() => import('../features/jobs/ingest/cron.js'), ['runJobsPlan', 'runJobsIngest', 'runJobsMaintain']],
  match: [() => import('../features/match/cron.js'), ['runScorePrecompute']],
  alerts: [() => import('../features/alerts/cron.js'), ['runJobAlerts']],
  lifecycle: [() => import('../features/lifecycle/cron.js'), ['runLifecycleEmails']],
  tracker: [() => import('../features/tracker/cron.js'), ['produceReminders']],
  agent: [() => import('../features/agent/cron.js'), ['runReadyWeekly', 'produceReminders']],
  seo: [() => import('../features/seo/cron.js'), ['runSeoRebuild']],
  compliance: [() => import('../features/compliance/cron.js'), ['runComplianceDaily']],
  'cn/campus': [() => import('../features/cn/campus/cron.js'), ['produceReminders']],
  tools: [() => import('../features/tools/cron.js'), ['runToolsPurge']],
  network: [() => import('../features/network/cron.js'), ['runContactsSync']],
  interview: [() => import('../features/interview/cron.js'), ['runInterviewRetention']],
};

describe('area workers.ts stubs', () => {
  it.each(Object.keys(WORKERS))('%s exports a workers list and valid kinds; every worker handles a declared kind', async (area) => {
    const mod = await WORKERS[area]!();
    expect(Array.isArray(mod.workers)).toBe(true);
    const kindsExport = Object.entries(mod).find(([k]) => k.endsWith('_WORK_KINDS'));
    expect(kindsExport, `${area} declares its kinds`).toBeDefined();
    const declared = Object.values(kindsExport![1] as Record<string, string>);
    for (const kind of declared) expect(() => assertValidKind(kind)).not.toThrow();
    for (const w of mod.workers as WorkerDefinition[]) {
      expect(declared, `${area} worker ${w.kind}`).toContain(w.kind);
      expect(typeof w.handler).toBe('function');
    }
  });

  it('no two areas claim the same kind; email.send and onboarding.match are where the plan puts them', async () => {
    const owner = new Map<string, string>();
    for (const [area, load] of Object.entries(WORKERS)) {
      const mod = await load();
      const kinds = Object.values(Object.entries(mod).find(([k]) => k.endsWith('_WORK_KINDS'))![1] as Record<string, string>);
      for (const k of kinds) {
        expect(owner.has(k), `${k} claimed by ${owner.get(k)} and ${area}`).toBe(false);
        owner.set(k, area);
      }
    }
    expect(owner.get('email.send')).toBe('notifications');
    expect(owner.get('onboarding.match')).toBe('onboarding');
  });
});

describe('area cron.ts', () => {
  it.each(Object.keys(CRONS))('%s exports its planned tasks', async (area) => {
    const [load, names] = CRONS[area]!;
    const mod = await load();
    for (const name of names) expect(typeof (mod[name] as CronTask), `${area}.${name}`).toBe('function');
  });
});
