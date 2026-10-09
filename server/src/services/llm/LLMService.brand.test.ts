// @vitest-environment node
//
// WP-14 acceptance: per-brand routing, the GoApply allowlist, the RoboApply
// egress rule (both on the endpoint host, primary and fallback), BYOK off for
// GoApply, and the content-safety wiring (GoApply only, fail closed).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ provider: string; model: string | undefined }>,
  keys: {} as Record<string, string>,
  baseUrls: {} as Record<string, string>,
  behavior: {} as Record<string, 'ok' | Error>,
  compatArgs: [] as Array<Record<string, unknown>>,
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  logLLMCall: vi.fn(),
}));
const byokMock = vi.hoisted(() => ({ resolveByok: vi.fn(async () => null), touchByok: vi.fn() }));

vi.mock('../LoggerService.js', () => ({ generateRequestId: () => 'req_test', logger: loggerMock }));
vi.mock('../../lib/byokService.js', () => byokMock);
vi.mock('../../lib/llm/systemCredentials.js', () => ({
  resolveProviderCredential: (provider: string) => {
    const p = provider.toLowerCase();
    return { apiKey: state.keys[p] ?? '', baseUrl: state.baseUrls[p], tuning: {} };
  },
}));

function respond(name: string, model: string | undefined) {
  state.calls.push({ provider: name, model });
  const b = state.behavior[name] ?? 'ok';
  if (b !== 'ok') throw b;
  return { content: `${name} says hello`, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: model ?? '' };
}

function makeProvider(name: string) {
  return class {
    constructor(..._args: unknown[]) {}
    getProviderName() {
      return name;
    }
    async chat(_m: unknown, options: { model?: string }) {
      return respond(name, options.model);
    }
  };
}

vi.mock('./DeepSeekProvider.js', () => ({ DeepSeekProvider: makeProvider('deepseek') }));
vi.mock('./OpenRouterProvider.js', () => ({ OpenRouterProvider: makeProvider('openrouter'), openRouterBrandHeaders: () => ({}) }));
vi.mock('./GoogleProvider.js', () => ({ GoogleProvider: makeProvider('google') }));
vi.mock('./AnthropicProvider.js', () => ({ AnthropicProvider: makeProvider('anthropic') }));
vi.mock('./OpenAIProvider.js', () => ({ OpenAIProvider: makeProvider('openai') }));
vi.mock('./KimiProvider.js', () => ({ KimiProvider: makeProvider('kimi'), isK2Model: () => false }));
vi.mock('./OpenAICompatibleProvider.js', () => ({
  OpenAICompatibleProvider: class {
    private readonly name: string;
    constructor(args: Record<string, unknown>) {
      state.compatArgs.push(args);
      this.name = String(args.providerName);
    }
    getProviderName() {
      return this.name;
    }
    async chat(_m: unknown, options: { model?: string }) {
      return respond(this.name, options.model);
    }
  },
}));

const { LLMService } = await import('./LLMService.js');
const { AiUnavailableError } = await import('./errors.js');
const routing = await import('./fallbackRouting.js');
const { runWithBrand, setCurrentUserId } = await import('../../lib/requestContext.js');
const { LlmBrandPolicyError } = await import('../../platform/llm/brandPolicy.js');
const safety = await import('../../platform/llm/contentSafety/index.js');

const msgs = [
  { role: 'system' as const, content: 'You are the resume assistant.' },
  { role: 'user' as const, content: 'Rewrite my summary.' },
];
const err = (message: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(message), extra);

const ENV_NAMES = [
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_FALLBACK_MODEL',
  'CN_LLM_PROVIDER',
  'CN_LLM_MODEL',
  'CN_LLM_FALLBACK_MODEL',
  'CN_LLM_REWRITE_MODEL',
  'LLM_SETTINGS_DB_DISABLED',
  'LLM_FALLBACK_AUTO',
  'MOCK_LLM',
  'NEWAPI_BASE_URL',
  'CN_LLM_DOMESTIC_HOSTS',
  'BRAND_LOCK',
  'ALLOWED_BRANDS',
  'NODE_ENV',
];
let savedEnv: Record<string, string | undefined> = {};

