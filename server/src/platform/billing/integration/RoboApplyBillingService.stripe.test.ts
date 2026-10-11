// @vitest-environment node
//
// RoboApply (Stripe) billing: checkout acknowledgements, the legacy switch
// quote, and webhook idempotency (TASK_PLAN.md WP-21a acceptance); Account V2
// wiring (WP-79): student plans need the capability and a live verification,
// Taiwan buyers are charged the configured TWD price and the webhook stores it.
// Market wave (ST-1, ST-2): checkout resolves the price through the catalog
// sync, one checkout attempt is one Stripe idempotency key, a synced price is
// recognised by the webhook without metadata or pins, and event types the
// service does not handle are offered to the handler registry.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'] } });
  return { default: fake.db };
});
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
    req.user = { id, email: `${id}@example.test`, name: 'Test', brand: 'roboapply' };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';
import billingRouter from '../../../roboapply/routes/billing.js';
import { createStripeWebhookRouter } from '../../../roboapply/routes/stripeWebhook.js';
import { handleRoboApplyStripeEvent, invoiceSubscriptionId, setBillingServiceDepsForTests } from '../../../roboapply/services/RoboApplyBillingService.js';
import {
  autoRenewAckSentence,
  proseHash,
  registerStripeEventHandler,
  resetStripeCatalogCacheForTests,
  setStripeClientForTests,
  unregisterStripeEventHandlerForTests,
} from '../index.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const PERIOD_END_S = NOW_S + 30 * 86400;

const PRICES = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_PRO_WEEKLY: 'price_w',
  STRIPE_PRICE_PRO_WEEKLY_CENTS: '999',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
  STRIPE_PRICE_PRO_WEEK_PASS: 'price_p',
  STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '699',
  STRIPE_PRICE_PRACTICE_PACK_5: 'price_5',
  STRIPE_PRICE_PRACTICE_PACK_5_CENTS: '999',
  STRIPE_ROBOAPPLY_STARTER_PRICE_ID: 'price_starter',
};

function stripeSub(id: string, price: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    start_date: NOW_S,
    metadata: {},
    items: { data: [{ id: 'si_1', price: { id: price, currency: 'usd', unit_amount: 2499 }, current_period_start: NOW_S, current_period_end: PERIOD_END_S }] },
    ...over,
  };
}

async function defaultRetrieve(id: string) {
  return stripeSub(id, 'price_m', { metadata: { planKey: 'pro_monthly' } });
}

/** The prices the fake Stripe account holds under a lookup key (what the catalog sync finds or creates). */
const synced = { prices: [] as Array<Record<string, any>>, seq: 0 };

const stripe = {
  customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
  checkout: { sessions: { create: vi.fn(async () => ({ id: 'cs_new', url: 'https://checkout.stripe.test/cs_new' })) } },
  products: { create: vi.fn(async (p: { id: string }) => ({ id: p.id })) },
  prices: {
    list: vi.fn(async (p: { lookup_keys: string[] }) => ({ data: synced.prices.filter((x) => p.lookup_keys.includes(x.lookup_key)) })),
    create: vi.fn(async (p: Record<string, any>) => {
      const price = { ...p, id: `price_synced_${++synced.seq}`, active: true, recurring: p.recurring ?? null };
      synced.prices.push(price);
      return price;
    }),
  },
  subscriptions: { retrieve: vi.fn(defaultRetrieve), update: vi.fn(async () => ({})) },
  invoices: {
    createPreview: vi.fn(async () => ({ currency: 'usd', amount_due: 1500, lines: { data: [] } })),
    list: vi.fn(async () => ({ data: [] })),
  },
};

// Stands in for mockCreditService.grantForPlanIfNewPeriod: a grant stamps
// renewedAt (wall time ≥ the period start); without `force` a grant is
// skipped when renewedAt ≥ periodStart.
const credits = { renewedAt: null as Date | null, grants: 0 };
const grantIfNewPeriod = vi.fn(async (p: { force?: boolean; periodStart: Date | null }) => {
  if (!p.force && credits.renewedAt && (p.periodStart == null || credits.renewedAt >= p.periodStart)) return 'skipped' as const;
  credits.renewedAt = p.periodStart && p.periodStart > NOW ? p.periodStart : NOW;
  credits.grants++;
  return 'granted' as const;
});
const grantPack = vi.fn(async () => ({}));
const sendEmail = vi.fn(async () => ({ status: 'sent' as const }));
const student = { enabled: true, verified: false, lookupFails: false };
const studentEnabled = vi.fn(async () => student.enabled);
const isStudentVerified = vi.fn(async () => {
  if (student.lookupFails) throw new Error('verification store down');
  return student.verified;
});
let h: RouteHarness;

