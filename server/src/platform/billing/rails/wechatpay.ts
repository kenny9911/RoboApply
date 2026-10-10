// server/src/platform/billing/rails/wechatpay.ts
//
// WeChat Pay API v3 rail for GoApply (TASK_PLAN.md WP-62; ARCHITECTURE.md
// §7.4; CN_TW_LAUNCH_PLAN.md WP-PAY, OPS C-13). Registered through WP-21a's
// `registerRail('wechatpay', …)` by `ensureWechatPayRail()` (called by the
// billing-cn router module) — no billing file is edited.
//
//   Checkout   Native (QR on desktop) · H5 (mobile browser) · JSAPI (inside
//              WeChat, with the openid the user's WeChat sign-in recorded under
//              WECHATPAY_APP_ID — looked up here, never taken from the caller). One-time
//              CNY passes and practice packs only: nothing renews, nothing is
//              debited automatically, and the purpose is never `coaching`.
//   Requests   signed with the merchant key (WECHATPAY2-SHA256-RSA2048);
//              responses verified with the WeChat Pay public key.
//   Notify     public-key mode: RSA-SHA256 over "ts\nnonce\nbody\n" on the RAW
//              bytes, serial = WECHATPAY_PUBLIC_KEY_ID, timestamp within 5 min;
//              the resource is AEAD_AES_256_GCM-decrypted with the APIv3 key.
//   Orders     `AlipayOrder` rows (channel 'wechatpay'); fulfilment goes through
//              `fulfilPass()` (the caller does that, idempotently).
//
// Charging stays off (the rail reports itself unconfigured) until:
//   - CN_PAYMENT_COLLECTING_ENTITY names who collects the money, AND
//   - WECHATPAY_MERCHANT_ENTITY (the legal name the merchant account is
//     registered to, entered by the owner) matches it — collecting for
//     another seller risks 二清 (OPS C-13), AND
//   - the public key + id needed to verify notifies are set.
// `pay.wechatpay` (platform/flags.ts) already requires CN_PAYMENTS_ENABLED and
// the merchant credentials; resolveRail/railAvailable combine both.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, type KeyObject } from 'node:crypto';
import { brandEnv, type EnvSource } from '../../brand/brandEnv.js';
import type { ProductBrand } from '../../brand/registry.js';
import type { ExtendedPrismaClient } from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { BillingError } from '../errors.js';
import { appOrigin, callbackOrigin, withQueryParam } from '../origins.js';
import { getRegisteredRail, registerRail } from './registry.js';
import {
  CallbackRejectedError,
  type CallbackInput,
  type CallbackVerification,
  type CheckoutOrder,
  type CheckoutResult,
  type PaymentRailImpl,
} from './types.js';

export const WECHATPAY_API_BASE = 'https://api.mch.weixin.qq.com';
export const WECHATPAY_NOTIFY_PATH = '/api/v1/webhooks/wechatpay';
export const WECHATPAY_SIGNATURE_TYPE = 'WECHATPAY2-SHA256-RSA2048';
/** Notifies and responses older/newer than this are refused (replay window). */
export const WECHATPAY_MAX_SKEW_SEC = 300;
/** How long a WeChat Pay order can be paid (`time_expire`). */
export const WECHATPAY_ORDER_TTL_MINUTES = 15;

export type WechatTradeType = 'native' | 'h5' | 'jsapi';
const TRADE_PATH: Record<WechatTradeType, string> = {
  native: '/v3/pay/transactions/native',
  h5: '/v3/pay/transactions/h5',
  jsapi: '/v3/pay/transactions/jsapi',
};
const TRADE_TYPE_COLUMN: Record<WechatTradeType, 'NATIVE' | 'H5' | 'JSAPI'> = { native: 'NATIVE', h5: 'H5', jsapi: 'JSAPI' };

// ── Configuration ──────────────────────────────────────────────────────────

