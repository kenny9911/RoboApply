// server/src/platform/credits/CreditService.ts
//
// Atomic credit consumption: reserve → commit / release (ARCHITECTURE.md
// §7.3; PRODUCT_PLAN.md §6.1 rule 5: debited only on success).
//
//   reserve({ userId, bucket, units, idempotencyKey, refType, refId, sku })
//   commit(reservationId, { refId? })
//   release(reservationId, reason)
//   withCredit(opts, fn)   reserve → fn() → commit on success / release on throw
//
// Reserve, inside one READ COMMITTED transaction:
//   1. insert the ledger row (ON CONFLICT on the idempotency key). A replay
//      returns the existing reservation; a replay of a RELEASED reservation
//      (the earlier attempt failed) re-arms it so a retry can still be paid.
//   2. window: one conditional statement that creates the row if missing.
//   3. otherwise a live grant for the bucket or '*'.
//   4. otherwise roll back and throw CreditsExhaustedError{bucket, resetsAt, upgradable}.
// Every plan has a cap (fair use for Pro), so there is no "unlimited" path.
//
// commit moves reserved → used and writes the UsageDeductionLog row (success-
// only billing). release gives the window units or grant units back.
// `releaseStale()` is called by the `jobs-maintain` cron (reservations older
// than 15 minutes).
//
// When the database is too busy to take a transaction the store throws
// CreditStoreBusyError (503, retryable; logged by the store):
//   reserve  fails fast with it: nothing ran, nothing was reserved.
//   commit / release  are safe to repeat, so they are tried again briefly:
//               short transaction limits and a total time budget
//               (SETTLE_TX_LIMITS, SETTLE_BUDGET_MS), because the action is
//               already over and someone is waiting for its answer.
//   withCredit  keeps the result of an action that worked even when the
//               commit still cannot be written: the person is not shown an
//               error for work that is done, and is not charged for it (the
//               reservation is released by `jobs-maintain`).

import { logger } from '../../services/LoggerService.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import type { BrandId } from '../brand/registry.js';
import { isWindowBucket, WINDOW_BUCKETS, type WindowBucket } from './catalog.js';
import { entitlementService as defaultEntitlements, type EntitlementService, type ResolvedEntitlements } from './EntitlementService.js';
import {
  CreditReplayError,
  CreditStoreBusyError,
  CreditsExhaustedError,
  InvalidIdempotencyKeyError,
  ReservationNotFoundError,
  ReservationStateError,
  UnknownBucketError,
} from './errors.js';
import {
  SETTLE_BUDGET_MS,
  SETTLE_TX_LIMITS,
  createPrismaCreditStore,
  retryWhenBusy,
  type CreditStore,
  type LedgerRow,
  type LedgerStatus,
} from './store.js';
import { currentWindow, resetsAtFor, windowKeyFor, type CreditWindow } from './windows.js';

export const STALE_RESERVATION_MS = 15 * 60_000;
const MAX_IDEMPOTENCY_KEY = 200;

export interface ReserveOptions {
  userId: string;
  bucket: WindowBucket;
  units?: number;
  /** Client `Idempotency-Key` or a server ref (e.g. the tailor session id). Scoped per user and bucket. */
  idempotencyKey: string;
  refType?: string | null;
  refId?: string | null;
  /** UsageDeductionLog SKU; defaults to the bucket's catalog SKU. */
  sku?: string | null;
  /** Request brand fallback when the user row has none. */
  brand?: BrandId;
}

export interface Reservation {
  id: string;
  userId: string;
  bucket: string;
  units: number;
  status: LedgerStatus;
  /** 'window' | 'grant:<id>' */
  fromSource: string;
  windowKey: string | null;
  idempotencyKey: string;
  /** True when the idempotency key already had a live reservation (nothing new was reserved). */
  replayed: boolean;
}