beforeAll(async () => {
  h = await startRouteHarness({ mounts: [['/api/v1/roboapply/billing', billingRouter]] });
});
afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  credits.renewedAt = null;
  credits.grants = 0;
  synced.prices = [];
  synced.seq = 0;
  resetStripeCatalogCacheForTests();
  stripe.subscriptions.retrieve.mockImplementation(defaultRetrieve);
  for (const [k, v] of Object.entries(PRICES)) vi.stubEnv(k, v);
  setStripeClientForTests(stripe as never);
  for (const t of ['seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'user', 'seekerProfile', 'alipayOrder']) fake.db[t].deleteMany({});
  fake.db.user.create({ data: { id: 'u_1', email: 'u_1@example.test', name: 'U', brand: 'roboapply' } });
  fake.db.seekerProfile.create({ data: { id: 'sp_1', userId: 'u_1', locale: 'en', deletedAt: null } });
  setBillingServiceDepsForTests({
    db: fake.db as never,
    getStripe: () => stripe as never,
    now: () => NOW,
    grantIfNewPeriod: grantIfNewPeriod as never,
    grantPack,
    sendEmail,
    getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
    invalidate: () => {},
    studentEnabled,
    isStudentVerified,
  });
  Object.assign(student, { enabled: true, verified: false, lookupFails: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStripeClientForTests(undefined);
  setBillingServiceDepsForTests();
});

const AS_USER = { host: 'localhost:3621', headers: { 'x-test-user': 'u_1' } };

describe('checkout acknowledgements', () => {
  it('refuses an auto-renewing plan without the unticked acknowledgement; nothing is recorded or opened', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('auto_renew_ack_required');
    expect(await fake.db.seekerConsentRecord.findMany({})).toEqual([]);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('records auto_renew_ack (and the waiver when ticked) before opening Stripe Checkout', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', {
      ...AS_USER,
      body: { planKey: 'pro_monthly', autoRenewAck: true, withdrawalWaiver: true, next: '/jobs' },
    });
    expect(res.status).toBe(200);
    // The shared checkout shape (features/credits/contract.ts `CheckoutResponse`), nothing else.
    expect(res.body.data).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.test/cs_new', orderId: 'cs_new', rail: 'stripe' });
    const types = (await fake.db.seekerConsentRecord.findMany({})).map((r: any) => r.consentType).sort();
    expect(types).toEqual(['auto_renew_ack', 'withdrawal_waiver']);
    const params = stripe.checkout.sessions.create.mock.calls[0]![0] as any;
    expect(params.metadata).toMatchObject({ brand: 'roboapply', planKey: 'pro_monthly', withdrawalWaiver: 'yes', autoRenewAck: 'yes' });
  });

  it('a pass needs no auto-renew box but is refused while a plan still renews', async () => {
    const ok = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'pro_week_pass' } });
    expect(ok.status).toBe(200);
    await fake.db.seekerSubscription.deleteMany({});
    await fake.db.seekerSubscription.create({
      data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', currentPeriodEnd: new Date(PERIOD_END_S * 1000), cancelAtPeriodEnd: false },
    });
    const refused = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'pro_week_pass' } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('already_subscribed');
  });

  it('a running pass (Stripe 7-day or legacy Alipay) refuses a subscription with pass_active and the date it ends — never "switch"', async () => {
    const until = new Date(NOW.getTime() + 3 * 86_400_000);
    for (const row of [
      { tier: 'pro', planKey: 'pro_week_pass', interval: 'pass', rail: 'stripe' },
      { tier: 'starter', planKey: 'starter', interval: 'pass', rail: 'alipay' },
    ]) {
      await fake.db.seekerSubscription.deleteMany({});
      await fake.db.seekerSubscription.create({
        data: { id: 'row_p', seekerProfileId: 'sp_1', status: 'active', stripeSubscriptionId: null, currentPeriodEnd: until, cancelAtPeriodEnd: false, ...row },
      });
      const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'pro_monthly', autoRenewAck: true } });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('pass_active');
      expect(res.body.error).not.toMatch(/switch/i);
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    }
  });

  it('an unknown plan is refused; a plan is refused while the rail is not ready (a key without a webhook secret)', async () => {
    expect((await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'nope' } })).body.code).toBe('plan_not_sellable');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'pro_quarterly', autoRenewAck: true } });
    expect([res.status, res.body.code]).toEqual([409, 'plan_not_sellable']);
    expect(res.body.details).toMatchObject({ reason: 'payments_disabled' });
    expect(await fake.db.seekerConsentRecord.findMany({})).toEqual([]);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.prices.list).not.toHaveBeenCalled();
  });
});

