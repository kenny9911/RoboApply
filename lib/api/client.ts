// roboapply-app/lib/api/client.ts
//
// Low-level fetch wrapper. Used by every API module. Sets `credentials:
// 'include'` so the session_token cookie flows on cross-origin prod
// requests; passes Bearer fallback when localStorage has a token (some
// browsers block third-party cookies).
//
// Errors are normalised through RoboApiError so callers can match on
// `.code` instead of poking at HTTP status.

import { API_BASE } from '../config';
import { LOCALE_COOKIE } from '../localeConfig';
import { isProtectedPath } from '../proxyPaths';

/**
 * `GET /api/v1/public/brand` — the requesting host's brand and its resolved
 * capabilities (R-04, R-24). Read by lib/flags.ts `useCapabilities()`.
 * FND-7's area wrapper `lib/api/brand.ts` may wrap it; keep the path here.
 */
export const PUBLIC_BRAND_PATH = '/api/v1/public/brand';

/** Dev/preview brand override cookie, set by proxy.ts from `?__brand=` (lib/brand/runtime.ts). */
const BRAND_OVERRIDE_COOKIE = 'ra_brand_override';

export type RoboErrorCode =
  | 'auth_expired'
  // The session belongs to the other product brand (requireAuth 401). Same
  // recovery as a dead session: drop the cookie, sign in on this site.
  | 'auth_other_brand'
  // Login: the password matched an account of the other brand (409, with
  // `payload.details.otherBrandUrl`).
  | 'account_other_brand'
  | 'account_disabled'
  | 'subscription_locked'
  | 'quota_exceeded'
  | 'onboarding_required'
  | 'invalid_credentials'
  | 'email_taken'
  | 'invalid_email'
  | 'invalid_password'
  | 'not_a_seeker_account'
  | 'account_deleted'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'unknown';

export class RoboApiError extends Error {
  code: RoboErrorCode;
  status?: number;
  payload?: unknown;
  constructor(
    message: string,
    opts: { code?: string; status?: number; payload?: unknown } = {},
  ) {
    super(message);
    this.name = 'RoboApiError';
    this.code = normalizeCode(opts.code, opts.status);
    this.status = opts.status;
    this.payload = opts.payload;
  }
}

function normalizeCode(
  code?: string,
  status?: number,
): RoboErrorCode {
  if (!code) {
    if (status === 401) return 'auth_expired';
    if (status === 402) return 'subscription_locked';
    if (status === 403) return 'quota_exceeded';
    if (status === 404) return 'not_found';
    if (status === 409) return 'onboarding_required';
    if (status === 429) return 'rate_limited';
    if (status && status >= 500) return 'server_error';
    return 'unknown';
  }
  switch (code) {
    case 'INVALID_TOKEN':
    case 'NO_AUTH':
    // Backend requireAuth's "no token at all" code. On a protected page that
    // still means "this browser is not signed in" — same recovery as a dead
    // session, so it must not fall through to 'unknown'.
    case 'AUTH_REQUIRED':
    case 'auth_expired':
      return 'auth_expired';
    case 'auth_other_brand':
      return 'auth_other_brand';
    case 'account_other_brand':
      return 'account_other_brand';
    case 'ACCOUNT_DISABLED':
    case 'account_disabled':
      return 'account_disabled';
    case 'SUBSCRIPTION_LOCKED':
      return 'subscription_locked';
    case 'QUOTA_EXCEEDED':
    case 'quota_exhausted':
      return 'quota_exceeded';
    case 'ONBOARDING_INCOMPLETE':
      return 'onboarding_required';
    case 'invalid_credentials':
    case 'login_failed':
      return 'invalid_credentials';
    case 'email_taken':
      return 'email_taken';
    case 'invalid_email':
      return 'invalid_email';
    case 'invalid_password':
      return 'invalid_password';
    case 'not_a_seeker_account':
      return 'not_a_seeker_account';
    case 'account_deleted':
      return 'account_deleted';
    // Transport codes this module sets on itself (a fetch that threw, a 5xx).
    // Without these they fall through to 'unknown' and a caller cannot tell a
    // connection that died mid-flight — where the request may well have been
    // processed — from a request the server actively refused.
    case 'network_error':
      return 'network_error';
    case 'server_error':
      return 'server_error';
    default:
      if (status === 404) return 'not_found';
      if (status === 429) return 'rate_limited';
      if (status && status >= 500) return 'server_error';
      return 'unknown';
  }
}

