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

export type RoboErrorCode =
  | 'auth_expired'
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
    case 'auth_expired':
      return 'auth_expired';
    case 'ACCOUNT_DISABLED':
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
    default:
      if (status === 404) return 'not_found';
      if (status === 429) return 'rate_limited';
      if (status && status >= 500) return 'server_error';
      return 'unknown';
  }
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
  const source =
    cookieStr ?? (typeof document !== 'undefined' ? document.cookie : '');
  if (!source) return null;
  const match = source
    .split('; ')
    .find((row) => row.startsWith(`${LOCALE_COOKIE}=`));
  if (!match) return null;
  const value = decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1));
  return value || null;
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
    throw new RoboApiError(
      data?.error ?? `HTTP ${res.status}`,
      {
        code: data?.code,
        status: res.status,
        payload: data,
      },
    );
  }
  return (data?.data ?? data) as T;
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
