// @vitest-environment node
//
// ST-2 server half (MARKET_STRATEGY §5.1 "Checkout", "Idempotency keys"): the
// Stripe rail resolves the price through the catalog sync, keys every create
// call, opens the session in the buyer's language with Adaptive Pricing off
// and repeats period, price and how to cancel above the pay button. The
// Stripe object is a hand-written fake: nothing here can reach Stripe.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { getBrand } from '../../brand/registry.js';
import { getPlan } from '../planCatalog.js';
import { resetStripeCatalogCacheForTests } from '../stripeCatalog.js';
import {
  CHECKOUT_ATTEMPT_BUCKET_MS,
  CHECKOUT_SUBMIT_TEXT_MAX,
  checkoutAttemptKey,
  checkoutIdempotencyKey,
  checkoutSubmitMessage,
  createStripeRail,
  stripeCheckoutLocale,
  type StripeRailDb,
} from './stripe.js';
import type { CheckoutOrder } from './types.js';

const NOW = new Date('2026-10-10T08:00:20.000Z');
/** The Stripe rail is ready and no price variable is set. */
const ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  NEXT_PUBLIC_ROBOAPPLY_URL: 'https://app.example.test/',
};

function fakeStripe(seedPrices: Array<Record<string, any>> = []) {
  const prices: Array<Record<string, any>> = [...seedPrices];
  let n = 0;
  let sessions = 0;
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
      sessions: {
        create: vi.fn(async (_params: Record<string, any>, _opts?: Record<string, any>) => {
          const id = `cs_${++sessions}`;
          return { id, url: `https://checkout.stripe.test/${id}` };
        }),
      },
    },
  };
  const calls = () =>
    api.customers.create.mock.calls.length + api.products.create.mock.calls.length + api.prices.list.mock.calls.length + api.prices.create.mock.calls.length + api.checkout.sessions.create.mock.calls.length;
  return { api, prices, calls };
}

function order(planKey: string, over: Partial<CheckoutOrder> = {}, env: Record<string, string> = ENV, brand: 'roboapply' | 'goapply' = 'roboapply'): CheckoutOrder {
  return {
    brand: getBrand(brand),
    plan: getPlan(brand, planKey as never, env)!,
    user: { id: 'user_1', email: 'u@example.test', name: 'U' },
    seekerProfileId: 'sp_1',
    stripeCustomerId: 'cus_1',
    acknowledgements: { autoRenewAck: true, withdrawalWaiver: false },
    ...over,
  };
}

function railWith(f: ReturnType<typeof fakeStripe>, opts: { env?: Record<string, string>; now?: () => Date; db?: StripeRailDb } = {}) {
  return createStripeRail({
    getStripe: () => f.api as never,
    env: opts.env ?? ENV,
    now: opts.now ?? (() => NOW),
    ...(opts.db ? { getDb: async () => opts.db! } : {}),
  });
}

const sessionParams = (f: ReturnType<typeof fakeStripe>, i = 0) => f.api.checkout.sessions.create.mock.calls[i]![0];
const sessionOptions = (f: ReturnType<typeof fakeStripe>, i = 0) => f.api.checkout.sessions.create.mock.calls[i]![1];

beforeEach(() => {
  vi.clearAllMocks();
  resetStripeCatalogCacheForTests();
});

