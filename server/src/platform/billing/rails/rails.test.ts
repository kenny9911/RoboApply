// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
// Rule A6 pins HOW the callback secret is compared: every call of the real
// `timingSafeEqual` is recorded (the comparison itself is untouched).
const cryptoCalls = vi.hoisted(() => ({ timingSafeEqual: [] as Array<[string, string]> }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const timingSafeEqual: typeof actual.timingSafeEqual = (a, b) => {
    cryptoCalls.timingSafeEqual.push([Buffer.from(a as Uint8Array).toString('utf8'), Buffer.from(b as Uint8Array).toString('utf8')]);
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { getBrand } from '../../brand/registry.js';
import { getPlan } from '../planCatalog.js';
import { createStripeRail, type StripeRailDb } from './stripe.js';
import {
  ALIPAY_CALLBACK_PATH,
  ALIPAY_DEFAULT_WORKER_URL,
  alipayCallbackSecretOk,
  alipayEntityNotice,
  collectingEntity,
  createAlipayWorkerRail,
  resetAlipayEntityNoticeForTests,
  warnIfAlipayEntityUnset,
  type AlipayRailDb,
} from './alipayWorker.js';
import { availableRails, ensureDefaultRails, getRegisteredRail, registerRail, resolveRail } from './index.js';
import { logger } from '../../../services/LoggerService.js';
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

  it('with ALIPAY_CALLBACK_SECRET alone: a 月卡 order at the catalog price, on the default worker, with cb on the notify URL', async () => {
    const env = { ALIPAY_CALLBACK_SECRET: 'only-secret' };
    const f = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://alipay.test/pay' } }) })) as unknown as typeof fetch;
    const { r, db } = rail(f, env as unknown as typeof ENV);
    const plan = getPlan('goapply', 'pro_monthly', env)!;
    expect(plan).toMatchObject({ sellable: true, amountMinor: 3900 });
    const res = await r.createCheckout({ ...order('goapply', 'pro_monthly'), plan });
    expect(res).toMatchObject({ kind: 'redirect', url: 'https://alipay.test/pay' });
    expect((f as any).mock.calls[0][0]).toBe('https://worker.gohire.top/payment/payment/create');
    const payload = JSON.parse((f as any).mock.calls[0][1].body);
    expect(payload).toMatchObject({ total_amount: 39, pay_channel: 'alipay', platform: 'gohire', subject: 'GoApply 会员月卡', body: 'GoApply 会员月卡' });
    expect(payload.notify_url).toBe('https://www.goapply.top/api/v1/roboapply/billing/alipay/callback?cb=only-secret');
    expect(await db.alipayOrder.findUnique({ where: { outTradeNo: payload.out_trade_no } })).toMatchObject({ tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', amountMinor: 3900, status: 'pending' });
  });

  it('honours CN_BACKEND_URL without a double slash and never the international BACKEND_URL', async () => {
    const f = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'x' } }) })) as unknown as typeof fetch;
    const { r } = rail(f, { ...ENV, BACKEND_URL: 'https://intl.example.test', CN_BACKEND_URL: 'https://api.goapply.example/' } as typeof ENV);
    await r.createCheckout(order('goapply', 'pro_monthly'));
    expect(JSON.parse((f as any).mock.calls[0][1].body).notify_url).toMatch(/^https:\/\/api\.goapply\.example\/api\/v1\/roboapply\/billing\/alipay\/callback\?cb=/);
  });

  it('refuses a price that is not a whole yuan (a hand-built plan: the catalog never yields one)', async () => {
    const { r } = rail(ok);
    // The catalog ignores a non-whole-yuan override, so the env value 1250 never reaches the rail.
    expect(getPlan('goapply', 'pro_week_pass', ENV)!.amountMinor).toBe(1200);
    const odd = order('goapply', 'pro_week_pass');
    await expect(r.createCheckout({ ...odd, plan: { ...odd.plan, amountMinor: 1250 } })).rejects.toMatchObject({ code: 'price_not_whole_yuan' });
  });

  describe('the collecting entity is printed when set and is not a gate (D5; MARKET_STRATEGY G5)', () => {
    const NO_ENTITY = { ...ENV, CN_PAYMENT_COLLECTING_ENTITY: '' };
    const go = getBrand('goapply');

    it('is configured for both brands with no entity', () => {
      const { r } = rail(ok);
      expect(r.isConfigured(go, NO_ENTITY)).toBe(true);
      expect(r.isConfigured(go, {})).toBe(true);
      expect(r.isConfigured(go, ENV)).toBe(true);
      expect(r.isConfigured(getBrand('roboapply'), {})).toBe(true);
    });

    it('creates the order without an entity: the body is the subject alone and every other field is unchanged', async () => {
      const f = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://alipay.test/pay' } }) })) as unknown as typeof fetch;
      const withEntity = rail(f);
      await withEntity.r.createCheckout(order('goapply', 'pro_monthly'));
      const without = rail(f, NO_ENTITY as typeof ENV);
      const res = await without.r.createCheckout({ ...order('goapply', 'pro_monthly'), plan: getPlan('goapply', 'pro_monthly', NO_ENTITY)! });
      expect(res).toMatchObject({ kind: 'redirect', url: 'https://alipay.test/pay' });
      const [a, b] = (f as any).mock.calls.map((c: any[]) => JSON.parse(c[1].body));
      expect(a.body).toBe('GoApply 会员月卡 · Example Collecting Co.');
      expect(b.body).toBe('GoApply 会员月卡');
      expect(b.subject).toBe('GoApply 会员月卡');
      // Same fields, same values, apart from the body line and the random order number.
      expect(Object.keys(b)).toEqual(Object.keys(a));
      expect({ ...b, body: null, out_trade_no: null }).toEqual({ ...a, body: null, out_trade_no: null });
      const row = await without.db.alipayOrder.findUnique({ where: { outTradeNo: b.out_trade_no } });
      expect(row).toMatchObject({ tier: 'ra_pro_monthly', brand: 'goapply', amount: 39, amountMinor: 3900, status: 'pending' });
    });

    it('CN_PAYMENT_REQUIRE_ENTITY=true restores the hard gate: unconfigured, and checkout answers rail_not_configured before the worker is called', async () => {
      const f = vi.fn() as unknown as typeof fetch;
      const strict = { ...NO_ENTITY, CN_PAYMENT_REQUIRE_ENTITY: 'true' };
      const { r, db } = rail(f, strict as typeof ENV);
      expect(r.isConfigured(go, strict)).toBe(false);
      await expect(r.createCheckout({ ...order('goapply', 'pro_monthly'), plan: getPlan('goapply', 'pro_monthly', strict)! })).rejects.toMatchObject({ code: 'rail_not_configured', details: { rail: 'alipay' } });
      expect(f).not.toHaveBeenCalled();
      expect(await db.alipayOrder.findMany({})).toEqual([]);
      // With the entity present the switch changes nothing.
      const named = { ...ENV, CN_PAYMENT_REQUIRE_ENTITY: 'true' };
      expect(r.isConfigured(go, named)).toBe(true);
      // Off values and RoboApply are not gated.
      expect(r.isConfigured(go, { ...NO_ENTITY, CN_PAYMENT_REQUIRE_ENTITY: 'false' })).toBe(true);
      expect(r.isConfigured(getBrand('roboapply'), { CN_PAYMENT_REQUIRE_ENTITY: 'true' })).toBe(true);
    });

    it('never borrows another brand\'s entity: only CN_PAYMENT_COLLECTING_ENTITY names GoApply\'s', async () => {
      const f = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'x' } }) })) as unknown as typeof fetch;
      const env = { ...NO_ENTITY, PAYMENT_COLLECTING_ENTITY: 'RoboApply Inc.' };
      const { r } = rail(f, env as typeof ENV);
      await r.createCheckout({ ...order('goapply', 'pro_monthly'), plan: getPlan('goapply', 'pro_monthly', env)! });
      expect(JSON.parse((f as any).mock.calls[0][1].body).body).toBe('GoApply 会员月卡');
      expect(collectingEntity(go, env)).toBeNull();
    });
  });

  it('a student pass is charged only for an order that says the buyer is verified', async () => {
    const f = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://alipay.test/pay' } }) })) as unknown as typeof fetch;
    const { r, db } = rail(f);
    const base = { ...order('goapply', 'student_monthly'), plan: getPlan('goapply', 'student_monthly', ENV)! };
    expect(base.plan).toMatchObject({ kind: 'pass', passDays: 30, amountMinor: 2900, sellable: true });
    for (const studentVerified of [undefined, false]) {
      await expect(r.createCheckout({ ...base, studentVerified })).rejects.toMatchObject({ code: 'student_verification_required' });
    }
    expect(f).not.toHaveBeenCalled();
    expect(await db.alipayOrder.findMany({})).toEqual([]);
    await expect(r.createCheckout({ ...base, studentVerified: true })).resolves.toMatchObject({ kind: 'redirect' });
    const payload = JSON.parse((f as any).mock.calls[0][1].body);
    expect(payload).toMatchObject({ total_amount: 29, subject: 'GoApply 学生月卡', package_data: { package_id: 'student_monthly', package_price: '29' } });
    // Every other plan needs no such mark.
    await expect(r.createCheckout(order('goapply', 'pro_monthly'))).resolves.toMatchObject({ kind: 'redirect' });
  });

  describe('the startup warning when GoApply charges without a named entity', () => {
    const READY = { ALIPAY_CALLBACK_SECRET: 's' };
    const warn = () => vi.fn<(tag: string, message: string, meta?: unknown) => void>();

    it('says it once when GoApply is served, the rail can charge and no entity is set', () => {
      const log = warn();
      expect(alipayEntityNotice(READY)).toMatch(/CN_PAYMENT_COLLECTING_ENTITY/);
      expect(warnIfAlipayEntityUnset(READY, { warn: log }, { force: true })).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![1]).toMatch(/CN_PAYMENT_COLLECTING_ENTITY/);
      // Once per process.
      expect(warnIfAlipayEntityUnset(READY, { warn: log })).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an entity is set', { ...READY, CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.' }],
      ['the rail has no callback secret (it cannot charge)', {}],
      ['payments are switched off', { ...READY, CN_PAYMENTS_ENABLED: 'false' }],
      ['the deployment does not serve GoApply', { ...READY, ALLOWED_BRANDS: 'roboapply' }],
      ['the hard gate is on (the rail refuses instead)', { ...READY, CN_PAYMENT_REQUIRE_ENTITY: 'true' }],
    ])('says nothing when %s', (_why, env) => {
      const log = warn();
      expect(alipayEntityNotice(env)).toBeNull();
      expect(warnIfAlipayEntityUnset(env, { warn: log }, { force: true })).toBe(false);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('when the notice is logged: on first use by the running deployment, not at import', () => {
    const go = getBrand('goapply');
    let warnSpy: ReturnType<typeof vi.spyOn>;
    const notices = () => warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('CN_PAYMENT_COLLECTING_ENTITY'));

    beforeEach(() => {
      resetAlipayEntityNoticeForTests();
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      for (const k of ['ALIPAY_CALLBACK_SECRET', 'CN_PAYMENT_COLLECTING_ENTITY', 'CN_PAYMENT_REQUIRE_ENTITY', 'CN_PAYMENTS_ENABLED', 'ALLOWED_BRANDS', 'BRAND_LOCK']) vi.stubEnv(k, '');
    });
    afterEach(() => {
      warnSpy.mockRestore();
      vi.unstubAllEnvs();
      resetAlipayEntityNoticeForTests();
    });

    it('credentials that arrive after the module was imported (dotenv in the entry point) are still reported: the first plans read logs it, once', () => {
      // Import time: the secret is not in the environment yet, so there is nothing to say and nothing is logged.
      ensureDefaultRails();
      expect(alipayEntityNotice()).toBeNull();
      expect(notices()).toHaveLength(0);
      // The entry point loads .env.
      vi.stubEnv('ALIPAY_CALLBACK_SECRET', 'cb-secret');
      const before = getRegisteredRail('alipay');
      registerRail('alipay', createAlipayWorkerRail());
      try {
        expect(availableRails(go)).toContain('alipay');
        expect(notices()).toHaveLength(1);
        expect(notices()[0]![0]).toBe('RA_BILLING');
        // Every later read and checkout resolution stays silent.
        availableRails(go);
        resolveRail(go, null);
        expect(notices()).toHaveLength(1);
      } finally {
        if (before) registerRail('alipay', before);
      }
    });

    it('is not raised for RoboApply, for an environment a caller passes in, or when the entity is named', () => {
      vi.stubEnv('ALIPAY_CALLBACK_SECRET', 'cb-secret');
      const r = createAlipayWorkerRail();
      r.isConfigured(getBrand('roboapply'), process.env);
      r.isConfigured(go, { ALIPAY_CALLBACK_SECRET: 'cb-secret' });
      expect(notices()).toHaveLength(0);
      vi.stubEnv('CN_PAYMENT_COLLECTING_ENTITY', 'Example Collecting Co.');
      r.isConfigured(go, process.env);
      expect(notices()).toHaveLength(0);
      vi.stubEnv('CN_PAYMENT_COLLECTING_ENTITY', '');
      r.isConfigured(go, process.env);
      expect(notices()).toHaveLength(1);
    });
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

// ── The Alipay "do not break" contract (MARKET_STRATEGY.md §5.2; AL-1; D6) ──
// Characterisation tests: they pin the worker request and the secret check as
// they are today. Every former gate (price, payments switch, collecting
// entity) is set explicitly, so they hold with the old gates and with the D5
// defaults. See also roboapply/routes/billing.test.ts (A1–A4, A6, A8, A10,
// A11) and platform/billing/fulfilPass.test.ts (A3, A4, A7, A8, A9, A12).
describe('Alipay contract A5: the worker request', () => {
  const SECRET = 'cb+secret&? /=';
  const A5_ENV = {
    CN_PAYMENTS_ENABLED: 'true',
    CN_PRICE_PRO_MONTHLY_FEN: '3900',
    CN_PRICE_PRACTICE_PACK_5_FEN: '2900',
    CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
    ALIPAY_CALLBACK_SECRET: SECRET,
  };
  type Env = Record<string, string>;

  async function send(planKey: string, env: Env = A5_ENV) {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://alipay.test/pay' } }) }));
    const db = createFakePrisma();
    const r = createAlipayWorkerRail({ fetch: fetchImpl as unknown as typeof fetch, env, now: () => NOW, getDb: async () => db as unknown as AlipayRailDb });
    const res = await r.createCheckout({
      brand: getBrand('goapply'),
      plan: getPlan('goapply', planKey as never, env)!,
      user: { id: 'user_123456789', email: 'u@example.test', name: 'U' },
      seekerProfileId: 'sp_1',
      acknowledgements: { autoRenewAck: false, withdrawalWaiver: false },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    return { res, url, init, payload: JSON.parse(init.body) as Record<string, any>, db };
  }

  it('A5 posts JSON to the default worker endpoint when ALIPAY_API_URL is unset, and to ALIPAY_API_URL when set', async () => {
    const def = await send('pro_monthly');
    expect(ALIPAY_DEFAULT_WORKER_URL).toBe('https://worker.gohire.top/payment/payment/create');
    expect(def.url).toBe('https://worker.gohire.top/payment/payment/create');
    expect(def.init.method).toBe('POST');
    expect(def.init.headers).toEqual({ 'Content-Type': 'application/json' });
    const custom = await send('pro_monthly', { ...A5_ENV, ALIPAY_API_URL: ' https://pay.example.test/create ' });
    expect(custom.url).toBe('https://pay.example.test/create');
  });

  it('A5 the body: pay_channel alipay, platform gohire, a whole-yuan numeric total_amount and the four package_data strings', async () => {
    const { payload } = await send('pro_monthly');
    expect(Object.keys(payload).sort()).toEqual(
      ['body', 'notify_url', 'out_trade_no', 'package_data', 'pay_channel', 'platform', 'return_url', 'subject', 'total_amount', 'user_email', 'user_id', 'user_name'].sort(),
    );
    expect(payload.pay_channel).toBe('alipay');
    expect(payload.platform).toBe('gohire');
    // A number, in whole yuan: never fen, never a string, never a fraction.
    expect(payload.total_amount).toBe(39);
    expect(typeof payload.total_amount).toBe('number');
    expect(Number.isInteger(payload.total_amount)).toBe(true);
    // Exactly four fields, every one a string.
    expect(payload.package_data).toEqual({ package_id: 'pro_monthly', package_name: 'pro_monthly', package_type: '1', package_price: '39' });
    for (const v of Object.values(payload.package_data)) expect(typeof v).toBe('string');
    expect(payload).toMatchObject({ user_id: 'user_123456789', user_email: 'u@example.test', user_name: 'U', subject: 'GoApply 会员月卡', body: 'GoApply 会员月卡 · Example Collecting Co.' });

    const pack = (await send('practice_pack_5')).payload;
    expect(pack.total_amount).toBe(29);
    expect(pack.package_data).toEqual({ package_id: 'practice_pack_5', package_name: 'practice_pack_5', package_type: '1', package_price: '29' });
  });

  it('A5 platform is "gohire" unless CN_ALIPAY_PLATFORM overrides it', async () => {
    expect((await send('pro_monthly', { ...A5_ENV, CN_ALIPAY_PLATFORM: ' goapply ' })).payload.platform).toBe('goapply');
    expect((await send('pro_monthly', { ...A5_ENV, CN_ALIPAY_PLATFORM: '  ' })).payload.platform).toBe('gohire');
    // RoboApply's override is never read for GoApply.
    expect((await send('pro_monthly', { ...A5_ENV, ROBOAPPLY_ALIPAY_PLATFORM: 'roboapply' })).payload.platform).toBe('gohire');
  });

  it('A5 notify_url is the callback route on the brand host with the URL-encoded secret as ?cb=', async () => {
    const { payload } = await send('pro_monthly');
    expect(ALIPAY_CALLBACK_PATH).toBe('/api/v1/roboapply/billing/alipay/callback');
    expect(payload.notify_url).toBe(`https://www.goapply.top/api/v1/roboapply/billing/alipay/callback?cb=${encodeURIComponent(SECRET)}`);
    // Decodes back to the exact secret, as the only query parameter.
    expect([...new URL(payload.notify_url).searchParams]).toEqual([['cb', SECRET]]);
    expect(payload.notify_url).not.toContain(SECRET);
    expect(payload.return_url).toBe('https://www.goapply.top/settings/billing/return?billing=success');
  });

  it('A5 a price that is not a whole yuan is refused, never rounded', async () => {
    const fetchImpl = vi.fn();
    const r = createAlipayWorkerRail({ fetch: fetchImpl as unknown as typeof fetch, env: A5_ENV, now: () => NOW, getDb: async () => createFakePrisma() as unknown as AlipayRailDb });
    const plan = { ...getPlan('goapply', 'pro_monthly', A5_ENV)!, amountMinor: 3990 };
    await expect(
      r.createCheckout({ brand: getBrand('goapply'), plan, user: { id: 'u', email: 'u@example.test', name: null }, seekerProfileId: 'sp', acknowledgements: { autoRenewAck: false, withdrawalWaiver: false } }),
    ).rejects.toMatchObject({ code: 'price_not_whole_yuan' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Alipay contract A6: the callback secret check', () => {
  const SECRET = 'cb+secret&?';
  const env = { ALIPAY_CALLBACK_SECRET: SECRET };
  const exploding = new Proxy({}, { get: () => { throw new Error('the database must not be touched'); } });

  function rail() {
    return createAlipayWorkerRail({ env, now: () => NOW, getDb: async () => exploding as unknown as AlipayRailDb, fetch: vi.fn() as unknown as typeof fetch });
  }

  it('A6 a wrong, missing or near-miss cb is refused as bad_secret without opening the database', async () => {
    const getDb = vi.fn(async () => exploding as unknown as AlipayRailDb);
    const r = createAlipayWorkerRail({ env, now: () => NOW, getDb, fetch: vi.fn() as unknown as typeof fetch });
    const wrong = [undefined, '', 'wrong', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), 'x'.repeat(SECRET.length)];
    for (const cb of wrong) {
      const query = { ...(cb === undefined ? {} : { cb }), pay_status: 'TRADE_SUCCESS', out_trade_no: 'GA_1', total_amount: '39.00' };
      await expect(r.verifyCallback!({ query, body: {}, headers: {} }), String(cb)).rejects.toMatchObject({ reason: 'bad_secret' });
    }
    expect(getDb).not.toHaveBeenCalled();
    // The secret is checked before the parameters: a wrong cb with nothing else is still bad_secret.
    await expect(r.verifyCallback!({ query: { cb: 'wrong' }, body: {}, headers: {} })).rejects.toMatchObject({ reason: 'bad_secret' });
  });

  it('A6 the secret may arrive as ?cb=, as a JSON body field or as the x-alipay-callback-secret header', async () => {
    const r = rail();
    const trade = { pay_status: 'TRADE_SUCCESS', out_trade_no: 'GA_1' };
    await expect(r.verifyCallback!({ query: { ...trade, cb: SECRET }, body: {}, headers: {} })).resolves.toMatchObject({ outTradeNo: 'GA_1', status: 'paid' });
    await expect(r.verifyCallback!({ query: {}, body: { ...trade, cb: SECRET }, headers: {} })).resolves.toMatchObject({ outTradeNo: 'GA_1', status: 'paid' });
    await expect(r.verifyCallback!({ query: trade, body: {}, headers: { 'x-alipay-callback-secret': SECRET } })).resolves.toMatchObject({ outTradeNo: 'GA_1', status: 'paid' });
  });

  it('A6 the comparison is constant-time: equal-length candidates go through crypto.timingSafeEqual, never ===', () => {
    cryptoCalls.timingSafeEqual.length = 0;
    const sameLength = 'x'.repeat(SECRET.length);
    expect(alipayCallbackSecretOk(sameLength, env)).toBe(false);
    expect(alipayCallbackSecretOk(SECRET, env)).toBe(true);
    expect(cryptoCalls.timingSafeEqual).toEqual([
      [sameLength, SECRET],
      [SECRET, SECRET],
    ]);
    // A different length cannot be compared in constant time; it is refused on the length alone.
    cryptoCalls.timingSafeEqual.length = 0;
    expect(alipayCallbackSecretOk('short', env)).toBe(false);
    expect(cryptoCalls.timingSafeEqual).toEqual([]);
  });

  it('A6 the trade facts the callback reads: status mapping, amount in fen, the provider trade number', async () => {
    const r = rail();
    const q = (over: Record<string, unknown>) => ({ query: { cb: SECRET, out_trade_no: 'GA_1', ...over }, body: {}, headers: {} });
    await expect(r.verifyCallback!(q({ pay_status: 'TRADE_SUCCESS', total_amount: '39.00', trade_no: 'T9' }))).resolves.toEqual({ outTradeNo: 'GA_1', status: 'paid', paidAmountMinor: 3900, transactionId: 'T9' });
    await expect(r.verifyCallback!(q({ pay_status: 'TRADE_SUCCESS', total_amount: '39' }))).resolves.toMatchObject({ paidAmountMinor: 3900 });
    await expect(r.verifyCallback!(q({ pay_status: 'TRADE_CLOSED' }))).resolves.toMatchObject({ status: 'closed', paidAmountMinor: null, transactionId: null });
    await expect(r.verifyCallback!(q({ pay_status: 'WAIT_BUYER_PAY' }))).resolves.toMatchObject({ status: 'pending' });
    // A JSON number in the body is read too.
    await expect(r.verifyCallback!({ query: { cb: SECRET }, body: { pay_status: 'TRADE_SUCCESS', out_trade_no: 'GA_1', total_amount: 39 }, headers: {} })).resolves.toMatchObject({ paidAmountMinor: 3900 });
  });
});

describe('Alipay contract A11: Stripe never serves GoApply', () => {
  it('A11 the Stripe rail refuses a GoApply order before it creates a customer or a session', async () => {
    const stripe = fakeStripe();
    const rail = createStripeRail({ getStripe: () => stripe as never, env: ENV });
    // A GoApply plan has no Stripe price: there is nothing the rail could charge.
    expect(getPlan('goapply', 'pro_monthly', ENV)!.stripePriceId).toBeNull();
    await expect(rail.createCheckout(order('goapply', 'pro_monthly', { stripeCustomerId: null }))).rejects.toMatchObject({ code: 'plan_not_sellable' });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});
