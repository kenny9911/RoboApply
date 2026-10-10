// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';

// The voice parity test imports the interview engine, whose module graph
// reaches lib/prisma.ts (which opens a pool and loads .env files into
// process.env). Nothing here talks to a database.
vi.mock('../lib/prisma.js', () => ({ default: {} }));

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
  setVoiceAvailabilityProbe,
  setWechatPayReadinessProbe,
} from './flags.js';
import { BRANDS } from './brand/registry.js';
import { fakeAuth, startRouteHarness } from '../test/routeHarness.js';
import { IMPLEMENTED_VOICE_PROVIDERS, voiceAvailable } from '../interview-engine/providers/index.js';
import { VOICE_PROVIDER_IDS } from '../interview-engine/config.js';
import { wechatPayReadiness } from './billing/rails/wechatpay.js';

const robo = BRANDS.roboapply;
const go = BRANDS.goapply;
const EMPTY = { NODE_ENV: 'test' };
const CN_MODEL = { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' };

afterEach(() => {
  setFlagOverrideLoader(null);
  setVoiceAvailabilityProbe(null);
  setWechatPayReadinessProbe(null);
  vi.unstubAllEnvs();
});

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

// ── WP-93 requirement checks (carry-over wave 4 #7, wave 2 optional) ───────

describe('webPush: not a mainland brand AND a usable VAPID config (key pair + subject)', () => {
  const VAPID = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:push@example.com' };

  it('the key pair without a subject the push services accept is not enough', () => {
    const pair = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    expect(isEnabledForBrand('webPush', robo, pair)).toBe(false);
    expect(isEnabledForBrand('webPush', robo, { ...pair, VAPID_SUBJECT: '  ' })).toBe(false);
    expect(isEnabledForBrand('webPush', robo, { ...pair, VAPID_SUBJECT: 'push@example.com' })).toBe(false);
    expect(isEnabledForBrand('webPush', robo, { ...pair, VAPID_SUBJECT: 'http://example.com' })).toBe(false);
    expect(isEnabledForBrand('webPush', robo, { ...pair, VAPID_SUBJECT: 'https://example.com/contact' })).toBe(true);
    expect(isEnabledForBrand('webPush', robo, { ...pair, VAPID_SUBJECT: 'MAILTO:push@example.com' })).toBe(true);
    // Forcing the switch on never stands in for the subject.
    expect(isEnabledForBrand('webPush', robo, { ...pair, FLAG_ROBOAPPLY_WEB_PUSH: 'true' }, { webPush: true })).toBe(false);
  });

  it('is on for RoboApply only with both keys', () => {
    const SUBJECT = { VAPID_SUBJECT: VAPID.VAPID_SUBJECT };
    expect(isEnabledForBrand('webPush', robo, VAPID)).toBe(true);
    expect(isEnabledForBrand('webPush', robo, EMPTY)).toBe(false);
    expect(isEnabledForBrand('webPush', robo, SUBJECT)).toBe(false);
    expect(isEnabledForBrand('webPush', robo, { ...SUBJECT, VAPID_PUBLIC_KEY: 'pub' })).toBe(false);
    expect(isEnabledForBrand('webPush', robo, { ...SUBJECT, VAPID_PRIVATE_KEY: 'priv' })).toBe(false);
    expect(isEnabledForBrand('webPush', robo, { ...SUBJECT, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: '  ' })).toBe(false);
    // An override cannot stand in for the keys.
    expect(isEnabledForBrand('webPush', robo, { FLAG_ROBOAPPLY_WEB_PUSH: 'true' })).toBe(false);
    expect(isEnabledForBrand('webPush', robo, EMPTY, { webPush: true })).toBe(false);
    // The product switch still turns it off.
    expect(isEnabledForBrand('webPush', robo, { ...VAPID, FLAG_ROBOAPPLY_WEB_PUSH: 'false' })).toBe(false);
    expect(resolveFlags(robo, VAPID).webPush).toBe(true);
  });

  it('GoApply never gets webPush, whatever is configured or overridden', () => {
    const everything = {
      ...VAPID,
      CN_VAPID_PUBLIC_KEY: 'pub',
      CN_VAPID_PRIVATE_KEY: 'priv',
      CN_VAPID_SUBJECT: 'mailto:a@b.cn',
      FLAG_GOAPPLY_WEB_PUSH: 'true',
    };
    expect(isEnabledForBrand('webPush', go, everything)).toBe(false);
    expect(isEnabledForBrand('webPush', go, everything, { webPush: true })).toBe(false);
    expect(resolveFlags(go, everything, { webPush: true }).webPush).toBe(false);
    // Any other mainland brand too: the rule is the market, not the brand id.
    const cnWithSwitch = { ...go, flags: { ...go.flags, webPush: true } };
    expect(isEnabledForBrand('webPush', cnWithSwitch, everything, { webPush: true })).toBe(false);
  });

  it('a per-user override reaches isEnabled only on top of the requirement', async () => {
    setFlagOverrideLoader(async () => [{ key: 'flag:webPush', value: true, expiresAt: null, createdAt: new Date() }]);
    expect(await isEnabled('webPush', { userId: 'u1', brand: go, env: VAPID })).toBe(false);
    expect(await isEnabled('webPush', { userId: 'u1', brand: robo, env: EMPTY })).toBe(false);
    expect(await isEnabled('webPush', { userId: 'u1', brand: robo, env: VAPID })).toBe(true);
  });
});

describe('pay.wechatpay: credentials, the notify public key and the entity match', () => {
  const FULL: Record<string, string> = {
    CN_PAYMENTS_ENABLED: 'true',
    WECHATPAY_MCH_ID: '1900000001',
    WECHATPAY_APP_ID: 'wx1234567890abcdef',
    WECHATPAY_API_V3_KEY: 'k'.repeat(32),
    WECHATPAY_MCH_CERT_SERIAL: 'SERIAL01',
    WECHATPAY_MCH_PRIVATE_KEY: 'merchant-private-key-pem',
    WECHATPAY_PUBLIC_KEY: 'wechatpay-public-key-pem',
    WECHATPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_01',
    CN_PAYMENT_COLLECTING_ENTITY: '示例（上海）科技有限公司',
    WECHATPAY_MERCHANT_ENTITY: '示例(上海)科技有限公司',
  };

  it('is on for GoApply with every requirement', () => {
    expect(isEnabledForBrand('pay.wechatpay', go, FULL)).toBe(true);
    expect(resolveFlags(go, FULL)['pay.wechatpay']).toBe(true);
  });

  it.each(Object.keys(FULL))('is off without %s', (name) => {
    const env = { ...FULL };
    delete env[name];
    expect(isEnabledForBrand('pay.wechatpay', go, env)).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, [name]: '  ' })).toBe(false);
  });

  it('is off when the collecting entity is not the merchant, or the APIv3 key is not 32 bytes', () => {
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, WECHATPAY_MERCHANT_ENTITY: '另一家有限公司' })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, WECHATPAY_API_V3_KEY: 'short' })).toBe(false);
    // The intl collecting entity is not GoApply's (R-03: no fallback from CN_X to X).
    const { CN_PAYMENT_COLLECTING_ENTITY: _cn, ...rest } = FULL;
    expect(isEnabledForBrand('pay.wechatpay', go, { ...rest, PAYMENT_COLLECTING_ENTITY: FULL.WECHATPAY_MERCHANT_ENTITY })).toBe(false);
  });

  it('the requirement equals wechatPayReadiness(brand, env).ready for every configuration', () => {
    const variants: Array<Record<string, string>> = [FULL, {}];
    for (const name of Object.keys(FULL)) {
      if (name === 'CN_PAYMENTS_ENABLED') continue;
      const without = { ...FULL };
      delete without[name];
      variants.push(without, { ...FULL, [name]: '   ' }, { ...FULL, [name]: '""' });
    }
    variants.push(
      { ...FULL, WECHATPAY_API_V3_KEY: 'short' },
      { ...FULL, WECHATPAY_API_V3_KEY: 'k'.repeat(33) },
      { ...FULL, WECHATPAY_API_V3_KEY: '密'.repeat(32) }, // 32 characters, 96 bytes
      { ...FULL, WECHATPAY_API_V3_KEY: ` ${'k'.repeat(32)} ` },
      { ...FULL, WECHATPAY_MERCHANT_ENTITY: '另一家有限公司' },
      { ...FULL, WECHATPAY_MERCHANT_ENTITY: ' 示例 （上海） 科技有限公司 ' },
      { ...FULL, CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.', WECHATPAY_MERCHANT_ENTITY: 'EXAMPLE  COLLECTING CO.' },
      { ...FULL, CN_PAYMENT_COLLECTING_ENTITY: 'Example (Shanghai) Ltd', WECHATPAY_MERCHANT_ENTITY: 'Example （Shanghai） Ltd' },
      { ...FULL, WECHATPAY_MCH_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"' },
      { ...FULL, WECHATPAY_PUBLIC_KEY: "'  '" },
      { ...FULL, PAYMENT_COLLECTING_ENTITY: FULL.CN_PAYMENT_COLLECTING_ENTITY!, CN_PAYMENT_COLLECTING_ENTITY: '' },
    );
    let ready = 0;
    for (const env of variants) {
      const table = { ...env, CN_PAYMENTS_ENABLED: 'true' };
      for (const brand of [go, robo]) {
        const expected = wechatPayReadiness(brand, table).ready;
        expect(isEnabledForBrand('pay.wechatpay', brand, table), `${brand.id} ${JSON.stringify(env)}`).toBe(expected);
        if (expected) ready += 1;
      }
    }
    expect(variants.length).toBeGreaterThan(30);
    expect(ready).toBeGreaterThanOrEqual(5); // the matrix covers both outcomes
  });

  it('once startup registers wechatPayReadiness, the rail decides', () => {
    const probe = vi.fn(() => false);
    setWechatPayReadinessProbe(probe);
    expect(isEnabledForBrand('pay.wechatpay', go, FULL)).toBe(false);
    expect(probe).toHaveBeenCalledWith(go, FULL);
    probe.mockReturnValue(true);
    expect(isEnabledForBrand('pay.wechatpay', go, FULL)).toBe(true);
    // CN_PAYMENTS_ENABLED and the brand's rails are still checked first.
    probe.mockClear();
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, CN_PAYMENTS_ENABLED: 'false' })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', robo, FULL)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('stays off until CN_PAYMENTS_ENABLED, off on RoboApply, and no override turns it on', () => {
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, CN_PAYMENTS_ENABLED: 'false' })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', robo, FULL)).toBe(false);
    const { WECHATPAY_PUBLIC_KEY_ID: _id, ...noKeyId } = FULL;
    expect(isEnabledForBrand('pay.wechatpay', go, { ...noKeyId, FLAG_GOAPPLY_PAY_WECHATPAY: 'true' }, { 'pay.wechatpay': true })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, FLAG_GOAPPLY_PAY_WECHATPAY: 'false' })).toBe(false);
  });
});

