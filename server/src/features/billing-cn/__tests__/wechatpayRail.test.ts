// @vitest-environment node
//
// WP-62 acceptance — the WeChat Pay v3 rail:
//   - notify signature verification against fixture vectors on the RAW body
//     (a one-byte change, a wrong serial or a stale timestamp fails);
//   - AES-256-GCM resource decrypt;
//   - requests signed with the merchant key, responses verified;
//   - Native / H5 / JSAPI checkout; order rows on AlipayOrder (channel
//     'wechatpay'); never a `coaching` purpose; no auto-renewing plan;
//   - charging stays off until the collecting entity matches the merchant;
//   - registered through WP-21a's registerRail / resolveRail.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { createVerify } from 'node:crypto';
import { getBrand } from '../../../platform/brand/registry.js';
import { getPlan } from '../../../platform/billing/planCatalog.js';
import { BillingError } from '../../../platform/billing/errors.js';
import { appOrigin } from '../../../platform/billing/origins.js';
import { getRegisteredRail, registerRail, resolveRail, unregisterRail } from '../../../platform/billing/rails/registry.js';
import { CallbackRejectedError, type CheckoutOrder } from '../../../platform/billing/rails/types.js';
import {
  buildAuthorization,
  createWechatPayRail,
  decryptResource,
  encryptResource,
  ensureWechatPayRail,
  isWechatPayRail,
  jsapiPaySign,
  mapTradeState,
  newWechatOutTradeNo,
  rsaSign,
  wechatSignMessage,
  normalizeEntityName,
  normalizePem,
  readWechatPayConfig,
  requestSignMessage,
  toCstRfc3339,
  verifyWechatSignature,
  wechatPayReadiness,
  ORDER_TERMS_VERSION_MAX,
  WECHATPAY_ORDER_TTL_MINUTES,
} from '../../../platform/billing/rails/wechatpay.js';
import { WECHATPAY_ORDER_TTL_MINUTES as CONTRACT_TTL } from '../contract.js';
import { ENTITY, GA_ENV, GA_ENV_VECTOR, MERCHANT, PLATFORM, PLATFORM_KEY_ID, parseAuthorization, seedDb, wechatFetch } from './helpers.js';
import { NOTIFY_BODY, NOTIFY_SIGNED_AT_SEC, NOTIFY_TRANSACTION, NOTIFY_VECTOR } from './wechatpayVectors.js';

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');
const NOW = new Date('2026-10-10T08:00:00.000Z');
const nowSec = () => Math.floor(NOW.getTime() / 1000);

function verifyRsa(publicKey: string, message: string, sig: string): boolean {
  const v = createVerify('RSA-SHA256');
  v.update(message);
  return v.verify(publicKey, sig, 'base64');
}

function order(planKey: 'pro_monthly' | 'practice_pack_5' | 'pro_week_pass', context: CheckoutOrder['context'] & Record<string, unknown> = { tradeType: 'native' }, env = GA_ENV): CheckoutOrder {
  const plan = getPlan('goapply', planKey, env)!;
  return {
    brand: goapply,
    plan,
    user: { id: 'u_1', email: 'u1@example.test', name: '测试' },
    seekerProfileId: 'sp_1',
    acknowledgements: { autoRenewAck: false, withdrawalWaiver: false },
    successPath: '/settings/billing/return?plan=' + planKey,
    context,
  };
}

