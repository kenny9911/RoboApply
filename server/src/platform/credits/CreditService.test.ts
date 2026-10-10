// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CreditReplayError,
  CreditStoreBusyError,
  CreditsExhaustedError,
  InvalidIdempotencyKeyError,
  ReservationNotFoundError,
  ReservationStateError,
  UnknownBucketError,
  creditErrorToHttp,
} from './errors.js';
import { isErrorCode, mapError } from '../http.js';
import { createCreditService } from './CreditService.js';
import { createCreditTestKit } from './testkit.js';
import type { AccountSnapshot } from './EntitlementService.js';
import { SETTLE_TX_LIMITS, type CreditStore, type CreditTxLimits } from './store.js';

const PRO: AccountSnapshot = {
  brand: 'roboapply',
  timezone: null,
  subscription: { tier: 'pro', planKey: 'pro_monthly', status: 'active', interval: 'month', currentPeriodEnd: new Date('2027-01-01') },
};

describe('reserve → commit', () => {
  it('reserves from the window, commits to used, and writes the deduction log', async () => {
    const kit = createCreditTestKit();
    const r = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k1', refType: 'tailor_session', refId: 's1' });
    expect(r).toMatchObject({ status: 'reserved', fromSource: 'window', windowKey: 'd:2026-10-10', replayed: false, units: 1 });
    expect(kit.store.windows[0]).toMatchObject({ used: 0, reserved: 1 });
    expect(kit.store.ledger[0].idempotencyKey).toBe('u1:tailor:k1');

    const c = await kit.credits.commit(r.id);
    expect(c.status).toBe('committed');
    expect(kit.store.windows[0]).toMatchObject({ used: 1, reserved: 0 });
    expect(kit.deductionLogs).toEqual([
      expect.objectContaining({ userId: 'u1', sku: 'ra_tailor_v2', units: 1, source: 'plan', relatedEntityType: 'tailor_session', relatedEntityId: 's1' }),
    ]);
    // commit is idempotent and does not log twice
    await kit.credits.commit(r.id);
    expect(kit.deductionLogs).toHaveLength(1);
  });

  it('rejects unknown buckets, practice, and missing idempotency keys', async () => {
    const kit = createCreditTestKit();
    await expect(kit.credits.reserve({ userId: 'u1', bucket: 'nope' as never, idempotencyKey: 'k' })).rejects.toBeInstanceOf(UnknownBucketError);
    await expect(kit.credits.reserve({ userId: 'u1', bucket: 'practice' as never, idempotencyKey: 'k' })).rejects.toBeInstanceOf(UnknownBucketError);
    await expect(kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: '  ' })).rejects.toBeInstanceOf(InvalidIdempotencyKeyError);
  });
});

