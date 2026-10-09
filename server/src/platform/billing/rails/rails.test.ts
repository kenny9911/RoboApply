// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { getBrand } from '../../brand/registry.js';
import { getPlan } from '../planCatalog.js';
import { createStripeRail, type StripeRailDb } from './stripe.js';
import { alipayCallbackSecretOk, createAlipayWorkerRail, type AlipayRailDb } from './alipayWorker.js';
import { CallbackRejectedError, type CheckoutOrder } from './types.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  NEXT_PUBLIC_ROBOAPPLY_URL: 'https://app.example.test/',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_WEEK_PASS: 'price_p',
  STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '699',
  STRIPE_PRICE_PRACTICE_PACK_5: 'price_5',
  STRIPE_PRICE_PRACTICE_PACK_5_CENTS: '999',
  CN_PAYMENTS_ENABLED: 'true',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRO_WEEK_PASS_FEN: '1250',
  CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
  ALIPAY_API_URL: 'https://pay.example.test/create',
  ALIPAY_CALLBACK_SECRET: 'cb+secret&?',
};

function order(brand: 'roboapply' | 'goapply', planKey: string, over: Partial<CheckoutOrder> = {}): CheckoutOrder {
  return {
    brand: getBrand(brand),
    plan: getPlan(brand, planKey as never, ENV)!,
    user: { id: 'user_123456789', email: 'u@example.test', name: 'U' },
    seekerProfileId: 'sp_1',
    stripeCustomerId: 'cus_1',
    acknowledgements: { autoRenewAck: true, withdrawalWaiver: false },
    ...over,
  };
}

function fakeStripe() {
  return {
    customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
    checkout: { sessions: { create: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })) } },
  };
}

describe('StripeRail', () => {
  it('sells Pro Monthly as a subscription with brand + planKey metadata and an acknowledgement trail', async () => {
    const stripe = fakeStripe();
    const rail = createStripeRail({ getStripe: () => stripe as never, env: ENV });
    const res = await rail.createCheckout(order('roboapply', 'pro_monthly'));
    expect(res).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.test/cs_1', orderId: 'cs_1' });
    const params = stripe.checkout.sessions.create.mock.calls[0]![0] as Record<string, any>;
    expect(params.mode).toBe('subscription');
    expect(params.line_items).toEqual([{ price: 'price_m', quantity: 1 }]);
    expect(params.metadata).toMatchObject({ product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly', userId: 'user_123456789', autoRenewAck: 'yes', withdrawalWaiver: 'no' });
    expect(params.subscription_data.metadata).toEqual(params.metadata);
    expect(params.allow_promotion_codes).toBe(false);
    expect(params.success_url).toBe('https://app.example.test/settings/billing/return?billing=success&session_id={CHECKOUT_SESSION_ID}');
    expect(params.cancel_url).toBe('https://app.example.test/settings/billing?billing=cancel');
  });

  it('sells the 7-day pass and packs as one-time payments', async () => {
    const stripe = fakeStripe();
    const rail = createStripeRail({ getStripe: () => stripe as never, env: ENV });
    await rail.createCheckout(order('roboapply', 'pro_week_pass'));
    await rail.createCheckout(order('roboapply', 'practice_pack_5'));
    const [pass, pack] = stripe.checkout.sessions.create.mock.calls.map((c) => c[0] as Record<string, any>);
    expect(pass.mode).toBe('payment');
    expect(pass.metadata.autoRenewAck).toBe('n/a');
    expect(pass.payment_intent_data.metadata.planKey).toBe('pro_week_pass');
    expect(pack.mode).toBe('payment');
    expect(pack.invoice_creation).toMatchObject({ enabled: true });
  });

  it('creates the customer once and stores it', async () => {
    const stripe = fakeStripe();
    const db = createFakePrisma();
    const rail = createStripeRail({ getStripe: () => stripe as never, env: ENV, getDb: async () => db as unknown as StripeRailDb });
    await rail.createCheckout(order('roboapply', 'pro_monthly', { stripeCustomerId: null }));
    expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({ email: 'u@example.test', metadata: expect.objectContaining({ brand: 'roboapply' }) }));
    expect(await db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } })).toMatchObject({ stripeCustomerId: 'cus_new', tier: 'free' });
  });

  it('refuses unpriced plans and a missing key', async () => {
    const rail = createStripeRail({ getStripe: () => fakeStripe() as never, env: ENV });
    await expect(rail.createCheckout(order('roboapply', 'pro_quarterly'))).rejects.toMatchObject({ code: 'plan_not_sellable' });
    const noKey = createStripeRail({ getStripe: () => null, env: ENV });
    await expect(noKey.createCheckout(order('roboapply', 'pro_monthly'))).rejects.toMatchObject({ code: 'rail_not_configured' });
  });
});

