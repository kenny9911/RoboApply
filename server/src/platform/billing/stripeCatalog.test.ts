// @vitest-environment node
//
// ST-1 (MARKET_STRATEGY §5.1 "Catalog sync"): Stripe Products and Prices
// follow the plan catalog by lookup key and are created on first use. The
// Stripe object is a hand-written fake: nothing here can reach Stripe.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from '../../services/LoggerService.js';
import { BillingError } from './errors.js';
import { getPlan, getPlanCatalog, type CatalogPlan, type PlanKey } from './planCatalog.js';
import type { StripeClient } from './stripeClient.js';
import {
  STRIPE_LOOKUP_KEYS_PER_CALL,
  STRIPE_PRODUCT_FOR_PLAN,
  parseStripeLookupKey,
  planKeyForPrice,
  resetStripeCatalogCacheForTests,
  resolveStripePriceId,
  stripeLookupKey,
  stripeRecurringFor,
  syncStripeCatalog,
} from './stripeCatalog.js';

/** The Stripe rail is ready and no price variable is set: the catalog defaults sell. */
const READY = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };

interface FakePrice {
  id: string;
  active: boolean;
  product: string;
  currency: string;
  unit_amount: number;
  lookup_key: string | null;
  tax_behavior?: string;
  recurring: { interval: string; interval_count: number } | null;
  metadata: Record<string, string>;
}

function stripeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, type: 'StripeInvalidRequestError' });
}

/** A Stripe account as far as the catalog sync sees it: products by id, prices by lookup key. */
function fakeStripe(seed: { prices?: FakePrice[]; products?: string[] } = {}) {
  const prices: FakePrice[] = [...(seed.prices ?? [])];
  const products = new Set<string>(seed.products ?? []);
  let n = 0;
  const api = {
    products: {
      create: vi.fn(async (params: { id: string; name: string; metadata?: Record<string, string> }, _opts?: { idempotencyKey?: string }) => {
        if (products.has(params.id)) throw stripeError(`Product already exists.`, 'resource_already_exists');
        products.add(params.id);
        return { id: params.id };
      }),
    },
    prices: {
      list: vi.fn(async (params: { lookup_keys: string[]; active?: boolean; limit?: number }) => ({
        data: prices.filter((p) => p.lookup_key !== null && params.lookup_keys.includes(p.lookup_key) && (params.active === undefined || p.active === params.active)),
      })),
      create: vi.fn(async (params: Omit<FakePrice, 'id' | 'active' | 'recurring'> & { recurring?: FakePrice['recurring'] }, _opts?: { idempotencyKey?: string }) => {
        if (!products.has(params.product)) throw stripeError(`No such product: '${params.product}'`, 'resource_missing');
        if (prices.some((p) => p.active && p.lookup_key === params.lookup_key)) throw stripeError('A price already uses this lookup key.', 'lookup_key_taken_in_fake');
        const price: FakePrice = { ...params, id: `price_synced_${++n}`, active: true, recurring: params.recurring ?? null };
        prices.push(price);
        return price;
      }),
    },
  };
  const calls = () => api.products.create.mock.calls.length + api.prices.list.mock.calls.length + api.prices.create.mock.calls.length;
  return { stripe: api as unknown as StripeClient, api, prices, products, calls };
}

const plan = (key: PlanKey, env: Record<string, string> = READY): CatalogPlan => getPlan('roboapply', key, env)!;

beforeEach(() => {
  vi.clearAllMocks();
  resetStripeCatalogCacheForTests();
});

