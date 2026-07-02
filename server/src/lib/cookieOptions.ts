import type { CookieOptions } from 'express';

/**
 * Cookie options shared across the auth surface.
 *
 * In production / staging, COOKIE_DOMAIN must be set to `.robohire.io` (with
 * leading dot) so sessions persist across the future `seeker.robohire.io`
 * subdomain split without forcing re-login.
 *
 * In dev, COOKIE_DOMAIN should be unset — cookies bind to the request host
 * (localhost) so each running stack keeps its own session.
 *
 * Production rollout
 * ------------------
 *  1. Set `COOKIE_DOMAIN=.robohire.io` in Render env (leading dot required).
 *  2. Existing users will have cookies on `robohire.io` (no dot). Those
 *     keep working for the current host but are NOT sent to subdomains.
 *     They auto-rotate to the parent-domain cookie on next login, and
 *     fully roll over within the 30-day session-token max-age.
 *  3. JWT in localStorage is unaffected — that's a separate auth path
 *     and is read directly by `frontend/src/lib/axios.ts`.
 *
 * The KEY DETAIL: `domain` MUST be `undefined` (not empty string) when
 * COOKIE_DOMAIN is unset, so the cookie binds to the request host (the
 * dev behavior). Express treats `domain: ''` as "set Domain= to empty",
 * which most browsers ignore but at least one rejects.
 */
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

/**
 * Build the options for `res.cookie(...)` on an auth-related cookie
 * (session_token today; any future seeker-app auth cookies should reuse
 * this helper). Pass `extra` to override or add fields — `maxAge`,
 * `sameSite` overrides, etc. The caller's fields win.
 *
 * Defaults applied:
 *  - `httpOnly: true`         (server-only; JS can't read)
 *  - `secure: NODE_ENV==='production'` (HTTPS in prod; HTTP in dev)
 *  - `sameSite: 'lax'`        (CSRF-safe default for first-party flows)
 *  - `domain: COOKIE_DOMAIN`  (undefined in dev → host-bound)
 */
export function buildCookieOptions(extra: CookieOptions = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: COOKIE_DOMAIN,
    ...extra,
  };
}

/**
 * Build the options for `res.clearCookie(...)`. Per the cookie spec,
 * clearing a cookie requires the `domain` and `path` to match the
 * Set-Cookie that created it — otherwise the browser keeps the old
 * cookie and only the (different) new empty one disappears.
 *
 * We intentionally do NOT replicate httpOnly/secure/sameSite here:
 * Express's `clearCookie` doesn't need them to identify the cookie,
 * and including them just means more attributes to keep in sync
 * with the set-side. Domain is the only one that matters for
 * targeting the right cookie record.
 */
export function buildClearCookieOptions(extra: CookieOptions = {}): CookieOptions {
  return {
    domain: COOKIE_DOMAIN,
    ...extra,
  };
}
