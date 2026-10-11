#!/usr/bin/env node
// scripts/alipay-notify-preflight.mjs: does the host GoApply's Alipay notify
// goes to answer with OUR callback JSON? (requirement AL-8; cut-over checklist
// steps 2 and 5 of docs/jobright-clone/market/MARKET_STRATEGY.md section 5.3;
// runbook docs/jobright-clone/market/ALIPAY_CUTOVER.md).
//
//   node scripts/alipay-notify-preflight.mjs [--origin https://…]
//
// What it does: ONE GET to <origin>/api/v1/roboapply/billing/alipay/callback
// with no parameters, no order number and no secret, redirects not followed,
// 10 s limit. It creates nothing and is safe to run against production: the
// route refuses such a request before it opens the database (rule A6).
//
// Which host: --origin when given; otherwise the rule the server uses for a
// GoApply notify_url (`resolveAlipayNotifyOrigin` in
// server/src/platform/billing/origins.ts), read from the environment of THIS
// shell: CN_ALIPAY_NOTIFY_ORIGIN (a bare https origin), else CN_BACKEND_URL,
// else https://www.goapply.top. BACKEND_URL is never read. The deployment's
// own answer is its boot line "GoApply Alipay notify host: <host>"; pass that
// host with --origin when this shell does not hold the deployment's variables.
// A CN_ALIPAY_NOTIFY_ORIGIN in this shell that the server would ignore (not a
// bare https origin) is a FAIL before any request, with --origin too: a
// deployment that holds it sends the notify somewhere else than it says.
//
// What it prints: the host, what decided it, the HTTP status, and one result.
//
//   PASS                          403 { code: 40003 } with the X-RA-Brand
//                                 response header: the route of this code
//                                 answered and a callback secret is set there.
//   PASS-ROUTE / FAIL-SECRET      503 { code: 50003 }: the route is reached,
//                                 ALIPAY_CALLBACK_SECRET is not set there.
//   PASS-ROUTE / FAIL-HANDLER     the callback route answered, but not as this
//                                 code does: 400 { code: 40001 } (this code
//                                 asks for the secret first; the older
//                                 production handler answers 40001 when no
//                                 secret is set on its host), or a 403 without
//                                 the X-RA-Brand header this code puts on
//                                 every response.
//   FAIL                          401 (deployment protection), 404, an HTML
//                                 page, any redirect, a timeout, anything else.
//
// What PASS does not prove: that the host uses the same database, or holds the
// same callback secret, as the deployment that creates the orders. A request
// that carries neither an order number nor the secret cannot show that; the
// supervised order of the runbook does.
//
// Exit code: 0 only on PASS; 1 on every other result; 2 on a usage error.
// The callback secret is never read, sent or printed, and a value that may
// hold one (a pasted notify URL) is never echoed.
//
// Plain Node (24 or newer), no dependency, no import from the server: the
// resolver below mirrors the server's, and
// __tests__/scripts/alipayNotifyPreflight.test.ts compares the two.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The public callback route (server: `ALIPAY_CALLBACK_PATH` in platform/billing/rails/alipayWorker.ts). */
export const ALIPAY_CALLBACK_PATH = '/api/v1/roboapply/billing/alipay/callback';

/** GoApply's canonical origin (server: the brand registry). The last step of the rule. */
export const GOAPPLY_CANONICAL_ORIGIN = 'https://www.goapply.top';

/** The one override of the notify origin (server: `ALIPAY_NOTIFY_ORIGIN_ENV`). */
export const NOTIFY_ORIGIN_ENV = 'CN_ALIPAY_NOTIFY_ORIGIN';

/** GoApply's own API origin, the second step of the rule. */
export const BACKEND_URL_ENV = 'CN_BACKEND_URL';

/** The response header this code puts on every answer (server: platform/brand/brandContext.ts). */
export const BRAND_HEADER = 'x-ra-brand';

export const PREFLIGHT_TIMEOUT_MS = 10_000;

export const USAGE = 'usage: node scripts/alipay-notify-preflight.mjs [--origin https://…]';

/** Printed under every PASS: the two things one request without an order and without the secret cannot show. */
export const NOT_PROVEN =
  'Not proven by this check: that this host uses the same database and the same callback secret as the deployment that creates the orders.';

const trimSlash = (v) => v.replace(/\/+$/, '');

/** Trimmed value, or undefined when unset or blank (server: `read` in platform/brand/brandEnv.ts). */
function readEnv(env, name) {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** `raw` as an https origin (scheme, host, optional port, nothing else), or why it is not one. Same rule as the server's. */
function httpsOriginOf(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { problem: 'malformed' };
  }
  if (url.protocol !== 'https:') return { problem: 'not_https' };
  if (!url.hostname) return { problem: 'malformed' };
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return { problem: 'not_an_origin' };
  return { origin: url.origin };
}