// ─── Stale-session recovery ─────────────────────────────────────────────────
//
// The edge proxy (proxy.ts) can only check that the session cookie EXISTS —
// it has no DB at the edge to validate it. A browser holding a dead session
// (row revoked or expired server-side; every pre-DB-split cookie is like
// this) therefore still reaches protected pages, where EVERY api call 401s:
// onboarding never bootstraps, resume uploads surface as parse failures, and
// nothing tells the user to sign back in. The (auth) shell's AuthGate only
// covers its own subtree, and only at mount.
//
// This is the global safety net: the first `auth_expired` that surfaces on a
// protected route runs the registered session cleanups (below), drops the
// dead credentials and hard-navigates to /login with a return path. Guarded
// because a stranded page tends to fire a burst of parallel 401s (auth/me +
// session + resumes + config…).
let authExpiredRecoveryFired = false;

// ─── Session cleanups ───────────────────────────────────────────────────────
//
// Things this browser must forget when a session ends here: the web-push
// subscription of the account that is leaving, unsent resume-builder drafts.
// They live in feature code (hooks/pwa, hooks/resume), which `lib` must not
// import, so the app shell REGISTERS them (components/v3/shell/
// signOutCleanup.ts) and this module only runs what is registered.
//
// Order matters: a cleanup may still need the session (deleting the push row
// is an authenticated call), so the stale-session recovery below runs them
// BEFORE it clears the cookie. They can never hold the recovery back: each
// one is isolated (a throw or a rejection is swallowed) and the whole batch is
// given SESSION_CLEANUP_TIMEOUT_MS.

export type SessionCleanup = () => void | Promise<void>;

/** Upper bound for all registered cleanups together before the session is cleared anyway. */
export const SESSION_CLEANUP_TIMEOUT_MS = 4000;

const sessionCleanups = new Set<SessionCleanup>();

/** Register a cleanup; returns the function that removes it again. */
export function registerSessionCleanup(cleanup: SessionCleanup): () => void {
  sessionCleanups.add(cleanup);
  return () => {
    sessionCleanups.delete(cleanup);
  };
}

/**
 * Run every registered cleanup. Never rejects; resolves when all have
 * settled or after `timeoutMs`, whichever is first.
 */
