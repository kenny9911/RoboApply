#!/usr/bin/env node
// deploy/cn/preflight.mjs — mainland readiness check for the API container
// (WP-76; D5 parity, GOAPPLY_PARITY_PLAN.md §3.6). Runs as the API
// Deployment's initContainer, and by hand before a first deploy:
//
//   docker run --rm --env-file deploy/cn/.env.cn <api image> node deploy/cn/preflight.mjs
//
// It mirrors the boot-time residency assertions the API makes
// (server/src/platform/residency/startupAssertions.ts) and adds the checks of
// the mainland kit itself.
//
// REFUSED (exit 1), always: the things the mainland kit cannot run without.
//   - DEPLOY_REGION=cn-mainland (otherwise the residency checks assert nothing);
//   - every residency FAILURE: an unknown region, a database that is not on
//     the CN allowlist, a deployment that would serve RoboApply;
//   - CRON_SECRET (the CronJobs authenticate with it);
//   - ROBOAPPLY_CRON_DISABLED=true (the CronJobs replace node-cron; both on
//     would run every sweep twice);
//   - VERCEL unset (the API would not listen).
//
// WARNED (exit 0), by default: a China-specific provider that is not set. The
// API then boots and GoApply runs on the shared stack for that part:
//   - no ICP number, no CN model route on the domestic allowlist, no bucket of
//     its own (CN_S3_*) or one that is not mainland storage, content safety
//     that is not Aliyun Green or not ready, email through Resend.
//
// With CN_RESIDENCY_STRICT=true every warning of that second list is a
// failure again (exit 1), and content safety must be READY for the mainland:
// Aliyun Green with credentials and a mainland endpoint
// (`contentSafetyReadiness().cn1Ready`, WP-24).
// It never prints secret values, only variable names and problem codes.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CN_MAINLAND = 'cn-mainland';

function set(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Pure check. `checkResidency` and `contentSafetyReadiness` are the server's
 * own functions (passed in so tests use the TypeScript sources and the image
 * uses server/dist).
 *
 * @returns {{ ok: boolean, strict: boolean, failures: Array<{code: string, message: string}>, warnings: string[] }}
 */
export function runPreflight({ env, checkResidency, contentSafetyReadiness }) {
  const failures = [];
  const warnings = [];

  if (set(env, 'DEPLOY_REGION') !== CN_MAINLAND) {
    failures.push({
      code: 'deploy_region_not_mainland',
      message: `DEPLOY_REGION must be ${CN_MAINLAND} on the mainland stack (got ${JSON.stringify(env.DEPLOY_REGION ?? null)}).`,
    });
  }

  const residency = checkResidency(env);
  // The strict mainland posture is the operator's explicit choice (CN_RESIDENCY_STRICT).
  const strict = residency.strict === true;
  const advisories = residency.advisories ?? [];
  failures.push(...residency.failures.map((f) => ({ code: f.code, message: f.message })));
  // Provider checks that did not pass: the API boots on the shared stack for that part.
  warnings.push(...advisories.map((a) => `[${a.code}] ${a.message}`));
  warnings.push(...residency.warnings);

  const safety = contentSafetyReadiness(env);
  const reported = (list) => list.some((f) => f.code === 'content_safety_not_ready');
  if (!safety.cn1Ready && strict && !reported(residency.failures)) {
    const detail = safety.problems.length ? ` Problems: ${safety.problems.join('; ')}.` : '';
    failures.push({
      code: 'content_safety_not_cn1_ready',
      message: `Content safety is not ready for the strict mainland posture (provider ${safety.provider}): Aliyun Green with ALIYUN_GREEN_ACCESS_KEY_ID / ALIYUN_GREEN_ACCESS_KEY_SECRET and a mainland region is required.${detail}`,
    });
  }

  if (!set(env, 'CRON_SECRET')) {
    failures.push({ code: 'cron_secret_missing', message: 'CRON_SECRET is not set; every CronJob call would be refused (401).' });
  }
  if ((set(env, 'ROBOAPPLY_CRON_DISABLED') ?? '').toLowerCase() !== 'true') {
    failures.push({
      code: 'node_cron_enabled',
      message: 'ROBOAPPLY_CRON_DISABLED must be true: the Kubernetes CronJobs run the sweeps, and node-cron would run each one again in every API pod.',
    });
  }
  if (set(env, 'VERCEL')) {
    failures.push({ code: 'vercel_env_set', message: 'VERCEL is set: the API would not listen (serverless mode). Remove it from the mainland env.' });
  }

  if (!set(env, 'INTERNAL_API_SECRET')) {
    warnings.push('INTERNAL_API_SECRET is not set: SEO revalidation (seo-rebuild → /api/revalidate) and per-visitor public API limits are off.');
  }
  if (!set(env, 'CN_CANONICAL_ORIGIN')) {
    warnings.push('CN_CANONICAL_ORIGIN is not set: links in emails and sitemaps use the registry default origin.');
  }

  return { ok: failures.length === 0, strict, failures, warnings };
}

export function formatReport(report) {
  const head = report.ok ? (report.warnings.length ? 'CN-1 preflight: OK, with warnings' : 'CN-1 preflight: OK') : 'CN-1 preflight: REFUSED';
  const lines = [head];
  for (const f of report.failures) lines.push(`  ✗ [${f.code}] ${f.message}`);
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  return lines.join('\n');
}

async function loadServerChecks() {
  // In the API image this file is /app/deploy/cn/preflight.mjs and the
  // compiled server is /app/server/dist.
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'dist');
  const residency = await import(pathToFileURL(join(dist, 'platform/residency/startupAssertions.js')).href);
  const safety = await import(pathToFileURL(join(dist, 'platform/llm/contentSafety/config.js')).href);
  return { checkResidency: residency.checkResidency, contentSafetyReadiness: safety.contentSafetyReadiness };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checks = await loadServerChecks();
  const report = runPreflight({ env: process.env, ...checks });
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
}
