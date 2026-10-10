// Test helpers for WP-62 (WeChat Pay). No network: fetch is a stub that
// answers with responses signed by a throwaway "WeChat Pay" key.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { NOTIFY_VECTOR } from './wechatpayVectors.js';

function pemPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** The merchant's own key (signs our requests). */
export const MERCHANT = pemPair();
/** A stand-in for WeChat Pay's key (signs API responses in these tests). */
export const PLATFORM = pemPair();
export const PLATFORM_KEY_ID = 'PUB_KEY_ID_TEST_PLATFORM_0001';

export const ENTITY = '测试科技（上海）有限公司';

/** GoApply with WeChat Pay fully configured (entity matches the merchant). */
export const GA_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  CN_PAYMENTS_ENABLED: 'true',
  WECHATPAY_MCH_ID: '1900000001',
  WECHATPAY_APP_ID: 'wxtestappid000001',
  WECHATPAY_API_V3_KEY: NOTIFY_VECTOR.apiV3Key,
  WECHATPAY_MCH_CERT_SERIAL: 'MCHSERIAL0001',
  WECHATPAY_MCH_PRIVATE_KEY: MERCHANT.privateKey,
  WECHATPAY_PUBLIC_KEY_ID: PLATFORM_KEY_ID,
  WECHATPAY_PUBLIC_KEY: PLATFORM.publicKey,
  CN_PAYMENT_COLLECTING_ENTITY: ENTITY,
  WECHATPAY_MERCHANT_ENTITY: '测试科技(上海)有限公司',
  CN_BACKEND_URL: 'https://api.goapply.test',
  CN_PRICE_PRO_WEEK_PASS_FEN: '1200',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRO_QUARTERLY_FEN: '9900',
  CN_PRICE_PRACTICE_PACK_5_FEN: '2900',
  CN_PRICE_PRACTICE_PACK_15_FEN: '7900',
  /** The published GoApply 用户协议 version (what GET /public/legal/terms returns). */
  CN_LEGAL_DOCS_VERSION: 'cn-terms-2026-10',
};

/** The same, but verifying notifies with the fixture vector's public key. */
export const GA_ENV_VECTOR: Record<string, string> = {
  ...GA_ENV,
  WECHATPAY_PUBLIC_KEY_ID: NOTIFY_VECTOR.publicKeyId,
  WECHATPAY_PUBLIC_KEY: NOTIFY_VECTOR.publicKey,
};

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A fetch stub. `respond` returns [status, json-or-null]; the response is
 * signed with PLATFORM unless `sign` is false.
 */
export function wechatFetch(
  respond: (call: RecordedCall) => [number, unknown] | Promise<[number, unknown]>,
  opts: { sign?: boolean; nowSec: () => number; signer?: { privateKey: string; keyId: string } } ,
) {
  const calls: RecordedCall[] = [];
  const signer = opts.signer ?? { privateKey: PLATFORM.privateKey, keyId: PLATFORM_KEY_ID };
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : '' };
    calls.push(call);
    const [status, json] = await respond(call);
    const text = json === null || json === undefined ? '' : JSON.stringify(json);
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.sign !== false) {
      const { rsaSign, wechatSignMessage } = await import('../../../platform/billing/rails/wechatpay.js');
      const ts = String(opts.nowSec());
      const nonce = randomBytes(8).toString('hex');
      h['wechatpay-timestamp'] = ts;
      h['wechatpay-nonce'] = nonce;
      h['wechatpay-serial'] = signer.keyId;
      h['wechatpay-signature-type'] = 'WECHATPAY2-SHA256-RSA2048';
      h['wechatpay-signature'] = rsaSign(signer.privateKey, wechatSignMessage(ts, nonce, text));
    }
    return new Response(status === 204 ? null : text, { status, headers: h });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function seedDb(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createFakePrisma({
    seed: {
      user: [{ id: 'u_1', email: 'u1@example.test', name: '测试', brand: 'goapply' }],
      seekerProfile: [{ id: 'sp_1', userId: 'u_1', locale: 'zh', market: 'cn' }],
      seekerSubscription: [],
      alipayOrder: [],
      rAAuthIdentity: [],
      ...extra,
    },
  });
}

/** Parse the `Authorization` header we send. */
export function parseAuthorization(value: string): Record<string, string> {
  const [scheme, rest] = [value.slice(0, value.indexOf(' ')), value.slice(value.indexOf(' ') + 1)];
  const out: Record<string, string> = { scheme };
  for (const m of rest.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** Fixed-window limiter over a Map (same semantics as the platform consumeRateLimit). */
export function memoryRateLimit(now: () => Date = () => new Date()) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const consume = async (key: string, windows: readonly { limit: number; windowSec: number }[]) => {
    keys.push(key);
    let allowed = true;
    let retryAfterSec = 0;
    for (const w of windows) {
      const ms = w.windowSec * 1000;
      const start = Math.floor(now().getTime() / ms) * ms;
      const k = `${key}:${w.windowSec}:${start}`;
      const count = (counts.get(k) ?? 0) + 1;
      counts.set(k, count);
      if (count > w.limit) {
        allowed = false;
        retryAfterSec = Math.max(retryAfterSec, Math.ceil((start + ms - now().getTime()) / 1000));
      }
    }
    return { allowed, retryAfterSec };
  };
  return { consume, keys };
}