export interface WechatPayConfig {
  mchId: string;
  appId: string;
  apiV3Key: string;
  mchCertSerial: string;
  mchPrivateKey: string;
  publicKeyId: string;
  publicKey: string;
  notifyUrl: string | null;
  /** The legal name the merchant account is registered to (owner-entered). */
  merchantEntity: string | null;
}

/** PEM from env: tolerate literal "\n" escapes and surrounding quotes. */
export function normalizePem(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').trim();
}

function envValue(env: EnvSource, name: string): string {
  return (env[name] ?? '').trim();
}

export function readWechatPayConfig(env: EnvSource = process.env): WechatPayConfig {
  return {
    mchId: envValue(env, 'WECHATPAY_MCH_ID'),
    appId: envValue(env, 'WECHATPAY_APP_ID'),
    apiV3Key: envValue(env, 'WECHATPAY_API_V3_KEY'),
    mchCertSerial: envValue(env, 'WECHATPAY_MCH_CERT_SERIAL'),
    mchPrivateKey: normalizePem(env.WECHATPAY_MCH_PRIVATE_KEY),
    publicKeyId: envValue(env, 'WECHATPAY_PUBLIC_KEY_ID'),
    publicKey: normalizePem(env.WECHATPAY_PUBLIC_KEY),
    notifyUrl: envValue(env, 'WECHATPAY_NOTIFY_URL') || null,
    merchantEntity: envValue(env, 'WECHATPAY_MERCHANT_ENTITY') || null,
  };
}

/** Compare legal names: case, width of brackets and whitespace do not matter. */
export function normalizeEntityName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFKC')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export type WechatPayNotReadyReason =
  | 'wrong_market'
  | 'credentials_missing'
  | 'api_v3_key_invalid'
  | 'public_key_missing'
  | 'collecting_entity_missing'
  | 'merchant_entity_missing'
  | 'entity_mismatch';

export interface WechatPayReadiness {
  ready: boolean;
  reason: WechatPayNotReadyReason | null;
  /** Who collects the money (named on the order, the receipt and the 用户协议). */
  collectingEntity: string | null;
}

/**
 * Whether WeChat Pay may take money on this brand. The capability flag checks
 * CN_PAYMENTS_ENABLED and the merchant credentials; this adds what charging
 * needs on top (OPS C-13: the collecting entity is the merchant).
 */
export function wechatPayReadiness(brand: ProductBrand, env: EnvSource = process.env): WechatPayReadiness {
  const entity = brandEnv(brand, 'PAYMENT_COLLECTING_ENTITY', env)?.trim() || null;
  const no = (reason: WechatPayNotReadyReason): WechatPayReadiness => ({ ready: false, reason, collectingEntity: entity });
  if (brand.market !== 'cn' || !brand.paymentRails.includes('wechatpay')) return no('wrong_market');
  const c = readWechatPayConfig(env);
  if (!c.mchId || !c.appId || !c.mchCertSerial || !c.mchPrivateKey) return no('credentials_missing');
  if (Buffer.byteLength(c.apiV3Key, 'utf8') !== 32) return no('api_v3_key_invalid');
  if (!c.publicKeyId || !c.publicKey) return no('public_key_missing');
  if (!entity) return no('collecting_entity_missing');
  if (!c.merchantEntity) return no('merchant_entity_missing');
  if (normalizeEntityName(c.merchantEntity) !== normalizeEntityName(entity)) return no('entity_mismatch');
  return { ready: true, reason: null, collectingEntity: entity };
}

// ── Crypto (pure) ──────────────────────────────────────────────────────────

function toPrivateKey(pem: string | KeyObject): KeyObject {
  return typeof pem === 'string' ? createPrivateKey(pem) : pem;
}

function toPublicKey(pem: string | KeyObject): KeyObject {
  return typeof pem === 'string' ? createPublicKey(pem) : pem;
}

/** SHA256withRSA, base64 — the signature WeChat Pay v3 uses everywhere. */
export function rsaSign(privateKey: string | KeyObject, message: string): string {
  const s = createSign('RSA-SHA256');
  s.update(message, 'utf8');
  s.end();
  return s.sign(toPrivateKey(privateKey), 'base64');
}

