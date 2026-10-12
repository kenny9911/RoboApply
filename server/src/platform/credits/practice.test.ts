// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createMemoryCreditStore } from './memoryStore.js';
import { createPracticeCredits } from './practice.js';
import { SETTLE_TX_LIMITS, type CreditStore, type CreditTxLimits } from './store.js';

function setup(opts: { profile?: boolean; failFirst?: boolean; brands?: Record<string, string>; brandLookupFails?: boolean } = {}) {
  const store = createMemoryCreditStore();
  let balance = 0;
  let calls = 0;
  const practice = createPracticeCredits({
    store,
    hasSeekerProfile: async () => opts.profile ?? true,
    adjust: async ({ delta }) => {
      calls += 1;
      if (opts.failFirst && calls === 1) return null;
      balance += delta;
      return { balanceAfter: balance };
    },
    getBalance: async () => ({ credits: balance, tier: 'free', periodAllotment: null, renewedAt: null }),
    userBrand: async (userId) => {
      if (opts.brandLookupFails) throw new Error('database offline');
      return opts.brands?.[userId] ?? 'roboapply';
    },
    now: () => new Date('2026-10-10T12:00:00Z'),
  });
  return { store, practice, calls: () => calls, balance: () => balance };
}

describe('grantPracticeCredit', () => {
  it('grants once per idempotency key', async () => {
    const s = setup();
    expect(await s.practice.grantPracticeCredit('u1', 'email_verified', 'email-verify')).toMatchObject({ status: 'granted', balanceAfter: 1 });
    expect(await s.practice.grantPracticeCredit('u1', 'email_verified', 'email-verify')).toMatchObject({ status: 'already_granted' });
    expect(s.calls()).toBe(1);
    expect(await s.practice.grantPracticeCredit('u1', 'checklist_complete', 'checklist')).toMatchObject({ status: 'granted', balanceAfter: 2 });
    expect(s.store.ledger.map((l) => [l.idempotencyKey, l.status, l.bucket])).toEqual([
      ['u1:practice:email-verify', 'committed', 'practice'],
      ['u1:practice:checklist', 'committed', 'practice'],
    ]);
    expect((await s.practice.getPracticeBalance('u1')).credits).toBe(2);
  });

  it('grants once even when called concurrently', async () => {
    const s = setup();
    const results = await Promise.all(Array.from({ length: 4 }, () => s.practice.grantPracticeCredit('u1', 'email_verified', 'k')));
    expect(results.filter((r) => r.status === 'granted')).toHaveLength(1);
    expect(s.balance()).toBe(1);
  });

  it('lets a retry grant after a failed attempt', async () => {
    const s = setup({ failFirst: true });
    expect((await s.practice.grantPracticeCredit('u1', 'phone_verified', 'phone')).status).toBe('failed');
    expect(s.store.ledger[0].status).toBe('released');
    expect((await s.practice.grantPracticeCredit('u1', 'phone_verified', 'phone')).status).toBe('granted');
    expect(s.balance()).toBe(1);
  });

  it('does nothing for a user without a seeker profile', async () => {
    const s = setup({ profile: false });
    expect(await s.practice.grantPracticeCredit('u1', 'email_verified', 'k')).toEqual({ status: 'no_profile', ledgerId: null, balanceAfter: null });
    expect(s.store.ledger).toHaveLength(0);
  });

  it('requires a key and honours the credits option', async () => {
    const s = setup();
    await expect(s.practice.grantPracticeCredit('u1', 'admin', ' ')).rejects.toThrow();
    expect(await s.practice.grantPracticeCredit('u1', 'compensation', 'c', { credits: 3 })).toMatchObject({ balanceAfter: 3 });
  });

  it('settles its claim with the short settle limits (the grant is already decided)', async () => {
    const memory = createMemoryCreditStore();
    const limits: (CreditTxLimits | undefined)[] = [];
    const store: CreditStore = {
      ...memory,
      transaction: (fn, txLimits) => {
        limits.push(txLimits);
        return memory.transaction(fn);
      },
    };
    const practice = createPracticeCredits({
      store,
      hasSeekerProfile: async () => true,
      adjust: async ({ delta }) => ({ balanceAfter: delta }),
      getBalance: async () => ({ credits: 1, tier: 'free', periodAllotment: null, renewedAt: null }),
      now: () => new Date('2026-10-10T12:00:00Z'),
    });
    expect((await practice.grantPracticeCredit('u1', 'email_verified', 'k')).status).toBe('granted');
    // claim, then settle
    expect(limits).toEqual([undefined, SETTLE_TX_LIMITS]);
  });
});

