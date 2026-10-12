#!/usr/bin/env node
// scripts/gen-cn-cronjobs.mjs — Kubernetes CronJobs for the mainland GoApply
// stack (CN-1), generated from vercel.json (WP-76; CN_TW_LAUNCH_PLAN.md
// WP-DEPLOY-CN, L-13).
//
// On Vercel, every entry in vercel.json `crons` is an HTTP GET to
// /api/v1/cron/<name> with `Authorization: Bearer $CRON_SECRET`. The mainland
// stack has no Vercel Cron, and the API container runs with
// ROBOAPPLY_CRON_DISABLED=true (no in-process node-cron), so each cron
// becomes one CronJob that makes the same authenticated call to the API
// Service from inside the cluster (deploy/cn/cron-call.mjs, shipped in the
// API image). This also brings the interview reconciler
// (/api/v1/cron/interview-cleanup) to the mainland, which the node-cron
// mirror lacks.
//
// Parity: __tests__/deploy/cronParity.test.ts fails when the committed
// deploy/cn/k8s/cronjobs.yaml differs from what this script renders from the
// current vercel.json. Every vercel.json cron is mirrored with the same
// schedule (UTC, as on Vercel), unless it is listed in EXCLUDED_CRONS with a
// reason.
//
//   node scripts/gen-cn-cronjobs.mjs            write deploy/cn/k8s/cronjobs.yaml
//   node scripts/gen-cn-cronjobs.mjs --check    exit 1 when the file is stale (CI)
//   node scripts/gen-cn-cronjobs.mjs --stdout   print instead of writing
//   --root <dir>                                 run against another checkout

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CRON_PATH_PREFIX = '/api/v1/cron/';
export const OUTPUT_PATH = 'deploy/cn/k8s/cronjobs.yaml';

/** In-cluster address of the API Service (deploy/cn/k8s/api.yaml). */
export const API_SERVICE_URL = 'http://api:4607';
/** Vercel's function limit for api/index.ts (vercel.json maxDuration: 300 s). */
export const CALL_TIMEOUT_SECONDS = 300;
/** Kubernetes object names are DNS labels; CronJob names are capped at 52. */
export const MAX_CRONJOB_NAME = 52;

/**
 * vercel.json crons that the mainland stack does NOT run, each with the
 * reason. A reason is required; an entry that is no longer in vercel.json is
 * reported as stale (harmless, but worth deleting).
 */
export const EXCLUDED_CRONS = Object.freeze({
  'daily-matcher':
    'V1 mission matcher that drafts applications for the retired auto-apply pipeline (D1); WP-75 removes it. GoApply never had V1 missions.',
  digest: 'V1 mission digest email (sends through offshore Resend); WP-75 removes it. GoApply has no V1 missions.',
  submitter: 'V1 auto-submit. D1: nothing submits an application on the user’s behalf; WP-75 removes it.',
  catchup: 'V1 auto-submit catch-up (D1); WP-75 removes it.',
  'billing-friday-nudge': 'Retired by WP-21a; WP-75 deletes the route and the vercel.json entry.',
});

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const FIELD_RE = /^[0-9*,/-]+$|^[A-Za-z]{3}(-[A-Za-z]{3})?$/;

/** A 5-field cron expression (Vercel's format; Kubernetes accepts the same). */
export function isCronSchedule(schedule) {
  if (typeof schedule !== 'string') return false;
  const fields = schedule.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => FIELD_RE.test(f));
}

export function cronJobName(name) {
  return `cron-${name}`;
}

/**
 * Split vercel.json crons into mirrored jobs and skipped ones. Throws on an
 * entry this stack cannot mirror (wrong path prefix, bad name or schedule,
 * duplicate), so a malformed vercel.json never silently drops a job.
 */
export function planCronJobs(vercel, { excluded = EXCLUDED_CRONS } = {}) {
  const crons = Array.isArray(vercel?.crons) ? vercel.crons : null;
  if (!crons) throw new Error('vercel.json has no "crons" array');
  const problems = [];
  const jobs = [];
  const skipped = [];
  const seen = new Set();
  for (const [i, entry] of crons.entries()) {
    const path = entry?.path;
    const schedule = entry?.schedule;
    if (typeof path !== 'string' || !path.startsWith(CRON_PATH_PREFIX)) {
      problems.push(`crons[${i}]: path ${JSON.stringify(path)} is not under ${CRON_PATH_PREFIX}`);
      continue;
    }
    const name = path.slice(CRON_PATH_PREFIX.length);
    if (!NAME_RE.test(name)) {
      problems.push(`crons[${i}]: "${name}" is not a valid job name (lowercase letters, digits and dashes)`);
      continue;
    }
    if (cronJobName(name).length > MAX_CRONJOB_NAME) {
      problems.push(`crons[${i}]: CronJob name ${cronJobName(name)} is longer than ${MAX_CRONJOB_NAME} characters`);
      continue;
    }
    if (!isCronSchedule(schedule)) {
      problems.push(`crons[${i}]: schedule ${JSON.stringify(schedule)} for ${name} is not a 5-field cron expression`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`crons[${i}]: ${name} is listed twice`);
      continue;
    }
    seen.add(name);
    const reason = Object.prototype.hasOwnProperty.call(excluded, name) ? excluded[name] : undefined;
    if (reason !== undefined) {
      if (typeof reason !== 'string' || !reason.trim()) problems.push(`EXCLUDED_CRONS.${name} needs a reason`);
      skipped.push({ name, path, schedule, reason });
    } else {
      jobs.push({ name, path, schedule: schedule.trim().split(/\s+/).join(' '), k8sName: cronJobName(name) });
    }
  }
  if (problems.length) throw new Error(`Cannot generate CN CronJobs:\n  - ${problems.join('\n  - ')}`);
  const stale = Object.keys(excluded).filter((name) => !seen.has(name));
  return { jobs, skipped, stale };
}

