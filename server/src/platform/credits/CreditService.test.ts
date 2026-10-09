// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CreditReplayError, CreditsExhaustedError, InvalidIdempotencyKeyError, ReservationNotFoundError, ReservationStateError, UnknownBucketError, creditErrorToHttp } from './errors.js';
import { createCreditTestKit } from './testkit.js';
import type { AccountSnapshot } from './EntitlementService.js';

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
