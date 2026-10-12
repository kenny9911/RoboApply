// server/src/platform/credits/store.ts
//
// Storage seam for CreditService. The reserve/commit/release algorithm lives
// once in CreditService.ts and talks to a `CreditTx` (one database
// transaction); this file implements it over Postgres with the statements of
// ARCHITECTURE.md §7.3 (its window INSERT and conditional UPDATE are folded
// into one statement here):
//
//   ledger   INSERT … ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING id
//   window   one statement: INSERT … SELECT … WHERE u <= cap
//            ON CONFLICT … DO UPDATE SET reserved = reserved + u
//            WHERE used + reserved + u <= cap
//   grant    UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)
//
// Under READ COMMITTED the ON CONFLICT DO UPDATE takes the row lock and
// evaluates its WHERE on the latest committed row, so concurrent reserves can
// never push `used + reserved` past the cap.
//
// The database is remote, so every statement inside a transaction is a round
// trip made while holding a pooled connection. A window reserve is three
// statements (ledger, window, source) and a commit or release is two; each
// write returns the row it changed instead of reading it back.
// `memoryStore.ts` is the in-memory twin used by logic tests.

import { randomUUID } from 'node:crypto';
import type { ExtendedPrismaClient, ExtendedTransactionClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import { CreditStoreBusyError, isCreditError } from './errors.js';

export type LedgerStatus = 'reserved' | 'committed' | 'released';

export interface LedgerRow {
  id: string;
  userId: string;
  bucket: string;
  amount: number;
  status: LedgerStatus;
  /** 'pending' while a reservation is being placed, then 'window' | 'grant:<id>' | 'mock_credit'. */
  fromSource: string;
  windowKey: string | null;
  idempotencyKey: string;
  refType: string | null;
  refId: string | null;
  sku: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface NewLedgerRow {
  userId: string;
  bucket: string;
  amount: number;
  status: LedgerStatus;
  fromSource: string;
  windowKey: string | null;
  idempotencyKey: string;
  refType: string | null;
  refId: string | null;
  sku: string | null;
  now: Date;
}

export interface WindowUsage {
  bucket: string;
  windowKey: string;
  used: number;
  reserved: number;
}

export interface NewGrant {
  userId: string;
  bucket: string;
  amount: number;
  reason: string;
  expiresAt: Date | null;
}

/** Operations inside one transaction. Every method is a single atomic statement. */
export interface CreditTx {
  /** Insert a ledger row; null when the idempotency key already exists. */
  insertLedger(row: NewLedgerRow): Promise<string | null>;
  findLedgerByKey(idempotencyKey: string): Promise<LedgerRow | null>;
  findLedgerById(id: string): Promise<LedgerRow | null>;
  /** released → reserved for a retried key; false when the row is not released. */
  rearmLedger(id: string, input: { amount: number; windowKey: string | null }): Promise<boolean>;
  /** Record where the units came from; returns the updated row. */
  setLedgerSource(id: string, fromSource: string, windowKey: string | null): Promise<LedgerRow>;
  /** reserved → `to`; returns the updated row, or null when the row was not reserved. */
  settleLedger(id: string, to: 'committed' | 'released', now: Date, refId?: string | null): Promise<LedgerRow | null>;
  /** The conditional reserve (creates the window row when it is missing); true when it fit under the cap. */
  reserveWindow(userId: string, bucket: string, windowKey: string, units: number, cap: number): Promise<boolean>;
  commitWindow(userId: string, bucket: string, windowKey: string, units: number): Promise<void>;
  releaseWindow(userId: string, bucket: string, windowKey: string, units: number): Promise<void>;
  /** Take `units` from the soonest-expiring live grant for the bucket (or '*'); returns the grant id. */
  takeGrant(userId: string, bucket: string, units: number, now: Date): Promise<string | null>;
  restoreGrant(grantId: string, units: number): Promise<void>;
}

/** Per-call limits for one transaction; anything left out uses the client-wide defaults (lib/prisma.ts). */
export interface CreditTxLimits {
  /** Longest wait for a connection and BEGIN. */
  maxWaitMs?: number;
  /** Longest the transaction may run once it has started. */
  timeoutMs?: number;
}

/**
 * Limits for the settle step (commit, release, the practice-claim settle).
 * It runs after the action has finished, while the person is still waiting
 * for an answer that is already decided, so it must not wait as long as a
 * reserve may: a settle that cannot be written is finished by `jobs-maintain`.
 */
export const SETTLE_TX_LIMITS: Readonly<Required<CreditTxLimits>> = { maxWaitMs: 3_000, timeoutMs: 5_000 };
/** No new settle attempt starts once this much time has passed since the first one began. */
export const SETTLE_BUDGET_MS = 6_000;

export interface CreditStore {
  transaction<T>(fn: (tx: CreditTx) => Promise<T>, limits?: CreditTxLimits): Promise<T>;
  findLedgerById(id: string): Promise<LedgerRow | null>;
  readWindows(userId: string, keys: { bucket: string; windowKey: string }[]): Promise<WindowUsage[]>;
  /** Remaining grant units per bucket ('*' included) that are live at `now`. */
  grantBalances(userId: string, now: Date): Promise<Record<string, number>>;
  createGrant(grant: NewGrant): Promise<string>;
  /** Reservations still `reserved` and created before `before` (oldest first). */
  listStaleReservations(before: Date, limit: number): Promise<LedgerRow[]>;
}

// ── Postgres implementation ────────────────────────────────────────────────

type Db = Pick<ExtendedPrismaClient, '$transaction' | 'rACreditLedger' | 'rACreditGrant' | 'rACreditWindow'>;
type Tx = Pick<ExtendedTransactionClient, '$queryRaw' | '$executeRaw' | 'rACreditLedger'>;

const LEDGER_SELECT = {
  id: true,
  userId: true,
  bucket: true,
  amount: true,
  status: true,
  fromSource: true,
  windowKey: true,
  idempotencyKey: true,
  refType: true,
  refId: true,
  sku: true,
  createdAt: true,
  settledAt: true,
} as const;

function toLedger(row: Record<string, unknown> | null): LedgerRow | null {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.userId),
    bucket: String(row.bucket),
    amount: Number(row.amount),
    status: row.status as LedgerStatus,
    fromSource: String(row.fromSource),
    windowKey: (row.windowKey as string | null) ?? null,
    idempotencyKey: String(row.idempotencyKey),
    refType: (row.refType as string | null) ?? null,
    refId: (row.refId as string | null) ?? null,
    sku: (row.sku as string | null) ?? null,
    createdAt: row.createdAt as Date,
    settledAt: (row.settledAt as Date | null) ?? null,
  };
}