describe('AlipayWorkerRail (GoApply passes)', () => {
  function rail(fetchImpl: typeof fetch, env = ENV) {
    const db = createFakePrisma();
    const r = createAlipayWorkerRail({ fetch: fetchImpl, env, now: () => NOW, getDb: async () => db as unknown as AlipayRailDb });
    return { r, db };
  }
  const ok = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://alipay.test/pay' } }) })) as unknown as typeof fetch;

  it('creates a whole-yuan order with the GoApply callback, return URL and collecting entity', async () => {
    const { r, db } = rail(ok);
    const res = await r.createCheckout(order('goapply', 'pro_monthly'));
    expect(res).toMatchObject({ kind: 'redirect', url: 'https://alipay.test/pay' });
    const payload = JSON.parse((ok as any).mock.calls[0][1].body);
    expect(payload).toMatchObject({ total_amount: 39, pay_channel: 'alipay', platform: 'gohire', subject: 'GoApply 会员月卡' });
    expect(payload.body).toContain('Example Collecting Co.');
    expect(payload.out_trade_no).toMatch(/^GAORDER_20261010080000_user_123_[0-9a-f]{10}$/);
    const notify = new URL(payload.notify_url);
    expect(notify.origin + notify.pathname).toBe('https://www.goapply.top/api/v1/roboapply/billing/alipay/callback');
    expect([...notify.searchParams]).toEqual([['cb', 'cb+secret&?']]);
    expect(payload.return_url).toBe('https://www.goapply.top/settings/billing/return?billing=success');
    const row = await db.alipayOrder.findUnique({ where: { outTradeNo: payload.out_trade_no } });
    expect(row).toMatchObject({ tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', amount: 39, amountMinor: 3900, channel: 'alipay', purpose: 'subscription', status: 'pending' });
  });

  it('honours CN_BACKEND_URL without a double slash and never the international BACKEND_URL', async () => {
    const f = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'x' } }) })) as unknown as typeof fetch;
    const { r } = rail(f, { ...ENV, BACKEND_URL: 'https://intl.example.test', CN_BACKEND_URL: 'https://api.goapply.example/' } as typeof ENV);
    await r.createCheckout(order('goapply', 'pro_monthly'));
    expect(JSON.parse((f as any).mock.calls[0][1].body).notify_url).toMatch(/^https:\/\/api\.goapply\.example\/api\/v1\/roboapply\/billing\/alipay\/callback\?cb=/);
  });

  it('refuses a price that is not a whole yuan, and charging without a collecting entity', async () => {
    const { r } = rail(ok);
    await expect(r.createCheckout(order('goapply', 'pro_week_pass'))).rejects.toMatchObject({ code: 'price_not_whole_yuan' });
    expect(r.isConfigured(getBrand('goapply'), { ...ENV, CN_PAYMENT_COLLECTING_ENTITY: '' })).toBe(false);
  });

  it('maps a worker failure to payment_provider_error and writes no order', async () => {
    const bad = vi.fn(async () => ({ status: 500, text: async () => 'Internal Server Error' })) as unknown as typeof fetch;
    const { r, db } = rail(bad);
    await expect(r.createCheckout(order('goapply', 'pro_monthly'))).rejects.toMatchObject({ code: 'payment_provider_error' });
    expect(await db.alipayOrder.findMany({})).toEqual([]);
  });

  it('verifies the echoed callback secret and reads the trade', async () => {
    const { r } = rail(ok);
    await expect(r.verifyCallback!({ query: { pay_status: 'TRADE_SUCCESS', out_trade_no: 'GA_1' }, body: {}, headers: {} })).rejects.toBeInstanceOf(CallbackRejectedError);
    await expect(r.verifyCallback!({ query: { cb: 'cb+secret&?', pay_status: 'TRADE_SUCCESS', out_trade_no: 'GA_1', total_amount: '39.00' }, body: {}, headers: {} })).resolves.toEqual({
      outTradeNo: 'GA_1',
      status: 'paid',
      paidAmountMinor: 3900,
      transactionId: null,
    });
    await expect(r.verifyCallback!({ query: {}, body: { cb: 'cb+secret&?', pay_status: 'TRADE_CLOSED', out_trade_no: 'GA_1' }, headers: {} })).resolves.toMatchObject({ status: 'closed', paidAmountMinor: null });
    await expect(r.verifyCallback!({ query: { cb: 'cb+secret&?' }, body: {}, headers: {} })).rejects.toBeInstanceOf(CallbackRejectedError);
  });

  it('fails closed when ALIPAY_CALLBACK_SECRET is unset: every callback is refused', async () => {
    const { r } = rail(ok, { ...ENV, ALIPAY_CALLBACK_SECRET: '' });
    for (const cb of [undefined, '', 'anything']) {
      await expect(
        r.verifyCallback!({ query: { ...(cb === undefined ? {} : { cb }), pay_status: 'TRADE_SUCCESS', out_trade_no: 'GA_1' }, body: {}, headers: {} }),
      ).rejects.toMatchObject({ reason: 'not_configured' });
    }
    expect(alipayCallbackSecretOk(undefined, {})).toBe(false);
    expect(alipayCallbackSecretOk('', { ALIPAY_CALLBACK_SECRET: '' })).toBe(false);
  });
});