describe('checkout through the catalog (ST-1, ST-2)', () => {
  const checkout = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { host: AS_USER.host, headers: { ...AS_USER.headers, ...headers }, body });
  const sessionCall = (i = -1) => stripe.checkout.sessions.create.mock.calls.at(i)! as unknown as [Record<string, any>, { idempotencyKey: string }];
  /** No price variable at all: only the key and the webhook secret. */
  const noPriceVariables = () => {
    for (const k of Object.keys(PRICES)) if (k.startsWith('STRIPE_PRICE_')) vi.stubEnv(k, '');
  };

  it('with no price variable a monthly checkout opens on the price created under ra_pro_monthly_usd_2499_incl', async () => {
    noPriceVariables();
    const res = await checkout({ planKey: 'pro_monthly', autoRenewAck: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.test/cs_new', orderId: 'cs_new', rail: 'stripe' });
    expect(synced.prices).toHaveLength(1);
    expect(synced.prices[0]).toMatchObject({ lookup_key: 'ra_pro_monthly_usd_2499_incl', unit_amount: 2499, currency: 'usd', product: 'ra_pro', recurring: { interval: 'month', interval_count: 1 }, tax_behavior: 'inclusive' });
    expect(sessionCall()[0].line_items).toEqual([{ price: synced.prices[0]!.id, quantity: 1 }]);
    // A second buyer of the same plan asks Stripe for no price.
    await checkout({ planKey: 'pro_monthly', autoRenewAck: true });
    expect(stripe.prices.list).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
  });

  it('every MVP plan can be bought with no price variable, each on its own synced price at the catalog amount', async () => {
    noPriceVariables();
    const bought: Array<[string, string, number, string]> = [];
    for (const planKey of ['pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15']) {
      const res = await checkout({ planKey, autoRenewAck: true });
      expect(res.status, planKey).toBe(200);
      const price = synced.prices.find((p) => p.id === sessionCall()[0].line_items[0].price)!;
      bought.push([planKey, price.lookup_key, price.unit_amount, sessionCall()[0].mode]);
    }
    expect(bought).toEqual([
      ['pro_weekly', 'ra_pro_weekly_usd_999_incl', 999, 'subscription'],
      ['pro_monthly', 'ra_pro_monthly_usd_2499_incl', 2499, 'subscription'],
      ['pro_quarterly', 'ra_pro_quarterly_usd_5499_incl', 5499, 'subscription'],
      ['pro_week_pass', 'ra_pro_week_pass_usd_999_incl', 999, 'payment'],
      ['practice_pack_5', 'ra_practice_pack_5_usd_999_incl', 999, 'payment'],
      ['practice_pack_15', 'ra_practice_pack_15_usd_2499_incl', 2499, 'payment'],
    ]);
  });

  it('a pinned plan is charged on its pin; a plan whose pin was removed is sold on its synced price', async () => {
    await checkout({ planKey: 'pro_monthly', autoRenewAck: true });
    expect(sessionCall()[0].line_items).toEqual([{ price: 'price_m', quantity: 1 }]);
    expect(stripe.prices.list).not.toHaveBeenCalled();
    // The amount variable stays (5999): the synced price carries that amount in its lookup key.
    vi.stubEnv('STRIPE_PRICE_PRO_QUARTERLY', '');
    const res = await checkout({ planKey: 'pro_quarterly', autoRenewAck: true });
    expect(res.status).toBe(200);
    expect(synced.prices[0]).toMatchObject({ lookup_key: 'ra_pro_quarterly_usd_5999_incl', unit_amount: 5999, recurring: { interval: 'month', interval_count: 3 } });
    expect(sessionCall()[0].line_items[0].price).toBe(synced.prices[0]!.id);
  });

  it('the Idempotency-Key header is the checkout attempt: the same header twice gives the same Stripe key, a different header a different one', async () => {
    const a = '3f0c1b0a-8a3e-4c57-9d0e-2b6f5f3a9c11';
    const b = '7d9e5a12-1111-4222-8333-944455556666';
    await checkout({ planKey: 'practice_pack_5' }, { 'Idempotency-Key': a });
    await checkout({ planKey: 'practice_pack_5' }, { 'Idempotency-Key': ` ${a} ` });
    await checkout({ planKey: 'practice_pack_5' }, { 'Idempotency-Key': b });
    const keys = stripe.checkout.sessions.create.mock.calls.map((c) => (c as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey);
    expect(keys).toEqual([`checkout:u_1:practice_pack_5:usd:${a}`, `checkout:u_1:practice_pack_5:usd:${a}`, `checkout:u_1:practice_pack_5:usd:${b}`]);
  });

  it('without the header, or with a malformed one, the server falls back to its 60-second bucket', async () => {
    await checkout({ planKey: 'practice_pack_5' });
    await checkout({ planKey: 'practice_pack_5' }, { 'Idempotency-Key': 'short' });
    await checkout({ planKey: 'practice_pack_5' }, { 'Idempotency-Key': 'not a valid key!' });
    for (const call of stripe.checkout.sessions.create.mock.calls) {
      expect((call as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey).toMatch(/^checkout:u_1:practice_pack_5:usd:b\d+$/);
    }
  });

  it('the customer is created under customer:<seekerProfileId>', async () => {
    await checkout({ planKey: 'practice_pack_5' });
    expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({ email: 'u_1@example.test' }), { idempotencyKey: 'customer:sp_1' });
  });

  it('X-Robo-Locale picks the payment page language; the session has Adaptive Pricing off, customer_update and the line above the pay button', async () => {
    await checkout({ planKey: 'pro_monthly', autoRenewAck: true }, { 'X-Robo-Locale': 'ja' });
    const params = sessionCall()[0];
    expect(params.locale).toBe('ja');
    expect(params.adaptive_pricing).toEqual({ enabled: false });
    expect(params.customer_update).toEqual({ address: 'auto', name: 'auto' });
    expect(params.custom_text.submit.message).toMatch(/^Renews every month at \$24\.99 until you cancel\. Cancel any time in Settings or at https?:\/\/.+\/cancel\.$/);
    expect(params.subscription_data.description).toBe('RoboApply Pro Monthly');
    await checkout({ planKey: 'pro_week_pass' }, { 'X-Robo-Locale': 'pt' });
    expect(sessionCall()[0].locale).toBe('pt-BR');
    expect(sessionCall()[0].custom_text.submit.message).toBe('One payment of $6.99. It does not renew.');
    await checkout({ planKey: 'pro_week_pass' });
    expect(sessionCall()[0].locale).toBe('auto');
  });

  it('a Stripe idempotency conflict answers 502 payment_provider_error with details.reason idempotency_conflict', async () => {
    stripe.checkout.sessions.create.mockRejectedValueOnce(Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters they were first used with.'), { type: 'StripeIdempotencyError' }));
    const res = await checkout({ planKey: 'practice_pack_5' }, { 'Idempotency-Key': 'attempt-0001' });
    expect([res.status, res.body.code]).toEqual([502, 'payment_provider_error']);
    expect(res.body.details).toMatchObject({ provider: 'stripe', reason: 'idempotency_conflict' });
  });

  it('a Stripe failure in the catalog sync makes checkout answer 502 while the plan list still answers', async () => {
    noPriceVariables();
    stripe.prices.list.mockRejectedValueOnce(new Error('stripe is down'));
    const res = await checkout({ planKey: 'pro_monthly', autoRenewAck: true });
    expect([res.status, res.body.code]).toEqual([502, 'payment_provider_error']);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
    const plan = await h.request<any>('GET', '/api/v1/roboapply/billing/plan', AS_USER);
    expect(plan.status).toBe(200);
    expect(plan.body.data.catalog.find((p: any) => p.key === 'pro_monthly')).toMatchObject({ amountMinor: 2499, sellable: true, stripePriceId: null });
    // The failure was not remembered: the next attempt goes through.
    expect((await checkout({ planKey: 'pro_monthly', autoRenewAck: true })).status).toBe(200);
  });

  it('a GoApply request never reaches Stripe: the fake Stripe records zero calls of any kind', async () => {
    const AS_GO = { host: 'goapply.localhost:3621', headers: { 'x-test-user': 'u_1' } };
    const go = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { host: AS_GO.host, headers: { ...AS_GO.headers, ...headers }, body });
    // Asking for Stripe by name.
    const named = await go({ planKey: 'pro_monthly', rail: 'stripe' }, { 'Idempotency-Key': 'attempt-0001' });
    expect([named.status, named.body.code]).toEqual([409, 'rail_not_allowed']);
    // Naming no rail: GoApply's own rails are the only candidates (none is set up in this env).
    const unnamed = await go({ planKey: 'pro_monthly' });
    expect(unnamed.status).toBe(503);
    expect(unnamed.body.code).toBe('rail_not_configured');
    // The renewing weekly plan does not exist on GoApply.
    const weekly = await go({ planKey: 'pro_weekly', autoRenewAck: true, rail: 'stripe' });
    expect([weekly.status, weekly.body.code]).toEqual([409, 'plan_not_sellable']);
    for (const fn of [stripe.customers.create, stripe.products.create, stripe.prices.list, stripe.prices.create, stripe.checkout.sessions.create, stripe.subscriptions.retrieve, stripe.subscriptions.update]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(synced.prices).toEqual([]);
  });
});

describe('Account V2: student plans (capability on + a live school-email verification)', () => {
  const buy = (planKey = 'student_monthly') => h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey, autoRenewAck: true } });

  beforeEach(() => {
    vi.stubEnv('STRIPE_PRICE_STUDENT_MONTHLY', 'price_sm');
    vi.stubEnv('STRIPE_PRICE_STUDENT_MONTHLY_CENTS', '1499');
    vi.stubEnv('STRIPE_PRICE_STUDENT_QUARTERLY', 'price_sq');
    vi.stubEnv('STRIPE_PRICE_STUDENT_QUARTERLY_CENTS', '3599');
  });

  it('an unverified user cannot buy a student plan: 409, nothing recorded, the payment page never opens', async () => {
    const res = await buy();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'student_verification_required', details: { planKey: 'student_monthly' } });
    expect(isStudentVerified).toHaveBeenCalledWith('u_1');
    expect(await fake.db.seekerConsentRecord.findMany({})).toEqual([]);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('a verified student can: the student price is charged and the acknowledgement recorded', async () => {
    student.verified = true;
    const res = await buy();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ kind: 'redirect', url: 'https://checkout.stripe.test/cs_new', orderId: 'cs_new', rail: 'stripe' });
    const params = stripe.checkout.sessions.create.mock.calls[0]![0] as any;
    expect(params.line_items).toEqual([{ price: 'price_sm', quantity: 1 }]);
    expect(params.mode).toBe('subscription');
    expect(params.metadata).toMatchObject({ planKey: 'student_monthly', autoRenewAck: 'yes' });
    // Student plans never take a promotion code (discounts do not stack).
    expect(params.allow_promotion_codes).toBe(false);
    expect((await fake.db.seekerConsentRecord.findMany({})).map((r: any) => r.consentType)).toEqual(['auto_renew_ack']);
  });

  it('still needs the unticked auto-renewal box', async () => {
    student.verified = true;
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'student_monthly' } });
    expect([res.status, res.body.code]).toEqual([422, 'auto_renew_ack_required']);
  });

  it('is not on sale while the student capability is off, verified or not', async () => {
    student.enabled = false;
    student.verified = true;
    const res = await buy();
    expect([res.status, res.body.code]).toEqual([409, 'plan_not_sellable']);
    expect(res.body.details).toMatchObject({ reason: 'student_off' });
    expect(isStudentVerified).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('fails closed when the verification cannot be read', async () => {
    student.lookupFails = true;
    const res = await buy();
    expect([res.status, res.body.code]).toEqual([409, 'student_verification_required']);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('a student plan with no pin is sold on its synced price, on the student product', async () => {
    student.verified = true;
    vi.stubEnv('STRIPE_PRICE_STUDENT_QUARTERLY', '');
    const res = await buy('student_quarterly');
    expect(res.status).toBe(200);
    expect(synced.prices).toHaveLength(1);
    expect(synced.prices[0]).toMatchObject({ lookup_key: 'ra_student_quarterly_usd_3599_incl', product: 'ra_pro_student', unit_amount: 3599, recurring: { interval: 'month', interval_count: 3 } });
    expect((stripe.checkout.sessions.create.mock.calls[0]![0] as any).line_items).toEqual([{ price: synced.prices[0]!.id, quantity: 1 }]);
    // Unverified: refused before any price is looked for.
    student.verified = false;
    stripe.prices.list.mockClear();
    expect((await buy('student_monthly')).body.code).toBe('student_verification_required');
    expect(stripe.prices.list).not.toHaveBeenCalled();
  });

  it('regular plans never ask about student status', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'pro_monthly', autoRenewAck: true } });
    expect(res.status).toBe(200);
    expect(studentEnabled).not.toHaveBeenCalled();
    expect(isStudentVerified).not.toHaveBeenCalled();
  });

  describe('switching to a student plan', () => {
    beforeEach(async () => {
      await fake.db.seekerSubscription.create({
        data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1', currentPeriodEnd: new Date(PERIOD_END_S * 1000), cancelAtPeriodEnd: false },
      });
    });

    it('is refused for an unverified user on the quote and on confirm; nothing is charged', async () => {
      const quote = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', { ...AS_USER, body: { planKey: 'student_monthly' } });
      expect([quote.status, quote.body.code]).toEqual([409, 'student_verification_required']);
      const confirm = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', { ...AS_USER, body: { planKey: 'student_monthly', confirm: true, prorationDate: NOW_S, autoRenewAck: true } });
      expect([confirm.status, confirm.body.code]).toEqual([409, 'student_verification_required']);
      expect(stripe.invoices.createPreview).not.toHaveBeenCalled();
      expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('a verified student gets the quote and the switch at the student price', async () => {
      student.verified = true;
      const quote = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', { ...AS_USER, body: { planKey: 'student_monthly' } });
      expect(quote.status).toBe(200);
      expect(quote.body.data.quote).toMatchObject({ planKey: 'student_monthly', newRenewalPriceMinor: 1499 });
      const confirm = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', { ...AS_USER, body: { planKey: 'student_monthly', confirm: true, prorationDate: NOW_S, autoRenewAck: true } });
      expect(confirm.body.data).toEqual({ switched: true, planKey: 'student_monthly' });
      expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_old', expect.objectContaining({ items: [expect.objectContaining({ price: 'price_sm' })] }));
    });
  });
});

