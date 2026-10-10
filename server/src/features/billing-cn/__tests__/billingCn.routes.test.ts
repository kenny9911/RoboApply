// @vitest-environment node
//
// WP-62 acceptance — the billing-cn routes end to end (no network, no DB:
// fetch is a stub, Prisma is the in-memory fake):
//   - POST /billing-cn/wechatpay: Native / H5 / JSAPI by context; hidden unless
//     CN_PAYMENTS_ENABLED + pay.wechatpay; 503 until the collecting entity
//     matches the merchant; no coaching purpose; openid only from sign-in;
//   - GET /orders/:id: the buyer's own order; an active query completes a paid
//     order whose notify was lost, and closes an expired one;
//   - POST /api/v1/webhooks/wechatpay: the signed fixture on the RAW body
//     fulfils through fulfilPass(); a duplicate notify is a no-op; a tampered
//     or parsed body is refused.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createBrandContext } from '../../../platform/brand/brandContext.js';
import { getBrand } from '../../../platform/brand/registry.js';
import { setFlagOverrideLoader } from '../../../platform/flags.js';
import { fulfilPass, type FulfilDb } from '../../../platform/billing/fulfilPass.js';
import { createWechatPayRail } from '../../../platform/billing/rails/wechatpay.js';
import { fakeAuth } from '../../../test/routeHarness.js';
import { createWechatPayNotifyRouter, createWechatPayRouter } from '../routes.js';
import { BillingCnService, type BillingCnDb } from '../service.js';
import { ENTITY, GA_ENV, GA_ENV_VECTOR, memoryRateLimit, seedDb, wechatFetch, type RecordedCall } from './helpers.js';
import { NOTIFY_BODY, NOTIFY_SIGNED_AT_SEC, NOTIFY_TRANSACTION, NOTIFY_VECTOR } from './wechatpayVectors.js';

const GOAPPLY = 'goapply.localhost:3621';
const ROBOAPPLY = 'localhost:3621';
const DAY = 86_400_000;

interface World {
  db: ReturnType<typeof seedDb>;
  calls: RecordedCall[];
  grants: { plan: ReturnType<typeof vi.fn>; pack: ReturnType<typeof vi.fn>; notice: ReturnType<typeof vi.fn> };
  base: string;
  close: () => Promise<void>;
  setNow: (d: Date) => void;
  respond: { fn: (c: RecordedCall) => [number, unknown] };
}

async function world(opts: { env?: Record<string, string>; now?: Date; user?: { id: string } | null; seed?: Record<string, Record<string, unknown>[]> } = {}): Promise<World> {
  const env = opts.env ?? GA_ENV;
  let now = opts.now ?? new Date('2026-10-10T08:00:00.000Z');
  const db = seedDb(opts.seed);
  const respond = { fn: (_c: RecordedCall): [number, unknown] => [200, { code_url: 'weixin://wxpay/bizpayurl?pr=abc' }] };
  const f = wechatFetch((c) => respond.fn(c), { nowSec: () => Math.floor(now.getTime() / 1000) });
  const getDb = async () => db as unknown as BillingCnDb;
  const grants = { plan: vi.fn(async () => undefined), pack: vi.fn(async () => ({ status: 'granted' })), notice: vi.fn(async () => ({ delivered: true })) };
  const limiter = memoryRateLimit(() => now);
  const service = new BillingCnService({
    env,
    getDb,
    now: () => now,
    consumeRateLimit: limiter.consume,
    rail: createWechatPayRail({ env, fetch: f.fetch, getDb, now: () => now }),
    fulfil: (o) =>
      fulfilPass(o, {
        getDb: async () => db as unknown as FulfilDb,
        now: () => now,
        grantPlan: grants.plan,
        grantPlanIfNewPeriod: vi.fn(async () => 'skipped'),
        grantPack: grants.pack,
        invalidate: () => {},
        notifyPaid: grants.notice,
      }),
  });
  const user = opts.user === undefined ? { id: 'u_1', email: 'u1@example.test', role: 'seeker' } : opts.user;

  const app = express();
  app.set('trust proxy', true);
  app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json());
  app.use(createBrandContext({ env }));
  app.use('/api/v1/roboapply/billing-cn/wechatpay', createWechatPayRouter({ env, service, seekerAuth: [fakeAuth(user)] }));
  app.use('/api/v1/webhooks/wechatpay', createWechatPayNotifyRouter({ env, service }));
  // Same mount, but behind a JSON parser that ran first (the mount-order bug).
  const parsedApp = express();
  parsedApp.use(express.json());
  parsedApp.use(createBrandContext({ env }));
  parsedApp.use('/api/v1/webhooks/wechatpay', createWechatPayNotifyRouter({ env, service }));
  app.use('/parsed', parsedApp);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    db,
    calls: f.calls,
    grants,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    setNow: (d) => {
      now = d;
    },
    respond,
  };
}