export function createPrismaCreditTx(tx: Tx): CreditTx {
  return {
    async insertLedger(row) {
      const id = randomUUID();
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "RACreditLedger"
          ("id", "userId", "bucket", "amount", "status", "fromSource", "windowKey", "idempotencyKey", "refType", "refId", "sku", "createdAt")
        VALUES
          (${id}, ${row.userId}, ${row.bucket}, ${row.amount}, ${row.status}, ${row.fromSource}, ${row.windowKey}, ${row.idempotencyKey}, ${row.refType}, ${row.refId}, ${row.sku}, ${row.now})
        ON CONFLICT ("idempotencyKey") DO NOTHING
        RETURNING "id"`;
      return rows[0]?.id ?? null;
    },
    async findLedgerByKey(idempotencyKey) {
      return toLedger(await tx.rACreditLedger.findUnique({ where: { idempotencyKey }, select: LEDGER_SELECT }));
    },
    async findLedgerById(id) {
      return toLedger(await tx.rACreditLedger.findUnique({ where: { id }, select: LEDGER_SELECT }));
    },
    async rearmLedger(id, input) {
      const res = await tx.rACreditLedger.updateMany({
        where: { id, status: 'released' },
        data: { status: 'reserved', fromSource: 'pending', amount: input.amount, windowKey: input.windowKey, settledAt: null },
      });
      return res.count === 1;
    },
    async setLedgerSource(id, fromSource, windowKey) {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        UPDATE "RACreditLedger"
           SET "fromSource" = ${fromSource}, "windowKey" = ${windowKey}
         WHERE "id" = ${id}
        RETURNING *`;
      const row = toLedger(rows[0] ?? null);
      if (!row) throw new Error(`credit ledger row ${id} is missing`);
      return row;
    },
    async settleLedger(id, to, now, refId) {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        UPDATE "RACreditLedger"
           SET "status" = ${to}, "settledAt" = ${now}, "refId" = COALESCE(${refId || null}, "refId")
         WHERE "id" = ${id} AND "status" = 'reserved'
        RETURNING *`;
      return toLedger(rows[0] ?? null);
    },
    async reserveWindow(userId, bucket, windowKey, units, cap) {
      // One statement: a missing window row is created already holding the
      // units (only when they fit under the cap); an existing row is updated
      // under its row lock, and the cap is re-checked against the locked row.
      const rows = await tx.$queryRaw<{ used: number; reserved: number }[]>`
        INSERT INTO "RACreditWindow" ("userId", "bucket", "windowKey", "used", "reserved", "updatedAt")
        SELECT ${userId}::text, ${bucket}::text, ${windowKey}::text, 0, ${units}::int, now()
         WHERE ${units}::int <= ${cap}::int
        ON CONFLICT ("userId", "bucket", "windowKey") DO UPDATE
           SET "reserved" = "RACreditWindow"."reserved" + ${units}::int, "updatedAt" = now()
         WHERE "RACreditWindow"."used" + "RACreditWindow"."reserved" + ${units}::int <= ${cap}::int
        RETURNING "used", "reserved"`;
      return rows.length === 1;
    },
    async commitWindow(userId, bucket, windowKey, units) {
      await tx.$executeRaw`
        UPDATE "RACreditWindow"
           SET "used" = "used" + ${units}, "reserved" = GREATEST("reserved" - ${units}, 0), "updatedAt" = now()
         WHERE "userId" = ${userId} AND "bucket" = ${bucket} AND "windowKey" = ${windowKey}`;
    },
    async releaseWindow(userId, bucket, windowKey, units) {
      await tx.$executeRaw`
        UPDATE "RACreditWindow"
           SET "reserved" = GREATEST("reserved" - ${units}, 0), "updatedAt" = now()
         WHERE "userId" = ${userId} AND "bucket" = ${bucket} AND "windowKey" = ${windowKey}`;
    },
    async takeGrant(userId, bucket, units, now) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "RACreditGrant"
           SET "remaining" = "remaining" - ${units}
         WHERE "id" = (
           SELECT "id" FROM "RACreditGrant"
            WHERE "userId" = ${userId} AND "bucket" IN (${bucket}, '*') AND "remaining" >= ${units}
              AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
            ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
           AND "remaining" >= ${units}
        RETURNING "id"`;
      return rows[0]?.id ?? null;
    },
    async restoreGrant(grantId, units) {
      await tx.$executeRaw`
        UPDATE "RACreditGrant" SET "remaining" = LEAST("remaining" + ${units}, "amount") WHERE "id" = ${grantId}`;
    },
  };
}

