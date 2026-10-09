// @vitest-environment node
//
// SQL snapshot tests for the Postgres credit store: the statements that make
// reserve atomic (ARCH §7.3) are asserted verbatim, and the full reserve flow
// is driven through the Prisma store with recorded results.
import { describe, expect, it } from 'vitest';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { createSqlRecorder } from '../../test/sqlSnapshot.js';
import { DEFAULT_CREDIT_CATALOG } from './catalog.js';
import { createCreditService } from './CreditService.js';
import { createEntitlementService } from './EntitlementService.js';
import { CreditsExhaustedError } from './errors.js';
import { createPrismaCreditStore, createPrismaCreditTx } from './store.js';

function harness(results: unknown[]) {
  const sql = createSqlRecorder({ results });
  const fake = createFakePrisma();
  const tx = { ...sql.client, rACreditLedger: fake.rACreditLedger };
  const txOptions: unknown[] = [];
  const db = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>, opts?: unknown) => {
      txOptions.push(opts);
      return fn(tx);
    },
    rACreditLedger: fake.rACreditLedger,
    rACreditGrant: fake.rACreditGrant,
    rACreditWindow: fake.rACreditWindow,
  };
  const store = createPrismaCreditStore(async () => db as never);
  return { sql, fake, store, txOptions, tx };
}

function service(store: ReturnType<typeof createPrismaCreditStore>) {
  return createCreditService({
    store,
    entitlements: createEntitlementService({
      source: { loadAccount: async () => ({ brand: 'roboapply', timezone: 'UTC', subscription: null }), loadOverrides: async () => [] },
      loadCatalog: async (b) => DEFAULT_CREDIT_CATALOG[b],
      proSellable: () => true,
      memoTtlMs: 0,
    }),
    now: () => new Date('2026-10-10T12:00:00Z'),
    writeDeductionLog: async () => undefined,
  });
}

describe('Postgres credit statements', () => {
  it('inserts the ledger row with ON CONFLICT on the idempotency key', async () => {
    const { sql, tx } = harness([[{ id: 'L1' }]]);
    const id = await createPrismaCreditTx(tx as never).insertLedger({
      userId: 'u1',
      bucket: 'tailor',
      amount: 1,
      status: 'reserved',
      fromSource: 'pending',
      windowKey: 'd:2026-10-10',
      idempotencyKey: 'u1:tailor:k',
      refType: null,
      refId: null,
      sku: 'ra_tailor_v2',
      now: new Date('2026-10-10T12:00:00Z'),
    });
    expect(id).toBe('L1');
    expect(sql.last()!.text).toMatch(/^INSERT INTO "RACreditLedger" .* ON CONFLICT \("idempotencyKey"\) DO NOTHING RETURNING "id"$/);
    expect(sql.last()!.values).toContain('u1:tailor:k');
  });

  it('reserves with one conditional UPDATE that re-checks the cap', async () => {
    const { sql, tx } = harness([0, [{ used: 0, reserved: 1 }]]);
    const t = createPrismaCreditTx(tx as never);
    await t.ensureWindow('u1', 'tailor', 'd:2026-10-10');
    expect(await t.reserveWindow('u1', 'tailor', 'd:2026-10-10', 1, 2)).toBe(true);
    expect(sql.texts()[0]).toBe(
      'INSERT INTO "RACreditWindow" ("userId", "bucket", "windowKey", "used", "reserved", "updatedAt") VALUES ($1, $2, $3, 0, 0, now()) ON CONFLICT ("userId", "bucket", "windowKey") DO NOTHING',
    );
    expect(sql.texts()[1]).toBe(
      'UPDATE "RACreditWindow" SET "reserved" = "reserved" + $1, "updatedAt" = now() WHERE "userId" = $2 AND "bucket" = $3 AND "windowKey" = $4 AND "used" + "reserved" + $5 <= $6 RETURNING "used", "reserved"',
    );
    expect(sql.calls[1].values).toEqual([1, 'u1', 'tailor', 'd:2026-10-10', 1, 2]);
  });

  it('takes a grant with FOR UPDATE SKIP LOCKED', async () => {
    const { sql, tx } = harness([[{ id: 'g1' }]]);
    expect(await createPrismaCreditTx(tx as never).takeGrant('u1', 'tailor', 1, new Date('2026-10-10T12:00:00Z'))).toBe('g1');
    const text = sql.last()!.text;
    expect(text).toContain('"bucket" IN ($3, \'*\')');
    expect(text).toContain('ORDER BY "expiresAt" ASC NULLS LAST, "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED');
    expect(text).toMatch(/AND "remaining" >= \$\d+ RETURNING "id"$/);
  });

  it('commits and releases windows without going below zero', async () => {
    const { sql, tx } = harness([]);
    const t = createPrismaCreditTx(tx as never);
    await t.commitWindow('u1', 'tailor', 'd:2026-10-10', 1);
    await t.releaseWindow('u1', 'tailor', 'd:2026-10-10', 1);
    await t.restoreGrant('g1', 1);
    expect(sql.texts()[0]).toContain('SET "used" = "used" + $1, "reserved" = GREATEST("reserved" - $2, 0)');
    expect(sql.texts()[1]).toContain('SET "reserved" = GREATEST("reserved" - $1, 0)');
    expect(sql.texts()[2]).toBe('UPDATE "RACreditGrant" SET "remaining" = LEAST("remaining" + $1, "amount") WHERE "id" = $2');
  });
});

describe('reserve flow over the Postgres store', () => {
  it('runs in a READ COMMITTED transaction: ledger → window → grant → exhausted', async () => {
    // insert → L1, ensureWindow → 0, conditional update → no row, grant → no row
    const { sql, store, txOptions } = harness([[{ id: 'L1' }], 0, [], []]);
    const err = await service(store).reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(CreditsExhaustedError);
    expect(txOptions).toEqual([{ isolationLevel: 'ReadCommitted' }]);
    expect(sql.texts().map((t) => t.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO "RACreditLedger"',
      'INSERT INTO "RACreditWindow"',
      'UPDATE "RACreditWindow" SET',
      'UPDATE "RACreditGrant" SET',
    ]);
  });

  it('returns the existing reservation on an idempotency conflict without touching the window', async () => {
    const { sql, store, fake } = harness([[]]);
    fake.$rows('rACreditLedger').push({
      id: 'L0',
      userId: 'u1',
      bucket: 'tailor',
      amount: 1,
      status: 'committed',
      fromSource: 'window',
      windowKey: 'd:2026-10-10',
      idempotencyKey: 'u1:tailor:k',
      refType: null,
      refId: null,
      sku: null,
      createdAt: new Date(),
      settledAt: new Date(),
    });
    const r = await service(store).reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' });
    expect(r).toMatchObject({ id: 'L0', replayed: true, status: 'committed' });
    expect(sql.calls).toHaveLength(1);
  });
});