describe('ai.interviewVoice: the media plane of the brand AND the interviewVoice switch', () => {
  const LK = { LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
  const CN_LK = { CN_LIVEKIT_URL: 'wss://cn', CN_LIVEKIT_API_KEY: 'k', CN_LIVEKIT_API_SECRET: 's' };

  it('RoboApply: on with its LiveKit credentials and an implemented provider', () => {
    expect(isEnabledForBrand('ai.interviewVoice', robo, LK)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', robo, { ...LK, VOICE_PROVIDER: 'livekit_selfhosted' })).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', robo, { ...LK, VOICE_PROVIDER: 'something-unknown' })).toBe(true); // unknown → livekit_cloud
    for (const name of Object.keys(LK)) {
      const env: Record<string, string> = { ...LK };
      delete env[name];
      expect(isEnabledForBrand('ai.interviewVoice', robo, env), name).toBe(false);
    }
    // A reserved provider has no implementation: voice is off even with credentials.
    expect(isEnabledForBrand('ai.interviewVoice', robo, { ...LK, VOICE_PROVIDER: 'volcano' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', robo, { ...LK, VOICE_PROVIDER: 'trtc' })).toBe(false);
    // GoApply's plane is not RoboApply's.
    expect(isEnabledForBrand('ai.interviewVoice', robo, CN_LK)).toBe(false);
    // The product switch still decides.
    expect(isEnabledForBrand('ai.interviewVoice', robo, { ...LK, FLAG_ROBOAPPLY_INTERVIEW_VOICE: 'false' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', robo, LK, { interviewVoice: false })).toBe(false);
  });

  it('GoApply: off by default, and config can now turn it on (switch + CN plane)', () => {
    expect(go.flags.interviewVoice).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, CN_LK)).toBe(false); // registry switch off
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'true' })).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, CN_LK, { interviewVoice: true })).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'true', CN_VOICE_PROVIDER: 'livekit_selfhosted' })).toBe(true);
    // The switch alone is not enough: no fallback to RoboApply's plane (R-03), no reserved provider.
    expect(isEnabledForBrand('ai.interviewVoice', go, { FLAG_GOAPPLY_INTERVIEW_VOICE: 'true' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'true' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'true', CN_VOICE_PROVIDER: 'volcano' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'true', CN_VOICE_PROVIDER: 'trtc' })).toBe(false);
    // RoboApply's provider setting does not leak into GoApply.
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'true', VOICE_PROVIDER: 'volcano' })).toBe(true);
  });

  it('the requirement equals voiceAvailable(brand) of interview-engine/providers for every provider id', () => {
    const NAMES = ['VOICE_PROVIDER', 'CN_VOICE_PROVIDER', ...Object.keys(LK), ...Object.keys(CN_LK), 'FLAG_ROBOAPPLY_INTERVIEW_VOICE', 'FLAG_GOAPPLY_INTERVIEW_VOICE'];
    const providerValues = [undefined, 'nonsense', ...VOICE_PROVIDER_IDS];
    let compared = 0;
    for (const brand of [robo, go]) {
      const prefix = brand.market === 'cn' ? 'CN_' : '';
      for (const provider of providerValues) {
        for (const creds of [{}, LK, CN_LK, { ...LK, ...CN_LK }, { LIVEKIT_URL: 'wss://x', CN_LIVEKIT_URL: 'wss://cn' }]) {
          const table: Record<string, string> = { ...creds, FLAG_GOAPPLY_INTERVIEW_VOICE: 'true' };
          if (provider) table[`${prefix}VOICE_PROVIDER`] = provider;
          for (const name of NAMES) vi.stubEnv(name, table[name] ?? '');
          expect(isEnabledForBrand('ai.interviewVoice', brand, table), `${brand.id} ${provider} ${Object.keys(creds).join(',')}`).toBe(voiceAvailable(brand.id));
          compared += 1;
        }
      }
    }
    expect(compared).toBe(2 * providerValues.length * 5);
    // The two id lists this file mirrors.
    expect([...IMPLEMENTED_VOICE_PROVIDERS].sort()).toEqual(['livekit_cloud', 'livekit_selfhosted']);
    expect([...VOICE_PROVIDER_IDS].sort()).toEqual(['livekit_cloud', 'livekit_selfhosted', 'trtc', 'volcano']);
  });

  it('once startup registers voiceAvailable, every process.env call goes through it', () => {
    const probe = vi.fn((brand: string) => brand === 'goapply');
    setVoiceAvailabilityProbe(probe);
    vi.stubEnv('FLAG_GOAPPLY_INTERVIEW_VOICE', 'true');
    vi.stubEnv('FLAG_ROBOAPPLY_INTERVIEW_VOICE', '');
    expect(isEnabledForBrand('ai.interviewVoice', go, process.env)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', robo, process.env)).toBe(false);
    expect(probe).toHaveBeenCalledWith('goapply');
    expect(probe).toHaveBeenCalledWith('roboapply');
    // The switch is still applied on top of the probe.
    vi.stubEnv('FLAG_GOAPPLY_INTERVIEW_VOICE', 'false');
    expect(isEnabledForBrand('ai.interviewVoice', go, process.env)).toBe(false);
    // A caller-supplied table is read from the table, not from the probe.
    probe.mockClear();
    expect(isEnabledForBrand('ai.interviewVoice', robo, LK)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('GoApply text model through a newapi gateway (CN_LLM_PROVIDER=newapi)', () => {
  const GATEWAY = { CN_LLM_PROVIDER: 'newapi', NEWAPI_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' };

  it('counts only when the gateway host passes the egress policy', () => {
    expect(isEnabledForBrand('ai.text', go, { ...GATEWAY, NEWAPI_BASE_URL: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(isEnabledForBrand('ai.text', go, { ...GATEWAY, NEWAPI_BASE_URL: 'https://gateway.dashscope.aliyuncs.com/v1' })).toBe(true);
    // An offshore or unknown gateway never unlocks GoApply AI.
    expect(isEnabledForBrand('ai.text', go, { ...GATEWAY, NEWAPI_BASE_URL: 'https://openrouter.ai/api/v1' })).toBe(false);
    expect(isEnabledForBrand('ai.text', go, { ...GATEWAY, NEWAPI_BASE_URL: 'https://newapi.example.com/v1' })).toBe(false);
    expect(isEnabledForBrand('ai.text', go, { ...GATEWAY, NEWAPI_BASE_URL: 'https://api.deepseek.com.evil.example/v1' })).toBe(false);
    expect(isEnabledForBrand('ai.text', go, { ...GATEWAY, NEWAPI_BASE_URL: 'https://dashscope-intl.aliyuncs.com/v1' })).toBe(false);
  });

  it('needs the key, the base URL and the model', () => {
    const ok = { ...GATEWAY, NEWAPI_BASE_URL: 'https://api.deepseek.com/v1' };
    for (const name of ['NEWAPI_API_KEY', 'NEWAPI_BASE_URL', 'CN_LLM_MODEL']) {
      const env: Record<string, string> = { ...ok };
      delete env[name];
      expect(isEnabledForBrand('ai.text', go, env), name).toBe(false);
    }
    // The AI-only product flags follow.
    expect(isEnabledForBrand('copilot', go, ok)).toBe(go.flags.copilot);
    expect(isEnabledForBrand('ai.vision', go, { ...ok, CN_LLM_VISION_MODEL: 'qwen-vl' })).toBe(true);
    expect(isEnabledForBrand('ai.vision', go, { ...ok, NEWAPI_BASE_URL: 'https://openrouter.ai/api/v1', CN_LLM_VISION_MODEL: 'qwen-vl' })).toBe(false);
  });

  it('an allowlisted extra domestic host is honoured, as LLMService would', () => {
    const env = { ...GATEWAY, NEWAPI_BASE_URL: 'https://llm.internal.example.cn/v1' };
    expect(isEnabledForBrand('ai.text', go, env)).toBe(false);
    expect(isEnabledForBrand('ai.text', go, { ...env, CN_LLM_DOMESTIC_HOSTS: 'llm.internal.example.cn' })).toBe(true);
    expect(isEnabledForBrand('ai.text', go, { ...env, CN_LLM_DOMESTIC_HOSTS: 'other.example.cn' })).toBe(false);
  });

  it('competitiveness stays an AI-dependent flag (owner decision, deferred)', async () => {
    const { AI_DEPENDENT_FLAGS } = await import('./flags.js');
    expect(AI_DEPENDENT_FLAGS.has('competitiveness')).toBe(true);
  });
});