/** Prisma codes for "the transaction could not start or ran out of time" and "no pooled connection in time". */
const BUSY_CODES = new Set(['P2028', 'P2024']);
const BUSY_MESSAGES = [
  'unable to start a transaction in the given time',
  'transaction already closed',
  'expired transaction',
  'timeout exceeded when trying to connect',
];

/**
 * True when the database could not take the transaction in time: Prisma's
 * transaction API error (P2028: could not start within `maxWait`, or ran past
 * `timeout`) or the pool's own connect timeout. Nothing was committed, so the
 * caller may try again.
 */
export function isDbBusyError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && BUSY_CODES.has(e.code)) return true;
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (message && BUSY_MESSAGES.some((m) => message.includes(m))) return true;
  return depth < 2 && e.cause !== undefined ? isDbBusyError(e.cause, depth + 1) : false;
}

export interface RetryWhenBusyOptions {
  /**
   * Total time allowed, counted from the start of the first attempt: no new
   * attempt starts once the time used plus the next wait reaches it. Without
   * it only the number of waits limits the retries.
   */
  budgetMs?: number;
  /** Clock in milliseconds (tests). */
  clock?: () => number;
}

/**
 * Run an idempotent store call again when the database was busy. Only for
 * calls that are safe to repeat (commit and release are; reserve is not: a
 * repeat with the same key would read as a replay).
 *
 * Each attempt can itself block for as long as its transaction limits allow,
 * so the number of attempts alone does not bound the wait. Pass `budgetMs`
 * (with short per-call limits, see SETTLE_TX_LIMITS) wherever someone is
 * waiting on the result.
 */
