// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { getPlan } from './planCatalog.js';
import { resetStripeCatalogCacheForTests } from './stripeCatalog.js';
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
/** The Stripe rail is ready (ST-0); with nothing else set the catalog defaults sell. */
const READY = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };
const PRICES = {
  ...READY,
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

  it('refuses a plan while the rail is not ready, the pass, the packs and switching to the same plan', async () => {
    const w = world(liveMonthly);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    // A key without a webhook secret: listed with its amount, not on sale.
    const notReady = getPlan('roboapply', 'pro_quarterly', { STRIPE_SECRET_KEY: 'sk_test_x' })!;
    expect(notReady).toMatchObject({ sellable: false, amountMinor: 5499 });
    await expect(quoteSwitch(account, notReady, w.deps)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    // One-time products are bought, not switched to.
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_week_pass', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    await expect(quoteSwitch(account, getPlan('roboapply', 'practice_pack_5', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_monthly', PRICES)!, w.deps)).rejects.toMatchObject({ code: 'switch_not_available' });
    expect(w.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

// ST-1 consequence: a switch needs no price pin. The target's Stripe price is
// the one the catalog sync finds or creates under the plan's lookup key.
describe('switch without price pins (the catalog sync resolves the target price)', () => {
  beforeEach(() => resetStripeCatalogCacheForTests());

  /** A Stripe that holds the running subscription and a price list addressed by lookup key. */
  function syncedWorld(currency: 'usd' | 'twd', seedPrices: Array<Record<string, unknown>> = []) {
    const w = world(liveMonthly);
    const prices: Array<Record<string, any>> = [...seedPrices];
    let n = 0;
    const stripe = {
      ...w.stripe,
      subscriptions: {
        update: vi.fn(async () => ({})),
        retrieve: vi.fn(async (id: string) => ({
          id,
          customer: 'cus_1',
          currency,
          metadata: { product: 'roboapply', planKey: 'pro_monthly' },
          items: { data: [{ id: 'si_1', current_period_end: Math.floor(LATER.getTime() / 1000), current_period_start: Math.floor(NOW.getTime() / 1000) }] },
        })),
      },
      invoices: { createPreview: vi.fn(async () => ({ currency, amount_due: 3000, lines: { data: [] } })) },
      products: { create: vi.fn(async (p: { id: string }) => ({ id: p.id })) },
      prices: {
        list: vi.fn(async (p: { lookup_keys: string[] }) => ({ data: prices.filter((x) => p.lookup_keys.includes(x.lookup_key)) })),
        create: vi.fn(async (p: Record<string, any>) => {
          const price = { ...p, id: `price_synced_${++n}`, active: true, recurring: p.recurring ?? null };
          prices.push(price);
          return price;
        }),
      },
    };
    const deps: StripeDeps = { getStripe: () => stripe as never, db: w.db as unknown as BillingDb, now: () => NOW };
    return { ...w, stripe, deps, prices };
  }

  it('a monthly subscriber is quoted and switched to quarterly on the synced quarterly price', async () => {
    const w = syncedWorld('usd');
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', READY)!;
    expect(target).toMatchObject({ sellable: true, stripePriceId: null, amountMinor: 5499 });

    const quote = await quoteSwitch(account, target, w.deps);
    expect(quote).toMatchObject({ planKey: 'pro_quarterly', currency: 'USD', amountDueTodayMinor: 3000, newRenewalPriceMinor: 5499 });
    const synced = w.prices.find((p) => p.lookup_key === 'ra_pro_quarterly_usd_5499_incl')!;
    expect(synced).toMatchObject({ unit_amount: 5499, currency: 'usd', recurring: { interval: 'month', interval_count: 3 }, product: 'ra_pro' });
    expect(w.stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({ subscription_details: expect.objectContaining({ items: [{ id: 'si_1', price: synced.id }] }) }));
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();

    const record = vi.fn(async () => undefined);
    await expect(confirmSwitch(account, target, quote.prorationDate, w.deps, { autoRenewAck: true, record })).resolves.toMatchObject({ planKey: 'pro_quarterly' });
    // The acknowledgement names the catalog price; the charge uses the same synced price id.
    expect(record).toHaveBeenCalledWith({ amountMinor: 5499, currency: 'USD' });
    expect(w.stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_1', price: synced.id }], proration_date: quote.prorationDate }));
    // Quote and confirm together resolved the price once.
    expect(w.stripe.prices.create).toHaveBeenCalledTimes(1);
    expect(w.stripe.prices.list).toHaveBeenCalledTimes(1);
  });

  it('a price that already exists under the lookup key is used as it is', async () => {
    const w = syncedWorld('usd', [
      { id: 'price_from_another_instance', active: true, product: 'ra_pro', currency: 'usd', unit_amount: 999, lookup_key: 'ra_pro_weekly_usd_999_incl', recurring: { interval: 'week', interval_count: 1 } },
    ]);
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    await quoteSwitch(account, getPlan('roboapply', 'pro_weekly', READY)!, w.deps);
    expect(w.stripe.invoices.createPreview).toHaveBeenCalledWith(expect.objectContaining({ subscription_details: expect.objectContaining({ items: [{ id: 'si_1', price: 'price_from_another_instance' }] }) }));
    expect(w.stripe.prices.create).not.toHaveBeenCalled();
  });

  it('a TWD subscriber switches only to a plan with a TWD amount, on its synced TWD price', async () => {
    const w = syncedWorld('twd');
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const env = { ...READY, PRICE_PRO_QUARTERLY_TWD_CENTS: '165000' };
    // No Taiwan amount for weekly: refused, and nothing is created on Stripe for it.
    await expect(quoteSwitch(account, getPlan('roboapply', 'pro_weekly', env)!, w.deps)).rejects.toMatchObject({ code: 'switch_not_available' });
    expect(w.stripe.prices.create).not.toHaveBeenCalled();

    const target = getPlan('roboapply', 'pro_quarterly', env)!;
    const quote = await quoteSwitch(account, target, w.deps);
    expect(quote).toMatchObject({ currency: 'TWD', newRenewalPriceMinor: 165000 });
    const synced = w.prices.find((p) => p.lookup_key === 'ra_pro_quarterly_twd_165000_incl')!;
    expect(synced).toMatchObject({ currency: 'twd', unit_amount: 165000 });
    // The USD price of the plan was never touched for a TWD subscription.
    expect(w.prices.some((p) => p.currency === 'usd')).toBe(false);
    const record = vi.fn(async () => undefined);
    await confirmSwitch(account, target, quote.prorationDate, w.deps, { autoRenewAck: true, record });
    expect(record).toHaveBeenCalledWith({ amountMinor: 165000, currency: 'TWD' });
    expect(w.stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', expect.objectContaining({ items: [{ id: 'si_1', price: synced.id }] }));
  });

  it('a Stripe failure while resolving the price is a 502 and nothing is charged or recorded', async () => {
    const w = syncedWorld('usd');
    w.stripe.prices.list.mockRejectedValue(new Error('stripe is down'));
    const account = (await loadBillingAccount(w.deps.db, 'u_1'))!;
    const target = getPlan('roboapply', 'pro_quarterly', READY)!;
    await expect(quoteSwitch(account, target, w.deps)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    const record = vi.fn(async () => undefined);
    await expect(confirmSwitch(account, target, Math.floor(NOW.getTime() / 1000), w.deps, { autoRenewAck: true, record })).rejects.toMatchObject({ code: 'payment_provider_error' });
    expect(record).not.toHaveBeenCalled();
    expect(w.stripe.subscriptions.update).not.toHaveBeenCalled();
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
