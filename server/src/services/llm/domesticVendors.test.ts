// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn(), ctor: [] as Array<Record<string, unknown>> }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: sdk.create } };
    constructor(opts: Record<string, unknown>) {
      sdk.ctor.push(opts);
    }
  },
}));
vi.mock('../LoggerService.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { OpenAICompatibleProvider } = await import('./OpenAICompatibleProvider.js');
const { maxTokensWithThinking, parseThinkingMode, resolveThinkingMode, thinkingParams, thinkingHeadroomTokens } = await import('./domesticVendors.js');
const { normalizeProviderType, resolveProviderPrefix } = await import('./providerPrefixes.js');
const { isTransientLLMError } = await import('./withRetry.js');

const ok = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

beforeEach(() => {
  sdk.create.mockReset();
  sdk.create.mockResolvedValue(ok);
  sdk.ctor.length = 0;
  process.env.LLM_PROXY_KEY = 'secret-proxy';
});
afterEach(() => {
  delete process.env.LLM_PROXY_KEY;
  delete process.env.DASHSCOPE_THINKING_MODE;
  delete process.env.LLM_THINKING_HEADROOM_TOKENS;
});

describe('domestic vendor helpers', () => {
  it('spells each thinking switch the vendor way', () => {
    expect(thinkingParams('qwen', 'enabled')).toEqual({ enable_thinking: true });
    expect(thinkingParams('glm', 'disabled')).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingParams('doubao', 'enabled')).toEqual({ thinking: { type: 'enabled' } });
    expect(thinkingParams('qwen', undefined)).toEqual({});
  });

  it('adds reasoning headroom only when thinking is explicitly on', () => {
    expect(maxTokensWithThinking(700, 'enabled')).toBe(8700);
    expect(maxTokensWithThinking(700, 'enabled', 2000)).toBe(2700);
    expect(maxTokensWithThinking(700, undefined)).toBe(700);
    expect(maxTokensWithThinking(undefined, 'enabled')).toBeUndefined();
    expect(thinkingHeadroomTokens(undefined, { LLM_THINKING_HEADROOM_TOKENS: '4000' })).toBe(4000);
  });

  it('reads the vendor env switch; the per-call override wins', () => {
    expect(parseThinkingMode('ON')).toBe('enabled');
    expect(parseThinkingMode('0')).toBe('disabled');
    expect(parseThinkingMode('maybe')).toBeUndefined();
    expect(resolveThinkingMode('qwen', undefined, { DASHSCOPE_THINKING_MODE: 'true' })).toBe('enabled');
    expect(resolveThinkingMode('qwen', 'disabled', { DASHSCOPE_THINKING_MODE: 'true' })).toBe('disabled');
  });

  it('maps vendor prefixes and aliases', () => {
    expect(resolveProviderPrefix('dashscope')).toBe('qwen');
    expect(resolveProviderPrefix('qwen')).toBeNull();
    expect(resolveProviderPrefix('qwen', 'domestic_cn')).toBe('qwen');
    expect(resolveProviderPrefix('z-ai')).toBeNull();
    expect(normalizeProviderType(' ARK ')).toBe('doubao');
  });
});

describe('OpenAICompatibleProvider on a domestic vendor', () => {
  const make = () =>
    new OpenAICompatibleProvider({
      apiKey: 'k',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      providerName: 'qwen',
      thinkingVendor: 'qwen',
      noProxyKey: true,
    });

  it('sends no proxy key to the vendor host', () => {
    make();
    expect(sdk.ctor[0].defaultHeaders).toBeUndefined();
  });

  it('switches thinking on with reasoning headroom', async () => {
    process.env.DASHSCOPE_THINKING_MODE = 'enabled';
    await make().chat([{ role: 'user', content: 'hi' }], { maxTokens: 500 });
    expect(sdk.create.mock.calls[0][0]).toMatchObject({ enable_thinking: true, max_tokens: 8500 });
  });

  it('leaves the vendor default alone when nothing is configured', async () => {
    await make().chat([{ role: 'user', content: 'hi' }], { maxTokens: 500 });
    const params = sdk.create.mock.calls[0][0];
    expect(params.enable_thinking).toBeUndefined();
    expect(params.max_tokens).toBe(500);
  });

  it('names a reasoning-budget exhaustion and marks it non-retryable', async () => {
    sdk.create.mockResolvedValue({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} });
    const caught = await make().chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 }).catch((e: unknown) => e);
    expect((caught as Error).message).toContain('finish_reason=length');
    expect(isTransientLLMError(caught)).toBe(false);
  });
});
