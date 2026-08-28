import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RAJobMatchScorerAgent,
  pickJobMatchScorerModel,
  resolvedJobMatchScorerModel,
} from './RAJobMatchScorerAgent.js';

const MODEL_ENV_KEYS = [
  'LLM_MATCHING_MODEL',
  'LLM_MATCHING_REASONING_EFFORT',
  'LLM_MODEL',
  'LLM_SETTINGS_DB_DISABLED',
  'RA_V2_JOB_MATCH_SCORER_MODEL',
] as const;

class ScorerProbe extends RAJobMatchScorerAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

describe('pickJobMatchScorerModel', () => {
  let savedEnv: Record<(typeof MODEL_ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      MODEL_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as typeof savedEnv;
    for (const key of MODEL_ENV_KEYS) delete process.env[key];
    process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  });

  afterEach(() => {
    for (const key of MODEL_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses LLM_MATCHING_MODEL at call time', () => {
    process.env.LLM_MATCHING_MODEL = '  deepseek/deepseek-v4-flash  ';

    expect(pickJobMatchScorerModel()).toBe('deepseek/deepseek-v4-flash');
  });

  it('does not let the retired scorer-specific env override the matching model', () => {
    process.env.LLM_MATCHING_MODEL = 'deepseek/deepseek-v4-flash';
    process.env.RA_V2_JOB_MATCH_SCORER_MODEL = 'legacy/scorer-model';

    expect(pickJobMatchScorerModel()).toBe('deepseek/deepseek-v4-flash');
  });

  it('falls through to the configured stack default when the task model is blank', () => {
    process.env.LLM_MATCHING_MODEL = '   ';
    process.env.LLM_MODEL = 'openrouter/test/default-model';

    expect(pickJobMatchScorerModel()).toBeUndefined();
    expect(resolvedJobMatchScorerModel()).toBe('openrouter/test/default-model');
  });

  it('resolves the default sentinel to the effective stack model', () => {
    process.env.LLM_MATCHING_MODEL = 'default';
    process.env.LLM_MODEL = 'openrouter/test/default-model';

    expect(resolvedJobMatchScorerModel()).toBe('openrouter/test/default-model');
  });

  it('fails before persistence when neither scorer nor stack model is configured', () => {
    expect(() => resolvedJobMatchScorerModel()).toThrow('Set LLM_MATCHING_MODEL or LLM_MODEL');
  });

  it('uses the matching-specific reasoning effort', () => {
    process.env.LLM_MATCHING_REASONING_EFFORT = ' HIGH ';

    expect(new ScorerProbe().readReasoningEffort()).toBe('high');
  });
});