export function rsaVerify(publicKey: string | KeyObject, message: string, signatureB64: string): boolean {
  try {
    const v = createVerify('RSA-SHA256');
    v.update(message, 'utf8');
    v.end();
    return v.verify(toPublicKey(publicKey), signatureB64, 'base64');
  } catch {
    return false;
  }
}

/** The message a merchant request signs: METHOD\nURL\nTS\nNONCE\nBODY\n. */
export function requestSignMessage(method: string, urlPathWithQuery: string, timestamp: string, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${urlPathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
}

/** The message WeChat Pay signs on notifies and responses: TS\nNONCE\nBODY\n. */
export function wechatSignMessage(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

export function buildAuthorization(input: {
  mchId: string;
  serialNo: string;
  privateKey: string | KeyObject;
  method: string;
  urlPathWithQuery: string;
  body: string;
  timestamp: string;
  nonce: string;
}): string {
  const signature = rsaSign(input.privateKey, requestSignMessage(input.method, input.urlPathWithQuery, input.timestamp, input.nonce, input.body));
  return `${WECHATPAY_SIGNATURE_TYPE} mchid="${input.mchId}",nonce_str="${input.nonce}",signature="${signature}",timestamp="${input.timestamp}",serial_no="${input.serialNo}"`;
}

/** JSAPI `paySign` over appId\ntimeStamp\nnonceStr\npackage\n. */
export function jsapiPaySign(privateKey: string | KeyObject, p: { appId: string; timeStamp: string; nonceStr: string; package: string }): string {
  return rsaSign(privateKey, `${p.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`);
}

/** AEAD_AES_256_GCM decrypt of a notify resource (the auth tag is the last 16 bytes). */
export function decryptResource(apiV3Key: string, r: { nonce: string; associatedData?: string | null; ciphertext: string }): string {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new Error('APIv3 key must be 32 bytes');
  const data = Buffer.from(r.ciphertext, 'base64');
  if (data.length <= 16) throw new Error('ciphertext too short');
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(r.nonce, 'utf8'));
  d.setAuthTag(tag);
  if (r.associatedData) d.setAAD(Buffer.from(r.associatedData, 'utf8'));
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/** The inverse of `decryptResource` (tests and fixture generation only). */
export function encryptResource(apiV3Key: string, r: { nonce: string; associatedData?: string | null; plaintext: string }): string {
  const c = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(r.nonce, 'utf8'));
  if (r.associatedData) c.setAAD(Buffer.from(r.associatedData, 'utf8'));
  const enc = Buffer.concat([c.update(r.plaintext, 'utf8'), c.final()]);
  return Buffer.concat([enc, c.getAuthTag()]).toString('base64');
}

function header(headers: CallbackInput['headers'] | Headers, name: string): string {
  if (typeof (headers as Headers).get === 'function') return ((headers as Headers).get(name) ?? '').trim();
  const h = headers as CallbackInput['headers'];
  const v = h[name] ?? h[name.toLowerCase()] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return (Array.isArray(v) ? v[0] : v ?? '').trim();
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing_headers' | 'wrong_type' | 'wrong_serial' | 'stale' | 'bad_signature' };

/**
 * Verify a WeChat Pay signature (notify or API response) over the exact bytes
 * received. Public-key mode: the serial is our WECHATPAY_PUBLIC_KEY_ID.
 */
export function verifyWechatSignature(input: {
  headers: CallbackInput['headers'] | Headers;
  body: Buffer | string;
  publicKey: string | KeyObject;
  publicKeyId: string;
  nowSec: number;
  maxSkewSec?: number;
}): SignatureCheck {
  const ts = header(input.headers, 'wechatpay-timestamp');
  const nonce = header(input.headers, 'wechatpay-nonce');
  const signature = header(input.headers, 'wechatpay-signature');
  const serial = header(input.headers, 'wechatpay-serial');
  const type = header(input.headers, 'wechatpay-signature-type');
  if (!ts || !nonce || !signature || !serial) return { ok: false, reason: 'missing_headers' };
  if (type && type !== WECHATPAY_SIGNATURE_TYPE) return { ok: false, reason: 'wrong_type' };
  if (serial !== input.publicKeyId) return { ok: false, reason: 'wrong_serial' };
  if (!/^\d{1,12}$/.test(ts) || Math.abs(input.nowSec - Number(ts)) > (input.maxSkewSec ?? WECHATPAY_MAX_SKEW_SEC)) return { ok: false, reason: 'stale' };
  const body = typeof input.body === 'string' ? input.body : input.body.toString('utf8');
  return rsaVerify(input.publicKey, wechatSignMessage(ts, nonce, body), signature) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// ── Order numbers and times ────────────────────────────────────────────────

/** 'GAWX' + yyyymmddhhmmss (UTC) + 12 hex = 30 chars (WeChat allows 6–32, [A-Za-z0-9_-|*]). */
export function newWechatOutTradeNo(now: Date, rand: (n: number) => Buffer = randomBytes): string {
  const ts = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  return `GAWX${ts}${rand(6).toString('hex')}`;
}

/** RFC 3339 in China Standard Time, e.g. 2026-10-10T16:15:00+08:00. */
export function toCstRfc3339(date: Date): string {
  return `${new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19)}+08:00`;
}

export function orderExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + WECHATPAY_ORDER_TTL_MINUTES * 60_000);
}

// ── Transaction mapping ────────────────────────────────────────────────────

/** The decrypted `transaction` resource / the order-query body (fields we read). */
export interface WechatTransaction {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_type?: string;
  trade_state?: string;
  success_time?: string;
  amount?: { total?: number; payer_total?: number; currency?: string };
}

export function mapTradeState(state: string | undefined): CallbackVerification['status'] {
  switch (state) {
    case 'SUCCESS':
      return 'paid';
    case 'CLOSED':
    case 'REVOKED':
    case 'PAYERROR':
      return 'closed';
    default:
      // NOTPAY, USERPAYING — and REFUND: a refunded order is never fulfilled
      // from a query (refunds are handled by staff in the merchant console).
      return 'pending';
  }
}

// ── Rail ───────────────────────────────────────────────────────────────────

export type WechatRailDb = Pick<ExtendedPrismaClient, 'alipayOrder' | 'rAAuthIdentity'>;

/**
 * The user's openid under the paying app, from their WeChat sign-in record
 * (`RAAuthIdentity`, provider 'wechat', appId = WECHATPAY_APP_ID), or null.
 * JSAPI only ever pays with this openid: nothing a caller sends is trusted,
 * so every route that reaches this rail (including WP-21a's legacy
 * /billing/checkout) gets the same rule.
 */
export async function wechatOpenIdFor(
  db: Pick<ExtendedPrismaClient, 'rAAuthIdentity'>,
  input: { userId: string; brandId: string; appId: string },
): Promise<string | null> {
  if (!input.appId) return null;
  const row = await db.rAAuthIdentity.findFirst({
    where: { userId: input.userId, brand: input.brandId, provider: 'wechat', appId: input.appId },
    orderBy: { lastUsedAt: 'desc' },
    select: { subject: true },
  });
  return row?.subject ?? null;
}

export interface WechatRailDeps {
  fetch?: typeof fetch;
  getDb?: () => Promise<WechatRailDb>;
  /** Env read at call time (default process.env). */
  env?: EnvSource;
  now?: () => Date;
  random?: (n: number) => Buffer;
}

/** What a CN checkout may carry beyond the shared `CheckoutOrder.context`. */
export interface WechatCheckoutContext {
  tradeType?: WechatTradeType;
  // No openId here on purpose: JSAPI looks the payer's openid up server-side
  // (`wechatOpenIdFor`), so an `openId` a caller puts in the context is ignored.
  /** Required for H5 (`scene_info.payer_client_ip`). */
  payerClientIp?: string;
}

export type WechatCheckoutResult = CheckoutResult & { expiresAt: string; collectingEntity: string };

export interface WechatQueryResult extends CallbackVerification {
  tradeState: string | null;
}

export interface WechatPayRail extends PaymentRailImpl {
  id: 'wechatpay';
  createCheckout(order: CheckoutOrder): Promise<WechatCheckoutResult>;
  verifyCallback(input: CallbackInput): Promise<CallbackVerification>;
  /** Active query (`GET /v3/pay/transactions/out-trade-no/{no}`); null when WeChat has no such order. */
  queryOrder(outTradeNo: string): Promise<WechatQueryResult | null>;
  /** Close an unpaid order at WeChat Pay (best effort). */
  closeOrder(outTradeNo: string): Promise<boolean>;
}

const defaultGetDb = async (): Promise<WechatRailDb> => (await import('../../../lib/prisma.js')).default;

class WechatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'WechatApiError';
  }
}

