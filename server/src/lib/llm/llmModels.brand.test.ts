// @vitest-environment node
//
// WP-14: per-brand model resolution (R-03/R-13). GoApply reads CN_* and its
// own DB key only; RoboApply keeps the unprefixed env and the historical key.

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
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_FALLBACK_MODEL', 'LLM_COPILOT_MODEL', 'LLM_FAST',
  'CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_FALLBACK_MODEL', 'CN_LLM_COPILOT_MODEL', 'CN_LLM_FAST',
  'LLM_SETTINGS_DB_DISABLED', 'NODE_ENV', 'BRAND_LOCK', 'ALLOWED_BRANDS',
];
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
  it('GoApply never falls back to the unprefixed variables', () => {
    runWithBrand('goapply', () => {
      expect(models.getProviderSetting()).toBeUndefined();
      expect(models.getDefaultModel()).toBeUndefined();
      expect(models.getFallbackModelSetting()).toBeUndefined();
      expect(models.getModelSetting('fast')).toBeUndefined();
      expect(tasks.getTaskModelOrDefault('copilot')).toBeUndefined();
    });
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

  it('requireLlmCallBrand refuses to guess only in production on a deployment that also serves GoApply', () => {
    process.env.ALLOWED_BRANDS = 'roboapply,goapply';
    expect(models.requireLlmCallBrand()).toEqual({ brandId: 'roboapply', source: 'default' });
    process.env.NODE_ENV = 'production';
    expect(() => models.requireLlmCallBrand()).toThrow(/runWithBrand/);
    expect(runWithBrand('goapply', () => models.requireLlmCallBrand())).toEqual({ brandId: 'goapply', source: 'context' });
    delete process.env.ALLOWED_BRANDS; // production default: RoboApply only, so it is the lock
    expect(models.requireLlmCallBrand()).toEqual({ brandId: 'roboapply', source: 'lock' });
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
  it('keys GoApply separately and never reads RoboApply\'s blob for it', async () => {
    delete process.env.LLM_SETTINGS_DB_DISABLED;
    process.env.NODE_ENV = 'development';
    expect(schema.appConfigKeyFor('development')).toBe('llm_stack.development');
    expect(schema.appConfigKeyFor('production', 'goapply')).toBe('llm_stack.goapply.production');

    const robo = schema.emptyLlmStackBlob();
    robo.defaultModel = 'openrouter/anthropic/claude-sonnet-4.6';
    db.rows['llm_stack.development'] = JSON.stringify(robo);
    await resolver.getLlmStack('roboapply');
    await resolver.getLlmStack('goapply');

    runWithBrand('roboapply', () => expect(models.getDefaultModel()).toBe('openrouter/anthropic/claude-sonnet-4.6'));
    runWithBrand('goapply', () => expect(models.getDefaultModel()).toBeUndefined());

    const go = schema.emptyLlmStackBlob();
    go.defaultModel = 'qwen/qwen-max';
    db.rows['llm_stack.goapply.development'] = JSON.stringify(go);
    resolver.invalidateLlmStack();
    await resolver.getLlmStack('goapply');
    runWithBrand('goapply', () => expect(models.getDefaultModel()).toBe('qwen/qwen-max'));
  });

  it('builds the env-defaults snapshot with the CN_ prefix for GoApply', () => {
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    expect(schema.buildEnvDefaultsSnapshot('goapply').defaultModel).toBe('deepseek-v4-flash');
    expect(schema.buildEnvDefaultsSnapshot().defaultModel).toBe('openrouter/openai/gpt-6-luna');
  });
});

describe('selectors and prompt locale', () => {
  it('pins qwen/ to DashScope only on GoApply', () => {
    expect(runWithBrand('roboapply', () => parseLlmSelector('qwen/qwen3.8-flash'))).toEqual({ model: 'qwen/qwen3.8-flash' });
    expect(runWithBrand('goapply', () => parseLlmSelector('qwen/qwen-plus'))).toEqual({ provider: 'qwen', model: 'qwen-plus' });
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
