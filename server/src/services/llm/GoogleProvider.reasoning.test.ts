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

const { GoogleProvider, googleMaxOutputTokens } = await import('./GoogleProvider.js');

describe('GoogleProvider thinking headroom', () => {
  beforeEach(() => {
    state.modelParams.length = 0;
    delete process.env.GOOGLE_REASONING_MAX_TOKENS;
  });

  it('adds thinking room on top of the answer cap of a thinking Gemini', async () => {
    const provider = new GoogleProvider('test-key', 'gemini-3.8-flash');
    await provider.chat([{ role: 'user', content: 'hello' }], { maxTokens: 3200 });

    expect(state.modelParams[0].generationConfig).toMatchObject({ maxOutputTokens: 11_200 });
  });

  it('keeps the reserve when an agent asks for a smaller reasoning cap', () => {
    expect(googleMaxOutputTokens('google/gemini-2.5-flash', 900, 300)).toBe(8_900);
    expect(googleMaxOutputTokens('gemini-3.8-flash', 900, 12_000)).toBe(12_900);
  });

  it('reads GOOGLE_REASONING_MAX_TOKENS', () => {
    process.env.GOOGLE_REASONING_MAX_TOKENS = '2000';
    expect(googleMaxOutputTokens('gemini-3.8-flash', 1000)).toBe(3_000);
  });

  it('leaves non-thinking models and an unset cap alone', () => {
    expect(googleMaxOutputTokens('gemini-2.0-flash', 1000)).toBe(1000);
    expect(googleMaxOutputTokens('gemini-3.8-flash', undefined)).toBeUndefined();
  });
});

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