describe('caps', () => {
  it('throws CreditsExhaustedError past the Free cap with the local reset time', async () => {
    const kit = createCreditTestKit({ accounts: { u1: { brand: 'goapply', timezone: null, subscription: null } }, now: new Date('2026-10-10T17:30:00Z') });
    // GoApply free tailor cap is 3; Shanghai is already Oct 11.
    for (let i = 0; i < 3; i++) await kit.credits.commit((await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: `k${i}` })).id);
    const err = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k3' }).catch((e) => e);
    expect(err).toBeInstanceOf(CreditsExhaustedError);
    expect(err).toMatchObject({ bucket: 'tailor', upgradable: true, cap: 3, window: 'day' });
    expect(err.resetsAt.toISOString()).toBe('2026-10-11T16:00:00.000Z');
    expect(kit.store.ledger).toHaveLength(3); // the failed attempt rolled back
    expect(creditErrorToHttp(err)).toEqual({
      status: 402,
      body: { error: 'credits_exhausted', bucket: 'tailor', resetsAt: '2026-10-11T16:00:00.000Z', upgradable: true, cap: 3, window: 'day' },
    });
  });

  it('enforces the Pro fair-use cap and is not upgradable', async () => {
    const kit = createCreditTestKit({ accounts: { u1: PRO } });
    kit.store.windows.push({ userId: 'u1', bucket: 'tailor', windowKey: 'd:2026-10-10', used: 50, reserved: 0 });
    const err = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(CreditsExhaustedError);
    expect(err.upgradable).toBe(false);
    expect(err.cap).toBe(50);
  });

  it('is not upgradable when no Pro plan is on sale', async () => {
    const kit = createCreditTestKit({ proSellable: false });
    await kit.credits.reserve({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'a' });
    const err = await kit.credits.reserve({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'b' }).catch((e) => e);
    expect(err.upgradable).toBe(false);
  });

  it('never lets concurrent reserves exceed the cap', async () => {
    const kit = createCreditTestKit();
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => kit.credits.reserve({ userId: 'u1', bucket: 'cover_letter', idempotencyKey: `k${i}` })),
    );
    const ok = attempts.filter((a) => a.status === 'fulfilled');
    const exhausted = attempts.filter((a) => a.status === 'rejected' && a.reason instanceof CreditsExhaustedError);
    expect(ok).toHaveLength(2);
    expect(exhausted).toHaveLength(23);
    const w = kit.store.windows.find((x) => x.bucket === 'cover_letter')!;
    expect(w.used + w.reserved).toBe(2);
    expect(kit.store.ledger.filter((l) => l.bucket === 'cover_letter')).toHaveLength(2);
  });

  it('never double-spends one key under concurrency', async () => {
    const kit = createCreditTestKit();
    const results = await Promise.all(Array.from({ length: 5 }, () => kit.credits.reserve({ userId: 'u1', bucket: 'rewrite', idempotencyKey: 'same' })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(kit.store.windows.find((x) => x.bucket === 'rewrite')).toMatchObject({ reserved: 1 });
  });

  it('keeps contact lookup at zero even with grants', async () => {
    const kit = createCreditTestKit({ grants: [{ userId: 'u1', bucket: '*', amount: 10 }] });
    await expect(kit.credits.reserve({ userId: 'u1', bucket: 'contact_lookup', idempotencyKey: 'k' })).rejects.toBeInstanceOf(CreditsExhaustedError);
    expect(kit.store.grants[0].remaining).toBe(10);
  });
});

