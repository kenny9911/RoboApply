// @vitest-environment node
//
// ST-8 (MARKET_STRATEGY §5.1 "Tax", decision M-15): `STRIPE_TAX_ENABLED`, off
// by default. Off: the Checkout Session carries no tax field and the billing
// address stays optional, exactly what the rail sent before the switch
// existed. On: automatic tax, tax id collection and a required billing
// address, for a subscription and for a one-time payment alike.
// The Stripe object is a hand-written fake: nothing here can reach Stripe.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../brand/registry.js';
import { getPlan } from '../planCatalog.js';
import { resetStripeCatalogCacheForTests } from '../stripeCatalog.js';
import { STRIPE_TAX_ENV, checkoutTaxParams, createStripeRail, stripeTaxEnabled } from './stripe.js';
import type { CheckoutOrder } from './types.js';

const NOW = new Date('2026-10-10T08:00:20.000Z');
/** The Stripe rail is ready and no price variable is set; the tax switch is not set. */
const ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  NEXT_PUBLIC_ROBOAPPLY_URL: 'https://app.example.test/',
};
const TAX_ON = { ...ENV, STRIPE_TAX_ENABLED: 'true' };

function fakeStripe() {
  const prices: Array<Record<string, any>> = [];
  let n = 0;
  const api = {
    customers: { create: vi.fn(async (_params: Record<string, any>, _opts?: Record<string, any>) => ({ id: 'cus_new' })) },
    products: { create: vi.fn(async (p: { id: string }, _opts?: Record<string, any>) => ({ id: p.id })) },
    prices: {
      list: vi.fn(async (p: { lookup_keys: string[] }) => ({ data: prices.filter((x) => p.lookup_keys.includes(x.lookup_key)) })),
      create: vi.fn(async (p: Record<string, any>, _opts?: Record<string, any>) => {
        const price = { ...p, id: `price_synced_${++n}`, active: true, recurring: p.recurring ?? null };
        prices.push(price);
        return price;
      }),
    },
    checkout: {
      sessions: { create: vi.fn(async (_params: Record<string, any>, _opts?: Record<string, any>) => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })) },
    },
  };
  return api;
}

function order(planKey: string, env: Record<string, string>, over: Partial<CheckoutOrder> = {}): CheckoutOrder {
  return {
    brand: getBrand('roboapply'),
    plan: getPlan('roboapply', planKey as never, env)!,
    user: { id: 'user_1', email: 'u@example.test', name: 'U' },
    seekerProfileId: 'sp_1',
    stripeCustomerId: 'cus_1',
    acknowledgements: { autoRenewAck: true, withdrawalWaiver: false },
    attemptKey: 'attempt-0001',
    ...over,
  };
}

/** The parameters of the one Checkout Session a checkout of `planKey` creates under `env`. */
async function sessionFor(planKey: string, env: Record<string, string>, over: Partial<CheckoutOrder> = {}): Promise<Record<string, any>> {
  const api = fakeStripe();
  await createStripeRail({ getStripe: () => api as never, env, now: () => NOW }).createCheckout(order(planKey, env, over));
  expect(api.checkout.sessions.create).toHaveBeenCalledTimes(1);
  return api.checkout.sessions.create.mock.calls[0]![0];
}

const TAX_FIELDS = ['automatic_tax', 'tax_id_collection'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetStripeCatalogCacheForTests();
});

describe('the switch itself', () => {
  it('is named STRIPE_TAX_ENABLED and is off unless it is set to a true value', () => {
    expect(STRIPE_TAX_ENV).toBe('STRIPE_TAX_ENABLED');
    for (const env of [{}, { STRIPE_TAX_ENABLED: '' }, { STRIPE_TAX_ENABLED: 'false' }, { STRIPE_TAX_ENABLED: '0' }, { STRIPE_TAX_ENABLED: 'off' }, { STRIPE_TAX_ENABLED: 'no' }]) {
      expect(stripeTaxEnabled(env)).toBe(false);
    }
    for (const value of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) expect(stripeTaxEnabled({ STRIPE_TAX_ENABLED: value })).toBe(true);
  });

  it('off adds only the optional address; on adds the three tax settings', () => {
    expect(checkoutTaxParams({})).toEqual({ billing_address_collection: 'auto' });
    expect(checkoutTaxParams({ STRIPE_TAX_ENABLED: 'true' })).toEqual({
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
    });
  });
});