describe('lookup keys', () => {
  it('are ra_<planKey>_<currency>_<amountMinor>_incl, and parse back', () => {
    expect(stripeLookupKey('pro_monthly', 'USD', 2499)).toBe('ra_pro_monthly_usd_2499_incl');
    expect(stripeLookupKey('pro_week_pass', 'TWD', 29900)).toBe('ra_pro_week_pass_twd_29900_incl');
    expect(parseStripeLookupKey('ra_pro_monthly_usd_2499_incl')).toEqual({ planKey: 'pro_monthly', currency: 'USD', amountMinor: 2499 });
    expect(parseStripeLookupKey('ra_practice_pack_15_twd_74900_incl')).toEqual({ planKey: 'practice_pack_15', currency: 'TWD', amountMinor: 74900 });
    for (const p of getPlanCatalog('roboapply', READY).filter((x) => x.kind !== 'free')) {
      expect(parseStripeLookupKey(stripeLookupKey(p.key, 'USD', p.amountMinor!)), p.key).toEqual({ planKey: p.key, currency: 'USD', amountMinor: p.amountMinor });
    }
  });

  it('anything that is not one of ours parses to null', () => {
    for (const bad of [null, undefined, '', 'pro_monthly', 'ra_pro_monthly_usd_2499', 'ra_pro_monthly_cny_3900_incl', 'ra_unknown_plan_usd_100_incl', 'ra_pro_monthly_usd_0_incl', 'ra_pro_monthly_usd_-5_incl', 'rh_pro_monthly_usd_2499_incl', 'ra_free_usd_abc_incl']) {
      expect(parseStripeLookupKey(bad), String(bad)).toBeNull();
    }
  });

  it('every paid RoboApply plan belongs to one of the four fixed products', () => {
    expect(STRIPE_PRODUCT_FOR_PLAN).toEqual({
      pro_weekly: 'ra_pro',
      pro_monthly: 'ra_pro',
      pro_quarterly: 'ra_pro',
      student_monthly: 'ra_pro_student',
      student_quarterly: 'ra_pro_student',
      pro_week_pass: 'ra_pro_week_pass',
      practice_pack_5: 'ra_practice_pack',
      practice_pack_15: 'ra_practice_pack',
    });
    for (const p of getPlanCatalog('roboapply', {}).filter((x) => x.kind !== 'free')) expect(STRIPE_PRODUCT_FOR_PLAN[p.key], p.key).toBeTruthy();
  });

  it('a quarter is three months on Stripe; the pass and the packs do not recur', () => {
    expect(stripeRecurringFor(plan('pro_weekly'))).toEqual({ interval: 'week', interval_count: 1 });
    expect(stripeRecurringFor(plan('pro_monthly'))).toEqual({ interval: 'month', interval_count: 1 });
    expect(stripeRecurringFor(plan('pro_quarterly'))).toEqual({ interval: 'month', interval_count: 3 });
    expect(stripeRecurringFor(plan('student_quarterly'))).toEqual({ interval: 'month', interval_count: 3 });
    expect(stripeRecurringFor(plan('pro_week_pass'))).toBeNull();
    expect(stripeRecurringFor(plan('practice_pack_5'))).toBeNull();
  });
});

