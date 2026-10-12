// @vitest-environment node
//
// SQL snapshot tests for the Postgres credit store: the statements that make
// reserve atomic (ARCH §7.3) are asserted verbatim, and the full reserve flow
// is driven through the Prisma store with recorded results.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../services/LoggerService.js', () => ({ logger: log }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { createSqlRecorder } from '../../test/sqlSnapshot.js';
import { DEFAULT_CREDIT_CATALOG } from './catalog.js';
import { createCreditService } from './CreditService.js';
import { createEntitlementService } from './EntitlementService.js';
import { CreditStoreBusyError, CreditsExhaustedError, creditErrorToHttp } from './errors.js';
import { SETTLE_BUDGET_MS, SETTLE_TX_LIMITS, createPrismaCreditStore, createPrismaCreditTx, isDbBusyError, retryWhenBusy } from './store.js';

/** A ledger row as `UPDATE "RACreditLedger" … RETURNING *` hands it back. */
const ledgerRow = (over: Record<string, unknown> = {}) => ({
  id: 'L1',
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
  createdAt: new Date('2026-10-10T12:00:00Z'),
  settledAt: null,
  ...over,
});

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

beforeEach(() => {
  for (const fn of Object.values(log)) fn.mockReset();
});

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

  it('reserves a window in ONE statement that creates the row if missing and re-checks the cap', async () => {
    const { sql, tx } = harness([[{ used: 0, reserved: 1 }], []]);
    const t = createPrismaCreditTx(tx as never);
    expect(await t.reserveWindow('u1', 'tailor', 'd:2026-10-10', 1, 2)).toBe(true);
    expect(await t.reserveWindow('u1', 'tailor', 'd:2026-10-10', 1, 2)).toBe(false);
    expect(sql.calls).toHaveLength(2);
    expect(sql.texts()[0]).toBe(
      'INSERT INTO "RACreditWindow" ("userId", "bucket", "windowKey", "used", "reserved", "updatedAt") ' +
        'SELECT $1::text, $2::text, $3::text, 0, $4::int, now() WHERE $5::int <= $6::int ' +
        'ON CONFLICT ("userId", "bucket", "windowKey") DO UPDATE ' +
        'SET "reserved" = "RACreditWindow"."reserved" + $7::int, "updatedAt" = now() ' +
        'WHERE "RACreditWindow"."used" + "RACreditWindow"."reserved" + $8::int <= $9::int ' +
        'RETURNING "used", "reserved"',
    );
    expect(sql.calls[0].values).toEqual(['u1', 'tailor', 'd:2026-10-10', 1, 1, 2, 1, 1, 2]);
  });

  it('records the source and settles with one UPDATE … RETURNING each (no read-back)', async () => {
    const at = new Date('2026-10-10T12:00:05Z');
    const { sql, tx } = harness([
      [ledgerRow({ fromSource: 'window' })],
      [ledgerRow({ fromSource: 'window', status: 'committed', settledAt: at, refId: 'r1' })],
      [],
      [],
    ]);
    const t = createPrismaCreditTx(tx as never);
    expect(await t.setLedgerSource('L1', 'window', 'd:2026-10-10')).toMatchObject({ id: 'L1', fromSource: 'window', amount: 1 });
    expect(await t.settleLedger('L1', 'committed', at, 'r1')).toMatchObject({ status: 'committed', settledAt: at, refId: 'r1' });
    // Not reserved any more → no row comes back.
    expect(await t.settleLedger('L1', 'released', at)).toBeNull();
    await expect(t.setLedgerSource('gone', 'window', null)).rejects.toThrow('credit ledger row gone is missing');
    expect(sql.texts()[0]).toBe('UPDATE "RACreditLedger" SET "fromSource" = $1, "windowKey" = $2 WHERE "id" = $3 RETURNING *');
    expect(sql.texts()[1]).toBe(
      'UPDATE "RACreditLedger" SET "status" = $1, "settledAt" = $2, "refId" = COALESCE($3, "refId") WHERE "id" = $4 AND "status" = \'reserved\' RETURNING *',
    );
    expect(sql.calls[1].values).toEqual(['committed', at, 'r1', 'L1']);
    // No refId given → the stored one is kept (COALESCE(NULL, "refId")).
    expect(sql.calls[2].values).toEqual(['released', at, null, 'L1']);
    expect(sql.calls).toHaveLength(4);
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
    // insert → L1, window statement → no row, grant → no row
    const { sql, store, txOptions } = harness([[{ id: 'L1' }], [], []]);
    const err = await service(store).reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(CreditsExhaustedError);
    expect(txOptions).toEqual([{ isolationLevel: 'ReadCommitted' }]);
    expect(sql.texts().map((t) => t.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO "RACreditLedger"',
      'INSERT INTO "RACreditWindow"',
      'UPDATE "RACreditGrant" SET',
    ]);
  });

  it('a window reserve is three statements and a commit is two (round trips against a remote database)', async () => {
    const at = new Date('2026-10-10T12:00:00Z');
    const { sql, store, fake } = harness([
      [{ id: 'L1' }],
      [{ used: 0, reserved: 1 }],
      [ledgerRow({ fromSource: 'window' })],
      [ledgerRow({ fromSource: 'window', status: 'committed', settledAt: at })],
      1,
    ]);
    const credits = service(store);
    const r = await credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' });
    expect(r).toMatchObject({ id: 'L1', status: 'reserved', fromSource: 'window', windowKey: 'd:2026-10-10', replayed: false });
    expect(sql.calls).toHaveLength(3);
    const c = await credits.commit(r.id);
    expect(c.status).toBe('committed');
    expect(sql.texts().slice(3).map((t) => t.split(' ').slice(0, 3).join(' '))).toEqual(['UPDATE "RACreditLedger" SET', 'UPDATE "RACreditWindow" SET']);
    // Nothing went through the model API (each call there is another round trip).
    expect(fake.$rows('rACreditLedger')).toHaveLength(0);
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

describe('a database that is too busy for the transaction', () => {
  const P2028_START = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' });
  const P2028_EXPIRED = Object.assign(
    new Error(
      'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5884 ms passed since the start of the transaction.',
    ),
    { code: 'P2028' },
  );

  function busyStore(errors: unknown[]) {
    const queue = [...errors];
    const sql = createSqlRecorder({ results: [] });
    const fake = createFakePrisma();
    let started = 0;
    const db = {
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        started += 1;
        const next = queue.shift();
        if (next) throw next;
        return fn({ ...sql.client, rACreditLedger: fake.rACreditLedger });
      },
      rACreditLedger: fake.rACreditLedger,
      rACreditGrant: fake.rACreditGrant,
      rACreditWindow: fake.rACreditWindow,
    };
    return { store: createPrismaCreditStore(async () => db as never), started: () => started };
  }

  it('recognises the two P2028 shapes and the pool connect timeout, and nothing else', () => {
    expect(isDbBusyError(P2028_START)).toBe(true);
    expect(isDbBusyError(P2028_EXPIRED)).toBe(true);
    expect(isDbBusyError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isDbBusyError(new Error('wrapped', { cause: P2028_START }))).toBe(true);
    expect(isDbBusyError(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))).toBe(false);
    expect(isDbBusyError(new Error('boom'))).toBe(false);
    expect(isDbBusyError(null)).toBe(false);
  });

  it('reserve fails fast with a retryable 503 instead of a bare 500, and is not repeated', async () => {
    for (const cause of [P2028_START, P2028_EXPIRED]) {
      const { store, started } = busyStore([cause]);
      const err = await service(store).reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }).catch((e) => e);
      expect(err).toBeInstanceOf(CreditStoreBusyError);
      expect(err.cause).toBe(cause);
      expect(creditErrorToHttp(err)).toEqual({
        status: 503,
        body: { error: 'credits_busy', message: 'We could not start this right now. Try again in a moment.', retryable: true, retryAfterSec: 5 },
      });
      expect(started()).toBe(1);
      // The failure is in the error log with the database's own message.
      expect(log.error).toHaveBeenLastCalledWith(
        'CREDITS',
        'credit transaction failed: the database was busy',
        expect.objectContaining({ code: 'P2028', error: cause.message, elapsedMs: expect.any(Number) }),
      );
    }
  });

  it('other database errors and credit outcomes pass through unchanged', async () => {
    const boom = new Error('column does not exist');
    const { store } = busyStore([boom]);
    await expect(store.transaction(async () => 1)).rejects.toBe(boom);
    expect(log.error).toHaveBeenCalledWith('CREDITS', 'credit transaction failed', expect.objectContaining({ error: 'column does not exist' }));
    log.error.mockReset();
    const exhausted = new CreditsExhaustedError({ bucket: 'tailor', resetsAt: new Date(), upgradable: true, cap: 2, window: 'day' });
    await expect(
      busyStore([]).store.transaction(async () => {
        throw exhausted;
      }),
    ).rejects.toBe(exhausted);
    // Running out of credits is an answer, not a failure.
    expect(log.error).not.toHaveBeenCalled();
  });

  it('retryWhenBusy repeats only busy failures, and only as many times as there are waits', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new CreditStoreBusyError();
      return 'ok';
    };
    await expect(retryWhenBusy(flaky, [0, 0])).resolves.toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryWhenBusy(flaky, [0])).rejects.toBeInstanceOf(CreditStoreBusyError);
    expect(calls).toBe(2);
    let other = 0;
    await expect(
      retryWhenBusy(async () => {
        other += 1;
        throw new Error('boom');
      }, [0, 0]),
    ).rejects.toThrow('boom');
    expect(other).toBe(1);
  });

  it('retryWhenBusy stops at its time budget, however many waits are left', async () => {
    // Each attempt blocks for 3 s (`maxWait`) and then fails busy.
    let clock = 0;
    let calls = 0;
    const blocked = async () => {
      calls += 1;
      clock += 3_000;
      throw new CreditStoreBusyError();
    };
    await expect(retryWhenBusy(blocked, [150, 500], { budgetMs: SETTLE_BUDGET_MS, clock: () => clock })).rejects.toBeInstanceOf(CreditStoreBusyError);
    // 3 s used, 3.15 s < 6 s: one more. 6 s used: stop (the third try is never made).
    expect(calls).toBe(2);
    // An attempt that already used the whole budget is not repeated at all.
    calls = 0;
    clock = 0;
    await expect(retryWhenBusy(blocked, [150, 500], { budgetMs: 3_000, clock: () => clock })).rejects.toBeInstanceOf(CreditStoreBusyError);
    expect(calls).toBe(1);
    // Fast failures inside the budget still get every retry.
    calls = 0;
    await expect(
      retryWhenBusy(
        async () => {
          calls += 1;
          throw new CreditStoreBusyError();
        },
        [0, 0],
        { budgetMs: SETTLE_BUDGET_MS, clock: () => 0 },
      ),
    ).rejects.toBeInstanceOf(CreditStoreBusyError);
    expect(calls).toBe(3);
  });

  it('per-call limits reach Prisma as maxWait and timeout; without them the client-wide defaults apply', async () => {
    const { store, txOptions } = harness([]);
    await store.transaction(async () => 1);
    await store.transaction(async () => 1, SETTLE_TX_LIMITS);
    await store.transaction(async () => 1, { timeoutMs: 1_000 });
    expect(txOptions).toEqual([
      { isolationLevel: 'ReadCommitted' },
      { isolationLevel: 'ReadCommitted', maxWait: 3_000, timeout: 5_000 },
      { isolationLevel: 'ReadCommitted', timeout: 1_000 },
    ]);
  });

  it('commit and release ask for the short settle limits', async () => {
    const reserved = ledgerRow({ fromSource: 'window', windowKey: 'd:2026-10-10' });
    for (const settle of ['commit', 'release'] as const) {
      const { store, txOptions } = harness([[{ ...reserved, status: settle === 'commit' ? 'committed' : 'released' }], 1]);
      if (settle === 'commit') await service(store).commit('L1');
      else await service(store).release('L1', 'cancelled');
      expect(txOptions).toEqual([{ isolationLevel: 'ReadCommitted', maxWait: SETTLE_TX_LIMITS.maxWaitMs, timeout: SETTLE_TX_LIMITS.timeoutMs }]);
    }
  });
});
