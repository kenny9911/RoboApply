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
//   2. window: create the row if missing, then the conditional UPDATE.
//   3. otherwise a live grant for the bucket or '*'.
//   4. otherwise roll back and throw CreditsExhaustedError{bucket, resetsAt, upgradable}.
// Every plan has a cap (fair use for Pro), so there is no "unlimited" path.
//
// commit moves reserved → used and writes the UsageDeductionLog row (success-
// only billing). release gives the window units or grant units back.
// `releaseStale()` is called by the `jobs-maintain` cron (reservations older
// than 15 minutes).

import { logger } from '../../services/LoggerService.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import type { BrandId } from '../brand/registry.js';
import { isWindowBucket, WINDOW_BUCKETS, type WindowBucket } from './catalog.js';
import { entitlementService as defaultEntitlements, type EntitlementService, type ResolvedEntitlements } from './EntitlementService.js';
import {
  CreditReplayError,
  CreditsExhaustedError,
  InvalidIdempotencyKeyError,
  ReservationNotFoundError,
  ReservationStateError,
  UnknownBucketError,
} from './errors.js';
import { createPrismaCreditStore, type CreditStore, type LedgerRow, type LedgerStatus } from './store.js';
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

      await tx.ensureWindow(opts.userId, opts.bucket, windowKey);
      if (await tx.reserveWindow(opts.userId, opts.bucket, windowKey, units, b.cap)) {
        await tx.setLedgerSource(id, 'window', windowKey);
        const row = await tx.findLedgerById(id);
        return toReservation(row!, false);
      }
      if (b.grantable) {
        const grantId = await tx.takeGrant(opts.userId, opts.bucket, units, at);
        if (grantId) {
          await tx.setLedgerSource(id, `grant:${grantId}`, null);
          const row = await tx.findLedgerById(id);
          return toReservation(row!, false);
        }
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
    const { row, transitioned } = await store.transaction(async (tx) => {
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
    });
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
    const row = await store.transaction(async (tx) => {
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
    });
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
    await commit(reservation.id);
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