describe('idempotency', () => {
  it('returns the same reservation for a replayed key', async () => {
    const kit = createCreditTestKit();
    const a = await kit.credits.reserve({ userId: 'u1', bucket: 'fit_analysis', idempotencyKey: 'k' });
    const b = await kit.credits.reserve({ userId: 'u1', bucket: 'fit_analysis', idempotencyKey: 'k' });
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect(kit.store.windows[0].reserved).toBe(1);
  });

  it('scopes keys per user and bucket', async () => {
    const kit = createCreditTestKit();
    const a = await kit.credits.reserve({ userId: 'u1', bucket: 'fit_analysis', idempotencyKey: 'k' });
    const b = await kit.credits.reserve({ userId: 'u2', bucket: 'fit_analysis', idempotencyKey: 'k' });
    const c = await kit.credits.reserve({ userId: 'u1', bucket: 'outreach', idempotencyKey: 'k' });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('re-arms a released reservation when the same key is retried', async () => {
    const kit = createCreditTestKit();
    const a = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' });
    await kit.credits.release(a.id, 'action_failed');
    expect(kit.store.windows[0].reserved).toBe(0);
    const b = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' });
    expect(b).toMatchObject({ id: a.id, status: 'reserved', replayed: false, fromSource: 'window' });
    expect(kit.store.windows[0].reserved).toBe(1);
  });
});

describe('release', () => {
  it('restores the window allowance', async () => {
    const kit = createCreditTestKit();
    const a = await kit.credits.reserve({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'a' });
    await expect(kit.credits.reserve({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'b' })).rejects.toBeInstanceOf(CreditsExhaustedError);
    await kit.credits.release(a.id, 'cancelled');
    const b = await kit.credits.reserve({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'b' });
    expect(b.fromSource).toBe('window');
  });

  it('restores the grant it took', async () => {
    const kit = createCreditTestKit({ grants: [{ id: 'g1', userId: 'u1', bucket: 'resume_check', amount: 2 }] });
    await kit.credits.reserve({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'a' });
    const g = await kit.credits.reserve({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'b' });
    expect(g.fromSource).toBe('grant:g1');
    expect(kit.store.grants[0].remaining).toBe(1);
    await kit.credits.release(g.id, 'failed');
    expect(kit.store.grants[0].remaining).toBe(2);
  });

  it('is idempotent and refuses to release a committed reservation', async () => {
    const kit = createCreditTestKit();
    const a = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'a' });
    await kit.credits.release(a.id, 'x');
    await expect(kit.credits.release(a.id, 'x')).resolves.toMatchObject({ status: 'released' });
    await expect(kit.credits.commit(a.id)).rejects.toBeInstanceOf(ReservationStateError);
    const b = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'b' });
    await kit.credits.commit(b.id);
    await expect(kit.credits.release(b.id, 'x')).rejects.toBeInstanceOf(ReservationStateError);
    await expect(kit.credits.commit('missing')).rejects.toBeInstanceOf(ReservationNotFoundError);
  });

  it('releases stale reservations, but never practice grants', async () => {
    const kit = createCreditTestKit();
    const a = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'a' });
    kit.store.ledger.push({ ...kit.store.ledger[0], id: 'p1', bucket: 'practice', fromSource: 'mock_credit', idempotencyKey: 'u1:practice:x', windowKey: null });
    kit.setNow(new Date('2026-10-10T12:20:00Z'));
    const fresh = await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'b' });
    expect(await kit.credits.releaseStale()).toBe(1);
    expect(kit.store.ledger.find((l) => l.id === a.id)!.status).toBe('released');
    expect(kit.store.ledger.find((l) => l.id === fresh.id)!.status).toBe('reserved');
    expect(kit.store.ledger.find((l) => l.id === 'p1')!.status).toBe('reserved');
  });
});

describe('grants', () => {
  it('pays from a bucket grant or a "*" grant after the window, soonest expiry first, ignoring expired ones', async () => {
    const kit = createCreditTestKit({
      grants: [
        { id: 'expired', userId: 'u1', bucket: '*', amount: 5, expiresAt: new Date('2026-10-01') },
        { id: 'later', userId: 'u1', bucket: '*', amount: 1, expiresAt: new Date('2027-01-01') },
        { id: 'soon', userId: 'u1', bucket: 'tailor', amount: 1, expiresAt: new Date('2026-11-01') },
      ],
    });
    await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: '1' });
    await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: '2' });
    expect((await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: '3' })).fromSource).toBe('grant:soon');
    expect((await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: '4' })).fromSource).toBe('grant:later');
    await expect(kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: '5' })).rejects.toBeInstanceOf(CreditsExhaustedError);
  });

  it('creates grants and refuses contact lookup or bad amounts', async () => {
    const kit = createCreditTestKit();
    const id = await kit.credits.grant({ userId: 'u1', bucket: '*', amount: 10, reason: 'referral', expiresAt: new Date('2027-01-08') });
    expect(kit.store.grants.find((g) => g.id === id)).toMatchObject({ remaining: 10, reason: 'referral' });
    await expect(kit.credits.grant({ userId: 'u1', bucket: 'contact_lookup', amount: 1, reason: 'admin' })).rejects.toBeInstanceOf(UnknownBucketError);
    await expect(kit.credits.grant({ userId: 'u1', bucket: 'tailor', amount: 0, reason: 'admin' })).rejects.toThrow();
  });
});

