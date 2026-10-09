// server/src/features/growth/attribution.ts — entry attribution (F-ONB-02,
// F-GROW-03; PRODUCT_PLAN.md §4.1).
//
// A visitor arrives with `from`, `job`, `action=apply`, `ref`, `invite`,
// `utm_source/medium/campaign` and `alert` in the URL. The web client
// (lib/analytics.ts) notes them as `{ firstTouch, lastTouch }` in Touch field
// names (`utmSource`, `jobId`, `inviteCode` …) and signup sends
// `getAttribution()` as `body.attribution`. Signup (WP-10) stores it once:
//
//   const identity = analyticsIdentity(req, brand.market);
//   const client = touchesFromClient(req.body?.attribution);
//   const first = client.firstTouch ?? touchFromQuery(req.query, { landingPath });
//   const opts = { anonId: identity.anonId ?? undefined, linkAllowed: identity.linkAllowed };
//   if (first) await recordAttribution(user.id, first, opts);
//   if (client.lastTouch) await recordAttribution(user.id, client.lastTouch, { ...opts, lastTouchOnly: true });
//
// `touchFromQuery` reads URL query keys (`utm_source`, `job`, `invite`);
// `touchesFromClient` reads the client's Touch objects. They are not
// interchangeable. `firstTouch` is written once and never overwritten; later
// visits may only update `lastTouch` (`{ lastTouchOnly: true }`). Without
// `linkAllowed: true` only the functional fields (ref, inviteCode, jobId,
// action) are stored — see `functionalTouch`. Pure helpers live here; the
// database writes are in service.ts.

import { TouchSchema, type Touch } from './contract.js';
import {
  ANALYTICS_CONSENT_COOKIE,
  ANON_ID_COOKIE,
  ANON_ID_RE,
  analyticsLinkAllowed,
  parseConsentChoice,
  redactTokenPath,
  type AnalyticsConsentChoice,
} from './events.js';

/** URL query key → Touch field. */
export const ATTRIBUTION_QUERY_KEYS = {
  from: 'from',
  job: 'jobId',
  action: 'action',
  ref: 'ref',
  invite: 'inviteCode',
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  alert: 'alert',
} as const satisfies Record<string, keyof Touch>;

/** Field limits, from TouchSchema (kept in one place so trimming matches validation). */
const FIELD_MAX: Record<Exclude<keyof Touch, 'at'>, number> = {
  from: 80,
  utmSource: 120,
  utmMedium: 120,
  utmCampaign: 120,
  ref: 64,
  inviteCode: 64,
  landingPath: 512,
  jobId: 64,
  action: 40,
  alert: 200,
};

function clean(value: unknown, max: number): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  // Printable characters only; no control characters in stored JSON.
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || undefined;
}

/**
 * Trim a touch to the documented shape: unknown keys and empty values are
 * dropped, long values are cut, `landingPath` loses its query string, `at`
 * defaults to `now`. Returns null when nothing but the time would be stored.
 */
