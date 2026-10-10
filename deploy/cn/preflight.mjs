#!/usr/bin/env node
// deploy/cn/preflight.mjs — mainland (CN-1) readiness check for the API
// container (WP-76). Runs as the API Deployment's initContainer, and by hand
// before a first deploy:
//
//   docker run --rm --env-file deploy/cn/.env.cn <api image> node deploy/cn/preflight.mjs
//
// It refuses (exit 1) when the API would boot in a state the mainland stack
// must not run in. On top of the boot-time residency assertions the API
// already makes (server/src/platform/residency/startupAssertions.ts, WP-15),
// it requires:
//   - DEPLOY_REGION=cn-mainland (otherwise the residency checks assert nothing);
//   - content safety READY for CN-1: Aliyun Green with credentials and a
//     mainland endpoint (`contentSafetyReadiness().cn1Ready`, WP-24), not just
//     the provider name the boot check looks at;
//   - CRON_SECRET (the CronJobs authenticate with it);
//   - ROBOAPPLY_CRON_DISABLED=true (the CronJobs replace node-cron; both on
//     would run every sweep twice).
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
 * @returns {{ ok: boolean, failures: Array<{code: string, message: string}>, warnings: string[] }}
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
  failures.push(...residency.failures.map((f) => ({ code: f.code, message: f.message })));
  warnings.push(...residency.warnings);

  const safety = contentSafetyReadiness(env);
  if (!safety.cn1Ready) {
    const detail = safety.problems.length ? ` Problems: ${safety.problems.join('; ')}.` : '';
    failures.push({
      code: 'content_safety_not_cn1_ready',
      message: `Content safety is not ready for CN-1 (provider ${safety.provider}): Aliyun Green with ALIYUN_GREEN_ACCESS_KEY_ID / ALIYUN_GREEN_ACCESS_KEY_SECRET and a mainland region is required.${detail}`,
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

  return { ok: failures.length === 0, failures, warnings };
}

export function formatReport(report) {
  const lines = [report.ok ? 'CN-1 preflight: OK' : 'CN-1 preflight: REFUSED'];
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
