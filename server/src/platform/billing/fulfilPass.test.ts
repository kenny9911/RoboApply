// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fulfilPass, closePendingOrder, type FulfilDb, type FulfilDeps } from './fulfilPass.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const DAY = 86_400_000;

function setup(orders: Record<string, unknown>[], subs: Record<string, unknown>[] = []) {
  const db = createFakePrisma({
    seed: {
      alipayOrder: orders,
      seekerProfile: [{ id: 'sp_1', userId: 'u_1' }],
      seekerSubscription: subs,
    },
  });
  // A stand-in for mockCreditService: grantForPlan stamps renewedAt; the
  // period-guarded grant skips when renewedAt ≥ periodStart.
  const credits = { renewedAt: null as Date | null, grants: 0 };
  const grantPlan = vi.fn(async () => {
    credits.renewedAt = NOW;
    credits.grants++;
  });
  const grantPlanIfNewPeriod = vi.fn(async (input: { periodStart: Date }) => {
    if (credits.renewedAt && credits.renewedAt >= input.periodStart) return 'skipped';
    credits.renewedAt = NOW;
    credits.grants++;
    return 'granted';
  });
  const grantPack = vi.fn(async () => ({ status: 'granted' }));
  const deps: FulfilDeps = {
    getDb: async () => db as unknown as FulfilDb,
    now: () => NOW,
    grantPlan,
    grantPlanIfNewPeriod,
    grantPack,
    invalidate: () => {},
  };
  return { db, grantPlan, grantPlanIfNewPeriod, grantPack, deps, credits };
}

const monthPass = {
  id: 'o_1',
  userId: 'u_1',
  outTradeNo: 'GAORDER_1',
  tier: 'ra_pro_monthly',
  planKey: 'pro_monthly',
  brand: 'goapply',
  channel: 'alipay',
  amount: 39,
  amountMinor: 3900,
  status: 'pending',
  createdAt: NOW,
  completedAt: null,
};