describe('Account V2: Taiwan prices (the buyer\'s edge country picks the TWD price when one is configured)', () => {
  const buyFrom = (country: string | null, planKey = 'pro_monthly') =>
    h.request<any>('POST', '/api/v1/roboapply/billing/checkout', {
      host: AS_USER.host,
      headers: { ...AS_USER.headers, ...(country ? { 'cf-ipcountry': country } : {}) },
      body: { planKey, autoRenewAck: true },
    });
  const charged = () => {
    const params = stripe.checkout.sessions.create.mock.calls.at(-1)![0] as any;
    return [params.line_items[0].price, params.metadata.currency];
  };

  it('a Taiwan buyer is charged the TWD price only for a plan whose TWD pair is set', async () => {
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD', 'price_m_twd');
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS', '74900');
    expect((await buyFrom('TW')).status).toBe(200);
    expect(charged()).toEqual(['price_m_twd', 'twd']);
    // Quarterly has no Taiwan price configured: USD, as the plan sheet showed.
    await fake.db.seekerSubscription.deleteMany({});
    expect((await buyFrom('tw', 'pro_quarterly')).status).toBe(200);
    expect(charged()).toEqual(['price_q', 'usd']);
  });

  it('without the TWD pair a Taiwan buyer pays the USD price; other countries always do', async () => {
    expect((await buyFrom('TW')).status).toBe(200);
    expect(charged()).toEqual(['price_m', 'usd']);
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD', 'price_m_twd');
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS', '74900');
    for (const country of ['DE', 'US', null]) {
      expect((await buyFrom(country)).status).toBe(200);
      expect(charged(), String(country)).toEqual(['price_m', 'usd']);
    }
  });

  it('the charge reads the edge\'s own country header: a client-sent cf-ipcountry cannot pick the Taiwan price', async () => {
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD', 'price_m_twd');
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS', '74900');
    const from = (headers: Record<string, string>) =>
      h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { host: AS_USER.host, headers: { ...AS_USER.headers, ...headers }, body: { planKey: 'pro_monthly', autoRenewAck: true } });
    expect((await from({ 'cf-ipcountry': 'TW', 'x-vercel-ip-country': 'US' })).status).toBe(200);
    expect(charged()).toEqual(['price_m', 'usd']);
    expect((await from({ 'cf-ipcountry': 'US', 'x-vercel-ip-country': 'TW' })).status).toBe(200);
    expect(charged()).toEqual(['price_m_twd', 'twd']);
  });

  it('the recorded auto-renewal acknowledgement names the price that is charged: TWD for a Taiwan buyer on a TWD price, USD otherwise', async () => {
    const ackHash = async () => {
      const rows = (await fake.db.seekerConsentRecord.findMany({})).filter((r: any) => r.consentType === 'auto_renew_ack');
      expect(rows).toHaveLength(1);
      await fake.db.seekerConsentRecord.deleteMany({});
      return rows[0].proseHash as string;
    };
    const usd = proseHash(autoRenewAckSentence({ interval: 'month', amountMinor: 2499, currency: 'USD' }));
    const twd = proseHash(autoRenewAckSentence({ interval: 'month', amountMinor: 74900, currency: 'TWD' }));
    expect(autoRenewAckSentence({ interval: 'month', amountMinor: 74900, currency: 'TWD' })).toBe('I agree this renews automatically every month at 749.00 TWD until I cancel');
    expect(twd).not.toBe(usd);

    // No Taiwan price configured: a Taiwan buyer ticked, and pays, the USD price.
    expect((await buyFrom('TW')).status).toBe(200);
    expect(await ackHash()).toBe(usd);

    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD', 'price_m_twd');
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS', '74900');
    expect((await buyFrom('TW')).status).toBe(200);
    expect(charged()).toEqual(['price_m_twd', 'twd']);
    expect(await ackHash()).toBe(twd);

    for (const country of ['US', null]) {
      expect((await buyFrom(country)).status).toBe(200);
      expect(await ackHash(), String(country)).toBe(usd);
    }
    // Quarterly has no Taiwan price: the USD quarterly sentence, even from Taiwan.
    expect((await buyFrom('TW', 'pro_quarterly')).status).toBe(200);
    expect(await ackHash()).toBe(proseHash(autoRenewAckSentence({ interval: 'quarter', amountMinor: 5999, currency: 'USD' })));
  });

  describe('the webhook stores what was charged', () => {
    const twdCheckout = {
      id: 'evt_tw',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_tw',
          mode: 'subscription',
          subscription: 'sub_tw',
          client_reference_id: 'u_1',
          customer_details: { address: { country: 'tw' } },
          metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly', userId: 'u_1', seekerProfileId: 'sp_1', currency: 'twd' },
        },
      },
    };

    beforeEach(async () => {
      vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD', 'price_m_twd');
      vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS', '74900');
      await fake.db.seekerSubscription.create({ data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'free', status: 'active', stripeCustomerId: 'cus_1', cancelAtPeriodEnd: false } });
    });

    it('a TWD subscription is stored as TWD with the charged amount, on the plan the TWD price belongs to', async () => {
      stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
        ...stripeSub(id, 'price_m_twd'),
        currency: 'twd',
        items: { data: [{ id: 'si_1', price: { id: 'price_m_twd', currency: 'twd', unit_amount: 74900 }, current_period_start: NOW_S, current_period_end: PERIOD_END_S }] },
      }));
      expect(await handleRoboApplyStripeEvent(twdCheckout as never, stripe as never)).toEqual({ handled: true });
      const row = await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } });
      expect(row).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'month', currency: 'TWD', amountMinor: 74900, stripePriceId: 'price_m_twd', billingCountry: 'TW', stripeSubscriptionId: 'sub_tw' });
      // Winback finds the subscription through the grant metadata, as before.
      expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { planKey: 'pro_monthly', stripeSubscriptionId: 'sub_tw' } }));
    });

    it('a thin event without the price fields still stores TWD and the configured Taiwan amount (matched by price id)', async () => {
      stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
        ...stripeSub(id, 'price_m_twd'),
        items: { data: [{ id: 'si_1', price: { id: 'price_m_twd' }, current_period_start: NOW_S, current_period_end: PERIOD_END_S }] },
      }));
      await handleRoboApplyStripeEvent(twdCheckout as never, stripe as never);
      expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ currency: 'TWD', amountMinor: 74900 });
    });

    it('a USD subscription on the same deployment stays USD at its own amount', async () => {
      await handleRoboApplyStripeEvent({ ...twdCheckout, data: { object: { ...twdCheckout.data.object, id: 'cs_us', subscription: 'sub_us' } } } as never, stripe as never);
      expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ currency: 'USD', amountMinor: 2499, stripePriceId: 'price_m' });
    });

    it('a renewal paid in TWD keeps the TWD amount', async () => {
      await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { tier: 'pro', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_tw', currency: 'TWD', amountMinor: 74900 } });
      stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
        ...stripeSub(id, 'price_m_twd'),
        items: { data: [{ id: 'si_1', price: { id: 'price_m_twd', currency: 'twd', unit_amount: 74900 }, current_period_start: PERIOD_END_S, current_period_end: PERIOD_END_S + 30 * 86400 }] },
      }));
      const paid = { id: 'evt_tw_renew', type: 'invoice.paid', data: { object: { id: 'in_tw_2', billing_reason: 'subscription_cycle', currency: 'twd', amount_paid: 74900, subscription: 'sub_tw' } } };
      expect(await handleRoboApplyStripeEvent(paid as never, stripe as never)).toEqual({ handled: true });
      expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ currency: 'TWD', amountMinor: 74900, planKey: 'pro_monthly' });
    });
  });
});

