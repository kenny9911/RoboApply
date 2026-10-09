// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { Router } from 'express';
import {
  CAPABILITY_KEYS,
  FLAG_KEYS,
  PRODUCT_FLAG_KEYS,
  cnRecruitmentInfoMode,
  flagEnvName,
  hiringContactsMode,
  isEnabled,
  isEnabledForBrand,
  overridesFromRows,
  requireFlag,
  resolveFlags,
  setFlagOverrideLoader,
} from './flags.js';
import { BRANDS } from './brand/registry.js';
import { fakeAuth, startRouteHarness } from '../test/routeHarness.js';

const robo = BRANDS.roboapply;
const go = BRANDS.goapply;
const EMPTY = { NODE_ENV: 'test' };
const CN_MODEL = { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' };

afterEach(() => setFlagOverrideLoader(null));

describe('flag keys', () => {
  it('cover ARCH BrandFlags ∪ CN §2.3 capabilities ∪ the plan additions', () => {
    for (const k of ['copilot', 'agent', 'extension', 'coaching', 'interviewBank', 'interviewVoice', 'referrals', 'webPush', 'contactEmailLookup', 'companyFunding', 'h1bHistory', 'campusCalendar', 'eeoAnswers', 'invitations', 'invites', 'cn.referralCodes'])
      expect(PRODUCT_FLAG_KEYS).toContain(k);
    for (const k of ['auth.phoneOtp', 'auth.wechatWeb', 'auth.wechatInApp', 'auth.wechatMini', 'auth.google', 'auth.line', 'auth.passwordReset', 'pay.stripe', 'pay.alipay', 'pay.wechatpay', 'ai.text', 'ai.vision', 'ai.interviewVoice', 'jobs.feed', 'jobs.recommendations', 'jobs.campusCalendar', 'jobs.import', 'jobs.alerts', 'notify.email', 'notify.wechat', 'fx.reference', 'ext.autofill'])
      expect(CAPABILITY_KEYS).toContain(k);
    expect(CAPABILITY_KEYS.some((k) => k.startsWith('legal.footer.'))).toBe(true);
    expect(new Set(FLAG_KEYS).size).toBe(FLAG_KEYS.length);
    const all = resolveFlags(robo, EMPTY);
    expect(Object.keys(all).sort()).toEqual([...FLAG_KEYS, 'hiringContacts'].sort());
  });

  it('builds the env override name', () => {
    expect(flagEnvName('goapply', 'coaching')).toBe('FLAG_GOAPPLY_COACHING');
    expect(flagEnvName('roboapply', 'cn.referralCodes')).toBe('FLAG_ROBOAPPLY_CN_REFERRAL_CODES');
    expect(flagEnvName('goapply', 'jobs.campusCalendar')).toBe('FLAG_GOAPPLY_JOBS_CAMPUS_CALENDAR');
    expect(flagEnvName('roboapply', 'hiringContacts')).toBe('FLAG_ROBOAPPLY_HIRING_CONTACTS');
  });
});

describe('registry layer + env overrides', () => {
  it('uses the registry defaults', () => {
    expect(isEnabledForBrand('copilot', robo, EMPTY)).toBe(true);
    expect(isEnabledForBrand('coaching', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('eeoAnswers', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('contactEmailLookup', robo, EMPTY)).toBe(false);
    expect(isEnabledForBrand('invitations', robo, EMPTY)).toBe(false);
  });

  it('FLAG_<BRAND>_<KEY> flips a product flag', () => {
    expect(isEnabledForBrand('coaching', go, { FLAG_GOAPPLY_COACHING: 'true' })).toBe(true);
    expect(isEnabledForBrand('copilot', robo, { FLAG_ROBOAPPLY_COPILOT: 'false' })).toBe(false);
    expect(isEnabledForBrand('copilot', go, { ...CN_MODEL, FLAG_ROBOAPPLY_COPILOT: 'false' })).toBe(true);
  });

  it('referrals mirrors invites; ext.autofill follows extension', () => {
    expect(isEnabledForBrand('referrals', robo, { FLAG_ROBOAPPLY_INVITES: 'false' })).toBe(false);
    expect(isEnabledForBrand('ext.autofill', robo, { FLAG_ROBOAPPLY_EXTENSION: 'false' })).toBe(false);
    expect(isEnabledForBrand('ext.autofill', robo, EMPTY)).toBe(true);
  });

  it('hiringContacts defaults to deeplinks_only and accepts a valid env mode only', () => {
    expect(hiringContactsMode(robo, EMPTY)).toBe('deeplinks_only');
    expect(hiringContactsMode(robo, { FLAG_ROBOAPPLY_HIRING_CONTACTS: 'off' })).toBe('off');
    expect(hiringContactsMode(robo, { FLAG_ROBOAPPLY_HIRING_CONTACTS: 'everyone' })).toBe('deeplinks_only');
  });
});

describe('requirements (credentials, env, legal mode) cannot be overridden', () => {
  it('R-14: GoApply job feed follows CN_RECRUITMENT_INFO_MODE', () => {
    expect(cnRecruitmentInfoMode({})).toBe('off');
    for (const key of ['jobs.feed', 'jobs.recommendations', 'jobs.alerts'] as const) {
      expect(isEnabledForBrand(key, go, EMPTY)).toBe(false);
      expect(isEnabledForBrand(key, go, { [flagEnvName('goapply', key)]: 'true' })).toBe(false);
      expect(isEnabledForBrand(key, go, { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' })).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_RECRUITMENT_INFO_MODE: 'licensed' })).toBe(true);
      expect(isEnabledForBrand(key, robo, EMPTY)).toBe(true);
    }
    expect(isEnabledForBrand('jobs.feed', go, EMPTY, { 'jobs.feed': true })).toBe(false);
  });

  it('R-14: campus calendar needs mode ≠ off or CN_CAMPUS_CALENDAR_ENABLED, and never on RoboApply by default', () => {
    expect(isEnabledForBrand('jobs.campusCalendar', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('jobs.campusCalendar', go, { CN_CAMPUS_CALENDAR_ENABLED: 'true' })).toBe(true);
    expect(isEnabledForBrand('jobs.campusCalendar', go, { CN_RECRUITMENT_INFO_MODE: 'licensed' })).toBe(true);
    expect(isEnabledForBrand('jobs.campusCalendar', robo, { CN_CAMPUS_CALENDAR_ENABLED: 'true' })).toBe(false);
  });

  it('job import, resume-side features and the extension work in every mode', () => {
    expect(isEnabledForBrand('jobs.import', go, EMPTY)).toBe(true);
    expect(isEnabledForBrand('ext.autofill', go, EMPTY)).toBe(true);
  });

  it('auth methods need their credentials and must be offered by the brand', () => {
    const google = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' };
    expect(isEnabledForBrand('auth.google', robo, EMPTY)).toBe(false);
    expect(isEnabledForBrand('auth.google', robo, google)).toBe(true);
    expect(isEnabledForBrand('auth.google', go, google)).toBe(false);
    expect(isEnabledForBrand('auth.line', robo, { LINE_LOGIN_CHANNEL_ID: 'a', LINE_LOGIN_CHANNEL_SECRET: 'b' })).toBe(true);
    expect(isEnabledForBrand('auth.wechatWeb', go, { WECHAT_OPEN_APP_ID: 'a', WECHAT_OPEN_APP_SECRET: 'b' })).toBe(true);
    expect(isEnabledForBrand('auth.wechatWeb', robo, { WECHAT_OPEN_APP_ID: 'a', WECHAT_OPEN_APP_SECRET: 'b' })).toBe(false);
    expect(isEnabledForBrand('auth.phoneOtp', go, EMPTY)).toBe(false);
    expect(
      isEnabledForBrand('auth.phoneOtp', go, {
        CN_SMS_PROVIDER: 'aliyun',
        ALIYUN_SMS_ACCESS_KEY_ID: 'a',
        ALIYUN_SMS_ACCESS_KEY_SECRET: 'b',
        ALIYUN_SMS_SIGN_NAME: 'c',
        ALIYUN_SMS_TEMPLATE_OTP: 'd',
      }),
    ).toBe(true);
    expect(isEnabledForBrand('auth.phoneOtp', go, { SMS_DEV_CONSOLE: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(isEnabledForBrand('auth.phoneOtp', go, { SMS_DEV_CONSOLE: 'true', NODE_ENV: 'production' })).toBe(false);
  });

  it('payment rails are brand-locked; CN rails need CN_PAYMENTS_ENABLED (R-15)', () => {
    expect(isEnabledForBrand('pay.stripe', robo, { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(true);
    expect(isEnabledForBrand('pay.stripe', go, { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(false);
    const alipay = { ALIPAY_API_URL: 'https://x', ALIPAY_CALLBACK_SECRET: 'y' };
    expect(isEnabledForBrand('pay.alipay', go, alipay)).toBe(false);
    expect(isEnabledForBrand('pay.alipay', go, { ...alipay, CN_PAYMENTS_ENABLED: 'true' })).toBe(true);
    expect(isEnabledForBrand('pay.alipay', robo, { ...alipay, CN_PAYMENTS_ENABLED: 'true' })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', go, { CN_PAYMENTS_ENABLED: 'true' })).toBe(false);
  });

  it('GoApply AI needs a domestic model; RoboApply AI keeps today’s stack (R-13)', () => {
    expect(isEnabledForBrand('ai.text', robo, EMPTY)).toBe(true);
    expect(isEnabledForBrand('ai.text', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('ai.text', go, { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' })).toBe(false); // no model
    expect(isEnabledForBrand('ai.text', go, { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' })).toBe(true);
    // WP-24: a misconfigured content-safety filter hides GoApply AI (never RoboApply's).
    const cnModel = { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' };
    expect(isEnabledForBrand('ai.text', go, { ...cnModel, CN_CONTENT_SAFETY_PROVIDER: 'nonsense' })).toBe(false);
    expect(isEnabledForBrand('ai.text', go, { ...cnModel, CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green' })).toBe(false); // no keys
    expect(isEnabledForBrand('ai.text', robo, { CN_CONTENT_SAFETY_PROVIDER: 'nonsense' })).toBe(true);
    expect(isEnabledForBrand('ai.text', go, { CN_LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', CN_LLM_MODEL: 'x' })).toBe(false);
    expect(isEnabledForBrand('ai.text', go, { LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', LLM_MODEL: 'x' })).toBe(false);
    expect(isEnabledForBrand('ai.vision', go, { CN_LLM_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'k', CN_LLM_MODEL: 'qwen-max' })).toBe(false);
  });

  it('R-13: AI-only product flags are off on GoApply until a domestic model is configured', () => {
    for (const key of ['copilot', 'agent', 'visitorAssistant', 'competitiveness'] as const) {
      expect(isEnabledForBrand(key, go, EMPTY), key).toBe(false);
      expect(isEnabledForBrand(key, go, { FLAG_GOAPPLY_COPILOT: 'true', FLAG_GOAPPLY_AGENT: 'true' }), key).toBe(false);
    }
    const flags = resolveFlags(go, EMPTY);
    expect(flags['ai.text']).toBe(false);
    expect(flags.copilot).toBe(false);
    expect(flags.agent).toBe(false);
    // With a model, they follow the registry again.
    expect(isEnabledForBrand('copilot', go, CN_MODEL)).toBe(go.flags.copilot);
    expect(isEnabledForBrand('agent', go, CN_MODEL)).toBe(go.flags.agent);
    // RoboApply keeps today's stack.
    expect(isEnabledForBrand('copilot', robo, EMPTY)).toBe(true);
  });

  it('R-14: campusCalendar and jobs.campusCalendar are one switch', () => {
    const go2 = { ...go, flags: { ...go.flags, campusCalendar: true } };
    const cases = [
      EMPTY,
      { CN_CAMPUS_CALENDAR_ENABLED: 'true' },
      { CN_RECRUITMENT_INFO_MODE: 'licensed' },
      { CN_CAMPUS_CALENDAR_ENABLED: 'true', FLAG_GOAPPLY_CAMPUS_CALENDAR: 'off' },
      { CN_CAMPUS_CALENDAR_ENABLED: 'true', FLAG_GOAPPLY_JOBS_CAMPUS_CALENDAR: 'off' },
    ];
    for (const env of cases) {
      for (const brand of [go, go2, robo]) {
        expect(isEnabledForBrand('campusCalendar', brand, env), JSON.stringify(env)).toBe(isEnabledForBrand('jobs.campusCalendar', brand, env));
      }
    }
    // Mode `off` without counsel sign-off: no campus calendar on either key.
    expect(isEnabledForBrand('campusCalendar', go2, EMPTY)).toBe(false);
    expect(isEnabledForBrand('campusCalendar', go2, { CN_CAMPUS_CALENDAR_ENABLED: 'true' })).toBe(true);
    // The product override turns both off.
    expect(isEnabledForBrand('jobs.campusCalendar', go2, { CN_CAMPUS_CALENDAR_ENABLED: 'true', FLAG_GOAPPLY_CAMPUS_CALENDAR: 'off' })).toBe(false);
    expect(isEnabledForBrand('campusCalendar', go2, { CN_CAMPUS_CALENDAR_ENABLED: 'true', FLAG_GOAPPLY_CAMPUS_CALENDAR: 'off' })).toBe(false);
  });

  it('voice needs the product flag and the brand LiveKit credentials', () => {
    const lk = { LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
    expect(isEnabledForBrand('ai.interviewVoice', robo, lk)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', robo, EMPTY)).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, { CN_LIVEKIT_URL: 'wss://x', CN_LIVEKIT_API_KEY: 'k', CN_LIVEKIT_API_SECRET: 's' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, lk)).toBe(false);
  });

  it('legal footer lines show only when set (D3)', () => {
    expect(isEnabledForBrand('legal.footer.icp', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('legal.footer.icp', go, { CN_ICP_NUMBER: 'X' })).toBe(true);
    expect(isEnabledForBrand('legal.footer.icp', robo, { CN_ICP_NUMBER: 'X' })).toBe(false);
    expect(isEnabledForBrand('legal.footer.entity', go, { LEGAL_ENTITY_NAME: 'Intl Co' })).toBe(false);
    expect(isEnabledForBrand('legal.footer.entity', go, { CN_LEGAL_ENTITY_NAME: 'CN Co' })).toBe(true);
    expect(isEnabledForBrand('legal.footer.hrLicence', go, { CN_HR_LICENCE_NUMBER: 'n' })).toBe(false);
  });

  it('email and WeChat notices need their transport', () => {
    expect(isEnabledForBrand('notify.email', robo, { RESEND_API_KEY: 'k' })).toBe(true);
    expect(isEnabledForBrand('notify.email', go, { RESEND_API_KEY: 'k' })).toBe(false);
    expect(isEnabledForBrand('notify.email', go, { CN_EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'k', CN_EMAIL_FROM: 'a@b' })).toBe(true);
    expect(isEnabledForBrand('notify.wechat', go, { WECHAT_MP_APP_ID: 'a', WECHAT_MP_APP_SECRET: 'b', WECHAT_MP_TOKEN: 'c' })).toBe(true);
    expect(isEnabledForBrand('auth.passwordReset', robo, EMPTY)).toBe(false);
  });
});

describe('per-user overrides (RAEntitlementOverride flag:<key>)', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  it('newest live boolean row per key wins; expired and malformed rows are ignored', () => {
    const o = overridesFromRows(
      [
        { key: 'flag:coaching', value: true, expiresAt: null, createdAt: new Date('2026-01-01') },
        { key: 'flag:coaching', value: false, expiresAt: null, createdAt: new Date('2026-02-01') },
        { key: 'flag:offers', value: false, expiresAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
        { key: 'flag:copilot', value: 'yes', expiresAt: null, createdAt: new Date('2026-01-01') },
        { key: 'flag:unknownKey', value: true, expiresAt: null, createdAt: new Date('2026-01-01') },
        { key: 'bucket:tailor', value: 5, expiresAt: null, createdAt: new Date('2026-01-01') },
        { key: 'flag:hiringContacts', value: 'on', expiresAt: null, createdAt: new Date('2026-01-01') },
      ],
      now,
    );
    expect(o).toEqual({ coaching: false, hiringContacts: 'on' });
  });

  it('isEnabled applies a beta override but never past a requirement', async () => {
    setFlagOverrideLoader(async (userId) =>
      userId === 'beta'
        ? [
            { key: 'flag:coaching', value: true, expiresAt: null, createdAt: now },
            { key: 'flag:jobs.feed', value: true, expiresAt: null, createdAt: now },
          ]
        : [],
    );
    expect(await isEnabled('coaching', { brand: go, env: EMPTY })).toBe(false);
    expect(await isEnabled('coaching', { brand: go, env: EMPTY, userId: 'beta' })).toBe(true);
    expect(await isEnabled('jobs.feed', { brand: go, env: EMPTY, userId: 'beta' })).toBe(false);
  });

  it('a failing override lookup falls back to brand defaults', async () => {
    setFlagOverrideLoader(async () => {
      throw new Error('db down');
    });
    expect(await isEnabled('copilot', { brand: robo, env: EMPTY, userId: 'u' })).toBe(true);
  });
});

describe('requireFlag', () => {
  it('404 feature_disabled, 503 ai_unavailable for AI, next() when on', async () => {
    setFlagOverrideLoader(async () => []);
    const router = Router();
    const env = { NODE_ENV: 'development' };
    router.get('/coaching', requireFlag('coaching', { env }), (_req, res) => {
      res.json({ ok: true });
    });
    router.get('/ai', requireFlag('ai.text', { env }), (_req, res) => {
      res.json({ ok: true });
    });
    router.get('/copilot', requireFlag('copilot', { env }), (_req, res) => {
      res.json({ ok: true });
    });
    const h = await startRouteHarness({
      env: { NODE_ENV: 'development' },
      before: [fakeAuth({ id: 'u1' })],
      mounts: [['/f', router]],
    });
    try {
      const off = await h.request<{ code: string }>('GET', '/f/coaching', { host: 'goapply.localhost:3621' });
      expect(off.status).toBe(404);
      expect(off.body.code).toBe('feature_disabled');
      const on = await h.request('GET', '/f/coaching', { host: 'localhost:3621' });
      expect(on.status).toBe(200);
      const ai = await h.request<{ code: string }>('GET', '/f/ai', { host: 'goapply.localhost:3621' });
      expect(ai.status).toBe(503);
      expect(ai.body.code).toBe('ai_unavailable');
      // An AI-only product flag whose switch is on but has no model → 503.
      const copilotCn = await h.request<{ code: string }>('GET', '/f/copilot', { host: 'goapply.localhost:3621' });
      expect(copilotCn.status).toBe(go.flags.copilot ? 503 : 404);
      const copilotIntl = await h.request('GET', '/f/copilot', { host: 'localhost:3621' });
      expect(copilotIntl.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