export function sanitizeTouch(input: Partial<Record<keyof Touch, unknown>> | null | undefined, now: Date = new Date()): Touch | null {
  if (!input || typeof input !== 'object') return null;
  const out: Record<string, string> = {};
  for (const key of Object.keys(FIELD_MAX) as Array<keyof typeof FIELD_MAX>) {
    let v = clean(input[key], FIELD_MAX[key]);
    if (v && key === 'landingPath') {
      v = v.split(/[?#]/)[0];
      v = v?.startsWith('/') ? redactTokenPath(v) : undefined;
    }
    if (v) out[key] = v;
  }
  if (Object.keys(out).length === 0) return null;
  const atMs = typeof input.at === 'string' ? Date.parse(input.at) : Number.NaN;
  const at = Number.isFinite(atMs) && atMs <= now.getTime() + 60_000 ? new Date(atMs).toISOString() : now.toISOString();
  const parsed = TouchSchema.safeParse({ ...out, at });
  return parsed.success ? parsed.data : null;
}

/** Build a touch from URL query parameters (`?from=alert&job=…&utm_source=…`). */
export function touchFromQuery(
  query: Record<string, unknown> | URLSearchParams | null | undefined,
  options: { landingPath?: string; now?: Date } = {},
): Touch | null {
  if (!query) return null;
  const get = (k: string): unknown => (query instanceof URLSearchParams ? query.get(k) : query[k]);
  const fields: Partial<Record<keyof Touch, unknown>> = { landingPath: options.landingPath };
  for (const [param, field] of Object.entries(ATTRIBUTION_QUERY_KEYS)) {
    const v = get(param);
    if (v !== undefined && v !== null) fields[field] = v;
  }
  return sanitizeTouch(fields, options.now);
}

/**
 * Touch fields that make the product work rather than measure marketing:
 * the referral (`ref`, `inviteCode`) and the job the visitor came to act on
 * (`jobId`, `action`). These are kept without analytics consent; `from`,
 * `utm*`, `alert` and `landingPath` are kept only where linking is allowed.
 */
export const FUNCTIONAL_TOUCH_FIELDS = ['ref', 'inviteCode', 'jobId', 'action'] as const satisfies readonly (keyof Touch)[];

/** The functional part of a touch (plus its time), or null when none is left. */
export function functionalTouch(touch: Touch | null | undefined, now: Date = new Date()): Touch | null {
  if (!touch) return null;
  const out: Partial<Record<keyof Touch, unknown>> = {};
  for (const key of FUNCTIONAL_TOUCH_FIELDS) if (touch[key]) out[key] = touch[key];
  if (!Object.keys(out).length) return null;
  return sanitizeTouch({ ...out, at: touch.at }, now);
}

/**
 * Read what the web client sends at signup: `getAttribution()` from
 * lib/analytics.ts, i.e. `{ firstTouch, lastTouch }` with Touch field names.
 * Each touch is sanitized; anything else (a bare query object, junk) yields
 * nulls, so callers fall back to `touchFromQuery(req.query, …)`.
 */
export function touchesFromClient(body: unknown, now: Date = new Date()): { firstTouch: Touch | null; lastTouch: Touch | null } {
  if (!body || typeof body !== 'object') return { firstTouch: null, lastTouch: null };
  const b = body as { firstTouch?: unknown; lastTouch?: unknown };
  const read = (v: unknown): Touch | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? sanitizeTouch(v as Partial<Record<keyof Touch, unknown>>, now) : null;
  return { firstTouch: read(b.firstTouch), lastTouch: read(b.lastTouch) };
}

// ── Request identity (for WP-10's signup and the events route) ───────────

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, unknown>;
}

/** Edge country headers, most trusted first (mirrors lib/server/brand.ts). */
export const COUNTRY_HEADERS = ['x-vercel-ip-country', 'cf-ipcountry', 'x-country', 'x-geo-country'] as const;

/** ISO-3166 alpha-2 country of the request (uppercase), or null. */
export function requestCountry(req: RequestLike): string | null {
  for (const name of COUNTRY_HEADERS) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && /^[a-z]{2}$/i.test(value.trim())) return value.trim().toUpperCase();
  }
  return null;
}

export interface AnalyticsIdentity {
  country: string | null;
  consent: AnalyticsConsentChoice | null;
  /** May events and attribution be linked to an anonId / the account? */
  linkAllowed: boolean;
  /** The `ra_anon` cookie when present, valid and linking is allowed; else null. */
  anonId: string | null;
}

/**
 * Who the analytics rules say this request is. WP-10 passes `anonId` and
 * `linkAllowed` to `recordAttribution` at signup: the anonId links the
 * visitor's earlier events to the new account, and `linkAllowed` decides
 * whether the marketing fields of the touch are kept — neither happens
 * before consent where consent is required.
 */
export function analyticsIdentity(req: RequestLike, market: 'intl' | 'cn'): AnalyticsIdentity {
  const country = requestCountry(req);
  const consent = parseConsentChoice(req.cookies?.[ANALYTICS_CONSENT_COOKIE]);
  const linkAllowed = analyticsLinkAllowed({ market, country, consent });
  const raw = req.cookies?.[ANON_ID_COOKIE];
  const anonId = linkAllowed && typeof raw === 'string' && ANON_ID_RE.test(raw) ? raw : null;
  return { country, consent, linkAllowed, anonId };
}
