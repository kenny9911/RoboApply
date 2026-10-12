// Test kit for the auth-cn area: an in-memory fake Prisma with the schema
// defaults these services rely on, a fixed-window rate limiter, a recording
// SMS service and a controllable clock. No network, no database.

import { createFakePrisma } from '../../../test/fakePrisma.js';
import type { RateLimitResult } from '../../../platform/ratelimit/index.js';
import type { RateWindow } from '../../../platform/ratelimit/defaults.js';
import type { OtpSms, SmsSendResult } from '../../../platform/sms/index.js';
import type { EnvSource } from '../../../platform/brand/brandEnv.js';
import type { AuthCnDb } from '../db.js';
import { createAuthCnServices, type AuthCnServices } from '../services.js';
import type { AccountHooks } from '../hooks.js';
import type { SignInGate } from '../accounts.js';
import { getBrand } from '../../../platform/brand/registry.js';
import { findConsentDefinition, resolveConsentProse } from '../../compliance/index.js';

/** Hooks that record every call (hooks.ts): invite attribution, invite check, the phone practice credit. */
export function recordingHooks() {
  const calls = {
    attribution: [] as Array<{ userId: string; touch: Record<string, unknown>; options: Record<string, unknown> }>,
    referralChecks: [] as string[],
    phoneCredits: [] as string[],
  };
  const hooks: AccountHooks = {
    async recordAttribution(userId, touch, options) {
      calls.attribution.push({ userId, touch: { ...touch }, options: { ...options } });
    },
    async checkReferral(userId) {
      calls.referralChecks.push(userId);
    },
    async grantPhoneCredit(userId) {
      calls.phoneCredits.push(userId);
    },
  };
  return { hooks, calls };
}

export function fakeDb(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const fake = createFakePrisma({
    seed,
    defaults: {
      user: { isActive: true, passwordHash: null, phoneE164: null, phoneVerifiedAt: null, emailIsPlaceholder: false, brand: 'roboapply', role: 'seeker' },
      seekerProfile: { deletedAt: null, onboardingStep: 'done' },
      rAPhoneOtp: { attempts: 0, consumedAt: null },
      rABrandInvite: { uses: 0, expiresAt: null, note: null },
      rAAuthToken: { consumedAt: null, userId: null, payload: null },
      rAAuthIdentity: { unionId: null, lastUsedAt: null, appId: '' },
    },
    uniqueFields: { user: ['email'], rABrandInvite: ['codeHash'], rAAuthToken: ['tokenHash'] },
  });
  return { fake, db: fake as unknown as AuthCnDb };
}

export function clock(start = '2026-10-10T08:00:00.000Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

/** Fixed-window limiter over a Map (same semantics as platform consumeRateLimit). */
export function memoryLimiter(now: () => Date) {
  const counts = new Map<string, number>();
  let failing = false;
  const consume = async (key: string, windows: readonly RateWindow[]): Promise<RateLimitResult> => {
    if (failing) throw new Error('db down');
    const at = now().getTime();
    const states = windows.map((w) => {
      const start = Math.floor(at / (w.windowSec * 1000)) * w.windowSec * 1000;
      const k = `${key}:${w.windowSec}:${start}`;
      const count = (counts.get(k) ?? 0) + 1;
      counts.set(k, count);
      return { windowSec: w.windowSec, limit: w.limit, count, windowStart: new Date(start), resetAt: new Date(start + w.windowSec * 1000) };
    });
    const blocked = states.filter((s) => s.count > s.limit);
    const retryAfterSec = blocked.length ? Math.max(...blocked.map((s) => Math.max(1, Math.ceil((s.resetAt.getTime() - at) / 1000)))) : 0;
    return { allowed: blocked.length === 0, retryAfterSec, remaining: 0, windows: states };
  };
  return {
    consume,
    fail(on: boolean) {
      failing = on;
    },
  };
}

export function recordingSms(result: Partial<SmsSendResult> = {}) {
  const sent: OtpSms[] = [];
  let next: Partial<SmsSendResult> = result;
  return {
    sent,
    setResult(r: Partial<SmsSendResult>) {
      next = r;
    },
    async sendOtp(m: OtpSms): Promise<SmsSendResult> {
      sent.push(m);
      return { ok: true, provider: 'dev_console', ...next };
    },
    lastCode(): string {
      const m = sent[sent.length - 1];
      if (!m) throw new Error('no SMS sent');
      return m.code;
    },
  };
}

/**
 * No `CN_SIGNUP_MODE`: sign-up is open by default (D5). A test that wants the
 * invite or the closed mode sets it.
 */
export const BASE_ENV: EnvSource = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret',
  SMS_DEV_CONSOLE: 'true',
  WECHAT_OPEN_APP_ID: 'wx_open',
  WECHAT_OPEN_APP_SECRET: 'open_secret',
  WECHAT_MP_APP_ID: 'wx_mp',
  WECHAT_MP_APP_SECRET: 'mp_secret',
  WECHAT_MINI_APP_ID: 'wx_mini',
  WECHAT_MINI_APP_SECRET: 'mini_secret',
  CN_CANONICAL_ORIGIN: 'https://www.goapply.top',
};

