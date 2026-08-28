import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ provider: string; model: string | undefined }>,
  providerMode: 'openrouter',
  fallbackModel: 'openrouter/google/fallback-model',
  failDeepSeek: true,
}));

vi.mock('../LoggerService.js', () => ({
  generateRequestId: () => 'req_test',
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logLLMCall: vi.fn(),
  },
}));

vi.mock('../../lib/requestContext.js', () => ({
  getCurrentUserId: () => null,
  getCurrentRequestId: () => null,
  setByokInRequest: vi.fn(),
}));

vi.mock('../../lib/byokService.js', () => ({
  resolveByok: vi.fn(async () => null),
  touchByok: vi.fn(),
}));

vi.mock('../../lib/llm/systemCredentials.js', () => ({
  resolveProviderCredential: () => ({ apiKey: 'test-key', tuning: {} }),
}));

vi.mock('../../lib/llm/llmModels.js', () => ({
  getProviderSetting: () => state.providerMode,
  getDefaultModel: () => 'openrouter/openai/default-model',
  getFallbackModelSetting: () => state.fallbackModel,
}));

vi.mock('./DeepSeekProvider.js', () => ({
  DeepSeekProvider: class {
    getProviderName() { return 'deepseek'; }
    async chat(_messages: unknown, options: { model?: string }) {
      state.calls.push({ provider: 'deepseek', model: options.model });
      if (state.failDeepSeek) {
        throw Object.assign(new Error('503 Service unavailable'), { status: 503 });
      }
      return {
        content: 'deepseek response',
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        model: options.model ?? '',
      };
    }
  },
}));

vi.mock('./OpenRouterProvider.js', () => ({
  OpenRouterProvider: class {
    getProviderName() { return 'openrouter'; }
    async chat(_messages: unknown, options: { model?: string }) {
      state.calls.push({ provider: 'openrouter', model: options.model });
      return {
        content: 'fallback response',
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        model: options.model ?? '',
      };
    }
  },
}));

const { LLMService } = await import('./LLMService.js');

describe('LLMService fallback routing', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.providerMode = 'openrouter';
    state.fallbackModel = 'openrouter/google/fallback-model';
    state.failDeepSeek = true;
    delete process.env.MOCK_LLM;
  });

  afterEach(() => {
    delete process.env.MOCK_LLM;
  });

  it('routes an explicit OpenRouter fallback away from a native task provider', async () => {
    const result = await new LLMService().chatWithUsage(
      [{ role: 'user', content: 'hello' }],
      { model: 'deepseek/native-primary' },
    );

    expect(state.calls).toEqual([
      { provider: 'deepseek', model: 'native-primary' },
      { provider: 'openrouter', model: 'google/fallback-model' },
    ]);
    expect(result.model).toBe('google/fallback-model');
  });

  it('lets an explicit OpenRouter selector override a legacy provider mode', async () => {
    state.providerMode = 'deepseek';
    state.fallbackModel = '';
    state.failDeepSeek = false;

    const result = await new LLMService().chatWithUsage(
      [{ role: 'user', content: 'hello' }],
      { model: 'openrouter/anthropic/router-model' },
    );

    expect(state.calls).toEqual([
      { provider: 'openrouter', model: 'anthropic/router-model' },
    ]);
    expect(result.model).toBe('anthropic/router-model');
  });
});
