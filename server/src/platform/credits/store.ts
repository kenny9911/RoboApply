// server/src/platform/credits/store.ts
//
// Storage seam for CreditService. The reserve/commit/release algorithm lives
// once in CreditService.ts and talks to a `CreditTx` (one database
// transaction); this file implements it over Postgres with the exact
// statements of ARCHITECTURE.md §7.3:
//
//   ledger   INSERT … ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING id
//   window   INSERT … ON CONFLICT DO NOTHING, then the conditional
//            UPDATE … SET reserved = reserved + u WHERE used + reserved + u <= cap
//   grant    UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)
//
// Under READ COMMITTED the conditional UPDATE takes the row lock and
// re-evaluates its WHERE after a concurrent writer commits, so concurrent
// reserves can never push `used + reserved` past the cap.
// `memoryStore.ts` is the in-memory twin used by logic tests.

import { randomUUID } from 'node:crypto';
import type { ExtendedPrismaClient, ExtendedTransactionClient } from '../../lib/prisma.js';

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
  setLedgerSource(id: string, fromSource: string, windowKey: string | null): Promise<void>;
  /** reserved → `to`; returns the updated row, or null when the row was not reserved. */
  settleLedger(id: string, to: 'committed' | 'released', now: Date, refId?: string | null): Promise<LedgerRow | null>;
  ensureWindow(userId: string, bucket: string, windowKey: string): Promise<void>;
  /** The conditional reserve; true when it fit under the cap. */
  reserveWindow(userId: string, bucket: string, windowKey: string, units: number, cap: number): Promise<boolean>;
  commitWindow(userId: string, bucket: string, windowKey: string, units: number): Promise<void>;
  releaseWindow(userId: string, bucket: string, windowKey: string, units: number): Promise<void>;
  /** Take `units` from the soonest-expiring live grant for the bucket (or '*'); returns the grant id. */
  takeGrant(userId: string, bucket: string, units: number, now: Date): Promise<string | null>;
  restoreGrant(grantId: string, units: number): Promise<void>;
}

export interface CreditStore {
  transaction<T>(fn: (tx: CreditTx) => Promise<T>): Promise<T>;
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
      await tx.rACreditLedger.update({ where: { id }, data: { fromSource, windowKey } });
    },
    async settleLedger(id, to, now, refId) {
      const res = await tx.rACreditLedger.updateMany({
        where: { id, status: 'reserved' },
        data: { status: to, settledAt: now, ...(refId ? { refId } : {}) },
      });
      if (res.count !== 1) return null;
      return toLedger(await tx.rACreditLedger.findUnique({ where: { id }, select: LEDGER_SELECT }));
    },
    async ensureWindow(userId, bucket, windowKey) {
      await tx.$executeRaw`
        INSERT INTO "RACreditWindow" ("userId", "bucket", "windowKey", "used", "reserved", "updatedAt")
        VALUES (${userId}, ${bucket}, ${windowKey}, 0, 0, now())
        ON CONFLICT ("userId", "bucket", "windowKey") DO NOTHING`;
    },
    async reserveWindow(userId, bucket, windowKey, units, cap) {
      const rows = await tx.$queryRaw<{ used: number; reserved: number }[]>`
        UPDATE "RACreditWindow"
           SET "reserved" = "reserved" + ${units}, "updatedAt" = now()
         WHERE "userId" = ${userId} AND "bucket" = ${bucket} AND "windowKey" = ${windowKey}
           AND "used" + "reserved" + ${units} <= ${cap}
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

export function createPrismaCreditStore(getDb: () => Promise<Db>): CreditStore {
  return {
    async transaction(fn) {
      const db = await getDb();
      return db.$transaction((tx) => fn(createPrismaCreditTx(tx as unknown as Tx)), { isolationLevel: 'ReadCommitted' });
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
