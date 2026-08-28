import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: state.create } };
  },
}));

const { OpenRouterProvider } = await import('./OpenRouterProvider.js');

describe('OpenRouterProvider task reasoning effort', () => {
  beforeEach(() => {
    state.create.mockReset();
    state.create.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
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
