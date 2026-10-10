// server/src/platform/http.ts
//
// The HTTP envelope for every new route (ARCHITECTURE.md §3.1, TASK_PLAN.md
// FND-3). Legacy routers keep their own shapes; code under
// server/src/features/** and server/src/platform/** uses this file.
//
//   success → { success: true, data }
//   error   → { success: false, code, error, details? }
//
// Pieces:
//   - ERROR_STATUS: the named error codes and their HTTP status.
//   - HttpError / httpError(): throw from a handler or service.
//   - ok() / fail(): write the envelope.
//   - parseBody/parseQuery/parseParams/parseInput: zod parse → 422 invalid_request.
//   - route(): async handler wrapper; any thrown error becomes an envelope.
//   - errorHandler(): Express error middleware with the same mapping.
//   - NotImplementedError / notImplemented(): the stub contract (FND-5 stubs
//     answer 501 not_implemented; service stubs throw NotImplementedError).
//   - MIN_SAMPLE and Sourced<T>: the D3 provenance rule's server twin of
//     components/features/common/SourceNote.tsx.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

// ── Error codes ───────────────────────────────────────────────────────────

/** Every named error code a new route may answer, with its HTTP status. */
export const ERROR_STATUS = {
  invalid_request: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal_error: 500,
  /** 402; details `{ bucket, resetsAt, upgradable }` (ARCH §3.1). */
  credits_exhausted: 402,
  /** The route's capability is off for this brand/user (R-04). */
  feature_disabled: 404,
  /** A disabled AI capability, or no model configured for the brand (R-04, R-13). */
  ai_unavailable: 503,
  /** Optimistic `version` mismatch; details `{ currentVersion }`. */
  version_conflict: 409,
  /** The account belongs to the other brand; details `{ otherBrandUrl }`. */
  account_other_brand: 409,
  /** The session belongs to the other brand (FND-2a requireAuth). */
  auth_other_brand: 401,
  /** 429 with a `Retry-After` header; details `{ retryAfterSec }`. */
  rate_limited: 429,
  /** The provider for this action is not configured on this deployment. */
  provider_not_configured: 501,
  /** A stub whose owner has not filled it yet. */
  not_implemented: 501,
  /** The content-safety filter refused the input or output (WP-24). */
  content_blocked: 422,
  /** The resolved LLM route violates the brand's policy (R-13); logged. */
  brand_policy: 500,
  /** The deployment does not serve this brand (FND-2a brand middleware). */
  brand_unavailable: 404,
  /** The brand's file storage is not available on this deployment (WP-15 residency; never falls back to another bucket). */
  storage_unavailable: 503,
  /** A residency-critical write ran with no brand context (WP-15 writeBrand; a server bug, logged). */
  brand_context_missing: 500,
  /** The resource existed and is gone for good, e.g. a closed public job page (WP-56; Wave 4 gate). */
  gone: 410,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_STATUS, value);
}

/** Default English messages. Clients localize by `code`; these are fallbacks for logs and tools. */
export const DEFAULT_ERROR_MESSAGES: Record<ErrorCode, string> = {
  invalid_request: 'The request is not valid.',
  unauthorized: 'Authentication required.',
  forbidden: 'You do not have access to this.',
  not_found: 'Not found.',
  conflict: 'This conflicts with the current state.',
  internal_error: 'Something went wrong.',
  credits_exhausted: 'You have used all credits for this action in the current period.',
  feature_disabled: 'This feature is not available.',
  ai_unavailable: 'This AI feature is not available right now.',
  version_conflict: 'This was changed elsewhere. Reload and try again.',
  account_other_brand: 'This account belongs to the other site.',
  auth_other_brand: 'This session belongs to the other site.',
  rate_limited: 'Too many requests. Try again later.',
  provider_not_configured: 'This provider is not configured.',
  not_implemented: 'Not implemented yet.',
  content_blocked: 'This content cannot be processed.',
  brand_policy: 'This request cannot be routed for this site.',
  brand_unavailable: 'This site is not served by this deployment.',
  storage_unavailable: 'File storage is not available right now.',
  brand_context_missing: 'Something went wrong.',
  gone: 'This is no longer available.',
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Extra response headers (e.g. Retry-After). */
  readonly headers?: Record<string, string>;

  constructor(code: ErrorCode, message?: string, details?: unknown, headers?: Record<string, string>) {
    super(message ?? DEFAULT_ERROR_MESSAGES[code]);
    this.name = 'HttpError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
    this.headers = headers;
  }
}

export function httpError(code: ErrorCode, message?: string, details?: unknown): HttpError {
  return new HttpError(code, message, details);
}

/**
 * Tag on a route handler that is still a FND stub (answers 501
 * not_implemented). The route-harness guard (features/features.test.ts) only
 * asserts 501 for tagged handlers, so a WP that replaces a stub with a real
 * handler drops out of that check without editing any shared test.
 */
