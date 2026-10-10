// @vitest-environment node
//
// The interview configuration against the shared model resolver of the LLM
// bundle (GOAPPLY_PARITY_PLAN.md §3.3 and the §5 contract: `getModelSetting`
// falls back to the shared stack, and a selector outside the stack table goes
// through `getEnvModelSetting`). Both bundles merge together, so config.ts
// must give the same answers before and after that resolver exists. Here the
// resolver is present (a stand-in with the contract's behaviour):
//   - a shared selector read by GoApply with a provider of its own comes back
//     qualified to a full route (`openrouter/…`);
//   - a GoApply selector read while GoApply's text calls run on the shared
//     stack comes back with its route spelled out (`dashscope/qwen-max`).
// Run: npx vitest run server/src/interview-engine/providers/__tests__/mergedLlmResolver.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  envModel: vi.fn<(envName: string, brand?: unknown) => string | undefined>(),
  taskModel: vi.fn<(task: string, brand?: unknown) => string | undefined>(),
}));

vi.mock('../../../lib/llm/llmModels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/llm/llmModels.js')>()),
  getEnvModelSetting: h.envModel,
}));
vi.mock('../../../lib/llm/llmTaskSettings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/llm/llmTaskSettings.js')>()),
  getTaskModel: h.taskModel,
}));

import { getBlueprintModel, getInterviewLlmRouting, voiceConfigProblems, voiceRoutingProblem } from '../../config.js';

const PREFIXES = ['LIVEKIT_', 'CN_', 'S3_', 'AWS_', 'INTERVIEW_', 'LLM_', 'VOICE_PROVIDER', 'BACKEND_PUBLIC_URL', 'PUBLIC_BACKEND_URL'];
let saved: Record<string, string | undefined>;

const brandId = (brand: unknown): string | undefined =>
  typeof brand === 'string' ? brand : (brand as { id?: string } | undefined)?.id;

beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (PREFIXES.some((p) => k.startsWith(p))) delete process.env[k];
  }
  process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  h.envModel.mockReset();
  h.taskModel.mockReset();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const INTL_LK = { LIVEKIT_URL: 'wss://intl.livekit.test', LIVEKIT_API_KEY: 'intl-key', LIVEKIT_API_SECRET: 'intl-secret' };
const CN_LK = {
  CN_LIVEKIT_URL: 'wss://cn.livekit.test', CN_LIVEKIT_API_KEY: 'cn-key', CN_LIVEKIT_API_SECRET: 'cn-secret',
  CN_LIVEKIT_AGENT_CALLBACK_SECRET: 'cn-cb',
};

describe('the blueprint model goes through the shared resolver (plan §3.3)', () => {
  it('GoApply: the resolver decides, so a shared selector is the qualified route when GoApply has a provider of its own', () => {
    // What the resolver returns for a shared LLM_INTERVIEW_BLUEPRINT_MODEL=openai/gpt-5.4-mini
    // read by GoApply with CN_LLM_PROVIDER set: the route it takes for RoboApply.
    process.env.LLM_INTERVIEW_BLUEPRINT_MODEL = 'openai/gpt-5.4-mini';
    h.envModel.mockReturnValue('openrouter/openai/gpt-5.4-mini');
    expect(getBlueprintModel('goapply')).toBe('openrouter/openai/gpt-5.4-mini');
    expect(h.envModel).toHaveBeenCalledTimes(1);
    expect(h.envModel.mock.calls[0]![0]).toBe('LLM_INTERVIEW_BLUEPRINT_MODEL');
    expect(brandId(h.envModel.mock.calls[0]![1])).toBe('goapply');
  });

  it('GoApply: no blueprint model anywhere falls to its interview task model', () => {
    h.envModel.mockReturnValue(undefined);
    h.taskModel.mockImplementation((_task, brand) => (brandId(brand) === 'goapply' ? 'deepseek/deepseek-v4-pro' : 'openai/gpt-5.4'));
    expect(getBlueprintModel('goapply')).toBe('deepseek/deepseek-v4-pro');
  });

  it('RoboApply keeps its own read: the resolver is not asked', () => {
    process.env.LLM_INTERVIEW_BLUEPRINT_MODEL = 'openai/gpt-5.4-mini';
    h.taskModel.mockReturnValue('openai/gpt-5.4');
    expect(getBlueprintModel('roboapply')).toBe('openai/gpt-5.4-mini');
    delete process.env.LLM_INTERVIEW_BLUEPRINT_MODEL;
    expect(getBlueprintModel('roboapply')).toBe('openai/gpt-5.4');
    expect(h.envModel).not.toHaveBeenCalled();
  });
});

describe('interview routing when the resolver spells GoApply’s own model as a full route', () => {
  // CN_LLM_INTERVIEW_MODEL=qwen/qwen-max while GoApply's text calls run on the
  // shared stack: the resolver hands the backend dashscope/qwen-max.
  const resolved = (_task: string, brand?: unknown) => (brandId(brand) === 'goapply' ? 'dashscope/qwen-max' : 'openai/gpt-5.5');

  it('shared plane: the model plans and scores; the shared worker runs the shared model (voice stays on)', () => {
    Object.assign(process.env, INTL_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.5', CN_LLM_INTERVIEW_MODEL: 'qwen/qwen-max' });
    h.taskModel.mockImplementation(resolved);
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'dashscope/qwen-max', workerModel: 'openai/gpt-5.5', reasoningEffort: 'low' });
    expect(voiceRoutingProblem('goapply')).toBeNull();
    expect(voiceConfigProblems('goapply').map((p) => p.message).join('\n')).toMatch(/CN_LLM_INTERVIEW_MODEL has no LiveKit Inference equivalent/);
    expect(getInterviewLlmRouting('roboapply')).toEqual({ backendModel: 'openai/gpt-5.5', workerModel: 'openai/gpt-5.5', reasoningEffort: 'low' });
  });

  it('own plane: the re-spelled route is still a domestic model GoApply’s worker runs (dashscope/ is one of its vendors)', () => {
    Object.assign(process.env, INTL_LK, CN_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.5', CN_LLM_INTERVIEW_MODEL: 'qwen/qwen-max' });
    h.taskModel.mockImplementation(resolved);
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'dashscope/qwen-max', workerModel: 'dashscope/qwen-max' });
    // Its own live model still wins.
    process.env.CN_LLM_INTERVIEW_LIVE_MODEL = 'deepseek/deepseek-v4-pro';
    expect(getInterviewLlmRouting('goapply')).toMatchObject({ backendModel: 'dashscope/qwen-max', workerModel: 'deepseek/deepseek-v4-pro' });
  });

  it('a shared selector qualified for GoApply’s own provider is mapped like the shared one', () => {
    Object.assign(process.env, INTL_LK, { LLM_INTERVIEW_MODEL: 'openai/gpt-5.5' });
    h.taskModel.mockImplementation((_task, brand) => (brandId(brand) === 'goapply' ? 'openrouter/openai/gpt-5.5' : 'openai/gpt-5.5'));
    expect(getInterviewLlmRouting('goapply')).toEqual({ backendModel: 'openrouter/openai/gpt-5.5', workerModel: 'openai/gpt-5.5', reasoningEffort: 'low' });
    expect(voiceConfigProblems('goapply')).toEqual([]);
  });
});