async function req(w: World, method: string, path: string, init: { body?: unknown; raw?: string; host?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-host': init.host ?? GOAPPLY, ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.raw !== undefined) {
    body = init.raw;
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${w.base}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

const ORDER_PATH = '/api/v1/roboapply/billing-cn/wechatpay';
const NOTIFY_PATH = '/api/v1/webhooks/wechatpay';
const buy = (over: Record<string, unknown> = {}) => ({ planKey: 'pro_monthly', tradeType: 'native', termsVersion: 'cn-terms-2026-10', ...over });

beforeAll(() => setFlagOverrideLoader(async () => []));
afterAll(() => setFlagOverrideLoader(null));

describe('POST /billing-cn/wechatpay', () => {
  let w: World;
  beforeEach(async () => {
    w?.close && (await w.close());
    w = await world({ seed: { rAAuthIdentity: [{ id: 'i_1', userId: 'u_1', brand: 'goapply', provider: 'wechat', appId: 'wxtestappid000001', subject: 'oFromSignIn', lastUsedAt: new Date() }] } });
  });
  afterAll(async () => w?.close());

  it('Native QR: order created, collecting entity and amount returned', async () => {
    const res = await req(w, 'POST', ORDER_PATH, { body: buy() });
    expect(res.status).toBe(200);
    expect(res.body!.data).toMatchObject({
      tradeType: 'native',
      codeUrl: 'weixin://wxpay/bizpayurl?pr=abc',
      collectingEntity: ENTITY,
      amountMinor: 3900,
      currency: 'CNY',
      planKey: 'pro_monthly',
    });
    const rows = await w.db.alipayOrder.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'wechatpay', purpose: 'subscription', status: 'pending', userId: 'u_1' });
    // The agreement the buyer ticked is on the order row itself.
    expect(rows[0]!.termsVersion).toBe('cn-terms-2026-10');
  });

  it('every trade type writes the ticked 用户协议 version on its order row', async () => {
    w.respond.fn = (c) =>
      c.url.endsWith('/h5') ? [200, { h5_url: 'https://wx.tenpay.com/checkmweb?prepay_id=1' }] : c.url.endsWith('/jsapi') ? [200, { prepay_id: 'wx_prepay_1' }] : [200, { code_url: 'weixin://wxpay/bizpayurl?pr=abc' }];
    for (const tradeType of ['native', 'h5', 'jsapi']) {
      expect((await req(w, 'POST', ORDER_PATH, { body: buy({ tradeType }), headers: { 'x-forwarded-for': '203.0.113.7' } })).status, tradeType).toBe(200);
    }
    const rows = await w.db.alipayOrder.findMany({});
    expect(rows.map((r) => [r.tradeType, r.termsVersion])).toEqual([
      ['NATIVE', 'cn-terms-2026-10'],
      ['H5', 'cn-terms-2026-10'],
      ['JSAPI', 'cn-terms-2026-10'],
    ]);
  });

  it('JSAPI uses the openid from WeChat sign-in, never the one the client sends', async () => {
    w.respond.fn = () => [200, { prepay_id: 'wx_prepay_1' }];
    const res = await req(w, 'POST', ORDER_PATH, { body: buy({ tradeType: 'jsapi', openId: 'oSomebodyElse' }) });
    expect(res.status).toBe(200);
    expect(res.body!.data.tradeType).toBe('jsapi');
    expect(res.body!.data.jsapi).toMatchObject({ appId: 'wxtestappid000001', package: 'prepay_id=wx_prepay_1', signType: 'RSA' });
    expect(JSON.parse(w.calls[0]!.body).payer).toEqual({ openid: 'oFromSignIn' });
  });

  it('JSAPI without a WeChat sign-in answers 409 wechat_openid_missing (client falls back to the QR)', async () => {
    await w.close();
    w = await world();
    const res = await req(w, 'POST', ORDER_PATH, { body: buy({ tradeType: 'jsapi', openId: 'oClaimed' }) });
    expect(res.status).toBe(409);
    expect(res.body!.code).toBe('wechat_openid_missing');
    expect(w.calls).toHaveLength(0);
  });

  it('H5 passes the request IP as payer_client_ip', async () => {
    w.respond.fn = () => [200, { h5_url: 'https://wx.tenpay.com/checkmweb?prepay_id=1' }];
    const res = await req(w, 'POST', ORDER_PATH, { body: buy({ tradeType: 'h5' }), headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(res.status).toBe(200);
    expect(res.body!.data.h5Url).toMatch(/^https:\/\/wx\.tenpay\.com\/checkmweb\?prepay_id=1&redirect_url=/);
    expect(JSON.parse(w.calls[0]!.body).scene_info.payer_client_ip).toBe('203.0.113.7');
  });

  it('refuses unknown plans, a mismatched purpose, a coaching purpose and a missing terms version', async () => {
    expect((await req(w, 'POST', ORDER_PATH, { body: buy({ planKey: 'pro_weekly' }) })).body!.code).toBe('plan_not_sellable');
    expect((await req(w, 'POST', ORDER_PATH, { body: buy({ planKey: 'nope' }) })).status).toBe(409);
    const mismatch = await req(w, 'POST', ORDER_PATH, { body: buy({ purpose: 'interview_pack' }) });
    expect([mismatch.status, mismatch.body!.code]).toEqual([422, 'purpose_mismatch']);
    expect((await req(w, 'POST', ORDER_PATH, { body: buy({ purpose: 'coaching' }) })).body!.code).toBe('invalid_request');
    expect((await req(w, 'POST', ORDER_PATH, { body: { planKey: 'pro_monthly', tradeType: 'native' } })).body!.code).toBe('invalid_request');
    expect(w.calls).toHaveLength(0);
  });

  it('stores the accepted 用户协议 version as a consent record before WeChat Pay is called', async () => {
    const res = await req(w, 'POST', ORDER_PATH, { body: buy(), headers: { 'user-agent': 'TestAgent/1.0', 'x-forwarded-for': '198.51.100.4' } });
    expect(res.status).toBe(200);
    const acks = await w.db.seekerConsentRecord.findMany({});
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({
      seekerProfileId: 'sp_1',
      consentType: 'cn_pay_terms_ack',
      granted: true,
      proseVersion: 'cn-terms-2026-10',
      ipAddress: '198.51.100.4',
      userAgent: 'TestAgent/1.0',
    });
    expect(acks[0]!.proseHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('409 terms_outdated when the ticked 用户协议 is not the published version (no order, no WeChat call, no record)', async () => {
    const stale = await req(w, 'POST', ORDER_PATH, { body: buy({ termsVersion: 'cn-terms-2026-09' }) });
    expect([stale.status, stale.body!.code]).toEqual([409, 'terms_outdated']);
    expect(stale.body!.details).toEqual({ currentVersion: 'cn-terms-2026-10' });
    expect(w.calls).toHaveLength(0);
    expect(await w.db.alipayOrder.findMany({})).toHaveLength(0);
    expect(await w.db.seekerConsentRecord.findMany({})).toHaveLength(0);
  });

  it('409 terms_outdated when no 用户协议 version is published at all', async () => {
    await w.close();
    const { CN_LEGAL_DOCS_VERSION: _unset, ...env } = GA_ENV;
    w = await world({ env });
    const res = await req(w, 'POST', ORDER_PATH, { body: buy() });
    expect([res.status, res.body!.code]).toEqual([409, 'terms_outdated']);
    expect(res.body!.details).toEqual({ currentVersion: null });
    expect(w.calls).toHaveLength(0);
    expect(await w.db.alipayOrder.findMany({})).toHaveLength(0);
  });

  it('acknowledgeTerms (the gate the legacy /billing/checkout holds) uses the injected version resolver and the same limit and record', async () => {
    const db = seedDb();
    const limiter = memoryRateLimit(() => new Date('2026-10-10T08:00:00.000Z'));
    // Join J5 swaps this resolver; both order paths must follow it.
    const svc = new BillingCnService({ env: GA_ENV, getDb: async () => db as unknown as BillingCnDb, consumeRateLimit: limiter.consume, termsVersion: () => 'published-v7' });
    const brand = getBrand('goapply');
    const input = { seekerProfileId: 'sp_1', plan: { key: 'pro_monthly' as const, amountMinor: 3900 } };
    for (const termsVersion of [undefined, null, 'cn-terms-2026-10']) {
      await expect(svc.acknowledgeTerms('u_1', brand, { ...input, termsVersion })).rejects.toMatchObject({ code: 'terms_outdated', status: 409, details: { currentVersion: 'published-v7' } });
    }
    expect(await db.seekerConsentRecord.findMany({})).toHaveLength(0);
    await svc.acknowledgeTerms('u_1', brand, { ...input, termsVersion: 'published-v7' }, { ip: '203.0.113.7', userAgent: 'UA' });
    const acks = await db.seekerConsentRecord.findMany({});
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ seekerProfileId: 'sp_1', consentType: 'cn_pay_terms_ack', granted: true, proseVersion: 'published-v7', ipAddress: '203.0.113.7' });
    // Four attempts so far; the per-user limit is 10 a minute.
    for (let i = 0; i < 6; i++) await svc.acknowledgeTerms('u_1', brand, { ...input, termsVersion: 'published-v7' });
    await expect(svc.acknowledgeTerms('u_1', brand, { ...input, termsVersion: 'published-v7' })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('rate-limits order creation per user: the 11th order within a minute is 429 rate_limited', async () => {
    for (let i = 0; i < 10; i++) expect((await req(w, 'POST', ORDER_PATH, { body: buy() })).status).toBe(200);
    const limited = await fetch(`${w.base}${ORDER_PATH}`, {
      method: 'POST',
      headers: { 'x-forwarded-host': GOAPPLY, 'content-type': 'application/json' },
      body: JSON.stringify(buy()),
    });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(w.calls).toHaveLength(10);
    expect(await w.db.alipayOrder.findMany({})).toHaveLength(10);
  });

  it('is hidden on RoboApply and when CN payments are off; 503 until the entity matches the merchant', async () => {
    const ra = await req(w, 'POST', ORDER_PATH, { body: buy(), host: ROBOAPPLY });
    expect([ra.status, ra.body!.code]).toEqual([404, 'feature_disabled']);
    await w.close();
    w = await world({ env: { ...GA_ENV, CN_PAYMENTS_ENABLED: 'false' } });
    const off = await req(w, 'POST', ORDER_PATH, { body: buy() });
    expect([off.status, off.body!.code]).toEqual([404, 'feature_disabled']);
    await w.close();
    w = await world({ env: { ...GA_ENV, WECHATPAY_MERCHANT_ENTITY: '别的公司' } });
    const mismatch = await req(w, 'POST', ORDER_PATH, { body: buy() });
    expect([mismatch.status, mismatch.body!.code]).toEqual([503, 'rail_not_configured']);
    expect(mismatch.body!.details).toMatchObject({ reason: 'entity_mismatch' });
    expect(w.calls).toHaveLength(0);
  });

  it('requires sign-in', async () => {
    await w.close();
    w = await world({ user: null });
    expect((await req(w, 'POST', ORDER_PATH, { body: buy() })).status).toBe(401);
    expect((await req(w, 'GET', `${ORDER_PATH}/orders/GAWX1`)).status).toBe(401);
  });
});

describe('GET /billing-cn/wechatpay/orders/:orderId', () => {
  const T0 = new Date('2026-10-10T08:00:00.000Z');
  const pending = (over: Record<string, unknown> = {}) => ({
    id: 'o_1',
    userId: 'u_1',
    outTradeNo: 'GAWX20261010080000aaaaaaaaaaaa',
    tier: 'ra_pro_monthly',
    planKey: 'pro_monthly',
    brand: 'goapply',
    channel: 'wechatpay',
    purpose: 'subscription',
    amount: 39,
    amountMinor: 3900,
    status: 'pending',
    tradeType: 'NATIVE',
    createdAt: T0,
    completedAt: null,
    ...over,
  });
  let w: World;
  afterAll(async () => w?.close());

  it('pending: asks WeChat Pay (throttled) and stays pending while unpaid', async () => {
    w = await world({ now: new Date(T0.getTime() + 10_000), seed: { alipayOrder: [pending()] } });
    w.respond.fn = () => [200, { mchid: '1900000001', out_trade_no: 'GAWX20261010080000aaaaaaaaaaaa', trade_state: 'NOTPAY' }];
    const res = await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`);
    expect(res.status).toBe(200);
    expect(res.body!.data).toMatchObject({
      status: 'pending',
      amountMinor: 3900,
      currency: 'CNY',
      tradeType: 'native',
      collectingEntity: ENTITY,
      expiresAt: new Date(T0.getTime() + 15 * 60_000).toISOString(),
      accessUntil: null,
    });
    await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`);
    expect(w.calls).toHaveLength(1);
    await w.close();
  });

  it('a paid order whose notify was lost is completed through fulfilPass by the query', async () => {
    w = await world({ now: new Date(T0.getTime() + 30_000), seed: { alipayOrder: [pending()] } });
    w.respond.fn = () => [200, { mchid: '1900000001', appid: 'wxtestappid000001', out_trade_no: 'GAWX20261010080000aaaaaaaaaaaa', trade_state: 'SUCCESS', transaction_id: 'tx_9', amount: { total: 3900 } }];
    const res = await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`);
    expect(res.body!.data.status).toBe('paid');
    expect(res.body!.data.accessUntil).toBe(new Date(T0.getTime() + 30_000 + 30 * DAY).toISOString());
    expect(w.grants.plan).toHaveBeenCalledTimes(1);
    expect(await w.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAWX20261010080000aaaaaaaaaaaa' } })).toMatchObject({ status: 'completed', wxTransactionId: 'tx_9' });
    await w.close();
  });

  it('a paid order the query cannot honour becomes needs_support once, then is never queried again', async () => {
    w = await world({ now: new Date(T0.getTime() + 30_000), seed: { alipayOrder: [pending({ amountMinor: 9900, amount: 99 })] } });
    w.respond.fn = () => [200, { mchid: '1900000001', appid: 'wxtestappid000001', out_trade_no: 'GAWX20261010080000aaaaaaaaaaaa', trade_state: 'SUCCESS', transaction_id: 'tx_bad', amount: { total: 3900 } }];
    const res = await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`);
    expect(res.body!.data.status).toBe('needs_support');
    expect(w.grants.plan).not.toHaveBeenCalled();
    expect(await w.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAWX20261010080000aaaaaaaaaaaa' } })).toMatchObject({ status: 'needs_review', wxTransactionId: 'tx_bad' });
    w.setNow(new Date(T0.getTime() + 120_000));
    expect((await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`)).body!.data.status).toBe('needs_support');
    expect(w.calls).toHaveLength(1);
    await w.close();
  });

  it('an expired unpaid order is closed at WeChat Pay and here', async () => {
    w = await world({ now: new Date(T0.getTime() + 20 * 60_000), seed: { alipayOrder: [pending()] } });
    w.respond.fn = (c) => (c.url.endsWith('/close') ? [204, null] : [200, { mchid: '1900000001', out_trade_no: 'GAWX20261010080000aaaaaaaaaaaa', trade_state: 'NOTPAY' }]);
    const res = await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`);
    expect(res.body!.data.status).toBe('closed');
    expect(w.calls.map((c) => c.url.split('/').pop())).toEqual(['GAWX20261010080000aaaaaaaaaaaa?mchid=1900000001', 'close']);
    await w.close();
  });

  it('an expired order whose payer is mid-payment (USERPAYING) stays pending and is not closed', async () => {
    w = await world({ now: new Date(T0.getTime() + 20 * 60_000), seed: { alipayOrder: [pending()] } });
    w.respond.fn = (c) => (c.url.endsWith('/close') ? [204, null] : [200, { mchid: '1900000001', out_trade_no: 'GAWX20261010080000aaaaaaaaaaaa', trade_state: 'USERPAYING' }]);
    const res = await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`);
    expect(res.body!.data.status).toBe('pending');
    expect(w.calls.map((c) => c.url.split('/').pop())).toEqual(['GAWX20261010080000aaaaaaaaaaaa?mchid=1900000001']);
    expect(await w.db.alipayOrder.findUnique({ where: { outTradeNo: 'GAWX20261010080000aaaaaaaaaaaa' } })).toMatchObject({ status: 'pending' });
    await w.close();
  });

  it('an expired order WeChat Pay refuses to close stays pending; a later notify still completes it', async () => {
    w = await world({ now: new Date(T0.getTime() + 20 * 60_000), seed: { alipayOrder: [pending()] } });
    w.respond.fn = (c) => (c.url.endsWith('/close') ? [400, { code: 'ORDERPAID' }] : [200, { mchid: '1900000001', out_trade_no: 'GAWX20261010080000aaaaaaaaaaaa', trade_state: 'NOTPAY' }]);
    const res = await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`);
    expect(res.body!.data.status).toBe('pending');
    expect(w.calls.map((c) => c.url.split('/').pop())).toEqual(['GAWX20261010080000aaaaaaaaaaaa?mchid=1900000001', 'close']);
    // Next poll (after the throttle): WeChat Pay now reports the payment, and the order completes.
    w.setNow(new Date(T0.getTime() + 20 * 60_000 + 10_000));
    w.respond.fn = () => [200, { mchid: '1900000001', appid: 'wxtestappid000001', out_trade_no: 'GAWX20261010080000aaaaaaaaaaaa', trade_state: 'SUCCESS', transaction_id: 'tx_late', amount: { total: 3900 } }];
    expect((await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`)).body!.data.status).toBe('paid');
    expect(w.grants.plan).toHaveBeenCalledTimes(1);
    await w.close();
  });

  it('an expired order WeChat Pay does not know is closed here', async () => {
    w = await world({ now: new Date(T0.getTime() + 20 * 60_000), seed: { alipayOrder: [pending()] } });
    w.respond.fn = () => [404, { code: 'ORDER_NOT_EXIST' }];
    expect((await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`)).body!.data.status).toBe('closed');
    expect(w.calls).toHaveLength(1);
    await w.close();
  });

  it("another user's order, an Alipay order and an unknown id are 404", async () => {
    w = await world({ seed: { alipayOrder: [pending({ userId: 'u_2' }), pending({ id: 'o_2', outTradeNo: 'GAORDER_X', channel: 'alipay' })] } });
    expect((await req(w, 'GET', `${ORDER_PATH}/orders/GAWX20261010080000aaaaaaaaaaaa`)).status).toBe(404);
    expect((await req(w, 'GET', `${ORDER_PATH}/orders/GAORDER_X`)).status).toBe(404);
    expect((await req(w, 'GET', `${ORDER_PATH}/orders/nope`)).status).toBe(404);
    expect(w.calls).toHaveLength(0);
  });
});

describe('POST /api/v1/webhooks/wechatpay (raw body, fixture vectors)', () => {
  const at = new Date(NOTIFY_SIGNED_AT_SEC * 1000);
  const order = (over: Record<string, unknown> = {}) => ({
    id: 'o_n',
    userId: 'u_1',
    outTradeNo: NOTIFY_TRANSACTION.out_trade_no,
    tier: 'ra_pro_monthly',
    planKey: 'pro_monthly',
    brand: 'goapply',
    channel: 'wechatpay',
    purpose: 'subscription',
    amount: 39,
    amountMinor: 3900,
    status: 'pending',
    tradeType: 'NATIVE',
    createdAt: new Date(at.getTime() - 60_000),
    completedAt: null,
    ...over,
  });
  let w: World;
  afterAll(async () => w?.close());

  const notify = (body = NOTIFY_BODY, headers: Record<string, string> = { ...NOTIFY_VECTOR.headers }, host = GOAPPLY) =>
    req(w, 'POST', NOTIFY_PATH, { raw: body, headers, host });

  it('fulfils the pass once; a duplicate notify is a no-op', async () => {
    w = await world({ env: GA_ENV_VECTOR, now: at, seed: { alipayOrder: [order()] } });
    const first = await notify();
    expect(first).toEqual({ status: 200, body: { code: 'SUCCESS', message: '成功' } });
    const row = await w.db.alipayOrder.findUnique({ where: { outTradeNo: NOTIFY_TRANSACTION.out_trade_no } });
    expect(row).toMatchObject({ status: 'completed', wxTransactionId: NOTIFY_TRANSACTION.transaction_id });
    const sub = await w.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect(sub).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', interval: 'pass', rail: 'wechatpay', currency: 'CNY', amountMinor: 3900, cancelAtPeriodEnd: false });
    expect(w.grants.plan).toHaveBeenCalledTimes(1);

    // The buyer is told on WeChat once, with the order's own facts.
    expect(w.grants.notice).toHaveBeenCalledTimes(1);
    expect(w.grants.notice).toHaveBeenCalledWith({
      userId: 'u_1',
      template: 'payment_success',
      params: { planName: '会员月卡', amountFen: 3900, paidAt: at.toISOString(), orderNo: NOTIFY_TRANSACTION.out_trade_no },
      href: '/settings/billing',
      eventId: NOTIFY_TRANSACTION.out_trade_no,
    });

    const again = await notify();
    expect(again.status).toBe(200);
    expect(w.grants.plan).toHaveBeenCalledTimes(1);
    expect(w.grants.notice).toHaveBeenCalledTimes(1);
    const subAfter = await w.db.seekerSubscription.findUnique({ where: { seekerProfileId: 'sp_1' } });
    expect(subAfter!.currentPeriodEnd).toEqual(sub!.currentPeriodEnd);
    expect(w.calls).toHaveLength(0);
    await w.close();
  });

  it('refuses a tampered body (401 FAIL) and changes nothing', async () => {
    w = await world({ env: GA_ENV_VECTOR, now: at, seed: { alipayOrder: [order()] } });
    const res = await notify(NOTIFY_BODY.replace('"summary":"', '"summary":" '));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'FAIL' });
    expect(await w.db.alipayOrder.findUnique({ where: { outTradeNo: NOTIFY_TRANSACTION.out_trade_no } })).toMatchObject({ status: 'pending' });
    expect(w.grants.plan).not.toHaveBeenCalled();
    await w.close();
  });

  it('refuses a replay outside the 5-minute window', async () => {
    w = await world({ env: GA_ENV_VECTOR, now: new Date(at.getTime() + 10 * 60_000), seed: { alipayOrder: [order()] } });
    expect((await notify()).status).toBe(401);
    await w.close();
  });

  it('refuses a body that was parsed before the handler (mount-order bug)', async () => {
    w = await world({ env: GA_ENV_VECTOR, now: at, seed: { alipayOrder: [order()] } });
    const res = await req(w, 'POST', `/parsed${NOTIFY_PATH}`, { raw: NOTIFY_BODY, headers: { ...NOTIFY_VECTOR.headers } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'invalid_request', details: { expected: 'Buffer' } });
    await w.close();
  });

  it('a paid notify that cannot be honoured (amount mismatch, unknown order) is acknowledged without granting', async () => {
    w = await world({ env: GA_ENV_VECTOR, now: at, seed: { alipayOrder: [order({ amountMinor: 9900, amount: 99 })] } });
    expect((await notify()).status).toBe(200);
    // Parked for staff (not left pending, not "nothing was charged").
    expect(await w.db.alipayOrder.findUnique({ where: { outTradeNo: NOTIFY_TRANSACTION.out_trade_no } })).toMatchObject({
      status: 'needs_review',
      wxTransactionId: NOTIFY_TRANSACTION.transaction_id,
    });
    expect(w.grants.plan).not.toHaveBeenCalled();
    // The buyer sees needs_support, and the status read stops querying WeChat Pay.
    const st = await req(w, 'GET', `${ORDER_PATH}/orders/${NOTIFY_TRANSACTION.out_trade_no}`);
    expect(st.body!.data).toMatchObject({ status: 'needs_support', paidAt: null });
    expect(w.calls).toHaveLength(0);
    await w.close();
    w = await world({ env: GA_ENV_VECTOR, now: at });
    expect((await notify()).status).toBe(200);
    expect(w.grants.plan).not.toHaveBeenCalled();
    await w.close();
  });

  it('answers 503 FAIL (WeChat retries) when verification is not configured, 404 on RoboApply', async () => {
    w = await world({ env: { ...GA_ENV_VECTOR, WECHATPAY_PUBLIC_KEY: '' }, now: at, seed: { alipayOrder: [order()] } });
    expect((await notify()).status).toBe(503);
    const ra = await notify(NOTIFY_BODY, { ...NOTIFY_VECTOR.headers }, ROBOAPPLY);
    expect([ra.status, ra.body!.code]).toEqual([404, 'feature_disabled']);
    await w.close();
  });
});

describe('router service lifetime', () => {
  it('with only deps.env injected, one service serves every request (its query throttle survives between requests)', async () => {
    const seen = new Set<BillingCnService>();
    const spy = vi.spyOn(BillingCnService.prototype, 'orderStatus').mockImplementation(async function (this: BillingCnService) {
      seen.add(this);
      return { orderId: 'x', status: 'pending' } as never;
    });
    const app = express();
    app.use(createBrandContext({ env: GA_ENV }));
    app.use(ORDER_PATH, createWechatPayRouter({ env: GA_ENV, seekerAuth: [fakeAuth({ id: 'u_1', email: 'u1@example.test', role: 'seeker' })] }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${base}${ORDER_PATH}/orders/GAWX1`, { headers: { 'x-forwarded-host': GOAPPLY } });
        expect(res.status).toBe(200);
      }
      expect(spy).toHaveBeenCalledTimes(2);
      expect(seen.size).toBe(1);
    } finally {
      spy.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
