import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getWorkerLlmModel,
  getWorkerLlmReasoningEffort,
  InterviewEngineConfigError,
} from './config.js';
import { InterviewBlueprintAgent } from './prompt/InterviewBlueprintAgent.js';
import { RAInterviewJobRequirementsAgent } from '../roboapply/v2/agents/RAInterviewJobRequirementsAgent.js';
import { pickMockInterviewerModel } from '../roboapply/v2/agents/RAMockInterviewerAgent.js';
import {
  interviewGenModel,
  interviewGenReasoningEffort,
} from '../roboapply/v2/lib/interviewGenShared.js';

const ENV_KEYS = [
  'LLM_SETTINGS_DB_DISABLED',
  'LLM_INTERVIEW_MODEL',
  'LLM_INTERVIEW_REASONING_EFFORT',
  'INTERVIEW_ENGINE_LLM_MODEL',
  'RA_V2_INTERVIEW_GEN_MODEL',
  'RA_V2_MOCK_INTERVIEWER_MODEL',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

class BlueprintProbe extends InterviewBlueprintAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

class LegacyProbe extends RAInterviewJobRequirementsAgent {
  readReasoningEffort() {
    return this.getReasoningEffort();
  }
}

describe('interview task settings', () => {
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

  it('uses one call-time model across the worker and both backend stacks', () => {
    process.env.LLM_INTERVIEW_MODEL = '  openai/gpt-5.4  ';

    expect(getWorkerLlmModel()).toBe('openai/gpt-5.4');
    expect(interviewGenModel()).toBe('openai/gpt-5.4');
    expect(pickMockInterviewerModel()).toBe('openai/gpt-5.4');

    process.env.LLM_INTERVIEW_MODEL = 'google/gemini-3-flash-preview';
    expect(getWorkerLlmModel()).toBe('google/gemini-3-flash-preview');
    expect(interviewGenModel()).toBe('google/gemini-3-flash-preview');
  });

  it('maps provider namespaces only when both runtimes expose the same model', () => {
    process.env.LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-pro';
    expect(interviewGenModel()).toBe('deepseek/deepseek-v4-pro');
    expect(getWorkerLlmModel()).toBe('deepseek-ai/deepseek-v4-pro');

    process.env.LLM_INTERVIEW_MODEL = 'moonshot/kimi-k2.6';
    expect(interviewGenModel()).toBe('moonshot/kimi-k2.6');
    expect(getWorkerLlmModel()).toBe('moonshotai/kimi-k2.6');

    process.env.LLM_INTERVIEW_MODEL = 'gemini/gemini-3-flash-preview';
    expect(interviewGenModel()).toBe('gemini/gemini-3-flash-preview');
    expect(getWorkerLlmModel()).toBe('google/gemini-3-flash-preview');
  });

  it('rejects backend models that have no equivalent in LiveKit Inference', () => {
    process.env.LLM_INTERVIEW_MODEL = 'deepseek/deepseek-v4-flash';

    expect(interviewGenModel()).toBe('deepseek/deepseek-v4-flash');
    expect(() => getWorkerLlmModel()).toThrow('no supported equivalent in LiveKit');
  });

  it('ignores retired interview-specific model variables', () => {
    process.env.INTERVIEW_ENGINE_LLM_MODEL = 'legacy/live';
    process.env.RA_V2_INTERVIEW_GEN_MODEL = 'legacy/generation';
    process.env.RA_V2_MOCK_INTERVIEWER_MODEL = 'legacy/mock';

    expect(interviewGenModel()).toBeUndefined();
    expect(pickMockInterviewerModel()).toBeUndefined();
    expect(() => getWorkerLlmModel()).toThrow(InterviewEngineConfigError);
  });

  it('fails clearly when live-worker model metadata cannot be configured', () => {
    expect(() => getWorkerLlmModel()).toThrow('Set LLM_INTERVIEW_MODEL');
  });

  it('applies interview reasoning effort to both backend agent stacks', () => {
    process.env.LLM_INTERVIEW_REASONING_EFFORT = ' HIGH ';

    expect(interviewGenReasoningEffort()).toBe('high');
    expect(new BlueprintProbe().readReasoningEffort()).toBe('high');
    expect(new LegacyProbe().readReasoningEffort()).toBe('high');
  });

  it('forwards LiveKit-supported effort and rejects max for the worker', () => {
    process.env.LLM_INTERVIEW_REASONING_EFFORT = 'medium';
    expect(getWorkerLlmReasoningEffort()).toBe('medium');

    process.env.LLM_INTERVIEW_REASONING_EFFORT = 'max';
    expect(() => getWorkerLlmReasoningEffort()).toThrow(InterviewEngineConfigError);
  });
});
