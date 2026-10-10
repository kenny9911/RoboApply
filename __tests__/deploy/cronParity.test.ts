// @vitest-environment node
//
// WP-76: the mainland CronJobs (deploy/cn/k8s/cronjobs.yaml) are generated from
// vercel.json by scripts/gen-cn-cronjobs.mjs. This test fails on any drift: a
// cron added to, removed from or rescheduled in vercel.json without
// regenerating the file, or a hand edit of the generated file.
// Fix: `node scripts/gen-cn-cronjobs.mjs`.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as gen from '../../scripts/gen-cn-cronjobs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERCEL_PATH = join(ROOT, 'vercel.json');
const OUTPUT = join(ROOT, gen.OUTPUT_PATH as string);

type Cron = { path: string; schedule: string };
const vercel = JSON.parse(readFileSync(VERCEL_PATH, 'utf8')) as { crons: Cron[] };
const committed = readFileSync(OUTPUT, 'utf8');

/** Parse the generated YAML into one record per CronJob (the file's shape is fixed by the generator). */
function cronJobsIn(yaml: string) {
  return yaml
    .split(/^---$/m)
    .slice(1)
    .map((doc) => ({
      name: /^ {2}name: (\S+)$/m.exec(doc)?.[1],
      kind: /^kind: (\S+)$/m.exec(doc)?.[1],
      path: /goapply\.top\/vercel-path: "([^"]+)"/.exec(doc)?.[1],
      schedule: /^ {2}schedule: "([^"]+)"$/m.exec(doc)?.[1],
      timeZone: /^ {2}timeZone: (\S+)$/m.exec(doc)?.[1],
      concurrency: /^ {2}concurrencyPolicy: (\S+)$/m.exec(doc)?.[1],
      command: /command: (\[.*\])$/m.exec(doc)?.[1],
      doc,
    }));
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway checkout holding vercel.json and the committed CronJobs file. */
function checkout(vercelJson: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cn-cron-'));
  tmpRoots.push(dir);
  writeFileSync(join(dir, 'vercel.json'), JSON.stringify(vercelJson, null, 2));
  mkdirSync(join(dir, dirname(gen.OUTPUT_PATH)), { recursive: true });
  copyFileSync(OUTPUT, join(dir, gen.OUTPUT_PATH));
  return dir;
}

const quiet = { log: () => {}, error: () => {} };

describe('deploy/cn/k8s/cronjobs.yaml ↔ vercel.json', () => {
  it('is exactly what the generator renders from the current vercel.json', () => {
    expect(committed, 'stale: run `node scripts/gen-cn-cronjobs.mjs`').toBe(gen.renderCronJobsYaml(vercel));
  });

  it('mirrors every vercel.json cron with the same schedule, or lists it as excluded with a reason', () => {
    const jobs = new Map(cronJobsIn(committed).map((j) => [j.path, j.schedule]));
    for (const { path, schedule } of vercel.crons) {
      const name = path.slice(gen.CRON_PATH_PREFIX.length);
      const reason = (gen.EXCLUDED_CRONS as Record<string, string>)[name];
      if (reason !== undefined) {
        expect(reason.trim().length, `${name} needs a reason`).toBeGreaterThan(20);
        expect(jobs.has(path), `${name} is excluded but still generated`).toBe(false);
        expect(committed).toContain(`#   - ${path} (${schedule}): `);
      } else {
        expect(jobs.get(path), `${path} is missing from cronjobs.yaml`).toBe(schedule);
      }
    }
  });

  it('has no CronJob without a vercel.json entry', () => {
    const vercelPaths = new Set(vercel.crons.map((c) => c.path));
    const jobs = cronJobsIn(committed);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(vercelPaths.has(job.path!), `${job.name} has no vercel.json entry`).toBe(true);
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
  });

  it('calls the API exactly as Vercel Cron does, on UTC, without overlap or retries', () => {
    for (const job of cronJobsIn(committed)) {
      expect(job.kind).toBe('CronJob');
      expect(job.name).toBe(`cron-${job.path!.slice(gen.CRON_PATH_PREFIX.length)}`);
      expect(job.name!.length).toBeLessThanOrEqual(52);
      expect(job.timeZone).toBe('Etc/UTC');
      expect(job.concurrency).toBe('Forbid');
      expect(JSON.parse(job.command!)).toEqual(['node', 'deploy/cn/cron-call.mjs', job.path]);
      expect(job.doc).toContain('backoffLimit: 0');
      expect(job.doc).toMatch(/name: CRON_API_URL\n\s+value: "http:\/\/api:4607"/);
      // The secret comes from the API's own Secret, never from the file.
      expect(job.doc).toMatch(/name: CRON_SECRET\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: goapply-api-env\n\s+key: CRON_SECRET/);
      expect(job.doc).toContain('image: goapply-api');
    }
  });

  it('never schedules the V1 auto-submit sweeps on the mainland (D1)', () => {
    const paths = cronJobsIn(committed).map((j) => j.path);
    for (const name of ['submitter', 'catchup', 'daily-matcher']) {
      expect(paths).not.toContain(`/api/v1/cron/${name}`);
      expect(gen.EXCLUDED_CRONS).toHaveProperty(name);
    }
  });

  it('brings the interview reconciler and every platform cron to the mainland', () => {
    const paths = cronJobsIn(committed).map((j) => j.path);
    expect(paths).toContain('/api/v1/cron/interview-cleanup');
    for (const name of ['queue-drain', 'jobs-ingest', 'reminders', 'compliance-daily']) {
      expect(paths).toContain(`/api/v1/cron/${name}`);
    }
  });
});