describe('withCredit', () => {
  it('commits on success and releases on failure', async () => {
    const kit = createCreditTestKit();
    await expect(kit.credits.withCredit({ userId: 'u1', bucket: 'outreach', idempotencyKey: 'ok' }, async () => 'draft')).resolves.toBe('draft');
    await expect(
      kit.credits.withCredit({ userId: 'u1', bucket: 'outreach', idempotencyKey: 'boom' }, async () => {
        throw new Error('llm failed');
      }),
    ).rejects.toThrow('llm failed');
    const w = kit.store.windows.find((x) => x.bucket === 'outreach')!;
    expect(w).toMatchObject({ used: 1, reserved: 0 });
    expect(kit.store.ledger.map((l) => l.status).sort()).toEqual(['committed', 'released']);
  });

  it('never reruns an already-paid request for free', async () => {
    const kit = createCreditTestKit();
    let runs = 0;
    await kit.credits.withCredit({ userId: 'u1', bucket: 'outreach', idempotencyKey: 'k' }, async () => runs++);
    const err = await kit.credits.withCredit({ userId: 'u1', bucket: 'outreach', idempotencyKey: 'k' }, async () => runs++).catch((e) => e);
    expect(err).toBeInstanceOf(CreditReplayError);
    expect(err.code).toBe('request_already_completed');
    expect(creditErrorToHttp(err)).toEqual({ status: 409, body: { error: 'request_already_completed' } });
    expect(runs).toBe(1);
  });

  it('does not run the action when credits are exhausted', async () => {
    const kit = createCreditTestKit();
    let runs = 0;
    await kit.credits.withCredit({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'a' }, async () => runs++);
    await expect(kit.credits.withCredit({ userId: 'u1', bucket: 'resume_check', idempotencyKey: 'b' }, async () => runs++)).rejects.toBeInstanceOf(
      CreditsExhaustedError,
    );
    expect(runs).toBe(1);
  });
});

describe('usage', () => {
  it('reports cap, used, remaining, grants and reset per bucket', async () => {
    const kit = createCreditTestKit({ grants: [{ userId: 'u1', bucket: '*', amount: 3 }, { userId: 'u1', bucket: 'tailor', amount: 2 }] });
    await kit.credits.commit((await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'a' })).id);
    await kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'b' });
    const usage = await kit.credits.usage('u1');
    const tailor = usage.find((u) => u.bucket === 'tailor')!;
    expect(tailor).toMatchObject({ cap: 2, used: 1, reserved: 1, remaining: 0, grantRemaining: 5, window: 'day' });
    expect(tailor.resetsAt.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(usage.find((u) => u.bucket === 'contact_lookup')).toMatchObject({ cap: 0, grantRemaining: 0 });
    expect(usage.find((u) => u.bucket === 'ready_kits')).toMatchObject({ window: 'week', cap: 3 });
    expect(usage).toHaveLength(13);
  });
});

