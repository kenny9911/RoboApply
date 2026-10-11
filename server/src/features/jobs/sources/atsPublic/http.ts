// server/src/features/jobs/sources/atsPublic/http.ts — the only outbound HTTP
// of the public ATS connectors (WP-42; MKT-5B).
//
// Review rule (TASK_PLAN.md WP-16b / WP-42, CN_TW_LAUNCH_PLAN.md L-5;
// MARKET_STRATEGY 1.6): posting APIs and feeds only. A request to any host
// outside the rules below is refused before it is sent, so no code path can
// fetch an HTML job board (104, 1111, Cake, Yourator, LinkedIn …) or Workday's
// career sites. Requests carry no personal information: only the ops-curated
// board id is in the URL. Redirects are never followed (`redirect: 'error'`,
// and a 3xx is refused), so an allowed host cannot hand the request on to
// another host; that is also the rule for a Personio host that is not a
// customer's (it answers with a redirect).
//
// Which hosts (`assertApiHost`):
//   1. API_HOSTS, compared exactly: the vendors' own API hosts.
//   2. TENANT_HOST_RULES, each an anchored pattern: systems whose board lives
//      on a host of the tenant's own (`<label>.recruitee.com`,
//      `<label>.jobs.personio.de|com`). The label is one lower-case DNS label
//      and never a vendor's own site (`www`, `api` …).
//   3. `<label>.zhiye.com` (北森 tenant boards) ONLY while
//      CN_ATS_BEISEN_ENABLED is true. With the flag off no such rule exists,
//      so no request to that domain can be built by any caller.
// https only, no port, no credentials in the URL.
//
// Three verbs, all under the same guards (host, redirect, size, timeout):
//   getJson   a JSON document;
//   getXml    a flat XML feed, returned as text for ./xml.ts;
//   postJson  a JSON body to a 北森 tenant board and nothing else: the one
//             listing we read that is asked with POST. It sends no cookie,
//             token, signature or Referer.
//
// Every request says who is asking (MARKET_STRATEGY 1.2 tier 0, JI-4): the
// identifying User-Agent of jobs/sources/userAgent.ts, for the market the
// caller names (`deps.market`; a board read for both brands is asked as the
// international brand). We never pose as a browser.

import type { EnvSource, Market } from '../../../../platform/brand/index.js';
import { sourceUserAgent } from '../index.js';
import { RESERVED_TENANT_LABELS } from './contract.js';
import { beisenEnabled, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from './shared.js';

/** The vendors' own API hosts, compared exactly. */
export const API_HOSTS = ['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com', 'api.smartrecruiters.com', 'apply.workable.com', 'api.eu.lever.co'] as const;

/** One lower-case DNS label (the same shape as contract.ts TENANT_LABEL_PATTERN). */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/** Systems whose board is served from the tenant's own host: one anchored pattern each. Group 1 is the tenant label. */
export const TENANT_HOST_RULES: ReadonlyArray<{ ats: 'recruitee' | 'personio'; pattern: RegExp }> = [
  { ats: 'recruitee', pattern: new RegExp(`^(${LABEL})\\.recruitee\\.com$`) },
  { ats: 'personio', pattern: new RegExp(`^(${LABEL})\\.jobs\\.personio\\.(?:de|com)$`) },
];

/** 北森 tenant boards. A rule only while CN_ATS_BEISEN_ENABLED is true (see the header). */
export const BEISEN_HOST_PATTERN = new RegExp(`^(${LABEL})\\.zhiye\\.com$`);

export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow'; method?: 'GET' | 'POST'; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class BoardFetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'BoardFetchError';
    this.status = status;
  }
}

export interface HttpDeps {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The market whose brand signs the request (default 'intl'). */
  market?: Market;
  /** Environment the contact and the connector flags are read from (default process.env). */
  env?: EnvSource;
}

/** The headers of every board request: what we accept, and who is asking. */
export function boardRequestHeaders(deps: Pick<HttpDeps, 'market' | 'env'> = {}, accept = 'application/json'): Record<string, string> {
  return { Accept: accept, 'User-Agent': sourceUserAgent(deps.market ?? 'intl', deps.env ?? process.env) };
}

function tenantHost(pattern: RegExp, hostname: string): boolean {
  const label = pattern.exec(hostname)?.[1];
  return !!label && !RESERVED_TENANT_LABELS.includes(label);
}

