// server/src/features/jobs/liveness/postingApi.ts — the three single-posting
// endpoints the liveness check may ask, and the one request it makes (MKT-5C;
// MARKET_STRATEGY 1.5 "Closure"; JOB_SOURCES_INTL.md 7.2).
//
// An applicant tracking system's PUBLIC job-board API documents an endpoint
// that returns one posting as JSON and answers 404 once the posting is closed:
//
//   greenhouse        GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}
//   lever             GET https://api.lever.co/v0/postings/{site}/{id}
//   smartrecruiters   GET https://api.smartrecruiters.com/v1/companies/{company}/postings/{id}
//
// Nothing else is ever requested. The URL is built here from a template and
// two path segments (each percent-encoded), so no caller can make this file
// fetch an HTML page, a career site, Workday, or any host outside the table:
// a URL that is not https on one of the three hosts is refused before a
// request is sent. A redirect is never followed. The request carries no
// personal information (the tenant and the posting id are the posting's own
// public identifiers) and says who is asking (jobs/sources/userAgent.ts).
//
// What was read on 2026-10-12 from the three public APIs (one live posting,
// one unknown id and the tenant in another letter case, each):
//   - Greenhouse: 200 with `id` (a number); an unknown id answers 404
//     `{"status":404,"error":"Job not found"}`; the board token is read
//     without regard to case.
//   - Lever: 200 with `id` (the uuid); an unknown id answers 404
//     `{"ok":false,"error":"Document not found"}`, AND SO DOES A LIVE POSTING
//     ASKED UNDER THE SITE NAME IN ANOTHER LETTER CASE. The site name is
//     therefore case-sensitive: see `tenantCaseMatters`.
//   - SmartRecruiters: 200 with `id` (a string) and `active`; the company
//     identifier is read without regard to case; a posting id that belongs to
//     no posting of the company answered 400, which is "unknown" here.
//
// "Closed" is the ATS's own statement, so a 404 counts only when its body is
// the API's JSON answer. A 404 page from anything in between (a proxy, a
// captive portal) is "unknown": a live posting is never archived on it.
//
// The board connectors' reader (sources/atsPublic/http.ts) is not used here:
// it belongs to another area, whose public surface does not export it, and it
// hides the body of a 404. Lever's EU host (api.eu.lever.co) is not in the
// table: a `lever_eu` key is answered "unknown" without a request.

import type { EnvSource, Market } from '../../../platform/brand/index.js';
import { sourceUserAgent } from '../sources/index.js';

/** The ATSs whose public API documents a single-posting JSON endpoint. */
export const LIVENESS_ATS = ['greenhouse', 'lever', 'smartrecruiters'] as const;
export type LivenessAts = (typeof LIVENESS_ATS)[number];

/** How long the one request may take. */
export const LIVENESS_TIMEOUT_MS = 4_000;
/** Largest answer read (characters): one posting with its text is a few tens of kilobytes. */
export const LIVENESS_MAX_BODY = 2 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d{1,20}$/;
/** A board token, site or company identifier as the ATS writes it in its URLs (normalize/ats.ts `TENANT_RE`). */
export const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

const enc = encodeURIComponent;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface PostingEndpoint {
  host: string;
  /** The posting's URL on the ATS's public API. */
  url(tenant: string, postingId: string): string;
  /** The shape of a posting id of this ATS. */
  idPattern: RegExp;
  /**
   * True when the API reads the tenant with regard to letter case, so a
   * request under another spelling answers 404 for a live posting (Lever).
   * Such a tenant is asked only in the exact spelling of one of the row's own
   * identifiers, and a 404 counts as "closed" only under the spelling the
   * board API itself gave (check.ts).
   */
  tenantCaseMatters: boolean;
  /** Is this 200 answer the posting that was asked for, listed? */
  lists(body: unknown, postingId: string): boolean;
}

const sameId = (value: unknown, postingId: string): boolean =>
  (typeof value === 'string' || typeof value === 'number') && String(value).toLowerCase() === postingId.toLowerCase();