describe('legacy switch never charges without confirm', () => {
  beforeEach(async () => {
    await fake.db.seekerSubscription.create({
      data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'starter', status: 'active', stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1', currentPeriodEnd: new Date(PERIOD_END_S * 1000), cancelAtPeriodEnd: false },
    });
  });

  it('quotes first', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', { ...AS_USER, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(200);
    expect(res.body.data.quote).toMatchObject({ planKey: 'pro_monthly', amountDueTodayMinor: 1500, newRenewalPriceMinor: 2499, currency: 'USD' });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('refuses confirm without the auto-renewal acknowledgement; nothing is charged or recorded', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', { ...AS_USER, body: { planKey: 'pro_weekly', confirm: true, prorationDate: NOW_S } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('auto_renew_ack_required');
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(await fake.db.seekerConsentRecord.findMany({})).toEqual([]);
  });

  it('charges on confirm with the quoted proration date, after recording auto_renew_ack for the new terms', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', {
      ...AS_USER,
      body: { planKey: 'pro_monthly', confirm: true, prorationDate: NOW_S, autoRenewAck: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ switched: true, planKey: 'pro_monthly' });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_old', expect.objectContaining({ proration_date: NOW_S, proration_behavior: 'always_invoice' }));
    const records = await fake.db.seekerConsentRecord.findMany({});
    expect(records).toEqual([
      expect.objectContaining({
        seekerProfileId: 'sp_1',
        consentType: 'auto_renew_ack',
        granted: true,
        proseHash: proseHash(autoRenewAckSentence({ interval: 'month', amountMinor: 2499, currency: 'USD' })),
      }),
    ]);
  });

  it('a switch on a Taiwan (TWD) subscription records the TWD renewal price it will charge', async () => {
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD', 'price_m_twd');
    vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS', '74900');
    stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({ ...stripeSub(id, 'price_starter_twd'), currency: 'twd' }));
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/switch', {
      ...AS_USER,
      body: { planKey: 'pro_monthly', confirm: true, prorationDate: NOW_S, autoRenewAck: true },
    });
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_old', expect.objectContaining({ items: [expect.objectContaining({ price: 'price_m_twd' })] }));
    const records = await fake.db.seekerConsentRecord.findMany({});
    expect(records.map((r: any) => r.proseHash)).toEqual([proseHash(autoRenewAckSentence({ interval: 'month', amountMinor: 74900, currency: 'TWD' }))]);
  });

  it('the plan view shows the legacy plan as legacy and Pro plans as the catalog', async () => {
    const res = await h.request<any>('GET', '/api/v1/roboapply/billing/plan', AS_USER);
    expect(res.body.data.current).toMatchObject({ planKey: 'starter', legacyPlan: true, autoRenews: true });
    expect(res.body.data.plans.every((p: any) => p.purchasable === false)).toBe(true);
    expect(res.body.data.defaultSelection).toBe('pro_monthly');
    expect(res.body.data.region).toEqual({ market: 'other', currency: 'USD', method: 'stripe', source: 'brand' });
  });
});