export async function runSessionCleanups(timeoutMs: number = SESSION_CLEANUP_TIMEOUT_MS): Promise<void> {
  if (sessionCleanups.size === 0) return;
  const work = Promise.all(
    [...sessionCleanups].map(async (cleanup) => {
      try {
        await cleanup();
      } catch {
        // One failing cleanup never stops the others or the sign-out.
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([work.then(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}

function recoverFromExpiredSession(): void {
  if (authExpiredRecoveryFired) return;
  authExpiredRecoveryFired = true;

  // Nothing registered (a page outside the app shell): keep the recovery
  // synchronous. Otherwise the cleanups go first; their own API calls 401 like
  // everything else on a dead session, and land on the guard above.
  if (sessionCleanups.size === 0) {
    clearExpiredSessionAndLeave();
    return;
  }
  void runSessionCleanups().then(clearExpiredSessionAndLeave, clearExpiredSessionAndLeave);
}

function clearExpiredSessionAndLeave(): void {
  // Drop the localStorage bearer fallback too — left in place it would ride
  // along on every request after re-login and mask the fresh cookie.
  try {
    window.localStorage.removeItem('auth_token');
  } catch {
    // Storage unavailable (private mode) — the cookie clear below still runs.
  }

  // Clear the dead cookie so the edge proxy stops treating the browser as
  // signed in. Logout is deliberately sessionless server-side (see
  // server/src/roboapply/routes/auth.ts) so this works with an invalid
  // token; keepalive lets it survive the navigation below. Fire-and-forget:
  // worst case the cookie lingers and the next 401 lands back here.
  try {
    void fetch(`${API_BASE}/api/v1/roboapply/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
    }).catch(() => {});
  } catch {
    // fetch itself threw (very old browser) — proceed to the redirect.
  }

  const { pathname, search } = window.location;
  window.location.assign(`/login?next=${encodeURIComponent(pathname + search)}`);
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** When called server-side (RSC), pass the cookie string explicitly. */
  cookie?: string;
  /** Set true for FormData; we skip JSON Content-Type. */
  multipart?: boolean;
}

function getBearerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

/**
 * The active UI locale, so the backend can tell LLM agents to respond in the
 * same language the user is reading the app in. Reads the `robo_locale`
 * cookie: from `document.cookie` in the browser, or from the explicitly
 * forwarded `opts.cookie` string in a server (RSC) context.
 */
function getLocaleFromCookie(cookieStr?: string): string | null {
  return readCookie(LOCALE_COOKIE, cookieStr);
}

/** Read one cookie from the forwarded string (RSC) or `document.cookie` (browser). */
function readCookie(name: string, cookieStr?: string): string | null {
  const source =
    cookieStr ?? (typeof document !== 'undefined' ? document.cookie : '');
  if (!source) return null;
  const match = source
    .split(/;\s*/)
    .find((row) => row.startsWith(`${name}=`));
  if (!match) return null;
  try {
    const value = decodeURIComponent(match.slice(name.length + 1));
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Development only: echo the `ra_brand_override` cookie as `X-RA-Brand` so
 * the API serves the brand the page is showing (ARCHITECTURE.md §1.5).
 * Express accepts the header on dev/preview hosts only, and production
 * bundles never send it (same-origin requests carry the real Host).
 */
export function devBrandHeader(cookieStr?: string): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  const value = readCookie(BRAND_OVERRIDE_COOKIE, cookieStr);
  return value === 'roboapply' || value === 'goapply' ? value : null;
}

/**
 * Take the payload out of the server's `{ success, data }` envelope.
 *
 * `data: null` is an answer — "no report yet", "no active plan" — and the
 * caller must receive `null`. The unwrap used to be `body?.data ?? body`, and
 * `??` cannot tell "this body has no data key" from "the data is null", so a
 * null payload came back as the whole envelope and pages rendered
 * `{ success, data }` as if it were the resource (/jobs/report crashed on it).
 *
 *   { success, data: X }     → X, whatever X is (null, 0, false, '' included)
 *   { data: X }, X not null  → X (a bare wrapper some older routes send)
 *   anything else            → the body unchanged (no data key, an array, a
 *                              resource that merely has a nullable `data` field)
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'data')) return body;
  const payload = record.data;
  if (payload !== null && payload !== undefined) return payload;
  // A null payload only counts when the body really is an envelope.
  return typeof record.success === 'boolean' ? null : body;
}

export async function request<T>(
  method: Method,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = { ...opts.headers };
  if (!opts.multipart && opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.cookie) headers['Cookie'] = opts.cookie;

  // Tell the backend which UI language to answer in (LLM output locale).
  // Caller-provided header wins; otherwise derive from the robo_locale cookie.
  if (!headers['X-Robo-Locale']) {
    const locale = getLocaleFromCookie(opts.cookie);
    if (locale) headers['X-Robo-Locale'] = locale;
  }

  // Dev-only brand override echo (never in production builds).
  if (!headers['X-RA-Brand']) {
    const devBrand = devBrandHeader(opts.cookie);
    if (devBrand) headers['X-RA-Brand'] = devBrand;
  }

  // Browser path: forward localStorage bearer as a fallback in case the
  // cookie was blocked by a Safari ITP rule or similar.
  const bearer = getBearerToken();
  if (bearer && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${bearer}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: opts.multipart
        ? (opts.body as FormData)
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    throw new RoboApiError(
      err instanceof Error ? err.message : 'Network error',
      { code: 'network_error' },
    );
  }

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // Empty body or non-JSON — leave as {}.
  }

  if (!res.ok || data?.success === false) {
    const error = new RoboApiError(
      data?.error ?? `HTTP ${res.status}`,
      {
        code: data?.code,
        status: res.status,
        payload: data,
      },
    );
    // Dead/absent session on a page that requires one → force re-login.
    // Public pages (landing, /login itself) just see the rejection: their
    // logged-out rendering is the correct outcome there.
    // A session from the other brand is just as unusable here: the server
    // rejects it on every call while the proxy still sees a cookie.
    if (
      (error.code === 'auth_expired' || error.code === 'auth_other_brand') &&
      typeof window !== 'undefined' &&
      isProtectedPath(window.location.pathname)
    ) {
      recoverFromExpiredSession();
    }
    throw error;
  }
  return unwrapEnvelope(data) as T;
}

export const roboApi = {
  get: <T>(p: string, o?: Omit<RequestOptions, 'body'>) =>
    request<T>('GET', p, o),
  post: <T>(p: string, body?: unknown, o?: RequestOptions) =>
    request<T>('POST', p, { ...o, body }),
  put: <T>(p: string, body?: unknown, o?: RequestOptions) =>
    request<T>('PUT', p, { ...o, body }),
  patch: <T>(p: string, body?: unknown, o?: RequestOptions) =>
    request<T>('PATCH', p, { ...o, body }),
  delete: <T>(p: string, o?: Omit<RequestOptions, 'body'>) =>
    request<T>('DELETE', p, o),
};
