// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { PAID_NOTICE_HREF, fulfilPass, closePendingOrder, type FulfilDb, type FulfilDeps, type FulfilResult, type PaidNotice, type PassOrderRef } from './fulfilPass.js';
import { PLAN_DEFINITIONS } from './planCatalog.js';

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
  const notifyPaid = vi.fn(async (_notice: PaidNotice) => ({ delivered: true }));
  const deps: FulfilDeps = {
    getDb: async () => db as unknown as FulfilDb,
    now: () => NOW,
    grantPlan,
    grantPlanIfNewPeriod,
    grantPack,
    invalidate: () => {},
    notifyPaid,
  };
  return { db, grantPlan, grantPlanIfNewPeriod, grantPack, notifyPaid, deps, credits };
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

  describe('the WeChat "payment received" notice', () => {
    const wxPass = { ...monthPass, outTradeNo: 'GAWX_1', channel: 'wechatpay' };
    const wx = { outTradeNo: 'GAWX_1', channel: 'wechatpay' as const, paidAmountMinor: 3900, transactionId: 'wx_tx_1' };

    it('sends one notice for a fulfilled WeChat Pay order, filled from the order itself', async () => {
      const c = setup([wxPass]);
      expect((await fulfilPass(wx, c.deps)).status).toBe('fulfilled');
      expect(c.notifyPaid).toHaveBeenCalledTimes(1);
      expect(c.notifyPaid).toHaveBeenCalledWith({
        userId: 'u_1',
        template: 'payment_success',
        params: { planName: '会员月卡', amountFen: 3900, paidAt: NOW.toISOString(), orderNo: 'GAWX_1' },
        href: PAID_NOTICE_HREF,
        eventId: 'GAWX_1',
      });
    });

    it('a replayed notify sends nothing more, however often it arrives', async () => {
      const c = setup([wxPass]);
      await fulfilPass(wx, c.deps);
      for (let i = 0; i < 3; i += 1) expect((await fulfilPass(wx, c.deps)).status).toBe('already_fulfilled');
      expect(c.notifyPaid).toHaveBeenCalledTimes(1);
    });

    it('two concurrent notifies send once', async () => {
      const c = setup([wxPass]);
      await Promise.all([fulfilPass(wx, c.deps), fulfilPass(wx, c.deps)]);
      expect(c.notifyPaid).toHaveBeenCalledTimes(1);
    });

    it('a failed notice never fails the fulfilment: the pass is on and the credits are granted', async () => {
      const c = setup([wxPass]);
      c.notifyPaid.mockRejectedValueOnce(new Error('WeChat is down'));
      const res = await fulfilPass(wx, c.deps);
      expect(res).toMatchObject({ status: 'fulfilled', activated: true });
      expect((await c.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAWX_1' } }))?.status).toBe('completed');
      expect(c.grantPlan).toHaveBeenCalledTimes(1);
      // Not retried on the replay either: the order was claimed once.
      await fulfilPass(wx, c.deps);
      expect(c.notifyPaid).toHaveBeenCalledTimes(1);
    });

    it('a practice pack bought with WeChat Pay is announced too', async () => {
      const c = setup([{ ...wxPass, outTradeNo: 'GAWX_P', tier: 'ra_practice_pack_5', planKey: 'practice_pack_5', amount: 29, amountMinor: 2900 }]);
      await fulfilPass({ outTradeNo: 'GAWX_P', channel: 'wechatpay', paidAmountMinor: 2900 }, c.deps);
      expect(c.notifyPaid).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ planName: '面试练习包 5 次', amountFen: 2900, orderNo: 'GAWX_P' }) }));
    });

    it('sends nothing for Alipay orders, for orders that are not fulfilled, and for the old RoboApply passes', async () => {
      await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay', paidAmountMinor: 3900 }, ctx.deps);
      expect(ctx.notifyPaid).not.toHaveBeenCalled();
      const mismatch = setup([wxPass]);
      expect((await fulfilPass({ ...wx, paidAmountMinor: 1 }, mismatch.deps)).status).toBe('amount_mismatch');
      expect(mismatch.notifyPaid).not.toHaveBeenCalled();
      const legacy = setup([{ ...monthPass, outTradeNo: 'RAWX_1', channel: 'wechatpay', tier: 'ra_starter', planKey: null, brand: null, amount: 19, amountMinor: null }]);
      expect((await fulfilPass({ outTradeNo: 'RAWX_1', channel: 'wechatpay' }, legacy.deps)).status).toBe('fulfilled');
      expect(legacy.notifyPaid).not.toHaveBeenCalled();
    });
  });

  it('closePendingOrder closes only pending orders', async () => {
    expect(await closePendingOrder('GAORDER_1', { getDb: ctx.deps.getDb })).toBe(true);
    expect(await closePendingOrder('GAORDER_1', { getDb: ctx.deps.getDb })).toBe(false);
  });
});