describe('Stripe webhook idempotency', () => {
  const subscriptionCheckout = {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        mode: 'subscription',
        subscription: 'sub_new',
        client_reference_id: 'u_1',
        customer_details: { address: { country: 'de' } },
        metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly', userId: 'u_1', seekerProfileId: 'sp_1' },
      },
    },
  };

  it('a replayed subscription checkout re-syncs but grants by period only', async () => {
    await fake.db.seekerSubscription.create({ data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'free', status: 'active', stripeCustomerId: 'cus_1', cancelAtPeriodEnd: false } });
    const first = await handleRoboApplyStripeEvent(subscriptionCheckout as never, stripe as never);
    expect(first).toEqual({ handled: true });
    const row = await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } });
    expect(row).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'month', rail: 'stripe', brand: 'roboapply', stripeSubscriptionId: 'sub_new', billingCountry: 'DE' });
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'pro', credits: 3, force: true }));
    const replay = await handleRoboApplyStripeEvent(subscriptionCheckout as never, stripe as never);
    expect(replay).toEqual({ handled: true, duplicate: true });
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ force: false }));
  });

  it('a replayed 7-day pass payment extends access once', async () => {
    const event = {
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_pass', mode: 'payment', payment_status: 'paid', amount_total: 699, currency: 'usd', customer: 'cus_1', metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_week_pass', userId: 'u_1', seekerProfileId: 'sp_1' } } },
    };
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true });
    const end = ((await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } })).currentPeriodEnd as Date).toISOString();
    expect(end).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true, duplicate: true });
    expect(((await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } })).currentPeriodEnd as Date).toISOString()).toBe(end);
    // The replay re-checks the grant under the period guard; it does not grant twice.
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ force: false, periodStart: NOW }));
    expect(credits.grants).toBe(1);
  });

  it('a 7-day pass whose grant crashed after activation is granted on the replay, once', async () => {
    const event = {
      id: 'evt_2c',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_pass_c', mode: 'payment', payment_status: 'paid', amount_total: 699, currency: 'usd', customer: 'cus_1', metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_week_pass', userId: 'u_1', seekerProfileId: 'sp_1' } } },
    };
    credits.renewedAt = new Date(NOW.getTime() - 86_400_000); // an older grant (e.g. the free plan)
    grantIfNewPeriod.mockRejectedValueOnce(new Error('crash'));
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toMatchObject({ failed: true });
    expect(credits.grants).toBe(0);
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true, duplicate: true });
    expect(credits.grants).toBe(1);
    await handleRoboApplyStripeEvent(event as never, stripe as never);
    expect(credits.grants).toBe(1);
  });

  it('a practice pack grants under one idempotency key per session', async () => {
    const event = {
      id: 'evt_3',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_pack', mode: 'payment', payment_status: 'paid', metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'practice_pack_5', userId: 'u_1', seekerProfileId: 'sp_1' } } },
    };
    await handleRoboApplyStripeEvent(event as never, stripe as never);
    await handleRoboApplyStripeEvent(event as never, stripe as never);
    expect(grantPack.mock.calls.map((c: any[]) => c[0].idempotencyKey)).toEqual(['stripe:cs_pack', 'stripe:cs_pack']);
    expect(grantPack).toHaveBeenCalledWith(expect.objectContaining({ credits: 5 }));
  });

  it('renewal credits wait for invoice.paid: subscription.updated (even past_due) grants nothing; the paid invoice grants once', async () => {
    await fake.db.seekerSubscription.create({ data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', currentPeriodEnd: new Date(PERIOD_END_S * 1000) } });
    credits.renewedAt = NOW; // this period was granted at checkout
    const NEXT_END_S = PERIOD_END_S + 30 * 86400;
    const renewed = (status: string) =>
      stripeSub('sub_1', 'price_m', {
        status,
        metadata: { planKey: 'pro_monthly' },
        items: { data: [{ id: 'si_1', price: { id: 'price_m', currency: 'usd', unit_amount: 2499 }, current_period_start: PERIOD_END_S, current_period_end: NEXT_END_S }] },
      });
    // Stripe advances the period when it drafts the invoice; the charge then fails.
    for (const status of ['active', 'past_due']) {
      const updated = { id: `evt_u_${status}`, type: 'customer.subscription.updated', data: { object: renewed(status) } };
      expect(await handleRoboApplyStripeEvent(updated as never, stripe as never)).toEqual({ handled: true });
    }
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).status).toBe('past_due');
    // The retry succeeds.
    stripe.subscriptions.retrieve.mockImplementation(async () => renewed('active') as never);
    const paid = { id: 'evt_paid', type: 'invoice.paid', data: { object: { id: 'in_2', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } } } };
    expect(await handleRoboApplyStripeEvent(paid as never, stripe as never)).toEqual({ handled: true });
    expect(grantIfNewPeriod).toHaveBeenCalledWith(expect.objectContaining({ periodStart: new Date(PERIOD_END_S * 1000), force: false, credits: 3 }));
    expect(credits.grants).toBe(1);
    await handleRoboApplyStripeEvent(paid as never, stripe as never);
    expect(credits.grants).toBe(1);
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).status).toBe('active');
  });

  it('a paid switch invoice grants the new plan once, even after subscription.updated synced the tier', async () => {
    await fake.db.seekerSubscription.create({ data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'starter', status: 'active', stripeSubscriptionId: 'sub_old', stripeCustomerId: 'cus_1', currentPeriodEnd: new Date(PERIOD_END_S * 1000) } });
    credits.renewedAt = NOW;
    const switched = stripeSub('sub_old', 'price_m', { metadata: { planKey: 'pro_monthly' } });
    stripe.subscriptions.retrieve.mockImplementation(async () => switched as never);
    await handleRoboApplyStripeEvent({ id: 'evt_s1', type: 'customer.subscription.updated', data: { object: switched } } as never, stripe as never);
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).tier).toBe('pro');
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
    const paid = { id: 'evt_s2', type: 'invoice.paid', data: { object: { id: 'in_sw', billing_reason: 'subscription_update', parent: { subscription_details: { subscription: 'sub_old' } } } } };
    expect(await handleRoboApplyStripeEvent(paid as never, stripe as never)).toEqual({ handled: true });
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'pro', credits: 3, force: true }));
    expect(await handleRoboApplyStripeEvent(paid as never, stripe as never)).toEqual({ handled: true, duplicate: true });
    expect(credits.grants).toBe(1);
  });

  it('a failed renewal marks past_due and emails once', async () => {
    await fake.db.seekerSubscription.create({ data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', stripeSubscriptionId: 'sub_1', amountMinor: 2499, currency: 'USD' } });
    const event = { id: 'evt_4', type: 'invoice.payment_failed', data: { object: { id: 'in_1', amount_due: 2499, currency: 'usd', parent: { subscription_details: { subscription: 'sub_1' } } } } };
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true });
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true, duplicate: true });
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).status).toBe('past_due');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ template: 'billing.payment_failed', brand: 'roboapply', to: 'u_1@example.test' }));
  });

  it('ignores events for a subscription the row no longer tracks (replaced by a pass)', async () => {
    await fake.db.seekerSubscription.create({ data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_week_pass', stripeSubscriptionId: null, stripeCustomerId: 'cus_1', currentPeriodEnd: new Date(PERIOD_END_S * 1000) } });
    const deleted = { id: 'evt_5', type: 'customer.subscription.deleted', data: { object: stripeSub('sub_old', 'price_m', { status: 'canceled' }) } };
    expect(await handleRoboApplyStripeEvent(deleted as never, stripe as never)).toEqual({ handled: false });
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).tier).toBe('pro');
  });

  // Alipay contract rule A11 (MARKET_STRATEGY.md §5.2): characterisation, do not relax.
  it('A11 never activates anything for a GoApply-branded Stripe session', async () => {
    const event = { ...subscriptionCheckout, data: { object: { ...subscriptionCheckout.data.object, metadata: { ...subscriptionCheckout.data.object.metadata, brand: 'goapply' } } } };
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('reads the subscription id on old and new invoice shapes', () => {
    expect(invoiceSubscriptionId({ subscription: 'sub_a' } as never)).toBe('sub_a');
    expect(invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_b' } } } as never)).toBe('sub_b');
    expect(invoiceSubscriptionId({} as never)).toBeNull();
  });
});

// ST-1 consequence: a price the catalog sync created has no env pin to compare
// with. The webhook recognises it by the plan key stamped on the price, or by
// its lookup key, even when the subscription carries no metadata.
describe('webhook: a synced price is recognised without metadata or pins', () => {
  const NEXT_END_S = PERIOD_END_S + 90 * 86400;
  const noPins = () => {
    for (const k of Object.keys(PRICES)) if (k.startsWith('STRIPE_PRICE_')) vi.stubEnv(k, '');
  };
  const subOn = (price: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    start_date: NOW_S,
    metadata: {},
    items: { data: [{ id: 'si_1', price, current_period_start: NOW_S, current_period_end: NEXT_END_S }] },
    ...over,
  });

  beforeEach(async () => {
    noPins();
    await fake.db.seekerSubscription.create({
      data: { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', currentPeriodEnd: new Date(PERIOD_END_S * 1000) },
    });
  });

  it('subscription.updated with empty metadata records the plan key, interval and price from the price the sync created', async () => {
    const price = { id: 'price_synced_q', lookup_key: 'ra_pro_quarterly_usd_5499_incl', currency: 'usd', unit_amount: 5499, metadata: { product: 'roboapply', planKey: 'pro_quarterly' } };
    const event = { id: 'evt_q', type: 'customer.subscription.updated', data: { object: subOn(price) } };
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true });
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({
      tier: 'pro',
      planKey: 'pro_quarterly',
      interval: 'quarter',
      currency: 'USD',
      amountMinor: 5499,
      stripePriceId: 'price_synced_q',
    });
    // State only: credits wait for the paid invoice.
    expect(grantIfNewPeriod).not.toHaveBeenCalled();
  });

  it('the paid invoice then grants that plan\'s allowance (3 credits for quarterly, 1 for weekly), found by the lookup key alone', async () => {
    const paid = { id: 'evt_paid', type: 'invoice.paid', data: { object: { id: 'in_1', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1' } } } } };
    // Metadata edited away on the price: the lookup key still names the plan.
    stripe.subscriptions.retrieve.mockImplementation(async () => subOn({ id: 'price_synced_q', lookup_key: 'ra_pro_quarterly_usd_5499_incl', currency: 'usd', unit_amount: 5499, metadata: {} }) as never);
    expect(await handleRoboApplyStripeEvent(paid as never, stripe as never)).toEqual({ handled: true });
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'pro', credits: 3, metadata: { planKey: 'pro_quarterly', stripeSubscriptionId: 'sub_1' } }));
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).interval).toBe('quarter');

    stripe.subscriptions.retrieve.mockImplementation(async () => subOn({ id: 'price_synced_w', lookup_key: 'ra_pro_weekly_usd_999_incl', currency: 'usd', unit_amount: 999 }) as never);
    await handleRoboApplyStripeEvent({ ...paid, id: 'evt_paid_2', data: { object: { ...paid.data.object, id: 'in_2' } } } as never, stripe as never);
    expect(grantIfNewPeriod).toHaveBeenLastCalledWith(expect.objectContaining({ credits: 1, metadata: { planKey: 'pro_weekly', stripeSubscriptionId: 'sub_1' } }));
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ planKey: 'pro_weekly', interval: 'week', amountMinor: 999 });
  });

  it('a synced TWD price is stored as TWD at its amount, from the price fields or, on a thin event, from the lookup key', async () => {
    vi.stubEnv('PRICE_PRO_MONTHLY_TWD_CENTS', '74900');
    const full = { id: 'price_synced_tw', lookup_key: 'ra_pro_monthly_twd_74900_incl', currency: 'twd', unit_amount: 74900, metadata: { product: 'roboapply', planKey: 'pro_monthly' } };
    await handleRoboApplyStripeEvent({ id: 'evt_tw1', type: 'customer.subscription.updated', data: { object: subOn(full) } } as never, stripe as never);
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ planKey: 'pro_monthly', currency: 'TWD', amountMinor: 74900, stripePriceId: 'price_synced_tw' });

    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { currency: null, amountMinor: null } });
    const thin = { id: 'price_synced_tw', lookup_key: 'ra_pro_monthly_twd_74900_incl' };
    await handleRoboApplyStripeEvent({ id: 'evt_tw2', type: 'customer.subscription.updated', data: { object: subOn(thin) } } as never, stripe as never);
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ planKey: 'pro_monthly', currency: 'TWD', amountMinor: 74900 });

    // The same for a thin USD event: the lookup key carries currency and amount.
    await fake.db.seekerSubscription.update({ where: { id: 'row_1' }, data: { currency: null, amountMinor: null } });
    await handleRoboApplyStripeEvent({ id: 'evt_us', type: 'customer.subscription.updated', data: { object: subOn({ id: 'price_synced_q', lookup_key: 'ra_pro_quarterly_usd_5499_incl' }) } } as never, stripe as never);
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ planKey: 'pro_quarterly', interval: 'quarter', currency: 'USD', amountMinor: 5499 });
  });

  it('subscription metadata still wins over the price (price-first is a later requirement), and a pinned id still resolves', async () => {
    const price = { id: 'price_synced_q', lookup_key: 'ra_pro_quarterly_usd_5499_incl', currency: 'usd', unit_amount: 5499, metadata: { product: 'roboapply', planKey: 'pro_quarterly' } };
    await handleRoboApplyStripeEvent({ id: 'evt_m', type: 'customer.subscription.updated', data: { object: subOn(price, { metadata: { planKey: 'pro_monthly' } }) } } as never, stripe as never);
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).planKey).toBe('pro_monthly');

    vi.stubEnv('STRIPE_PRICE_PRO_WEEKLY', 'price_w');
    vi.stubEnv('STRIPE_PRICE_PRO_WEEKLY_CENTS', '999');
    await handleRoboApplyStripeEvent({ id: 'evt_p', type: 'customer.subscription.updated', data: { object: subOn({ id: 'price_w', currency: 'usd', unit_amount: 999 }) } } as never, stripe as never);
    expect(await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).toMatchObject({ planKey: 'pro_weekly', interval: 'week' });
  });

  it('a price of another product on the same Stripe account is not read as one of our plans', async () => {
    const foreign = { id: 'price_other', lookup_key: 'rh_team_usd_9900', currency: 'usd', unit_amount: 9900, metadata: { product: 'robohire', planKey: 'pro_quarterly' } };
    await handleRoboApplyStripeEvent({ id: 'evt_f', type: 'customer.subscription.updated', data: { object: subOn(foreign) } } as never, stripe as never);
    // Falls to the legacy practice-plan mapping, exactly as an unknown price did before.
    expect((await fake.db.seekerSubscription.findUnique({ where: { id: 'row_1' } })).planKey).not.toBe('pro_quarterly');
  });
});