function q(value) {
  return JSON.stringify(String(value));
}

function renderJob(job) {
  return [
    '---',
    'apiVersion: batch/v1',
    'kind: CronJob',
    'metadata:',
    `  name: ${job.k8sName}`,
    '  labels:',
    '    app.kubernetes.io/name: goapply-cron',
    '    app.kubernetes.io/part-of: goapply',
    `    goapply.top/cron: ${job.name}`,
    '  annotations:',
    `    goapply.top/vercel-path: ${q(job.path)}`,
    'spec:',
    `  schedule: ${q(job.schedule)}`,
    '  # Vercel Cron schedules are UTC; pin it so a cluster in Asia/Shanghai does not shift them.',
    '  timeZone: Etc/UTC',
    '  concurrencyPolicy: Forbid',
    '  startingDeadlineSeconds: 300',
    '  successfulJobsHistoryLimit: 1',
    '  failedJobsHistoryLimit: 3',
    '  jobTemplate:',
    '    spec:',
    '      # Vercel does not retry a failed cron call; neither do we (sweeps are idempotent per tick).',
    '      backoffLimit: 0',
    `      activeDeadlineSeconds: ${CALL_TIMEOUT_SECONDS + 30}`,
    '      ttlSecondsAfterFinished: 86400',
    '      template:',
    '        metadata:',
    '          labels:',
    '            app.kubernetes.io/name: goapply-cron',
    '            app.kubernetes.io/part-of: goapply',
    `            goapply.top/cron: ${job.name}`,
    '        spec:',
    '          restartPolicy: Never',
    '          automountServiceAccountToken: false',
    '          imagePullSecrets:',
    '            - name: acr-pull',
    '          securityContext:',
    '            runAsNonRoot: true',
    '            runAsUser: 1000',
    '          containers:',
    '            - name: caller',
    '              # The API image ships deploy/cn/cron-call.mjs; kustomize rewrites the name to the ACR image.',
    '              image: goapply-api',
    `              command: ["node", "deploy/cn/cron-call.mjs", ${q(job.path)}]`,
    '              env:',
    '                - name: CRON_API_URL',
    `                  value: ${q(API_SERVICE_URL)}`,
    '                - name: CRON_TIMEOUT_MS',
    `                  value: ${q(CALL_TIMEOUT_SECONDS * 1000)}`,
    '                - name: CRON_SECRET',
    '                  valueFrom:',
    '                    secretKeyRef:',
    '                      name: goapply-api-env',
    '                      key: CRON_SECRET',
    '              resources:',
    '                requests: { cpu: 10m, memory: 64Mi }',
    '                limits: { memory: 128Mi }',
    '              securityContext:',
    '                allowPrivilegeEscalation: false',
    '                readOnlyRootFilesystem: true',
    '                capabilities: { drop: ["ALL"] }',
  ].join('\n');
}

/** The full deploy/cn/k8s/cronjobs.yaml text for a parsed vercel.json. */
export function renderCronJobsYaml(vercel, options = {}) {
  const plan = planCronJobs(vercel, options);
  const header = [
    '# GENERATED by scripts/gen-cn-cronjobs.mjs from vercel.json — do not edit by hand.',
    '# Regenerate: node scripts/gen-cn-cronjobs.mjs   (parity test: __tests__/deploy/cronParity.test.ts)',
    '#',
    '# One CronJob per vercel.json cron: an authenticated GET to the API Service, exactly what',
    '# Vercel Cron sends. Not mirrored on the mainland stack (scripts/gen-cn-cronjobs.mjs EXCLUDED_CRONS):',
    ...(plan.skipped.length
      ? plan.skipped.map((s) => `#   - ${s.path} (${s.schedule}): ${s.reason}`)
      : ['#   (none)']),
  ];
  return `${header.join('\n')}\n${plan.jobs.map(renderJob).join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { check: false, stdout: false, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--stdout') args.stdout = true;
    else if (a === '--root') args.root = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** CLI entry. Returns the exit code (tests call it with `--root`). */
export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.error(err.message);
    return 2;
  }
  const root = resolve(args.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  let rendered;
  try {
    rendered = renderCronJobsYaml(vercel);
  } catch (err) {
    io.error(err.message);
    return 1;
  }
  const { stale } = planCronJobs(vercel);
  for (const name of stale) io.error(`note: EXCLUDED_CRONS.${name} is no longer in vercel.json; delete the entry.`);
  const out = join(root, OUTPUT_PATH);
  if (args.stdout) {
    io.log(rendered);
    return 0;
  }
  if (args.check) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : null;
    if (current !== rendered) {
      io.error(`${OUTPUT_PATH} is out of date with vercel.json. Run: node scripts/gen-cn-cronjobs.mjs`);
      return 1;
    }
    io.log(`${OUTPUT_PATH} matches vercel.json.`);
    return 0;
  }
  writeFileSync(out, rendered);
  io.log(`Wrote ${OUTPUT_PATH}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
