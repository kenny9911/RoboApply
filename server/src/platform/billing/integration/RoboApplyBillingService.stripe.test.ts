// @vitest-environment node
//
// RoboApply (Stripe) billing: checkout acknowledgements, the legacy switch
// quote, and webhook idempotency (TASK_PLAN.md WP-21a acceptance); Account V2
// wiring (WP-79): student plans need the capability and a live verification,
// Taiwan buyers are charged the configured TWD price and the webhook stores it.

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
import { handleRoboApplyStripeEvent, invoiceSubscriptionId, setBillingServiceDepsForTests } from '../../../roboapply/services/RoboApplyBillingService.js';
import { autoRenewAckSentence, proseHash, setStripeClientForTests } from '../index.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const PERIOD_END_S = NOW_S + 30 * 86400;

const PRICES = {
  STRIPE_SECRET_KEY: 'sk_test_x',
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

const stripe = {
  customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
  checkout: { sessions: { create: vi.fn(async () => ({ id: 'cs_new', url: 'https://checkout.stripe.test/cs_new' })) } },
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

  it('weekly is sold only when asked for, never as a default; unknown and unpriced plans are refused', async () => {
    expect((await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'nope' } })).body.code).toBe('plan_not_sellable');
    vi.stubEnv('STRIPE_PRICE_PRO_QUARTERLY', '');
    expect((await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...AS_USER, body: { planKey: 'pro_quarterly', autoRenewAck: true } })).status).toBe(409);
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

  it('an unpriced student plan is not on sale', async () => {
    student.verified = true;
    vi.stubEnv('STRIPE_PRICE_STUDENT_QUARTERLY', '');
    expect((await buy('student_quarterly')).body.code).toBe('plan_not_sellable');
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

  it('never activates anything for a GoApply-branded Stripe session', async () => {
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
