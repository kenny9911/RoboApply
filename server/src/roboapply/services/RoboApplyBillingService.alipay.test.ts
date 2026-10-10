// @vitest-environment node
//
// CN-rail checkout and the Alipay callback through the legacy /billing routes
// (CN_TW_LAUNCH_PLAN.md WP-PAY: "an existing test is updated"). Brand decides
// the rail; GoApply orders are fulfilled once through fulfilPass(). WeChat Pay
// through /billing/checkout carries the payer address this server saw (H5
// needs it) and the ticked agreement version to the rail, and holds the same
// agreement gate as /billing-cn/wechatpay (published version, consent record).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'], alipayOrder: ['outTradeNo'] } });
  return { default: fake.db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
    req.user = { id, email: `${id}@example.test`, name: 'Test', brand: req.headers['x-test-brand'] ?? 'roboapply' };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import billingRouter from '../routes/billing.js';
import { setBillingServiceDepsForTests } from './RoboApplyBillingService.js';
import { createAlipayWorkerRail, getRegisteredRail, registerRail, unregisterRail, type CheckoutOrder, type PaymentRailImpl } from '../../platform/billing/index.js';
import { BillingCnService, cnPayTermsStatement } from '../../features/billing-cn/service.js';
import { CN_PAY_TERMS_CONSENT_TYPE } from '../../features/billing-cn/contract.js';
import { createHash } from 'node:crypto';

const ENV_KEYS = {
  CN_PAYMENTS_ENABLED: 'true',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRACTICE_PACK_5_FEN: '2900',
  CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
  ALIPAY_API_URL: 'https://payments.example.com/create',
  ALIPAY_CALLBACK_SECRET: 'test-secret',
  STRIPE_SECRET_KEY: '',
  BACKEND_URL: '',
  CN_BACKEND_URL: '',
};

const fetchMock = vi.fn();
const grantIfNewPeriod = vi.fn(async () => 'granted' as const);
let h: RouteHarness;

beforeAll(async () => {
  // The rail's HTTP client is injected; the harness itself uses the real fetch.
  registerRail('alipay', createAlipayWorkerRail({ fetch: fetchMock as unknown as typeof fetch }));
  h = await startRouteHarness({ mounts: [['/api/v1/roboapply/billing', billingRouter]] });
});
afterAll(async () => {
  registerRail('alipay', createAlipayWorkerRail());
  await h.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(ENV_KEYS)) vi.stubEnv(k, v);
  fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://payments.example.com/pay' } }) });
  for (const t of ['alipayOrder', 'seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'rACreditGrant']) fake.db[t].deleteMany({});
  fake.db.user.deleteMany({});
  fake.db.seekerProfile.deleteMany({});
  fake.db.user.create({ data: { id: 'cn_user', email: 'cn_user@example.test', name: 'CN', brand: 'goapply' } });
  fake.db.user.create({ data: { id: 'intl_user', email: 'intl_user@example.test', name: 'Intl', brand: 'roboapply' } });
  fake.db.seekerProfile.create({ data: { id: 'sp_cn', userId: 'cn_user', locale: 'zh', deletedAt: null } });
  fake.db.seekerProfile.create({ data: { id: 'sp_intl', userId: 'intl_user', locale: 'en', deletedAt: null } });
  setBillingServiceDepsForTests({
    db: fake.db as never,
    grantIfNewPeriod,
    getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
    sendEmail: vi.fn(async () => ({ status: 'sent' as const })),
    invalidate: () => {},
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setBillingServiceDepsForTests();
});

const GO = { host: 'goapply.localhost:3621', headers: { 'x-test-user': 'cn_user', 'x-test-brand': 'goapply' } };
const RA = { host: 'localhost:3621', headers: { 'x-test-user': 'intl_user' } };

describe('GoApply checkout through the Alipay worker', () => {
  it('creates a whole-yuan pass order on the GoApply callback URL', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'redirect', url: 'https://payments.example.com/pay', rail: 'alipay' });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.total_amount).toBe(39);
    const notify = new URL(payload.notify_url);
    expect(notify.origin).toBe('https://www.goapply.top');
    expect(notify.pathname).toBe('/api/v1/roboapply/billing/alipay/callback');
    expect([...notify.searchParams]).toEqual([['cb', 'test-secret']]);
    const order = await fake.db.alipayOrder.findUnique({ where: { outTradeNo: payload.out_trade_no } });
    expect(order).toMatchObject({ tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', amountMinor: 3900, status: 'pending' });
  });

  it('GoApply checkout stays closed while CN payments are off', async () => {
    vi.stubEnv('CN_PAYMENTS_ENABLED', 'false');
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('plan_not_sellable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RoboApply never sells through Alipay, and legacy practice plans are no longer sold', async () => {
    const alipay = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...RA, body: { planKey: 'pro_monthly' } });
    expect(alipay.status).toBe(409);
    expect(['rail_not_allowed', 'plan_not_sellable']).toContain(alipay.body.code);
    const legacy = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...RA, body: { tier: 'starter' } });
    expect(legacy.status).toBe(409);
    expect(legacy.body.code).toBe('plan_not_sellable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GoApply WeChat Pay through the legacy /billing/checkout', () => {
  const WECHAT_ENV = {
    WECHATPAY_MCH_ID: '1900000001',
    WECHATPAY_APP_ID: 'wxtestappid000001',
    WECHATPAY_API_V3_KEY: 'k'.repeat(32),
    WECHATPAY_MCH_CERT_SERIAL: 'MCHSERIAL0001',
    WECHATPAY_MCH_PRIVATE_KEY: 'test-private-key',
    // Everything the `pay.wechatpay` capability may ask for (verification key and the entity match).
    WECHATPAY_PUBLIC_KEY: 'test-public-key',
    WECHATPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_TEST_0001',
    WECHATPAY_MERCHANT_ENTITY: 'Example Collecting Co.',
    CN_PRICE_PRO_WEEK_PASS_FEN: '1200',
    // The published 用户协议 version (what GET /public/legal/terms answers on GoApply).
    CN_LEGAL_DOCS_VERSION: 'cn-terms-2026-10',
  };
  const TERMS = 'cn-terms-2026-10';
  const orders: CheckoutOrder[] = [];
  const limiter = { allowed: true };
  let before: PaymentRailImpl | null = null;
  const consents = async () => (await fake.db.seekerConsentRecord.findMany({})) as Array<Record<string, any>>;

  beforeEach(() => {
    for (const [k, v] of Object.entries(WECHAT_ENV)) vi.stubEnv(k, v);
    orders.length = 0;
    limiter.allowed = true;
    // The real billing-cn gate over the fake database; only the DB-backed limiter is stood in.
    const cn = new BillingCnService({
      getDb: async () => fake.db as never,
      consumeRateLimit: async () => ({ allowed: limiter.allowed, retryAfterSec: limiter.allowed ? 0 : 42 }),
    });
    setBillingServiceDepsForTests({
      db: fake.db as never,
      grantIfNewPeriod,
      getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
      sendEmail: vi.fn(async () => ({ status: 'sent' as const })),
      invalidate: () => {},
      acknowledgeCnPayTerms: (i) =>
        cn.acknowledgeTerms(i.userId, i.brand, { seekerProfileId: i.seekerProfileId, plan: i.plan, termsVersion: i.termsVersion }, { ip: i.ip, userAgent: i.userAgent }),
    });
    before = getRegisteredRail('wechatpay');
    // A stand-in rail: what matters here is what the route hands it.
    registerRail('wechatpay', {
      id: 'wechatpay',
      isConfigured: () => true,
      createCheckout: async (order) => {
        orders.push(order);
        if (order.context?.tradeType === 'h5') return { kind: 'redirect', url: 'https://wx.tenpay.com/checkmweb?prepay_id=1', orderId: 'GAWX_H5' };
        return { kind: 'qr', qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=abc', orderId: 'GAWX_QR', expiresAt: '2026-10-10T08:15:00.000Z' };
      },
    });
  });
  afterEach(() => {
    if (before) registerRail('wechatpay', before);
    else unregisterRail('wechatpay');
  });

  it('H5 carries the address this server saw as payerClientIp (never a body field), and answers the shared redirect shape', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', {
      ...GO,
      body: { planKey: 'pro_week_pass', rail: 'wechatpay', tradeType: 'h5', termsVersion: TERMS, payerClientIp: '203.0.113.99' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ kind: 'redirect', url: 'https://wx.tenpay.com/checkmweb?prepay_id=1', orderId: 'GAWX_H5', rail: 'wechatpay' });
    expect(orders).toHaveLength(1);
    const ctx = orders[0]!.context!;
    expect(ctx.tradeType).toBe('h5');
    // The harness calls over loopback: that is the address Express reports.
    expect(ctx.payerClientIp).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
    expect(ctx.payerClientIp).not.toBe('203.0.113.99');
    expect(ctx.termsVersion).toBe(TERMS);
    // The same consent record /billing-cn/wechatpay writes, before the rail was called.
    const records = await consents();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      seekerProfileId: 'sp_cn',
      consentType: CN_PAY_TERMS_CONSENT_TYPE,
      granted: true,
      proseVersion: TERMS,
      proseHash: createHash('sha256')
        .update(cnPayTermsStatement({ termsVersion: TERMS, planKey: 'pro_week_pass', amountMinor: 1200, collectingEntity: 'Example Collecting Co.' }), 'utf8')
        .digest('hex'),
    });
  });

  it('409 terms_outdated when the ticked 用户协议 version is missing or not the published one: no order, no consent record', async () => {
    const bodies = [
      { planKey: 'pro_monthly', rail: 'wechatpay', tradeType: 'native' },
      { planKey: 'pro_monthly', rail: 'wechatpay', tradeType: 'native', termsVersion: 'cn-terms-2026-09' },
      { planKey: 'pro_week_pass', rail: 'wechatpay', tradeType: 'h5', termsVersion: 'anything' },
      { planKey: 'pro_monthly', rail: 'wechatpay' },
    ];
    for (const body of bodies) {
      const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body });
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([409, 'terms_outdated']);
      expect(res.body.details).toEqual({ currentVersion: TERMS });
    }
    expect(orders).toHaveLength(0);
    expect(await consents()).toEqual([]);
    expect(await fake.db.alipayOrder.findMany({})).toEqual([]);
  });

  it('409 terms_outdated when no 用户协议 version is published at all, whatever the client sends', async () => {
    vi.stubEnv('CN_LEGAL_DOCS_VERSION', '');
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly', rail: 'wechatpay', tradeType: 'native', termsVersion: TERMS } });
    expect([res.status, res.body.code]).toEqual([409, 'terms_outdated']);
    expect(orders).toHaveLength(0);
    expect(await consents()).toEqual([]);
  });

  it('429 rate_limited from the same per-user limit as /billing-cn/wechatpay: no order, no consent record', async () => {
    limiter.allowed = false;
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly', rail: 'wechatpay', tradeType: 'native', termsVersion: TERMS } });
    expect([res.status, res.body.code]).toEqual([429, 'rate_limited']);
    expect(res.body.details).toEqual({ retryAfterSec: 42 });
    expect(orders).toHaveLength(0);
    expect(await consents()).toEqual([]);
  });

  it('the Alipay rail is not behind the WeChat Pay agreement gate', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(200);
    expect(await consents()).toEqual([]);
  });

  it('a Native order answers `kind: qr` with the code content and the rail, never a redirect URL', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly', rail: 'wechatpay', tradeType: 'native', termsVersion: TERMS } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ kind: 'qr', qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=abc', orderId: 'GAWX_QR', expiresAt: '2026-10-10T08:15:00.000Z', rail: 'wechatpay' });
    expect(res.body.data.url).toBeUndefined();
    expect(orders[0]!.context).toMatchObject({ tradeType: 'native', termsVersion: TERMS });
  });

  it('stays unpurchasable while CN_PAYMENTS_ENABLED is unset: no order reaches the rail on any trade type', async () => {
    vi.stubEnv('CN_PAYMENTS_ENABLED', '');
    for (const tradeType of ['native', 'h5', 'jsapi']) {
      const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly', rail: 'wechatpay', tradeType, termsVersion: TERMS } });
      expect(res.status, tradeType).toBe(409);
      expect(res.body.code).toBe('plan_not_sellable');
    }
    expect(orders).toHaveLength(0);
    expect(await consents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RoboApply never reaches WeChat Pay', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...RA, body: { planKey: 'pro_monthly', autoRenewAck: true, rail: 'wechatpay', tradeType: 'h5', termsVersion: TERMS } });
    expect(res.status).toBeGreaterThanOrEqual(409);
    expect(orders).toHaveLength(0);
    expect(await consents()).toEqual([]);
  });
});

