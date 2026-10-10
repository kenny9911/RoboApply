// @vitest-environment node
//
// Per-brand, per-key model resolution (D5; GOAPPLY_PARITY_PLAN.md §3.3).
// GoApply: its own blob ?? CN_<NAME> ?? RoboApply's blob ?? <NAME>. RoboApply
// keeps the unprefixed env and the historical key and never reads a CN_ value.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: {} as Record<string, string> }));
vi.mock('../prisma.js', () => ({
  prisma: {
    appConfig: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        db.rows[where.key] ? { key: where.key, value: db.rows[where.key], updatedAt: new Date(), updatedBy: 'admin' } : null,
      ),
    },
  },
}));
vi.mock('../../services/LoggerService.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const models = await import('./llmModels.js');
const tasks = await import('./llmTaskSettings.js');
const resolver = await import('./llmStackConfigResolver.js');
const schema = await import('./llmStackConfigSchema.js');
const { runWithBrand } = await import('../requestContext.js');
const { parseLlmSelector } = await import('./llmSelector.js');
const { resolvePromptLocale, defaultPromptLocale } = await import('./promptLocale.js');

const NAMES = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_FALLBACK_MODEL', 'LLM_COPILOT_MODEL', 'LLM_FAST', 'LLM_VISION_MODEL', 'LLM_CAMPUS_MODEL',
  'CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_FALLBACK_MODEL', 'CN_LLM_COPILOT_MODEL', 'CN_LLM_FAST', 'CN_LLM_VISION_MODEL', 'CN_LLM_CAMPUS_MODEL',
  'CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT',
  'LLM_SETTINGS_DB_DISABLED', 'NODE_ENV', 'BRAND_LOCK', 'ALLOWED_BRANDS',
];
const ALL_KEYS = ['defaultModel', 'fallbackModel', ...schema.PURPOSE_KEYS] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
  process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  process.env.LLM_PROVIDER = 'openrouter';
  process.env.LLM_MODEL = 'openrouter/openai/gpt-6-luna';
  process.env.LLM_FALLBACK_MODEL = 'google/gemini-3.8-flash';
  process.env.LLM_FAST = 'openrouter/openai/gpt-6-luna';
  db.rows = {};
  resolver.invalidateLlmStack();
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('env resolution per brand', () => {
  it('with no CN_LLM_* and no GoApply blob, every model key and the provider mode resolve to the same strings for both brands', () => {
    process.env.LLM_VISION_MODEL = 'google/gemini-3.8-flash';
    process.env.LLM_COPILOT_MODEL = 'qwen/qwen3.8-flash'; // an OpenRouter id on the shared stack; it must not be rewritten
    for (const key of ALL_KEYS) {
      expect(models.getModelSetting(key, 'goapply'), key).toBe(models.getModelSetting(key, 'roboapply'));
    }
    expect(models.getProviderSetting('goapply')).toBe('openrouter');
    expect(models.getProviderSetting('goapply')).toBe(models.getProviderSetting('roboapply'));
    expect(models.getLlmRoutingDefaults('goapply')).toEqual(models.getLlmRoutingDefaults('roboapply'));
    expect(models.effectiveLlmProfile('goapply')).toBe('global');
    runWithBrand('goapply', () => {
      expect(models.getDefaultModel()).toBe('openrouter/openai/gpt-6-luna');
      expect(models.getFallbackModelSetting()).toBe('google/gemini-3.8-flash');
      expect(models.getModelSetting('fast')).toBe('openrouter/openai/gpt-6-luna');
      expect(models.getModelSetting('copilot')).toBe('qwen/qwen3.8-flash');
      expect(tasks.getTaskModelOrDefault('enrich')).toBe('openrouter/openai/gpt-6-luna');
      // The value is the shared one, and says so.
      expect(models.resolveModelKey('defaultModel')).toMatchObject({
        envName: 'CN_LLM_MODEL',
        sharedEnvName: 'LLM_MODEL',
        env: null,
        shared: 'openrouter/openai/gpt-6-luna',
        effective: 'openrouter/openai/gpt-6-luna',
        source: 'shared',
      });
      expect(models.resolveModelKey('extract')).toMatchObject({ effective: null, source: 'none' });
    });
    expect(models.llmUsesSharedStack('goapply')).toBe(true);
  });

  it('mixed case: GoApply with its own provider reads an unset key from the shared stack, qualified to its real route', () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    expect(models.effectiveLlmProfile('goapply')).toBe('domestic_cn');
    // A shared selector with a routing prefix already names its route: unchanged.
    process.env.LLM_VISION_MODEL = 'google/gemini-3.8-flash';
    expect(models.getModelSetting('vision', 'goapply')).toBe('google/gemini-3.8-flash');
    // A bare shared id runs through the SHARED provider mode, never GoApply's own provider.
    process.env.LLM_VISION_MODEL = 'gpt-6-vision';
    expect(models.getModelSetting('vision', 'goapply')).toBe('openrouter/gpt-6-vision');
    // On the shared stack qwen/ is an OpenRouter id; on GoApply's own stack it would mean DashScope.
    process.env.LLM_VISION_MODEL = 'qwen/qwen3.8-vl';
    expect(models.getModelSetting('vision', 'goapply')).toBe('openrouter/qwen/qwen3.8-vl');
    expect(models.resolveModelKey('vision', 'goapply')).toMatchObject({
      env: null,
      shared: 'qwen/qwen3.8-vl',
      effective: 'openrouter/qwen/qwen3.8-vl',
      source: 'shared',
    });
    // RoboApply reads its own value as written, and never a CN_ one.
    expect(models.getModelSetting('vision', 'roboapply')).toBe('qwen/qwen3.8-vl');
    expect(models.getDefaultModel('roboapply')).toBe('openrouter/openai/gpt-6-luna');
    expect(models.getProviderSetting('roboapply')).toBe('openrouter');
    expect(models.resolveModelKey('defaultModel', 'roboapply')).toMatchObject({ envName: 'LLM_MODEL', sharedEnvName: null, shared: null, source: 'env' });
    // GoApply's own keys stay as written; its own override of the same key wins over the shared one.
    expect(models.getDefaultModel('goapply')).toBe('deepseek-v4-flash');
    process.env.CN_LLM_VISION_MODEL = 'qwen/qwen-vl-max';
    expect(models.getModelSetting('vision', 'goapply')).toBe('qwen/qwen-vl-max');
    // Its routing defaults are its own: a bare id goes to its own provider.
    expect(models.getLlmRoutingDefaults('goapply')).toEqual({ profile: 'domestic_cn', providerMode: 'deepseek', model: 'deepseek-v4-flash' });
    expect(models.llmUsesSharedStack('goapply')).toBe(true); // fast and fallback still come from the shared stack
  });

  it('a GoApply default model without a provider of its own: the shared provider mode is not borrowed for its bare ids', () => {
    process.env.CN_LLM_MODEL = 'qwen-plus';
    expect(models.getProviderSetting('goapply')).toBe('openrouter'); // the setting itself is per key
    expect(models.resolveProviderSetting('goapply')).toEqual({ value: 'openrouter', source: 'shared' });
    expect(models.getLlmRoutingDefaults('goapply')).toEqual({ profile: 'domestic_cn', providerMode: '', model: 'qwen-plus' });
  });

  describe('behind the domestic-only wall (CN_LLM_DOMESTIC_ONLY, or CN_RESIDENCY_STRICT)', () => {
    const ownDeepSeek = () => {
      process.env.CN_LLM_PROVIDER = 'deepseek';
      process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    };

    it.each(['CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT'])('%s: a shared task model does not shadow GoApply\'s own mainland default', (switchName) => {
      process.env[switchName] = 'true';
      ownDeepSeek();
      process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
      process.env.LLM_VISION_MODEL = 'gpt-6-vision'; // a bare shared id: OpenRouter on the shared stack
      // The key counts as unset, so the task falls back to GoApply's own default.
      expect(models.getModelSetting('copilot', 'goapply')).toBeUndefined();
      expect(tasks.getTaskModelOrDefault('copilot', 'goapply')).toBe('deepseek-v4-flash');
      expect(models.getModelSetting('vision', 'goapply')).toBeUndefined();
      expect(models.getModelSetting('fast', 'goapply')).toBeUndefined();
      expect(models.getFallbackModelSetting('goapply')).toBeUndefined();
      // The admin view says what was set aside and why nothing runs from it.
      expect(models.resolveModelKey('copilot', 'goapply')).toMatchObject({
        envName: 'CN_LLM_COPILOT_MODEL',
        sharedEnvName: 'LLM_COPILOT_MODEL',
        env: null,
        shared: null,
        sharedWalledOff: 'openrouter/openai/gpt-6-luna',
        effective: null,
        source: 'none',
      });
      // GoApply's own value of the same key wins as always.
      process.env.CN_LLM_COPILOT_MODEL = 'kimi/kimi-k2';
      expect(models.resolveModelKey('copilot', 'goapply')).toMatchObject({ effective: 'kimi/kimi-k2', source: 'env' });
      // RoboApply is not behind GoApply's wall: every key as written.
      expect(models.getModelSetting('copilot', 'roboapply')).toBe('openrouter/openai/gpt-6-luna');
      expect(models.getModelSetting('vision', 'roboapply')).toBe('gpt-6-vision');
      expect(models.resolveModelKey('copilot', 'roboapply')).toMatchObject({ sharedWalledOff: null, source: 'env' });
      expect(models.getLlmRoutingDefaults('roboapply')).toEqual({ profile: 'global', providerMode: 'openrouter', model: 'openrouter/openai/gpt-6-luna' });
    });

    it('a shared value that names a mainland vendor is still inherited', () => {
      process.env.CN_LLM_DOMESTIC_ONLY = 'true';
      ownDeepSeek();
      process.env.LLM_COPILOT_MODEL = 'kimi/kimi-k2';
      process.env.LLM_VISION_MODEL = 'dashscope/qwen-vl-max';
      process.env.LLM_FAST = 'qwen/qwen3.8-flash'; // an OpenRouter id on the shared stack, not DashScope
      expect(models.resolveModelKey('copilot', 'goapply')).toMatchObject({ effective: 'kimi/kimi-k2', source: 'shared', sharedWalledOff: null });
      expect(models.getModelSetting('vision', 'goapply')).toBe('dashscope/qwen-vl-max');
      expect(models.resolveModelKey('fast', 'goapply')).toMatchObject({ effective: null, source: 'none', sharedWalledOff: 'qwen/qwen3.8-flash' });
      // A gateway cannot be judged by its name: the shared one is not borrowed.
      process.env.LLM_COPILOT_MODEL = 'newapi/some-model';
      expect(models.getModelSetting('copilot', 'goapply')).toBeUndefined();
    });

    it('with no provider or model of its own GoApply has no model and no default gateway (nothing can leave the mainland)', () => {
      process.env.CN_LLM_DOMESTIC_ONLY = 'true';
      expect(models.effectiveLlmProfile('goapply')).toBe('global');
      for (const key of ALL_KEYS) expect(models.getModelSetting(key, 'goapply'), key).toBeUndefined();
      expect(models.resolveProviderSetting('goapply')).toEqual({ value: undefined, source: 'none' });
      expect(models.getLlmRoutingDefaults('goapply')).toEqual({ profile: 'global', providerMode: '', model: undefined });
      // A shared stack that itself runs on a mainland vendor is inherited whole.
      process.env.LLM_PROVIDER = 'deepseek';
      process.env.LLM_MODEL = 'deepseek-v4-flash';
      expect(models.getLlmRoutingDefaults('goapply')).toEqual({ profile: 'global', providerMode: 'deepseek', model: 'deepseek-v4-flash' });
      expect(models.resolveModelKey('defaultModel', 'goapply')).toMatchObject({ source: 'shared', sharedWalledOff: null });
    });

    it('a selector variable outside the stack table follows the same rule (getEnvModelSetting)', () => {
      process.env.CN_LLM_DOMESTIC_ONLY = 'true';
      ownDeepSeek();
      process.env.LLM_CAMPUS_MODEL = 'openai/gpt-campus';
      expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'goapply')).toBeUndefined();
      expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'roboapply')).toBe('openai/gpt-campus');
      process.env.LLM_CAMPUS_MODEL = 'deepseek/deepseek-chat';
      expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'goapply')).toBe('deepseek/deepseek-chat');
    });

    it('llmUsesSharedStack is false: no route leaves the mainland, whichever variable names it (as the LLM part of brandUsesSharedStack)', () => {
      process.env.CN_LLM_PROVIDER = 'deepseek';
      process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
      // LLM_FAST, LLM_MODEL and LLM_FALLBACK_MODEL are set (beforeEach): shared values exist.
      expect(models.llmUsesSharedStack('goapply')).toBe(true);
      process.env.CN_LLM_DOMESTIC_ONLY = 'true';
      expect(models.llmUsesSharedStack('goapply')).toBe(false);
      // Also with no stack of its own, and with a shared value it does inherit (a mainland vendor).
      delete process.env.CN_LLM_PROVIDER;
      delete process.env.CN_LLM_MODEL;
      expect(models.llmUsesSharedStack('goapply')).toBe(false);
      process.env.LLM_COPILOT_MODEL = 'kimi/kimi-k2';
      expect(models.llmUsesSharedStack('goapply')).toBe(false);
      delete process.env.CN_LLM_DOMESTIC_ONLY;
      process.env.CN_RESIDENCY_STRICT = 'true';
      expect(models.llmUsesSharedStack('goapply')).toBe(false);
      // RoboApply IS the shared stack.
      expect(models.llmUsesSharedStack('roboapply')).toBe(true);
    });
  });

  it('a GoApply task model written in the domestic dialect keeps its meaning while GoApply runs on the shared profile', () => {
    process.env.CN_LLM_VISION_MODEL = 'qwen/qwen-vl-max';
    expect(models.effectiveLlmProfile('goapply')).toBe('global');
    expect(models.getModelSetting('vision', 'goapply')).toBe('dashscope/qwen-vl-max');
    expect(models.resolveModelKey('vision', 'goapply')).toMatchObject({ env: 'qwen/qwen-vl-max', effective: 'dashscope/qwen-vl-max', source: 'env' });
    process.env.CN_LLM_VISION_MODEL = 'deepseek/deepseek-v4-flash';
    expect(models.getModelSetting('vision', 'goapply')).toBe('deepseek/deepseek-v4-flash');
  });

  it('a selector variable outside the stack table follows the same per-key rule (getEnvModelSetting)', () => {
    process.env.LLM_CAMPUS_MODEL = 'gpt-6-luna';
    expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'roboapply')).toBe('gpt-6-luna');
    expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'goapply')).toBe('gpt-6-luna');
    process.env.CN_LLM_PROVIDER = 'deepseek';
    expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'goapply')).toBe('openrouter/gpt-6-luna');
    process.env.CN_LLM_CAMPUS_MODEL = 'kimi/kimi-k2';
    expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'goapply')).toBe('kimi/kimi-k2');
    expect(models.getEnvModelSetting('LLM_CAMPUS_MODEL', 'roboapply')).toBe('gpt-6-luna');
    // An explicit env table is read instead of process.env.
    expect(models.getModelSetting('defaultModel', 'goapply', { LLM_MODEL: 'x/y' })).toBe('x/y');
    expect(models.getModelSetting('defaultModel', 'goapply', { LLM_MODEL: 'x/y', CN_LLM_MODEL: 'deepseek/z' })).toBe('deepseek/z');
    expect(models.getModelSetting('defaultModel', 'roboapply', { LLM_MODEL: 'x/y', CN_LLM_MODEL: 'deepseek/z' })).toBe('x/y');
  });

  it('GoApply reads CN_*; RoboApply keeps reading the unprefixed names', () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    process.env.CN_LLM_COPILOT_MODEL = 'qwen/qwen-plus';
    runWithBrand('goapply', () => {
      expect(models.getProviderSetting()).toBe('deepseek');
      expect(models.getDefaultModel()).toBe('deepseek-v4-flash');
      expect(tasks.getTaskModel('copilot')).toBe('qwen/qwen-plus');
      expect(tasks.getTaskModelOrDefault('enrich')).toBe('deepseek-v4-flash');
      expect(models.resolveModelKey('copilot')).toMatchObject({ envName: 'CN_LLM_COPILOT_MODEL', source: 'env' });
    });
    runWithBrand('roboapply', () => {
      expect(models.getDefaultModel()).toBe('openrouter/openai/gpt-6-luna');
      expect(tasks.getTaskModel('copilot')).toBeUndefined();
      expect(tasks.getTaskModelOrDefault('copilot')).toBe('openrouter/openai/gpt-6-luna');
    });
    // An explicit brand argument wins over the ambient one.
    runWithBrand('roboapply', () => expect(models.getDefaultModel('goapply')).toBe('deepseek-v4-flash'));
  });

  it('defaults to RoboApply outside any brand context (legacy callers)', () => {
    expect(models.getDefaultModel()).toBe('openrouter/openai/gpt-6-luna');
  });

  it('outside any context on a GoApply-only deployment, reads CN_* (BRAND_LOCK or a single ALLOWED_BRANDS entry)', () => {
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    process.env.BRAND_LOCK = 'goapply';
    expect(models.contextlessLlmBrand()).toEqual({ brandId: 'goapply', source: 'lock' });
    expect(models.getDefaultModel()).toBe('deepseek-v4-flash');
    delete process.env.BRAND_LOCK;
    process.env.ALLOWED_BRANDS = 'goapply';
    expect(models.getDefaultModel()).toBe('deepseek-v4-flash');
    expect(parseLlmSelector('qwen/qwen-plus')).toEqual({ provider: 'qwen', model: 'qwen-plus' });
    // The ambient context still wins over the lock.
    runWithBrand('roboapply', () => expect(models.getDefaultModel()).toBe('openrouter/openai/gpt-6-luna'));
  });

  it('requireLlmCallBrand refuses to guess only in production and only where a wrong guess crosses a wall an operator chose', () => {
    process.env.ALLOWED_BRANDS = 'roboapply,goapply';
    expect(models.requireLlmCallBrand()).toEqual({ brandId: 'roboapply', source: 'default' });
    process.env.NODE_ENV = 'production';
    // Both brands served, shared stack only: both route the same way, so the default brand is a safe answer.
    expect(models.requireLlmCallBrand()).toEqual({ brandId: 'roboapply', source: 'default' });
    delete process.env.ALLOWED_BRANDS; // the production default serves both brands too
    expect(models.requireLlmCallBrand()).toEqual({ brandId: 'roboapply', source: 'default' });
    // GoApply has an LLM stack of its own: a GoApply prompt would leave by the wrong route.
    process.env.CN_LLM_PROVIDER = 'deepseek';
    expect(() => models.requireLlmCallBrand()).toThrow(/runWithBrand/);
    expect(runWithBrand('goapply', () => models.requireLlmCallBrand())).toEqual({ brandId: 'goapply', source: 'context' });
    delete process.env.CN_LLM_PROVIDER;
    process.env.CN_LLM_MODEL = 'deepseek/deepseek-v4-flash';
    expect(() => models.requireLlmCallBrand()).toThrow(/runWithBrand/);
    delete process.env.CN_LLM_MODEL;
    // The domestic-only wall, or the strict residency switch that implies it.
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    expect(() => models.requireLlmCallBrand()).toThrow(/runWithBrand/);
    delete process.env.CN_LLM_DOMESTIC_ONLY;
    process.env.CN_RESIDENCY_STRICT = 'true';
    expect(() => models.requireLlmCallBrand()).toThrow(/runWithBrand/);
    // A deployment that does not serve GoApply has no wall to cross; it is locked to its one brand.
    process.env.ALLOWED_BRANDS = 'roboapply';
    process.env.CN_LLM_PROVIDER = 'deepseek';
    expect(models.requireLlmCallBrand()).toEqual({ brandId: 'roboapply', source: 'lock' });
    // Outside production the default is always returned (tests, scripts).
    delete process.env.ALLOWED_BRANDS;
    process.env.NODE_ENV = 'test';
    expect(models.requireLlmCallBrand()).toEqual({ brandId: 'roboapply', source: 'default' });
  });

  it('lists every model env var for both brands, CN_ twins included (cost coverage)', () => {
    for (const name of Object.values(schema.MODEL_ENV)) {
      expect(schema.ALL_BRAND_MODEL_ENV_VARS).toContain(name);
      expect(schema.ALL_BRAND_MODEL_ENV_VARS).toContain(`CN_${name}`);
    }
    expect(schema.ALL_BRAND_MODEL_ENV_VARS).toContain('CN_LLM_COPILOT_MODEL');
  });

  it('registers the clone tasks with their env names', () => {
    expect(tasks.LLM_TASKS).toEqual(expect.arrayContaining(['copilot', 'enrich', 'writing']));
    expect(schema.MODEL_ENV).toMatchObject({ copilot: 'LLM_COPILOT_MODEL', enrich: 'LLM_ENRICH_MODEL', writing: 'LLM_WRITING_MODEL' });
    expect(tasks.isLlmTask('copilot')).toBe(true);
    expect(tasks.isLlmTask('nope')).toBe(false);
  });
});

