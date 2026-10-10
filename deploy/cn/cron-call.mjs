#!/usr/bin/env node
// deploy/cn/cron-call.mjs — the command every mainland CronJob runs (WP-76).
//
// It makes the call Vercel Cron makes: `GET <CRON_API_URL><path>` with
// `Authorization: Bearer $CRON_SECRET`, and turns the answer into an exit
// code so a failed sweep shows up as a failed Job in the cluster.
//
//   node deploy/cn/cron-call.mjs /api/v1/cron/jobs-ingest
//
// Env: CRON_SECRET (required), CRON_API_URL (default http://api:4607, the API
// Service), CRON_TIMEOUT_MS (default 300000, Vercel's maxDuration for the API).
//
// Exit codes: 0 = 2xx · 1 = non-2xx, timeout or network error · 2 = bad
// invocation (no secret, bad path). The secret is never printed.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_API_URL = 'http://api:4607';
export const DEFAULT_TIMEOUT_MS = 300_000;
const PATH_RE = /^\/api\/v1\/cron\/[a-z0-9-]+$/;
const MAX_BODY_LOG = 2000;

/**
 * @param {{ path?: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *           log?: (line: string) => void, now?: () => number }} options
 * @returns {Promise<number>} the process exit code
 */
export async function callCron({ path, env = process.env, fetchImpl = fetch, log = console.log, now = Date.now } = {}) {
  if (!path || !PATH_RE.test(path)) {
    log(`cron-call: path must look like /api/v1/cron/<name> (got ${JSON.stringify(path ?? null)})`);
    return 2;
  }
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    log('cron-call: CRON_SECRET is not set; the API would answer 401.');
    return 2;
  }
  const base = (env.CRON_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, '');
  const parsedTimeout = Number(env.CRON_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const started = now();
  try {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}`, 'user-agent': 'goapply-cn-cronjob/1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => '');
    const ms = now() - started;
    const shown = body.length > MAX_BODY_LOG ? `${body.slice(0, MAX_BODY_LOG)}…` : body;
    log(`cron-call: ${path} answered ${res.status} in ${ms} ms ${shown}`.trimEnd());
    return res.status >= 200 && res.status < 300 ? 0 : 1;
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : String(err?.message ?? err);
    log(`cron-call: ${path} failed: ${reason}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await callCron({ path: process.argv[2] });
}