describe('Alipay callback → fulfilPass', () => {
  async function seedOrder(over: Record<string, unknown> = {}) {
    await fake.db.alipayOrder.create({
      data: { id: 'o_1', userId: 'cn_user', outTradeNo: 'GAORDER_X', tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', channel: 'alipay', amount: 39, amountMinor: 3900, status: 'pending', ...over },
    });
  }

  it('rejects a callback without the shared secret', async () => {
    await seedOrder();
    const res = await h.request<any>('GET', '/api/v1/roboapply/billing/alipay/callback?pay_status=TRADE_SUCCESS&out_trade_no=GAORDER_X');
    expect(res.status).toBe(403);
    expect((await fake.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_X' } })).status).toBe('pending');
  });

  it('refuses every callback (503) when ALIPAY_CALLBACK_SECRET is unset, even for a known order', async () => {
    await seedOrder();
    vi.stubEnv('ALIPAY_CALLBACK_SECRET', '');
    for (const q of ['', '&cb=', '&cb=guess']) {
      const res = await h.request<any>('GET', `/api/v1/roboapply/billing/alipay/callback?pay_status=TRADE_SUCCESS&out_trade_no=GAORDER_X${q}`);
      expect(res.status).toBe(503);
    }
    expect((await fake.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_X' } })).status).toBe('pending');
    expect(await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } })).toBeNull();
  });

  it('activates the pass once; a replayed notify answers success without a second activation', async () => {
    await seedOrder();
    const url = '/api/v1/roboapply/billing/alipay/callback?cb=test-secret&pay_status=TRADE_SUCCESS&out_trade_no=GAORDER_X';
    const first = await h.request<any>('POST', url);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ code: 0, message: 'success' });
    const sub = await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } });
    expect(sub).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'pass', rail: 'alipay', brand: 'goapply' });
    const end = (sub.currentPeriodEnd as Date).getTime();
    const second = await h.request<any>('POST', url);
    expect(second.status).toBe(200);
    expect(((await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } })).currentPeriodEnd as Date).getTime()).toBe(end);
  });

  it('closes an unpaid order and refuses unknown ones', async () => {
    await seedOrder();
    const closed = await h.request<any>('GET', '/api/v1/roboapply/billing/alipay/callback?cb=test-secret&pay_status=TRADE_CLOSED&out_trade_no=GAORDER_X');
    expect(closed.body.message).toBe('closed');
    expect((await fake.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAORDER_X' } })).status).toBe('closed');
    const unknown = await h.request<any>('GET', '/api/v1/roboapply/billing/alipay/callback?cb=test-secret&pay_status=TRADE_SUCCESS&out_trade_no=NOPE');
    expect(unknown.status).toBe(400);
  });
});