const go = <T>(fn: () => Promise<T>) => runWithBrand('goapply', fn);
const robo = <T>(fn: () => Promise<T>) => runWithBrand('roboapply', fn);

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const n of ENV_NAMES) delete process.env[n];
  process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  // RoboApply's stack is configured; GoApply must never borrow it.
  process.env.LLM_PROVIDER = 'openrouter';
  process.env.LLM_MODEL = 'openrouter/openai/gpt-6-luna';
  process.env.LLM_FALLBACK_MODEL = 'openrouter/google/gemini-3.8-flash';
  state.calls.length = 0;
  state.compatArgs.length = 0;
  state.keys = { openrouter: 'or', google: 'g', anthropic: 'a', openai: 'o', deepseek: 'd', qwen: 'q', glm: 'z', doubao: 'ark', newapi: 'n', kimi: 'k' };
  state.baseUrls = {};
  state.behavior = {};
  routing.resetCircuits();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const n of ENV_NAMES) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
  safety.setContentSafetyProvider(null);
});

describe('GoApply routing (R-13: domestic allowlist, CN_ env only)', () => {
  it('passes with DeepSeek and reads CN_LLM_* only', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';

    const result = await go(() => new LLMService().chatWithUsage(msgs));

    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
    expect(result.content).toBe('deepseek says hello');
  });

  it('throws LlmBrandPolicyError for OpenRouter and never calls it', async () => {
    process.env.CN_LLM_PROVIDER = 'openrouter';
    process.env.CN_LLM_MODEL = 'openai/gpt-6-luna';

    const caught = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(LlmBrandPolicyError);
    expect(caught).toMatchObject({ code: 'brand_policy', policyCode: 'provider_not_domestic' });
    expect((caught as Error).message).not.toContain('openrouter.ai');
    expect(state.calls).toEqual([]);
    expect(loggerMock.error).toHaveBeenCalledWith('LLM_POLICY', expect.any(String), expect.objectContaining({ brand: 'goapply' }), expect.any(String));
  });

  it('refuses an explicit international model even when the provider mode is domestic', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';

    for (const model of ['google/gemini-3.8-flash', 'anthropic/claude-sonnet-4-6', 'openrouter/qwen/qwen3.8-flash']) {
      await expect(go(() => new LLMService().chat(msgs, { model }))).rejects.toBeInstanceOf(LlmBrandPolicyError);
    }
    expect(state.calls).toEqual([]);
  });

  it('answers ai_unavailable with no CN model, even though LLM_MODEL is set (no fallback to unprefixed env)', async () => {
    const caught = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiUnavailableError);
    expect(caught).toMatchObject({ code: 'ai_unavailable', status: 503, reason: 'no_model' });

    // A bare model with no CN_LLM_PROVIDER has no route either.
    process.env.CN_LLM_MODEL = 'qwen-plus';
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(state.calls).toEqual([]);
  });

  it('builds the domestic adapters on their mainland endpoints', async () => {
    for (const [provider, host] of [
      ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
      ['dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
      ['glm', 'https://open.bigmodel.cn/api/paas/v4'],
      ['zhipu', 'https://open.bigmodel.cn/api/paas/v4'],
      ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
      ['ark', 'https://ark.cn-beijing.volces.com/api/v3'],
    ] as const) {
      process.env.CN_LLM_PROVIDER = provider;
      process.env.CN_LLM_MODEL = 'some-model';
      state.compatArgs.length = 0;
      await go(() => new LLMService().chat(msgs));
      expect(state.compatArgs[0]).toMatchObject({ baseURL: host, noProxyKey: true, defaultModel: 'some-model' });
      expect(['qwen', 'glm', 'doubao']).toContain(state.compatArgs[0].providerName);
      expect(state.compatArgs[0].thinkingVendor).toBe(state.compatArgs[0].providerName);
    }
  });

  it('routes a qwen/ selector to DashScope on GoApply (OpenRouter is never an option there)', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    process.env.CN_LLM_REWRITE_MODEL = 'qwen/qwen-plus';
    const { getTaskModel } = await import('../../lib/llm/llmTaskSettings.js');

    await go(() => new LLMService().chat(msgs, { model: getTaskModel('rewrite') }));
    expect(state.calls).toEqual([{ provider: 'qwen', model: 'qwen-plus' }]);
  });

  it('filters the fallback chain to domestic routes', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-pro';
    process.env.CN_LLM_FALLBACK_MODEL = 'qwen/qwen-plus';
    state.behavior = { deepseek: err('401 Invalid API key', { status: 401 }) };

    const result = await go(() => new LLMService().chatWithUsage(msgs));

    expect(state.calls.map((c) => c.provider)).toEqual(['deepseek', 'qwen']);
    expect(result.content).toBe('qwen says hello');
  });

  it('drops international fallbacks (configured and auto) instead of leaving the mainland', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-pro';
    process.env.CN_LLM_FALLBACK_MODEL = 'openrouter/openai/gpt-6-luna';
    state.behavior = { deepseek: err('402 Insufficient Balance', { status: 402 }) };

    const caught = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);

    expect(routing.isLLMUnavailableError(caught)).toBe(true);
    expect(state.calls.map((c) => c.provider)).toEqual(['deepseek']);
    expect((caught as Error).message).toContain('CN_LLM_FALLBACK_MODEL');
    expect((caught as Error).message).not.toMatch(/google|anthropic|openai, /);
  });

  it('never consults a personal key (BYOK off)', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    await go(async () => {
      setCurrentUserId('user_cn');
      await new LLMService().chat(msgs);
    });
    expect(byokMock.resolveByok).not.toHaveBeenCalled();

    await robo(async () => {
      setCurrentUserId('user_intl');
      await new LLMService().chat(msgs);
    });
    expect(byokMock.resolveByok).toHaveBeenCalledWith('user_intl', 'openrouter');
  });

  it('the brand option pins a call regardless of the ambient context', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    await robo(() => new LLMService().chat(msgs, { brand: 'goapply' }));
    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });
});

