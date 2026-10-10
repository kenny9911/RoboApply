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
  cnPaymentsKilled,
  cnRecruitmentInfoMode,
  cnRecruitmentInfoModeProblem,
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
  type FlagKey,
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
/** A content-safety setting that cannot run: the one thing that turns GoApply AI off. */
const SAFETY_BROKEN = { CN_CONTENT_SAFETY_PROVIDER: 'nonsense' };

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
    expect(isEnabledForBrand('copilot', go, EMPTY)).toBe(true);
    expect(isEnabledForBrand('coaching', go, EMPTY)).toBe(true);
    expect(isEnabledForBrand('student', go, EMPTY)).toBe(true);
    expect(isEnabledForBrand('eeoAnswers', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('h1bHistory', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('contactEmailLookup', robo, EMPTY)).toBe(false);
    expect(isEnabledForBrand('invitations', robo, EMPTY)).toBe(false);
  });

  it('FLAG_<BRAND>_<KEY> flips a product flag', () => {
    expect(isEnabledForBrand('coaching', go, { FLAG_GOAPPLY_COACHING: 'false' })).toBe(false);
    expect(isEnabledForBrand('coaching', robo, { FLAG_GOAPPLY_COACHING: 'false' })).toBe(true);
    expect(isEnabledForBrand('eeoAnswers', go, { FLAG_GOAPPLY_EEO_ANSWERS: 'true' })).toBe(true);
    expect(isEnabledForBrand('copilot', robo, { FLAG_ROBOAPPLY_COPILOT: 'false' })).toBe(false);
    expect(isEnabledForBrand('copilot', go, { FLAG_ROBOAPPLY_COPILOT: 'false' })).toBe(true);
    expect(isEnabledForBrand('copilot', go, { FLAG_GOAPPLY_COPILOT: 'false' })).toBe(false);
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

describe('cnRecruitmentInfoModeProblem: a value that is not a mode is named, never silent', () => {
  it.each([[undefined], [''], ['  '], ['off'], [' OFF '], ['partner_deeplink'], ['Partner_Deeplink'], ['licensed'], [' Licensed ']])(
    '%j is a mode (or unset): no problem',
    (value) => {
      expect(cnRecruitmentInfoModeProblem({ CN_RECRUITMENT_INFO_MODE: value })).toBeNull();
    },
  );

  // The sibling switches accept false/0/no; this one is a mode. Such a value
  // leaves the feed ON, which is the opposite of what the operator meant.
  it.each([['false'], ['0'], ['no'], ['none'], ['disabled'], ['true'], ['partner-deeplink'], ['licenced']])(
    '%j is not a mode: reported, and the feed stays on',
    (value) => {
      const env = { CN_RECRUITMENT_INFO_MODE: ` ${value} ` };
      expect(cnRecruitmentInfoModeProblem(env)).toBe(value);
      expect(cnRecruitmentInfoMode(env)).toBe('licensed');
      expect(isEnabledForBrand('jobs.feed', go, env)).toBe(true);
    },
  );
});

describe('requirements (credentials, off switches) cannot be overridden', () => {
  it('the GoApply job feed is on by default; CN_RECRUITMENT_INFO_MODE=off is the off switch', () => {
    expect(cnRecruitmentInfoMode({})).toBe('licensed');
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: '  ' })).toBe('licensed');
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: 'licensed' })).toBe('licensed');
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: 'something-else' })).toBe('licensed');
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' })).toBe('partner_deeplink');
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: ' Partner_Deeplink ' })).toBe('partner_deeplink');
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: 'off' })).toBe('off');
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: ' OFF ' })).toBe('off');
    // Only the literal word is the off switch.
    expect(cnRecruitmentInfoMode({ CN_RECRUITMENT_INFO_MODE: 'false' })).toBe('licensed');
    const OFF = { CN_RECRUITMENT_INFO_MODE: 'off' };
    for (const key of ['jobs.feed', 'jobs.recommendations', 'jobs.alerts'] as const) {
      expect(isEnabledForBrand(key, go, EMPTY), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_RECRUITMENT_INFO_MODE: 'licensed' }), key).toBe(true);
      // The off switch is a requirement: no override turns the feed back on.
      expect(isEnabledForBrand(key, go, OFF), key).toBe(false);
      expect(isEnabledForBrand(key, go, { ...OFF, [flagEnvName('goapply', key)]: 'true' }), key).toBe(false);
      expect(isEnabledForBrand(key, go, OFF, { [key]: true }), key).toBe(false);
      // The product switch turns it off too.
      expect(isEnabledForBrand(key, go, { [flagEnvName('goapply', key)]: 'false' }), key).toBe(false);
      // RoboApply never reads the variable.
      expect(isEnabledForBrand(key, robo, EMPTY), key).toBe(true);
      expect(isEnabledForBrand(key, robo, OFF), key).toBe(true);
    }
  });

  it('the campus calendar is on for GoApply by default; CN_CAMPUS_CALENDAR_ENABLED=false turns it off; never on RoboApply', () => {
    for (const key of ['jobs.campusCalendar', 'campusCalendar'] as const) {
      expect(isEnabledForBrand(key, go, EMPTY), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_CAMPUS_CALENDAR_ENABLED: 'true' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_CAMPUS_CALENDAR_ENABLED: '  ' }), key).toBe(true);
      // It no longer follows the recruitment-info mode.
      expect(isEnabledForBrand(key, go, { CN_RECRUITMENT_INFO_MODE: 'off' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_RECRUITMENT_INFO_MODE: 'licensed' }), key).toBe(true);
      for (const off of ['false', '0', 'off', 'no', 'FALSE']) {
        expect(isEnabledForBrand(key, go, { CN_CAMPUS_CALENDAR_ENABLED: off }), `${key} ${off}`).toBe(false);
        // The off switch is a requirement: no override turns it back on.
        expect(isEnabledForBrand(key, go, { CN_CAMPUS_CALENDAR_ENABLED: off, FLAG_GOAPPLY_CAMPUS_CALENDAR: 'true' }, { campusCalendar: true }), `${key} ${off}`).toBe(false);
      }
      expect(isEnabledForBrand(key, robo, EMPTY), key).toBe(false);
      expect(isEnabledForBrand(key, robo, { CN_CAMPUS_CALENDAR_ENABLED: 'true' }), key).toBe(false);
    }
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

  it('payment rails are brand-locked; Alipay opens with its callback secret; CN_PAYMENTS_ENABLED=false is the kill switch (D6)', () => {
    expect(isEnabledForBrand('pay.stripe', robo, { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(true);
    expect(isEnabledForBrand('pay.stripe', robo, EMPTY)).toBe(false);
    // Stripe never serves GoApply.
    expect(isEnabledForBrand('pay.stripe', go, { STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(false);
    expect(isEnabledForBrand('pay.stripe', go, { STRIPE_SECRET_KEY: 'sk_test_x', FLAG_GOAPPLY_PAY_STRIPE: 'true' }, { 'pay.stripe': true })).toBe(false);

    const SECRET = { ALIPAY_CALLBACK_SECRET: 'y' };
    // The secret alone: no CN_PAYMENTS_ENABLED and no ALIPAY_API_URL (the rail defaults the worker URL).
    expect(isEnabledForBrand('pay.alipay', go, SECRET)).toBe(true);
    expect(isEnabledForBrand('pay.alipay', go, { ...SECRET, ALIPAY_API_URL: 'https://x' })).toBe(true);
    expect(isEnabledForBrand('pay.alipay', go, { ...SECRET, CN_PAYMENTS_ENABLED: 'true' })).toBe(true);
    expect(isEnabledForBrand('pay.alipay', go, { ...SECRET, CN_PAYMENTS_ENABLED: '  ' })).toBe(true);
    // Without the rail's own credential it cannot open a payment.
    expect(isEnabledForBrand('pay.alipay', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('pay.alipay', go, { ALIPAY_API_URL: 'https://x' })).toBe(false);
    expect(isEnabledForBrand('pay.alipay', go, { ALIPAY_CALLBACK_SECRET: '  ' })).toBe(false);
    expect(isEnabledForBrand('pay.alipay', go, { FLAG_GOAPPLY_PAY_ALIPAY: 'true' }, { 'pay.alipay': true })).toBe(false);
    // The kill switch, which no override lifts.
    for (const off of ['false', '0', 'off', 'no']) {
      expect(isEnabledForBrand('pay.alipay', go, { ...SECRET, CN_PAYMENTS_ENABLED: off }), off).toBe(false);
      expect(isEnabledForBrand('pay.alipay', go, { ...SECRET, CN_PAYMENTS_ENABLED: off, FLAG_GOAPPLY_PAY_ALIPAY: 'true' }, { 'pay.alipay': true }), off).toBe(false);
    }
    // The rail is not RoboApply's.
    expect(isEnabledForBrand('pay.alipay', robo, SECRET)).toBe(false);
    expect(isEnabledForBrand('pay.alipay', robo, { ...SECRET, CN_PAYMENTS_ENABLED: 'true' })).toBe(false);
    // WeChat Pay still needs its merchant set.
    expect(isEnabledForBrand('pay.wechatpay', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', go, { CN_PAYMENTS_ENABLED: 'true' })).toBe(false);
  });

  it('cnPaymentsKilled: set and false, never a missing value', () => {
    expect(cnPaymentsKilled({})).toBe(false);
    expect(cnPaymentsKilled({ CN_PAYMENTS_ENABLED: '' })).toBe(false);
    expect(cnPaymentsKilled({ CN_PAYMENTS_ENABLED: '  ' })).toBe(false);
    expect(cnPaymentsKilled({ CN_PAYMENTS_ENABLED: 'true' })).toBe(false);
    expect(cnPaymentsKilled({ CN_PAYMENTS_ENABLED: '1' })).toBe(false);
    expect(cnPaymentsKilled({ CN_PAYMENTS_ENABLED: 'false' })).toBe(true);
    expect(cnPaymentsKilled({ CN_PAYMENTS_ENABLED: ' OFF ' })).toBe(true);
    expect(cnPaymentsKilled({ CN_PAYMENTS_ENABLED: '0' })).toBe(true);
  });

  it('GoApply AI runs on the shared stack by default: no CN model is required, only a usable content-safety filter', () => {
    for (const key of ['ai.text', 'ai.vision'] as const) {
      expect(isEnabledForBrand(key, robo, EMPTY), key).toBe(true);
      expect(isEnabledForBrand(key, go, EMPTY), key).toBe(true);
      // The shared stack, GoApply's own model, half a CN config, a non-domestic CN provider: all on.
      expect(isEnabledForBrand(key, go, { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', LLM_MODEL: 'x' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, CN_MODEL), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', CN_LLM_MODEL: 'x' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { CN_LLM_PROVIDER: 'newapi', NEWAPI_API_KEY: 'k', NEWAPI_BASE_URL: 'https://openrouter.ai/api/v1', CN_LLM_MODEL: 'x' }), key).toBe(true);
      // WP-24: a content-safety filter that cannot run hides GoApply AI (never RoboApply's).
      expect(isEnabledForBrand(key, go, SAFETY_BROKEN), key).toBe(false);
      expect(isEnabledForBrand(key, go, { ...CN_MODEL, ...SAFETY_BROKEN }), key).toBe(false);
      expect(isEnabledForBrand(key, go, { CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green' }), key).toBe(false); // no keys
      expect(isEnabledForBrand(key, go, SAFETY_BROKEN, { [key]: true }), key).toBe(false);
      expect(isEnabledForBrand(key, robo, SAFETY_BROKEN), key).toBe(true);
      // The filter setting is GoApply's own: an unprefixed value is not read.
      expect(isEnabledForBrand(key, go, { CONTENT_SAFETY_PROVIDER: 'nonsense' }), key).toBe(true);
    }
    // ai.vision no longer needs CN_LLM_VISION_MODEL.
    expect(isEnabledForBrand('ai.vision', go, { CN_LLM_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'k', CN_LLM_MODEL: 'qwen-max' })).toBe(true);
  });

  it('AI-only product flags follow the registry on both brands, and go off with the content-safety filter', () => {
    for (const key of ['copilot', 'agent', 'visitorAssistant', 'competitiveness'] as const) {
      expect(isEnabledForBrand(key, go, EMPTY), key).toBe(go.flags[key]);
      expect(isEnabledForBrand(key, go, CN_MODEL), key).toBe(go.flags[key]);
      expect(isEnabledForBrand(key, robo, EMPTY), key).toBe(robo.flags[key]);
      // Same default on both brands (D5).
      expect(go.flags[key], key).toBe(robo.flags[key]);
      // No override stands in for the filter.
      expect(isEnabledForBrand(key, go, { ...SAFETY_BROKEN, [flagEnvName('goapply', key)]: 'true' }, { [key]: true }), key).toBe(false);
      expect(isEnabledForBrand(key, robo, { ...SAFETY_BROKEN, [flagEnvName('roboapply', key)]: 'true' }), key).toBe(true);
    }
    const flags = resolveFlags(go, EMPTY);
    expect(flags['ai.text']).toBe(true);
    expect(flags.copilot).toBe(true);
    expect(flags.agent).toBe(true);
    expect(flags.competitiveness).toBe(true);
    const broken = resolveFlags(go, SAFETY_BROKEN);
    expect(broken['ai.text']).toBe(false);
    expect(broken['ai.vision']).toBe(false);
    expect(broken.copilot).toBe(false);
    expect(broken['legal.footer.aiDisclosure']).toBe(false);
    // The footer model line shows whenever GoApply AI runs; RoboApply has no such line.
    expect(flags['legal.footer.aiDisclosure']).toBe(true);
    expect(resolveFlags(robo, EMPTY)['legal.footer.aiDisclosure']).toBe(false);
  });

  it('campusCalendar and jobs.campusCalendar are one switch', () => {
    const goWithout = { ...go, flags: { ...go.flags, campusCalendar: false } };
    const cases = [
      EMPTY,
      { CN_CAMPUS_CALENDAR_ENABLED: 'true' },
      { CN_CAMPUS_CALENDAR_ENABLED: 'false' },
      { CN_RECRUITMENT_INFO_MODE: 'licensed' },
      { CN_RECRUITMENT_INFO_MODE: 'off' },
      { FLAG_GOAPPLY_CAMPUS_CALENDAR: 'off' },
      { FLAG_GOAPPLY_JOBS_CAMPUS_CALENDAR: 'off' },
      { CN_CAMPUS_CALENDAR_ENABLED: 'false', FLAG_GOAPPLY_CAMPUS_CALENDAR: 'true' },
    ];
    for (const env of cases) {
      for (const brand of [go, goWithout, robo]) {
        expect(isEnabledForBrand('campusCalendar', brand, env), JSON.stringify(env)).toBe(isEnabledForBrand('jobs.campusCalendar', brand, env));
      }
    }
    // A mainland brand without the surface never gets it, whatever the env says.
    expect(isEnabledForBrand('campusCalendar', goWithout, { CN_CAMPUS_CALENDAR_ENABLED: 'true', FLAG_GOAPPLY_CAMPUS_CALENDAR: 'true' })).toBe(false);
    // The product override turns both keys off.
    expect(isEnabledForBrand('jobs.campusCalendar', go, { FLAG_GOAPPLY_CAMPUS_CALENDAR: 'off' })).toBe(false);
    expect(isEnabledForBrand('campusCalendar', go, { FLAG_GOAPPLY_CAMPUS_CALENDAR: 'off' })).toBe(false);
  });

  it('voice needs the product flag and LiveKit credentials: GoApply uses the shared plane unless it has its own', () => {
    const lk = { LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
    const cnLk = { CN_LIVEKIT_URL: 'wss://cn', CN_LIVEKIT_API_KEY: 'k', CN_LIVEKIT_API_SECRET: 's' };
    expect(isEnabledForBrand('ai.interviewVoice', robo, lk)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', robo, EMPTY)).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, lk)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, cnLk)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('interviewVoice', go, EMPTY)).toBe(true); // the product switch alone
  });

  it('legal footer lines show only when set (D3)', () => {
    expect(isEnabledForBrand('legal.footer.icp', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('legal.footer.icp', go, { CN_ICP_NUMBER: 'X' })).toBe(true);
    expect(isEnabledForBrand('legal.footer.icp', robo, { CN_ICP_NUMBER: 'X' })).toBe(false);
    // A legal entity never crosses brands (brand-own name).
    expect(isEnabledForBrand('legal.footer.entity', go, { LEGAL_ENTITY_NAME: 'Intl Co' })).toBe(false);
    expect(isEnabledForBrand('legal.footer.entity', go, { CN_LEGAL_ENTITY_NAME: 'CN Co' })).toBe(true);
    expect(isEnabledForBrand('legal.footer.entity', robo, { CN_LEGAL_ENTITY_NAME: 'CN Co' })).toBe(false);
    expect(isEnabledForBrand('legal.footer.entity', robo, { LEGAL_ENTITY_NAME: 'Intl Co' })).toBe(true);
    expect(isEnabledForBrand('legal.footer.hrLicence', go, { CN_HR_LICENCE_NUMBER: 'n' })).toBe(false);
  });

  it('email: GoApply falls back to the shared Resend account; aliyun_dm needs its keys; none is the off switch', () => {
    const RESEND = { RESEND_API_KEY: 'k' };
    const ALIYUN = { ALIYUN_DM_ACCESS_KEY_ID: 'a', ALIYUN_DM_ACCESS_KEY_SECRET: 'b', ALIYUN_DM_ACCOUNT_NAME: 'noreply@goapply.top' };
    for (const key of ['notify.email', 'auth.passwordReset'] as const) {
      expect(isEnabledForBrand(key, robo, RESEND), key).toBe(true);
      expect(isEnabledForBrand(key, robo, EMPTY), key).toBe(false);
      // Unset transport, or `resend`: the shared key, with no CN_EMAIL_FROM requirement.
      expect(isEnabledForBrand(key, go, RESEND), key).toBe(true);
      expect(isEnabledForBrand(key, go, { ...RESEND, CN_EMAIL_TRANSPORT: 'resend' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { ...RESEND, CN_EMAIL_TRANSPORT: 'resend', CN_EMAIL_FROM: 'a@b' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { ...RESEND, CN_EMAIL_TRANSPORT: 'something-else' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, EMPTY), key).toBe(false);
      expect(isEnabledForBrand(key, go, { CN_EMAIL_TRANSPORT: 'resend', CN_EMAIL_FROM: 'a@b' }), key).toBe(false);
      // aliyun_dm: the three DirectMail keys, and the Resend key does not stand in.
      expect(isEnabledForBrand(key, go, { ...ALIYUN, CN_EMAIL_TRANSPORT: 'aliyun_dm' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { ...ALIYUN, CN_EMAIL_TRANSPORT: ' Aliyun_DM ' }), key).toBe(true);
      expect(isEnabledForBrand(key, go, { ...RESEND, CN_EMAIL_TRANSPORT: 'aliyun_dm' }), key).toBe(false);
      for (const name of Object.keys(ALIYUN)) {
        const env: Record<string, string> = { ...ALIYUN, ...RESEND, CN_EMAIL_TRANSPORT: 'aliyun_dm' };
        delete env[name];
        expect(isEnabledForBrand(key, go, env), `${key} ${name}`).toBe(false);
      }
      // none: the off switch, which no override lifts.
      expect(isEnabledForBrand(key, go, { ...RESEND, ...ALIYUN, CN_EMAIL_TRANSPORT: 'none' }), key).toBe(false);
      expect(isEnabledForBrand(key, go, { ...RESEND, CN_EMAIL_TRANSPORT: 'NONE', [flagEnvName('goapply', key)]: 'true' }, { [key]: true }), key).toBe(false);
      // RoboApply never reads CN_EMAIL_TRANSPORT.
      expect(isEnabledForBrand(key, robo, { ...RESEND, CN_EMAIL_TRANSPORT: 'none' }), key).toBe(true);
      expect(isEnabledForBrand(key, robo, { ...ALIYUN, CN_EMAIL_TRANSPORT: 'aliyun_dm' }), key).toBe(false);
    }
  });

  it('WeChat notices need the official-account credentials and are GoApply only', () => {
    const MP = { WECHAT_MP_APP_ID: 'a', WECHAT_MP_APP_SECRET: 'b', WECHAT_MP_TOKEN: 'c' };
    expect(isEnabledForBrand('notify.wechat', go, MP)).toBe(true);
    expect(isEnabledForBrand('notify.wechat', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('notify.wechat', robo, MP)).toBe(false);
  });
});

/**
 * D5 acceptance (GOAPPLY_PARITY_PLAN §3.2): with only the shared credentials
 * and no CN_ value, every capability that is on for RoboApply is on for
 * GoApply, except the six that belong to RoboApply's market.
 */
describe('brand parity matrix (D5)', () => {
  const SHARED = {
    NODE_ENV: 'test',
    RESEND_API_KEY: 'k',
    LIVEKIT_URL: 'wss://x',
    LIVEKIT_API_KEY: 'k',
    LIVEKIT_API_SECRET: 's',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:push@example.com',
    ALIPAY_CALLBACK_SECRET: 'secret',
    STRIPE_SECRET_KEY: 'sk_test_x',
  };
  /** On for RoboApply only: they follow from the market, not from a missing GoApply credential. */
  const ROBOAPPLY_ONLY: readonly FlagKey[] = ['h1bHistory', 'eeoAnswers', 'fx.reference', 'pay.stripe', 'auth.google', 'auth.line'];
  /** The same, with the sign-in credentials RoboApply's two extra methods need. */
  const WITH_SIGN_IN = { ...SHARED, GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's', LINE_LOGIN_CHANNEL_ID: 'a', LINE_LOGIN_CHANNEL_SECRET: 'b' };

  it.each([
    ['the shared credentials', SHARED],
    ['the shared credentials plus Google and LINE sign-in', WITH_SIGN_IN],
    ['production', { ...WITH_SIGN_IN, NODE_ENV: 'production' }],
  ])('%s: every flag on for RoboApply is on for GoApply, except the market six', (_label, env) => {
    const r = resolveFlags(robo, env);
    const g = resolveFlags(go, env);
    const missing = FLAG_KEYS.filter((key) => r[key] && !g[key]);
    expect(missing.filter((key) => !ROBOAPPLY_ONLY.includes(key))).toEqual([]);
    // The six stay RoboApply's whenever RoboApply has them.
    for (const key of ROBOAPPLY_ONLY) expect(g[key], key).toBe(false);
    expect(g.hiringContacts).toBe(r.hiringContacts);
  });

  it('the capabilities the audits found dark are on for GoApply', () => {
    const g = resolveFlags(go, SHARED);
    for (const key of [
      'ai.text',
      'ai.vision',
      'ai.interviewVoice',
      'interviewVoice',
      'copilot',
      'agent',
      'competitiveness',
      'notify.email',
      'auth.passwordReset',
      'jobs.feed',
      'jobs.recommendations',
      'jobs.alerts',
      'jobs.import',
      'campusCalendar',
      'jobs.campusCalendar',
      'webPush',
      'coaching',
      'student',
      'totp',
      'offers',
      'extension',
      'ext.autofill',
      'pay.alipay',
    ] as const) {
      expect(g[key], key).toBe(true);
    }
    // With the sign-in credentials all six are on for RoboApply, so the exception list is exact.
    const r = resolveFlags(robo, WITH_SIGN_IN);
    for (const key of ROBOAPPLY_ONLY) expect(r[key], key).toBe(true);
  });

  it('no CN_ value is needed, and none is read for RoboApply', () => {
    expect(Object.keys(SHARED).some((name) => name.startsWith('CN_'))).toBe(false);
    const cnEverything = {
      ...SHARED,
      CN_RECRUITMENT_INFO_MODE: 'off',
      CN_CAMPUS_CALENDAR_ENABLED: 'false',
      CN_EMAIL_TRANSPORT: 'none',
      CN_PAYMENTS_ENABLED: 'false',
      CN_CONTENT_SAFETY_PROVIDER: 'nonsense',
      CN_LIVEKIT_URL: 'wss://cn',
      CN_VAPID_PUBLIC_KEY: 'cn-pub',
    };
    expect(resolveFlags(robo, cnEverything)).toEqual(resolveFlags(robo, SHARED));
  });

  it.each([
    ['CN_RECRUITMENT_INFO_MODE=off', { CN_RECRUITMENT_INFO_MODE: 'off' }, ['jobs.feed', 'jobs.recommendations', 'jobs.alerts']],
    ['CN_CAMPUS_CALENDAR_ENABLED=false', { CN_CAMPUS_CALENDAR_ENABLED: 'false' }, ['campusCalendar', 'jobs.campusCalendar']],
    ['CN_EMAIL_TRANSPORT=none', { CN_EMAIL_TRANSPORT: 'none' }, ['notify.email', 'auth.passwordReset']],
    ['CN_PAYMENTS_ENABLED=false', { CN_PAYMENTS_ENABLED: 'false' }, ['pay.alipay']],
    ['FLAG_GOAPPLY_COACHING=false', { FLAG_GOAPPLY_COACHING: 'false' }, ['coaching']],
    ['FLAG_GOAPPLY_STUDENT=false', { FLAG_GOAPPLY_STUDENT: 'false' }, ['student']],
    ['FLAG_GOAPPLY_WEB_PUSH=false', { FLAG_GOAPPLY_WEB_PUSH: 'false' }, ['webPush']],
    ['FLAG_GOAPPLY_INTERVIEW_VOICE=false', { FLAG_GOAPPLY_INTERVIEW_VOICE: 'false' }, ['interviewVoice', 'ai.interviewVoice']],
    ['FLAG_GOAPPLY_COPILOT=false', { FLAG_GOAPPLY_COPILOT: 'false' }, ['copilot']],
    ['FLAG_GOAPPLY_AI_TEXT=false', { FLAG_GOAPPLY_AI_TEXT: 'false' }, ['ai.text']],
    ['FLAG_GOAPPLY_JOBS_FEED=false', { FLAG_GOAPPLY_JOBS_FEED: 'false' }, ['jobs.feed']],
    ['FLAG_GOAPPLY_PAY_ALIPAY=false', { FLAG_GOAPPLY_PAY_ALIPAY: 'false' }, ['pay.alipay']],
  ] as Array<[string, Record<string, string>, FlagKey[]]>)('%s turns exactly its capability off, on GoApply only', (_label, off, keys) => {
    const before = resolveFlags(go, SHARED);
    const after = resolveFlags(go, { ...SHARED, ...off });
    const changed = FLAG_KEYS.filter((key) => before[key] !== after[key]);
    expect(changed.sort()).toEqual([...keys].sort());
    for (const key of keys) expect(after[key], key).toBe(false);
    expect(resolveFlags(robo, { ...SHARED, ...off })).toEqual(resolveFlags(robo, SHARED));
  });

  it('every FLAG_GOAPPLY_<KEY>=false turns its key off', () => {
    // Two keys are aliases and read the variable of the key they mirror.
    const ALIAS: Partial<Record<FlagKey, FlagKey>> = { referrals: 'invites', 'jobs.campusCalendar': 'campusCalendar' };
    const before = resolveFlags(go, SHARED);
    let checked = 0;
    for (const key of FLAG_KEYS) {
      if (!before[key]) continue;
      const after = resolveFlags(go, { ...SHARED, [flagEnvName('goapply', ALIAS[key] ?? key)]: 'false' });
      expect(after[key], key).toBe(false);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(25);
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
    const coachingOff = { ...EMPTY, FLAG_GOAPPLY_COACHING: 'false' };
    expect(await isEnabled('coaching', { brand: go, env: coachingOff })).toBe(false);
    expect(await isEnabled('coaching', { brand: go, env: coachingOff, userId: 'beta' })).toBe(true);
    // The feed's off switch is a requirement: a beta override does not lift it.
    expect(await isEnabled('jobs.feed', { brand: go, env: { ...EMPTY, CN_RECRUITMENT_INFO_MODE: 'off' }, userId: 'beta' })).toBe(false);
    expect(await isEnabled('jobs.feed', { brand: go, env: EMPTY, userId: 'beta' })).toBe(true);
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
    // GoApply: the coaching switch off, and a content-safety filter that cannot run (the one thing that stops its AI).
    const env = { NODE_ENV: 'development', FLAG_GOAPPLY_COACHING: 'false', ...SAFETY_BROKEN };
    const healthy = { NODE_ENV: 'development' };
    router.get('/coaching', requireFlag('coaching', { env }), (_req, res) => {
      res.json({ ok: true });
    });
    router.get('/ai', requireFlag('ai.text', { env }), (_req, res) => {
      res.json({ ok: true });
    });
    router.get('/copilot', requireFlag('copilot', { env }), (_req, res) => {
      res.json({ ok: true });
    });
    router.get('/copilot-off', requireFlag('copilot', { env: { ...env, FLAG_GOAPPLY_COPILOT: 'false' } }), (_req, res) => {
      res.json({ ok: true });
    });
    router.get('/default/:key', (req, res, next) => requireFlag(req.params.key as FlagKey, { env: healthy })(req, res, next), (_req, res) => {
      res.json({ ok: true });
    });
    const h = await startRouteHarness({
      env: { NODE_ENV: 'development' },
      before: [fakeAuth({ id: 'u1' })],
      mounts: [['/f', router]],
    });
    const GO = { host: 'goapply.localhost:3621' };
    const ROBO = { host: 'localhost:3621' };
    try {
      const off = await h.request<{ code: string }>('GET', '/f/coaching', GO);
      expect(off.status).toBe(404);
      expect(off.body.code).toBe('feature_disabled');
      const on = await h.request('GET', '/f/coaching', ROBO);
      expect(on.status).toBe(200);
      const ai = await h.request<{ code: string }>('GET', '/f/ai', GO);
      expect(ai.status).toBe(503);
      expect(ai.body.code).toBe('ai_unavailable');
      // An AI-only product flag whose switch is on but whose brand cannot run AI → 503.
      const copilotCn = await h.request<{ code: string }>('GET', '/f/copilot', GO);
      expect(copilotCn.status).toBe(503);
      expect(copilotCn.body.code).toBe('ai_unavailable');
      // Its switch off → 404, the plain "not here".
      const copilotOff = await h.request<{ code: string }>('GET', '/f/copilot-off', GO);
      expect(copilotOff.status).toBe(404);
      const copilotIntl = await h.request('GET', '/f/copilot', ROBO);
      expect(copilotIntl.status).toBe(200);
      // With nothing switched off, GoApply passes the same gates as RoboApply (D5).
      for (const key of ['coaching', 'ai.text', 'copilot', 'student', 'jobs.feed']) {
        expect((await h.request('GET', `/f/default/${key}`, GO)).status, key).toBe(200);
        expect((await h.request('GET', `/f/default/${key}`, ROBO)).status, key).toBe(200);
      }
    } finally {
      await h.close();
    }
  });
});

// ── WP-93 requirement checks (carry-over wave 4 #7, wave 2 optional) ───────

describe('webPush: both brands, with a usable VAPID config (key pair + subject)', () => {
  const VAPID = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:push@example.com' };
  const CN_VAPID = { CN_VAPID_PUBLIC_KEY: 'cn-pub', CN_VAPID_PRIVATE_KEY: 'cn-priv', CN_VAPID_SUBJECT: 'mailto:a@b.cn' };

  it.each([
    ['roboapply', robo],
    ['goapply', go],
  ] as const)('%s: the key pair without a subject the push services accept is not enough', (id, brand) => {
    const pair = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    const force = { [flagEnvName(id, 'webPush')]: 'true' };
    expect(isEnabledForBrand('webPush', brand, pair)).toBe(false);
    expect(isEnabledForBrand('webPush', brand, { ...pair, VAPID_SUBJECT: '  ' })).toBe(false);
    expect(isEnabledForBrand('webPush', brand, { ...pair, VAPID_SUBJECT: 'push@example.com' })).toBe(false);
    expect(isEnabledForBrand('webPush', brand, { ...pair, VAPID_SUBJECT: 'http://example.com' })).toBe(false);
    expect(isEnabledForBrand('webPush', brand, { ...pair, VAPID_SUBJECT: 'https://example.com/contact' })).toBe(true);
    expect(isEnabledForBrand('webPush', brand, { ...pair, VAPID_SUBJECT: 'MAILTO:push@example.com' })).toBe(true);
    // Forcing the switch on never stands in for the subject.
    expect(isEnabledForBrand('webPush', brand, { ...pair, ...force }, { webPush: true })).toBe(false);
  });

  it.each([
    ['roboapply', robo],
    ['goapply', go],
  ] as const)('%s: on with the shared pair and subject only', (id, brand) => {
    const SUBJECT = { VAPID_SUBJECT: VAPID.VAPID_SUBJECT };
    const force = { [flagEnvName(id, 'webPush')]: 'true' };
    expect(isEnabledForBrand('webPush', brand, VAPID)).toBe(true);
    expect(isEnabledForBrand('webPush', brand, EMPTY)).toBe(false);
    expect(isEnabledForBrand('webPush', brand, SUBJECT)).toBe(false);
    expect(isEnabledForBrand('webPush', brand, { ...SUBJECT, VAPID_PUBLIC_KEY: 'pub' })).toBe(false);
    expect(isEnabledForBrand('webPush', brand, { ...SUBJECT, VAPID_PRIVATE_KEY: 'priv' })).toBe(false);
    expect(isEnabledForBrand('webPush', brand, { ...SUBJECT, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: '  ' })).toBe(false);
    // An override cannot stand in for the keys.
    expect(isEnabledForBrand('webPush', brand, force)).toBe(false);
    expect(isEnabledForBrand('webPush', brand, EMPTY, { webPush: true })).toBe(false);
    // The product switch still turns it off.
    expect(isEnabledForBrand('webPush', brand, { ...VAPID, [flagEnvName(id, 'webPush')]: 'false' })).toBe(false);
    expect(isEnabledForBrand('webPush', brand, VAPID, { webPush: false })).toBe(false);
    expect(resolveFlags(brand, VAPID).webPush).toBe(true);
  });

  it('GoApply: its own VAPID set when CN_VAPID_PUBLIC_KEY is set, never half of each', () => {
    expect(go.flags.webPush).toBe(true);
    expect(isEnabledForBrand('webPush', go, CN_VAPID)).toBe(true);
    expect(isEnabledForBrand('webPush', go, { ...VAPID, ...CN_VAPID })).toBe(true);
    // The CN public key starts the own set: the shared private key and subject do not complete it.
    expect(isEnabledForBrand('webPush', go, { ...VAPID, CN_VAPID_PUBLIC_KEY: 'cn-pub' })).toBe(false);
    expect(isEnabledForBrand('webPush', go, { ...VAPID, CN_VAPID_PUBLIC_KEY: 'cn-pub', CN_VAPID_PRIVATE_KEY: 'cn-priv' })).toBe(false);
    expect(isEnabledForBrand('webPush', go, { ...VAPID, CN_VAPID_PUBLIC_KEY: 'cn-pub', CN_VAPID_PRIVATE_KEY: 'cn-priv', CN_VAPID_SUBJECT: 'cn@example.cn' })).toBe(false);
    // Without the CN public key the stray CN values are not read: the shared set decides.
    expect(isEnabledForBrand('webPush', go, { ...VAPID, CN_VAPID_PRIVATE_KEY: '', CN_VAPID_SUBJECT: 'not-a-subject' })).toBe(true);
    // RoboApply never reads GoApply's set.
    expect(isEnabledForBrand('webPush', robo, CN_VAPID)).toBe(false);
  });

  it('a per-user override reaches isEnabled only on top of the requirement', async () => {
    setFlagOverrideLoader(async () => [{ key: 'flag:webPush', value: true, expiresAt: null, createdAt: new Date() }]);
    for (const brand of [robo, go]) {
      expect(await isEnabled('webPush', { userId: 'u1', brand, env: EMPTY })).toBe(false);
      expect(await isEnabled('webPush', { userId: 'u1', brand, env: VAPID })).toBe(true);
      expect(await isEnabled('webPush', { userId: 'u1', brand, env: { ...VAPID, [flagEnvName(brand.id, 'webPush')]: 'false' } })).toBe(true);
    }
  });
});

describe('pay.wechatpay: credentials, the notify public key and the entity match', () => {
  const FULL: Record<string, string> = {
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

  it('is on for GoApply with every requirement; CN_PAYMENTS_ENABLED is not one of them', () => {
    expect(Object.keys(FULL)).not.toContain('CN_PAYMENTS_ENABLED');
    expect(isEnabledForBrand('pay.wechatpay', go, FULL)).toBe(true);
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, CN_PAYMENTS_ENABLED: 'true' })).toBe(true);
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, CN_PAYMENTS_ENABLED: '  ' })).toBe(true);
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
    // The intl collecting entity is not GoApply's (PAYMENT_COLLECTING_ENTITY is a brand-own name: never the shared value).
    const { CN_PAYMENT_COLLECTING_ENTITY: _cn, ...rest } = FULL;
    expect(isEnabledForBrand('pay.wechatpay', go, { ...rest, PAYMENT_COLLECTING_ENTITY: FULL.WECHATPAY_MERCHANT_ENTITY })).toBe(false);
  });

  it('the requirement equals wechatPayReadiness(brand, env).ready for every configuration', () => {
    const variants: Array<Record<string, string>> = [FULL, {}];
    for (const name of Object.keys(FULL)) {
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
      // With the switch unset and with it on: the rail alone decides.
      for (const table of [env, { ...env, CN_PAYMENTS_ENABLED: 'true' }]) {
        for (const brand of [go, robo]) {
          const expected = wechatPayReadiness(brand, table).ready;
          expect(isEnabledForBrand('pay.wechatpay', brand, table), `${brand.id} ${JSON.stringify(table)}`).toBe(expected);
          if (expected) ready += 1;
        }
      }
      // Killed: off whatever the rail says.
      expect(isEnabledForBrand('pay.wechatpay', go, { ...env, CN_PAYMENTS_ENABLED: 'false' }), JSON.stringify(env)).toBe(false);
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
    // The kill switch and the brand's rails are still checked first.
    probe.mockClear();
    expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, CN_PAYMENTS_ENABLED: 'false' })).toBe(false);
    expect(isEnabledForBrand('pay.wechatpay', robo, FULL)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('CN_PAYMENTS_ENABLED=false stops it, it is off on RoboApply, and no override turns it on', () => {
    for (const off of ['false', '0', 'off', 'no']) {
      expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, CN_PAYMENTS_ENABLED: off }), off).toBe(false);
      expect(isEnabledForBrand('pay.wechatpay', go, { ...FULL, CN_PAYMENTS_ENABLED: off, FLAG_GOAPPLY_PAY_WECHATPAY: 'true' }, { 'pay.wechatpay': true }), off).toBe(false);
    }
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
    // GoApply's own plane is not RoboApply's: RoboApply never reads a CN_ value.
    expect(isEnabledForBrand('ai.interviewVoice', robo, CN_LK)).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', robo, { ...LK, CN_VOICE_PROVIDER: 'volcano' })).toBe(true);
    // The product switch still decides.
    expect(isEnabledForBrand('ai.interviewVoice', robo, { ...LK, FLAG_ROBOAPPLY_INTERVIEW_VOICE: 'false' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', robo, LK, { interviewVoice: false })).toBe(false);
  });

  it('GoApply: on by default, on the shared plane or on its own, never on a mix of the two', () => {
    expect(go.flags.interviewVoice).toBe(true);
    // The shared LiveKit project (no CN_LIVEKIT_URL), with the shared provider setting.
    expect(isEnabledForBrand('ai.interviewVoice', go, LK)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, VOICE_PROVIDER: 'livekit_selfhosted' })).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, VOICE_PROVIDER: 'volcano' })).toBe(false);
    for (const name of Object.keys(LK)) {
      const env: Record<string, string> = { ...LK };
      delete env[name];
      expect(isEnabledForBrand('ai.interviewVoice', go, env), name).toBe(false);
    }
    // A stray CN value without CN_LIVEKIT_URL does not start an own plane and is not read.
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, CN_VOICE_PROVIDER: 'volcano' })).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, CN_LIVEKIT_API_KEY: '', CN_LIVEKIT_API_SECRET: '' })).toBe(true);
    // Its own plane: CN_LIVEKIT_URL starts the set, and every member comes from it.
    expect(isEnabledForBrand('ai.interviewVoice', go, CN_LK)).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, CN_VOICE_PROVIDER: 'livekit_selfhosted' })).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, ...CN_LK })).toBe(true);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, CN_LIVEKIT_URL: 'wss://cn' })).toBe(false); // never the shared key and secret
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, CN_LIVEKIT_URL: 'wss://cn', CN_LIVEKIT_API_KEY: 'k' })).toBe(false);
    // A reserved provider has no implementation.
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, CN_VOICE_PROVIDER: 'volcano' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, CN_VOICE_PROVIDER: 'trtc' })).toBe(false);
    // On its own plane RoboApply's provider setting does not leak in.
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, VOICE_PROVIDER: 'volcano' })).toBe(true);
    // No plane at all: the switch alone is not enough, and no override stands in.
    expect(isEnabledForBrand('ai.interviewVoice', go, EMPTY)).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, { FLAG_GOAPPLY_INTERVIEW_VOICE: 'true' }, { interviewVoice: true, 'ai.interviewVoice': true })).toBe(false);
    // The product switch still decides.
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'false' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, { ...CN_LK, FLAG_GOAPPLY_INTERVIEW_VOICE: 'false' })).toBe(false);
    expect(isEnabledForBrand('ai.interviewVoice', go, LK, { interviewVoice: false })).toBe(false);
  });

  it('the requirement equals voiceAvailable(brand) of interview-engine/providers for every provider id', () => {
    const PROVIDER_NAMES = ['VOICE_PROVIDER', 'CN_VOICE_PROVIDER'];
    const NAMES = [...PROVIDER_NAMES, ...Object.keys(LK), ...Object.keys(CN_LK), 'FLAG_ROBOAPPLY_INTERVIEW_VOICE', 'FLAG_GOAPPLY_INTERVIEW_VOICE'];
    const providerValues = [undefined, 'nonsense', ...VOICE_PROVIDER_IDS];
    const credSets = [{}, LK, CN_LK, { ...LK, ...CN_LK }, { LIVEKIT_URL: 'wss://x', CN_LIVEKIT_URL: 'wss://cn' }, { ...LK, CN_LIVEKIT_URL: 'wss://cn' }, { ...CN_LK, LIVEKIT_URL: 'wss://x' }];
    let compared = 0;
    const outcomes = { roboapply: new Set<boolean>(), goapply: new Set<boolean>() };
    for (const brand of [robo, go]) {
      // Both provider names for both brands: which one a brand reads is brandEnv's rule (the voice group).
      for (const providerName of PROVIDER_NAMES) {
        for (const provider of providerValues) {
          for (const creds of credSets) {
            const table: Record<string, string> = { ...creds };
            if (provider) table[providerName] = provider;
            for (const name of NAMES) vi.stubEnv(name, table[name] ?? '');
            const expected = voiceAvailable(brand.id);
            expect(isEnabledForBrand('ai.interviewVoice', brand, table), `${brand.id} ${providerName}=${provider} ${Object.keys(creds).join(',')}`).toBe(expected);
            outcomes[brand.id].add(expected);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(2 * PROVIDER_NAMES.length * providerValues.length * credSets.length);
    // The matrix covers both outcomes for both brands.
    expect([...outcomes.roboapply].sort()).toEqual([false, true]);
    expect([...outcomes.goapply].sort()).toEqual([false, true]);
    // The two id lists this file mirrors.
    expect([...IMPLEMENTED_VOICE_PROVIDERS].sort()).toEqual(['livekit_cloud', 'livekit_selfhosted']);
    expect([...VOICE_PROVIDER_IDS].sort()).toEqual(['livekit_cloud', 'livekit_selfhosted', 'trtc', 'volcano']);
  });

  it('once startup registers voiceAvailable, every process.env call goes through it', () => {
    const probe = vi.fn((brand: string) => brand === 'goapply');
    setVoiceAvailabilityProbe(probe);
    vi.stubEnv('FLAG_GOAPPLY_INTERVIEW_VOICE', '');
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

describe('no model credential is a capability requirement any more (D5)', () => {
  const GATEWAY = { CN_LLM_PROVIDER: 'newapi', NEWAPI_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' };

  it('a newapi gateway of any host, complete or not, neither turns GoApply AI on nor off', () => {
    // Which route a prompt may take is decided where it is sent (LLMService and
    // the egress policy; the domestic-only wall is the opt-in CN_LLM_DOMESTIC_ONLY),
    // never by hiding the capability.
    for (const base of [
      'https://api.deepseek.com/v1',
      'https://gateway.dashscope.aliyuncs.com/v1',
      'https://openrouter.ai/api/v1',
      'https://newapi.example.com/v1',
      undefined,
    ]) {
      const env: Record<string, string> = { ...GATEWAY, ...(base ? { NEWAPI_BASE_URL: base } : {}) };
      for (const key of ['ai.text', 'ai.vision', 'copilot', 'agent', 'competitiveness'] as const) {
        expect(isEnabledForBrand(key, go, env), `${key} ${base}`).toBe(true);
      }
    }
    for (const name of ['NEWAPI_API_KEY', 'CN_LLM_MODEL', 'CN_LLM_PROVIDER']) {
      const env: Record<string, string> = { ...GATEWAY, NEWAPI_BASE_URL: 'https://api.deepseek.com/v1' };
      delete env[name];
      expect(isEnabledForBrand('ai.text', go, env), name).toBe(true);
    }
  });

  it('the strict switches do not hide AI either: they narrow where a prompt may go', () => {
    for (const env of [{ CN_LLM_DOMESTIC_ONLY: 'true' }, { CN_RESIDENCY_STRICT: 'true' }]) {
      expect(isEnabledForBrand('ai.text', go, env), JSON.stringify(env)).toBe(true);
      expect(isEnabledForBrand('ai.text', robo, env), JSON.stringify(env)).toBe(true);
    }
  });

  it('competitiveness stays an AI-dependent flag (owner decision, deferred)', async () => {
    const { AI_DEPENDENT_FLAGS } = await import('./flags.js');
    expect(AI_DEPENDENT_FLAGS.has('competitiveness')).toBe(true);
    expect([...AI_DEPENDENT_FLAGS].sort()).toEqual(['agent', 'competitiveness', 'copilot', 'visitorAssistant']);
  });
});
