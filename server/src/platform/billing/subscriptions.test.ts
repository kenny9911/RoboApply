// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { getPlan } from './planCatalog.js';
import {
  cancelSubscription,
  confirmSwitch,
  describePlan,
  loadBillingAccount,
  quoteSwitch,
  stripePeriod,
  type BillingDb,
  type StripeDeps,
} from './subscriptions.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const LATER = new Date('2026-10-30T08:00:00.000Z');
const PRICES = {
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
};

function world(sub: Record<string, unknown> | null) {
  const db = createFakePrisma({
    seed: {
      user: [{ id: 'u_1', email: 'u@example.test', name: 'U', brand: 'roboapply' }],
      seekerProfile: [{ id: 'sp_1', userId: 'u_1', locale: 'en', market: 'us' }],
      seekerSubscription: sub ? [{ id: 'sub_row', seekerProfileId: 'sp_1', cancelAtPeriodEnd: false, ...sub }] : [],
    },
  });
  const stripe = {
    subscriptions: {
      update: vi.fn(async () => ({})),
      retrieve: vi.fn(async (id: string) => ({
        id,
        customer: 'cus_1',
        metadata: { product: 'roboapply' },
        items: { data: [{ id: 'si_1', current_period_end: Math.floor(LATER.getTime() / 1000), current_period_start: Math.floor(NOW.getTime() / 1000) }] },
      })),
    },
    invoices: {
      createPreview: vi.fn(async () => ({
        currency: 'usd',
        amount_due: 1234,
        lines: { data: [{ pricing: { price_details: { price: 'price_q' } }, period: { end: Math.floor(new Date('2027-01-10T08:00:00Z').getTime() / 1000) } }] },
      })),
    },
  };
  const deps: StripeDeps = { getStripe: () => stripe as never, db: db as unknown as BillingDb, now: () => NOW };
  return { db, stripe, deps };
}

const liveMonthly = { tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', rail: 'stripe', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', currentPeriodEnd: LATER };

describe('describePlan', () => {
  it('classifies free, subscriptions, passes, legacy plans and payment failures', async () => {
    const check = async (sub: Record<string, unknown> | null) => describePlan((await loadBillingAccount(world(sub).deps.db, 'u_1'))!, NOW);
    expect(await check(null)).toMatchObject({ state: 'free', live: false });
    expect(await check(liveMonthly)).toMatchObject({ state: 'subscription', live: true, autoRenews: true, planKey: 'pro_monthly' });
    expect(await check({ ...liveMonthly, cancelAtPeriodEnd: true })).toMatchObject({ autoRenews: false, cancelAtPeriodEnd: true });
    expect(await check({ ...liveMonthly, status: 'past_due' })).toMatchObject({ live: true, paymentFailed: true });
    expect(await check({ ...liveMonthly, status: 'unpaid' })).toMatchObject({ state: 'free', live: false });
    expect(await check({ ...liveMonthly, currentPeriodEnd: new Date('2026-10-01T00:00:00Z') })).toMatchObject({ state: 'free' });
    expect(await check({ tier: 'pro', status: 'active', planKey: 'pro_week_pass', interval: 'pass', currentPeriodEnd: LATER })).toMatchObject({ state: 'pass', autoRenews: false });
    expect(await check({ tier: 'starter', status: 'active', stripeSubscriptionId: 'sub_old', currentPeriodEnd: LATER })).toMatchObject({ state: 'legacy_subscription', planKey: 'starter' });
    expect(await check({ tier: 'growth', status: 'active', currency: 'CNY', currentPeriodEnd: LATER })).toMatchObject({ state: 'legacy_pass', autoRenews: false });
  });
});

