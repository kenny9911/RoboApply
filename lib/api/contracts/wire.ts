// lib/api/contracts/wire.ts — the small runtime every area wrapper in lib/api/
// shares (FND-7). Area files stay thin: one function per endpoint, typed by the
// area's contract, calling `call()` / `postStream()` / `apiUrl()` from here.
//
// Rules (TASK_PLAN.md §2.1, AGENTS.md):
//   - Components never build `/api/v1/...` URLs; they import an area wrapper.
//   - Request types come from the server contract (`In<typeof XSchema>` is
//     the zod *input* type, so defaults and coercions stay optional).
//   - Where a contract names no response type yet, the wrapper uses the
//     conventions below (`Items<T>`, `void`); the owner WP adds the explicit
//     type to its contract.ts and switches the wrapper in the same change.
//
// Errors: everything rejects with `RoboApiError` (lib/api/client.ts). The
// platform error code (`credits_exhausted`, `feature_disabled`, …) is on
// `apiErrorCode(err)`; `err.code` is the legacy normalized code.

import type { z } from 'zod';

import { API_BASE } from '../../config';
import { LOCALE_COOKIE } from '../../localeConfig';
import { RoboApiError, devBrandHeader, request, type RequestOptions } from '../client';

/** zod input type of a contract schema (`In<typeof C.PutOfferBodySchema>`). */
export type In<S> = S extends z.ZodType ? z.input<S> : never;
/** zod output type of a contract schema. */
export type Out<S> = S extends z.ZodType ? z.output<S> : never;

/** Default list shape where a contract names none: `{ items, cursor }` (cursor pagination). */
export interface Items<T> {
  items: T[];
  cursor?: string | null;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Per-call options every wrapper accepts as its last argument. */
export interface CallOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Forwarded cookie string for server-side (RSC) calls. */
  cookie?: string;
  /**
   * `Idempotency-Key` header. Credit-spending endpoints (tailor, fit analysis,
   * cover letters, outreach drafts, autofill runs, …) need one so a retry
   * never charges twice (ARCHITECTURE.md §7.3). `newIdempotencyKey()` makes one.
   */
  idempotencyKey?: string;
}

/** Encode one path segment. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

type QueryValue = string | number | boolean | Date | null | undefined | readonly (string | number | boolean)[];

/**
 * Append a query string. `undefined`/`null` are dropped, arrays repeat the key
 * (`?a=1&a=2`), dates become ISO strings, nested objects are JSON-encoded.
 */
export function withQuery(path: string, query?: object | null): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query as Record<string, QueryValue | object>)) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      for (const v of raw) params.append(key, String(v));
    } else if (raw instanceof Date) {
      params.append(key, raw.toISOString());
    } else if (typeof raw === 'object') {
      params.append(key, JSON.stringify(raw));
    } else {
      params.append(key, String(raw));
    }
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

/** Absolute URL for links, downloads and redirects (`<a href>`, `window.location`). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** A fresh idempotency key (UUID v4 when available). */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function mergeHeaders(opts?: CallOptions): Record<string, string> | undefined {
  if (!opts?.headers && !opts?.idempotencyKey) return undefined;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  return headers;
}

/** One JSON call through `request()` (envelope unwrapped, `RoboApiError` on failure). */
export function call<T>(
  method: HttpMethod,
  path: string,
  opts: CallOptions & { body?: unknown; multipart?: boolean } = {},
): Promise<T> {
  const options: RequestOptions = {
    body: opts.body,
    headers: mergeHeaders(opts),
    signal: opts.signal,
    cookie: opts.cookie,
    multipart: opts.multipart,
  };
  return request<T>(method, path, options);
}

/** The platform error code (`credits_exhausted`, `feature_disabled`, …) carried by a failed call. */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof RoboApiError)) return null;
  const payload = err.payload as { code?: unknown } | undefined;
  return typeof payload?.code === 'string' ? payload.code : null;
}

/**
 * The area-specific reason of a failed call. Areas keep the platform `code`
 * generic (`rate_limited`, `conflict`, …) and put their own reason in
 * `details.reason` (`feed_refresh_limited`, `feed_session_expired`, …).
 */
export function apiErrorReason(err: unknown): string | null {
  if (!(err instanceof RoboApiError)) return null;
  const payload = err.payload as { details?: { reason?: unknown } | null } | undefined;
  const reason = payload?.details && typeof payload.details === 'object' ? payload.details.reason : undefined;
  return typeof reason === 'string' ? reason : null;
}

/** The `details` object of a failed call (e.g. the credits-exhausted bucket). */
export function apiErrorDetails<T = Record<string, unknown>>(err: unknown): T | null {
  if (!(err instanceof RoboApiError)) return null;
  const payload = err.payload as { details?: unknown } | undefined;
  return payload?.details && typeof payload.details === 'object' ? (payload.details as T) : null;
}

// ─── Server-sent events over POST ────────────────────────────────────────────
//
// The Assistant turn, the onboarding match and the visitor assistant answer
// with `text/event-stream` (server/src/platform/sse.ts). EventSource cannot
// POST, so this reads the stream with fetch. Heartbeat comments (`: ping`)
// are skipped; `data:` lines are JSON-parsed when they parse.

export interface SseEvent {
  event: string;
  data: unknown;
}

export interface StreamOptions<E extends SseEvent> extends CallOptions {
  onEvent: (event: E) => void;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const row = document.cookie.split(/;\s*/).find((r) => r.startsWith(`${name}=`));
  if (!row) return null;
  try {
    return decodeURIComponent(row.slice(name.length + 1)) || null;
  } catch {
    return null;
  }
}

function streamHeaders(opts: CallOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...mergeHeaders(opts),
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const locale = readCookie(LOCALE_COOKIE);
  if (locale && !headers['X-Robo-Locale']) headers['X-Robo-Locale'] = locale;
  const devBrand = devBrandHeader(opts.cookie);
  if (devBrand && !headers['X-RA-Brand']) headers['X-RA-Brand'] = devBrand;
  if (typeof window !== 'undefined' && !headers.Authorization) {
    try {
      const bearer = window.localStorage.getItem('auth_token');
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
    } catch {
      // storage unavailable — the cookie still authenticates
    }
  }
  return headers;
}

/** Parse one SSE block (lines between blank lines). Returns null for comments/empty blocks. */
export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

/**
 * POST a JSON body and deliver each SSE event to `onEvent`. Resolves when the
 * stream ends; rejects with `RoboApiError` when the server answers with a
 * non-2xx JSON error before streaming (e.g. 402 credits_exhausted).
 */
export async function postStream<E extends SseEvent>(
  path: string,
  body: unknown,
  opts: StreamOptions<E>,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: streamHeaders(opts),
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    throw new RoboApiError(err instanceof Error ? err.message : 'Network error', { code: 'network_error' });
  }
  if (!res.ok) {
    let data: { error?: string; code?: string } = {};
    try {
      data = await res.json();
    } catch {
      // non-JSON error body
    }
    throw new RoboApiError(data.error ?? `HTTP ${res.status}`, { code: data.code, status: res.status, payload: data });
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const parsed = parseSseBlock(block);
      if (parsed) opts.onEvent(parsed as E);
    }
  }
  buffer += decoder.decode();
  const tail = parseSseBlock(buffer);
  if (tail) opts.onEvent(tail as E);
}