describe('calls with no brand context (crons, workers)', () => {
  it('route as the locked brand: on a GoApply-only deployment they read CN_LLM_* and OpenRouter is refused', async () => {
    process.env.BRAND_LOCK = 'goapply';
    process.env.CN_LLM_PROVIDER = 'openrouter';
    process.env.CN_LLM_MODEL = 'openai/gpt-6-luna';

    const caught = await new LLMService().chat(msgs).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(LlmBrandPolicyError);
    expect(caught).toMatchObject({ policyCode: 'provider_not_domestic' });
    expect(state.calls).toEqual([]);
  });

  it('a single ALLOWED_BRANDS entry locks too: the call uses the CN stack, never LLM_MODEL', async () => {
    process.env.ALLOWED_BRANDS = 'goapply';
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';

    await new LLMService().chat(msgs);

    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });

  it('a GoApply-only deployment with no CN model answers ai_unavailable instead of using LLM_MODEL', async () => {
    process.env.BRAND_LOCK = 'goapply';
    await expect(new LLMService().chat(msgs)).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(state.calls).toEqual([]);
  });

  it('in production on a deployment that also serves GoApply, refuses to guess the brand', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_BRANDS = 'roboapply,goapply';

    await expect(new LLMService().chat(msgs)).rejects.toMatchObject({ name: 'BrandContextMissingError' });
    expect(state.calls).toEqual([]);
    // With a context (or an explicit brand) the same deployment routes normally.
    await robo(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
  });

  it('a RoboApply-only deployment keeps the default brand', async () => {
    process.env.NODE_ENV = 'production';
    await new LLMService().chat(msgs);
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
  });
});

describe('RoboApply egress (no mainland endpoint for prompts with user data)', () => {
  it('skips DeepSeek in the fallback chain', async () => {
    process.env.LLM_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';
    state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

    await robo(() => new LLMService().chat(msgs));

    expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'google']);
    expect(state.calls.map((c) => c.provider)).not.toContain('deepseek');
  });

  it('treats a newapi gateway on dashscope.aliyuncs.com as mainland (host, not provider name)', async () => {
    process.env.NEWAPI_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

    const caught = await robo(() => new LLMService().chat(msgs, { model: 'newapi/qwen-plus' })).catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: 'brand_policy', policyCode: 'mainland_endpoint_for_intl', host: 'dashscope.aliyuncs.com' });
    expect(state.calls).toEqual([]);

    // The same gateway is fine for GoApply (domestic host).
    process.env.CN_LLM_PROVIDER = 'newapi';
    process.env.CN_LLM_MODEL = 'qwen-plus';
    await go(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([{ provider: 'newapi', model: 'qwen-plus' }]);
  });

  it('checks the credential base URL, so a deepseek key pointed at a mainland proxy host is refused and an intl host is not', async () => {
    state.baseUrls = { openai: 'https://gw.example.volces.com/v1' };
    await expect(robo(() => new LLMService().chat(msgs, { model: 'openai/gpt-6-luna' }))).rejects.toBeInstanceOf(LlmBrandPolicyError);

    state.baseUrls = { openai: 'https://proxy.example.com/v1' };
    await robo(() => new LLMService().chat(msgs, { model: 'openai/gpt-6-luna' }));
    expect(state.calls).toEqual([{ provider: 'openai', model: 'gpt-6-luna' }]);
  });

  it('keeps qwen/ an OpenRouter slug on RoboApply', async () => {
    await robo(() => new LLMService().chat(msgs, { model: 'qwen/qwen3.8-flash' }));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'qwen/qwen3.8-flash' }]);
  });

  it('skips a personal key whose own endpoint is mainland and serves the call on the checked platform route', async () => {
    byokMock.resolveByok.mockResolvedValueOnce({ rowId: 'r1', apiKey: 'user', baseUrl: 'https://api.deepseek.com' } as never);
    await robo(async () => {
      setCurrentUserId('user_intl');
      await new LLMService().chat(msgs);
    });
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
    expect(loggerMock.warn).toHaveBeenCalledWith('LLM_POLICY', expect.stringContaining('Skipping a personal'), expect.anything(), expect.any(String));
  });
});

