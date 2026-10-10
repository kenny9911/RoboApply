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
import { availableRails, createAlipayWorkerRail, getRegisteredRail, registerRail, registeredRailIds, resolveRail, unregisterRail, type CheckoutOrder, type PaymentRailImpl } from '../../platform/billing/index.js';
import { ensureWechatPayRail } from '../../platform/billing/rails/wechatpay.js';
import { getBrand } from '../../platform/brand/registry.js';
import { BillingCnService, cnPayTermsStatement } from '../../features/billing-cn/service.js';
import { CN_PAY_TERMS_CONSENT_TYPE } from '../../features/billing-cn/contract.js';
import { rateLimitKey } from '../../platform/ratelimit/index.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// What a GoApply deployment needs to sell through Alipay: the rail's callback
// secret, nothing else (D5, D6). Prices are the catalog defaults; there is no
// master switch, no worker URL and no collecting entity to set. The other
// names are blanked so a developer's own environment cannot leak in.
const ENV_KEYS = {
  ALIPAY_CALLBACK_SECRET: 'test-secret',
  CN_PAYMENTS_ENABLED: '',
  CN_PAYMENT_COLLECTING_ENTITY: '',
  CN_PAYMENT_REQUIRE_ENTITY: '',
  CN_PRICE_PRO_MONTHLY_FEN: '',
  CN_PRICE_PRO_WEEK_PASS_FEN: '',
  ALIPAY_API_URL: '',
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
    // The DB-backed limiter is stood in (the fake database has no raw SQL); it allows everything here.
    consumeRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
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

  it('with the callback secret alone: a 月卡 checkout creates one AlipayOrder at the catalog price and answers the pay URL', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'redirect', url: 'https://payments.example.com/pay', rail: 'alipay' });
    // The default worker endpoint: ALIPAY_API_URL is not required.
    expect(fetchMock.mock.calls[0][0]).toBe('https://worker.gohire.top/payment/payment/create');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ total_amount: 39, subject: 'GoApply 会员月卡', body: 'GoApply 会员月卡', pay_channel: 'alipay' });
    expect(payload.notify_url).toBe('https://www.goapply.top/api/v1/roboapply/billing/alipay/callback?cb=test-secret');
    expect(res.body.data.orderId).toBe(payload.out_trade_no);
    const orders = await fake.db.alipayOrder.findMany({});
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ outTradeNo: payload.out_trade_no, userId: 'cn_user', tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', amount: 39, amountMinor: 3900, status: 'pending', channel: 'alipay' });
  });

  it('that order is fulfilled exactly once by a callback that carries the secret, and refused without it', async () => {
    const checkout = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    const no = checkout.body.data.orderId as string;
    const base = `/api/v1/roboapply/billing/alipay/callback?pay_status=TRADE_SUCCESS&out_trade_no=${no}&total_amount=39.00`;

    const noSecret = await h.request<any>('POST', base);
    expect([noSecret.status, noSecret.body.code]).toEqual([403, 40003]);
    const wrongSecret = await h.request<any>('POST', `${base}&cb=guess`);
    expect([wrongSecret.status, wrongSecret.body.code]).toEqual([403, 40003]);
    expect((await fake.db.alipayOrder.findUnique({ where: { outTradeNo: no } })).status).toBe('pending');
    expect(await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } })).toBeNull();

    // The notify URL the worker was given, as the worker would call it.
    const notify = new URL(JSON.parse(fetchMock.mock.calls[0][1].body).notify_url);
    const first = await h.request<any>('POST', `${base}&cb=${encodeURIComponent(notify.searchParams.get('cb')!)}`);
    expect([first.status, first.body]).toEqual([200, { code: 0, message: 'success' }]);
    const sub = await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } });
    expect(sub).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'pass', rail: 'alipay', brand: 'goapply', currency: 'CNY', amountMinor: 3900 });
    const end = (sub.currentPeriodEnd as Date).getTime();
    expect(Math.round((end - Date.now()) / 86_400_000)).toBe(30);
    for (let i = 0; i < 2; i += 1) {
      const replay = await h.request<any>('GET', `${base}&cb=test-secret`);
      expect([replay.status, replay.body.code]).toEqual([200, 0]);
    }
    expect(((await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } })).currentPeriodEnd as Date).getTime()).toBe(end);
    expect((await fake.db.alipayOrder.findMany({ where: { status: 'completed' } })).map((o: { outTradeNo: string }) => o.outTradeNo)).toEqual([no]);
  });

  it('without the callback secret: checkout answers 503 rail_not_configured and no order exists', async () => {
    vi.stubEnv('ALIPAY_CALLBACK_SECRET', '');
    for (const path of ['/api/v1/roboapply/billing/checkout', '/api/v1/roboapply/billing/alipay']) {
      const res = await h.request<any>('POST', path, { ...GO, body: { planKey: 'pro_monthly' } });
      expect([res.status, res.body.code], path).toEqual([503, 'rail_not_configured']);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fake.db.alipayOrder.findMany({})).toEqual([]);
    // The plans and their prices are still listed (GET /billing/plan carries the catalog).
    const plan = await h.request<any>('GET', '/api/v1/roboapply/billing/plan', GO);
    expect(plan.status).toBe(200);
    expect(plan.body.data.rails).toEqual([]);
    expect(plan.body.data.alipayConfigured).toBe(false);
    const paid = plan.body.data.catalog.filter((p: { kind: string }) => p.kind !== 'free');
    expect(paid.map((p: { key: string; amountMinor: number }) => [p.key, p.amountMinor])).toEqual([
      ['pro_week_pass', 1200],
      ['pro_monthly', 3900],
      ['pro_quarterly', 9900],
      ['practice_pack_5', 2900],
      ['practice_pack_15', 7900],
    ]);
  });

  it('with the secret, GET /billing/plan lists Alipay as the rail that can charge', async () => {
    const plan = await h.request<any>('GET', '/api/v1/roboapply/billing/plan', GO);
    expect(plan.body.data).toMatchObject({ brand: 'goapply', rails: ['alipay'], alipayConfigured: true, stripeConfigured: false, defaultSelection: 'pro_monthly' });
  });

  it('the kill switch (CN_PAYMENTS_ENABLED=false) closes checkout: 409 plan_not_sellable, nothing sent to the worker', async () => {
    vi.stubEnv('CN_PAYMENTS_ENABLED', 'false');
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('plan_not_sellable');
    expect(res.body.details).toMatchObject({ reason: 'payments_disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the entity hard gate (CN_PAYMENT_REQUIRE_ENTITY=true) refuses until the entity is named, then prints it', async () => {
    vi.stubEnv('CN_PAYMENT_REQUIRE_ENTITY', 'true');
    const refused = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    expect([refused.status, refused.body.code]).toEqual([503, 'rail_not_configured']);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('CN_PAYMENT_COLLECTING_ENTITY', 'Example Collecting Co.');
    const ok = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).body).toBe('GoApply 会员月卡 · Example Collecting Co.');
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

describe('a new Alipay order is limited per user (the limit WeChat Pay orders have)', () => {
  /** A counting limiter with the real windows' first limit. */
  function limiterOf(limit: number) {
    const hits = new Map<string, number>();
    const calls: Array<{ key: string; windows: ReadonlyArray<{ limit: number; windowSec: number }> }> = [];
    const consume = async (key: string, windows: ReadonlyArray<{ limit: number; windowSec: number }>) => {
      calls.push({ key, windows });
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { allowed: n <= limit, retryAfterSec: n <= limit ? 0 : 37 };
    };
    return { calls, consume };
  }
  const useLimiter = (consumeRateLimit: (key: string, windows: ReadonlyArray<{ limit: number; windowSec: number }>) => Promise<{ allowed: boolean; retryAfterSec: number }>) =>
    setBillingServiceDepsForTests({
      db: fake.db as never,
      grantIfNewPeriod,
      getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
      sendEmail: vi.fn(async () => ({ status: 'sent' as const })),
      invalidate: () => {},
      consumeRateLimit,
    });

  it('the order after the limit answers 429 rate_limited with Retry-After: no worker call, no order row, no acknowledgement', async () => {
    const limiter = limiterOf(10);
    useLimiter(limiter.consume);
    for (let i = 0; i < 10; i += 1) {
      const ok = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
      expect(ok.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(await fake.db.alipayOrder.findMany({})).toHaveLength(10);
    const consentsBefore = (await fake.db.seekerConsentRecord.findMany({})).length;

    for (const path of ['/api/v1/roboapply/billing/alipay', '/api/v1/roboapply/billing/checkout']) {
      const res = await h.request<any>('POST', path, { ...GO, body: { planKey: 'pro_monthly' } });
      expect([res.status, res.body.code]).toEqual([429, 'rate_limited']);
      expect(res.body.details).toEqual({ retryAfterSec: 37 });
      expect(res.headers.get('retry-after')).toBe('37');
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(await fake.db.alipayOrder.findMany({})).toHaveLength(10);
    expect(await fake.db.seekerConsentRecord.findMany({})).toHaveLength(consentsBefore);

    // One budget per user and brand, on the windows WeChat Pay orders use: 10 a minute, 60 a day.
    expect(new Set(limiter.calls.map((c) => c.key))).toEqual(new Set([rateLimitKey('billingCnCreate', 'user', 'cn_user', 'goapply')]));
    expect(limiter.calls[0]!.windows).toEqual([
      { limit: 10, windowSec: 60 },
      { limit: 60, windowSec: 86_400 },
    ]);
  });

  it('a request that is refused for another reason does not reach the limiter, and RoboApply checkout is never counted', async () => {
    const limiter = limiterOf(10);
    useLimiter(limiter.consume);
    const unknownPlan = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_weekly' } });
    expect(unknownPlan.status).toBe(409);
    const robo = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...RA, body: { planKey: 'pro_monthly' } });
    expect(robo.status).toBe(409);
    expect(limiter.calls).toEqual([]);
  });

  it('fails open: a limiter that cannot answer never blocks an Alipay payment', async () => {
    useLimiter(async () => {
      throw new Error('rate counter table unreachable');
    });
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'redirect', rail: 'alipay' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fake.db.alipayOrder.findMany({})).toHaveLength(1);
  });
});

describe('GoApply student passes through Alipay (学生月卡 ¥29, 学生季卡 ¥69)', () => {
  const student = { enabled: true, verified: false };
  beforeEach(() => {
    student.enabled = true;
    student.verified = false;
    setBillingServiceDepsForTests({
      db: fake.db as never,
      grantIfNewPeriod,
      getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
      sendEmail: vi.fn(async () => ({ status: 'sent' as const })),
      invalidate: () => {},
      studentEnabled: async () => student.enabled,
      isStudentVerified: async () => student.verified,
      consumeRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
    });
  });

  it('a buyer who is not a verified student is refused before anything is sent or stored', async () => {
    for (const planKey of ['student_monthly', 'student_quarterly']) {
      const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey } });
      expect([res.status, res.body.code], planKey).toEqual([409, 'student_verification_required']);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fake.db.alipayOrder.findMany({})).toEqual([]);
  });

  it('with the student capability off the passes are not on sale, even for a verified student', async () => {
    student.enabled = false;
    student.verified = true;
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'student_monthly' } });
    expect([res.status, res.body.code]).toEqual([409, 'plan_not_sellable']);
    expect(res.body.details).toMatchObject({ reason: 'student_off' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['student_monthly', 29, 30, '学生月卡'],
    ['student_quarterly', 69, 90, '学生季卡'],
  ] as const)('a verified student buys %s for ¥%i and the paid order activates %i days', async (planKey, yuan, days, label) => {
    student.verified = true;
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'redirect', rail: 'alipay' });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ total_amount: yuan, subject: `GoApply ${label}`, package_data: { package_id: planKey, package_name: planKey, package_type: '1', package_price: String(yuan) } });
    const no = payload.out_trade_no as string;
    expect(await fake.db.alipayOrder.findUnique({ where: { outTradeNo: no } })).toMatchObject({ tier: `ra_${planKey}`, planKey, brand: 'goapply', amount: yuan, amountMinor: yuan * 100, status: 'pending', purpose: 'subscription' });

    const paid = await h.request<any>('POST', `/api/v1/roboapply/billing/alipay/callback?cb=test-secret&pay_status=TRADE_SUCCESS&out_trade_no=${no}&total_amount=${yuan}.00`);
    expect([paid.status, paid.body]).toEqual([200, { code: 0, message: 'success' }]);
    const sub = await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } });
    expect(sub).toMatchObject({ tier: 'pro', planKey, interval: 'pass', rail: 'alipay', brand: 'goapply', currency: 'CNY', amountMinor: yuan * 100 });
    expect(Math.round(((sub.currentPeriodEnd as Date).getTime() - Date.now()) / 86_400_000)).toBe(days);
    // A replay does not add another period.
    const end = (sub.currentPeriodEnd as Date).getTime();
    await h.request<any>('POST', `/api/v1/roboapply/billing/alipay/callback?cb=test-secret&pay_status=TRADE_SUCCESS&out_trade_no=${no}`);
    expect(((await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } })).currentPeriodEnd as Date).getTime()).toBe(end);
  });

  it('a callback that pays the regular price for a student order is refused (40004) and the order stays pending', async () => {
    student.verified = true;
    await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'student_monthly' } });
    const no = JSON.parse(fetchMock.mock.calls[0][1].body).out_trade_no as string;
    const res = await h.request<any>('POST', `/api/v1/roboapply/billing/alipay/callback?cb=test-secret&pay_status=TRADE_SUCCESS&out_trade_no=${no}&total_amount=39.00`);
    expect([res.status, res.body.code]).toEqual([400, 40004]);
    expect((await fake.db.alipayOrder.findUnique({ where: { outTradeNo: no } })).status).toBe('pending');
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
    // WeChat Pay keeps its entity check: the collecting entity must be named and match the merchant.
    CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
    // The published 用户协议 version (what GET /public/legal/terms answers on GoApply).
    CN_LEGAL_DOCS_VERSION: 'cn-terms-2026-10',
    // Join J5: the gate asks compliance for the PUBLISHED version; the repository's own
    // document is still a draft, so the tests read a published fixture.
    LEGAL_CONTENT_DIR: fileURLToPath(new URL('../../features/billing-cn/__tests__/fixtures/legal', import.meta.url)),
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
      // The Alipay order limit (the WeChat Pay path counts through the gate above).
      consumeRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
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
    // The wait is in the header too, for clients that read only that.
    expect(res.headers.get('retry-after')).toBe('42');
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

  it('the kill switch (CN_PAYMENTS_ENABLED=false): no order reaches the rail on any trade type', async () => {
    vi.stubEnv('CN_PAYMENTS_ENABLED', 'false');
    for (const tradeType of ['native', 'h5', 'jsapi']) {
      const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly', rail: 'wechatpay', tradeType, termsVersion: TERMS } });
      expect(res.status, tradeType).toBe(409);
      expect(res.body.code).toBe('plan_not_sellable');
    }
    expect(orders).toHaveLength(0);
    expect(await consents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CN_PAYMENTS_ENABLED unset is not a gate: a WeChat Pay order goes through', async () => {
    vi.stubEnv('CN_PAYMENTS_ENABLED', '');
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly', rail: 'wechatpay', tradeType: 'native', termsVersion: TERMS } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'qr', rail: 'wechatpay' });
    expect(orders).toHaveLength(1);
  });

  it('a purchase that names no rail goes to Alipay even with WeChat Pay ready (Alipay first)', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kind: 'redirect', rail: 'alipay' });
    expect(orders).toHaveLength(0);
    // No agreement record: that gate belongs to WeChat Pay orders.
    expect(await consents()).toEqual([]);
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

