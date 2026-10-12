// @vitest-environment node
//
// WP-11: invite codes — shown once, stored hashed, brand-scoped, status
// (active/used/expired), compare-and-set redemption.

import { describe, expect, it } from 'vitest';
import { INVITE_CODE_ALPHABET, normalizeInviteCode } from './contract.js';
import { AuthCnError } from './errors.js';
import { createInviteService, generateInviteCode, hashInviteCode, inviteStatus } from './inviteService.js';
import { authCnService } from './index.js';
import { clock, fakeDb } from './__tests__/testkit.js';

describe('codes', () => {
  it('are 10 unambiguous characters shown as XXXXX-XXXXX', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      for (const ch of normalizeInviteCode(code)) expect(INVITE_CODE_ALPHABET).toContain(ch);
      expect(code).not.toMatch(/[01IOL]/);
    }
  });

  it('normalize before hashing (case, spaces, dashes)', () => {
    expect(hashInviteCode('abcde fghjk')).toBe(hashInviteCode('ABCDE-FGHJK'));
  });

  it('status', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(inviteStatus({ uses: 0, maxUses: 1, expiresAt: null }, now)).toBe('active');
    expect(inviteStatus({ uses: 1, maxUses: 1, expiresAt: null }, now)).toBe('used');
    expect(inviteStatus({ uses: 0, maxUses: 1, expiresAt: new Date('2026-10-09') }, now)).toBe('expired');
  });
});

describe('createInviteService', () => {
  it('returns raw codes once and stores only hashes', async () => {
    const { fake, db } = fakeDb();
    const c = clock();
    const svc = createInviteService({ db, now: c.now });
    const { items } = await svc.create('goapply', 'admin1', { count: 3, maxUses: 2, note: 'Campus beta' });
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(item).toMatchObject({ maxUses: 2, usedCount: 0, status: 'active', note: 'Campus beta' });
    }
    const stored = JSON.stringify(fake.$rows('rABrandInvite'));
    for (const item of items) expect(stored).not.toContain(item.code!);
    expect(fake.$rows('rABrandInvite')[0]).toMatchObject({ brand: 'goapply', createdBy: 'admin1', codeHash: hashInviteCode(items[0]!.code!) });

    const list = await svc.list('goapply', {});
    expect(list.items.every((i) => i.code === null)).toBe(true);
    expect(list.items).toHaveLength(3);
    expect(await svc.list('roboapply', {})).toEqual({ items: [], cursor: null });
  });

  it('redeems with compare-and-set until maxUses, filters by status', async () => {
    const { db } = fakeDb();
    const c = clock();
    const svc = createInviteService({ db, now: c.now });
    const { items } = await svc.create('goapply', null, { count: 1, maxUses: 2 });
    const code = items[0]!.code!;
    await expect(svc.isRedeemable('goapply', code)).resolves.toBe(true);
    await expect(svc.isRedeemable('roboapply', code)).resolves.toBe(false);
    await svc.redeem('goapply', code);
    await svc.redeem('goapply', code.toLowerCase());
    await expect(svc.redeem('goapply', code)).rejects.toBeInstanceOf(AuthCnError);
    await expect(svc.list('goapply', { status: 'used' })).resolves.toMatchObject({ items: [{ usedCount: 2, status: 'used' }] });
    await expect(svc.list('goapply', { status: 'active' })).resolves.toMatchObject({ items: [] });
  });

  it('expired codes cannot be redeemed', async () => {
    const { db } = fakeDb();
    const c = clock();
    const svc = createInviteService({ db, now: c.now });
    const { items } = await svc.create('goapply', null, { count: 1, maxUses: 5, expiresAt: '2026-10-11T00:00:00.000Z' });
    c.advance(2 * 24 * 3600 * 1000);
    await expect(svc.redeem('goapply', items[0]!.code!)).rejects.toMatchObject({ code: 'invite_invalid' });
    await expect(svc.list('goapply', { status: 'expired' })).resolves.toMatchObject({ items: [{ status: 'expired' }] });
  });

  it('public seam: redeemInviteInTx spends the last use exactly once when two signups race', async () => {
    const { db } = fakeDb();
    const c = clock();
    const svc = createInviteService({ db, now: c.now });
    const { items } = await svc.create('goapply', null, { count: 1, maxUses: 1 });
    const code = items[0]!.code!;
    // Each signup redeems inside its own account-creation transaction.
    const results = await Promise.allSettled([
      db.$transaction((tx) => authCnService.redeemInviteInTx(tx, 'goapply', code)),
      db.$transaction((tx) => authCnService.redeemInviteInTx(tx, 'goapply', code)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'invite_invalid' });
    await expect(svc.list('goapply', {})).resolves.toMatchObject({ items: [{ usedCount: 1, status: 'used' }] });
  });
});
