import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RAOnboardingPrefExtractAgent,
  pickOnboardingExtractModel,
  pickOnboardingExtractReasoningEffort,
} from './RAOnboardingPrefExtractAgent.js';
import {
  RAOnboardingResumeSeedAgent,
  pickOnboardingSeedModel,
  pickOnboardingSeedReasoningEffort,
} from './RAOnboardingResumeSeedAgent.js';
import {
  RAResumeRewriteAgent,
  pickResumeRewriteModel,
  pickResumeRewriteReasoningEffort,
} from './RAResumeRewriteAgent.js';
import {
  RoboApplyIntentParserAgent,
  pickIntentParserModel,
  pickIntentParserReasoningEffort,
} from '../../agents/RoboApplyIntentParserAgent.js';

const ENV_KEYS = [
  'LLM_SETTINGS_DB_DISABLED',
  'LLM_ONBOARDING_MODEL',
  'LLM_ONBOARDING_REASONING_EFFORT',
  'LLM_REWRITE_MODEL',
  'LLM_REWRITE_REASONING_EFFORT',
  'RA_V2_ONBOARDING_EXTRACT_MODEL',
  'RA_V2_ONBOARDING_SEED_MODEL',
  'RA_V2_RESUME_REWRITE_MODEL',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

class PrefExtractProbe extends RAOnboardingPrefExtractAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

class ResumeSeedProbe extends RAOnboardingResumeSeedAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

class ResumeRewriteProbe extends RAResumeRewriteAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

class IntentParserProbe extends RoboApplyIntentParserAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

describe('RoboApply onboarding and rewrite task settings', () => {
  let savedEnv: Record<EnvKey, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<EnvKey, string | undefined>;
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses one call-time onboarding model for intent parsing, extraction, and resume seeding', () => {
    process.env.LLM_ONBOARDING_MODEL = '  deepseek/deepseek-v4-flash  ';

    expect(pickIntentParserModel()).toBe('deepseek/deepseek-v4-flash');
    expect(pickOnboardingExtractModel()).toBe('deepseek/deepseek-v4-flash');
    expect(pickOnboardingSeedModel()).toBe('deepseek/deepseek-v4-flash');

    process.env.LLM_ONBOARDING_MODEL = 'openrouter/openai/gpt-5.6-luna';
    expect(pickIntentParserModel()).toBe('openrouter/openai/gpt-5.6-luna');
    expect(pickOnboardingExtractModel()).toBe('openrouter/openai/gpt-5.6-luna');
    expect(pickOnboardingSeedModel()).toBe('openrouter/openai/gpt-5.6-luna');
  });

  it('ignores retired onboarding overrides and falls through to the stack default', () => {
    process.env.RA_V2_ONBOARDING_EXTRACT_MODEL = 'legacy/extract';
    process.env.RA_V2_ONBOARDING_SEED_MODEL = 'legacy/seed';

    expect(pickOnboardingExtractModel()).toBeUndefined();
    expect(pickOnboardingSeedModel()).toBeUndefined();
  });

  it('applies onboarding reasoning effort to every onboarding agent class', () => {
    process.env.LLM_ONBOARDING_REASONING_EFFORT = ' HIGH ';

    expect(pickIntentParserReasoningEffort()).toBe('high');
    expect(pickOnboardingExtractReasoningEffort()).toBe('high');
    expect(pickOnboardingSeedReasoningEffort()).toBe('high');
    expect(new IntentParserProbe().readReasoningEffort()).toBe('high');
    expect(new PrefExtractProbe().readReasoningEffort()).toBe('high');
    expect(new ResumeSeedProbe().readReasoningEffort()).toBe('high');
  });

  it('uses the call-time rewrite model and ignores the retired override', () => {
    process.env.RA_V2_RESUME_REWRITE_MODEL = 'legacy/rewrite';
    expect(pickResumeRewriteModel()).toBeUndefined();

    process.env.LLM_REWRITE_MODEL = '  deepseek/deepseek-v4-flash  ';
    expect(pickResumeRewriteModel()).toBe('deepseek/deepseek-v4-flash');
  });

  it('applies validated rewrite reasoning effort to the agent class', () => {
    process.env.LLM_REWRITE_REASONING_EFFORT = 'max';

    expect(pickResumeRewriteReasoningEffort()).toBe('max');
    expect(new ResumeRewriteProbe().readReasoningEffort()).toBe('max');

    process.env.LLM_REWRITE_REASONING_EFFORT = 'unsupported';
    expect(pickResumeRewriteReasoningEffort()).toBeUndefined();
    expect(new ResumeRewriteProbe().readReasoningEffort()).toBeUndefined();
  });
});