export interface DeductionLogWriter {
  (input: {
    userId: string;
    sku: string;
    units: number;
    source: string;
    tierAtCommit: string | null;
    requestId: string | null;
    relatedEntityType: string | null;
    relatedEntityId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

// Writes the existing UsageDeductionLog audit row directly (the matchBilling
// writer's SKU union does not include the ra_* SKUs, and the column is free-form).
const defaultDeductionWriter: DeductionLogWriter = async (input) => {
  const { default: prisma } = await import('../../lib/prisma.js');
  await prisma.usageDeductionLog.create({
    data: {
      userId: input.userId,
      sku: input.sku,
      units: input.units,
      source: input.source,
      tierAtCommit: input.tierAtCommit,
      requestId: input.requestId,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      metadata: input.metadata as object,
    },
  });
};

export interface CreditServiceDeps {
  store?: CreditStore;
  entitlements?: EntitlementService;
  now?: () => Date;
  writeDeductionLog?: DeductionLogWriter;
  /** Waits between tries of a commit or release the database was too busy for (default 150 ms, then 500 ms). */
  settleRetryDelaysMs?: readonly number[];
  /** Total time a commit or release may spend before it stops trying again (default SETTLE_BUDGET_MS). */
  settleBudgetMs?: number;
  /** Millisecond clock for that budget (tests). */
  clock?: () => number;
}

export interface BucketUsage {
  bucket: WindowBucket;
  cap: number;
  window: CreditWindow;
  used: number;
  reserved: number;
  /** cap − used − reserved, never below 0. Grants are reported separately. */
  remaining: number;
  /** Grant units usable for this bucket (bucket-specific plus '*'); 0 when the bucket is not grantable. */
  grantRemaining: number;
  resetsAt: Date;
}

export interface CreditService {
  reserve(opts: ReserveOptions): Promise<Reservation>;
  commit(reservationId: string, opts?: { refId?: string | null }): Promise<Reservation>;
  release(reservationId: string, reason: string): Promise<Reservation>;
  /**
   * The usual call site. Throws CreditReplayError (409) when the key was
   * already spent or is still running, so a replayed key never buys a free rerun.
   */
  withCredit<T>(opts: ReserveOptions, fn: (reservation: Reservation) => Promise<T>): Promise<T>;
  usage(userId: string, options?: { brand?: BrandId; entitlements?: ResolvedEntitlements }): Promise<BucketUsage[]>;
  /** Bonus credits (referral rewards, admin grants, purchased packs). `bucket` may be '*' (any grantable bucket). */
  grant(input: { userId: string; bucket: WindowBucket | '*'; amount: number; reason: string; expiresAt?: Date | null }): Promise<string>;
  /** Release reservations stuck in `reserved` (crashed requests). Returns how many were released. */
  releaseStale(options?: { olderThanMs?: number; limit?: number }): Promise<number>;
}

function toReservation(row: LedgerRow, replayed: boolean): Reservation {
  return {
    id: row.id,
    userId: row.userId,
    bucket: row.bucket,
    units: row.amount,
    status: row.status,
    fromSource: row.fromSource,
    windowKey: row.windowKey,
    idempotencyKey: row.idempotencyKey,
    replayed,
  };
}

/** The stored key: '<userId>:<bucket>:<client key>' (ARCH §2.11). */
export function ledgerIdempotencyKey(userId: string, bucket: string, key: string): string {
  return `${userId}:${bucket}:${key}`;
}

function grantIdOf(fromSource: string): string | null {
  return fromSource.startsWith('grant:') ? fromSource.slice('grant:'.length) : null;
}

export function createCreditService(deps: CreditServiceDeps = {}): CreditService {
  const store = deps.store ?? createPrismaCreditStore(async () => (await import('../../lib/prisma.js')).default);
  const entitlements = deps.entitlements ?? defaultEntitlements;
  const now = deps.now ?? (() => new Date());
  const writeLog = deps.writeDeductionLog ?? defaultDeductionWriter;
  const settleDelays = deps.settleRetryDelaysMs ?? [150, 500];
  const settleRetry = { budgetMs: deps.settleBudgetMs ?? SETTLE_BUDGET_MS, ...(deps.clock ? { clock: deps.clock } : {}) };

  async function reserve(opts: ReserveOptions): Promise<Reservation> {
    if (!isWindowBucket(opts.bucket)) throw new UnknownBucketError(String(opts.bucket));
    const key = typeof opts.idempotencyKey === 'string' ? opts.idempotencyKey.trim() : '';
    if (!key || key.length > MAX_IDEMPOTENCY_KEY) throw new InvalidIdempotencyKeyError();
    const units = Math.max(1, Math.floor(opts.units ?? 1));
    const ent = await entitlements.resolve(opts.userId, opts.brand ? { brand: opts.brand } : undefined);
    const b = ent.buckets[opts.bucket];
    const at = now();
    const windowKey = windowKeyFor(b.window, at, ent.timezone);
    const fullKey = ledgerIdempotencyKey(opts.userId, opts.bucket, key);

    return store.transaction(async (tx) => {
      let id = await tx.insertLedger({
        userId: opts.userId,
        bucket: opts.bucket,
        amount: units,
        status: 'reserved',
        fromSource: 'pending',
        windowKey,
        idempotencyKey: fullKey,
        refType: opts.refType ?? null,
        refId: opts.refId ?? null,
        sku: opts.sku ?? b.sku,
        now: at,
      });
      if (!id) {
        const existing = await tx.findLedgerByKey(fullKey);
        if (!existing) throw new Error('credit ledger conflict without a row');
        if (existing.status !== 'released') return toReservation(existing, true);
        const rearmed = await tx.rearmLedger(existing.id, { amount: units, windowKey });
        if (!rearmed) {
          const cur = await tx.findLedgerByKey(fullKey);
          return toReservation(cur ?? existing, true);
        }
        id = existing.id;
      }

      if (await tx.reserveWindow(opts.userId, opts.bucket, windowKey, units, b.cap)) {
        return toReservation(await tx.setLedgerSource(id, 'window', windowKey), false);
      }
      if (b.grantable) {
        const grantId = await tx.takeGrant(opts.userId, opts.bucket, units, at);
        if (grantId) return toReservation(await tx.setLedgerSource(id, `grant:${grantId}`, null), false);
      }
      throw new CreditsExhaustedError({
        bucket: opts.bucket,
        resetsAt: resetsAtFor(b.window, at, ent.timezone),
        upgradable: ent.planProfile === 'free' && ent.proSellable && b.proCap > b.cap,
        cap: b.cap,
        window: b.window,
      });
    });
  }

  async function commit(reservationId: string, opts: { refId?: string | null } = {}): Promise<Reservation> {
    const at = now();
    // Safe to repeat: a second run finds the row committed and changes nothing.
    const { row, transitioned } = await retryWhenBusy(
      () =>
        store.transaction(async (tx) => {
          const settled = await tx.settleLedger(reservationId, 'committed', at, opts.refId ?? null);
          if (!settled) {
            const cur = await tx.findLedgerById(reservationId);
            if (!cur) throw new ReservationNotFoundError(reservationId);
            if (cur.status === 'committed') return { row: cur, transitioned: false };
            throw new ReservationStateError(reservationId, cur.status, 'commit');
          }
          if (settled.fromSource === 'window' && settled.windowKey) {
            await tx.commitWindow(settled.userId, settled.bucket, settled.windowKey, settled.amount);
          }
          return { row: settled, transitioned: true };
        }, SETTLE_TX_LIMITS),
      settleDelays,
      settleRetry,
    );
    if (transitioned && row.sku) {
      try {
        await writeLog({
          userId: row.userId,
          sku: row.sku,
          units: row.amount,
          source: row.fromSource === 'window' ? 'plan' : 'grant',
          tierAtCommit: null,
          requestId: getCurrentRequestId() ?? null,
          relatedEntityType: row.refType,
          relatedEntityId: row.refId,
          metadata: { bucket: row.bucket, reservationId: row.id, fromSource: row.fromSource, windowKey: row.windowKey },
        });
      } catch (err) {
        logger.warn('CREDITS', 'deduction log write failed', {
          reservationId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return toReservation(row, false);
  }

  async function release(reservationId: string, reason: string): Promise<Reservation> {
    const at = now();
    // Safe to repeat: a second run finds the row released and changes nothing.
    const row = await retryWhenBusy(
      () =>
        store.transaction(async (tx) => {
          const settled = await tx.settleLedger(reservationId, 'released', at);
          if (!settled) {
            const cur = await tx.findLedgerById(reservationId);
            if (!cur) throw new ReservationNotFoundError(reservationId);
            if (cur.status === 'released') return cur;
            throw new ReservationStateError(reservationId, cur.status, 'release');
          }
          if (settled.fromSource === 'window' && settled.windowKey) {
            await tx.releaseWindow(settled.userId, settled.bucket, settled.windowKey, settled.amount);
          }
          const grantId = grantIdOf(settled.fromSource);
          if (grantId) await tx.restoreGrant(grantId, settled.amount);
          return settled;
        }, SETTLE_TX_LIMITS),
      settleDelays,
      settleRetry,
    );
    logger.info('CREDITS', 'reservation released', { reservationId, bucket: row.bucket, reason });
    return toReservation(row, false);
  }

  async function withCredit<T>(opts: ReserveOptions, fn: (reservation: Reservation) => Promise<T>): Promise<T> {
    const reservation = await reserve(opts);
    if (reservation.replayed) {
      throw new CreditReplayError(reservation.id, reservation.status === 'committed' ? 'committed' : 'reserved');
    }
    let result: T;
    try {
      result = await fn(reservation);
    } catch (err) {
      try {
        await release(reservation.id, 'action_failed');
      } catch (releaseErr) {
        logger.warn('CREDITS', 'release after failure failed; jobs-maintain will release it', {
          reservationId: reservation.id,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
      throw err;
    }
    try {
      await commit(reservation.id);
    } catch (err) {
      // The action worked. A commit the database is too busy to take must not
      // turn finished work into an error (and a retry with the same key would
      // read as "still running"). The reservation stays `reserved` and
      // `jobs-maintain` releases it, so this use is not charged.
      if (!(err instanceof CreditStoreBusyError)) throw err;
      logger.error('CREDITS', 'commit failed after the action succeeded; the result is kept and the use is not charged', {
        reservationId: reservation.id,
        userId: reservation.userId,
        bucket: reservation.bucket,
        error: err.cause instanceof Error ? err.cause.message : err.message,
      });
    }
    return result;
  }

  async function usage(userId: string, options: { brand?: BrandId; entitlements?: ResolvedEntitlements } = {}): Promise<BucketUsage[]> {
    const ent = options.entitlements ?? (await entitlements.resolve(userId, options.brand ? { brand: options.brand } : undefined));
    const at = now();
    const windows = WINDOW_BUCKETS.map((bucket) => ({ bucket, ...currentWindow(ent.buckets[bucket].window, at, ent.timezone) }));
    const [rows, grants] = await Promise.all([
      store.readWindows(
        userId,
        windows.map((w) => ({ bucket: w.bucket, windowKey: w.windowKey })),
      ),
      store.grantBalances(userId, at),
    ]);
    return windows.map((w) => {
      const b = ent.buckets[w.bucket];
      const row = rows.find((r) => r.bucket === w.bucket && r.windowKey === w.windowKey);
      const used = row?.used ?? 0;
      const reserved = row?.reserved ?? 0;
      return {
        bucket: w.bucket,
        cap: b.cap,
        window: b.window,
        used,
        reserved,
        remaining: Math.max(0, b.cap - used - reserved),
        grantRemaining: b.grantable ? (grants[w.bucket] ?? 0) + (grants['*'] ?? 0) : 0,
        resetsAt: w.resetsAt,
      };
    });
  }

  async function grant(input: { userId: string; bucket: WindowBucket | '*'; amount: number; reason: string; expiresAt?: Date | null }): Promise<string> {
    if (input.bucket !== '*' && !isWindowBucket(input.bucket)) throw new UnknownBucketError(String(input.bucket));
    if (input.bucket === 'contact_lookup') throw new UnknownBucketError('contact_lookup');
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('grant amount must be a positive integer');
    const id = await store.createGrant({
      userId: input.userId,
      bucket: input.bucket,
      amount: input.amount,
      reason: input.reason,
      expiresAt: input.expiresAt ?? null,
    });
    entitlements.invalidate(input.userId);
    return id;
  }

  async function releaseStale(options: { olderThanMs?: number; limit?: number } = {}): Promise<number> {
    const before = new Date(now().getTime() - (options.olderThanMs ?? STALE_RESERVATION_MS));
    // Practice grants (practice.ts) are at-most-once: a stuck one is left for
    // an admin, never auto-released, so a crash can never grant twice.
    const stale = (await store.listStaleReservations(before, options.limit ?? 200)).filter((row) => row.bucket !== 'practice');
    let released = 0;
    for (const row of stale) {
      try {
        await release(row.id, 'stale');
        released += 1;
      } catch (err) {
        logger.warn('CREDITS', 'stale release failed', {
          reservationId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (stale.length) logger.info('CREDITS', 'stale reservations released', { released, found: stale.length });
    return released;
  }

  return { reserve, commit, release, withCredit, usage, grant, releaseStale };
}

/** The process-wide service (Postgres store, Prisma-backed entitlements). */
export const creditService: CreditService = createCreditService();