describe('drift detection (gen-cn-cronjobs.mjs --check)', () => {
  it('passes on an unchanged checkout', () => {
    expect(gen.main(['--check', '--root', checkout(vercel)], quiet)).toBe(0);
  });

  it('fails when vercel.json gains a cron', () => {
    const added = { ...vercel, crons: [...vercel.crons, { path: '/api/v1/cron/new-sweep', schedule: '*/30 * * * *' }] };
    expect(gen.main(['--check', '--root', checkout(added)], quiet)).toBe(1);
    expect(gen.renderCronJobsYaml(added)).toContain('name: cron-new-sweep');
  });

  it('fails when a schedule changes', () => {
    const target = vercel.crons.find((c) => c.path.endsWith('/queue-drain'))!;
    const changed = { ...vercel, crons: vercel.crons.map((c) => (c === target ? { ...c, schedule: '*/7 * * * *' } : c)) };
    expect(gen.main(['--check', '--root', checkout(changed)], quiet)).toBe(1);
  });

  it('fails when a cron is removed', () => {
    const removed = { ...vercel, crons: vercel.crons.filter((c) => !c.path.endsWith('/interview-cleanup')) };
    expect(gen.main(['--check', '--root', checkout(removed)], quiet)).toBe(1);
  });

  it('writes the file and then passes the check', () => {
    const dir = checkout({ crons: [{ path: '/api/v1/cron/queue-drain', schedule: '*/5 * * * *' }] });
    expect(gen.main(['--check', '--root', dir], quiet)).toBe(1);
    expect(gen.main(['--root', dir], quiet)).toBe(0);
    expect(gen.main(['--check', '--root', dir], quiet)).toBe(0);
    expect(readFileSync(join(dir, gen.OUTPUT_PATH), 'utf8')).toContain('name: cron-queue-drain');
  });
});

describe('planCronJobs', () => {
  it('rejects entries it cannot mirror instead of dropping them', () => {
    expect(() => gen.planCronJobs({ crons: [{ path: '/api/other/x', schedule: '0 * * * *' }] })).toThrow(/not under/);
    expect(() => gen.planCronJobs({ crons: [{ path: '/api/v1/cron/x', schedule: 'hourly' }] })).toThrow(/5-field/);
    expect(() => gen.planCronJobs({ crons: [{ path: '/api/v1/cron/Bad_Name', schedule: '0 * * * *' }] })).toThrow(/valid job name/);
    expect(() =>
      gen.planCronJobs({
        crons: [
          { path: '/api/v1/cron/x', schedule: '0 * * * *' },
          { path: '/api/v1/cron/x', schedule: '5 * * * *' },
        ],
      }),
    ).toThrow(/twice/);
    expect(() => gen.planCronJobs({ crons: [{ path: `/api/v1/cron/${'a'.repeat(60)}`, schedule: '0 * * * *' }] })).toThrow(/longer/);
    expect(() => gen.planCronJobs({})).toThrow(/crons/);
  });

  it('requires a reason for every exclusion and reports stale ones', () => {
    expect(() =>
      gen.planCronJobs({ crons: [{ path: '/api/v1/cron/x', schedule: '0 * * * *' }] }, { excluded: { x: ' ' } }),
    ).toThrow(/needs a reason/);
    const plan = gen.planCronJobs({ crons: [{ path: '/api/v1/cron/x', schedule: '0 * * * *' }] }, { excluded: { gone: 'retired' } });
    expect(plan.stale).toEqual(['gone']);
    expect(plan.jobs.map((j: { name: string }) => j.name)).toEqual(['x']);
  });

  it('accepts the cron syntax vercel.json uses', () => {
    for (const s of ['*/15 9-15 * * *', '0 16 * * 5', '30 3 * * *', '0 4 * * MON-FRI']) expect(gen.isCronSchedule(s), s).toBe(true);
    for (const s of ['* * * *', '@daily', '0 0 * * * *', '']) expect(gen.isCronSchedule(s), s).toBe(false);
  });
});