// ── The Alipay "do not break" contract (MARKET_STRATEGY.md §5.2; AL-1; D6) ──
// Characterisation tests for the fulfilment half of the contract. They pin
// today's behaviour; nothing here depends on a price, a payments switch or a
// collecting entity. See also roboapply/routes/billing.test.ts (the answers on
// the wire) and rails/rails.test.ts (the worker request and the secret check).
describe('Alipay contract (fulfilment): A3, A4, A7, A8, A9, A12', () => {
  it('A3 the order is found by outTradeNo only, and a tier without the ra_ prefix is not ours', async () => {
    const c = setup([
      monthPass,
      { ...monthPass, id: 'o_2', outTradeNo: 'ORDER_RECRUITER', tier: 'pro_monthly' },
      { ...monthPass, id: 'o_3', outTradeNo: 'ORDER_GROWTH', tier: 'growth', planKey: null, brand: null },
    ]);
    // The row's id, the buyer's id and the plan key are not order numbers.
    for (const notANumber of ['o_1', 'u_1', 'pro_monthly', 'ra_pro_monthly', 'gaorder_1', ' GAORDER_1']) {
      expect((await fulfilPass({ outTradeNo: notANumber, channel: 'alipay' }, c.deps)).status, notANumber).toBe('not_found');
    }
    // Recruiter orders share the table; even one carrying a seeker plan key is refused without the prefix.
    expect((await fulfilPass({ outTradeNo: 'ORDER_RECRUITER', channel: 'alipay', paidAmountMinor: 3900 }, c.deps)).status).toBe('not_found');
    expect((await fulfilPass({ outTradeNo: 'ORDER_GROWTH', channel: 'alipay' }, c.deps)).status).toBe('not_found');
    expect((await c.db.alipayOrder.findMany({})).map((o: Record<string, unknown>) => o.status)).toEqual(['pending', 'pending', 'pending']);
    expect(c.grantPlan).not.toHaveBeenCalled();
    expect((await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, c.deps)).status).toBe('fulfilled');
  });

  it('A4 one order activates once and grants once: five replays and five concurrent notifies', async () => {
    const replayed = setup([monthPass]);
    for (let i = 0; i < 5; i += 1) await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay', paidAmountMinor: 3900 }, replayed.deps);
    expect(replayed.credits.grants).toBe(1);
    expect(replayed.grantPlan).toHaveBeenCalledTimes(1);
    const sub = await replayed.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect((sub?.currentPeriodEnd as Date).toISOString()).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());

    const concurrent = setup([monthPass]);
    const results = await Promise.all(Array.from({ length: 5 }, () => fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay', paidAmountMinor: 3900 }, concurrent.deps)));
    expect(results.map((r) => r.status).sort()).toEqual(['already_fulfilled', 'already_fulfilled', 'already_fulfilled', 'already_fulfilled', 'fulfilled']);
    expect(concurrent.credits.grants).toBe(1);
    const sub2 = await concurrent.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect((sub2?.currentPeriodEnd as Date).toISOString()).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
  });

  it('A4 a practice pack is granted under one key per order, on the first notify and on every replay', async () => {
    const c = setup([{ ...monthPass, outTradeNo: 'GAORDER_P', tier: 'ra_practice_pack_5', planKey: 'practice_pack_5', amount: 29, amountMinor: 2900 }]);
    await Promise.all([fulfilPass({ outTradeNo: 'GAORDER_P', channel: 'alipay' }, c.deps), fulfilPass({ outTradeNo: 'GAORDER_P', channel: 'alipay' }, c.deps)]);
    await fulfilPass({ outTradeNo: 'GAORDER_P', channel: 'alipay' }, c.deps);
    const keys = c.grantPack.mock.calls.map((call) => (call as unknown as [{ idempotencyKey: string; credits: number }])[0]);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    // Always the same key and amount, so the practice ledger adds the credits once.
    expect(new Set(keys.map((k) => `${k.idempotencyKey}:${k.credits}`))).toEqual(new Set(['order:o_1:5']));
  });

  it.each([
    ['ra_starter', 'starter', 19],
    ['ra_growth', 'growth', 45],
  ] as const)('A7 a pending legacy %s order still fulfils: 30 days, the plan credits, CNY, market cn', async (tier, planKey, yuan) => {
    const c = setup([{ ...monthPass, outTradeNo: 'RAORDER_OLD', tier, planKey: null, brand: null, amount: yuan, amountMinor: null }]);
    const res = await fulfilPass({ outTradeNo: 'RAORDER_OLD', channel: 'alipay', paidAmountMinor: yuan * 100 }, c.deps);
    expect(res).toMatchObject({ status: 'fulfilled', planKey, brand: 'roboapply', activated: true });
    expect(res.periodEnd?.toISOString()).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    const sub = await c.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect(sub).toMatchObject({ tier: planKey, status: 'active', market: 'cn', currency: 'CNY', amountMinor: yuan * 100, rail: 'alipay', planKey, interval: 'pass', cancelAtPeriodEnd: false });
    expect((sub?.currentPeriodEnd as Date).toISOString()).toBe(new Date(NOW.getTime() + 30 * DAY).toISOString());
    // `credits: undefined` = the legacy plan's own allotment (mockInterviewPlans), not a Pro number.
    expect(c.grantPlan).toHaveBeenCalledTimes(1);
    expect(c.grantPlan).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_1', tier: planKey, credits: undefined, source: 'alipay' }));
    // A replay answers already_fulfilled and grants nothing more.
    expect((await fulfilPass({ outTradeNo: 'RAORDER_OLD', channel: 'alipay' }, c.deps)).status).toBe('already_fulfilled');
    expect(c.credits.grants).toBe(1);
  });

  it('A8 fulfilment writes only status and completedAt on the order; tier and amount keep their meaning', async () => {
    const c = setup([monthPass]);
    const before = { ...(await c.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_1' } })) } as Record<string, unknown>;
    await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay', paidAmountMinor: 3900, transactionId: 'T1' }, c.deps);
    const after = (await c.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_1' } })) as Record<string, unknown>;
    const changed = Object.keys(after).filter((k) => String(after[k]) !== String(before[k]) && k !== 'updatedAt');
    expect(changed.sort()).toEqual(['completedAt', 'status']);
    // tier 'ra_' + plan key; amount in yuan; status pending → completed; completedAt the fulfilment time.
    expect(after).toMatchObject({ tier: 'ra_pro_monthly', amount: 39, amountMinor: 3900, status: 'completed', completedAt: NOW });
    // A closed order: status only.
    const closed = setup([monthPass]);
    await closePendingOrder('GAORDER_1', { getDb: closed.deps.getDb });
    const row = (await closed.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_1' } })) as Record<string, unknown>;
    expect(row).toMatchObject({ tier: 'ra_pro_monthly', amount: 39, status: 'closed', completedAt: null });
  });

  it('A9 CN rails sell one-time products only: no GoApply plan renews, and fulfilPass refuses every subscription plan', async () => {
    // The GoApply catalog: free, passes and packs. Nothing auto-renews, nothing is a subscription.
    for (const def of PLAN_DEFINITIONS.goapply) {
      expect(['free', 'pass', 'pack'], def.key).toContain(def.kind);
      expect(def.autoRenews, def.key).toBe(false);
      if (def.kind === 'pass') expect(def.passDays, def.key).toBeGreaterThan(0);
    }
    expect(PLAN_DEFINITIONS.goapply.some((d) => d.key === 'pro_weekly')).toBe(false);
    // An order that names a subscription plan is never activated, on either brand's rows.
    const subscriptions = PLAN_DEFINITIONS.roboapply.filter((d) => d.kind === 'subscription').map((d) => d.key);
    expect(subscriptions).toContain('pro_weekly');
    for (const key of subscriptions) {
      const c = setup([{ ...monthPass, outTradeNo: `RAORDER_${key}`, tier: `ra_${key}`, planKey: key, brand: 'roboapply' }]);
      const res = await fulfilPass({ outTradeNo: `RAORDER_${key}`, channel: 'alipay', paidAmountMinor: 3900 }, c.deps);
      expect(res.status, key).toBe('unknown_plan');
      expect((await c.db.alipayOrder.findUnique({ where: { outTradeNo: `RAORDER_${key}` } }))?.status).toBe('pending');
      expect(await c.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } })).toBeNull();
      expect(c.grantPlan).not.toHaveBeenCalled();
    }
    // A fulfilled pass is a pass: no renewal flag, no Stripe subscription, nothing to debit later.
    const pass = setup([monthPass]);
    await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, pass.deps);
    const sub = await pass.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect(sub).toMatchObject({ interval: 'pass', cancelAtPeriodEnd: false, rail: 'alipay' });
    expect(sub?.stripeSubscriptionId ?? null).toBeNull();
  });

  it('A12 the fulfilPass signature both CN rails call: (order ref, optional deps) → a result with a status', async () => {
    // One required argument; the second is optional dependencies.
    expect(fulfilPass.length).toBe(1);
    const c = setup([monthPass, { ...monthPass, id: 'o_wx', outTradeNo: 'GAWX_1', channel: 'wechatpay' }]);
    // The Alipay callback's call shape.
    const alipay: PassOrderRef = { outTradeNo: 'GAORDER_1', channel: 'alipay', paidAmountMinor: 3900, transactionId: null };
    // The WeChat Pay notify's call shape (features/billing-cn).
    const wechat: PassOrderRef = { outTradeNo: 'GAWX_1', channel: 'wechatpay', paidAmountMinor: 3900, transactionId: 'wx_tx_1' };
    const a: FulfilResult = await fulfilPass(alipay, c.deps);
    const w: FulfilResult = await fulfilPass(wechat, c.deps);
    expect(Object.keys(a).sort()).toEqual(['activated', 'brand', 'orderId', 'periodEnd', 'planKey', 'status', 'userId']);
    expect([a.status, w.status]).toEqual(['fulfilled', 'fulfilled']);
    // The minimal reference (order number and channel) is enough.
    const minimal = setup([monthPass]);
    expect((await fulfilPass({ outTradeNo: 'GAORDER_1', channel: 'alipay' }, minimal.deps)).status).toBe('fulfilled');
    const statuses: FulfilResult['status'][] = ['fulfilled', 'already_fulfilled', 'not_found', 'amount_mismatch', 'unknown_plan'];
    expect(statuses).toHaveLength(5);
  });
});