/**
 * Where the server tells the Alipay worker to post a GoApply notify, and what
 * decided it. The same three steps, the same result shape and the same values
 * as `resolveAlipayNotifyOrigin(getBrand('goapply'), env)`:
 * CN_ALIPAY_NOTIFY_ORIGIN when it is a bare https origin, else CN_BACKEND_URL,
 * else https://www.goapply.top. Reads those two variables and no other.
 */
export function resolveNotifyOrigin(env = process.env) {
  let ignoredOverride = null;
  const override = readEnv(env, NOTIFY_ORIGIN_ENV);
  if (override) {
    const parsed = httpsOriginOf(override);
    if ('origin' in parsed) return { origin: parsed.origin, source: NOTIFY_ORIGIN_ENV, ignoredOverride: null };
    ignoredOverride = parsed.problem;
  }
  const own = readEnv(env, BACKEND_URL_ENV);
  if (own) return { origin: trimSlash(own), source: BACKEND_URL_ENV, ignoredOverride };
  return { origin: GOAPPLY_CANONICAL_ORIGIN, source: 'canonical', ignoredOverride };
}

/** Why a set CN_ALIPAY_NOTIFY_ORIGIN is not used, in words (the server's own wording). */
export const IGNORED_OVERRIDE_REASON = {
  malformed: 'it is not a URL',
  not_https: 'it is not https',
  not_an_origin: 'it is not a bare origin (it carries a path, a query, a fragment or credentials)',
};

function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';
}

/**
 * `--origin` as an origin to check: https, or http for a loopback host only (a
 * local stub). Scheme, host and optional port, nothing else. Returns
 * `{ origin }` or `{ problem }`; the problem never repeats the value, because
 * someone may paste a whole notify URL, secret included.
 */
export function originFromArgument(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { problem: 'it is not a URL (write the scheme too: https://host)' };
  }
  if (!url.hostname) return { problem: 'it has no host' };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return { problem: 'it is not https (http is accepted for localhost only)' };
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { problem: 'it is not a bare origin: give scheme and host only, without a path, a query, a fragment or credentials' };
  }
  return { origin: url.origin };
}

/** `[--origin <value>]`, `--origin=<value>`, `--help`. Anything else is a usage error. */
export function parseArgs(argv) {
  const out = { origin: undefined, help: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--origin') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { ...out, error: '--origin needs a value' };
      out.origin = value;
      i += 1;
    } else if (arg.startsWith('--origin=')) {
      out.origin = arg.slice('--origin='.length);
      if (!out.origin) return { ...out, error: '--origin needs a value' };
    } else {
      // Never echo an unknown argument: it may be a pasted URL with a secret in it.
      return { ...out, error: 'unknown argument' };
    }
  }
  return out;
}

/**
 * The origin to check and what decided it.
 *   { origin, decidedBy }            ready to send
 *   { usageError }                   --origin is not an origin (exit 2)
 *   { refusal }                      a FAIL, nothing is sent: the shell holds a CN_ALIPAY_NOTIFY_ORIGIN the
 *                                    server would ignore, or the environment names no usable host
 * An ignored override is a refusal with --origin as well: one rule, so no run
 * that sees one can end in PASS.
 */
export function resolveTarget({ originArg, env = process.env } = {}) {
  const fromEnv = resolveNotifyOrigin(env);
  let given = null;
  if (originArg !== undefined) {
    const parsed = originFromArgument(originArg);
    if ('problem' in parsed) return { usageError: `--origin: ${parsed.problem}` };
    given = parsed.origin;
  }
  if (fromEnv.ignoredOverride) {
    // The server would silently use the next step; the operator meant another host. Stop here.
    // The value is never printed: it may be a whole notify URL, secret included.
    const elsewhere = `${hostOf(fromEnv.origin) ?? 'an unusable host'} (${fromEnv.source === 'canonical' ? 'the brand origin' : fromEnv.source})`;
    return {
      refusal:
        `${NOTIFY_ORIGIN_ENV} is set in this shell and the server would ignore it: ${IGNORED_OVERRIDE_REASON[fromEnv.ignoredOverride]}. ` +
        `It must be a bare https origin (scheme and host only), not the callback URL. As it stands a deployment that holds this value sends the notify to ${elsewhere}.` +
        (given ? ' --origin does not change that, so the host you gave was not checked. Fix the variable, or unset it in this shell when it is not the deployment\'s, then run again.' : ''),
    };
  }
  if (given) return { origin: given, decidedBy: '--origin' };
  let url;
  try {
    url = new URL(fromEnv.origin);
  } catch {
    return { refusal: `${fromEnv.source} is not a URL: the server would build a notify_url the worker cannot call.` };
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password || url.search || url.hash) {
    return { refusal: `${fromEnv.source} is not a plain http(s) origin: the server would build a notify_url the worker cannot call.` };
  }
  return { origin: fromEnv.origin, decidedBy: describeSource(fromEnv.source) };
}

