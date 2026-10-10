import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithBrand } from '../../lib/requestContext.js';
import { LLMService } from './LLMService.js';

const ENV_KEYS = ['LLM_MODEL', 'LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_PROVIDER', 'LLM_SETTINGS_DB_DISABLED'] as const;

describe('LLMService model configuration', () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof saved;
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns the configured default model at call time', () => {
    process.env.LLM_MODEL = '  openrouter/openai/gpt-5.6-luna  ';

    expect(new LLMService().getModel()).toBe('openrouter/openai/gpt-5.6-luna');
  });

  it('fails clearly instead of selecting a hard-coded model', () => {
    expect(() => new LLMService().getModel()).toThrow('Set LLM_MODEL');
  });

  it('GoApply reads the shared default model and provider mode when it has none of its own', () => {
    process.env.LLM_MODEL = 'openrouter/openai/gpt-5.6-luna';
    runWithBrand('goapply', () => {
      expect(new LLMService().getModel()).toBe('openrouter/openai/gpt-5.6-luna');
      expect(new LLMService().getProvider()).toBe('openrouter');
    });
    process.env.LLM_PROVIDER = 'direct';
    expect(runWithBrand('goapply', () => new LLMService().getProvider())).toBe('direct');
    expect(runWithBrand('roboapply', () => new LLMService().getProvider())).toBe('direct');
    // Its own model and provider win when set.
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    runWithBrand('goapply', () => {
      expect(new LLMService().getModel()).toBe('deepseek-v4-flash');
      expect(new LLMService().getProvider()).toBe('deepseek');
    });
    expect(runWithBrand('roboapply', () => new LLMService().getModel())).toBe('openrouter/openai/gpt-5.6-luna');
  });

  it('names the variable GoApply really reads when no model is configured', () => {
    // On the shared stack the missing variable is the shared one.
    expect(() => runWithBrand('goapply', () => new LLMService().getModel())).toThrow('Set LLM_MODEL');
    // With a provider of its own, its override is the one to set.
    process.env.CN_LLM_PROVIDER = 'deepseek';
    expect(() => runWithBrand('goapply', () => new LLMService().getModel())).toThrow('Set CN_LLM_MODEL');
  });
});