// ── The Alipay "do not break" contract (MARKET_STRATEGY.md §5.2; AL-1; D6) ──
// Characterisation tests; the rest of the contract is pinned in
// routes/billing.test.ts, platform/billing/rails/rails.test.ts and
// platform/billing/fulfilPass.test.ts.
describe('Alipay contract A11 and A12: the rails stay apart', () => {
  let wechatBefore: PaymentRailImpl | null = null;
  beforeEach(() => {
    wechatBefore = getRegisteredRail('wechatpay');
    // A frozen contract test must not move when a gate default moves: every
    // value that has ever gated a GoApply checkout is set explicitly here (as
    // routes/billing.test.ts does), so these pass on any gate default.
    vi.stubEnv('CN_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('CN_PRICE_PRO_MONTHLY_FEN', '3900');
    vi.stubEnv('CN_PAYMENT_COLLECTING_ENTITY', 'Example Collecting Co.');
  });
  afterEach(() => {
    if (wechatBefore) registerRail('wechatpay', wechatBefore);
    else unregisterRail('wechatpay');
  });

  it('A11 Stripe is not one of GoApply\'s rails, with or without a Stripe key, and the Stripe webhook guard names the brand', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const go = getBrand('goapply');
    expect(go.paymentRails).not.toContain('stripe');
    expect(availableRails(go)).not.toContain('stripe');
    expect(() => resolveRail(go, 'stripe')).toThrow(expect.objectContaining({ code: 'rail_not_allowed' }));
    for (const path of ['/api/v1/roboapply/billing/checkout', '/api/v1/roboapply/billing/alipay']) {
      const res = await h.request<any>('POST', path, { ...GO, body: { planKey: 'pro_monthly', rail: 'stripe' } });
      // /billing/alipay forces the Alipay rail whatever the body says; /checkout refuses Stripe.
      if (path.endsWith('/alipay')) expect(res.body.data).toMatchObject({ rail: 'alipay' });
      else expect([res.status, res.body.code]).toEqual([409, 'rail_not_allowed']);
    }
    // (The webhook half of A11 is 'A11 never activates anything for a GoApply-branded Stripe session'
    // in platform/billing/integration/RoboApplyBillingService.stripe.test.ts.)
  });

  it('A12 registering WeChat Pay does not replace, wrap or reorder the Alipay rail', () => {
    const alipay = getRegisteredRail('alipay');
    expect(alipay?.id).toBe('alipay');
    expect(typeof alipay?.verifyCallback).toBe('function');
    unregisterRail('wechatpay');
    // What features/billing-cn/routes.ts does on import.
    const wechat = ensureWechatPayRail();
    expect(wechat.id).toBe('wechatpay');
    expect(getRegisteredRail('alipay')).toBe(alipay);
    expect(registeredRailIds()).toEqual(expect.arrayContaining(['stripe', 'alipay', 'wechatpay']));
    // The brand lists Alipay before WeChat Pay, so Alipay is the rail a purchase gets when none is named.
    expect(getBrand('goapply').paymentRails).toEqual(['alipay', 'wechatpay']);
    expect(resolveRail(getBrand('goapply'), null).id).toBe('alipay');
  });

  it('A12 an Alipay notify fulfils the same way with the WeChat Pay rail registered', async () => {
    unregisterRail('wechatpay');
    ensureWechatPayRail();
    await fake.db.alipayOrder.create({
      data: { id: 'o_12', userId: 'cn_user', outTradeNo: 'GAORDER_12', tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', channel: 'alipay', amount: 39, amountMinor: 3900, status: 'pending' },
    });
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay/callback?cb=test-secret&pay_status=TRADE_SUCCESS&out_trade_no=GAORDER_12&total_amount=39.00');
    expect([res.status, res.body]).toEqual([200, { code: 0, message: 'success' }]);
    expect(await fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_cn' } })).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'pass', rail: 'alipay', brand: 'goapply' });
  });
});