describe('Stripe event handler registry (the seam for refunds, disputes and the later lifecycle events)', () => {
  const TYPE = 'charge.refunded';
  const event = { id: 'evt_r1', type: TYPE, data: { object: { id: 'ch_1', customer: 'cus_1', amount: 2499, amount_refunded: 2499 } } };
  afterEach(() => {
    unregisterStripeEventHandlerForTests(TYPE);
    unregisterStripeEventHandlerForTests('invoice.paid');
  });

  it('an event type with a registered handler is dispatched to it, with the service\'s Stripe client, database and clock, and its result is returned', async () => {
    const handler = vi.fn(async () => ({ handled: true, duplicate: true }));
    registerStripeEventHandler(TYPE, handler);
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: true, duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
    const [got, ctx] = handler.mock.calls[0] as unknown as [typeof event, { stripe: unknown; db: unknown; now: () => Date }];
    expect(got).toBe(event);
    expect(ctx.stripe).toBe(stripe);
    expect(ctx.db).toBe(fake.db);
    expect(ctx.now()).toEqual(NOW);
  });

  it('an unregistered type still answers { handled: false }', async () => {
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: false });
    expect(await handleRoboApplyStripeEvent({ id: 'evt_x', type: 'customer.created', data: { object: {} } } as never, stripe as never)).toEqual({ handled: false });
  });

  it('a handler that throws is a failed event, so the webhook answers 500 and Stripe retries', async () => {
    registerStripeEventHandler(TYPE, async () => {
      throw new Error('ledger unavailable');
    });
    expect(await handleRoboApplyStripeEvent(event as never, stripe as never)).toEqual({ handled: false, failed: true });
  });

  it('a type the service handles itself never reaches a registered handler', async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    registerStripeEventHandler('invoice.paid', handler);
    const paid = { id: 'evt_p', type: 'invoice.paid', data: { object: { id: 'in_9', billing_reason: 'subscription_cycle' } } };
    expect(await handleRoboApplyStripeEvent(paid as never, stripe as never)).toEqual({ handled: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('over HTTP: 200 handled false for an unregistered type, the handler\'s answer for a registered one, 500 when it throws', async () => {
    let next: Record<string, unknown> = event;
    const verifying = { ...stripe, webhooks: { constructEvent: vi.fn(() => next) } };
    const wh = await startRouteHarness({ mounts: [['/wh', createStripeWebhookRouter({ getStripe: () => verifying as never, secret: () => 'whsec_test' })]] });
    try {
      const post = () => wh.request<any>('POST', '/wh', { headers: { 'stripe-signature': 't=1,v1=x' }, body: {} });
      const none = await post();
      expect([none.status, none.body]).toEqual([200, { received: true, handled: false }]);

      registerStripeEventHandler(TYPE, async () => ({ handled: true }));
      const handled = await post();
      expect([handled.status, handled.body]).toEqual([200, { received: true, handled: true }]);

      registerStripeEventHandler(TYPE, async () => {
        throw new Error('ledger unavailable');
      });
      const failed = await post();
      expect([failed.status, failed.body]).toEqual([500, { received: true, handled: false }]);

      next = { id: 'evt_other', type: 'payout.paid', data: { object: {} } };
      expect((await post()).status).toBe(200);
    } finally {
      await wh.close();
    }
  });
});