describe('fulfilPass (shared by every CN rail)', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup([monthPass]);
  });

  it('activates a GoApply month pass once and grants its practice credits', async () => {
    const res = await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay', paidAmountMinor: 3900 }, ctx.deps);
    expect(res).toMatchObject({ status: 'fulfilled', userId: 'u_1', planKey: 'pro_monthly', brand: 'goapply', activated: true });
    expect(res.periodEnd?.toISOString()).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    const sub = await ctx.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect(sub).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'pass', rail: 'alipay', brand: 'goapply', currency: 'CNY', amountMinor: 3900, status: 'active' });
    expect(ctx.grantPlan).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_1', tier: 'pro', credits: 3, source: 'alipay' }));
    const order = await ctx.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_1' } });
    expect(order).toMatchObject({ status: 'completed' });
  });

  it('is idempotent: a replayed notify changes nothing and grants nothing', async () => {
    await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, ctx.deps);
    const again = await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, ctx.deps);
    expect(again.status).toBe('already_fulfilled');
    expect(ctx.grantPlan).toHaveBeenCalledTimes(1);
    // The replay re-checks the grant under the period guard, which skips it.
    expect(ctx.grantPlanIfNewPeriod).toHaveBeenCalledWith(expect.objectContaining({ periodStart: NOW, force: false, credits: 3 }));
    expect(ctx.credits.grants).toBe(1);
  });

  it('heals a crash between the claim and the grant on the next notify, once', async () => {
    ctx.grantPlan.mockRejectedValueOnce(new Error('crash'));
    expect((await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, ctx.deps)).status).toBe('fulfilled');
    expect(ctx.credits.grants).toBe(0);
    expect((await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, ctx.deps)).status).toBe('already_fulfilled');
    expect(ctx.credits.grants).toBe(1);
    await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, ctx.deps);
    expect(ctx.credits.grants).toBe(1);
  });

  it('two concurrent notifies fulfil once', async () => {
    const [a, b] = await Promise.all([
      fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, ctx.deps),
      fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'wechatpay', transactionId: 'wx_1' }, ctx.deps),
    ]);
    expect([a.status, b.status].sort()).toEqual(['already_fulfilled', 'fulfilled']);
    expect(ctx.grantPlan).toHaveBeenCalledTimes(1);
  });

  it('refuses a paid amount that does not match the order', async () => {
    const res = await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay', paidAmountMinor: 100 }, ctx.deps);
    expect(res.status).toBe('amount_mismatch');
    expect((await ctx.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_1' } }))?.status).toBe('pending');
  });

  it('unknown orders and recruiter orders are not ours', async () => {
    expect((await fulfilPass({ outTradeNo: 'NOPE', channel: 'alipay' }, ctx.deps)).status).toBe('not_found');
    const other = setup([{ ...monthPass, outTradeNo: 'ORDER_RH', tier: 'growth' }]);
    expect((await fulfilPass({ outTradeNo: 'ORDER_RH', channel: 'alipay' }, other.deps)).status).toBe('not_found');
  });

  it('buying again ("续费") extends from the end of the live pass', async () => {
    const liveEnd = new Date(NOW.getTime() + 10 * DAY);
    const c = setup([monthPass], [{ id: 'sub_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', currentPeriodEnd: liveEnd, startedAt: new Date('2026-09-20T00:00:00Z') }]);
    const res = await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, c.deps);
    expect(res.periodEnd?.toISOString()).toBe(new Date(liveEnd.getTime() + 30 * DAY).toISOString());
    const sub = await c.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect((sub?.startedAt as Date).toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('a practice pack adds credits (idempotent per order) and leaves the plan alone', async () => {
    const c = setup([{ ...monthPass, outTradeNo: 'GAORDER_P', tier: 'ra_practice_pack_5', planKey: 'practice_pack_5', amount: 29, amountMinor: 2900 }]);
    const res = await fulfilPass({ outTradeNo: 'GAORDER_P', channel: 'alipay' }, c.deps);
    expect(res.status).toBe('fulfilled');
    expect(c.grantPack).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_1', credits: 5, idempotencyKey: 'order:o_1' }));
    expect(await c.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } })).toBeNull();
    expect(c.grantPlan).not.toHaveBeenCalled();
    // A replay re-runs only the idempotent pack grant (same key).
    await fulfilPass({ outTradeNo: 'GAORDER_P', channel: 'alipay' }, c.deps);
    expect(c.grantPack).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: 'order:o_1' }));
  });

  it('honours old RoboApply Alipay monthly passes (ra_starter) for 30 days', async () => {
    const c = setup([{ ...monthPass, outTradeNo: 'RAORDER_1', tier: 'ra_starter', planKey: null, brand: null, amount: 19, amountMinor: null }]);
    const res = await fulfilPass({ outTradeNo: 'RAORDER_1', channel: 'alipay', paidAmountMinor: 1900 }, c.deps);
    expect(res).toMatchObject({ status: 'fulfilled', brand: 'roboapply', planKey: 'starter' });
    const sub = await c.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect(sub).toMatchObject({ tier: 'starter', currency: 'CNY', amountMinor: 1900 });
    expect(c.grantPlan).toHaveBeenCalledWith(expect.objectContaining({ tier: 'starter', credits: undefined }));
  });

  it('refuses an order whose plan is a subscription (CN rails sell passes and packs only)', async () => {
    const c = setup([{ ...monthPass, outTradeNo: 'GAORDER_S', tier: 'ra_pro_weekly', planKey: 'pro_weekly' }]);
    expect((await fulfilPass({ outTradeNo: 'GAORDER_S', channel: 'alipay' }, c.deps)).status).toBe('unknown_plan');
  });

  it('closePendingOrder closes only pending orders', async () => {
    expect(await closePendingOrder('GAORDER_1', { getDb: ctx.deps.getDb })).toBe(true);
    expect(await closePendingOrder('GAORDER_1', { getDb: ctx.deps.getDb })).toBe(false);
  });
});
