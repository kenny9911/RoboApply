// @vitest-environment node
//
// The Alipay "do not break" contract, at the HTTP boundary
// (docs/jobright-clone/market/MARKET_STRATEGY.md §5.2, requirement AL-1; D6).
//
// These are CHARACTERISATION tests: they pin what the callback route answers
// today, rule by rule (A1 … A12), so later billing work cannot change the
// wire by accident. They set every former gate explicitly (prices, the
// payments switch, the collecting entity), so they pass with the old gates
// and with the D5 defaults alike. Do not relax an assertion here to make a
// change pass: a failing test in this file means the Alipay contract moved.
//
// The other halves of the contract live beside the code they pin:
//   platform/billing/rails/rails.test.ts   A5, A6 (worker request, secret check)
//   platform/billing/fulfilPass.test.ts    A3, A4, A7, A8, A9, A12
//   services/RoboApplyBillingService.alipay.test.ts  A11, A12 (rail registration)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));
/** A stand-in for the practice-credit grants: `grantForPlan` always grants, the period-guarded one skips a grant already made. */
const credits = vi.hoisted(() => ({ grants: [] as Array<{ userId: string; tier: string; credits?: number; source: string }>, renewedAt: new Map<string, Date>() }));

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
vi.mock('../../lib/mockCreditService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mockCreditService.js')>();
  return {
    ...actual,
    grantForPlan: vi.fn(async (input: { userId: string; tier: string; credits?: number; source: string }) => {
      credits.grants.push({ userId: input.userId, tier: input.tier, credits: input.credits, source: input.source });
      credits.renewedAt.set(input.userId, new Date());
    }),
    grantForPlanIfNewPeriod: vi.fn(async (input: { userId: string; tier: string; credits?: number; source: string; periodStart: Date }) => {
      const last = credits.renewedAt.get(input.userId);
      if (last && last >= input.periodStart) return 'skipped';
      credits.grants.push({ userId: input.userId, tier: input.tier, credits: input.credits, source: input.source });
      credits.renewedAt.set(input.userId, new Date());
      return 'granted';
    }),
  };
});
// The receipt is a PDF; what the contract pins is who may fetch it.
vi.mock('../lib/invoiceReceipt.js', () => ({ renderAlipayReceiptPdf: vi.fn(async () => Buffer.from('%PDF-receipt')) }));

import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import billingRouter from './billing.js';
import { setBillingServiceDepsForTests } from '../services/RoboApplyBillingService.js';
import { createAlipayWorkerRail, getRegisteredRail, registerRail, unregisterRail, type PaymentRailImpl } from '../../platform/billing/index.js';

const SECRET = 'cb+secret&?';
const CB = encodeURIComponent(SECRET);
const CALLBACK = '/api/v1/roboapply/billing/alipay/callback';

// Every former gate is set explicitly so the contract is pinned independently of the gate defaults.
const ENV = {
  CN_PAYMENTS_ENABLED: 'true',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRACTICE_PACK_5_FEN: '2900',
  CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
  ALIPAY_API_URL: '',
  ALIPAY_CALLBACK_SECRET: SECRET,
  CN_ALIPAY_PLATFORM: '',
  STRIPE_SECRET_KEY: '',
  BACKEND_URL: '',
  CN_BACKEND_URL: '',
  CN_CANONICAL_ORIGIN: '',
};

const fetchMock = vi.fn();
let h: RouteHarness;
let builtIn: PaymentRailImpl;

