// server/src/platform/credits/errors.ts
//
// Errors thrown by the credit and entitlement services, and their HTTP
// mapping (ARCHITECTURE.md §7.3). Routes map `CreditsExhaustedError` to
// `402 credits_exhausted`; the client shows the three-way sheet (Get Pro ·
// wait until `resetsAt` · continue without it, PRODUCT §6.4).

import type { CreditWindow } from './windows.js';

export class CreditsExhaustedError extends Error {
  readonly code = 'credits_exhausted' as const;
  readonly status = 402;
  readonly bucket: string;
  readonly resetsAt: Date;
  /** True when a sellable plan raises this bucket's cap above the user's. */
  readonly upgradable: boolean;
  readonly cap: number;
  readonly window: CreditWindow;

  constructor(input: { bucket: string; resetsAt: Date; upgradable: boolean; cap: number; window: CreditWindow }) {
    super(`No ${input.bucket} credits left in this ${input.window}`);
    this.name = 'CreditsExhaustedError';
    this.bucket = input.bucket;
    this.resetsAt = input.resetsAt;
    this.upgradable = input.upgradable;
    this.cap = input.cap;
    this.window = input.window;
  }

  toJSON() {
    return {
      error: this.code,
      bucket: this.bucket,
      resetsAt: this.resetsAt.toISOString(),
      upgradable: this.upgradable,
      cap: this.cap,
      window: this.window,
    };
  }
}

/**
 * The same idempotency key came back for an action that was already paid for
 * (or is still running). `withCredit` refuses to run the action again for
 * free; the route answers 409 and the client shows the earlier result.
 */
export class CreditReplayError extends Error {
  readonly code: 'request_already_completed' | 'request_in_progress';
  readonly status = 409;
  readonly reservationId: string;

  constructor(reservationId: string, state: 'committed' | 'reserved') {
    super(state === 'committed' ? 'This request was already completed' : 'This request is still running');
    this.name = 'CreditReplayError';
    this.code = state === 'committed' ? 'request_already_completed' : 'request_in_progress';
    this.reservationId = reservationId;
  }
}

export class ReservationNotFoundError extends Error {
  readonly code = 'reservation_not_found' as const;
  readonly status = 404;
  constructor(readonly reservationId: string) {
    super(`Credit reservation ${reservationId} not found`);
    this.name = 'ReservationNotFoundError';
  }
}

/** commit after release, or release after commit. */
export class ReservationStateError extends Error {
  readonly code = 'reservation_state' as const;
  readonly status = 409;
  constructor(
    readonly reservationId: string,
    readonly currentStatus: string,
    readonly attempted: 'commit' | 'release',
  ) {
    super(`Cannot ${attempted} reservation ${reservationId}: it is ${currentStatus}`);
    this.name = 'ReservationStateError';
  }
}

export class UnknownBucketError extends Error {
  readonly code = 'unknown_bucket' as const;
  readonly status = 400;
  constructor(readonly bucket: string) {
    super(`Unknown credit bucket "${bucket}"`);
    this.name = 'UnknownBucketError';
  }
}

export class InvalidIdempotencyKeyError extends Error {
  readonly code = 'invalid_idempotency_key' as const;
  readonly status = 400;
  constructor() {
    super('An idempotency key of 1–200 characters is required');
    this.name = 'InvalidIdempotencyKeyError';
  }
}

/**
 * The database could not take the credit transaction in time (it could not
 * start, or it ran out of time and was rolled back). Nothing was reserved or
 * spent, so the same request can be sent again. Routes answer 503 with
 * `retryable: true`; the original database error is kept as `cause` and is
 * logged by the store.
 */
export class CreditStoreBusyError extends Error {
  readonly code = 'credits_busy' as const;
  readonly status = 503;
  readonly retryable = true;
  /** Seconds a client should wait before sending the request again. */
  readonly retryAfterSec = 5;

  constructor(options: { cause?: unknown } = {}) {
    super('We could not start this right now. Try again in a moment.', options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CreditStoreBusyError';
  }
}

export type CreditError =
  | CreditsExhaustedError
  | CreditReplayError
  | ReservationNotFoundError
  | ReservationStateError
  | UnknownBucketError
  | InvalidIdempotencyKeyError
  | CreditStoreBusyError;

export function isCreditError(err: unknown): err is CreditError {
  return (
    err instanceof CreditsExhaustedError ||
    err instanceof CreditReplayError ||
    err instanceof ReservationNotFoundError ||
    err instanceof ReservationStateError ||
    err instanceof UnknownBucketError ||
    err instanceof InvalidIdempotencyKeyError ||
    err instanceof CreditStoreBusyError
  );
}

/** `{ status, body }` for a credit error, or null for anything else (let the route's 500 handler take it). */
export function creditErrorToHttp(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof CreditsExhaustedError) return { status: err.status, body: err.toJSON() };
  if (err instanceof CreditReplayError) return { status: err.status, body: { error: err.code } };
  if (err instanceof CreditStoreBusyError) {
    return { status: err.status, body: { error: err.code, message: err.message, retryable: true, retryAfterSec: err.retryAfterSec } };
  }
  if (isCreditError(err)) return { status: err.status, body: { error: err.code } };
  return null;
}
