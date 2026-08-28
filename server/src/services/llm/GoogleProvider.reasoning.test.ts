import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  modelParams: [] as Array<Record<string, unknown>>,
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(params: Record<string, unknown>) {
      state.modelParams.push(params);
      return {
        generateContent: async () => ({
          response: {
            text: () => 'ok',
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              totalTokenCount: 2,
            },
          },
        }),
      };
    }
  },
}));

const { GoogleProvider } = await import('./GoogleProvider.js');

describe('GoogleProvider task reasoning effort', () => {
  beforeEach(() => {
    state.modelParams.length = 0;
  });

  it('sends a numeric thinking budget to Gemini 2.5', async () => {
    const provider = new GoogleProvider('test-key', 'gemini-2.5-flash');
    await provider.chat(
      [{ role: 'user', content: 'hello' }],
      { reasoningEffort: 'medium' },
    );

    expect(state.modelParams[0].generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 8_192 },
    });
  });

  it('sends a qualitative thinking level to Gemini 3', async () => {
    const provider = new GoogleProvider('test-key', 'gemini-3-flash-preview');
    await provider.chat(
      [{ role: 'user', content: 'hello' }],
      { reasoningEffort: 'high' },
    );

    expect(state.modelParams[0].generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'high' },
    });
  });
});