export const STUB_HANDLER: unique symbol = Symbol.for('roboapply.stubHandler');

/** Mark a handler as a not-implemented stub (see STUB_HANDLER). Returns the same handler. */
export function markStub<T extends RequestHandler>(handler: T): T {
  Object.defineProperty(handler, STUB_HANDLER, { value: true });
  return handler;
}

/** True when `handler` was built as a stub (`markStub`). */
export function isStubHandler(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as unknown as Record<symbol, unknown>)[STUB_HANDLER] === true;
}

/** Thrown by service stubs (FND-5 `index.ts` interfaces) until the owner fills them. Maps to 501. */
export class NotImplementedError extends Error {
  readonly code = 'not_implemented' as const;
  readonly status = 501;
  constructor(what = 'This') {
    super(`${what} is not implemented yet.`);
    this.name = 'NotImplementedError';
  }
}

// ── Envelope writers ─────────────────────────────────────────────────────

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

export interface ErrorEnvelope {
  success: false;
  code: ErrorCode | string;
  error: string;
  details?: unknown;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ success: true, data } satisfies SuccessEnvelope<T>);
}

export function fail(res: Response, code: ErrorCode, message?: string, details?: unknown): Response {
  const body: ErrorEnvelope = { success: false, code, error: message ?? DEFAULT_ERROR_MESSAGES[code] };
  if (details !== undefined) body.details = details;
  if (code === 'rate_limited') {
    const retry = retryAfterFromDetails(details);
    if (retry !== undefined) res.setHeader('Retry-After', String(retry));
  }
  return res.status(ERROR_STATUS[code]).json(body);
}

/** Stub handler body: `501 not_implemented`. */
export function notImplemented(res: Response, what?: string): Response {
  return fail(res, 'not_implemented', what ? `${what} is not implemented yet.` : undefined);
}

function retryAfterFromDetails(details: unknown): number | undefined {
  if (details && typeof details === 'object' && 'retryAfterSec' in details) {
    const v = Number((details as { retryAfterSec: unknown }).retryAfterSec);
    if (Number.isFinite(v) && v >= 0) return Math.ceil(v);
  }
  return undefined;
}

// ── Validation (zod → 422) ───────────────────────────────────────────────

export interface ValidationIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

function toIssues(error: unknown): ValidationIssue[] {
  const issues = (error as { issues?: Array<{ path?: PropertyKey[]; code?: string; message?: string }> })?.issues ?? [];
  return issues.map((i) => ({
    path: (i.path ?? []).map((p) => (typeof p === 'number' ? p : String(p))),
    code: String(i.code ?? 'invalid'),
    message: String(i.message ?? 'Invalid value'),
  }));
}

/** Parse `value` with `schema`; throws `HttpError('invalid_request', …, { issues, where })`. */
export function parseInput<T>(schema: ZodType<T>, value: unknown, where = 'body'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError('invalid_request', `The ${where} is not valid.`, { where, issues: toIssues(result.error) });
}

export function parseBody<T>(req: Request, schema: ZodType<T>): T {
  return parseInput(schema, req.body ?? {}, 'body');
}

export function parseQuery<T>(req: Request, schema: ZodType<T>): T {
  return parseInput(schema, req.query ?? {}, 'query');
}

export function parseParams<T>(req: Request, schema: ZodType<T>): T {
  return parseInput(schema, req.params ?? {}, 'params');
}

// ── Error mapping ────────────────────────────────────────────────────────

export interface MappedError {
  status: number;
  body: ErrorEnvelope;
  headers: Record<string, string>;
  /** True for unexpected errors (logged with the stack). */
  unexpected: boolean;
}