describe('cancelSubscription (one click)', () => {
  it('turns auto-renewal off at Stripe and locally; passes the optional survey to Stripe', async () => {
    const w = world(liveMonthly);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const out = await cancelSubscription(account, { source: 'in_app', reason: 'too_expensive', note: 'Found a job' }, w.deps);
    expect(out).toMatchObject({ status: 'cancelled', changed: true, planKey: 'pro_monthly' });
    expect(out.accessUntil?.toISOString()).toBe(LATER.toISOString());
    expect(w.stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({
      cancel_at_period_end: true,
      cancellation_details: { feedback: 'too_expensive', comment: 'Found a job' },
    }));
    expect((await w.db.seekerSubscription.findUnique({ where: { id: 'sub_row' } }))?.cancelAtPeriodEnd).toBe(true);
  });

  it('a pass or an already-cancelled plan has nothing to stop', async () => {
    const pass = world({ tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'pass', brand: 'goapply', currentPeriodEnd: LATER });
    const res = await cancelSubscription((await loadBillingAccount(pass.deps.db, 'u_1'))!, { source: 'in_app' }, pass.deps);
    expect(res).toMatchObject({ status: 'already_cancelled', changed: false });
    expect(pass.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('no live plan → no_subscription', async () => {
    const w = world(null);
    await expect(cancelSubscription((await loadBillingAccount(w.deps.db, 'u_1'))!, { source: 'in_app' }, w.deps)).rejects.toMatchObject({ code: 'no_subscription' });
  });
});

describe('legacy switch: quote first, charge only on confirm', () => {
  const legacy = { tier: 'starter', status: 'active', planKey: null, stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1', currentPeriodEnd: LATER };

  it('the quote previews the proration and never updates the subscription', async () => {
    const w = world(legacy);
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const quote = await quoteSwitch((await loadBillingAccount(w.deps.db, 'u_1'))!, target, w.deps);
    expect(quote).toEqual({
      planKey: 'pro_quarterly',
      currency: 'USD',
      amountDueTodayMinor: 1234,
      newRenewalPriceMinor: 5999,
      nextRenewalDate: '2027-01-10T08:00:00.000Z',
      prorationDate: Math.floor(NOW.getTime() / 1000),
    });
    expect(w.stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({
      subscription: 'sub_old',
      subscription_details: expect.objectContaining({ items: [{ id: 'si_1', price: 'price_q' }], proration_behavior: 'always_invoice' }),
    }));
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('confirm charges with the quoted proration date; a stale quote is refused', async () => {
    const w = world(legacy);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const pd = Math.floor(NOW.getTime() / 1000) - 60;
    const record = vi.fn(async () => undefined);
    await expect(confirmSwitch(account, target, pd, w.deps, { autoRenewAck: true, record })).resolves.toMatchObject({ planKey: 'pro_quarterly' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(w.stripe.subscriptions.update.mock.invocationCallOrder[0]);
    expect(w.stripe.subscriptions.update).toHaveBeenCalledWith('sub_old', expect.objectContaining({
      items: [{ id: 'si_1', price: 'price_q' }],
      proration_behavior: 'always_invoice',
      proration_date: pd,
      metadata: expect.objectContaining({ planKey: 'pro_quarterly', brand: 'roboapply' }),
    }));
    await expect(confirmSwitch(account, target, pd - 7200, w.deps, { autoRenewAck: true, record })).rejects.toMatchObject({ code: 'quote_expired' });
  });

  it('confirm without the auto-renewal acknowledgement is refused and charges nothing', async () => {
    const w = world(legacy);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', PRICES)!;
    const record = vi.fn(async () => undefined);
    const pd = Math.floor(NOW.getTime() / 1000) - 60;
    await expect(confirmSwitch(account, target, pd, w.deps, { autoRenewAck: false, record })).rejects.toMatchObject({ code: 'auto_renew_ack_required' });
    expect(record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('refuses unpriced plans, passes and switching to the same plan', async () => {
    const w = world(liveMonthly);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_weekly', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_monthly', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'switch_not_available' });
  });
});

describe('stripePeriod', () => {
  it('reads item-level periods (current API) and falls back to top-level ones', () => {
    const start = 1_760_000_000;
    expect(stripePeriod({ items: { data: [{ current_period_start: start, current_period_end: start + 10 }] } } as never)).toEqual({
      start: new Date(start * 1000),
      end: new Date((start + 10) * 1000),
    });
    expect(stripePeriod({ current_period_start: start, current_period_end: start + 5, items: { data: [] } } as never).end).toEqual(new Date((start + 5) * 1000));
  });
});