describe('when the database is too busy for a transaction', () => {
  /**
   * The memory store, except that the transactions numbered in `busyAt`
   * (1-based, in the order they start) fail the way the Postgres store does
   * when Prisma answers P2028: nothing is written.
   */
  function busyKit(busyAt: (n: number) => boolean, options: { busyCostMs?: number } = {}) {
    const kit = createCreditTestKit();
    let started = 0;
    /** A fake millisecond clock: every busy transaction "blocks" for `busyCostMs` before it fails. */
    let clockMs = 0;
    const limits: (CreditTxLimits | undefined)[] = [];
    const store: CreditStore = {
      ...kit.store,
      transaction: (fn, txLimits) => {
        started += 1;
        limits.push(txLimits);
        if (busyAt(started)) {
          clockMs += options.busyCostMs ?? 0;
          return Promise.reject(new CreditStoreBusyError({ cause: new Error('Unable to start a transaction in the given time.') }));
        }
        return kit.store.transaction(fn);
      },
    };
    const credits = createCreditService({
      store,
      entitlements: kit.entitlements,
      now: () => new Date('2026-10-10T12:00:00Z'),
      writeDeductionLog: async (row) => {
        kit.deductionLogs.push(row);
      },
      settleRetryDelaysMs: [0, 0],
      clock: () => clockMs,
    });
    return { kit, credits, started: () => started, limits };
  }

  it('reserve fails fast (one try) and the action never runs', async () => {
    const { kit, credits, started } = busyKit((n) => n === 1);
    let runs = 0;
    const err = await credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => runs++).catch((e) => e);
    expect(err).toBeInstanceOf(CreditStoreBusyError);
    expect(err).toMatchObject({ code: 'credits_busy', status: 503, retryable: true });
    expect(runs).toBe(0);
    expect(started()).toBe(1);
    expect(kit.store.ledger).toHaveLength(0);
    // The same key works on the next try: nothing was left behind.
    await expect(credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => 'done')).resolves.toBe('done');
    expect(kit.store.ledger.map((l) => l.status)).toEqual(['committed']);
  });

  it('a commit that hits a busy database is tried again and charges once', async () => {
    // tx 1 = reserve, tx 2 and 3 = commit (busy), tx 4 = commit (works)
    const { kit, credits, started } = busyKit((n) => n === 2 || n === 3);
    await expect(credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => 'resume')).resolves.toBe('resume');
    expect(started()).toBe(4);
    expect(kit.store.ledger.map((l) => l.status)).toEqual(['committed']);
    expect(kit.store.windows.find((w) => w.bucket === 'tailor')).toMatchObject({ used: 1, reserved: 0 });
    expect(kit.deductionLogs).toHaveLength(1);
  });

  it('work that succeeded is returned even when the commit cannot be written; the use is not charged', async () => {
    const { kit, credits, started } = busyKit((n) => n >= 2);
    await expect(credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => 'resume')).resolves.toBe('resume');
    // reserve + three commit tries
    expect(started()).toBe(4);
    expect(kit.store.ledger.map((l) => l.status)).toEqual(['reserved']);
    expect(kit.deductionLogs).toHaveLength(0);
    // jobs-maintain later releases the reservation, giving the unit back.
    kit.store.ledger[0].createdAt = new Date('2026-10-10T11:00:00Z');
    const maintenance = createCreditService({ store: kit.store, entitlements: kit.entitlements, now: () => new Date('2026-10-10T12:00:00Z'), writeDeductionLog: async () => undefined });
    expect(await maintenance.releaseStale()).toBe(1);
    expect(kit.store.windows.find((w) => w.bucket === 'tailor')).toMatchObject({ used: 0, reserved: 0 });
  });

  it('the settle step uses short transaction limits; reserve keeps the client-wide ones', async () => {
    const { credits, limits } = busyKit(() => false);
    await credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'ok' }, async () => 'done');
    await credits
      .withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'fails' }, async () => {
        throw new Error('llm failed');
      })
      .catch(() => undefined);
    // reserve, commit, reserve, release
    expect(limits).toEqual([undefined, SETTLE_TX_LIMITS, undefined, SETTLE_TX_LIMITS]);
    expect(SETTLE_TX_LIMITS).toEqual({ maxWaitMs: 3_000, timeoutMs: 5_000 });
  });

  it('finished work is not held for long: the commit stops trying once its time budget is spent', async () => {
    // Every commit attempt blocks for the full 3 s `maxWait` before it fails.
    // The first leaves room for one more (3 s used of 6 s); the second does not.
    const { kit, credits, started } = busyKit((n) => n >= 2, { busyCostMs: SETTLE_TX_LIMITS.maxWaitMs });
    await expect(credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => 'resume')).resolves.toBe('resume');
    // reserve + two commit tries (three without the budget)
    expect(started()).toBe(3);
    expect(kit.store.ledger.map((l) => l.status)).toEqual(['reserved']);
  });

  it('a transaction that ran out of time once it had started is not tried again', async () => {
    // maxWait + timeout: the whole budget went on the first attempt.
    const { credits, started } = busyKit((n) => n >= 2, { busyCostMs: SETTLE_TX_LIMITS.maxWaitMs + SETTLE_TX_LIMITS.timeoutMs });
    await expect(credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => 'resume')).resolves.toBe('resume');
    expect(started()).toBe(2);
  });

  it('a failed action is not held either: the release keeps to the same budget and the original error is thrown', async () => {
    const { kit, credits, started } = busyKit((n) => n >= 2, { busyCostMs: SETTLE_TX_LIMITS.maxWaitMs });
    await expect(
      credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => {
        throw new Error('llm failed');
      }),
    ).rejects.toThrow('llm failed');
    expect(started()).toBe(3);
    // Still reserved: jobs-maintain gives the unit back.
    expect(kit.store.ledger.map((l) => l.status)).toEqual(['reserved']);
  });

  it('a commit that fails for another reason still fails the call', async () => {
    const kit = createCreditTestKit();
    const err = await kit.credits
      .withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async (r) => {
        await kit.credits.release(r.id, 'cancelled');
        return 'resume';
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReservationStateError);
  });

  it('a release after a failed action is tried again, and the original error is the one thrown', async () => {
    // tx 1 = reserve, tx 2 = release (busy), tx 3 = release (works)
    const { kit, credits } = busyKit((n) => n === 2);
    await expect(
      credits.withCredit({ userId: 'u1', bucket: 'tailor', idempotencyKey: 'k' }, async () => {
        throw new Error('llm failed');
      }),
    ).rejects.toThrow('llm failed');
    expect(kit.store.ledger.map((l) => l.status)).toEqual(['released']);
    expect(kit.store.windows.find((w) => w.bucket === 'tailor')).toMatchObject({ used: 0, reserved: 0 });
  });
});

