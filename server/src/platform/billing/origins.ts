// server/src/platform/billing/origins.ts
//
// Brand-aware origins for payment redirects and provider callbacks
// (TASK_PLAN.md WP-21a: rail and URLs from the brand, never from `?region=`).
//   appOrigin:      where the user returns after paying (the brand's web app).
//   callbackOrigin: where a payment worker posts its notify (the brand's API).
// RoboApply keeps the env names it already uses (NEXT_PUBLIC_ROBOAPPLY_URL /
// ROBOAPPLY_URL, BACKEND_URL); GoApply reads only its own `CN_` names here.
// Both names are brand-own identity (`BRAND_OWN_ENV`, parity plan §3.1): an
// origin never crosses brands, so there is no fallback to the international
// value. A GoApply payment notify therefore goes to CN_BACKEND_URL, else to
// GoApply's canonical origin, never to another brand's host (MARKET_STRATEGY
// §5.3 G8).
//   alipayNotifyOrigin: where the Alipay worker posts its notify. For GoApply
//     one more override in front of that chain, CN_ALIPAY_NOTIFY_ORIGIN, for a
//     deployment whose callback is served by another host that runs THIS code
//     on the SAME database. RoboApply (legacy orders only) is `callbackOrigin`.

import { brandEnv, brandOwnEnv, type EnvSource } from '../brand/brandEnv.js';
import type { ProductBrand } from '../brand/registry.js';
import { logger } from '../../services/LoggerService.js';

function trimSlash(v: string): string {
  return v.replace(/\/+$/, '');
}

export function appOrigin(brand: ProductBrand, env: EnvSource = process.env): string {
  if (brand.market === 'cn') return trimSlash(brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin);
  return trimSlash(
    env.NEXT_PUBLIC_ROBOAPPLY_URL?.trim() || env.ROBOAPPLY_URL?.trim() || brandEnv(brand, 'CANONICAL_ORIGIN', env) || brand.canonicalOrigin,
  );
}

export function callbackOrigin(brand: ProductBrand, env: EnvSource = process.env): string {
  return trimSlash(brandEnv(brand, 'BACKEND_URL', env) || brand.canonicalOrigin);
}

/** The one override of GoApply's Alipay notify origin (MARKET_STRATEGY §5.3 G8). */
export const ALIPAY_NOTIFY_ORIGIN_ENV = 'CN_ALIPAY_NOTIFY_ORIGIN';

/** What decided the notify origin: a variable name, or the brand's canonical origin when none is set. */
export type AlipayNotifyOriginSource = typeof ALIPAY_NOTIFY_ORIGIN_ENV | 'CN_BACKEND_URL' | 'BACKEND_URL' | 'canonical';

/** Why a set CN_ALIPAY_NOTIFY_ORIGIN is not used. */
export type AlipayNotifyOverrideProblem = 'malformed' | 'not_https' | 'not_an_origin';

export interface AlipayNotifyOriginResolution {
  /** Scheme and host, no trailing slash: the callback path is appended to it. */
  origin: string;
  source: AlipayNotifyOriginSource;
  /** Set when CN_ALIPAY_NOTIFY_ORIGIN has a value that was ignored, else null. */
  ignoredOverride: AlipayNotifyOverrideProblem | null;
}

/** `raw` as an https origin (scheme, host, optional port, nothing else), or the reason it is not one. */
function httpsOriginOf(raw: string): { origin: string } | { problem: AlipayNotifyOverrideProblem } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: 'malformed' };
  }
  if (url.protocol !== 'https:') return { problem: 'not_https' };
  if (!url.hostname) return { problem: 'malformed' };
  // A path, a query (it would collide with `?cb=`), a fragment or credentials: not an origin.
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return { problem: 'not_an_origin' };
  return { origin: url.origin };
}

/**
 * Where the Alipay worker is told to post its notify, and what decided it
 * (MARKET_STRATEGY §5.3 G8). Pure: it reads `env` and logs nothing.
 *
 * GoApply: CN_ALIPAY_NOTIFY_ORIGIN when it is an https origin, else
 * CN_BACKEND_URL, else GoApply's canonical origin (https://www.goapply.top).
 * It NEVER reads BACKEND_URL and never lands on another brand's host: while
 * goapply.top is live and roboapply.io still runs the older code, that host's
 * handler has no amount check and would mis-activate the order or not find it.
 * Point the override at another host only once that host runs this code
 * against the same database.
 *
 * RoboApply (legacy orders only; it opens no new Alipay order): unchanged,
 * `callbackOrigin`.
 */
export function resolveAlipayNotifyOrigin(brand: ProductBrand, env: EnvSource = process.env): AlipayNotifyOriginResolution {
  if (brand.market !== 'cn') {
    return { origin: callbackOrigin(brand, env), source: brandEnv(brand, 'BACKEND_URL', env) ? 'BACKEND_URL' : 'canonical', ignoredOverride: null };
  }
  let ignoredOverride: AlipayNotifyOverrideProblem | null = null;
  const override = env[ALIPAY_NOTIFY_ORIGIN_ENV]?.trim();
  if (override) {
    const parsed = httpsOriginOf(override);
    if ('origin' in parsed) return { origin: parsed.origin, source: ALIPAY_NOTIFY_ORIGIN_ENV, ignoredOverride: null };
    ignoredOverride = parsed.problem;
  }
  // The strict brand-own read: CN_BACKEND_URL, never the shared BACKEND_URL.
  const own = brandOwnEnv(brand, 'BACKEND_URL', env);
  if (own) return { origin: trimSlash(own), source: 'CN_BACKEND_URL', ignoredOverride };
  return { origin: trimSlash(brand.canonicalOrigin), source: 'canonical', ignoredOverride };
}

type WarnLog = { warn: (tag: string, message: string, meta?: Record<string, unknown>) => void };
const ignoredOverridesLogged = new Set<string>();

/**
 * The origin for an Alipay `notify_url` (see `resolveAlipayNotifyOrigin`). A
 * CN_ALIPAY_NOTIFY_ORIGIN that is not an https origin is ignored and logged,
 * once per process and value. The value itself is never logged: someone may
 * have pasted a whole notify URL, secret included.
 */
export function alipayNotifyOrigin(brand: ProductBrand, env: EnvSource = process.env, log: WarnLog = logger): string {
  const resolved = resolveAlipayNotifyOrigin(brand, env);
  if (resolved.ignoredOverride) {
    const key = `${resolved.ignoredOverride}:${env[ALIPAY_NOTIFY_ORIGIN_ENV] ?? ''}`;
    if (!ignoredOverridesLogged.has(key)) {
      ignoredOverridesLogged.add(key);
      try {
        log.warn('RA_BILLING', `${ALIPAY_NOTIFY_ORIGIN_ENV} is not an https origin and is ignored`, {
          variable: ALIPAY_NOTIFY_ORIGIN_ENV,
          reason: resolved.ignoredOverride,
          usedInstead: resolved.source,
        });
      } catch {
        /* a log line never stops an order */
      }
    }
  }
  return resolved.origin;
}

/** The host (with a port, if any) of an origin, or null when it does not parse as a URL. */
export function originHost(origin: string): string | null {
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
}

/** Tests only: forget which ignored overrides were logged. */
export function resetAlipayNotifyOriginLogForTests(): void {
  ignoredOverridesLogged.clear();
}

/**
 * A caller-supplied return path, only when it is a same-origin relative path
 * (starts with one '/', no scheme, no backslash). Anything else → undefined.
 */
export function safeReturnPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim();
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('://') || p.includes('\\')) return undefined;
  return p.slice(0, 200);
}

export function withQueryParam(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${value}`;
}
