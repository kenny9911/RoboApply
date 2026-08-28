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

  it('uses the mapped worker namespace when a usage item omits its model', () => {
    const priced = priceLiveUsage(
      [{ type: 'llm_usage', inputTokens: 1_000_000, outputTokens: 1_000_000 }],
      'moonshotai/kimi-k2.6',
    );

    expect(priced.llm?.model).toBe('moonshotai/kimi-k2.6');
    expect(priced.llm?.usd).toBe(5.3998);
  });
});