function describeSource(source) {
  return source === 'canonical' ? 'the brand origin (no variable set)' : source;
}

/** Host and port of an origin or URL, or null. */
export function hostOf(value) {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

const RESULT = {
  pass: { verdict: 'PASS', exitCode: 0 },
  secret: { verdict: 'PASS-ROUTE / FAIL-SECRET', exitCode: 1 },
  handler: { verdict: 'PASS-ROUTE / FAIL-HANDLER', exitCode: 1 },
  fail: { verdict: 'FAIL', exitCode: 1 },
};

const fail = (reason) => ({ ...RESULT.fail, reason });

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function looksLikeHtml(contentType, body) {
  return /html/i.test(contentType ?? '') || /^\s*<(!doctype|html|head|body)\b/i.test(body ?? '');
}

/**
 * The result for one answer. Pure.
 * `answer`: { status, contentType, body, location, brandHeader, requestUrl, finalUrl, redirected }.
 */
export function classifyAnswer(answer) {
  const { status, contentType = '', body = '', location = null, brandHeader = null, requestUrl, finalUrl = null, redirected = false } = answer;
  const requestHost = hostOf(requestUrl);

  // A redirect: never followed, always a FAIL. A notify must not depend on the worker following one.
  const followedElsewhere = Boolean(finalUrl) && hostOf(finalUrl) !== null && hostOf(finalUrl) !== requestHost;
  if ((status >= 300 && status < 400) || status === 0 || redirected || followedElsewhere) {
    let target = null;
    try {
      target = location ? new URL(location, requestUrl) : finalUrl ? new URL(finalUrl) : null;
    } catch {
      target = null;
    }
    // Host and path only: a query is never printed.
    const where = target ? `${target.host}${target.pathname}` : 'an unreadable address';
    const other = target && target.host !== requestHost;
    return fail(
      `a redirect${status ? ` (HTTP ${status})` : ''} to ${other ? 'another host' : 'another address on the same host'}: ${where}. The callback route must answer at the exact address the worker is given: whether the worker follows a redirect, and keeps its parameters when it does, is not known.`,
    );
  }

  const json = parseJsonObject(body);
  const code = json && typeof json.code === 'number' ? json.code : null;

  if (status === 401) {
    return fail('HTTP 401: the host asks for a login before it reaches our code (a Vercel preview behind Deployment Protection answers 401 to the worker too). Use a public alias, or switch protection off for that deployment.');
  }
  if (status === 404) {
    if (json && json.code === 'brand_unavailable') {
      return fail('HTTP 404 brand_unavailable: this code is running there, but the deployment does not serve the site this host belongs to (ALLOWED_BRANDS / BRAND_LOCK).');
    }
    return fail('HTTP 404: this host does not serve the callback route.');
  }
  if (!json) {
    if (looksLikeHtml(contentType, body)) return fail(`HTTP ${status} with an HTML page, not our JSON: another site or a gateway answered.`);
    return fail(`HTTP ${status} with a body that is not our JSON.`);
  }

  if (status === 403 && code === 40003) {
    if (!brandHeader) {
      return {
        ...RESULT.handler,
        reason:
          'the callback route answered 403 / 40003, but without the X-RA-Brand header this code puts on every response. The older production handler answers the same when a callback secret is set on its host, and it would not serve a GoApply order. If a proxy in front removes the header, check with: curl -si <the address above> | grep -i x-ra-brand',
      };
    }
    return { ...RESULT.pass, reason: 'our callback route answered (403 / 40003, the refusal of a request without the secret) and a callback secret is set on that host.' };
  }
  if (status === 503 && code === 50003) {
    return {
      ...RESULT.secret,
      reason: 'the callback route is reached, but ALIPAY_CALLBACK_SECRET is not set on that host (or the Alipay rail is not registered there): every notify would be refused and no order would be fulfilled.',
    };
  }
  if (status === 400 && code === 40001) {
    return {
      ...RESULT.handler,
      reason:
        'the callback route answered 400 / 40001 to a request without the secret. This code asks for the secret first (it answers 403 / 40003, or 503 / 50003 when none is set); 40001 here is what the older production handler answers when NO callback secret is set on its host. Do not send GoApply notifies to this host.',
    };
  }
  return fail(`HTTP ${status}${code === null ? '' : ` with code ${code}`}: not one of the answers our callback route gives to a request without parameters.`);
}

function errorCode(err) {
  const cause = err && typeof err === 'object' ? err.cause : null;
  const code = (cause && typeof cause === 'object' && cause.code) || (err && typeof err === 'object' && err.code) || null;
  return typeof code === 'string' ? code : null;
}

/**
 * Send the one GET and classify the answer. Never throws.
 * Returns { url, host, status, code, brandHeader, verdict, exitCode, reason }.
 */
export async function preflight({ origin, fetchImpl = globalThis.fetch, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  const url = `${origin}${ALIPAY_CALLBACK_PATH}`;
  const host = hostOf(url);
  const base = { url, host, status: null, code: null, brandHeader: null };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    // No query, no body, no secret, no cookie. Redirects are reported, never followed.
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json', 'user-agent': 'alipay-notify-preflight/1 (read-only check; no order)' },
      signal: controller.signal,
    });
    const body = (await res.text()).slice(0, 65_536);
    const brandHeader = res.headers.get(BRAND_HEADER);
    const result = classifyAnswer({
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body,
      location: res.headers.get('location'),
      brandHeader,
      requestUrl: url,
      finalUrl: res.url || null,
      redirected: res.redirected === true || res.type === 'opaqueredirect',
    });
    const json = parseJsonObject(body);
    return { ...base, status: res.status, code: json && (typeof json.code === 'number' || typeof json.code === 'string') ? json.code : null, brandHeader: brandHeader || null, ...result };
  } catch (err) {
    if (timedOut) return { ...base, ...fail(`no answer within ${Math.round(timeoutMs / 1000)} s (timeout).`) };
    const code = errorCode(err);
    return { ...base, ...fail(`the request failed before any answer${code ? ` (${code})` : ''}: the host does not resolve, refuses the connection or fails TLS.`) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole run. Returns the exit code; prints through `out` / `err`.
 * `deps`: { env, fetch, timeoutMs, out, err }, all optional (tests inject them).
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));

  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    out('One GET to <origin>/api/v1/roboapply/billing/alipay/callback: no parameters, no secret, no order. Exit code 0 only on PASS.');
    out(`Without --origin: ${NOTIFY_ORIGIN_ENV}, else ${BACKEND_URL_ENV}, else ${GOAPPLY_CANONICAL_ORIGIN} (read from this shell).`);
    return 0;
  }
  if (args.error) {
    err(`${args.error}\n${USAGE}`);
    return 2;
  }

  const target = resolveTarget({ originArg: args.origin, env });
  if (target.usageError) {
    err(`${target.usageError}\n${USAGE}`);
    return 2;
  }
  out('Alipay notify pre-flight (read-only: one GET, no parameters, no secret, no order)');
  if (target.refusal) {
    out(`result:   FAIL  ${target.refusal}`);
    out('          Nothing was sent.');
    return 1;
  }

  out(`host:     ${hostOf(target.origin)}`);
  out(`decided:  ${target.decidedBy}`);
  const result = await preflight({ origin: target.origin, fetchImpl: deps.fetch ?? globalThis.fetch, timeoutMs: deps.timeoutMs ?? PREFLIGHT_TIMEOUT_MS });
  out(`request:  GET ${result.url}`);
  out(`status:   ${result.status === null ? 'no answer' : `HTTP ${result.status}`}`);
  if (result.code !== null) out(`answer:   { code: ${JSON.stringify(result.code)} }`);
  if (result.status !== null) out(`brand:    ${result.brandHeader ? `${result.brandHeader} (X-RA-Brand)` : 'no X-RA-Brand header'}`);
  out(`result:   ${result.verdict}  ${result.reason}`);
  if (result.exitCode === 0) {
    out(`          ${NOT_PROVEN}`);
    if (target.decidedBy !== '--origin') {
      out('          The host was read from this shell. Compare it with the boot line "GoApply Alipay notify host: <host>" of the deployment that creates the orders.');
    }
  }
  return result.exitCode;
}

/**
 * Was this file started as the command (`node <path to this file>`)? Both
 * sides are compared as real paths: Node resolves the entry module through
 * symbolic links and leaves `process.argv[1]` as typed, so a plain comparison
 * says "no" for a start through a linked directory, and the command would then
 * print nothing and exit 0, which a wrapper reads as a pass.
 */
export function isEntryPoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
