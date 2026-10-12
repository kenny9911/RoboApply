// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BRAND_ENV_GROUPS,
  BRAND_ENV_GROUP_IDS,
  BRAND_OWN_ENV,
  BRAND_STACK_IDS,
  brandEnv,
  brandEnvFlag,
  brandEnvName,
  brandEnvGroupProblems,
  brandEnvSource,
  brandOwnEnv,
  brandStack,
  brandUsesSharedStack,
  cnLlmDomesticOnly,
  cnResidencyStrict,
  envSet,
  type BrandEnvGroupId,
  type EnvSource,
} from './brandEnv.js';
import * as brandIndex from './index.js';

/** Names read per key (`CN_NAME ?? NAME`): neither brand-own nor in a group. */
const PER_KEY = [
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_VISION_MODEL',
  'LLM_INTERVIEW_MODEL',
  'TOTP_ENCRYPTION_KEY',
  'COPILOT_DAILY_BUDGET_USD',
  'SCORE_DAILY_BUDGET',
  'RA_SYSTEM_USER_ID',
  'INTERVIEW_RETENTION_DAYS',
  'INTERVIEW_ENGINE_RECORDING_ENABLED',
];

const GROUPED = BRAND_ENV_GROUP_IDS.flatMap((group) => BRAND_ENV_GROUPS[group].members.map((name) => [group, name] as const));

/** Every anchor of a group set to a CN value. */
function ownAnchors(group: BrandEnvGroupId): EnvSource {
  return Object.fromEntries(BRAND_ENV_GROUPS[group].anchors.map((a) => [`CN_${a}`, `cn-${a}`]));
}

describe('the name lists (GOAPPLY_PARITY_PLAN §3.1)', () => {
  it('brand-own names', () => {
    expect([...BRAND_OWN_ENV].sort()).toEqual(
      [
        'CANONICAL_ORIGIN',
        'COOKIE_DOMAIN',
        'BACKEND_URL',
        'EMAIL_FROM',
        'SUPPORT_EMAIL',
        'COACHING_ADMIN_EMAIL',
        'TAKEDOWN_CONTACT',
        'LEGAL_ENTITY_NAME',
        'LEGAL_POSTAL_ADDRESS',
        'LEGAL_DOCS_VERSION',
        'PAYMENT_COLLECTING_ENTITY',
        'MIN_EXT_VERSION',
        'BAIDU_PUSH_TOKEN',
        'CONTACT_OPTIN_API_URL',
        'CONTACT_OPTIN_API_KEY',
        'CONTENT_SAFETY_PROVIDER',
        'CONTENT_SAFETY_TIMEOUT_MS',
        'SAFETY_KEYWORDS_URL',
        'JOB_SOURCES_CONTACT',
      ].sort(),
    );
  });

  it('groups and their anchors', () => {
    expect([...BRAND_ENV_GROUP_IDS].sort()).toEqual(['push', 'speech', 'storage', 'voice']);
    expect(BRAND_ENV_GROUPS.voice.anchors).toEqual(['LIVEKIT_URL']);
    expect([...BRAND_ENV_GROUPS.voice.members].sort()).toEqual(
      [
        'LIVEKIT_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'LIVEKIT_AGENT_NAME',
        'LIVEKIT_AGENT_CALLBACK_SECRET',
        'VOICE_PROVIDER',
        'INTERVIEW_ENGINE_AGENT_NAME',
        'INTERVIEW_ENGINE_CALLBACK_BASE_URL',
      ].sort(),
    );
    expect(BRAND_ENV_GROUPS.speech.anchors).toEqual(['INTERVIEW_ENGINE_STT_MODEL', 'INTERVIEW_ENGINE_TTS_MODEL']);
    expect([...BRAND_ENV_GROUPS.speech.members].sort()).toEqual(
      [
        'INTERVIEW_ENGINE_STT_MODEL',
        'INTERVIEW_ENGINE_TTS_MODEL',
        'INTERVIEW_ENGINE_TTS_VOICE',
        'INTERVIEW_ENGINE_TTS_VOICE_MALE',
        'INTERVIEW_ENGINE_STT_FALLBACK_MODELS',
      ].sort(),
    );
    expect(BRAND_ENV_GROUPS.storage.anchors).toEqual(['S3_BUCKET']);
    expect([...BRAND_ENV_GROUPS.storage.members].sort()).toEqual(
      [
        'S3_BUCKET',
        'S3_ENDPOINT',
        'S3_REGION',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
        'S3_FORCE_PATH_STYLE',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_REGION',
      ].sort(),
    );
    expect(BRAND_ENV_GROUPS.push.anchors).toEqual(['VAPID_PUBLIC_KEY']);
    expect([...BRAND_ENV_GROUPS.push.members].sort()).toEqual(['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT']);
    expect([...BRAND_STACK_IDS].sort()).toEqual(['llm', 'push', 'speech', 'storage', 'voice']);
  });

  it('every name is in exactly one class, and every anchor is a member of its group', () => {
    const grouped = GROUPED.map(([, name]) => name);
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const name of grouped) expect(BRAND_OWN_ENV.has(name), name).toBe(false);
    for (const name of PER_KEY) {
      expect(BRAND_OWN_ENV.has(name), name).toBe(false);
      expect(grouped, name).not.toContain(name);
    }
    for (const group of BRAND_ENV_GROUP_IDS) {
      for (const anchor of BRAND_ENV_GROUPS[group].anchors) expect(BRAND_ENV_GROUPS[group].members).toContain(anchor);
    }
  });
});