describe('resolveStripePriceId', () => {
  it('empty env + key: every MVP plan resolves a price at the default amount, created on first use', async () => {
    const f = fakeStripe();
    const expected: Array<[PlanKey, number]> = [
      ['pro_weekly', 999],
      ['pro_monthly', 2499],
      ['pro_quarterly', 5499],
      ['pro_week_pass', 999],
      ['practice_pack_5', 999],
      ['practice_pack_15', 2499],
    ];
    const mvp = getPlanCatalog('roboapply', READY).filter((p) => p.phase === 'mvp' && p.kind !== 'free');
    expect(mvp.map((p) => [p.key, p.amountMinor])).toEqual(expected);
    for (const p of mvp) {
      const id = await resolveStripePriceId(f.stripe, p, 'USD');
      const created = f.prices.find((x) => x.id === id)!;
      expect(created, p.key).toMatchObject({ unit_amount: p.amountMinor, currency: 'usd', lookup_key: stripeLookupKey(p.key, 'USD', p.amountMinor!) });
    }
    expect(f.prices).toHaveLength(6);
    // Three products for the six MVP plans, each created once.
    expect([...f.products].sort()).toEqual(['ra_practice_pack', 'ra_pro', 'ra_pro_week_pass']);
    expect(f.api.products.create).toHaveBeenCalledTimes(3);
  });

  it('a second resolve makes no call', async () => {
    const f = fakeStripe();
    const first = await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD');
    const before = f.calls();
    expect(before).toBe(3); // list, product, create
    expect(await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD')).toBe(first);
    expect(await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD')).toBe(first);
    expect(f.calls()).toBe(before);
  });

  it('a price that already exists under the lookup key is found, and nothing is created', async () => {
    const f = fakeStripe({
      prices: [{ id: 'price_existing', active: true, product: 'ra_pro', currency: 'usd', unit_amount: 2499, lookup_key: 'ra_pro_monthly_usd_2499_incl', recurring: { interval: 'month', interval_count: 1 }, metadata: {} }],
      products: ['ra_pro'],
    });
    expect(await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD')).toBe('price_existing');
    expect(f.api.prices.list).toHaveBeenCalledWith({ lookup_keys: ['ra_pro_monthly_usd_2499_incl'], active: true, limit: 1 });
    expect(f.api.prices.create).not.toHaveBeenCalled();
    expect(f.api.products.create).not.toHaveBeenCalled();
  });

  it('two concurrent resolves create one price', async () => {
    const f = fakeStripe();
    const p = plan('pro_quarterly');
    const [a, b, c] = await Promise.all([resolveStripePriceId(f.stripe, p, 'USD'), resolveStripePriceId(f.stripe, p, 'USD'), resolveStripePriceId(f.stripe, p, 'USD')]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(f.api.prices.list).toHaveBeenCalledTimes(1);
    expect(f.api.prices.create).toHaveBeenCalledTimes(1);
    expect(f.prices).toHaveLength(1);
  });

  it('two plans of one product resolved together create the product once', async () => {
    const f = fakeStripe();
    await Promise.all([resolveStripePriceId(f.stripe, plan('pro_weekly'), 'USD'), resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD'), resolveStripePriceId(f.stripe, plan('pro_quarterly'), 'USD')]);
    expect(f.api.products.create).toHaveBeenCalledTimes(1);
    expect(f.api.products.create).toHaveBeenCalledWith({ id: 'ra_pro', name: 'RoboApply Pro', metadata: { product: 'roboapply' } }, { idempotencyKey: 'catalog:product:ra_pro' });
    expect(f.prices).toHaveLength(3);
  });

  it('a pin skips the sync: no Stripe call at all', async () => {
    const f = fakeStripe();
    const pinned = plan('pro_monthly', { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_pinned', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' });
    expect(await resolveStripePriceId(f.stripe, pinned, 'USD')).toBe('price_pinned');
    const twdPinned = plan('pro_monthly', { ...READY, PRICE_PRO_MONTHLY_TWD_CENTS: '74900', STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_pinned_twd' });
    expect(await resolveStripePriceId(f.stripe, twdPinned, 'TWD')).toBe('price_pinned_twd');
    expect(f.calls()).toBe(0);
    // The USD price of the same plan has no pin: it goes through the sync.
    expect(await resolveStripePriceId(f.stripe, twdPinned, 'USD')).toMatch(/^price_synced_/);
  });

  it('quarterly is created with interval month and interval_count 3; weekly and monthly with their own interval', async () => {
    const f = fakeStripe();
    await resolveStripePriceId(f.stripe, plan('pro_quarterly'), 'USD');
    await resolveStripePriceId(f.stripe, plan('pro_weekly'), 'USD');
    await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD');
    await resolveStripePriceId(f.stripe, plan('student_quarterly'), 'USD');
    const recurring = Object.fromEntries(f.api.prices.create.mock.calls.map((c) => [c[0].lookup_key, c[0].recurring]));
    expect(recurring).toEqual({
      ra_pro_quarterly_usd_5499_incl: { interval: 'month', interval_count: 3 },
      ra_pro_weekly_usd_999_incl: { interval: 'week', interval_count: 1 },
      ra_pro_monthly_usd_2499_incl: { interval: 'month', interval_count: 1 },
      ra_student_quarterly_usd_3799_incl: { interval: 'month', interval_count: 3 },
    });
  });

  it('the pass and the packs have no recurring', async () => {
    const f = fakeStripe();
    for (const key of ['pro_week_pass', 'practice_pack_5', 'practice_pack_15'] as const) await resolveStripePriceId(f.stripe, plan(key), 'USD');
    for (const call of f.api.prices.create.mock.calls) expect('recurring' in call[0], call[0].lookup_key ?? '').toBe(false);
    expect(f.prices.every((p) => p.recurring === null)).toBe(true);
    expect(f.prices.map((p) => p.product)).toEqual(['ra_pro_week_pass', 'ra_practice_pack', 'ra_practice_pack']);
  });

  it('every created price carries tax_behavior inclusive, the lookup key, metadata.planKey and an idempotency key', async () => {
    const f = fakeStripe();
    for (const p of getPlanCatalog('roboapply', READY).filter((x) => x.kind !== 'free')) await resolveStripePriceId(f.stripe, p, 'USD');
    expect(f.api.prices.create).toHaveBeenCalledTimes(8);
    for (const [params, opts] of f.api.prices.create.mock.calls) {
      const parsed = parseStripeLookupKey(params.lookup_key)!;
      expect(params).toMatchObject({
        product: STRIPE_PRODUCT_FOR_PLAN[parsed.planKey],
        currency: 'usd',
        unit_amount: parsed.amountMinor,
        tax_behavior: 'inclusive',
        metadata: { product: 'roboapply', planKey: parsed.planKey },
      });
      expect(opts).toEqual({ idempotencyKey: `catalog:${params.lookup_key}` });
    }
    // The student plans have their own product.
    expect([...f.products].sort()).toEqual(['ra_practice_pack', 'ra_pro', 'ra_pro_student', 'ra_pro_week_pass']);
  });

  it('a changed amount gives a new lookup key and leaves the old price untouched', async () => {
    const f = fakeStripe();
    const oldId = await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD');
    const oldPrice = { ...f.prices.find((p) => p.id === oldId)! };
    const repriced = plan('pro_monthly', { ...READY, PRICE_PRO_MONTHLY_USD_CENTS: '2999' });
    const newId = await resolveStripePriceId(f.stripe, repriced, 'USD');
    expect(newId).not.toBe(oldId);
    expect(f.prices.find((p) => p.id === newId)).toMatchObject({ lookup_key: 'ra_pro_monthly_usd_2999_incl', unit_amount: 2999 });
    // The old price is exactly as it was: still active, same key, same amount (existing subscribers keep it).
    expect(f.prices.find((p) => p.id === oldId)).toEqual(oldPrice);
    // And the old amount still resolves to the old price.
    expect(await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD')).toBe(oldId);
  });

  it('a Taiwan price is its own Stripe price in TWD under ..._twd_..._incl', async () => {
    const f = fakeStripe();
    const tw = plan('pro_monthly', { ...READY, PRICE_PRO_MONTHLY_TWD_CENTS: '74900' });
    const id = await resolveStripePriceId(f.stripe, tw, 'TWD');
    expect(f.prices.find((p) => p.id === id)).toMatchObject({ currency: 'twd', unit_amount: 74900, lookup_key: 'ra_pro_monthly_twd_74900_incl', recurring: { interval: 'month', interval_count: 1 }, product: 'ra_pro' });
    // A plan with no Taiwan amount has no TWD price to resolve.
    await expect(resolveStripePriceId(f.stripe, plan('pro_weekly'), 'TWD')).rejects.toMatchObject({ code: 'plan_not_sellable' });
  });

  it('a GoApply plan is refused with plan_not_sellable and no Stripe call: a CNY product or price is never created (rule A11)', async () => {
    const f = fakeStripe();
    for (const p of getPlanCatalog('goapply', READY).filter((x) => x.kind !== 'free')) {
      expect(p).toMatchObject({ currency: 'CNY', sellable: true });
      await expect(resolveStripePriceId(f.stripe, p, 'USD'), p.key).rejects.toMatchObject({ code: 'plan_not_sellable', status: 409 });
      await expect(resolveStripePriceId(f.stripe, p, 'TWD'), p.key).rejects.toBeInstanceOf(BillingError);
    }
    expect(f.calls()).toBe(0);
    expect(f.prices).toEqual([]);
    expect(f.products.size).toBe(0);
  });

  it('the free plan is never a Stripe price', async () => {
    const f = fakeStripe();
    await expect(resolveStripePriceId(f.stripe, plan('free'), 'USD')).rejects.toMatchObject({ code: 'plan_not_sellable' });
    expect(f.calls()).toBe(0);
  });

  it('resource_already_exists on the product counts as success', async () => {
    // Another instance created the product earlier; this instance has never seen it.
    const f = fakeStripe({ products: ['ra_pro'] });
    const id = await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD');
    expect(f.api.products.create).toHaveBeenCalledTimes(1);
    expect(f.prices.find((p) => p.id === id)).toMatchObject({ lookup_key: 'ra_pro_monthly_usd_2499_incl' });
  });

  it('the lost race: create rejects because the key is taken, the second list finds the winner', async () => {
    const f = fakeStripe({ products: ['ra_pro'] });
    // Between our list and our create another instance creates the price.
    f.api.prices.list.mockImplementationOnce(async () => {
      f.prices.push({ id: 'price_winner', active: true, product: 'ra_pro', currency: 'usd', unit_amount: 2499, lookup_key: 'ra_pro_monthly_usd_2499_incl', recurring: { interval: 'month', interval_count: 1 }, metadata: { planKey: 'pro_monthly' } });
      return { data: [] };
    });
    expect(await resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD')).toBe('price_winner');
    expect(f.api.prices.create).toHaveBeenCalledTimes(1);
    expect(f.api.prices.list).toHaveBeenCalledTimes(2);
    expect(f.prices).toHaveLength(1);
  });

  it.each([
    ['another amount', { unit_amount: 1999 }],
    ['another currency', { currency: 'eur' }],
    ['another interval', { recurring: { interval: 'year', interval_count: 1 } }],
    ['another interval count', { recurring: { interval: 'month', interval_count: 3 } }],
    ['a one-time price where a subscription is sold', { recurring: null }],
  ])('a price under our lookup key with %s is refused, not sold on, and the key is not moved', async (_name, wrong) => {
    const f = fakeStripe({
      prices: [{ id: 'price_wrong', active: true, product: 'ra_pro', currency: 'usd', unit_amount: 2499, lookup_key: 'ra_pro_monthly_usd_2499_incl', recurring: { interval: 'month', interval_count: 1 }, metadata: {}, ...wrong } as FakePrice],
      products: ['ra_pro'],
    });
    await expect(resolveStripePriceId(f.stripe, plan('pro_monthly'), 'USD')).rejects.toMatchObject({ code: 'payment_provider_error', status: 502, details: { reason: 'price_mismatch' } });
    expect(f.api.prices.create).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(f.prices).toHaveLength(1);
  });

  it('a recurring price where a one-time payment is sold is refused too', async () => {
    const f = fakeStripe({
      prices: [{ id: 'price_wrong', active: true, product: 'ra_pro_week_pass', currency: 'usd', unit_amount: 999, lookup_key: 'ra_pro_week_pass_usd_999_incl', recurring: { interval: 'week', interval_count: 1 }, metadata: {} }],
    });
    await expect(resolveStripePriceId(f.stripe, plan('pro_week_pass'), 'USD')).rejects.toMatchObject({ code: 'payment_provider_error' });
  });

  it('a Stripe failure becomes payment_provider_error (502), is not remembered, and the plan catalog still answers', async () => {
    const f = fakeStripe();
    f.api.prices.list.mockRejectedValueOnce(new Error('connection reset by sk_should_never_matter'));
    const p = plan('pro_monthly');
    const err = await resolveStripePriceId(f.stripe, p, 'USD').catch((e) => e);
    expect(err).toBeInstanceOf(BillingError);
    expect(err).toMatchObject({ code: 'payment_provider_error', status: 502, details: { provider: 'stripe', step: 'find price', planKey: 'pro_monthly' } });
    // The catalog never called Stripe: it lists the plan exactly as before.
    expect(getPlan('roboapply', 'pro_monthly', READY)).toMatchObject({ amountMinor: 2499, sellable: true });
    // The failed promise was removed: the next attempt goes to Stripe again and succeeds.
    expect(await resolveStripePriceId(f.stripe, p, 'USD')).toMatch(/^price_synced_/);
  });

  it('a failed create (and nothing to find afterwards) is a 502 too, and a failed product create is retried next time', async () => {
    const f = fakeStripe();
    f.api.products.create.mockRejectedValueOnce(new Error('stripe is down'));
    await expect(resolveStripePriceId(f.stripe, plan('practice_pack_5'), 'USD')).rejects.toMatchObject({ code: 'payment_provider_error', details: { step: 'create price' } });
    expect(f.prices).toEqual([]);
    expect(await resolveStripePriceId(f.stripe, plan('practice_pack_5'), 'USD')).toMatch(/^price_synced_/);
    expect(f.api.products.create).toHaveBeenCalledTimes(2);
  });

  it('keeps one cache per Stripe client', async () => {
    const a = fakeStripe();
    const b = fakeStripe();
    await resolveStripePriceId(a.stripe, plan('pro_monthly'), 'USD');
    expect(b.calls()).toBe(0);
    await resolveStripePriceId(b.stripe, plan('pro_monthly'), 'USD');
    expect(b.api.prices.create).toHaveBeenCalledTimes(1);
  });
});

describe('planKeyForPrice', () => {
  it('resolves a synced price from its metadata, from the lookup key alone, and a pinned id from env', async () => {
    const f = fakeStripe();
    const id = await resolveStripePriceId(f.stripe, plan('pro_quarterly'), 'USD');
    const synced = f.prices.find((p) => p.id === id)!;
    // As the sync created it (a cold instance has never resolved this price and has no pin for it).
    expect(planKeyForPrice(synced, {})).toBe('pro_quarterly');
    // Metadata edited away in the Dashboard: the lookup key still names the plan.
    expect(planKeyForPrice({ id, lookup_key: synced.lookup_key, metadata: {} }, {})).toBe('pro_quarterly');
    expect(planKeyForPrice({ id, lookup_key: 'ra_pro_weekly_twd_29900_incl', metadata: null }, {})).toBe('pro_weekly');
    // A pinned id, as an object or as a bare id.
    const pins = { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_m', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499', PRICE_PRO_MONTHLY_TWD_CENTS: '74900', STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_m_twd' };
    expect(planKeyForPrice({ id: 'price_m' }, pins)).toBe('pro_monthly');
    expect(planKeyForPrice('price_m', pins)).toBe('pro_monthly');
    expect(planKeyForPrice('price_m_twd', pins)).toBe('pro_monthly');
  });

  it('answers null for a price that is not ours', () => {
    expect(planKeyForPrice(null, READY)).toBeNull();
    expect(planKeyForPrice(undefined, READY)).toBeNull();
    expect(planKeyForPrice('price_unknown', READY)).toBeNull();
    expect(planKeyForPrice({ id: 'price_unknown', lookup_key: 'someone_elses_key', metadata: { planKey: 'enterprise' } }, READY)).toBeNull();
    // The account may be shared: a price that names another product is not ours, whatever its planKey says.
    expect(planKeyForPrice({ id: 'price_other', lookup_key: null, metadata: { product: 'robohire', planKey: 'pro_monthly' } }, READY)).toBeNull();
    // A bare id of a synced price cannot be resolved without the price object (and never by a Stripe call).
    expect(planKeyForPrice('price_synced_1', READY)).toBeNull();
  });
});

describe('syncStripeCatalog (optional warm-up)', () => {
  it('resolves every MVP plan once, listing at most 10 lookup keys per call and creating what is missing', async () => {
    const f = fakeStripe();
    const out = await syncStripeCatalog(f.stripe, READY);
    expect(out.map((o) => [o.planKey, o.currency])).toEqual([
      ['pro_weekly', 'USD'],
      ['pro_monthly', 'USD'],
      ['pro_quarterly', 'USD'],
      ['pro_week_pass', 'USD'],
      ['practice_pack_5', 'USD'],
      ['practice_pack_15', 'USD'],
    ]);
    expect(out.every((o) => f.prices.some((p) => p.id === o.priceId))).toBe(true);
    expect(f.api.prices.list).toHaveBeenCalledTimes(1);
    expect(f.api.prices.list.mock.calls[0]![0].lookup_keys).toEqual([
      'ra_pro_weekly_usd_999_incl',
      'ra_pro_monthly_usd_2499_incl',
      'ra_pro_quarterly_usd_5499_incl',
      'ra_pro_week_pass_usd_999_incl',
      'ra_practice_pack_5_usd_999_incl',
      'ra_practice_pack_15_usd_2499_incl',
    ]);
    expect(f.api.prices.create).toHaveBeenCalledTimes(6);
    // A second warm-up, and every later checkout, make no call.
    const before = f.calls();
    await syncStripeCatalog(f.stripe, READY);
    for (const o of out) expect(await resolveStripePriceId(f.stripe, plan(o.planKey), 'USD')).toBe(o.priceId);
    expect(f.calls()).toBe(before);
  });

  it('on an account that already holds the prices it creates nothing; with Taiwan amounts it splits the list at 10 keys', async () => {
    const tw = {
      ...READY,
      PRICE_PRO_WEEKLY_TWD_CENTS: '29900',
      PRICE_PRO_MONTHLY_TWD_CENTS: '74900',
      PRICE_PRO_QUARTERLY_TWD_CENTS: '165000',
      PRICE_PRO_WEEK_PASS_TWD_CENTS: '29900',
      PRICE_PRACTICE_PACK_5_TWD_CENTS: '29900',
      PRICE_PRACTICE_PACK_15_TWD_CENTS: '74900',
    };
    const first = fakeStripe();
    const created = await syncStripeCatalog(first.stripe, tw);
    expect(created).toHaveLength(12);
    expect(first.api.prices.list.mock.calls.map((c) => c[0].lookup_keys.length)).toEqual([STRIPE_LOOKUP_KEYS_PER_CALL, 2]);

    // A cold instance against the same account: everything is found, nothing is created.
    resetStripeCatalogCacheForTests();
    const second = fakeStripe({ prices: first.prices, products: [...first.products] });
    const found = await syncStripeCatalog(second.stripe, tw);
    expect(found).toEqual(created);
    expect(second.api.prices.create).not.toHaveBeenCalled();
    expect(second.api.products.create).not.toHaveBeenCalled();
    expect(second.api.prices.list).toHaveBeenCalledTimes(2);
  });

  it('pinned plans are returned as pinned and never listed or created', async () => {
    const f = fakeStripe();
    const out = await syncStripeCatalog(f.stripe, { ...READY, STRIPE_PRICE_PRO_MONTHLY: 'price_pinned', PRICE_PRO_MONTHLY_USD_CENTS: '2499' });
    expect(out.find((o) => o.planKey === 'pro_monthly')).toEqual({ planKey: 'pro_monthly', currency: 'USD', priceId: 'price_pinned' });
    expect(f.api.prices.list.mock.calls[0]![0].lookup_keys).not.toContain('ra_pro_monthly_usd_2499_incl');
    expect(f.prices.some((p) => p.lookup_key === 'ra_pro_monthly_usd_2499_incl')).toBe(false);
  });

  it('a Stripe failure is a 502 and leaves nothing half-remembered', async () => {
    const f = fakeStripe();
    f.api.prices.list.mockRejectedValueOnce(new Error('stripe is down'));
    await expect(syncStripeCatalog(f.stripe, READY)).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    expect(await syncStripeCatalog(f.stripe, READY)).toHaveLength(6);
  });
});
