import type { CookieOptions, Request } from 'express';
import { getCurrentBrandOrDefault } from '../platform/brand/brandContext.js';
import { cookieDomainFor, requestHost } from '../platform/brand/runtime.js';
import { getBrand, parseBrandId } from '../platform/brand/registry.js';
import { getCurrentRequestHost } from './requestContext.js';

/**
 * Cookie options shared across the auth surface.
 *
 * Per-brand cookie domain (ARCHITECTURE.md §1.6, TASK_PLAN.md R-03):
 *   RoboApply reads `COOKIE_DOMAIN` (e.g. `.roboapply.io`), GoApply reads
 *   `CN_COOKIE_DOMAIN` (e.g. `.goapply.top`). There is no fallback across
 *   brands. The domain is applied ONLY when the request host ends with it, so
 *   preview hosts (*.vercel.app) and localhost get a host-only cookie the
 *   browser accepts. Unset → host-only, exactly as before.
 *
 * The brand and host come from `req` when one is passed, else from the
 * request context entered by the brand middleware, so existing callers that
 * pass only `extra` get per-brand behaviour without changes.
 *
 * The KEY DETAIL: `domain` MUST be `undefined` (not empty string) when no
 * domain applies, so the cookie binds to the request host. Express treats
 * `domain: ''` as "set Domain= to empty", which most browsers ignore but at
 * least one rejects.
 */

/**
 * RoboApply's session cookie name — deliberately NOT `session_token`.
 *
 * RoboHire dev uses `session_token`, and browser cookies are host-scoped,
 * not port-scoped: on `localhost` every dev app shares one cookie jar. Since
 * the 2026-07 DB split, a RoboHire session row no longer exists in
 * RoboApply's database, so a shared cookie name meant a stale RoboHire (or
 * pre-split RoboApply) cookie passed the proxy's presence check, then 401'd
 * on /auth/me and bounced the user to /login in a loop. A distinct name makes
 * the two apps' sessions invisible to each other. Must match
 * SESSION_COOKIE_NAME in the frontend's lib/config.ts.
 */
export const SESSION_COOKIE_NAME = 'ra_session_token';

type RequestLike = Pick<Request, 'headers'> & { brand?: { id?: string } };

function isRequestLike(value: unknown): value is RequestLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'headers' in value &&
    typeof (value as { headers?: unknown }).headers === 'object'
  );
}

/** The cookie domain for this request (or the current request context). */
export function resolveCookieDomain(req?: RequestLike): string | undefined {
  try {
    const brand = req?.brand?.id ? getBrand(parseBrandId(req.brand.id) ?? 'roboapply') : getCurrentBrandOrDefault();
    const host = req ? requestHost(req as Parameters<typeof requestHost>[0]) : getCurrentRequestHost();
    return cookieDomainFor(brand, host);
  } catch {
    return process.env.COOKIE_DOMAIN || undefined;
  }
}

/**
 * Build the options for `res.cookie(...)` on an auth-related cookie
 * (ra_session_token today; any future seeker-app auth cookies should reuse
 * this helper). Pass `extra` to override or add fields — `maxAge`,
 * `sameSite` overrides, etc. The caller's fields win.
 *
 *   buildCookieOptions(req, extra?)  — preferred in new code
 *   buildCookieOptions(extra?)       — legacy form; reads the request context
 *
 * Defaults applied:
 *  - `httpOnly: true`         (server-only; JS can't read)
 *  - `secure: NODE_ENV==='production'` (HTTPS in prod; HTTP in dev)
 *  - `sameSite: 'lax'`        (CSRF-safe default for first-party flows)
 *  - `domain`                 (per brand and host; undefined → host-bound)
 */
export function buildCookieOptions(reqOrExtra?: RequestLike | CookieOptions, extra: CookieOptions = {}): CookieOptions {
  const req = isRequestLike(reqOrExtra) ? reqOrExtra : undefined;
  const fields = req ? extra : ((reqOrExtra as CookieOptions | undefined) ?? {});
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: resolveCookieDomain(req),
    ...fields,
  };
}

/**
 * Build the options for `res.clearCookie(...)`. Per the cookie spec,
 * clearing a cookie requires the `domain` and `path` to match the
 * Set-Cookie that created it — otherwise the browser keeps the old
 * cookie and only the (different) new empty one disappears. The domain is
 * resolved exactly like buildCookieOptions, so set and clear always agree
 * for the same host.
 *
 * We intentionally do NOT replicate httpOnly/secure/sameSite here:
 * Express's `clearCookie` doesn't need them to identify the cookie,
 * and including them just means more attributes to keep in sync
 * with the set-side. Domain is the only one that matters for
 * targeting the right cookie record.
 */
export function buildClearCookieOptions(reqOrExtra?: RequestLike | CookieOptions, extra: CookieOptions = {}): CookieOptions {
  const req = isRequestLike(reqOrExtra) ? reqOrExtra : undefined;
  const fields = req ? extra : ((reqOrExtra as CookieOptions | undefined) ?? {});
  return {
    domain: resolveCookieDomain(req),
    ...fields,
  };
}
