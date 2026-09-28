import { describe, expect, it } from 'vitest';

import { priceLiveUsage } from './sessionCost.js';

describe('priceLiveUsage', () => {
  it('prices the LiveKit DeepSeek namespace using the backend DeepSeek rate', () => {
    const priced = priceLiveUsage([
      {
        type: 'llm_usage',
        provider: 'deepseek-ai',
        model: 'deepseek-v4-pro',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
    ]);

    expect(priced.llm?.model).toBe('deepseek-ai/deepseek-v4-pro');
    expect(priced.llm?.usd).toBe(1.305);
    expect(priced.usd).toBe(1.305);
  });

  it('prices LiveKit Inference GPT-6 Luna usage at its own rate, not the default tier', () => {
    // inference.LLM reports provider `livekit` and the gateway's vendor/model
    // id, so the model is priced as sent.
    const priced = priceLiveUsage([
      {
        type: 'llm_usage',
        provider: 'livekit',
        model: 'openai/gpt-6-luna',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
    ]);

    expect(priced.llm?.model).toBe('openai/gpt-6-luna');
    expect(priced.llm?.usd).toBe(0.6);
    expect(priced.usd).toBe(0.6);
  });

  it('uses the mapped worker namespace when a usage item omits its model', () => {
    const priced = priceLiveUsage(
      [{ type: 'llm_usage', inputTokens: 1_000_000, outputTokens: 1_000_000 }],
      'moonshotai/kimi-k2.6',
    );

    expect(priced.llm?.model).toBe('moonshotai/kimi-k2.6');
    expect(priced.llm?.usd).toBe(5.3998);
  });
});