beforeAll(async () => {
  builtIn = createAlipayWorkerRail({ fetch: fetchMock as unknown as typeof fetch });
  registerRail('alipay', builtIn);
  h = await startRouteHarness({ mounts: [['/api/v1/roboapply/billing', billingRouter]] });
});
afterAll(async () => {
  registerRail('alipay', createAlipayWorkerRail());
  await h.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  credits.grants.length = 0;
  credits.renewedAt.clear();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://payments.example.com/pay' } }) });
  for (const t of ['alipayOrder', 'seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'rACreditGrant', 'user', 'seekerProfile']) fake.db[t].deleteMany({});
  fake.db.user.create({ data: { id: 'cn_user', email: 'cn_user@example.test', name: 'CN', brand: 'goapply' } });
  fake.db.user.create({ data: { id: 'cn_other', email: 'cn_other@example.test', name: 'Other', brand: 'goapply' } });
  fake.db.user.create({ data: { id: 'intl_user', email: 'intl_user@example.test', name: 'Intl', brand: 'roboapply' } });
  fake.db.seekerProfile.create({ data: { id: 'sp_cn', userId: 'cn_user', locale: 'zh', deletedAt: null } });
  fake.db.seekerProfile.create({ data: { id: 'sp_other', userId: 'cn_other', locale: 'zh', deletedAt: null } });
  fake.db.seekerProfile.create({ data: { id: 'sp_intl', userId: 'intl_user', locale: 'en', deletedAt: null } });
  setBillingServiceDepsForTests({
    db: fake.db as never,
    getBalance: async () => ({ credits: 0, tier: 'free', periodAllotment: 1, renewedAt: null, currentPeriodEnd: null, ephemeral: false }),
    sendEmail: vi.fn(async () => ({ status: 'sent' as const })),
    invalidate: () => {},
    // The DB-backed order limiter is stood in (the fake database has no raw SQL); it allows everything here.
    consumeRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setBillingServiceDepsForTests();
  if (getRegisteredRail('alipay') !== builtIn) registerRail('alipay', builtIn);
});

const GO = { host: 'goapply.localhost:3621', headers: { 'x-test-user': 'cn_user', 'x-test-brand': 'goapply' } };
const GO_OTHER = { host: 'goapply.localhost:3621', headers: { 'x-test-user': 'cn_other', 'x-test-brand': 'goapply' } };
const RA = { host: 'localhost:3621', headers: { 'x-test-user': 'intl_user' } };

async function seedOrder(over: Record<string, unknown> = {}) {
  return fake.db.alipayOrder.create({
    data: {
      id: 'o_1',
      userId: 'cn_user',
      outTradeNo: 'GAORDER_X',
      tier: 'ra_pro_monthly',
      planKey: 'pro_monthly',
      brand: 'goapply',
      channel: 'alipay',
      amount: 39,
      amountMinor: 3900,
      status: 'pending',
      completedAt: null,
      ...over,
    },
  });
}
const orderRow = (no = 'GAORDER_X') => fake.db.alipayOrder.findUnique({ where: { outTradeNo: no } });
const subOf = (profile = 'sp_cn') => fake.db.seekerSubscription.findUnique({ where: { seekerProfileId: profile } });
const paid = (no = 'GAORDER_X', extra = '') => `${CALLBACK}?cb=${CB}&pay_status=TRADE_SUCCESS&out_trade_no=${no}${extra}`;

describe('Alipay contract A1: the callback route is public and reads query and JSON body', () => {
  it('A1 GET and POST both answer without a session, a CSRF token or a brand host', async () => {
    await seedOrder();
    // No x-test-user header (requireAuth would answer 401), no cookie, no Host of either brand.
    const get = await h.request<any>('GET', paid());
    expect([get.status, get.body]).toEqual([200, { code: 0, message: 'success' }]);
    await seedOrder({ id: 'o_2', outTradeNo: 'GAORDER_Y' });
    const post = await h.request<any>('POST', paid('GAORDER_Y'));
    expect([post.status, post.body]).toEqual([200, { code: 0, message: 'success' }]);
    expect((await orderRow()).status).toBe('completed');
    expect((await orderRow('GAORDER_Y')).status).toBe('completed');
  });

  it('A1 reads every parameter from a JSON body, and mixes query and body', async () => {
    await seedOrder();
    const body = await h.request<any>('POST', CALLBACK, { body: { cb: SECRET, pay_status: 'TRADE_SUCCESS', out_trade_no: 'GAORDER_X', total_amount: 39, trade_no: 'T1' } });
    expect([body.status, body.body.code]).toEqual([200, 0]);
    expect((await orderRow()).status).toBe('completed');

    await seedOrder({ id: 'o_2', outTradeNo: 'GAORDER_Y' });
    const mixed = await h.request<any>('POST', `${CALLBACK}?cb=${CB}`, { body: { pay_status: 'TRADE_SUCCESS', out_trade_no: 'GAORDER_Y', total_amount: '39.00' } });
    expect([mixed.status, mixed.body.code]).toEqual([200, 0]);
    expect((await orderRow('GAORDER_Y')).status).toBe('completed');
  });

  it('A1 no capability flag stands in front of it: a notify still lands on either host with CN payments switched off', async () => {
    vi.stubEnv('CN_PAYMENTS_ENABLED', 'false');
    await seedOrder();
    const onRobo = await h.request<any>('GET', paid(), { host: 'localhost:3621' });
    expect([onRobo.status, onRobo.body.code]).toEqual([200, 0]);
    expect((await orderRow()).status).toBe('completed');
    await seedOrder({ id: 'o_2', outTradeNo: 'GAORDER_Y' });
    const onGo = await h.request<any>('POST', paid('GAORDER_Y'), { host: 'goapply.localhost:3621' });
    expect([onGo.status, onGo.body.code]).toEqual([200, 0]);
  });

  it('A1 app.ts mounts the billing router after express.json, with nothing in front of it', () => {
    const app = readFileSync(fileURLToPath(new URL('../../app.ts', import.meta.url)), 'utf8');
    const json = app.indexOf('app.use(express.json(');
    const mount = app.indexOf("app.use('/api/v1/roboapply/billing', roboapplyBillingRouter);");
    expect(json).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(json);
    // The callback path is not handed to a raw-body parser (the worker sends JSON or a query string).
    expect(app).not.toMatch(/app\.use\(\s*'\/api\/v1\/roboapply\/billing[^']*',\s*express\.raw/);
  });
});

describe('Alipay contract A2: the answers, exactly as given today', () => {
  it('A2 200 { code: 0 } for success, for a closed trade, for a status that needs no action, and for replays', async () => {
    await seedOrder();
    const success = await h.request<any>('GET', paid());
    expect([success.status, success.body]).toEqual([200, { code: 0, message: 'success' }]);
    for (let i = 0; i < 3; i += 1) {
      const replay = await h.request<any>(i % 2 ? 'GET' : 'POST', paid());
      expect([replay.status, replay.body], `replay ${i}`).toEqual([200, { code: 0, message: 'success' }]);
    }

    await seedOrder({ id: 'o_2', outTradeNo: 'GAORDER_C' });
    const closed = await h.request<any>('GET', `${CALLBACK}?cb=${CB}&pay_status=TRADE_CLOSED&out_trade_no=GAORDER_C`);
    expect([closed.status, closed.body]).toEqual([200, { code: 0, message: 'closed' }]);
    expect((await orderRow('GAORDER_C')).status).toBe('closed');

    await seedOrder({ id: 'o_3', outTradeNo: 'GAORDER_W' });
    const waiting = await h.request<any>('GET', `${CALLBACK}?cb=${CB}&pay_status=WAIT_BUYER_PAY&out_trade_no=GAORDER_W`);
    expect([waiting.status, waiting.body]).toEqual([200, { code: 0, message: 'no action' }]);
    expect((await orderRow('GAORDER_W')).status).toBe('pending');
  });

  it('A2 400 / 40001 when pay_status or out_trade_no is missing', async () => {
    for (const q of ['&pay_status=TRADE_SUCCESS', '&out_trade_no=GAORDER_X', '']) {
      const res = await h.request<any>('GET', `${CALLBACK}?cb=${CB}${q}`);
      expect([res.status, res.body.code], q).toEqual([400, 40001]);
    }
  });

  it('A2 400 / 40002 for an unknown order and for a tier without the ra_ prefix', async () => {
    const unknown = await h.request<any>('GET', paid('NOPE'));
    expect([unknown.status, unknown.body.code]).toEqual([400, 40002]);
    await seedOrder({ outTradeNo: 'ORDER_RECRUITER', tier: 'growth', planKey: null, brand: null });
    const recruiter = await h.request<any>('GET', paid('ORDER_RECRUITER'));
    expect([recruiter.status, recruiter.body.code]).toEqual([400, 40002]);
    expect((await orderRow('ORDER_RECRUITER')).status).toBe('pending');
  });

  it('A2 400 / 40004 on an amount mismatch, and the order stays pending', async () => {
    await seedOrder();
    const res = await h.request<any>('GET', paid('GAORDER_X', '&total_amount=1.00'));
    expect([res.status, res.body.code]).toEqual([400, 40004]);
    expect((await orderRow()).status).toBe('pending');
    expect(await subOf()).toBeNull();
    expect(credits.grants).toEqual([]);
  });

  it('A2 400 / 40005 when the order names no pass or pack plan', async () => {
    await seedOrder({ tier: 'ra_pro_weekly', planKey: 'pro_weekly' });
    const res = await h.request<any>('GET', paid());
    expect([res.status, res.body.code]).toEqual([400, 40005]);
    expect((await orderRow()).status).toBe('pending');
  });

  it('A2 403 / 40003 for a wrong or missing secret', async () => {
    await seedOrder();
    for (const q of ['', '&cb=', '&cb=wrong', `&cb=${encodeURIComponent(`${SECRET}x`)}`]) {
      const res = await h.request<any>('GET', `${CALLBACK}?pay_status=TRADE_SUCCESS&out_trade_no=GAORDER_X${q}`);
      expect([res.status, res.body.code], q).toEqual([403, 40003]);
    }
    expect((await orderRow()).status).toBe('pending');
  });

  it('A2 503 / 50003 when no callback secret is configured, and when the rail is not registered', async () => {
    await seedOrder();
    vi.stubEnv('ALIPAY_CALLBACK_SECRET', '');
    for (const q of ['', '&cb=', `&cb=${CB}`]) {
      const res = await h.request<any>('GET', `${CALLBACK}?pay_status=TRADE_SUCCESS&out_trade_no=GAORDER_X${q}`);
      expect([res.status, res.body.code], q).toEqual([503, 50003]);
    }
    vi.stubEnv('ALIPAY_CALLBACK_SECRET', SECRET);
    unregisterRail('alipay');
    const noRail = await h.request<any>('GET', paid());
    expect([noRail.status, noRail.body.code]).toEqual([503, 50003]);
    expect((await orderRow()).status).toBe('pending');
  });

  it('A2 500 / 50001 when handling throws', async () => {
    await seedOrder();
    vi.spyOn(fake.db.alipayOrder, 'findUnique').mockRejectedValueOnce(new Error('db down'));
    const res = await h.request<any>('GET', paid());
    expect([res.status, res.body]).toEqual([500, { code: 50001, message: 'internal error' }]);
  });
});

describe('Alipay contract A3: outTradeNo is the only lookup key; the tier keeps its ra_ prefix', () => {
  it('A3 a checkout writes tier "ra_<planKey>" under a unique outTradeNo', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    expect(res.status).toBe(200);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(res.body.data.orderId).toBe(payload.out_trade_no);
    const row = await orderRow(payload.out_trade_no);
    expect(row).toMatchObject({ tier: 'ra_pro_monthly', planKey: 'pro_monthly', userId: 'cn_user' });
    // The table refuses a second row with the same order number.
    let duplicate: unknown = null;
    try {
      await fake.db.alipayOrder.create({ data: { id: 'dup', userId: 'cn_other', outTradeNo: payload.out_trade_no, tier: 'ra_pro_monthly', amount: 39, status: 'pending' } });
    } catch (err) {
      duplicate = err;
    }
    expect(duplicate).not.toBeNull();
  });

  it('A3 the callback finds the order by out_trade_no alone: other parameters never pick the order or the buyer', async () => {
    await seedOrder();
    await seedOrder({ id: 'o_2', outTradeNo: 'GAORDER_B', userId: 'cn_other' });
    // Names the other buyer and the other order's id everywhere but in out_trade_no.
    const res = await h.request<any>('POST', paid('GAORDER_B', '&user_id=cn_user&order_id=o_1&trade_no=GAORDER_X'), { body: { user_id: 'cn_user', id: 'o_1' } });
    expect([res.status, res.body.code]).toEqual([200, 0]);
    expect((await orderRow('GAORDER_B')).status).toBe('completed');
    expect((await orderRow('GAORDER_X')).status).toBe('pending');
    expect(await subOf('sp_other')).toMatchObject({ tier: 'pro', planKey: 'pro_monthly' });
    expect(await subOf('sp_cn')).toBeNull();
  });
});

describe('Alipay contract A4: one order activates once and grants once', () => {
  it('A4 under replay', async () => {
    await seedOrder();
    for (let i = 0; i < 4; i += 1) expect((await h.request<any>('POST', paid())).status).toBe(200);
    const sub = await subOf();
    // 30 days from the one activation, not 120.
    const days = ((sub.currentPeriodEnd as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(credits.grants).toEqual([{ userId: 'cn_user', tier: 'pro', credits: 3, source: 'alipay' }]);
  });

  it('A4 under two concurrent notifies', async () => {
    await seedOrder();
    const [a, b] = await Promise.all([h.request<any>('POST', paid()), h.request<any>('GET', paid())]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.code, b.body.code]).toEqual([0, 0]);
    const sub = await subOf();
    const days = ((sub.currentPeriodEnd as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(credits.grants).toHaveLength(1);
  });
});

describe('Alipay contract A6: a wrong cb is refused before any database access', () => {
  it('A6 no table is read or written for a callback with a wrong or missing secret', async () => {
    await seedOrder();
    const touched: string[] = [];
    for (const table of ['alipayOrder', 'seekerSubscription', 'seekerProfile', 'user', 'rACreditLedger', 'rACreditGrant']) {
      for (const op of ['findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
        if (typeof fake.db[table][op] !== 'function') continue;
        const original = fake.db[table][op].bind(fake.db[table]);
        vi.spyOn(fake.db[table], op).mockImplementation((...args: unknown[]) => {
          touched.push(`${table}.${op}`);
          return original(...args);
        });
      }
    }
    for (const q of ['', '&cb=wrong', `&cb=${encodeURIComponent(SECRET.slice(0, -1))}`]) {
      const res = await h.request<any>('POST', `${CALLBACK}?pay_status=TRADE_SUCCESS&out_trade_no=GAORDER_X${q}`, { body: { cb: 'also-wrong' } });
      expect(res.status, q).toBe(403);
    }
    expect(touched).toEqual([]);
    // The same request with the secret does reach the table (the spies see it).
    expect((await h.request<any>('POST', paid())).status).toBe(200);
    expect(touched).toContain('alipayOrder.findUnique');
  });
});

describe('Alipay contract A8: AlipayOrder columns keep their meaning', () => {
  it('A8 tier, amount, status and completedAt through the life of an order', async () => {
    const res = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...GO, body: { planKey: 'pro_monthly' } });
    const no = res.body.data.orderId as string;
    const pending = await orderRow(no);
    // tier: 'ra_' + plan key. amount: whole yuan as a number. status: pending. completedAt: unset.
    expect(pending).toMatchObject({ tier: 'ra_pro_monthly', amount: 39, status: 'pending', channel: 'alipay' });
    expect(pending.completedAt ?? null).toBeNull();

    const before = Date.now();
    await h.request<any>('GET', paid(no, '&total_amount=39.00'));
    const done = await orderRow(no);
    expect(done).toMatchObject({ tier: 'ra_pro_monthly', amount: 39, status: 'completed' });
    expect(done.completedAt).toBeInstanceOf(Date);
    expect((done.completedAt as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);

    // A closed trade: status 'closed', never a completion time.
    await seedOrder({ id: 'o_c', outTradeNo: 'GAORDER_C' });
    await h.request<any>('GET', `${CALLBACK}?cb=${CB}&pay_status=TRADE_CLOSED&out_trade_no=GAORDER_C`);
    const closed = await orderRow('GAORDER_C');
    expect(closed).toMatchObject({ tier: 'ra_pro_monthly', amount: 39, status: 'closed' });
    expect(closed.completedAt ?? null).toBeNull();
  });
});

describe('Alipay contract A10: completed ra_ orders stay in billing history, for their owner only', () => {
  const completedAt = new Date('2026-09-01T08:00:00.000Z');

  beforeEach(async () => {
    await seedOrder({ id: 'o_done', outTradeNo: 'GAORDER_DONE', status: 'completed', completedAt });
    await seedOrder({ id: 'o_legacy', outTradeNo: 'RAORDER_OLD', tier: 'ra_starter', planKey: null, brand: null, amount: 19, amountMinor: null, status: 'completed', completedAt: new Date('2026-08-01T08:00:00.000Z') });
    await seedOrder({ id: 'o_pending', outTradeNo: 'GAORDER_PENDING' });
    await seedOrder({ id: 'o_recruiter', outTradeNo: 'ORDER_RH', tier: 'growth', planKey: null, brand: null, status: 'completed', completedAt });
    await seedOrder({ id: 'o_theirs', outTradeNo: 'GAORDER_THEIRS', userId: 'cn_other', status: 'completed', completedAt });
  });

  it('A10 GET /history lists every completed ra_ order of the caller, newest first, and nothing else', async () => {
    const res = await h.request<any>('GET', '/api/v1/roboapply/billing/history', GO);
    expect(res.status).toBe(200);
    expect(res.body.data.invoices).toEqual([
      { id: 'o_done', kind: 'alipay', date: completedAt.toISOString(), amountMinor: 3900, currency: 'CNY', status: 'paid', description: 'GoApply 会员月卡 (Alipay)', downloadable: true },
      { id: 'o_legacy', kind: 'alipay', date: '2026-08-01T08:00:00.000Z', amountMinor: 1900, currency: 'CNY', status: 'paid', description: 'RoboApply Practice plan (legacy) (Alipay)', downloadable: true },
    ]);
    const theirs = await h.request<any>('GET', '/api/v1/roboapply/billing/history', GO_OTHER);
    expect(theirs.body.data.invoices.map((i: { id: string }) => i.id)).toEqual(['o_theirs']);
    expect((await h.request<any>('GET', '/api/v1/roboapply/billing/history')).status).toBe(401);
  });

  it('A10 the receipt downloads for its owner and is "not found" for anyone else, for recruiter orders and without a session', async () => {
    const own = await h.request<any>('GET', '/api/v1/roboapply/billing/invoices/o_done/download', GO);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toContain('application/pdf');
    expect(own.headers.get('content-disposition')).toContain('goapply-receipt-GAORDER_DONE.pdf');

    const other = await h.request<any>('GET', '/api/v1/roboapply/billing/invoices/o_done/download', GO_OTHER);
    expect([other.status, other.body.code]).toEqual([404, 'not_found']);
    const recruiter = await h.request<any>('GET', '/api/v1/roboapply/billing/invoices/o_recruiter/download', GO);
    expect([recruiter.status, recruiter.body.code]).toEqual([404, 'not_found']);
    expect((await h.request<any>('GET', '/api/v1/roboapply/billing/invoices/o_done/download')).status).toBe(401);
  });
});

describe('Alipay contract A11: Stripe never serves GoApply', () => {
  it('A11 a GoApply checkout that asks for Stripe is refused, and RoboApply cannot open a new Alipay order', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    const stripe = await h.request<any>('POST', '/api/v1/roboapply/billing/checkout', { ...GO, body: { planKey: 'pro_monthly', rail: 'stripe' } });
    expect([stripe.status, stripe.body.code]).toEqual([409, 'rail_not_allowed']);
    const alipay = await h.request<any>('POST', '/api/v1/roboapply/billing/alipay', { ...RA, body: { planKey: 'pro_monthly' } });
    expect(alipay.status).toBe(409);
    expect(['rail_not_allowed', 'plan_not_sellable']).toContain(alipay.body.code);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fake.db.alipayOrder.findMany({})).toEqual([]);
  });
});