export const POSTING_ENDPOINTS: Readonly<Record<LivenessAts, PostingEndpoint>> = {
  greenhouse: {
    host: 'boards-api.greenhouse.io',
    url: (tenant, id) => `https://boards-api.greenhouse.io/v1/boards/${enc(tenant)}/jobs/${enc(id)}`,
    idPattern: DIGITS_RE,
    tenantCaseMatters: false,
    lists: (body, id) => isRecord(body) && sameId(body.id, id),
  },
  lever: {
    host: 'api.lever.co',
    url: (tenant, id) => `https://api.lever.co/v0/postings/${enc(tenant)}/${enc(id)}`,
    idPattern: UUID_RE,
    tenantCaseMatters: true,
    lists: (body, id) => isRecord(body) && sameId(body.id, id),
  },
  smartrecruiters: {
    host: 'api.smartrecruiters.com',
    url: (tenant, id) => `https://api.smartrecruiters.com/v1/companies/${enc(tenant)}/postings/${enc(id)}`,
    idPattern: DIGITS_RE,
    tenantCaseMatters: false,
    // A posting the API still answers but marks inactive is not a confirmed listing (and not a 404 either).
    lists: (body, id) => isRecord(body) && sameId(body.id, id) && body.active !== false,
  },
};

/** The only hosts this file sends a request to. */
export const LIVENESS_HOSTS: readonly string[] = LIVENESS_ATS.map((ats) => POSTING_ENDPOINTS[ats].host);

export function isLivenessAts(value: string): value is LivenessAts {
  return (LIVENESS_ATS as readonly string[]).includes(value);
}

export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export interface PostingRequestDeps {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** The market whose brand signs the request (the posting row's market). */
  market?: Market;
  env?: EnvSource;
  /** The clock a `Retry-After` date is read against. */
  now?: () => Date;
}

/**
 * What the API said about one posting. `error` covers everything that is
 * neither a posting nor the API's own "not found"; a 429 carries how long the
 * host asked to be left alone, when it said (`Retry-After`).
 */
export type PostingAnswer = { kind: 'posting'; body: unknown } | { kind: 'not_found' } | { kind: 'error'; reason: string; retryAfterMs?: number };

/** `Retry-After` as milliseconds from `now`: a number of seconds or an HTTP date. Undefined for anything else. */
export function retryAfterMs(value: string | null | undefined, now: Date): number | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return undefined;
  if (/^\d{1,9}$/.test(raw)) return Number(raw) * 1_000;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  const ms = at - now.getTime();
  return ms > 0 ? ms : undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * One GET of one posting. Never throws: a refused URL, a timeout, a redirect,
 * a non-JSON body and every status other than 200 and a JSON 404 come back as
 * `{ kind: 'error' }`.
 */
export async function requestPosting(url: string, deps: PostingRequestDeps = {}): Promise<PostingAnswer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'error', reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' || !LIVENESS_HOSTS.includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
    return { kind: 'error', reason: 'host_not_allowed' };
  }
  const doFetch: FetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LIVENESS_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': sourceUserAgent(deps.market ?? 'intl', deps.env ?? process.env) },
      redirect: 'error',
    });
    // A fetch that ignores `redirect` must still not be followed.
    if (res.status >= 300 && res.status < 400) return { kind: 'error', reason: 'redirect' };
    if (res.status === 429) {
      // The host said to slow down: how long, when it says (check.ts leaves the host alone for that long).
      let header: string | null = null;
      try {
        header = res.headers?.get('retry-after') ?? null;
      } catch {
        header = null;
      }
      const wait = retryAfterMs(header, (deps.now ?? (() => new Date()))());
      return wait === undefined ? { kind: 'error', reason: 'http_429' } : { kind: 'error', reason: 'http_429', retryAfterMs: wait };
    }
    if (res.status !== 200 && res.status !== 404) return { kind: 'error', reason: `http_${res.status}` };
    const text = await res.text();
    if (text.length > LIVENESS_MAX_BODY) return { kind: 'error', reason: 'response_too_large' };
    const json = parseJson(text);
    if (res.status === 404) return json.ok && isRecord(json.value) ? { kind: 'not_found' } : { kind: 'error', reason: 'http_404_not_json' };
    return json.ok ? { kind: 'posting', body: json.value } : { kind: 'error', reason: 'not_json' };
  } catch (err) {
    if (controller.signal.aborted) return { kind: 'error', reason: 'timeout' };
    if (err instanceof TypeError && /redirect/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`)) return { kind: 'error', reason: 'redirect' };
    return { kind: 'error', reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
