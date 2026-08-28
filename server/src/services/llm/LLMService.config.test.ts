import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LLMService } from './LLMService.js';

const ENV_KEYS = ['LLM_MODEL', 'LLM_SETTINGS_DB_DISABLED'] as const;

describe('LLMService model configuration', () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof saved;
    delete process.env.LLM_MODEL;
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
});
