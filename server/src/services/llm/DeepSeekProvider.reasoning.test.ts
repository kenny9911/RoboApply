import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: state.create } };
  },
}));

const { DeepSeekProvider } = await import('./DeepSeekProvider.js');

/** The params object the provider sent on its most recent call. */
function sentParams(): Record<string, unknown> {
  return state.create.mock.calls[0]![0] as Record<string, unknown>;
}

describe('DeepSeekProvider reasoning headroom', () => {
  beforeEach(() => {
    state.create.mockReset();
    state.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    delete process.env.DEEPSEEK_REASONING_MAX_TOKENS;
    delete process.env.DEEPSEEK_THINKING_MODE;
  });

  afterEach(() => {
    delete process.env.DEEPSEEK_REASONING_MAX_TOKENS;
    delete process.env.DEEPSEEK_THINKING_MODE;
  });

  // Regression: DeepSeek counts reasoning_content against max_tokens, so a bare
  // 1500 answer budget was consumed entirely by the chain of thought and the
  // API returned finish_reason='length' with empty content — 3 wasted retries
  // and a 502 for the caller (RAJobMatchScorerAgent failed 4/4 runs this way).
  it('adds thinking headroom on top of the caller maxTokens when thinking is on', async () => {
    const provider = new DeepSeekProvider('test-key', 'deepseek-v4-flash');
    await provider.chat([{ role: 'user', content: 'score this' }], { maxTokens: 1_500 });

    expect(sentParams().thinking).toEqual({ type: 'enabled' });
    expect(sentParams().max_tokens).toBe(1_500 + 8_000);
  });

  it('leaves maxTokens untouched when thinking is disabled', async () => {
    const provider = new DeepSeekProvider('test-key', 'deepseek-v4-flash');
    await provider.chat(
      [{ role: 'user', content: 'score this' }],
      { maxTokens: 1_500, thinkingMode: 'disabled' },
    );

    expect(sentParams().thinking).toEqual({ type: 'disabled' });
    expect(sentParams().max_tokens).toBe(1_500);
  });

  it("honours an agent's explicit reasoningMaxTokens over the default reserve", async () => {
    const provider = new DeepSeekProvider('test-key', 'deepseek-v4-pro');
    await provider.chat(
      [{ role: 'user', content: 'score this' }],
      { maxTokens: 1_000, reasoningMaxTokens: 2_000 },
    );

    expect(sentParams().max_tokens).toBe(1_000 + 2_000);
  });

  it('lets DEEPSEEK_REASONING_MAX_TOKENS override the default reserve', async () => {
    process.env.DEEPSEEK_REASONING_MAX_TOKENS = '3000';
    const provider = new DeepSeekProvider('test-key', 'deepseek-v4-flash');
    await provider.chat([{ role: 'user', content: 'score this' }], { maxTokens: 1_000 });

    expect(sentParams().max_tokens).toBe(1_000 + 3_000);
  });

  it('sends no max_tokens at all when the caller sets none', async () => {
    const provider = new DeepSeekProvider('test-key', 'deepseek-v4-flash');
    await provider.chat([{ role: 'user', content: 'score this' }], {});

    expect(sentParams().max_tokens).toBeUndefined();
  });

  // The bare "No content in DeepSeek response" message read as a transient
  // provider blip, so the real cause (a deterministic budget exhaustion) was
  // invisible in the logs behind three identical retries.
  it('explains budget exhaustion instead of reporting a bare empty response', async () => {
    state.create.mockResolvedValue({
      choices: [{ message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1_500,
        total_tokens: 1_501,
        completion_tokens_details: { reasoning_tokens: 1_500 },
      },
    });
    const provider = new DeepSeekProvider('test-key', 'deepseek-v4-flash');

    await expect(
      provider.chat([{ role: 'user', content: 'score this' }], { maxTokens: 1_500 }),
    ).rejects.toThrow(/exhausted by reasoning \(1500 reasoning tokens, finish_reason=length\)/);
  });
});