describe('RoboApply: the unprefixed name, always', () => {
  const ALL = [...BRAND_OWN_ENV, ...GROUPED.map(([, name]) => name), ...PER_KEY];

  it.each(ALL)('%s', (name) => {
    expect(brandEnvName('roboapply', name)).toBe(name);
    expect(brandEnv('roboapply', name, { [name]: 'shared', [`CN_${name}`]: 'cn' })).toBe('shared');
    expect(brandOwnEnv('roboapply', name, { [name]: 'shared', [`CN_${name}`]: 'cn' })).toBe('shared');
    // RoboApply never reads a CN_ value.
    expect(brandEnv('roboapply', name, { [`CN_${name}`]: 'cn' })).toBeUndefined();
    expect(brandOwnEnv('roboapply', name, { [`CN_${name}`]: 'cn' })).toBeUndefined();
    expect(brandEnvSource('roboapply', name, { [`CN_${name}`]: 'cn' })).toBe('none');
  });

  it('is not moved by a GoApply group anchor', () => {
    for (const [group, name] of GROUPED) {
      const env = { ...ownAnchors(group), [name]: 'shared', [`CN_${name}`]: 'cn' };
      expect(brandEnv('roboapply', name, env), name).toBe('shared');
    }
  });
});

describe('GoApply, brand-own names: CN_NAME only', () => {
  it.each([...BRAND_OWN_ENV])('%s', (name) => {
    expect(brandEnvName('goapply', name)).toBe(`CN_${name}`);
    expect(brandEnv('goapply', name, { [name]: 'shared', [`CN_${name}`]: 'cn' })).toBe('cn');
    // The shared value never stands in.
    expect(brandEnv('goapply', name, { [name]: 'shared' })).toBeUndefined();
    expect(brandEnv('goapply', name, { [name]: 'shared', [`CN_${name}`]: '  ' })).toBeUndefined();
    expect(brandEnvSource('goapply', name, { [name]: 'shared' })).toBe('none');
    expect(brandEnvSource('goapply', name, { [`CN_${name}`]: 'cn' })).toBe('own');
    // RoboApply's brand-own value is its own too, not a shared one.
    expect(brandEnvSource('roboapply', name, { [name]: 'shared' })).toBe('own');
  });

  it('COOKIE_DOMAIN and LEGAL_ENTITY_NAME never cross brands', () => {
    const env = { COOKIE_DOMAIN: '.roboapply.io', LEGAL_ENTITY_NAME: 'Intl Co', CN_LEGAL_ENTITY_NAME: '中国公司' };
    expect(brandEnv('goapply', 'COOKIE_DOMAIN', env)).toBeUndefined();
    expect(brandEnv('roboapply', 'COOKIE_DOMAIN', env)).toBe('.roboapply.io');
    expect(brandEnv('goapply', 'LEGAL_ENTITY_NAME', env)).toBe('中国公司');
    expect(brandEnv('roboapply', 'LEGAL_ENTITY_NAME', env)).toBe('Intl Co');
    expect(brandEnv('goapply', 'LEGAL_ENTITY_NAME', { LEGAL_ENTITY_NAME: 'Intl Co' })).toBeUndefined();
    expect(brandEnv('roboapply', 'LEGAL_ENTITY_NAME', { CN_LEGAL_ENTITY_NAME: '中国公司' })).toBeUndefined();
  });
});