export function createWechatPayRail(deps: WechatRailDeps = {}): WechatPayRail {
  const getDb = deps.getDb ?? defaultGetDb;
  const now = deps.now ?? (() => new Date());
  const rand = deps.random ?? randomBytes;
  const env = () => deps.env ?? process.env;

  async function api<T>(method: 'GET' | 'POST', pathWithQuery: string, body: unknown): Promise<{ status: number; data: T | null }> {
    const c = readWechatPayConfig(env());
    const doFetch = deps.fetch ?? fetch;
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(now().getTime() / 1000));
    const nonce = rand(16).toString('hex');
    const authorization = buildAuthorization({
      mchId: c.mchId,
      serialNo: c.mchCertSerial,
      privateKey: c.mchPrivateKey,
      method,
      urlPathWithQuery: pathWithQuery,
      body: payload,
      timestamp,
      nonce,
    });
    let res: Response;
    try {
      res = await doFetch(`${WECHATPAY_API_BASE}${pathWithQuery}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'goapply-billing/1.0',
          Authorization: authorization,
          'Wechatpay-Serial': c.publicKeyId,
        },
        ...(method === 'POST' ? { body: payload } : {}),
      });
    } catch (err) {
      logger.error('RA_BILLING', 'wechatpay request failed', { path: pathWithQuery.split('?')[0], error: err instanceof Error ? err.message : String(err) });
      throw new BillingError('payment_provider_error', 'Could not reach WeChat Pay', { provider: 'wechatpay' });
    }
    const text = await res.text();
    if (res.status === 404) return { status: 404, data: null };
    if (res.status < 200 || res.status >= 300) {
      let code: string | null = null;
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? null;
      } catch {
        /* not JSON */
      }
      logger.error('RA_BILLING', 'wechatpay error response', { path: pathWithQuery.split('?')[0], status: res.status, code });
      throw new WechatApiError('WeChat Pay refused the request', res.status, code);
    }
    // Responses are signed like notifies; refuse anything we cannot verify.
    const check = verifyWechatSignature({
      headers: res.headers,
      body: text,
      publicKey: c.publicKey,
      publicKeyId: c.publicKeyId,
      nowSec: Math.floor(now().getTime() / 1000),
    });
    if (!check.ok) {
      logger.error('RA_BILLING', 'wechatpay response signature invalid', { path: pathWithQuery.split('?')[0], reason: check.reason });
      throw new BillingError('payment_provider_error', 'WeChat Pay returned an unverifiable response', { provider: 'wechatpay' });
    }
    if (!text) return { status: res.status, data: null };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      throw new BillingError('payment_provider_error', 'WeChat Pay returned an unexpected response', { provider: 'wechatpay' });
    }
  }

  function fromQuery(t: WechatTransaction, outTradeNo: string): WechatQueryResult {
    const total = typeof t.amount?.total === 'number' ? t.amount.total : null;
    let status = mapTradeState(t.trade_state);
    if (status === 'paid' && total === null) {
      // The paid amount is the only check that ties the money to the order:
      // a SUCCESS without it is never fulfilled (the notify or a later query decides).
      logger.warn('RA_BILLING', 'wechatpay query SUCCESS without amount', { outTradeNo });
      status = 'pending';
    }
    return {
      outTradeNo: t.out_trade_no ?? outTradeNo,
      status,
      paidAmountMinor: total,
      transactionId: t.transaction_id ?? null,
      tradeState: t.trade_state ?? null,
    };
  }

  const rail: WechatPayRail = {
    id: 'wechatpay',
    isConfigured: (brand, e) => wechatPayReadiness(brand, e).ready,

    async createCheckout(order: CheckoutOrder): Promise<WechatCheckoutResult> {
      const e = env();
      const { brand, plan } = order;
      const readiness = wechatPayReadiness(brand, e);
      if (!readiness.ready || !readiness.collectingEntity) {
        throw new BillingError('rail_not_configured', 'Payments are not open yet', { rail: 'wechatpay', reason: readiness.reason });
      }
      if (!plan.sellable || plan.amountMinor === null || plan.amountMinor <= 0) {
        throw new BillingError('plan_not_sellable', 'This plan is not on sale', { planKey: plan.key });
      }
      // CN rails sell one-time passes and packs only: no auto-renewal, no
      // auto-debit, and never a payment on someone else's behalf (coaching).
      if (plan.autoRenews || (plan.kind !== 'pass' && plan.kind !== 'pack')) {
        throw new BillingError('plan_not_sellable', 'This plan cannot be bought with WeChat Pay', { planKey: plan.key });
      }
      const ctx = (order.context ?? {}) as WechatCheckoutContext;
      const tradeType: WechatTradeType = ctx.tradeType ?? 'native';
      if (tradeType === 'h5' && !ctx.payerClientIp) {
        throw new BillingError('payment_provider_error', 'Mobile payment needs the payer address', { provider: 'wechatpay', reason: 'payer_ip_missing' });
      }
      const c = readWechatPayConfig(e);
      const db = await getDb();
      // Never the caller's openid: only the one WeChat sign-in recorded.
      const payerOpenId = tradeType === 'jsapi' ? await wechatOpenIdFor(db, { userId: order.user.id, brandId: brand.id, appId: c.appId }) : null;
      if (tradeType === 'jsapi' && !payerOpenId) {
        throw new BillingError('payment_provider_error', 'WeChat in-app payment needs your WeChat account', { provider: 'wechatpay', reason: 'openid_missing' });
      }
      const createdAt = now();
      const expiresAt = orderExpiresAt(createdAt);
      const outTradeNo = newWechatOutTradeNo(createdAt, rand);
      const purpose = plan.kind === 'pack' ? 'interview_pack' : 'subscription';
      const notifyUrl = c.notifyUrl || `${callbackOrigin(brand, e)}${WECHATPAY_NOTIFY_PATH}`;

      // The order row exists before WeChat Pay knows the order, so a notify
      // can never arrive for an order we have no record of.
      await db.alipayOrder.create({
        data: {
          userId: order.user.id,
          outTradeNo,
          tier: `ra_${plan.key}`,
          amount: plan.amountMinor / 100,
          amountMinor: plan.amountMinor,
          status: 'pending',
          channel: 'wechatpay',
          brand: brand.id,
          planKey: plan.key,
          purpose,
          tradeType: TRADE_TYPE_COLUMN[tradeType],
          createdAt,
        },
      });

      const body: Record<string, unknown> = {
        appid: c.appId,
        mchid: c.mchId,
        description: `${brand.name} ${plan.defaultLabel}`.slice(0, 127),
        out_trade_no: outTradeNo,
        time_expire: toCstRfc3339(expiresAt),
        attach: `plan=${plan.key}`,
        notify_url: notifyUrl,
        amount: { total: plan.amountMinor, currency: 'CNY' },
      };
      if (tradeType === 'jsapi') body.payer = { openid: payerOpenId };
      if (tradeType === 'h5') {
        body.scene_info = { payer_client_ip: ctx.payerClientIp, h5_info: { type: 'Wap', app_name: brand.name, app_url: appOrigin(brand, e) } };
      }

      let data: { code_url?: string; h5_url?: string; prepay_id?: string } | null;
      try {
        data = (await api<{ code_url?: string; h5_url?: string; prepay_id?: string }>('POST', TRADE_PATH[tradeType], body)).data;
      } catch (err) {
        await db.alipayOrder.updateMany({ where: { outTradeNo, status: 'pending' }, data: { status: 'failed' } }).catch(() => undefined);
        if (err instanceof BillingError) throw err;
        throw new BillingError('payment_provider_error', 'WeChat Pay could not create the order', {
          provider: 'wechatpay',
          ...(err instanceof WechatApiError && err.code ? { providerCode: err.code } : {}),
        });
      }

      const base = { orderId: outTradeNo, expiresAt: expiresAt.toISOString(), collectingEntity: readiness.collectingEntity };
      let result: WechatCheckoutResult;
      if (tradeType === 'native' && data?.code_url) {
        await db.alipayOrder.update({ where: { outTradeNo }, data: { wxCodeUrl: data.code_url } });
        result = { kind: 'qr', qrCodeUrl: data.code_url, ...base };
      } else if (tradeType === 'h5' && data?.h5_url) {
        // Back to our page with the order number, so the page can ask for its status.
        const back = `${appOrigin(brand, e)}${withQueryParam(order.successPath ?? '/settings/billing', 'order', outTradeNo)}`;
        const url = `${data.h5_url}${data.h5_url.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(back)}`;
        result = { kind: 'redirect', url, ...base };
      } else if (tradeType === 'jsapi' && data?.prepay_id) {
        await db.alipayOrder.update({ where: { outTradeNo }, data: { wxPrepayId: data.prepay_id } });
        const p = { appId: c.appId, timeStamp: String(Math.floor(now().getTime() / 1000)), nonceStr: rand(16).toString('hex'), package: `prepay_id=${data.prepay_id}` };
        result = { kind: 'jsapi', jsapiParams: { ...p, signType: 'RSA', paySign: jsapiPaySign(c.mchPrivateKey, p) }, ...base };
      } else {
        await db.alipayOrder.updateMany({ where: { outTradeNo, status: 'pending' }, data: { status: 'failed' } }).catch(() => undefined);
        throw new BillingError('payment_provider_error', 'WeChat Pay returned an unexpected response', { provider: 'wechatpay' });
      }
      logger.info('RA_BILLING', 'wechatpay order created', { userId: order.user.id, planKey: plan.key, outTradeNo, tradeType, brand: brand.id });
      return result;
    },

    async verifyCallback(input: CallbackInput): Promise<CallbackVerification> {
      const c = readWechatPayConfig(env());
      if (!c.publicKey || !c.publicKeyId || Buffer.byteLength(c.apiV3Key, 'utf8') !== 32) {
        logger.error('RA_BILLING', 'wechatpay notify refused: public key or APIv3 key not configured');
        throw new CallbackRejectedError('wechatpay notify verification is not configured', 'not_configured');
      }
      if (!Buffer.isBuffer(input.rawBody)) throw new CallbackRejectedError('the notify must be verified on the raw body', 'invalid_params');
      const check = verifyWechatSignature({
        headers: input.headers,
        body: input.rawBody,
        publicKey: c.publicKey,
        publicKeyId: c.publicKeyId,
        nowSec: Math.floor(now().getTime() / 1000),
      });
      if (!check.ok) throw new CallbackRejectedError(`notify signature rejected (${check.reason})`, 'bad_secret');

      let event: { event_type?: string; resource?: { algorithm?: string; ciphertext?: string; nonce?: string; associated_data?: string; original_type?: string } };
      try {
        event = JSON.parse(input.rawBody.toString('utf8')) as typeof event;
      } catch {
        throw new CallbackRejectedError('notify body is not JSON', 'invalid_params');
      }
      const r = event.resource;
      if (!r || r.algorithm !== 'AEAD_AES_256_GCM' || !r.ciphertext || !r.nonce) throw new CallbackRejectedError('notify resource missing', 'invalid_params');
      let tx: WechatTransaction & { refund_status?: string };
      try {
        tx = JSON.parse(decryptResource(c.apiV3Key, { nonce: r.nonce, associatedData: r.associated_data ?? null, ciphertext: r.ciphertext })) as typeof tx;
      } catch {
        // A valid signature with an undecryptable resource: wrong APIv3 key.
        throw new CallbackRejectedError('notify resource could not be decrypted', 'not_configured');
      }
      if (!tx.out_trade_no) throw new CallbackRejectedError('notify has no out_trade_no', 'invalid_params');
      if ((tx.mchid && tx.mchid !== c.mchId) || (tx.appid && tx.appid !== c.appId)) {
        throw new CallbackRejectedError('notify is for another merchant or app', 'invalid_params');
      }
      if (tx.amount?.currency && tx.amount.currency !== 'CNY') throw new CallbackRejectedError('notify currency is not CNY', 'invalid_params');
      const isTransaction = (event.event_type ?? '').startsWith('TRANSACTION.') && (r.original_type ?? 'transaction') === 'transaction';
      if (!isTransaction) {
        // Refund events etc. are acknowledged and logged; staff handle refunds.
        logger.warn('RA_BILLING', 'wechatpay non-transaction notify acknowledged', { eventType: event.event_type, outTradeNo: tx.out_trade_no });
        return { outTradeNo: tx.out_trade_no, status: 'pending', paidAmountMinor: null, transactionId: tx.transaction_id ?? null };
      }
      const status = mapTradeState(tx.trade_state);
      const total = typeof tx.amount?.total === 'number' ? tx.amount.total : null;
      // A paid notify must state the amount (fulfilPass compares it with the order).
      if (status === 'paid' && total === null) throw new CallbackRejectedError('notify has no amount', 'invalid_params');
      return {
        outTradeNo: tx.out_trade_no,
        status,
        paidAmountMinor: total,
        transactionId: tx.transaction_id ?? null,
      };
    },

    async queryOrder(outTradeNo: string): Promise<WechatQueryResult | null> {
      const c = readWechatPayConfig(env());
      const res = await api<WechatTransaction>('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(c.mchId)}`, undefined);
      if (res.status === 404 || !res.data) return null;
      if ((res.data.mchid && res.data.mchid !== c.mchId) || (res.data.appid && res.data.appid !== c.appId)) return null;
      return fromQuery(res.data, outTradeNo);
    },

    async closeOrder(outTradeNo: string): Promise<boolean> {
      const c = readWechatPayConfig(env());
      try {
        await api('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, { mchid: c.mchId });
        return true;
      } catch (err) {
        logger.warn('RA_BILLING', 'wechatpay close failed', { outTradeNo, error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
  };
  return rail;
}

/**
 * Register the WeChat Pay rail unless one is registered already (a test or a
 * later wave may register its own). Returns the registered implementation.
 */
export function ensureWechatPayRail(deps: WechatRailDeps = {}): PaymentRailImpl {
  const existing = getRegisteredRail('wechatpay');
  if (existing) return existing;
  const rail = createWechatPayRail(deps);
  registerRail('wechatpay', rail);
  return rail;
}

/** True when `impl` is a full WeChat Pay rail (query/close available). */
export function isWechatPayRail(impl: PaymentRailImpl | null | undefined): impl is WechatPayRail {
  return Boolean(impl && impl.id === 'wechatpay' && typeof (impl as Partial<WechatPayRail>).queryOrder === 'function');
}