/**
 * Map any thrown value to an envelope. Recognises HttpError, NotImplementedError
 * and duck-typed domain errors that carry a known `code` (e.g. FND-4's
 * CreditsExhaustedError `{ code: 'credits_exhausted', bucket, resetsAt, upgradable }`,
 * VersionConflictError `{ code: 'version_conflict', currentVersion }`) plus an
 * optional `details`. Everything else is a 500 `internal_error` whose message
 * is never leaked.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof HttpError) {
    const body: ErrorEnvelope = { success: false, code: err.code, error: err.message };
    if (err.details !== undefined) body.details = err.details;
    const headers: Record<string, string> = { ...(err.headers ?? {}) };
    if (err.code === 'rate_limited' && !headers['Retry-After']) {
      const retry = retryAfterFromDetails(err.details);
      if (retry !== undefined) headers['Retry-After'] = String(retry);
    }
    return { status: err.status, body, headers, unexpected: false };
  }
  const e = err as { code?: unknown; message?: unknown; details?: unknown } | null;
  if (e && isErrorCode(e.code) && e.code !== 'internal_error') {
    const code = e.code;
    const details = e.details !== undefined ? e.details : domainDetails(err as Record<string, unknown>);
    const body: ErrorEnvelope = {
      success: false,
      code,
      error: typeof e.message === 'string' && e.message ? e.message : DEFAULT_ERROR_MESSAGES[code],
    };
    if (details !== undefined) body.details = details;
    const headers: Record<string, string> = {};
    const retry = code === 'rate_limited' ? retryAfterFromDetails(details) : undefined;
    if (retry !== undefined) headers['Retry-After'] = String(retry);
    return { status: ERROR_STATUS[code], body, headers, unexpected: false };
  }
  return {
    status: 500,
    body: { success: false, code: 'internal_error', error: DEFAULT_ERROR_MESSAGES.internal_error },
    headers: {},
    unexpected: true,
  };
}

const DOMAIN_DETAIL_KEYS = ['bucket', 'resetsAt', 'upgradable', 'currentVersion', 'otherBrandUrl', 'retryAfterSec'] as const;

function domainDetails(err: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of DOMAIN_DETAIL_KEYS) {
    if (err[k] !== undefined) out[k] = err[k] instanceof Date ? (err[k] as Date).toISOString() : err[k];
  }
  return Object.keys(out).length ? out : undefined;
}

export type ErrorLogger = (err: unknown, req: Request) => void;

function defaultErrorLogger(err: unknown, req: Request): void {
  // eslint-disable-next-line no-console
  console.error(`[http] ${req.method} ${req.originalUrl} failed:`, err);
}

function sendMapped(res: Response, mapped: MappedError): void {
  for (const [k, v] of Object.entries(mapped.headers)) res.setHeader(k, v);
  res.status(mapped.status).json(mapped.body);
}

/**
 * Async route wrapper. The handler may return a value (sent as `ok(data)`),
 * write the response itself, or throw (mapped by `mapError`).
 *
 *   router.get('/', route(async (req) => service.get(userId(req))));
 */
export function route<T>(
  handler: (req: Request, res: Response) => Promise<T> | T,
  options: { status?: number; logError?: ErrorLogger } = {},
): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const result = await handler(req, res);
      if (res.headersSent || res.writableEnded) return;
      ok(res, result === undefined ? null : result, options.status ?? 200);
    } catch (err) {
      const mapped = mapError(err);
      if (mapped.unexpected) (options.logError ?? defaultErrorLogger)(err, req);
      if (res.headersSent) return;
      sendMapped(res, mapped);
    }
  };
}

/** Express error middleware for feature routers (mount last). */
export function errorHandler(logError: ErrorLogger = defaultErrorLogger) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const mapped = mapError(err);
    if (mapped.unexpected) logError(err, req);
    sendMapped(res, mapped);
  };
}

/** The authenticated user id, or a 401 HttpError. */
export function requireUserId(req: Request): string {
  const id = (req as Request & { user?: { id?: unknown } }).user?.id;
  if (typeof id === 'string' && id) return id;
  throw new HttpError('unauthorized');
}

// ── D3 provenance (server twin of SourceNote) ────────────────────────────

/**
 * One sample rule (TASK_PLAN.md §2.2): an aggregate (pay medians included)
 * needs at least this many rows in one currency and period, and shows N.
 * Mirrors `MIN_SAMPLE` in components/features/common/SourceNote.tsx.
 */
export const MIN_SAMPLE = 20;

/** Where a number came from. `ai_estimate` renders as "Estimate". */
export type SourceKind =
  | 'posting'
  | 'provider'
  | 'employer'
  | 'public_record'
  | 'aggregate'
  | 'user'
  | 'ai_estimate'
  | (string & {});

/** Every non-user number on the wire (ARCH §2.14). */
export interface Sourced<T> {
  value: T;
  source: SourceKind;
  /** Rows behind an aggregate; required for aggregates. */
  sampleSize?: number;
  /** ISO timestamp of the data. */
  asOf: string;
  method?: string;
  url?: string;
}

export function meetsMinSample(sampleSize: number | null | undefined, min: number = MIN_SAMPLE): boolean {
  return typeof sampleSize === 'number' && Number.isFinite(sampleSize) && sampleSize >= min;
}

/** Build a `Sourced<T>`; returns null for unknown values (render "—", never 0). */
export function sourced<T>(
  value: T | null | undefined,
  meta: Omit<Sourced<T>, 'value' | 'asOf'> & { asOf: Date | string },
): Sourced<T> | null {
  if (value === null || value === undefined) return null;
  const asOf = meta.asOf instanceof Date ? meta.asOf.toISOString() : meta.asOf;
  return { ...meta, value, asOf };
}

/**
 * An aggregate is published only when its sample meets MIN_SAMPLE;
 * below that the caller gets null (the UI shows "Not enough data").
 */
export function sourcedAggregate<T>(
  value: T | null | undefined,
  meta: Omit<Sourced<T>, 'value' | 'asOf' | 'sampleSize'> & { asOf: Date | string; sampleSize: number },
  min: number = MIN_SAMPLE,
): Sourced<T> | null {
  if (!meetsMinSample(meta.sampleSize, min)) return null;
  return sourced(value, meta);
}