// The first free practice (plan §3.5; PAR-4 item 8, requests P3-A and P6-A): a verified
// email or a verified phone earns it on GoApply, once per account whichever comes first.
describe('grantFirstPracticeCredit', () => {
  it('GoApply: email first, then a phone bind: one credit', async () => {
    const s = setup({ brands: { cn: 'goapply' } });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'email_verified', 'goapply')).toMatchObject({ status: 'granted', balanceAfter: 1 });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'phone_verified', 'goapply')).toMatchObject({ status: 'already_granted', balanceAfter: null });
    // The brand is read from the account when the caller has none (the phone-bind hook).
    expect(await s.practice.grantFirstPracticeCredit('cn', 'phone_verified')).toMatchObject({ status: 'already_granted' });
    expect(s.calls()).toBe(1);
    expect(s.store.ledger.map((l) => [l.idempotencyKey, l.status])).toEqual([['cn:practice:email_verified', 'committed']]);
  });

  it('GoApply: phone first, then the email link: one credit; a repeat of the same verification stays idempotent', async () => {
    const s = setup({ brands: { cn: 'goapply' } });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'phone_verified')).toMatchObject({ status: 'granted' });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'phone_verified')).toMatchObject({ status: 'already_granted' });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'email_verified')).toMatchObject({ status: 'already_granted' });
    expect(s.balance()).toBe(1);
    expect(s.store.ledger.map((l) => l.idempotencyKey)).toEqual(['cn:practice:phone_verified']);
  });

  it('GoApply: a failed first grant is released, so the other verification can still earn it', async () => {
    const s = setup({ brands: { cn: 'goapply' }, failFirst: true });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'email_verified')).toMatchObject({ status: 'failed' });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'phone_verified')).toMatchObject({ status: 'granted', balanceAfter: 1 });
    expect(await s.practice.grantFirstPracticeCredit('cn', 'email_verified')).toMatchObject({ status: 'already_granted' });
    expect(s.balance()).toBe(1);
  });

  it('GoApply: other practice grants (checklist, a pack) are separate entitlements and are not held back', async () => {
    const s = setup({ brands: { cn: 'goapply' } });
    await s.practice.grantFirstPracticeCredit('cn', 'email_verified');
    expect(await s.practice.grantPracticeCredit('cn', 'checklist_complete', 'checklist')).toMatchObject({ status: 'granted', balanceAfter: 2 });
  });

  it('RoboApply: exactly the per-key grant (email only earns it there; the keys do not look at each other)', async () => {
    const s = setup();
    expect(await s.practice.grantFirstPracticeCredit('ra', 'email_verified', 'roboapply')).toMatchObject({ status: 'granted', balanceAfter: 1 });
    expect(await s.practice.grantFirstPracticeCredit('ra', 'email_verified')).toMatchObject({ status: 'already_granted' });
    expect(s.store.ledger.map((l) => l.idempotencyKey)).toEqual(['ra:practice:email_verified']);
  });

  it('a brand that cannot be read grants nothing (never a guess); the caller retries later', async () => {
    const s = setup({ brandLookupFails: true });
    await expect(s.practice.grantFirstPracticeCredit('cn', 'phone_verified')).rejects.toThrow('database offline');
    expect(s.store.ledger).toHaveLength(0);
    expect(s.calls()).toBe(0);
  });
});