describe('CreditStoreBusyError on the wire', () => {
  it('carries everything a route needs: a code, a plain message, and when to try again', () => {
    const err = new CreditStoreBusyError({ cause: new Error('P2028') });
    expect(err).toMatchObject({ code: 'credits_busy', status: 503, retryable: true, retryAfterSec: 5 });
    expect(err.message).toBe('We could not start this right now. Try again in a moment.');
    expect(creditErrorToHttp(err)).toEqual({
      status: 503,
      body: { error: 'credits_busy', message: err.message, retryable: true, retryAfterSec: 5 },
    });
  });

  // Routes answer through platform/http.ts `mapError`, which only honours
  // codes registered in ERROR_STATUS. That file belongs to another group;
  // until `credits_busy: 503` is registered there a busy store still answers
  // 500 internal_error (FIX-9 request). This test starts running the moment
  // the code is registered and holds the two sides together.
  it.runIf(isErrorCode('credits_busy'))('mapError answers 503 credits_busy with retryAfterSec and never leaks the database error', () => {
    const mapped = mapError(new CreditStoreBusyError({ cause: new Error('Transaction API error: P2028 on db.internal:5432') }));
    expect(mapped.status).toBe(503);
    expect(mapped.unexpected).toBe(false);
    expect(mapped.body).toMatchObject({
      success: false,
      code: 'credits_busy',
      error: 'We could not start this right now. Try again in a moment.',
      details: { retryAfterSec: 5 },
    });
    expect(JSON.stringify(mapped.body)).not.toContain('P2028');
  });
});

describe('window rows', () => {
  it('a bucket with no allowance reserves nothing and leaves no window row', async () => {
    const kit = createCreditTestKit();
    await expect(kit.credits.reserve({ userId: 'u1', bucket: 'contact_lookup', idempotencyKey: 'k' })).rejects.toBeInstanceOf(CreditsExhaustedError);
    expect(kit.store.windows).toHaveLength(0);
    expect(kit.store.ledger).toHaveLength(0);
  });

  it('concurrent first reserves of a window never go past the cap', async () => {
    const kit = createCreditTestKit();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => kit.credits.reserve({ userId: 'u1', bucket: 'tailor', idempotencyKey: `k${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(kit.store.windows.filter((w) => w.bucket === 'tailor')).toEqual([expect.objectContaining({ used: 0, reserved: 2 })]);
  });
});