describe.each([
  ['a subscription (pro_monthly)', 'pro_monthly', 'subscription'],
  ['a one-time payment (the 7-day pass)', 'pro_week_pass', 'payment'],
  ['a one-time payment (a practice pack)', 'practice_pack_5', 'payment'],
] as const)('Checkout for %s', (_name, planKey, mode) => {
  it('off (the default): no tax field is sent and the billing address stays optional', async () => {
    const params = await sessionFor(planKey, ENV);
    expect(params.mode).toBe(mode);
    for (const field of TAX_FIELDS) expect(params).not.toHaveProperty(field);
    expect(params.billing_address_collection).toBe('auto');
    expect(params.customer_update).toEqual({ address: 'auto', name: 'auto' });
  });

  it.each([['false'], ['0'], ['off'], ['']])('off when the variable is set to "%s"', async (value) => {
    const params = await sessionFor(planKey, { ...ENV, STRIPE_TAX_ENABLED: value });
    for (const field of TAX_FIELDS) expect(params).not.toHaveProperty(field);
    expect(params.billing_address_collection).toBe('auto');
  });

  it('on: automatic tax, tax id collection and a required billing address are sent', async () => {
    const params = await sessionFor(planKey, TAX_ON);
    expect(params.mode).toBe(mode);
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe('required');
    // Stripe requires both with tax on an existing customer; they are always sent.
    expect(params.customer_update).toEqual({ address: 'auto', name: 'auto' });
  });

  it('on changes nothing else: the two sessions differ only in the three tax settings', async () => {
    const off = await sessionFor(planKey, ENV);
    const on = await sessionFor(planKey, TAX_ON);
    const { automatic_tax: _a, tax_id_collection: _t, billing_address_collection: _b, ...rest } = on;
    const { billing_address_collection: _offAddress, ...offRest } = off;
    expect(rest).toEqual(offRest);
  });
});

describe('the default environment sends exactly what the rail sent before the switch existed', () => {
  it('a subscription session has these parameters and no others', async () => {
    const params = await sessionFor('pro_monthly', ENV);
    expect(Object.keys(params).sort()).toEqual(
      [
        'adaptive_pricing',
        'allow_promotion_codes',
        'billing_address_collection',
        'cancel_url',
        'client_reference_id',
        'custom_text',
        'customer',
        'customer_update',
        'line_items',
        'locale',
        'metadata',
        'mode',
        'subscription_data',
        'success_url',
      ].sort(),
    );
  });

  it('a one-time payment session has these parameters and no others', async () => {
    const params = await sessionFor('pro_week_pass', ENV);
    expect(Object.keys(params).sort()).toEqual(
      [
        'adaptive_pricing',
        'allow_promotion_codes',
        'billing_address_collection',
        'cancel_url',
        'client_reference_id',
        'custom_text',
        'customer',
        'customer_update',
        'invoice_creation',
        'line_items',
        'locale',
        'metadata',
        'mode',
        'payment_intent_data',
        'success_url',
      ].sort(),
    );
  });
});

describe('what the switch does not change', () => {
  it('the price is still the tax-inclusive catalog price, and the line above the pay button names it', async () => {
    const api = fakeStripe();
    await createStripeRail({ getStripe: () => api as never, env: TAX_ON, now: () => NOW }).createCheckout(order('pro_monthly', TAX_ON));
    expect(api.prices.create.mock.calls[0]![0]).toMatchObject({ lookup_key: 'ra_pro_monthly_usd_2499_incl', unit_amount: 2499, tax_behavior: 'inclusive' });
    expect(api.checkout.sessions.create.mock.calls[0]![0].custom_text.submit.message).toContain('$24.99');
  });

  it('a Taiwan buyer on a TWD price gets the same three settings', async () => {
    const env = { ...TAX_ON, PRICE_PRO_MONTHLY_TWD_CENTS: '74900' };
    const params = await sessionFor('pro_monthly', env, { country: 'TW' });
    expect(params.metadata.currency).toBe('twd');
    expect(params).toMatchObject({ automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, billing_address_collection: 'required' });
  });

  it('rule A11 holds with the switch on: a GoApply order is refused before any Stripe call', async () => {
    const api = fakeStripe();
    const goapply: CheckoutOrder = { ...order('pro_monthly', TAX_ON), brand: getBrand('goapply'), plan: getPlan('goapply', 'pro_monthly', TAX_ON)! };
    await expect(createStripeRail({ getStripe: () => api as never, env: TAX_ON, now: () => NOW }).createCheckout(goapply)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    for (const fn of [api.customers.create, api.products.create, api.prices.list, api.prices.create, api.checkout.sessions.create]) expect(fn).not.toHaveBeenCalled();
  });
});