/** Is this host a 北森 tenant board we may ask right now? False for every host while the flag is off. */
export function isBeisenHost(hostname: string, env: EnvSource = process.env): boolean {
  return beisenEnabled(env) && tenantHost(BEISEN_HOST_PATTERN, hostname);
}

/** The URL when its host is one we may ask (see the header); throws BoardFetchError before anything is sent otherwise. */
export function assertApiHost(url: string, env: EnvSource = process.env): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BoardFetchError('invalid_url');
  }
  const host = parsed.hostname;
  const plain = parsed.protocol === 'https:' && parsed.port === '' && parsed.username === '' && parsed.password === '';
  const allowed = (API_HOSTS as readonly string[]).includes(host) || TENANT_HOST_RULES.some((rule) => tenantHost(rule.pattern, host)) || isBeisenHost(host, env);
  if (!plain || !allowed) throw new BoardFetchError(`host_not_allowed:${host}`);
  return parsed;
}

interface RequestSpec {
  accept: string;
  method?: 'GET' | 'POST';
  /** A JSON request body (POST only). */
  body?: string;
}

/** One request under every guard of this file; the answer's text. Throws BoardFetchError. */
async function requestText(url: string, deps: HttpDeps, spec: RequestSpec): Promise<string> {
  assertApiHost(url, deps.env ?? process.env);
  if (deps.signal?.aborted) throw new BoardFetchError('timeout');
  const doFetch: FetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const headers = boardRequestHeaders(deps, spec.accept);
    const init: Parameters<FetchLike>[1] = { signal: controller.signal, headers, redirect: 'error' };
    if (spec.method === 'POST') {
      init.method = 'POST';
      init.body = spec.body ?? '';
      init.headers = { ...headers, 'Content-Type': 'application/json' };
    }
    const res = await doFetch(url, init);
    // A fetch that ignores `redirect` (or answers 'manual') must still not be followed.
    if (res.status >= 300 && res.status < 400) throw new BoardFetchError('redirect', res.status);
    if (!res.ok) throw new BoardFetchError(res.status === 404 ? 'board_not_found' : `http_${res.status}`, res.status);
    const body = await res.text();
    if (body.length > MAX_RESPONSE_BYTES) throw new BoardFetchError('response_too_large');
    return body;
  } catch (err) {
    if (err instanceof BoardFetchError) throw err;
    if (controller.signal.aborted) throw new BoardFetchError('timeout');
    // undici rejects a redirect under `redirect: 'error'` with a TypeError.
    if (err instanceof TypeError && /redirect/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`)) {
      throw new BoardFetchError('redirect');
    }
    throw new BoardFetchError(err instanceof Error ? `network:${err.message.slice(0, 120)}` : 'network');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new BoardFetchError('not_json');
  }
}

/** GET a JSON document from an allowed host. Throws BoardFetchError. */
export async function getJson(url: string, deps: HttpDeps = {}): Promise<unknown> {
  return parseJson(await requestText(url, deps, { accept: 'application/json' }));
}

/**
 * GET an XML feed from an allowed host and return its text (./xml.ts reads
 * it). An answer that is not XML at all (an HTML page, JSON, nothing) is
 * 'not_xml'. Throws BoardFetchError.
 */
export async function getXml(url: string, deps: HttpDeps = {}): Promise<string> {
  const body = await requestText(url, deps, { accept: 'application/xml, text/xml' });
  const start = body.replace(/^﻿/, '').trimStart();
  if (!start.startsWith('<') || /^<!doctype\s+html|^<html[\s>]/i.test(start)) throw new BoardFetchError('not_xml');
  return body;
}

/**
 * POST a JSON body and read a JSON answer. For 北森 tenant boards only, whose
 * listing is asked with POST: any other host is refused here even though
 * `assertApiHost` knows it, so this verb cannot be pointed at a system we
 * read with GET. While CN_ATS_BEISEN_ENABLED is off every URL is refused.
 * Throws BoardFetchError.
 */
export async function postJson(url: string, body: unknown, deps: HttpDeps = {}): Promise<unknown> {
  const parsed = assertApiHost(url, deps.env ?? process.env);
  if (!isBeisenHost(parsed.hostname, deps.env ?? process.env)) throw new BoardFetchError(`host_not_allowed:${parsed.hostname}`);
  return parseJson(await requestText(url, deps, { accept: 'application/json', method: 'POST', body: JSON.stringify(body) }));
}