describe('notify verification — fixture vectors on the raw body', () => {
  const headers = { ...NOTIFY_VECTOR.headers };
  const base = { publicKey: NOTIFY_VECTOR.publicKey, publicKeyId: NOTIFY_VECTOR.publicKeyId, nowSec: NOTIFY_SIGNED_AT_SEC };

  it('accepts the vector exactly as signed (Buffer or string)', () => {
    expect(verifyWechatSignature({ ...base, headers, body: Buffer.from(NOTIFY_BODY, 'utf8') })).toEqual({ ok: true });
    expect(verifyWechatSignature({ ...base, headers, body: NOTIFY_BODY })).toEqual({ ok: true });
  });

  it('refuses a body changed by one byte', () => {
    const tampered = NOTIFY_BODY.replace('TRANSACTION.SUCCESS', 'TRANSACTION.SUCCESs');
    expect(verifyWechatSignature({ ...base, headers, body: tampered })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a re-serialised body (the signature covers the raw bytes, not the JSON value)', () => {
    const reserialised = JSON.stringify(JSON.parse(NOTIFY_BODY), null, 1);
    expect(verifyWechatSignature({ ...base, headers, body: reserialised }).ok).toBe(false);
  });

  it('refuses a wrong serial, a wrong signature type, missing headers and a stale timestamp', () => {
    expect(verifyWechatSignature({ ...base, headers: { ...headers, 'wechatpay-serial': 'PUB_KEY_ID_OTHER' }, body: NOTIFY_BODY })).toEqual({ ok: false, reason: 'wrong_serial' });
    expect(verifyWechatSignature({ ...base, headers: { ...headers, 'wechatpay-signature-type': 'WECHATPAY2-SM2-WITH-SM3' }, body: NOTIFY_BODY })).toEqual({ ok: false, reason: 'wrong_type' });
    const { ['wechatpay-signature']: _drop, ...noSig } = headers;
    expect(verifyWechatSignature({ ...base, headers: noSig, body: NOTIFY_BODY })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyWechatSignature({ ...base, nowSec: NOTIFY_SIGNED_AT_SEC + 301, headers, body: NOTIFY_BODY })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyWechatSignature({ ...base, nowSec: NOTIFY_SIGNED_AT_SEC + 299, headers, body: NOTIFY_BODY })).toEqual({ ok: true });
  });

  it('refuses the WeChat "signature probe" (a deliberately broken signature)', () => {
    const probe = { ...headers, 'wechatpay-signature': 'WECHATPAY/SIGNTEST/' + headers['wechatpay-signature'] };
    expect(verifyWechatSignature({ ...base, headers: probe, body: NOTIFY_BODY })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('decrypts the AES-256-GCM resource with the APIv3 key', () => {
    const { resource } = JSON.parse(NOTIFY_BODY) as { resource: { nonce: string; associated_data: string; ciphertext: string } };
    const plain = decryptResource(NOTIFY_VECTOR.apiV3Key, { nonce: resource.nonce, associatedData: resource.associated_data, ciphertext: resource.ciphertext });
    expect(JSON.parse(plain)).toEqual(NOTIFY_TRANSACTION);
    expect(() => decryptResource('X'.repeat(32), { nonce: resource.nonce, associatedData: resource.associated_data, ciphertext: resource.ciphertext })).toThrow();
    expect(() => decryptResource(NOTIFY_VECTOR.apiV3Key, { nonce: resource.nonce, associatedData: 'other', ciphertext: resource.ciphertext })).toThrow();
    // Round trip of the test helper.
    const ct = encryptResource(NOTIFY_VECTOR.apiV3Key, { nonce: 'n0nce1234567', associatedData: 'a', plaintext: '{"x":1}' });
    expect(decryptResource(NOTIFY_VECTOR.apiV3Key, { nonce: 'n0nce1234567', associatedData: 'a', ciphertext: ct })).toBe('{"x":1}');
  });

  it('verifyCallback turns the vector into a paid order with the amount and transaction id', async () => {
    const rail = createWechatPayRail({ env: GA_ENV_VECTOR, now: () => new Date(NOTIFY_SIGNED_AT_SEC * 1000) });
    const res = await rail.verifyCallback({ query: {}, body: null, headers, rawBody: Buffer.from(NOTIFY_BODY) });
    expect(res).toEqual({
      outTradeNo: NOTIFY_TRANSACTION.out_trade_no,
      status: 'paid',
      paidAmountMinor: 3900,
      transactionId: NOTIFY_TRANSACTION.transaction_id,
    });
  });

  it('verifyCallback rejects: no raw Buffer, bad signature, not configured, another merchant', async () => {
    const at = () => new Date(NOTIFY_SIGNED_AT_SEC * 1000);
    const rail = createWechatPayRail({ env: GA_ENV_VECTOR, now: at });
    const reason = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof CallbackRejectedError ? e.reason : String(e)));
    expect(await reason(rail.verifyCallback({ query: {}, body: JSON.parse(NOTIFY_BODY), headers }))).toBe('invalid_params');
    expect(await reason(rail.verifyCallback({ query: {}, body: null, headers, rawBody: Buffer.from(NOTIFY_BODY + ' ') }))).toBe('bad_secret');
    const unconfigured = createWechatPayRail({ env: { ...GA_ENV_VECTOR, WECHATPAY_PUBLIC_KEY: '' }, now: at });
    expect(await reason(unconfigured.verifyCallback({ query: {}, body: null, headers, rawBody: Buffer.from(NOTIFY_BODY) }))).toBe('not_configured');
    const otherMerchant = createWechatPayRail({ env: { ...GA_ENV_VECTOR, WECHATPAY_MCH_ID: '1900000099' }, now: at });
    expect(await reason(otherMerchant.verifyCallback({ query: {}, body: null, headers, rawBody: Buffer.from(NOTIFY_BODY) }))).toBe('invalid_params');
    const wrongKey = createWechatPayRail({ env: { ...GA_ENV_VECTOR, WECHATPAY_API_V3_KEY: 'Y'.repeat(32) }, now: at });
    expect(await reason(wrongKey.verifyCallback({ query: {}, body: null, headers, rawBody: Buffer.from(NOTIFY_BODY) }))).toBe('not_configured');
  });

  it('verifyCallback rejects a SUCCESS notify that does not state the amount (never fulfilled without the amount check)', async () => {
    const tx = { mchid: '1900000001', appid: 'wxtestappid000001', out_trade_no: 'NOAMT1', trade_state: 'SUCCESS', transaction_id: 't_noamt' };
    const resource = { algorithm: 'AEAD_AES_256_GCM', nonce: 'n0nce1234567', associated_data: 'transaction', original_type: 'transaction' };
    const body = JSON.stringify({
      id: 'ev_noamt',
      event_type: 'TRANSACTION.SUCCESS',
      resource: { ...resource, ciphertext: encryptResource(GA_ENV.WECHATPAY_API_V3_KEY!, { nonce: resource.nonce, associatedData: resource.associated_data, plaintext: JSON.stringify(tx) }) },
    });
    const ts = String(nowSec());
    const signed = {
      'wechatpay-timestamp': ts,
      'wechatpay-nonce': 'abc123',
      'wechatpay-serial': PLATFORM_KEY_ID,
      'wechatpay-signature-type': 'WECHATPAY2-SHA256-RSA2048',
      'wechatpay-signature': rsaSign(PLATFORM.privateKey, wechatSignMessage(ts, 'abc123', body)),
    };
    const rail = createWechatPayRail({ env: GA_ENV, now: () => NOW });
    const err = await rail.verifyCallback({ query: {}, body: null, headers: signed, rawBody: Buffer.from(body) }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CallbackRejectedError);
    expect((err as CallbackRejectedError).reason).toBe('invalid_params');
    // The same notify WITH the amount is accepted (the rejection is the missing amount, nothing else).
    const withAmount = JSON.stringify({
      id: 'ev_amt',
      event_type: 'TRANSACTION.SUCCESS',
      resource: {
        ...resource,
        ciphertext: encryptResource(GA_ENV.WECHATPAY_API_V3_KEY!, { nonce: resource.nonce, associatedData: resource.associated_data, plaintext: JSON.stringify({ ...tx, amount: { total: 3900, currency: 'CNY' } }) }),
      },
    });
    const ok = await rail.verifyCallback({
      query: {},
      body: null,
      headers: { ...signed, 'wechatpay-signature': rsaSign(PLATFORM.privateKey, wechatSignMessage(ts, 'abc123', withAmount)) },
      rawBody: Buffer.from(withAmount),
    });
    expect(ok).toMatchObject({ outTradeNo: 'NOAMT1', status: 'paid', paidAmountMinor: 3900 });
  });

  it('maps trade states conservatively (refunds and unknown states never fulfil)', () => {
    expect(mapTradeState('SUCCESS')).toBe('paid');
    for (const s of ['CLOSED', 'REVOKED', 'PAYERROR']) expect(mapTradeState(s)).toBe('closed');
    for (const s of ['NOTPAY', 'USERPAYING', 'REFUND', undefined, 'WHATEVER']) expect(mapTradeState(s)).toBe('pending');
  });
});

describe('request signing', () => {
  it('signs METHOD\\nURL\\nTS\\nNONCE\\nBODY\\n with the merchant key', () => {
    const auth = buildAuthorization({
      mchId: '1900000001',
      serialNo: 'MCHSERIAL0001',
      privateKey: MERCHANT.privateKey,
      method: 'POST',
      urlPathWithQuery: '/v3/pay/transactions/native',
      body: '{"a":1}',
      timestamp: '1791590400',
      nonce: 'abc',
    });
    const p = parseAuthorization(auth);
    expect(p).toMatchObject({ scheme: 'WECHATPAY2-SHA256-RSA2048', mchid: '1900000001', nonce_str: 'abc', timestamp: '1791590400', serial_no: 'MCHSERIAL0001' });
    expect(verifyRsa(MERCHANT.publicKey, requestSignMessage('POST', '/v3/pay/transactions/native', '1791590400', 'abc', '{"a":1}'), p.signature!)).toBe(true);
  });

  it('JSAPI paySign covers appId, timeStamp, nonceStr and package', () => {
    const p = { appId: 'wxapp', timeStamp: '1791590400', nonceStr: 'n', package: 'prepay_id=wx1' };
    expect(verifyRsa(MERCHANT.publicKey, 'wxapp\n1791590400\nn\nprepay_id=wx1\n', jsapiPaySign(MERCHANT.privateKey, p))).toBe(true);
  });

  it('order numbers fit WeChat Pay (≤32 chars, allowed charset) and times are +08:00', () => {
    const no = newWechatOutTradeNo(NOW);
    expect(no).toMatch(/^GAWX20261010080000[0-9a-f]{12}$/);
    expect(no.length).toBeLessThanOrEqual(32);
    expect(toCstRfc3339(NOW)).toBe('2026-10-10T16:00:00+08:00');
    expect(CONTRACT_TTL).toBe(WECHATPAY_ORDER_TTL_MINUTES);
  });

  it('reads PEM values with escaped newlines', () => {
    expect(normalizePem('"-----BEGIN X-----\\nabc\\n-----END X-----"')).toBe('-----BEGIN X-----\nabc\n-----END X-----');
    expect(readWechatPayConfig({ WECHATPAY_MCH_PRIVATE_KEY: MERCHANT.privateKey.replace(/\n/g, '\\n') }).mchPrivateKey).toBe(MERCHANT.privateKey.trim());
  });
});

describe('charging stays off until the collecting entity matches the merchant (OPS C-13)', () => {
  it('is ready with the full configuration (bracket width and spaces ignored)', () => {
    expect(normalizeEntityName('测试科技（上海） 有限公司')).toBe(normalizeEntityName('测试科技(上海)有限公司'));
    expect(wechatPayReadiness(goapply, GA_ENV)).toEqual({ ready: true, reason: null, collectingEntity: ENTITY });
  });

  it.each([
    ['collecting_entity_missing', { CN_PAYMENT_COLLECTING_ENTITY: '' }],
    ['merchant_entity_missing', { WECHATPAY_MERCHANT_ENTITY: '' }],
    ['entity_mismatch', { WECHATPAY_MERCHANT_ENTITY: '另一家公司' }],
    ['public_key_missing', { WECHATPAY_PUBLIC_KEY: '' }],
    ['api_v3_key_invalid', { WECHATPAY_API_V3_KEY: 'short' }],
    ['credentials_missing', { WECHATPAY_MCH_PRIVATE_KEY: '' }],
  ])('%s → not ready', (reason, patch) => {
    expect(wechatPayReadiness(goapply, { ...GA_ENV, ...patch })).toMatchObject({ ready: false, reason });
  });

  it('never applies to RoboApply', () => {
    expect(wechatPayReadiness(roboapply, GA_ENV)).toMatchObject({ ready: false, reason: 'wrong_market' });
  });

  it('createCheckout refuses before any request when the entity does not match', async () => {
    const db = seedDb();
    const f = wechatFetch(() => [200, { code_url: 'weixin://x' }], { nowSec });
    const rail = createWechatPayRail({ env: { ...GA_ENV, WECHATPAY_MERCHANT_ENTITY: '另一家公司' }, fetch: f.fetch, getDb: async () => db as never, now: () => NOW });
    await expect(rail.createCheckout(order('pro_monthly'))).rejects.toMatchObject({ code: 'rail_not_configured' });
    expect(f.calls).toHaveLength(0);
    expect(await db.alipayOrder.findMany({})).toHaveLength(0);
  });
});

describe('checkout', () => {
  function railWith(respond: Parameters<typeof wechatFetch>[0], opts: { sign?: boolean; env?: Record<string, string> } = {}) {
    const db = seedDb();
    const f = wechatFetch(respond, { nowSec, sign: opts.sign });
    const rail = createWechatPayRail({ env: opts.env ?? GA_ENV, fetch: f.fetch, getDb: async () => db as never, now: () => NOW });
    return { db, f, rail };
  }

  it('Native: signed request, CNY fen amount, notify URL, 15-minute expiry; QR code URL back; order row written', async () => {
    const { db, f, rail } = railWith(() => [200, { code_url: 'weixin://wxpay/bizpayurl?pr=abc' }]);
    const res = await rail.createCheckout(order('pro_monthly'));
    expect(res).toMatchObject({ kind: 'qr', qrCodeUrl: 'weixin://wxpay/bizpayurl?pr=abc', collectingEntity: ENTITY });
    expect(res.expiresAt).toBe(new Date(NOW.getTime() + 15 * 60_000).toISOString());

    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/native');
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({
      appid: 'wxtestappid000001',
      mchid: '1900000001',
      amount: { total: 3900, currency: 'CNY' },
      notify_url: 'https://api.goapply.test/api/v1/webhooks/wechatpay',
      time_expire: '2026-10-10T16:15:00+08:00',
      attach: 'plan=pro_monthly',
    });
    expect(body.out_trade_no).toBe(res.orderId);
    expect(body.description.length).toBeLessThanOrEqual(127);
    const auth = parseAuthorization(call.headers.authorization!);
    expect(auth.serial_no).toBe('MCHSERIAL0001');
    expect(verifyRsa(MERCHANT.publicKey, requestSignMessage('POST', '/v3/pay/transactions/native', auth.timestamp!, auth.nonce_str!, call.body), auth.signature!)).toBe(true);

    const row = await db.alipayOrder.findUnique({ where: { outTradeNo: res.orderId! } });
    expect(row).toMatchObject({
      userId: 'u_1',
      channel: 'wechatpay',
      brand: 'goapply',
      planKey: 'pro_monthly',
      tier: 'ra_pro_monthly',
      purpose: 'subscription',
      amountMinor: 3900,
      amount: 39,
      status: 'pending',
      tradeType: 'NATIVE',
      wxCodeUrl: 'weixin://wxpay/bizpayurl?pr=abc',
    });
  });

  it('a practice pack is an interview_pack order (never coaching)', async () => {
    const { db, rail } = railWith(() => [200, { code_url: 'weixin://p' }]);
    const res = await rail.createCheckout(order('practice_pack_5'));
    const row = await db.alipayOrder.findUnique({ where: { outTradeNo: res.orderId! } });
    expect(row).toMatchObject({ purpose: 'interview_pack', amountMinor: 2900 });
    const purposes = (await db.alipayOrder.findMany({})).map((r) => r.purpose);
    expect(purposes).not.toContain('coaching');
  });

  it('H5: sends the payer IP and returns the h5 URL with our return page', async () => {
    const { f, rail } = railWith(() => [200, { h5_url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx1&package=1' }]);
    const res = await rail.createCheckout(order('pro_week_pass', { tradeType: 'h5', payerClientIp: '203.0.113.9' }));
    expect(res.kind).toBe('redirect');
    expect(res.kind === 'redirect' && res.url).toBe(
      'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx1&package=1&redirect_url=' +
        encodeURIComponent(`${appOrigin(goapply, GA_ENV)}/settings/billing/return?plan=pro_week_pass&order=${res.orderId}`),
    );
    expect(f.calls[0]!.url).toMatch(/\/v3\/pay\/transactions\/h5$/);
    expect(JSON.parse(f.calls[0]!.body).scene_info).toMatchObject({ payer_client_ip: '203.0.113.9', h5_info: { type: 'Wap' } });
  });

  it('stores the 用户协议 version the buyer ticked on the order row (clipped to the column\'s limit; null when the caller has none)', async () => {
    const { db, rail } = railWith(() => [200, { code_url: 'weixin://p' }]);
    const withTerms = await rail.createCheckout(order('pro_monthly', { tradeType: 'native', termsVersion: ' cn-terms-2026-10 ' }));
    expect((await db.alipayOrder.findUnique({ where: { outTradeNo: withTerms.orderId! } }))?.termsVersion).toBe('cn-terms-2026-10');
    const long = await rail.createCheckout(order('pro_monthly', { tradeType: 'native', termsVersion: 'v'.repeat(60) }));
    expect((await db.alipayOrder.findUnique({ where: { outTradeNo: long.orderId! } }))?.termsVersion).toBe('v'.repeat(ORDER_TERMS_VERSION_MAX));
    const none = await rail.createCheckout(order('pro_monthly'));
    expect((await db.alipayOrder.findUnique({ where: { outTradeNo: none.orderId! } }))?.termsVersion).toBeNull();
  });

  it('H5 without the payer IP is refused before any request', async () => {
    const { f, rail } = railWith(() => [200, { h5_url: 'x' }]);
    await expect(rail.createCheckout(order('pro_week_pass', { tradeType: 'h5' }))).rejects.toMatchObject({ code: 'payment_provider_error' });
    expect(f.calls).toHaveLength(0);
  });

  it('JSAPI: payer openid from WeChat sign-in (a caller-sent one is ignored); signed bridge parameters back', async () => {
    const { db, f, rail } = railWith(() => [200, { prepay_id: 'wx201410272009395522657a690389285100' }]);
    await db.rAAuthIdentity.create({ data: { id: 'i_1', userId: 'u_1', brand: 'goapply', provider: 'wechat', appId: 'wxtestappid000001', subject: 'oUser1', lastUsedAt: new Date() } });
    const res = await rail.createCheckout(order('pro_monthly', { tradeType: 'jsapi', openId: 'oSomebodyElse' }));
    expect(JSON.parse(f.calls[0]!.body).payer).toEqual({ openid: 'oUser1' });
    expect(res.kind).toBe('jsapi');
    if (res.kind !== 'jsapi') return;
    const p = res.jsapiParams;
    expect(p).toMatchObject({ appId: 'wxtestappid000001', package: 'prepay_id=wx201410272009395522657a690389285100', signType: 'RSA' });
    expect(verifyRsa(MERCHANT.publicKey, `${p.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`, p.paySign!)).toBe(true);
    expect(await db.alipayOrder.findUnique({ where: { outTradeNo: res.orderId } })).toMatchObject({ tradeType: 'JSAPI', wxPrepayId: 'wx201410272009395522657a690389285100' });
  });

  it('JSAPI without a WeChat sign-in is refused before any request, whatever openid the caller sends (legacy /billing/checkout path)', async () => {
    const { db, f, rail } = railWith(() => [200, { prepay_id: 'wx1' }]);
    await db.rAAuthIdentity.create({ data: { id: 'i_2', userId: 'u_2', brand: 'goapply', provider: 'wechat', appId: 'wxtestappid000001', subject: 'oOtherUser', lastUsedAt: new Date() } });
    await expect(rail.createCheckout(order('pro_monthly', { tradeType: 'jsapi', openId: 'oOtherUser' }))).rejects.toMatchObject({ code: 'payment_provider_error' });
    expect(f.calls).toHaveLength(0);
    expect(await db.alipayOrder.findMany({})).toHaveLength(0);
  });

  it('an unsigned (or wrongly signed) response is refused and the order marked failed', async () => {
    const { db, rail } = railWith(() => [200, { code_url: 'weixin://evil' }], { sign: false });
    await expect(rail.createCheckout(order('pro_monthly'))).rejects.toMatchObject({ code: 'payment_provider_error' });
    const rows = await db.alipayOrder.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed' });
  });

  it('a WeChat Pay error is a payment_provider_error and the order is failed', async () => {
    const { db, rail } = railWith(() => [400, { code: 'PARAM_ERROR', message: 'bad' }]);
    await expect(rail.createCheckout(order('pro_monthly'))).rejects.toBeInstanceOf(BillingError);
    expect((await db.alipayOrder.findMany({}))[0]).toMatchObject({ status: 'failed' });
  });

  it('refuses unpriced plans, plans with payments disabled and auto-renewing plans (no auto-debit)', async () => {
    const { rail, f } = railWith(() => [200, { code_url: 'x' }]);
    const unpriced = order('pro_monthly', { tradeType: 'native' }, { ...GA_ENV, CN_PRICE_PRO_MONTHLY_FEN: '' });
    await expect(rail.createCheckout(unpriced)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    const disabled = order('pro_monthly', { tradeType: 'native' }, { ...GA_ENV, CN_PAYMENTS_ENABLED: 'false' });
    await expect(rail.createCheckout(disabled)).rejects.toMatchObject({ code: 'plan_not_sellable' });
    const renewing = order('pro_monthly');
    await expect(rail.createCheckout({ ...renewing, plan: { ...renewing.plan, autoRenews: true, kind: 'subscription' } })).rejects.toMatchObject({ code: 'plan_not_sellable' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('order query and close', () => {
  it('maps the query to paid / closed / pending and returns null for an unknown order', async () => {
    const states: Record<string, [number, unknown]> = {
      A: [200, { mchid: '1900000001', appid: 'wxtestappid000001', out_trade_no: 'A', trade_state: 'SUCCESS', transaction_id: 't1', amount: { total: 3900 } }],
      B: [200, { mchid: '1900000001', out_trade_no: 'B', trade_state: 'CLOSED' }],
      C: [200, { mchid: '1900000001', out_trade_no: 'C', trade_state: 'NOTPAY' }],
      D: [404, { code: 'ORDER_NOT_EXIST' }],
      E: [200, { mchid: '1900000099', out_trade_no: 'E', trade_state: 'SUCCESS' }],
      F: [200, { mchid: '1900000001', out_trade_no: 'F', trade_state: 'SUCCESS', transaction_id: 't6' }],
    };
    const f = wechatFetch((c) => states[c.url.match(/out-trade-no\/(\w)/)![1]!]!, { nowSec });
    const rail = createWechatPayRail({ env: GA_ENV, fetch: f.fetch, getDb: async () => seedDb() as never, now: () => NOW });
    expect(await rail.queryOrder('A')).toEqual({ outTradeNo: 'A', status: 'paid', paidAmountMinor: 3900, transactionId: 't1', tradeState: 'SUCCESS' });
    expect((await rail.queryOrder('B'))?.status).toBe('closed');
    expect((await rail.queryOrder('C'))?.status).toBe('pending');
    expect(await rail.queryOrder('D')).toBeNull();
    expect(await rail.queryOrder('E')).toBeNull();
    // SUCCESS without amount.total is never 'paid' (the amount check is what ties the money to the order).
    expect(await rail.queryOrder('F')).toMatchObject({ status: 'pending', paidAmountMinor: null, tradeState: 'SUCCESS' });
    expect(f.calls[0]!.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/A?mchid=1900000001');
  });

  it('close posts the merchant id and tolerates failure', async () => {
    const f = wechatFetch((c) => (c.url.includes('/X/') ? [204, null] : [400, { code: 'ORDERPAID' }]), { nowSec });
    const rail = createWechatPayRail({ env: GA_ENV, fetch: f.fetch, getDb: async () => seedDb() as never, now: () => NOW });
    expect(await rail.closeOrder('X')).toBe(true);
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ mchid: '1900000001' });
    expect(await rail.closeOrder('Y')).toBe(false);
  });
});

describe('registration through WP-21a', () => {
  afterEach(() => {
    unregisterRail('wechatpay');
  });

  it('ensureWechatPayRail registers once; resolveRail picks it on GoApply when ready, never on RoboApply', () => {
    unregisterRail('wechatpay');
    const impl = ensureWechatPayRail();
    expect(getRegisteredRail('wechatpay')).toBe(impl);
    expect(ensureWechatPayRail()).toBe(impl);
    expect(isWechatPayRail(impl)).toBe(true);
    expect(resolveRail(goapply, 'wechatpay', GA_ENV)).toBe(impl);
    expect(() => resolveRail(goapply, 'wechatpay', { ...GA_ENV, CN_PAYMENT_COLLECTING_ENTITY: '' })).toThrow(/not set up/);
    expect(() => resolveRail(goapply, 'wechatpay', { ...GA_ENV, CN_PAYMENTS_ENABLED: 'false' })).toThrow(/not set up/);
    expect(() => resolveRail(roboapply, 'wechatpay', GA_ENV)).toThrow(/does not take/);
  });

  it('keeps a rail somebody registered first', () => {
    const fake = { id: 'wechatpay' as const, isConfigured: () => true, createCheckout: vi.fn() };
    registerRail('wechatpay', fake);
    expect(ensureWechatPayRail()).toBe(fake);
    expect(isWechatPayRail(fake)).toBe(false);
  });
});

// Keep the helper's platform key referenced (the response signer).
void PLATFORM;