describe('GoApply, grouped names: the whole set from CN_* or the whole set from the shared names', () => {
  it.each(GROUPED)('%s · %s', (group, name) => {
    const both = { [name]: 'shared', [`CN_${name}`]: 'cn' };
    // No CN anchor: the shared value, and a stray CN_ member is not read.
    const isAnchor = BRAND_ENV_GROUPS[group].anchors.includes(name);
    const single = BRAND_ENV_GROUPS[group].anchors.length === 1;
    expect(brandEnv('goapply', name, { [name]: 'shared' })).toBe('shared');
    expect(brandEnvSource('goapply', name, { [name]: 'shared' })).toBe('shared');
    if (!isAnchor) {
      expect(brandEnv('goapply', name, both)).toBe('shared');
      expect(brandEnvSource('goapply', name, both)).toBe('shared');
    } else if (!single) {
      // One anchor of two does not start an own group.
      expect(brandEnv('goapply', name, both)).toBe('shared');
    }
    // CN anchor set: the CN value, and no fallback to the shared one.
    const own = ownAnchors(group);
    expect(brandEnv('goapply', name, { ...both, ...own })).toBe(isAnchor ? `cn-${name}` : 'cn');
    expect(brandEnvSource('goapply', name, { ...both, ...own })).toBe('own');
    if (!isAnchor) {
      expect(brandEnv('goapply', name, { [name]: 'shared', ...own })).toBeUndefined();
      expect(brandEnvSource('goapply', name, { [name]: 'shared', ...own })).toBe('none');
    }
    // A blank anchor is an unset anchor.
    const blank = Object.fromEntries(Object.keys(own).map((k) => [k, '  ']));
    expect(brandEnv('goapply', name, { [name]: 'shared', ...blank })).toBe('shared');
  });

  it('storage: only S3_BUCKET set → the shared bucket and the shared keys', () => {
    const env = { S3_BUCKET: 'shared-bucket', S3_ACCESS_KEY_ID: 'AKIA-shared', S3_SECRET_ACCESS_KEY: 'shared-secret' };
    expect(brandEnv('goapply', 'S3_BUCKET', env)).toBe('shared-bucket');
    expect(brandEnv('goapply', 'S3_ACCESS_KEY_ID', env)).toBe('AKIA-shared');
    expect(brandEnv('goapply', 'S3_SECRET_ACCESS_KEY', env)).toBe('shared-secret');
    expect(brandEnv('goapply', 'S3_BUCKET', { S3_BUCKET: 'shared-bucket' })).toBe('shared-bucket');
    expect(brandStack('goapply', 'storage', env)).toBe('shared');
  });

  it('storage: CN_S3_BUCKET set and CN_S3_ACCESS_KEY_ID unset → the key is undefined, never the shared key', () => {
    const env = { S3_BUCKET: 'shared-bucket', S3_ACCESS_KEY_ID: 'AKIA-shared', AWS_ACCESS_KEY_ID: 'AKIA-aws', CN_S3_BUCKET: 'cn-bucket' };
    expect(brandEnv('goapply', 'S3_BUCKET', env)).toBe('cn-bucket');
    expect(brandEnv('goapply', 'S3_ACCESS_KEY_ID', env)).toBeUndefined();
    expect(brandEnv('goapply', 'AWS_ACCESS_KEY_ID', env)).toBeUndefined();
    expect(brandEnvSource('goapply', 'S3_ACCESS_KEY_ID', env)).toBe('none');
    expect(brandStack('goapply', 'storage', env)).toBe('own');
    // RoboApply still reads its own set.
    expect(brandEnv('roboapply', 'S3_BUCKET', env)).toBe('shared-bucket');
    expect(brandEnv('roboapply', 'S3_ACCESS_KEY_ID', env)).toBe('AKIA-shared');
  });

  it('voice: a CN LiveKit URL never pairs with the shared key or secret', () => {
    const shared = { LIVEKIT_URL: 'wss://shared', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', VOICE_PROVIDER: 'livekit_selfhosted' };
    expect(brandEnv('goapply', 'LIVEKIT_URL', shared)).toBe('wss://shared');
    expect(brandEnv('goapply', 'LIVEKIT_API_SECRET', shared)).toBe('s');
    expect(brandEnv('goapply', 'VOICE_PROVIDER', shared)).toBe('livekit_selfhosted');
    const mixed = { ...shared, CN_LIVEKIT_URL: 'wss://cn' };
    expect(brandEnv('goapply', 'LIVEKIT_URL', mixed)).toBe('wss://cn');
    expect(brandEnv('goapply', 'LIVEKIT_API_KEY', mixed)).toBeUndefined();
    expect(brandEnv('goapply', 'LIVEKIT_API_SECRET', mixed)).toBeUndefined();
    expect(brandEnv('goapply', 'VOICE_PROVIDER', mixed)).toBeUndefined();
    // A CN key without the CN URL does not start an own plane.
    expect(brandEnv('goapply', 'LIVEKIT_API_KEY', { ...shared, CN_LIVEKIT_API_KEY: 'cn-k' })).toBe('k');
  });

  it('speech: both CN models start the own set; one alone leaves the shared set whole', () => {
    const shared = { INTERVIEW_ENGINE_STT_MODEL: 'stt', INTERVIEW_ENGINE_TTS_MODEL: 'tts', INTERVIEW_ENGINE_TTS_VOICE: 'voice' };
    const half = { ...shared, CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/stt' };
    expect(brandStack('goapply', 'speech', half)).toBe('shared');
    expect(brandEnv('goapply', 'INTERVIEW_ENGINE_STT_MODEL', half)).toBe('stt');
    expect(brandEnv('goapply', 'INTERVIEW_ENGINE_TTS_MODEL', half)).toBe('tts');
    const full = { ...half, CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/tts' };
    expect(brandStack('goapply', 'speech', full)).toBe('own');
    expect(brandEnv('goapply', 'INTERVIEW_ENGINE_STT_MODEL', full)).toBe('dashscope/stt');
    expect(brandEnv('goapply', 'INTERVIEW_ENGINE_TTS_MODEL', full)).toBe('dashscope/tts');
    expect(brandEnv('goapply', 'INTERVIEW_ENGINE_TTS_VOICE', full)).toBeUndefined();
  });

  it('push: the VAPID pair and subject come from one set', () => {
    const shared = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.c' };
    expect(brandEnv('goapply', 'VAPID_PRIVATE_KEY', shared)).toBe('priv');
    expect(brandEnv('goapply', 'VAPID_PRIVATE_KEY', { ...shared, CN_VAPID_PUBLIC_KEY: 'cn-pub' })).toBeUndefined();
    expect(brandEnv('goapply', 'VAPID_SUBJECT', { ...shared, CN_VAPID_PUBLIC_KEY: 'cn-pub' })).toBeUndefined();
  });
});

describe('GoApply, every other name: CN_NAME ?? NAME, per key', () => {
  it.each(PER_KEY)('%s', (name) => {
    expect(brandEnvName('goapply', name)).toBe(`CN_${name}`);
    expect(brandEnv('goapply', name, { [name]: 'shared', [`CN_${name}`]: 'cn' })).toBe('cn');
    expect(brandEnv('goapply', name, { [name]: 'shared' })).toBe('shared');
    expect(brandEnv('goapply', name, { [name]: 'shared', [`CN_${name}`]: '  ' })).toBe('shared');
    expect(brandEnv('goapply', name, {})).toBeUndefined();
    expect(brandEnvSource('goapply', name, { [name]: 'shared', [`CN_${name}`]: 'cn' })).toBe('own');
    expect(brandEnvSource('goapply', name, { [name]: 'shared' })).toBe('shared');
    expect(brandEnvSource('goapply', name, {})).toBe('none');
    expect(brandEnvSource('roboapply', name, { [name]: 'shared' })).toBe('shared');
    expect(brandEnvSource('roboapply', name, {})).toBe('none');
    // The strict read does not fall back.
    expect(brandOwnEnv('goapply', name, { [name]: 'shared' })).toBeUndefined();
    expect(brandOwnEnv('goapply', name, { [name]: 'shared', [`CN_${name}`]: 'cn' })).toBe('cn');
  });

  it('a name nobody listed is per key too', () => {
    expect(brandEnv('goapply', 'SOME_NEW_SETTING', { SOME_NEW_SETTING: 'x' })).toBe('x');
    expect(brandEnv('goapply', 'SOME_NEW_SETTING', { SOME_NEW_SETTING: 'x', CN_SOME_NEW_SETTING: 'y' })).toBe('y');
  });
});

describe('brandEnv basics', () => {
  it('treats blank values as unset', () => {
    const env = { S3_BUCKET: 'intl-bucket', CN_S3_BUCKET: 'cn-bucket', EMPTY: '  ' };
    expect(brandEnv('roboapply', 'EMPTY', env)).toBeUndefined();
    expect(brandEnv('goapply', 'EMPTY', env)).toBeUndefined();
    expect(envSet(env, 'EMPTY')).toBe(false);
    expect(envSet(env, 'S3_BUCKET', 'CN_S3_BUCKET')).toBe(true);
  });

  it('trims the value', () => {
    expect(brandEnv('goapply', 'LLM_MODEL', { CN_LLM_MODEL: '  deepseek-chat ' })).toBe('deepseek-chat');
    expect(brandOwnEnv('goapply', 'LLM_MODEL', { CN_LLM_MODEL: '  deepseek-chat ' })).toBe('deepseek-chat');
  });

  it('brandEnvFlag inherits the rule', () => {
    const env = { FLAG: 'TRUE' };
    expect(brandEnvFlag('roboapply', 'FLAG', false, env)).toBe(true);
    // Per key: GoApply falls back to the shared value, and its own value wins.
    expect(brandEnvFlag('goapply', 'FLAG', false, env)).toBe(true);
    expect(brandEnvFlag('goapply', 'FLAG', true, { ...env, CN_FLAG: 'false' })).toBe(false);
    expect(brandEnvFlag('goapply', 'FLAG', true, {})).toBe(true);
    expect(brandEnvFlag('goapply', 'FLAG', false, {})).toBe(false);
    // Brand-own: the shared value is not read, so the fallback applies.
    expect(brandEnvFlag('goapply', 'MIN_EXT_VERSION', false, { MIN_EXT_VERSION: 'true' })).toBe(false);
    // Grouped: follows the group.
    expect(brandEnvFlag('goapply', 'S3_FORCE_PATH_STYLE', false, { S3_FORCE_PATH_STYLE: 'true' })).toBe(true);
    expect(brandEnvFlag('goapply', 'S3_FORCE_PATH_STYLE', false, { S3_FORCE_PATH_STYLE: 'true', CN_S3_BUCKET: 'cn' })).toBe(false);
  });

  it('rejects prefixed or lowercase names', () => {
    for (const fn of [brandEnvName, brandEnv, brandOwnEnv, brandEnvSource]) {
      expect(() => fn('goapply', 'CN_S3_BUCKET')).toThrow();
      expect(() => fn('goapply', 's3_bucket')).toThrow();
      expect(() => fn('roboapply', '')).toThrow();
    }
  });

  it('accepts a brand id or a brand object', async () => {
    const { BRANDS } = await import('./registry.js');
    expect(brandEnv(BRANDS.goapply, 'LLM_MODEL', { LLM_MODEL: 'x' })).toBe('x');
    expect(brandStack(BRANDS.goapply, 'voice', { CN_LIVEKIT_URL: 'wss://cn' })).toBe('own');
  });
});

describe('brandStack and brandUsesSharedStack', () => {
  /** GoApply with its own value for every stack and its own email transport. */
  const ALL_OWN: EnvSource = {
    CN_LLM_PROVIDER: 'deepseek',
    CN_LIVEKIT_URL: 'wss://cn',
    CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/stt',
    CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/tts',
    CN_S3_BUCKET: 'cn-bucket',
    CN_VAPID_PUBLIC_KEY: 'cn-pub',
    CN_EMAIL_TRANSPORT: 'aliyun_dm',
  };

  it('GoApply: shared for every stack with no CN value', () => {
    for (const group of BRAND_STACK_IDS) expect(brandStack('goapply', group, {}), group).toBe('shared');
    expect(brandUsesSharedStack('goapply', {})).toBe(true);
  });

  it('GoApply: own per stack when its anchor is set', () => {
    for (const group of BRAND_STACK_IDS) expect(brandStack('goapply', group, ALL_OWN), group).toBe('own');
    expect(brandStack('goapply', 'voice', { CN_LIVEKIT_URL: 'wss://cn' })).toBe('own');
    expect(brandStack('goapply', 'storage', { CN_LIVEKIT_URL: 'wss://cn' })).toBe('shared');
    expect(brandStack('goapply', 'voice', { CN_LIVEKIT_API_KEY: 'k' })).toBe('shared');
    expect(brandStack('goapply', 'push', { CN_VAPID_PRIVATE_KEY: 'priv' })).toBe('shared');
  });

  it("'llm' is own when CN_LLM_PROVIDER or CN_LLM_MODEL is set", () => {
    expect(brandStack('goapply', 'llm', { CN_LLM_PROVIDER: 'deepseek' })).toBe('own');
    expect(brandStack('goapply', 'llm', { CN_LLM_MODEL: 'deepseek-chat' })).toBe('own');
    expect(brandStack('goapply', 'llm', { CN_LLM_VISION_MODEL: 'qwen-vl', LLM_PROVIDER: 'openrouter', LLM_MODEL: 'x' })).toBe('shared');
    expect(brandStack('goapply', 'llm', { CN_LLM_PROVIDER: '  ' })).toBe('shared');
  });

  it('RoboApply always runs on the shared stack', () => {
    for (const group of BRAND_STACK_IDS) expect(brandStack('roboapply', group, ALL_OWN), group).toBe('shared');
    expect(brandUsesSharedStack('roboapply', ALL_OWN)).toBe(true);
    expect(brandUsesSharedStack('roboapply', {})).toBe(true);
  });

  it('brandUsesSharedStack(goapply) is false only when nothing resolves to the shared stack', () => {
    expect(brandUsesSharedStack('goapply', ALL_OWN)).toBe(false);
    for (const name of Object.keys(ALL_OWN)) {
      if (name === 'CN_EMAIL_TRANSPORT') continue;
      const env = { ...ALL_OWN };
      delete env[name];
      expect(brandUsesSharedStack('goapply', env), name).toBe(true);
    }
    // Email: unset and resend are the shared transport; aliyun_dm is GoApply's own; none sends nothing.
    const { CN_EMAIL_TRANSPORT: _t, ...noTransport } = ALL_OWN;
    expect(brandUsesSharedStack('goapply', noTransport)).toBe(true);
    expect(brandUsesSharedStack('goapply', { ...ALL_OWN, CN_EMAIL_TRANSPORT: 'resend' })).toBe(true);
    expect(brandUsesSharedStack('goapply', { ...ALL_OWN, CN_EMAIL_TRANSPORT: 'Aliyun_DM' })).toBe(false);
    expect(brandUsesSharedStack('goapply', { ...ALL_OWN, CN_EMAIL_TRANSPORT: 'none' })).toBe(false);
  });

  // Model settings are per key: GoApply's own provider does not cover a task
  // whose model still comes from an unprefixed LLM_* setting.
  it.each([
    ['a shared vision model with no CN vision model', { LLM_VISION_MODEL: 'openrouter/vision' }, true],
    ['the shared default model beside CN_LLM_PROVIDER', { LLM_MODEL: 'openrouter/x' }, true],
    ['a shared purpose selector that does not end in _MODEL', { LLM_FAST: 'openrouter/fast' }, true],
    ['a shared task model outside the stack table', { LLM_INTERVIEW_LIVE_MODEL: 'openai/realtime' }, true],
    ['a shared fallback model', { LLM_FALLBACK_MODEL: 'openrouter/fallback' }, true],
    ['the shared setting overridden by its CN twin', { LLM_VISION_MODEL: 'openrouter/vision', CN_LLM_VISION_MODEL: 'qwen-vl' }, false],
    ['the shared provider overridden by CN_LLM_PROVIDER', { LLM_PROVIDER: 'openrouter' }, false],
    ['a blank shared setting', { LLM_VISION_MODEL: '  ' }, false],
    ['shared tuning, which routes nothing', { LLM_TIMEOUT_MS: '30000', LLM_RETRY_ATTEMPTS: '3', LLM_REASONING_EFFORT: 'low', LLM_PII_KINDS: 'email' }, false],
    ['a non-LLM shared value', { TOTP_ENCRYPTION_KEY: 'k', COPILOT_DAILY_BUDGET_USD: '12.5' }, false],
  ])('own text-model stack, %s → %s', (_label, extra, expected) => {
    expect(brandStack('goapply', 'llm', { ...ALL_OWN, ...extra })).toBe('own');
    expect(brandUsesSharedStack('goapply', { ...ALL_OWN, ...extra })).toBe(expected);
  });

  it('own stack through CN_LLM_MODEL alone: a shared provider mode still routes the call', () => {
    const { CN_LLM_PROVIDER: _p, ...rest } = ALL_OWN;
    const ownModel = { ...rest, CN_LLM_MODEL: 'deepseek-chat' };
    expect(brandUsesSharedStack('goapply', ownModel)).toBe(false);
    expect(brandUsesSharedStack('goapply', { ...ownModel, LLM_PROVIDER: 'openrouter' })).toBe(true);
    expect(brandUsesSharedStack('goapply', { ...ownModel, LLM_PROVIDER: 'openrouter', CN_LLM_PROVIDER: 'deepseek' })).toBe(false);
  });

  it('the domestic-only wall keeps every route in the mainland, so shared LLM settings do not count', () => {
    const mixed = { ...ALL_OWN, LLM_VISION_MODEL: 'openrouter/vision', LLM_MODEL: 'openrouter/x' };
    expect(brandUsesSharedStack('goapply', mixed)).toBe(true);
    expect(brandUsesSharedStack('goapply', { ...mixed, CN_LLM_DOMESTIC_ONLY: 'true' })).toBe(false);
    expect(brandUsesSharedStack('goapply', { ...mixed, CN_RESIDENCY_STRICT: 'true' })).toBe(false);
    // The wall is about the text model only: another shared stack still counts.
    const { CN_S3_BUCKET: _b, ...sharedStorage } = mixed;
    expect(brandUsesSharedStack('goapply', { ...sharedStorage, CN_LLM_DOMESTIC_ONLY: 'true' })).toBe(true);
  });
});

describe('brandEnvGroupProblems: a half-set GoApply group is named, never silent', () => {
  it('nothing to report when a group is wholly unset, wholly shared or anchored', () => {
    expect(brandEnvGroupProblems('goapply', {})).toEqual([]);
    expect(brandEnvGroupProblems('goapply', { S3_BUCKET: 'shared', S3_ACCESS_KEY_ID: 'k', LIVEKIT_URL: 'wss://shared', VAPID_PUBLIC_KEY: 'p' })).toEqual([]);
    // Anchored: the group is GoApply's own. A missing member is "not configured", reported by the module that needs it.
    expect(brandEnvGroupProblems('goapply', { CN_S3_BUCKET: 'cn-bucket' })).toEqual([]);
    expect(brandEnvGroupProblems('goapply', { CN_LIVEKIT_URL: 'wss://cn', CN_LIVEKIT_API_KEY: 'k' })).toEqual([]);
    expect(
      brandEnvGroupProblems('goapply', { CN_INTERVIEW_ENGINE_STT_MODEL: 'stt', CN_INTERVIEW_ENGINE_TTS_MODEL: 'tts', CN_INTERVIEW_ENGINE_TTS_VOICE: 'v' }),
    ).toEqual([]);
  });

  it.each([
    [
      'storage: endpoint and keys without CN_S3_BUCKET',
      { CN_S3_ENDPOINT: 'https://oss', CN_S3_ACCESS_KEY_ID: 'k', CN_S3_SECRET_ACCESS_KEY: 's', S3_BUCKET: 'shared' },
      { group: 'storage', set: ['CN_S3_ENDPOINT', 'CN_S3_ACCESS_KEY_ID', 'CN_S3_SECRET_ACCESS_KEY'], missingAnchors: ['CN_S3_BUCKET'] },
    ],
    [
      'storage: a mistyped bucket name (CN_S3_BUCKT) beside the AWS alias',
      { CN_S3_BUCKT: 'cn-bucket', CN_AWS_REGION: 'cn-north-1' },
      { group: 'storage', set: ['CN_AWS_REGION'], missingAnchors: ['CN_S3_BUCKET'] },
    ],
    [
      'voice: key and provider without CN_LIVEKIT_URL',
      { CN_LIVEKIT_API_KEY: 'k', CN_VOICE_PROVIDER: 'livekit_selfhosted', LIVEKIT_URL: 'wss://shared' },
      { group: 'voice', set: ['CN_LIVEKIT_API_KEY', 'CN_VOICE_PROVIDER'], missingAnchors: ['CN_LIVEKIT_URL'] },
    ],
    [
      'voice: a blank CN_LIVEKIT_URL is unset',
      { CN_LIVEKIT_URL: '  ', CN_LIVEKIT_API_SECRET: 's' },
      { group: 'voice', set: ['CN_LIVEKIT_API_SECRET'], missingAnchors: ['CN_LIVEKIT_URL'] },
    ],
    [
      'speech: one model of the pair',
      { CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/stt' },
      { group: 'speech', set: ['CN_INTERVIEW_ENGINE_STT_MODEL'], missingAnchors: ['CN_INTERVIEW_ENGINE_TTS_MODEL'] },
    ],
    [
      'speech: a voice with neither model',
      { CN_INTERVIEW_ENGINE_TTS_VOICE: 'zh-voice' },
      {
        group: 'speech',
        set: ['CN_INTERVIEW_ENGINE_TTS_VOICE'],
        missingAnchors: ['CN_INTERVIEW_ENGINE_STT_MODEL', 'CN_INTERVIEW_ENGINE_TTS_MODEL'],
      },
    ],
    [
      'push: the private key without the public key',
      { CN_VAPID_PRIVATE_KEY: 'priv', CN_VAPID_SUBJECT: 'mailto:a@goapply.top' },
      { group: 'push', set: ['CN_VAPID_PRIVATE_KEY', 'CN_VAPID_SUBJECT'], missingAnchors: ['CN_VAPID_PUBLIC_KEY'] },
    ],
  ])('%s', (_label, env, problem) => {
    expect(brandEnvGroupProblems('goapply', env)).toEqual([problem]);
    // The rule itself is unchanged: the group is shared and the CN values are not read.
    expect(brandStack('goapply', problem.group as BrandEnvGroupId, env)).toBe('shared');
    for (const name of problem.set) expect(brandEnv('goapply', name.slice(3), env)).toBe((env as EnvSource)[name.slice(3)]);
    // RoboApply never reads a CN_ value, so it has nothing to report.
    expect(brandEnvGroupProblems('roboapply', env)).toEqual([]);
  });

  it('reports every half-set group, in group order, with names only (never a value)', () => {
    const env = { CN_VAPID_PRIVATE_KEY: 'secret-priv', CN_S3_SECRET_ACCESS_KEY: 'secret-s3', CN_LIVEKIT_URL: 'wss://cn' };
    const problems = brandEnvGroupProblems('goapply', env);
    expect(problems.map((p) => p.group)).toEqual(['storage', 'push']);
    expect(JSON.stringify(problems)).not.toContain('secret-');
  });
});

describe('the strict mainland posture is an explicit choice', () => {
  it('cnResidencyStrict: CN_RESIDENCY_STRICT=true only', () => {
    expect(cnResidencyStrict({})).toBe(false);
    expect(cnResidencyStrict({ CN_RESIDENCY_STRICT: '' })).toBe(false);
    expect(cnResidencyStrict({ CN_RESIDENCY_STRICT: 'false' })).toBe(false);
    expect(cnResidencyStrict({ CN_RESIDENCY_STRICT: 'true' })).toBe(true);
    expect(cnResidencyStrict({ CN_RESIDENCY_STRICT: ' ON ' })).toBe(true);
    // Never implied by a domestic provider, a mainland region or a missing value.
    expect(cnResidencyStrict({ CN_LLM_PROVIDER: 'deepseek', DEPLOY_REGION: 'cn-mainland', CN_LLM_DOMESTIC_ONLY: 'true' })).toBe(false);
  });

  it('cnLlmDomesticOnly: CN_LLM_DOMESTIC_ONLY=true, or the strict switch', () => {
    expect(cnLlmDomesticOnly({})).toBe(false);
    expect(cnLlmDomesticOnly({ CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat' })).toBe(false);
    expect(cnLlmDomesticOnly({ CN_LLM_DOMESTIC_ONLY: 'false' })).toBe(false);
    expect(cnLlmDomesticOnly({ CN_LLM_DOMESTIC_ONLY: 'true' })).toBe(true);
    expect(cnLlmDomesticOnly({ CN_RESIDENCY_STRICT: 'true' })).toBe(true);
    expect(cnLlmDomesticOnly({ CN_RESIDENCY_STRICT: 'true', CN_LLM_DOMESTIC_ONLY: 'false' })).toBe(true);
  });
});

describe('platform/brand/index.ts re-exports the seam', () => {
  it.each([
    'brandEnv',
    'brandEnvFlag',
    'brandEnvName',
    'brandOwnEnv',
    'brandEnvSource',
    'brandStack',
    'brandUsesSharedStack',
    'brandEnvGroupProblems',
    'allowedBrandsProblem',
    'cnResidencyStrict',
    'cnLlmDomesticOnly',
    'BRAND_OWN_ENV',
    'BRAND_ENV_GROUPS',
    'envSet',
    'parseBoolEnv',
  ])('%s', (name) => {
    expect((brandIndex as Record<string, unknown>)[name]).toBeDefined();
  });
});