/**
 * A mainland deployment on which nothing of GoApply leaves the mainland: every
 * stack is its own (`brandUsesSharedStack('goapply')` is false). The only
 * shape in which a new account is not asked for the cross-border consent.
 */
// The values are the ones the consent catalog's own test uses for "a complete
// stack of its own on the mainland" (features/compliance/consents.test.ts,
// `MAINLAND_OWN`, PAR-5): the catalog also looks at WHERE the configured AI
// model is served, and only a vendor it knows to be in the mainland (here
// `deepseek`) counts as staying there. So this env means "nothing leaves the
// mainland" to the sign-up predicate and to the catalog alike.
export const CN_OWN_STACK_ENV: EnvSource = {
  DEPLOY_REGION: 'cn-mainland',
  DATABASE_URL: 'postgresql://u:p@10.0.0.12:5432/goapply',
  CN_LLM_PROVIDER: 'deepseek',
  CN_LLM_MODEL: 'deepseek-chat',
  CN_LIVEKIT_URL: 'wss://rtc.goapply.example.cn',
  CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer',
  CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/cosyvoice',
  CN_S3_BUCKET: 'cn',
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_VAPID_PUBLIC_KEY: 'pub',
  CN_EMAIL_TRANSPORT: 'aliyun_dm',
};

const CN0_TYPES = ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'] as const;

/**
 * CN-0 signup consents (agreement + age + cross-border) as the form sends
 * them: each with the hash of the text GET /auth/phone/policy serves for it
 * under `env` in `locale` (Chinese is GoApply's default). `proseVersion` is a
 * client string the server never stores.
 */
export function cn0Consents(env: EnvSource = BASE_ENV, locale: string = 'zh') {
  const brand = getBrand('goapply');
  return CN0_TYPES.map((type) => ({
    type: type as string,
    granted: true,
    proseVersion: 'v1',
    proseHash: resolveConsentProse(findConsentDefinition('goapply', type)!, brand, locale, env).hash,
  }));
}

/** `cn0Consents()` for BASE_ENV. */
export const CN0_CONSENTS = cn0Consents();

/** The same consents as a form that sends no hash (an old client): refused as `outdated`. */
export const CN0_CONSENTS_NO_HASH = CN0_TYPES.map((type) => ({ type: type as string, granted: true, proseVersion: 'v1' }));

export interface FakeWechatUser {
  openid: string;
  unionid?: string;
}

/** fetch stand-in for api.weixin.qq.com: maps OAuth/mini codes to identities and phone codes to numbers. */
export function fakeWechatFetch(codes: Record<string, FakeWechatUser>, phones: Record<string, string> = {}) {
  const calls: string[] = [];
  const fn = async (url: string, init?: { body?: string }) => {
    calls.push(url);
    const u = new URL(url);
    let body: Record<string, unknown>;
    if (u.pathname === '/sns/oauth2/access_token' || u.pathname === '/sns/jscode2session') {
      const code = u.searchParams.get('code') ?? u.searchParams.get('js_code') ?? '';
      const who = codes[code];
      body = who ? { openid: who.openid, ...(who.unionid ? { unionid: who.unionid } : {}), access_token: 'at', session_key: 'sk' } : { errcode: 40029, errmsg: 'invalid code' };
    } else if (u.pathname === '/cgi-bin/stable_token') {
      body = { access_token: 'app_token', expires_in: 7200 };
    } else if (u.pathname === '/wxa/business/getuserphonenumber') {
      const code = (JSON.parse(init?.body ?? '{}') as { code?: string }).code ?? '';
      const phone = phones[code];
      body = phone ? { errcode: 0, phone_info: { purePhoneNumber: phone, countryCode: '86' } } : { errcode: 40001 };
    } else {
      body = { errcode: -1 };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch: fn, calls };
}

export function buildServices(opts: {
  db: AuthCnDb;
  env?: EnvSource;
  now: () => Date;
  consume?: ReturnType<typeof memoryLimiter>['consume'];
  sms?: ReturnType<typeof recordingSms>;
  fetch?: ReturnType<typeof fakeWechatFetch>['fetch'];
  /** Growth / credit seams (hooks.ts). Absent = none run (an injected database never reaches the production seams). */
  hooks?: AccountHooks;
  signInGate?: SignInGate;
}): AuthCnServices {
  return createAuthCnServices({
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.signInGate ? { signInGate: opts.signInGate } : {}),
    db: opts.db,
    env: opts.env ?? BASE_ENV,
    now: opts.now,
    consume: opts.consume ?? memoryLimiter(opts.now).consume,
    sms: opts.sms ?? recordingSms(),
    fetch: opts.fetch ?? fakeWechatFetch({}).fetch,
    issueSession: async (userId) => ({ token: `tok_${userId}_${Math.random().toString(36).slice(2, 8)}` }),
  });
}