export async function retryWhenBusy<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = [150, 500],
  options: RetryWhenBusyOptions = {},
): Promise<T> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof CreditStoreBusyError) || attempt >= delaysMs.length) throw err;
      const wait = Math.max(0, delaysMs[attempt]);
      if (options.budgetMs !== undefined && clock() - startedAt + wait >= options.budgetMs) throw err;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export function createPrismaCreditStore(getDb: () => Promise<Db>): CreditStore {
  return {
    async transaction(fn, limits = {}) {
      const db = await getDb();
      const startedAt = Date.now();
      try {
        // maxWait / timeout come from the client-wide defaults in lib/prisma.ts
        // unless the caller passes its own (the settle step does).
        return await db.$transaction((tx) => fn(createPrismaCreditTx(tx as unknown as Tx)), {
          isolationLevel: 'ReadCommitted',
          ...(limits.maxWaitMs !== undefined ? { maxWait: limits.maxWaitMs } : {}),
          ...(limits.timeoutMs !== undefined ? { timeout: limits.timeoutMs } : {}),
        });
      } catch (err) {
        // Domain outcomes (no credits left, wrong state, …) are answers, not failures.
        if (isCreditError(err)) throw err;
        const busy = isDbBusyError(err);
        logger.error('CREDITS', busy ? 'credit transaction failed: the database was busy' : 'credit transaction failed', {
          elapsedMs: Date.now() - startedAt,
          code: (err as { code?: unknown } | null)?.code ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        if (busy) throw new CreditStoreBusyError({ cause: err });
        throw err;
      }
    },
    async findLedgerById(id) {
      const db = await getDb();
      return toLedger(await db.rACreditLedger.findUnique({ where: { id }, select: LEDGER_SELECT }));
    },
    async readWindows(userId, keys) {
      if (keys.length === 0) return [];
      const db = await getDb();
      const rows = await db.rACreditWindow.findMany({
        where: { userId, OR: keys.map((k) => ({ bucket: k.bucket, windowKey: k.windowKey })) },
        select: { bucket: true, windowKey: true, used: true, reserved: true },
      });
      return rows;
    },
    async grantBalances(userId, now) {
      const db = await getDb();
      const rows = await db.rACreditGrant.findMany({
        where: { userId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { bucket: true, remaining: true },
      });
      const out: Record<string, number> = {};
      for (const r of rows) out[r.bucket] = (out[r.bucket] ?? 0) + r.remaining;
      return out;
    },
    async createGrant(grant) {
      const db = await getDb();
      const row = await db.rACreditGrant.create({
        data: {
          userId: grant.userId,
          bucket: grant.bucket,
          amount: grant.amount,
          remaining: grant.amount,
          reason: grant.reason,
          expiresAt: grant.expiresAt,
        },
        select: { id: true },
      });
      return row.id;
    },
    async listStaleReservations(before, limit) {
      const db = await getDb();
      const rows = await db.rACreditLedger.findMany({
        where: { status: 'reserved', createdAt: { lt: before } },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: LEDGER_SELECT,
      });
      return rows.map((r) => toLedger(r)!);
    },
  };
}