describe('DB overrides per brand', () => {
  it('GoApply: its own blob, then CN_<NAME>, then RoboApply\'s blob, then <NAME>; RoboApply never reads GoApply\'s', async () => {
    delete process.env.LLM_SETTINGS_DB_DISABLED;
    process.env.NODE_ENV = 'development';
    expect(schema.appConfigKeyFor('development')).toBe('llm_stack.development');
    expect(schema.appConfigKeyFor('production', 'goapply')).toBe('llm_stack.goapply.production');
    const load = async () => {
      resolver.invalidateLlmStack();
      await resolver.getLlmStack('roboapply');
      await resolver.getLlmStack('goapply');
    };

    // 4. Nothing but the shared variable.
    await load();
    expect(models.getDefaultModel('goapply')).toBe('openrouter/openai/gpt-6-luna');

    // 3. RoboApply's admin override is the shared stack's value: GoApply follows it.
    const robo = schema.emptyLlmStackBlob();
    robo.defaultModel = 'openrouter/anthropic/claude-sonnet-4.6';
    robo.purposes.vision = 'google/gemini-3.8-flash';
    db.rows['llm_stack.development'] = JSON.stringify(robo);
    await load();
    runWithBrand('roboapply', () => expect(models.getDefaultModel()).toBe('openrouter/anthropic/claude-sonnet-4.6'));
    runWithBrand('goapply', () => {
      expect(models.getDefaultModel()).toBe('openrouter/anthropic/claude-sonnet-4.6');
      expect(models.resolveModelKey('defaultModel')).toMatchObject({ override: null, env: null, shared: 'openrouter/anthropic/claude-sonnet-4.6', source: 'shared' });
    });

    // 2. CN_<NAME> wins over the shared stack (blob and variable).
    process.env.CN_LLM_MODEL = 'deepseek/deepseek-v4-flash';
    expect(models.getDefaultModel('goapply')).toBe('deepseek/deepseek-v4-flash');
    expect(models.resolveModelKey('defaultModel', 'goapply').source).toBe('env');
    // The key it has not overridden still comes from RoboApply's blob.
    expect(models.getModelSetting('vision', 'goapply')).toBe('google/gemini-3.8-flash');

    // 1. GoApply's own blob wins over everything.
    const go = schema.emptyLlmStackBlob();
    go.defaultModel = 'qwen/qwen-max';
    go.provider = 'qwen';
    db.rows['llm_stack.goapply.development'] = JSON.stringify(go);
    await load();
    runWithBrand('goapply', () => {
      expect(models.getDefaultModel()).toBe('qwen/qwen-max');
      expect(models.getProviderSetting()).toBe('qwen');
      expect(models.resolveModelKey('defaultModel')).toMatchObject({ override: 'qwen/qwen-max', env: 'deepseek/deepseek-v4-flash', source: 'override' });
    });
    // RoboApply is untouched by GoApply's blob and by CN_ values.
    runWithBrand('roboapply', () => {
      expect(models.getDefaultModel()).toBe('openrouter/anthropic/claude-sonnet-4.6');
      expect(models.getProviderSetting()).toBe('openrouter');
    });
  });

  it('a provider in the GoApply blob alone makes its profile domestic (no env variable involved)', async () => {
    delete process.env.LLM_SETTINGS_DB_DISABLED;
    process.env.NODE_ENV = 'development';
    expect(models.effectiveLlmProfile('goapply')).toBe('global');
    const go = schema.emptyLlmStackBlob();
    go.provider = 'deepseek';
    db.rows['llm_stack.goapply.development'] = JSON.stringify(go);
    resolver.invalidateLlmStack();
    await resolver.getLlmStack('goapply');
    await resolver.getLlmStack('roboapply');
    expect(models.effectiveLlmProfile('goapply')).toBe('domestic_cn');
    expect(models.effectiveLlmProfile('roboapply')).toBe('global');
    // The default model still comes from the shared stack, qualified so it never reaches DeepSeek.
    process.env.LLM_MODEL = 'gpt-6-luna';
    expect(models.getDefaultModel('goapply')).toBe('openrouter/gpt-6-luna');
    expect(models.getLlmRoutingDefaults('goapply')).toEqual({ profile: 'domestic_cn', providerMode: 'deepseek', model: 'openrouter/gpt-6-luna' });
    // With overrides switched off the blob is not read.
    process.env.LLM_SETTINGS_DB_DISABLED = 'true';
    expect(models.effectiveLlmProfile('goapply')).toBe('global');
  });

  it('behind the wall an international value in RoboApply\'s blob is not inherited either; GoApply\'s own blob still wins', async () => {
    delete process.env.LLM_SETTINGS_DB_DISABLED;
    process.env.NODE_ENV = 'development';
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    const robo = schema.emptyLlmStackBlob();
    robo.purposes.copilot = 'openrouter/openai/gpt-6-sol';
    robo.purposes.rewrite = 'kimi/kimi-k2';
    const go = schema.emptyLlmStackBlob();
    go.provider = 'deepseek';
    go.defaultModel = 'deepseek-v4-flash';
    db.rows['llm_stack.development'] = JSON.stringify(robo);
    db.rows['llm_stack.goapply.development'] = JSON.stringify(go);
    resolver.invalidateLlmStack();
    await resolver.getLlmStack('goapply');
    await resolver.getLlmStack('roboapply');
    expect(models.resolveModelKey('copilot', 'goapply')).toMatchObject({ effective: null, source: 'none', sharedWalledOff: 'openrouter/openai/gpt-6-sol' });
    expect(tasks.getTaskModelOrDefault('copilot', 'goapply')).toBe('deepseek-v4-flash');
    expect(models.resolveModelKey('rewrite', 'goapply')).toMatchObject({ effective: 'kimi/kimi-k2', source: 'shared', sharedWalledOff: null });
    expect(models.getLlmRoutingDefaults('goapply')).toEqual({ profile: 'domestic_cn', providerMode: 'deepseek', model: 'deepseek-v4-flash' });
    expect(models.llmUsesSharedStack('goapply')).toBe(false);
    // RoboApply reads its own blob as written.
    expect(models.getModelSetting('copilot', 'roboapply')).toBe('openrouter/openai/gpt-6-sol');
    // Without the wall the same value is inherited (qualified already), and counts as the shared stack.
    delete process.env.CN_LLM_DOMESTIC_ONLY;
    expect(models.getModelSetting('copilot', 'goapply')).toBe('openrouter/openai/gpt-6-sol');
    expect(models.llmUsesSharedStack('goapply')).toBe(true);
  });

  it('builds the env-defaults snapshot for GoApply from CN_<NAME>, else the shared name', () => {
    expect(schema.buildEnvDefaultsSnapshot('goapply').defaultModel).toBe('openrouter/openai/gpt-6-luna');
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    expect(schema.buildEnvDefaultsSnapshot('goapply').defaultModel).toBe('deepseek-v4-flash');
    expect(schema.buildEnvDefaultsSnapshot('goapply').purposes.fast).toBe('openrouter/openai/gpt-6-luna');
    expect(schema.buildEnvDefaultsSnapshot().defaultModel).toBe('openrouter/openai/gpt-6-luna');
  });
});