describe('content safety (WP-24 seam, wired here)', () => {
  function spyProvider(overrides: Partial<{ input: () => Promise<unknown>; output: () => Promise<unknown> }> = {}) {
    const provider = {
      id: 'spy',
      checkInput: vi.fn(overrides.input ?? (async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }))),
      checkOutput: vi.fn(overrides.output ?? (async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }))),
    };
    safety.setContentSafetyProvider(provider as never);
    return provider;
  }

  beforeEach(() => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
  });

  it('checks the input before and the output after every GoApply call', async () => {
    const provider = spyProvider();
    await go(() => new LLMService().chat(msgs, { task: 'rewrite' }));

    expect(provider.checkInput).toHaveBeenCalledTimes(1);
    const [inputText, ctx] = provider.checkInput.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(inputText.startsWith('Rewrite my summary.')).toBe(true);
    expect(ctx).toMatchObject({ brand: 'goapply', task: 'rewrite' });
    expect(provider.checkOutput).toHaveBeenCalledWith('deepseek says hello', expect.objectContaining({ brand: 'goapply', callId: ctx.callId }));
  });

  it('never checks RoboApply calls', async () => {
    const provider = spyProvider();
    await robo(() => new LLMService().chat(msgs));
    expect(provider.checkInput).not.toHaveBeenCalled();
    expect(provider.checkOutput).not.toHaveBeenCalled();
  });

  it('a blocked input never reaches the model (422 content_blocked)', async () => {
    spyProvider({ input: async () => ({ verdict: 'block', labels: ['rule_1'], provider: 'spy' }) });
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'content_blocked', status: 422 });
    expect(state.calls).toEqual([]);
  });

  it('a blocked output is not returned', async () => {
    spyProvider({ output: async () => ({ verdict: 'block', labels: ['rule_2'], provider: 'spy' }) });
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'content_blocked', details: { stage: 'output' } });
  });

  it('fails closed (503 ai_unavailable) when the checker errors', async () => {
    spyProvider({ output: async () => { throw new Error('green timeout'); } });
    const caught = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: 'ai_unavailable', reason: 'content_safety_unavailable' });
  });

  it('runs no check when GoApply has no model (nothing was going to be sent)', async () => {
    delete process.env.CN_LLM_MODEL;
    const provider = spyProvider();
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(provider.checkInput).not.toHaveBeenCalled();
  });
});

describe('route explanation and probe', () => {
  it('explains per-task resolution without calling anything', () => {
    process.env.CN_LLM_PROVIDER = 'qwen';
    process.env.CN_LLM_MODEL = 'qwen-plus';
    const svc = new LLMService();
    const copilot = svc.explainRoute('copilot', 'goapply');
    expect(copilot).toMatchObject({
      brand: 'goapply',
      selector: 'qwen-plus',
      inheritsDefault: true,
      providerType: 'qwen',
      host: 'dashscope.aliyuncs.com',
      hasKey: true,
      allowed: true,
      toolsSupported: true,
    });
    expect(svc.explainRoute('fallback', 'goapply')).toMatchObject({ selector: null, allowed: false, policyCode: 'missing_route' });
    expect(state.calls).toEqual([]);
  });

  it('probe refuses an international model for GoApply without calling it', async () => {
    const result = await go(() => new LLMService().probeModel('openrouter/openai/gpt-6-luna', 'goapply'));
    expect(result.ok).toBe(false);
    expect(state.calls).toEqual([]);
  });
});
