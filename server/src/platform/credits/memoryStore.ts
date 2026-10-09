// server/src/platform/credits/memoryStore.ts
//
// In-memory CreditStore with the same per-statement semantics as the
// Postgres store (store.ts): each CreditTx method is atomic, transactions
// interleave between statements (every method yields first), a failed
// transaction undoes its writes, and a second insert of an idempotency key
// that another open transaction holds waits for that transaction to finish
// (as a unique-index conflict does in Postgres).
//
// Used by logic tests here and by later WPs that need real credit behaviour
// without a database. No vitest imports.

import { randomUUID } from 'node:crypto';
import type { CreditStore, CreditTx, LedgerRow, NewGrant, WindowUsage } from './store.js';

export interface MemoryGrant {
  id: string;
  userId: string;
  bucket: string;
  amount: number;
  remaining: number;
  reason: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface MemoryWindow {
  userId: string;
  bucket: string;
  windowKey: string;
  used: number;
  reserved: number;
}

export interface MemoryCreditStore extends CreditStore {
  ledger: LedgerRow[];
  windows: MemoryWindow[];
  grants: MemoryGrant[];
  /** Number of transactions that rolled back (for assertions). */
  rollbacks(): number;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createMemoryCreditStore(seed: { grants?: Partial<MemoryGrant>[]; windows?: MemoryWindow[] } = {}): MemoryCreditStore {
  const ledger: LedgerRow[] = [];
  const windows: MemoryWindow[] = (seed.windows ?? []).map((w) => ({ ...w }));
  const grants: MemoryGrant[] = (seed.grants ?? []).map((g) => ({
    id: g.id ?? randomUUID(),
    userId: g.userId ?? 'u1',
    bucket: g.bucket ?? '*',
    amount: g.amount ?? g.remaining ?? 0,
    remaining: g.remaining ?? g.amount ?? 0,
    reason: g.reason ?? 'admin',
    expiresAt: g.expiresAt ?? null,
    createdAt: g.createdAt ?? new Date(0),
  }));
  /** idempotencyKey → completion promise of the transaction that inserted it but has not finished. */
  const pendingKeys = new Map<string, Promise<void>>();
  let rollbackCount = 0;

  const findWindow = (userId: string, bucket: string, windowKey: string) =>
    windows.find((w) => w.userId === userId && w.bucket === bucket && w.windowKey === windowKey);

  function makeTx(undo: (() => void)[], done: Promise<void>, ownedKeys: string[]): CreditTx {
    return {
      async insertLedger(row) {
        await tick();
        for (;;) {
          const pending = pendingKeys.get(row.idempotencyKey);
          if (!pending || ownedKeys.includes(row.idempotencyKey)) break;
          await pending;
        }
        if (ledger.some((l) => l.idempotencyKey === row.idempotencyKey)) return null;
        const created: LedgerRow = {
          id: randomUUID(),
          userId: row.userId,
          bucket: row.bucket,
          amount: row.amount,
          status: row.status,
          fromSource: row.fromSource,
          windowKey: row.windowKey,
          idempotencyKey: row.idempotencyKey,
          refType: row.refType,
          refId: row.refId,
          sku: row.sku,
          createdAt: row.now,
          settledAt: null,
        };
        ledger.push(created);
        pendingKeys.set(row.idempotencyKey, done);
        ownedKeys.push(row.idempotencyKey);
        undo.push(() => {
          const i = ledger.indexOf(created);
          if (i >= 0) ledger.splice(i, 1);
        });
        return created.id;
      },
      async findLedgerByKey(key) {
        await tick();
        const row = ledger.find((l) => l.idempotencyKey === key);
        return row ? { ...row } : null;
      },
      async findLedgerById(id) {
        await tick();
        const row = ledger.find((l) => l.id === id);
        return row ? { ...row } : null;
      },
      async rearmLedger(id, input) {
        await tick();
        const row = ledger.find((l) => l.id === id);
        if (!row || row.status !== 'released') return false;
        const before = { ...row };
        Object.assign(row, { status: 'reserved', fromSource: 'pending', amount: input.amount, windowKey: input.windowKey, settledAt: null });
        undo.push(() => Object.assign(row, before));
        return true;
      },
      async setLedgerSource(id, fromSource, windowKey) {
        await tick();
        const row = ledger.find((l) => l.id === id);
        if (!row) throw new Error(`ledger ${id} missing`);
        const before = { ...row };
        row.fromSource = fromSource;
        row.windowKey = windowKey;
        undo.push(() => Object.assign(row, before));
      },
      async settleLedger(id, to, now, refId) {
        await tick();
        const row = ledger.find((l) => l.id === id);
        if (!row || row.status !== 'reserved') return null;
        const before = { ...row };
        row.status = to;
        row.settledAt = now;
        if (refId) row.refId = refId;
        undo.push(() => Object.assign(row, before));
        return { ...row };
      },
      async ensureWindow(userId, bucket, windowKey) {
        await tick();
        if (findWindow(userId, bucket, windowKey)) return;
        const w: MemoryWindow = { userId, bucket, windowKey, used: 0, reserved: 0 };
        windows.push(w);
        undo.push(() => {
          const i = windows.indexOf(w);
          if (i >= 0 && w.used === 0 && w.reserved === 0) windows.splice(i, 1);
        });
      },
      async reserveWindow(userId, bucket, windowKey, units, cap) {
        await tick();
        const w = findWindow(userId, bucket, windowKey);
        if (!w || w.used + w.reserved + units > cap) return false;
        w.reserved += units;
        undo.push(() => {
          w.reserved -= units;
        });
        return true;
      },
      async commitWindow(userId, bucket, windowKey, units) {
        await tick();
        const w = findWindow(userId, bucket, windowKey);
        if (!w) return;
        const before = { ...w };
        w.used += units;
        w.reserved = Math.max(w.reserved - units, 0);
        undo.push(() => Object.assign(w, before));
      },
      async releaseWindow(userId, bucket, windowKey, units) {
        await tick();
        const w = findWindow(userId, bucket, windowKey);
        if (!w) return;
        const before = { ...w };
        w.reserved = Math.max(w.reserved - units, 0);
        undo.push(() => Object.assign(w, before));
      },
      async takeGrant(userId, bucket, units, now) {
        await tick();
        const live = grants
          .filter(
            (g) =>
              g.userId === userId &&
              (g.bucket === bucket || g.bucket === '*') &&
              g.remaining >= units &&
              (!g.expiresAt || g.expiresAt.getTime() > now.getTime()),
          )
          .sort((a, b) => {
            const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
            const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
            return ea - eb || a.createdAt.getTime() - b.createdAt.getTime();
          });
        const g = live[0];
        if (!g) return null;
        g.remaining -= units;
        undo.push(() => {
          g.remaining += units;
        });
        return g.id;
      },
      async restoreGrant(grantId, units) {
        await tick();
        const g = grants.find((x) => x.id === grantId);
        if (!g) return;
        const before = g.remaining;
        g.remaining = Math.min(g.remaining + units, g.amount);
        undo.push(() => {
          g.remaining = before;
        });
      },
    };
  }

  return {
    ledger,
    windows,
    grants,
    rollbacks: () => rollbackCount,
    async transaction(fn) {
      const undo: (() => void)[] = [];
      const ownedKeys: string[] = [];
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        const result = await fn(makeTx(undo, done, ownedKeys));
        return result;
      } catch (err) {
        for (const u of undo.reverse()) u();
        rollbackCount += 1;
        throw err;
      } finally {
        for (const k of ownedKeys) if (pendingKeys.get(k) === done) pendingKeys.delete(k);
        finish();
      }
    },
    async findLedgerById(id) {
      const row = ledger.find((l) => l.id === id);
      return row ? { ...row } : null;
    },
    async readWindows(userId, keys): Promise<WindowUsage[]> {
      return windows
        .filter((w) => w.userId === userId && keys.some((k) => k.bucket === w.bucket && k.windowKey === w.windowKey))
        .map((w) => ({ bucket: w.bucket, windowKey: w.windowKey, used: w.used, reserved: w.reserved }));
    },
    async grantBalances(userId, now) {
      const out: Record<string, number> = {};
      for (const g of grants) {
        if (g.userId !== userId || g.remaining <= 0) continue;
        if (g.expiresAt && g.expiresAt.getTime() <= now.getTime()) continue;
        out[g.bucket] = (out[g.bucket] ?? 0) + g.remaining;
      }
      return out;
    },
    async createGrant(grant: NewGrant) {
      const id = randomUUID();
      grants.push({ id, ...grant, remaining: grant.amount, createdAt: new Date() });
      return id;
    },
    async listStaleReservations(before, limit) {
      return ledger
        .filter((l) => l.status === 'reserved' && l.createdAt.getTime() < before.getTime())
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit)
        .map((l) => ({ ...l }));
    },
  };
}