// GoApply student passes (MARKET_STRATEGY PC-2; parity plan §3.8). New cases
// only: fulfilPass itself is unchanged, the catalog gained two pass rows.
describe('fulfilPass: GoApply student passes', () => {
  it.each([
    ['student_monthly', 29, 30, 3],
    ['student_quarterly', 69, 90, 3],
  ] as const)('a paid %s order (¥%i) activates %i days of Pro through the same path and grants %i practice credits', async (planKey, yuan, days, credits) => {
    const c = setup([{ ...monthPass, outTradeNo: 'GAORDER_S', tier: `ra_${planKey}`, planKey, amount: yuan, amountMinor: yuan * 100 }]);
    const res = await fulfilPass({ outTradeNo: 'GAORDER_S', channel: 'alipay', paidAmountMinor: yuan * 100 }, c.deps);
    expect(res).toMatchObject({ status: 'fulfilled', userId: 'u_1', planKey, brand: 'goapply', activated: true });
    expect(res.periodEnd?.toISOString()).toBe(new Date(NOW.getTime() + days * DAY).toISOString());
    const sub = await c.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect(sub).toMatchObject({ tier: 'pro', planKey, interval: 'pass', rail: 'alipay', brand: 'goapply', market: 'cn', currency: 'CNY', amountMinor: yuan * 100, status: 'active', cancelAtPeriodEnd: false });
    expect(c.grantPlan).toHaveBeenCalledTimes(1);
    expect(c.grantPlan).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_1', tier: 'pro', credits, source: 'alipay' }));
    // Once: a replay changes nothing.
    expect((await fulfilPass({ outTradeNo: 'GAORDER_S', channel: 'alipay', paidAmountMinor: yuan * 100 }, c.deps)).status).toBe('already_fulfilled');
    expect(c.credits.grants).toBe(1);
    expect(((await c.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } }))?.currentPeriodEnd as Date).toISOString()).toBe(new Date(NOW.getTime() + days * DAY).toISOString());
  });

  it('a student pass bought while a pass is live extends from its end, like any pass', async () => {
    const liveEnd = new Date(NOW.getTime() + 5 * DAY);
    const c = setup(
      [{ ...monthPass, outTradeNo: 'GAORDER_S', tier: 'ra_student_quarterly', planKey: 'student_quarterly', amount: 69, amountMinor: 6900 }],
      [{ id: 'sub_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_week_pass', currentPeriodEnd: liveEnd, startedAt: new Date('2026-10-08T00:00:00Z') }],
    );
    const res = await fulfilPass({ outTradeNo: 'GAORDER_S', channel: 'wechatpay', paidAmountMinor: 6900, transactionId: 'wx_1' }, c.deps);
    expect(res.periodEnd?.toISOString()).toBe(new Date(liveEnd.getTime() + 90 * DAY).toISOString());
    expect(c.notifyPaid).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ planName: '学生季卡', amountFen: 6900 }) }));
  });

  it('the paid amount must match the student price: the regular price is refused, the order stays pending', async () => {
    const c = setup([{ ...monthPass, outTradeNo: 'GAORDER_S', tier: 'ra_student_monthly', planKey: 'student_monthly', amount: 29, amountMinor: 2900 }]);
    expect((await fulfilPass({ outTradeNo: 'GAORDER_S', channel: 'alipay', paidAmountMinor: 3900 }, c.deps)).status).toBe('amount_mismatch');
    expect((await c.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_S' } }))?.status).toBe('pending');
  });

  it('on a RoboApply-branded order the same keys are subscriptions, and a CN rail never activates them', async () => {
    const c = setup([{ ...monthPass, outTradeNo: 'RAORDER_S', tier: 'ra_student_monthly', planKey: 'student_monthly', brand: 'roboapply' }]);
    expect((await fulfilPass({ outTradeNo: 'RAORDER_S', channel: 'alipay' }, c.deps)).status).toBe('unknown_plan');
  });
});