describe('the price is resolved at checkout through the catalog sync', () => {
  it('with no price variable a monthly checkout creates the session on the price created under ra_pro_monthly_usd_2499_incl', async () => {
    const f = fakeStripe();
    const res = await railWith(f).createCheckout(order('pro_monthly'));
    expect(res).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.test/cs_1', orderId: 'cs_1' });
    const synced = f.prices.find((p) => p.lookup_key === 'ra_pro_monthly_usd_2499_incl')!;
    expect(synced).toMatchObject({ unit_amount: 2499, currency: 'usd', product: 'ra_pro', recurring: { interval: 'month', interval_count: 1 }, tax_behavior: 'inclusive', metadata: { planKey: 'pro_monthly' } });
    expect(sessionParams(f)).toMatchObject({ mode: 'subscription', customer: 'cus_1', line_items: [{ price: synced.id, quantity: 1 }], client_reference_id: 'user_1' });
    expect(sessionParams(f).metadata).toMatchObject({ product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly', userId: 'user_1', seekerProfileId: 'sp_1', autoRenewAck: 'yes', currency: 'usd' });
    expect(sessionParams(f).subscription_data.metadata).toEqual(sessionParams(f).metadata);
  });

  it('a price that already exists under the lookup key is used; a second checkout asks Stripe for no price', async () => {
    const f = fakeStripe([{ id: 'price_found', active: true, product: 'ra_pro', currency: 'usd', unit_amount: 2499, lookup_key: 'ra_pro_monthly_usd_2499_incl', recurring: { interval: 'month', interval_count: 1 } }]);
    const rail = railWith(f);
    await rail.createCheckout(order('pro_monthly', { attemptKey: 'attempt-0001' }));
    await rail.createCheckout(order('pro_monthly', { attemptKey: 'attempt-0002' }));
    expect(f.api.checkout.sessions.create.mock.calls.map((c) => c[0].line_items[0].price)).toEqual(['price_found', 'price_found']);
    expect(f.api.prices.list).toHaveBeenCalledTimes(1);
    expect(f.api.prices.create).not.toHaveBeenCalled();
    expect(f.api.products.create).not.toHaveBeenCalled();
  });

  it('the pass and the packs are one-time payments with an invoice, on one-time prices', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    await rail.createCheckout(order('pro_week_pass'));
    await rail.createCheckout(order('practice_pack_15'));
    const [pass, pack] = [sessionParams(f, 0), sessionParams(f, 1)];
    expect(pass).toMatchObject({ mode: 'payment', invoice_creation: { enabled: true }, payment_intent_data: { metadata: { planKey: 'pro_week_pass' } } });
    expect(pass.metadata.autoRenewAck).toBe('n/a');
    expect(pass.subscription_data).toBeUndefined();
    expect(pack).toMatchObject({ mode: 'payment', invoice_creation: { enabled: true, invoice_data: { metadata: { planKey: 'practice_pack_15' } } } });
    expect(f.prices.map((p) => [p.lookup_key, p.recurring, p.product])).toEqual([
      ['ra_pro_week_pass_usd_999_incl', null, 'ra_pro_week_pass'],
      ['ra_practice_pack_15_usd_2499_incl', null, 'ra_practice_pack'],
    ]);
  });

  it('a pinned price is charged as pinned, with no Stripe price call', async () => {
    const env = { ...ENV, STRIPE_PRICE_PRO_MONTHLY: 'price_pinned', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499' };
    const f = fakeStripe();
    await railWith(f, { env }).createCheckout(order('pro_monthly', {}, env));
    expect(sessionParams(f).line_items).toEqual([{ price: 'price_pinned', quantity: 1 }]);
    expect(f.api.prices.list).not.toHaveBeenCalled();
    expect(f.api.prices.create).not.toHaveBeenCalled();
  });

  it('a pin left next to a changed amount is not charged: the session is opened on the price of the amount shown', async () => {
    // The older pair (pin + 2499), then the price moved to 1999 with the new variable and the pair left in place.
    const env = { ...ENV, PRICE_PRO_MONTHLY_USD_CENTS: '1999', STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499', STRIPE_PRICE_PRO_MONTHLY: 'price_old_2499' };
    const f = fakeStripe();
    const o = order('pro_monthly', {}, env);
    expect(o.plan.amountMinor).toBe(1999);
    await railWith(f, { env }).createCheckout(o);
    const synced = f.prices.find((p) => p.lookup_key === 'ra_pro_monthly_usd_1999_incl')!;
    expect(synced).toMatchObject({ unit_amount: 1999, currency: 'usd' });
    expect(sessionParams(f).line_items).toEqual([{ price: synced.id, quantity: 1 }]);
    expect(JSON.stringify(sessionParams(f))).not.toContain('price_old_2499');
    // What the buyer reads above the pay button is the amount of that price.
    expect(sessionParams(f).custom_text.submit.message).toContain('$19.99');
    expect(sessionParams(f).custom_text.submit.message).not.toContain('24.99');
  });

  it('a Taiwan buyer on a configured TWD amount is charged the TWD price (lookup key ..._twd_..._incl); everyone else the USD price', async () => {
    const env = { ...ENV, PRICE_PRO_MONTHLY_TWD_CENTS: '74900' };
    const f = fakeStripe();
    const rail = railWith(f, { env });
    await rail.createCheckout(order('pro_monthly', { country: 'TW', attemptKey: 'attempt-tw-1' }, env));
    await rail.createCheckout(order('pro_monthly', { country: 'US', attemptKey: 'attempt-us-1' }, env));
    // No Taiwan amount for the weekly plan: a Taiwan buyer pays USD for it.
    await rail.createCheckout(order('pro_weekly', { country: 'TW', attemptKey: 'attempt-tw-2' }, env));
    const twd = f.prices.find((p) => p.lookup_key === 'ra_pro_monthly_twd_74900_incl')!;
    const usd = f.prices.find((p) => p.lookup_key === 'ra_pro_monthly_usd_2499_incl')!;
    const weekly = f.prices.find((p) => p.lookup_key === 'ra_pro_weekly_usd_999_incl')!;
    expect(twd).toMatchObject({ currency: 'twd', unit_amount: 74900 });
    expect(f.api.checkout.sessions.create.mock.calls.map((c) => c[0].line_items[0].price)).toEqual([twd.id, usd.id, weekly.id]);
    expect(f.api.checkout.sessions.create.mock.calls.map((c) => c[0].metadata.currency)).toEqual(['twd', 'usd', 'usd']);
    expect(f.api.checkout.sessions.create.mock.calls.map((c) => c[1].idempotencyKey)).toEqual([
      'checkout:user_1:pro_monthly:twd:attempt-tw-1',
      'checkout:user_1:pro_monthly:usd:attempt-us-1',
      'checkout:user_1:pro_weekly:usd:attempt-tw-2',
    ]);
    // The line above the pay button names the amount that is charged.
    expect(sessionParams(f, 0).custom_text.submit.message).toContain('NT$749');
    expect(sessionParams(f, 1).custom_text.submit.message).toContain('$24.99');
  });

  it('a Stripe failure in the catalog sync answers payment_provider_error (502): no customer, no session', async () => {
    const f = fakeStripe();
    f.api.prices.list.mockRejectedValue(new Error('stripe is down'));
    await expect(railWith(f).createCheckout(order('pro_monthly', { stripeCustomerId: null }))).rejects.toMatchObject({ code: 'payment_provider_error', status: 502 });
    expect(f.api.customers.create).not.toHaveBeenCalled();
    expect(f.api.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe('idempotency keys', () => {
  it('customers.create carries customer:<seekerProfileId>, and the customer is stored', async () => {
    const f = fakeStripe();
    const db = createFakePrisma();
    await railWith(f, { db: db as unknown as StripeRailDb }).createCheckout(order('pro_monthly', { stripeCustomerId: null, seekerProfileId: 'sp_42' }));
    expect(f.api.customers.create).toHaveBeenCalledTimes(1);
    expect(f.api.customers.create).toHaveBeenCalledWith(
      { email: 'u@example.test', metadata: { userId: 'user_1', seekerProfileId: 'sp_42', product: 'roboapply', brand: 'roboapply' } },
      { idempotencyKey: 'customer:sp_42' },
    );
    expect(await db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_42' } })).toMatchObject({ stripeCustomerId: 'cus_new', tier: 'free', brand: 'roboapply' });
    expect(sessionParams(f).customer).toBe('cus_new');
  });

  it('the same attempt key twice gives the same Stripe idempotency key; a different one a different key', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    const uuid = '3f0c1b0a-8a3e-4c57-9d0e-2b6f5f3a9c11';
    await rail.createCheckout(order('pro_monthly', { attemptKey: uuid }));
    await rail.createCheckout(order('pro_monthly', { attemptKey: uuid }));
    await rail.createCheckout(order('pro_monthly', { attemptKey: '7d9e5a12-1111-4222-8333-944455556666' }));
    const keys = f.api.checkout.sessions.create.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys[0]).toBe(`checkout:user_1:pro_monthly:usd:${uuid}`);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe('checkout:user_1:pro_monthly:usd:7d9e5a12-1111-4222-8333-944455556666');
    // Same attempt, same parameters: Stripe can replay the first session.
    expect(sessionParams(f, 1)).toEqual(sessionParams(f, 0));
  });

  it('without an attempt key two calls in the same minute share a key and a call a minute later does not', async () => {
    const f = fakeStripe();
    let now = new Date('2026-10-10T08:00:05.000Z');
    const rail = railWith(f, { now: () => now });
    await rail.createCheckout(order('practice_pack_5'));
    now = new Date('2026-10-10T08:00:55.000Z');
    await rail.createCheckout(order('practice_pack_5'));
    now = new Date('2026-10-10T08:01:05.000Z');
    await rail.createCheckout(order('practice_pack_5'));
    const keys = f.api.checkout.sessions.create.mock.calls.map((c) => c[1].idempotencyKey);
    const bucket = Math.floor(new Date('2026-10-10T08:00:05.000Z').getTime() / CHECKOUT_ATTEMPT_BUCKET_MS);
    expect(keys[0]).toBe(`checkout:user_1:practice_pack_5:usd:b${bucket}`);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(`checkout:user_1:practice_pack_5:usd:b${bucket + 1}`);
  });

  it('a malformed attempt key is not used: the bucket answers', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    const bucketKey = `checkout:user_1:pro_monthly:usd:b${Math.floor(NOW.getTime() / CHECKOUT_ATTEMPT_BUCKET_MS)}`;
    for (const bad of ['short', 'has space in it', 'a'.repeat(65), 'semi;colon;key', '', null, undefined]) {
      f.api.checkout.sessions.create.mockClear();
      await rail.createCheckout(order('pro_monthly', { attemptKey: bad as never }));
      expect(sessionOptions(f).idempotencyKey, String(bad)).toBe(bucketKey);
    }
    expect(checkoutAttemptKey('  abcdefgh  ')).toBe('abcdefgh');
    expect(checkoutAttemptKey('A-Z_a-z0-9')).toBe('A-Z_a-z0-9');
    expect(checkoutAttemptKey('abcdefg')).toBeUndefined();
    expect(checkoutAttemptKey(['abcdefgh'])).toBeUndefined();
    expect(checkoutIdempotencyKey({ userId: 'u', planKey: 'pro_weekly', currency: 'TWD', attemptKey: 'abcdefgh', now: NOW })).toBe('checkout:u:pro_weekly:twd:abcdefgh');
  });

  it('the key separates users, plans and currencies for one attempt key', async () => {
    const f = fakeStripe();
    const env = { ...ENV, PRICE_PRO_MONTHLY_TWD_CENTS: '74900' };
    const rail = railWith(f, { env });
    const attemptKey = 'same-attempt-key';
    await rail.createCheckout(order('pro_monthly', { attemptKey }, env));
    await rail.createCheckout(order('pro_quarterly', { attemptKey }, env));
    await rail.createCheckout(order('pro_monthly', { attemptKey, country: 'TW' }, env));
    await rail.createCheckout(order('pro_monthly', { attemptKey, user: { id: 'user_2', email: 'v@example.test', name: null } }, env));
    const keys = f.api.checkout.sessions.create.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('a Stripe idempotency error (same key, different parameters) is payment_provider_error with reason idempotency_conflict', async () => {
    const f = fakeStripe();
    f.api.checkout.sessions.create.mockRejectedValueOnce(Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters they were first used with.'), { type: 'StripeIdempotencyError', rawType: 'idempotency_error' }));
    await expect(railWith(f).createCheckout(order('pro_monthly', { attemptKey: 'attempt-0001' }))).rejects.toMatchObject({
      code: 'payment_provider_error',
      status: 502,
      details: { provider: 'stripe', reason: 'idempotency_conflict' },
    });
    // Any other Stripe failure carries no such reason.
    f.api.checkout.sessions.create.mockRejectedValueOnce(new Error('card network unavailable'));
    const other = await railWith(f).createCheckout(order('pro_monthly', { attemptKey: 'attempt-0002' })).catch((e) => e);
    expect(other).toMatchObject({ code: 'payment_provider_error', status: 502 });
    expect(other.details.reason).toBeUndefined();
  });
});

describe('the session', () => {
  it('carries adaptive_pricing disabled, the mapped locale, customer_update and custom_text', async () => {
    const f = fakeStripe();
    await railWith(f).createCheckout(order('pro_monthly', { locale: 'zh-TW' }));
    const p = sessionParams(f);
    expect(p.adaptive_pricing).toEqual({ enabled: false });
    expect(p.locale).toBe('zh-TW');
    expect(p.customer_update).toEqual({ address: 'auto', name: 'auto' });
    expect(p.billing_address_collection).toBe('auto');
    expect(p.custom_text).toEqual({
      submit: { message: 'Renews every month at $24.99 until you cancel. Cancel any time in Settings or at https://app.example.test/cancel.' },
    });
    expect(p.subscription_data.description).toBe('RoboApply Pro Monthly');
    expect(p.allow_promotion_codes).toBe(false);
    expect(p.success_url).toBe('https://app.example.test/settings/billing/return?billing=success&session_id={CHECKOUT_SESSION_ID}');
    expect(p.cancel_url).toBe('https://app.example.test/settings/billing?billing=cancel');
  });

  it('maps every app locale to a Stripe Checkout locale, and anything else to auto', () => {
    expect(
      Object.fromEntries(['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt'].map((l) => [l, stripeCheckoutLocale(l)])),
    ).toEqual({ en: 'en', zh: 'zh', 'zh-TW': 'zh-TW', ja: 'ja', ko: 'ko', es: 'es', fr: 'fr', de: 'de', pt: 'pt-BR' });
    expect(stripeCheckoutLocale('zh-tw')).toBe('zh-TW');
    expect(stripeCheckoutLocale('zh_TW')).toBe('zh-TW');
    expect(stripeCheckoutLocale(' EN ')).toBe('en');
    for (const other of ['it', 'xx', '', null, undefined, 'en-US; drop table']) expect(stripeCheckoutLocale(other as never), String(other)).toBe('auto');
  });

  it('opens in the mapped locale for each app locale; without one Stripe chooses', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    await rail.createCheckout(order('pro_monthly', { locale: 'pt', attemptKey: 'attempt-pt-01' }));
    await rail.createCheckout(order('pro_monthly', { attemptKey: 'attempt-none-1' }));
    await rail.createCheckout(order('pro_monthly', { locale: 'tlh', attemptKey: 'attempt-tlh-1' }));
    expect(f.api.checkout.sessions.create.mock.calls.map((c) => c[0].locale)).toEqual(['pt-BR', 'auto', 'auto']);
  });

  it('the line above the pay button repeats period, price and how to cancel for a renewing plan', () => {
    const origin = 'https://www.roboapply.io';
    expect(checkoutSubmitMessage(getPlan('roboapply', 'pro_weekly', ENV)!, { amountMinor: 999, currency: 'USD' }, origin)).toBe(
      'Renews every week at $9.99 until you cancel. Cancel any time in Settings or at https://www.roboapply.io/cancel.',
    );
    expect(checkoutSubmitMessage(getPlan('roboapply', 'pro_quarterly', ENV)!, { amountMinor: 5499, currency: 'USD' }, origin)).toBe(
      'Renews every 3 months at $54.99 until you cancel. Cancel any time in Settings or at https://www.roboapply.io/cancel.',
    );
    expect(checkoutSubmitMessage(getPlan('roboapply', 'pro_monthly', ENV)!, { amountMinor: 74900, currency: 'TWD' }, origin)).toBe(
      'Renews every month at NT$749 until you cancel. Cancel any time in Settings or at https://www.roboapply.io/cancel.',
    );
  });

  it('for the pass and the packs it says one payment and that it does not renew', async () => {
    expect(checkoutSubmitMessage(getPlan('roboapply', 'pro_week_pass', ENV)!, { amountMinor: 999, currency: 'USD' }, 'https://x.test')).toBe('One payment of $9.99. It does not renew.');
    expect(checkoutSubmitMessage(getPlan('roboapply', 'practice_pack_15', ENV)!, { amountMinor: 2499, currency: 'USD' }, 'https://x.test')).toBe('One payment of $24.99. It does not renew.');
    const f = fakeStripe();
    await railWith(f).createCheckout(order('practice_pack_5'));
    expect(sessionParams(f).custom_text.submit.message).toBe('One payment of $9.99. It does not renew.');
  });

  it('the text is built from the amount charged (an override moves it) and never exceeds the Stripe limit', async () => {
    const env = { ...ENV, PRICE_PRO_MONTHLY_USD_CENTS: '2999' };
    const f = fakeStripe();
    await railWith(f, { env }).createCheckout(order('pro_monthly', {}, env));
    expect(sessionParams(f).custom_text.submit.message).toContain('$29.99');
    const long = checkoutSubmitMessage(getPlan('roboapply', 'pro_monthly', ENV)!, { amountMinor: 2499, currency: 'USD' }, `https://${'a'.repeat(3000)}.test`);
    expect(long.length).toBe(CHECKOUT_SUBMIT_TEXT_MAX);
  });
});

describe('what the rail refuses before it touches Stripe', () => {
  it('a GoApply order handed straight to the Stripe rail is refused with plan_not_sellable; the fake Stripe records zero calls of any kind', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    for (const key of ['pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15']) {
      const o = order(key, { stripeCustomerId: null }, ENV, 'goapply');
      // Sellable, with a CNY amount: only the brand (and the currency) stand between it and Stripe.
      expect(o.plan).toMatchObject({ sellable: true, currency: 'CNY', stripePriceId: null });
      await expect(rail.createCheckout(o), key).rejects.toMatchObject({ code: 'plan_not_sellable', status: 409 });
    }
    expect(f.calls()).toBe(0);
    expect(f.api.customers.create).not.toHaveBeenCalled();
    expect(f.api.products.create).not.toHaveBeenCalled();
    expect(f.api.prices.list).not.toHaveBeenCalled();
    expect(f.api.prices.create).not.toHaveBeenCalled();
    expect(f.api.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('a RoboApply plan carried by the GoApply brand, or a GoApply plan carried by the RoboApply brand, never reaches Stripe either', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    await expect(rail.createCheckout({ ...order('pro_monthly', { stripeCustomerId: null }), brand: getBrand('goapply') })).rejects.toMatchObject({ code: 'plan_not_sellable' });
    await expect(rail.createCheckout({ ...order('pro_monthly', { stripeCustomerId: null }, ENV, 'goapply'), brand: getBrand('roboapply') })).rejects.toMatchObject({ code: 'plan_not_sellable' });
    expect(f.calls()).toBe(0);
  });

  it('a plan while the rail is not ready, and the free plan, are refused with no Stripe call', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    const keyOnly = { STRIPE_SECRET_KEY: 'sk_test_x' };
    await expect(rail.createCheckout(order('pro_monthly', { stripeCustomerId: null }, keyOnly))).rejects.toMatchObject({ code: 'plan_not_sellable', details: { reason: 'payments_disabled' } });
    await expect(rail.createCheckout(order('free', { stripeCustomerId: null }))).rejects.toMatchObject({ code: 'plan_not_sellable' });
    expect(f.calls()).toBe(0);
  });

  it('no client (no key, or a live key outside production): rail_not_configured', async () => {
    const rail = createStripeRail({ getStripe: () => null, env: ENV });
    await expect(rail.createCheckout(order('pro_monthly'))).rejects.toMatchObject({ code: 'rail_not_configured', status: 503 });
  });

  it('a student plan still needs the verification, before any price or customer exists', async () => {
    const f = fakeStripe();
    const rail = railWith(f);
    await expect(rail.createCheckout(order('student_monthly', { stripeCustomerId: null }))).rejects.toMatchObject({ code: 'student_verification_required' });
    expect(f.calls()).toBe(0);
    await rail.createCheckout(order('student_monthly', { studentVerified: true }));
    expect(f.prices[0]).toMatchObject({ lookup_key: 'ra_student_monthly_usd_1749_incl', product: 'ra_pro_student' });
    expect(sessionParams(f).allow_promotion_codes).toBe(false);
  });
});