describe('selectors and prompt locale', () => {
  it('pins qwen/ to DashScope only on the domestic profile (GoApply with a provider of its own)', () => {
    expect(runWithBrand('roboapply', () => parseLlmSelector('qwen/qwen3.8-flash'))).toEqual({ model: 'qwen/qwen3.8-flash' });
    // GoApply on the shared stack reads a selector as RoboApply does.
    expect(runWithBrand('goapply', () => parseLlmSelector('qwen/qwen3.8-flash'))).toEqual({ model: 'qwen/qwen3.8-flash' });
    process.env.CN_LLM_PROVIDER = 'deepseek';
    expect(runWithBrand('goapply', () => parseLlmSelector('qwen/qwen-plus'))).toEqual({ provider: 'qwen', model: 'qwen-plus' });
    expect(runWithBrand('roboapply', () => parseLlmSelector('qwen/qwen3.8-flash'))).toEqual({ model: 'qwen/qwen3.8-flash' });
    expect(parseLlmSelector('dashscope/qwen-plus')).toEqual({ provider: 'qwen', model: 'qwen-plus' });
    expect(parseLlmSelector('zhipu/glm-4.6')).toEqual({ provider: 'glm', model: 'glm-4.6' });
    expect(parseLlmSelector('ark/doubao-seed')).toEqual({ provider: 'doubao', model: 'doubao-seed' });
    expect(parseLlmSelector('deepseek/deepseek-v4-pro')).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });

  it('defaults the prompt locale to zh on GoApply', () => {
    expect(defaultPromptLocale('goapply')).toBe('zh');
    expect(defaultPromptLocale('roboapply')).toBe('en');
    expect(resolvePromptLocale(undefined, 'goapply')).toBe('zh');
    expect(resolvePromptLocale('ja', 'goapply')).toBe('zh');
    expect(resolvePromptLocale('en', 'goapply')).toBe('en');
    expect(resolvePromptLocale('zh-tw', 'roboapply')).toBe('zh-TW');
    expect(runWithBrand('goapply', () => resolvePromptLocale(null))).toBe('zh');
  });
});
