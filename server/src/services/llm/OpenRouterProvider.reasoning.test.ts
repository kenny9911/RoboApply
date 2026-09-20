import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: state.create } };
  },
}));

const { OpenRouterProvider } = await import('./OpenRouterProvider.js');
const { isTransientLLMError, withLLMRetry } = await import('./withRetry.js');

describe('OpenRouterProvider reasoning budget', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_REASONING_EFFORT', '');
    state.create.mockReset();
    state.create.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(['openai/gpt-5.6-luna', 'openai/o3-mini'])(
    'leaves room for reasoning alongside the scorer answer budget on %s',
    async (model) => {
      const provider = new OpenRouterProvider('test-key', model);
      await provider.chat([{ role: 'user', content: 'score this' }], { maxTokens: 1_500 });

      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({ model, max_tokens: 9_500 }),
        expect.any(Object),
      );
      expect(state.create.mock.calls[0]![0].reasoning).toBeUndefined();
    },
  );

  it('uses the per-call model when deciding whether to reserve reasoning tokens', async () => {
    const provider = new OpenRouterProvider('test-key', 'openai/gpt-4o');
    await provider.chat(
      [{ role: 'user', content: 'score this' }],
      { model: 'openai/gpt-5.6-luna', maxTokens: 1_500 },
    );

    expect(state.create.mock.calls[0]![0].max_tokens).toBe(9_500);
  });

  it.each(['openai/gpt-4o', 'openai/gpt-5-chat-latest', 'google/gemini-2.5-flash'])(
    'preserves the existing token budget for %s',
    async (model) => {
      const provider = new OpenRouterProvider('test-key', 'openai/gpt-5.6-luna');
      await provider.chat(
        [{ role: 'user', content: 'score this' }],
        { model, maxTokens: 1_500, reasoningMaxTokens: 400 },
      );

      expect(state.create.mock.calls[0]![0]).toMatchObject({
        max_tokens: 1_500,
        reasoning: { max_tokens: 400 },
      });
    },
  );

  it('uses an explicit reasoning budget as headroom when no task effort overrides it', async () => {
    const provider = new OpenRouterProvider('test-key', 'openai/gpt-5.6-luna', {
      reasoningEffort: 'high',
    });
    await provider.chat(
      [{ role: 'user', content: 'score this' }],
      { maxTokens: 1_500, reasoningMaxTokens: 2_000 },
    );

    expect(state.create.mock.calls[0]![0]).toMatchObject({
      max_tokens: 3_500,
      reasoning: { max_tokens: 2_000 },
    });
  });

  it('preserves configured effort while adding headroom', async () => {
    const provider = new OpenRouterProvider('test-key', 'openai/gpt-5.6-luna');
    await provider.chat(
      [{ role: 'user', content: 'score this' }],
      { maxTokens: 1_500, reasoningEffort: 'high', reasoningMaxTokens: 400 },
    );

    expect(state.create.mock.calls[0]![0]).toMatchObject({
      max_tokens: 9_500,
      reasoning: { effort: 'high' },
    });
  });

  it.each(['provider', 'global'])('retains %s effort tuning alongside reasoning headroom', async (source) => {
    if (source === 'global') vi.stubEnv('LLM_REASONING_EFFORT', 'medium');
    const provider = new OpenRouterProvider('test-key', 'openai/gpt-5.6-luna',
      source === 'provider' ? { reasoningEffort: 'medium' } : undefined);
    await provider.chat([{ role: 'user', content: 'score this' }], { maxTokens: 1_500 });

    expect(state.create.mock.calls[0]![0]).toMatchObject({
      max_tokens: 9_500,
      reasoning: { effort: 'medium' },
    });
  });

  it('does not impose a token limit when the caller leaves it unset', async () => {
    const provider = new OpenRouterProvider('test-key', 'openai/gpt-5.6-luna');
    await provider.chat([{ role: 'user', content: 'hello' }]);

    expect(state.create.mock.calls[0]![0].max_tokens).toBeUndefined();
  });

  it.each(['length', null])('does not retry an empty max_output_tokens response (finish=%s)', async (finishReason) => {
    state.create.mockResolvedValue({
      choices: [{
        message: { content: '' },
        finish_reason: finishReason,
        native_finish_reason: 'max_output_tokens',
      }],
      usage: {
        prompt_tokens: 4_266,
        completion_tokens: 1_500,
        total_tokens: 5_766,
        completion_tokens_details: { reasoning_tokens: 1_500 },
      },
    });
    const provider = new OpenRouterProvider('test-key', 'openai/gpt-5.6-luna');

    await expect(withLLMRetry(
      () => provider.chat([{ role: 'user', content: 'score this' }], { maxTokens: 1_500 }),
      { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    ))
      .rejects.toMatchObject({
        nonRetryable: true,
        finishReason: finishReason ?? 'max_output_tokens',
        message: expect.stringContaining('reasoning=1500'),
        usage: { promptTokens: 4_266, completionTokens: 1_500, totalTokens: 5_766 },
      });
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it('recognizes native output exhaustion after error metadata is lost', () => {
    expect(isTransientLLMError(new Error(
      'No content in OpenRouter response — native_finish_reason=max_output_tokens',
    ))).toBe(false);
    expect(isTransientLLMError(new Error('No content in OpenRouter response'))).toBe(true);
  });

  it('forwards max and lets the explicit task effort replace a token budget', async () => {
    const provider = new OpenRouterProvider('test-key', 'openai/gpt-5.5');
    await provider.chat(
      [{ role: 'user', content: 'hello' }],
      { reasoningEffort: 'max', reasoningMaxTokens: 4_000 },
    );

    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: { effort: 'max' } }),
      expect.any(Object),
    );
  });
});
