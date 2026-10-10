// @vitest-environment node
//
// Per-brand routing (D5; GOAPPLY_PARITY_PLAN.md §3.3): GoApply on the shared
// stack routes exactly as RoboApply does (same provider, model, fallback
// chain, BYOK); with a domestic provider of its own that path is unchanged;
// the mainland-only allowlist and BYOK-off are the operator's opt-in
// (CN_LLM_DOMESTIC_ONLY). The RoboApply egress rule (on the endpoint host,
// primary and fallback) is unchanged, and content safety runs on every
// GoApply call whatever route it takes (fail closed).

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
// The real brand predicate (isByokAllowedForBrand); only the key lookup is faked.
vi.mock('../../lib/byokService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/byokService.js')>()),
  ...byokMock,
}));
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
const { getTaskModelOrDefault } = await import('../../lib/llm/llmTaskSettings.js');
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
  'LLM_VISION_MODEL',
  'CN_LLM_VISION_MODEL',
  'LLM_COPILOT_MODEL',
  'CN_LLM_DOMESTIC_ONLY',
  'CN_RESIDENCY_STRICT',
  'CN_CONTENT_SAFETY_PROVIDER',
  'CN_SAFETY_KEYWORDS_URL',
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

/** Every model/provider variable of either brand that is set right now (a local .env may carry some). */
const llmEnvNames = () => Object.keys(process.env).filter((n) => /^(CN_)?LLM_/.test(n));

beforeEach(() => {
  const names = [...new Set([...ENV_NAMES, ...llmEnvNames()])];
  savedEnv = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  // The shared stack is configured. GoApply runs on it unless it has its own.
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
  for (const n of new Set([...Object.keys(savedEnv), ...llmEnvNames()])) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
  safety.setContentSafetyProvider(null);
  safety.setContentSafetyEventWriter(null);
  safety.reloadContentSafetyFromEnv();
});

/** The operator's opt-in wall: GoApply may use mainland model endpoints only. */
const wall = () => {
  process.env.CN_LLM_DOMESTIC_ONLY = 'true';
};
const ownDeepSeek = () => {
  process.env.CN_LLM_PROVIDER = 'deepseek';
  process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
};

describe('GoApply on the shared stack (D5: no CN_LLM_* set)', () => {
  it('chat reaches the same provider and model as RoboApply', async () => {
    const goResult = await go(() => new LLMService().chatWithUsage(msgs));
    const goCalls = [...state.calls];
    state.calls.length = 0;
    const roboResult = await robo(() => new LLMService().chatWithUsage(msgs));

    expect(goCalls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
    expect(goCalls).toEqual(state.calls);
    expect(goResult.content).toBe(roboResult.content);
  });

  it('keeps the same fallback chain: configured hop, then the auto routes', async () => {
    process.env.LLM_FALLBACK_MODEL = 'google/gemini-3.8-flash';
    state.behavior = { openrouter: err('401 User not found.', { status: 401 }), google: err('402 Insufficient credits', { status: 402 }) };

    await go(() => new LLMService().chat(msgs));
    const goChain = state.calls.map((c) => `${c.provider}/${c.model}`);
    state.calls.length = 0;
    routing.resetCircuits();
    await robo(() => new LLMService().chat(msgs));

    expect(goChain).toEqual(['openrouter/openai/gpt-6-luna', 'google/gemini-3.8-flash', 'anthropic/claude-sonnet-4-6']);
    expect(state.calls.map((c) => `${c.provider}/${c.model}`)).toEqual(goChain);
  });

  it('an international provider is allowed as a fallback hop, and GoApply keeps its domestic vendors too', async () => {
    // RoboApply drops a direct DeepSeek hop (user data never to a mainland endpoint); GoApply may use it.
    process.env.LLM_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';
    state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

    await go(() => new LLMService().chat(msgs));
    expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'deepseek']);

    state.calls.length = 0;
    routing.resetCircuits();
    await robo(() => new LLMService().chat(msgs));
    expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'google']);
  });

  it('routes explicit international selectors natively, as RoboApply does', async () => {
    for (const [model, provider, sent] of [
      ['google/gemini-3.8-flash', 'google', 'gemini-3.8-flash'],
      ['anthropic/claude-sonnet-4-6', 'anthropic', 'claude-sonnet-4-6'],
      ['openai/gpt-6-luna', 'openai', 'gpt-6-luna'],
      // On the shared (global) profile qwen/ is an OpenRouter id, exactly as for RoboApply.
      ['qwen/qwen3.8-flash', 'openrouter', 'qwen/qwen3.8-flash'],
    ] as const) {
      state.calls.length = 0;
      await go(() => new LLMService().chat(msgs, { model }));
      expect(state.calls).toEqual([{ provider, model: sent }]);
    }
  });

  it('never answers no_model: a missing shared model is the same configuration error as on RoboApply', async () => {
    delete process.env.LLM_MODEL;
    const goErr = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);
    const roboErr = await robo(() => new LLMService().chat(msgs)).catch((e: unknown) => e);
    expect(goErr).not.toBeInstanceOf(AiUnavailableError);
    expect((goErr as Error).message).toMatch(/No LLM model is configured/);
    expect((goErr as Error).message).toBe((roboErr as Error).message);
    expect(state.calls).toEqual([]);
  });

  it('uses a personal key as RoboApply does (the endpoint re-check runs for both brands)', async () => {
    await go(async () => {
      setCurrentUserId('user_cn');
      await new LLMService().chat(msgs);
    });
    expect(byokMock.resolveByok).toHaveBeenCalledWith('user_cn', 'openrouter');

    // A GoApply user's own key may point at a mainland endpoint; a RoboApply user's may not.
    byokMock.resolveByok.mockResolvedValue({ rowId: 'r1', apiKey: 'user', baseUrl: 'https://api.deepseek.com' } as never);
    state.calls.length = 0;
    loggerMock.warn.mockClear();
    await go(async () => {
      setCurrentUserId('user_cn');
      await new LLMService().chat(msgs);
    });
    expect(loggerMock.warn).not.toHaveBeenCalledWith('LLM_POLICY', expect.stringContaining('Skipping a personal'), expect.anything(), expect.any(String));
    expect(loggerMock.logLLMCall).toHaveBeenCalledWith(expect.objectContaining({ byok: true, status: 'success' }));
  });

  it('a blocked keyword is refused on the shared international route; the same prompt on RoboApply is not filtered', async () => {
    // The real default filter (keyword_only, built-in list): nothing is injected.
    const events: Array<Record<string, unknown>> = [];
    safety.setContentSafetyEventWriter(async (row) => {
      events.push(row as unknown as Record<string, unknown>);
    });
    const blocked = safety.BUILTIN_KEYWORD_LIST.entries.find((e) => e.action === 'block')!;
    const prompt = [{ role: 'user' as const, content: `Please help with this: ${blocked.term}` }];

    const caught = await go(() => new LLMService().chat(prompt, { task: 'rewrite' })).catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: 'content_blocked', status: 422, details: { stage: 'input' } });
    expect(state.calls).toEqual([]); // the prompt never reached OpenRouter
    expect(events).toEqual([expect.objectContaining({ brand: 'goapply', verdict: 'block' })]);

    await robo(() => new LLMService().chat(prompt));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
    expect(events).toHaveLength(1);

    // A clean GoApply prompt goes to the shared route, checked on the way in and out.
    state.calls.length = 0;
    await go(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
    expect(events.filter((e) => e.verdict === 'pass')).toHaveLength(2);
  });
});

describe('GoApply with a domestic provider of its own (CN_LLM_PROVIDER): the path is unchanged', () => {
  it('passes with DeepSeek and reads its own CN_LLM_* first', async () => {
    ownDeepSeek();

    const result = await go(() => new LLMService().chatWithUsage(msgs));

    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
    expect(result.content).toBe('deepseek says hello');
  });

  it('mixed case: a model it has not overridden comes from the shared stack and goes to its real route, never to DeepSeek', async () => {
    ownDeepSeek();
    process.env.LLM_VISION_MODEL = 'gpt-6-vision'; // a bare id: OpenRouter on the shared stack
    const { getModelSetting } = await import('../../lib/llm/llmModels.js');

    await go(() => new LLMService().chat(msgs, { visionModel: getModelSetting('vision') }));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'gpt-6-vision' }]);

    // The same read for RoboApply is the raw selector and the same route.
    state.calls.length = 0;
    await robo(() => new LLMService().chat(msgs, { visionModel: getModelSetting('vision') }));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'gpt-6-vision' }]);

    // Its own default is still its own.
    state.calls.length = 0;
    await go(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });

  it('answers ai_unavailable (no_model) when its own stack has no route or no model; it never guesses a provider for a bare id', async () => {
    // A default model of its own, a bare id, and no provider of its own.
    process.env.CN_LLM_MODEL = 'qwen-plus';
    const caught = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiUnavailableError);
    expect(caught).toMatchObject({ code: 'ai_unavailable', status: 503, reason: 'no_model' });

    // A provider of its own and no model anywhere.
    delete process.env.CN_LLM_MODEL;
    delete process.env.LLM_MODEL;
    process.env.CN_LLM_PROVIDER = 'deepseek';
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'ai_unavailable', reason: 'no_model' });
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

  it('routes a qwen/ selector to DashScope on its own (domestic) profile', async () => {
    ownDeepSeek();
    process.env.CN_LLM_REWRITE_MODEL = 'qwen/qwen-plus';
    const { getTaskModel } = await import('../../lib/llm/llmTaskSettings.js');

    await go(() => new LLMService().chat(msgs, { model: getTaskModel('rewrite') }));
    expect(state.calls).toEqual([{ provider: 'qwen', model: 'qwen-plus' }]);
  });

  it('a qwen/ task model keeps meaning DashScope even with no provider of its own (shared profile)', async () => {
    process.env.CN_LLM_REWRITE_MODEL = 'qwen/qwen-plus';
    const { getTaskModel } = await import('../../lib/llm/llmTaskSettings.js');

    await go(() => new LLMService().chat(msgs, { model: getTaskModel('rewrite') }));
    expect(state.calls).toEqual([{ provider: 'qwen', model: 'qwen-plus' }]);
  });

  it('falls back through its own configured hop first', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-pro';
    process.env.CN_LLM_FALLBACK_MODEL = 'qwen/qwen-plus';
    state.behavior = { deepseek: err('401 Invalid API key', { status: 401 }) };

    const result = await go(() => new LLMService().chatWithUsage(msgs));

    expect(state.calls.map((c) => c.provider)).toEqual(['deepseek', 'qwen']);
    expect(result.content).toBe('qwen says hello');
  });

  it('by default an international fallback hop is allowed too (its own, or the shared one it has not overridden)', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-pro';
    state.behavior = { deepseek: err('402 Insufficient Balance', { status: 402 }) };

    // The shared LLM_FALLBACK_MODEL (openrouter/google/gemini-3.8-flash), read per key.
    await go(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
      { provider: 'openrouter', model: 'google/gemini-3.8-flash' },
    ]);

    state.calls.length = 0;
    routing.resetCircuits();
    process.env.CN_LLM_FALLBACK_MODEL = 'openrouter/openai/gpt-6-luna';
    await go(() => new LLMService().chat(msgs));
    expect(state.calls.map((c) => `${c.provider}/${c.model}`)).toEqual(['deepseek/deepseek-v4-pro', 'openrouter/openai/gpt-6-luna']);
  });

  it('the brand option pins a call regardless of the ambient context', async () => {
    ownDeepSeek();
    await robo(() => new LLMService().chat(msgs, { brand: 'goapply' }));
    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });
});

describe('GoApply behind the domestic-only wall (CN_LLM_DOMESTIC_ONLY=true)', () => {
  beforeEach(wall);

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

  it('the shared stack is no fallback: with no mainland model AI is unavailable (503) and nothing is sent', async () => {
    const caught = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiUnavailableError);
    expect(caught).toMatchObject({ code: 'ai_unavailable', status: 503, reason: 'no_model' });
    expect((caught as { detail?: string }).detail).toMatch(/CN_LLM_DOMESTIC_ONLY/);
    expect(state.calls).toEqual([]);
    // A shared task model is no fallback either: the task has no model of GoApply's own.
    process.env.LLM_REWRITE_MODEL = 'openai/gpt-6-luna';
    expect(getTaskModelOrDefault('rewrite', 'goapply')).toBeUndefined();
    await expect(go(() => new LLMService().chat(msgs, { task: 'rewrite', model: getTaskModelOrDefault('rewrite', 'goapply') }))).rejects.toMatchObject({
      code: 'ai_unavailable',
      reason: 'no_model',
    });
    expect(state.calls).toEqual([]);
    // CN_RESIDENCY_STRICT implies the wall.
    delete process.env.CN_LLM_DOMESTIC_ONLY;
    process.env.CN_RESIDENCY_STRICT = 'true';
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'ai_unavailable', reason: 'no_model' });
    expect(state.calls).toEqual([]);
    // RoboApply is not behind GoApply's wall.
    await robo(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
  });

  it('a shared task model does not shadow GoApply\'s own mainland default: the task runs on that default', async () => {
    ownDeepSeek();
    // RoboApply's task models, set for the whole deployment.
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    process.env.LLM_REWRITE_MODEL = 'openai/gpt-6-luna';
    process.env.LLM_VISION_MODEL = 'google/gemini-3.8-flash';
    const svc = new LLMService();

    expect(svc.explainRoute('copilot', 'goapply')).toMatchObject({
      selector: 'deepseek-v4-flash',
      source: 'env',
      inheritsDefault: true,
      sharedWalledOff: 'openrouter/openai/gpt-6-luna',
      providerType: 'deepseek',
      host: 'api.deepseek.com',
      allowed: true,
      toolsSupported: true,
    });
    expect(svc.explainRoute('rewrite', 'goapply')).toMatchObject({ selector: 'deepseek-v4-flash', providerType: 'deepseek', allowed: true });
    // The shared fallback is international: GoApply has none behind the wall.
    expect(svc.explainRoute('fallback', 'goapply')).toMatchObject({
      selector: null,
      source: 'none',
      allowed: false,
      policyCode: 'missing_route',
      sharedWalledOff: 'openrouter/google/gemini-3.8-flash',
    });
    // RoboApply's rows are untouched by GoApply's wall.
    expect(svc.explainRoute('copilot', 'roboapply')).toMatchObject({ selector: 'openrouter/openai/gpt-6-luna', providerType: 'openrouter', allowed: true });
    expect(svc.explainRoute('copilot', 'roboapply').sharedWalledOff).toBeUndefined();

    await go(() => svc.chat(msgs, { model: getTaskModelOrDefault('rewrite', 'goapply') }));
    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });

  it('a shared selector that names a mainland vendor is still inherited behind the wall', async () => {
    ownDeepSeek();
    process.env.LLM_REWRITE_MODEL = 'kimi/kimi-k2';
    const svc = new LLMService();
    expect(svc.explainRoute('rewrite', 'goapply')).toMatchObject({ selector: 'kimi/kimi-k2', source: 'shared', providerType: 'kimi', allowed: true });
    expect(svc.explainRoute('rewrite', 'goapply').sharedWalledOff).toBeUndefined();
    await go(() => svc.chat(msgs, { model: getTaskModelOrDefault('rewrite', 'goapply') }));
    expect(state.calls).toEqual([{ provider: 'kimi', model: 'kimi-k2' }]);
  });

  it('a bare GoApply task model with no mainland provider mode has no route: unavailable, not sent through OpenRouter', async () => {
    // Only a task model of its own, as a bare id; the shared provider mode (openrouter) is not borrowed behind the wall.
    process.env.CN_LLM_REWRITE_MODEL = 'qwen-plus';
    const caught = await go(() => new LLMService().chat(msgs, { model: getTaskModelOrDefault('rewrite', 'goapply') })).catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: 'ai_unavailable', reason: 'no_model' });
    expect(state.calls).toEqual([]);
    // Spelled with its vendor it routes.
    process.env.CN_LLM_REWRITE_MODEL = 'dashscope/qwen-plus';
    await go(() => new LLMService().chat(msgs, { model: getTaskModelOrDefault('rewrite', 'goapply') }));
    expect(state.calls).toEqual([{ provider: 'qwen', model: 'qwen-plus' }]);
  });

  it('refuses an explicit international model even when the provider mode is domestic', async () => {
    ownDeepSeek();

    for (const model of ['google/gemini-3.8-flash', 'anthropic/claude-sonnet-4-6', 'openrouter/qwen/qwen3.8-flash']) {
      await expect(go(() => new LLMService().chat(msgs, { model }))).rejects.toBeInstanceOf(LlmBrandPolicyError);
    }
    expect(state.calls).toEqual([]);
    // Its domestic route still works.
    await go(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });

  it('refuses a domestic provider behind an international host and a gateway off the allowlist', async () => {
    ownDeepSeek();
    state.baseUrls = { deepseek: 'https://llm-proxy.example.com/v1' };
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ policyCode: 'host_not_domestic' });

    process.env.CN_LLM_PROVIDER = 'newapi';
    process.env.NEWAPI_BASE_URL = 'https://gateway.example.com/v1';
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ policyCode: 'newapi_host_not_allowlisted' });
    expect(state.calls).toEqual([]);
  });

  it('never falls back to an international hop (configured, shared or auto) instead of leaving the mainland', async () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-pro';
    process.env.CN_LLM_FALLBACK_MODEL = 'openrouter/openai/gpt-6-luna';
    state.behavior = { deepseek: err('402 Insufficient Balance', { status: 402 }) };

    const caught = await go(() => new LLMService().chat(msgs)).catch((e: unknown) => e);

    expect(routing.isLLMUnavailableError(caught)).toBe(true);
    expect(state.calls.map((c) => c.provider)).toEqual(['deepseek']);
    expect((caught as Error).message).toContain('CN_LLM_FALLBACK_MODEL');
    expect((caught as Error).message).not.toMatch(/google|anthropic|openai, /);

    // The shared fallback it would inherit is international as well: dropped.
    delete process.env.CN_LLM_FALLBACK_MODEL;
    state.calls.length = 0;
    routing.resetCircuits();
    await expect(go(() => new LLMService().chat(msgs))).rejects.toSatisfy(routing.isLLMUnavailableError);
    expect(state.calls.map((c) => c.provider)).toEqual(['deepseek']);
  });

  it('never consults a personal key (BYOK off behind the wall); RoboApply still does', async () => {
    ownDeepSeek();
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
});

describe('calls with no brand context (crons, workers)', () => {
  it('route as the locked brand: on a GoApply-only deployment they read its own CN_LLM_* (OpenRouter is refused only behind the wall)', async () => {
    process.env.BRAND_LOCK = 'goapply';
    process.env.CN_LLM_PROVIDER = 'openrouter';
    process.env.CN_LLM_MODEL = 'meta/llama-4-scout';

    await new LLMService().chat(msgs);
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'meta/llama-4-scout' }]);

    state.calls.length = 0;
    wall();
    const caught = await new LLMService().chat(msgs).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(LlmBrandPolicyError);
    expect(caught).toMatchObject({ policyCode: 'provider_not_domestic' });
    expect(state.calls).toEqual([]);
  });

  it('a single ALLOWED_BRANDS entry locks too: the call uses the CN stack when it is set', async () => {
    process.env.ALLOWED_BRANDS = 'goapply';
    ownDeepSeek();

    await new LLMService().chat(msgs);

    expect(state.calls).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }]);
  });

  it('a GoApply-only deployment with no CN model uses the shared model', async () => {
    process.env.BRAND_LOCK = 'goapply';
    await new LLMService().chat(msgs);
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
  });

  it('production, both brands served by default, shared stack only: the call completes as RoboApply with one warning', async () => {
    process.env.NODE_ENV = 'production';
    // A fresh module, so the once-per-process warning is observable.
    vi.resetModules();
    const fresh = await import('./LLMService.js');

    await new fresh.LLMService().chat(msgs);
    await new fresh.LLMService().chat(msgs);

    expect(state.calls).toEqual([
      { provider: 'openrouter', model: 'openai/gpt-6-luna' },
      { provider: 'openrouter', model: 'openai/gpt-6-luna' },
    ]);
    const warnings = loggerMock.warn.mock.calls.filter((c) => c[0] === 'LLM_POLICY' && String(c[1]).includes('without a brand context'));
    expect(warnings).toHaveLength(1);
  });

  it('production, GoApply with a stack of its own or behind the wall: refuses to guess the brand (BrandContextMissingError)', async () => {
    process.env.NODE_ENV = 'production';
    for (const set of [
      () => { process.env.CN_LLM_PROVIDER = 'deepseek'; },
      () => { process.env.CN_LLM_MODEL = 'deepseek/deepseek-v4-flash'; },
      () => { process.env.CN_LLM_DOMESTIC_ONLY = 'true'; },
    ]) {
      for (const n of ['CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_DOMESTIC_ONLY']) delete process.env[n];
      set();
      await expect(new LLMService().chat(msgs)).rejects.toMatchObject({ name: 'BrandContextMissingError' });
    }
    expect(state.calls).toEqual([]);
    // The same holds when the scope names both brands explicitly.
    process.env.ALLOWED_BRANDS = 'roboapply,goapply';
    await expect(new LLMService().chat(msgs)).rejects.toMatchObject({ name: 'BrandContextMissingError' });
    // With a context (or an explicit brand) the same deployment routes normally.
    await robo(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
    await new LLMService().chat(msgs, { brand: 'roboapply' });
    expect(state.calls).toHaveLength(2);
  });

  it('a RoboApply-only deployment (ALLOWED_BRANDS=roboapply) keeps the default brand whatever the CN_ values say', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_BRANDS = 'roboapply';
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
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

    // The same gateway is fine for GoApply (a domestic host), behind the wall too.
    process.env.CN_LLM_PROVIDER = 'newapi';
    process.env.CN_LLM_MODEL = 'qwen-plus';
    await go(() => new LLMService().chat(msgs));
    wall();
    await go(() => new LLMService().chat(msgs));
    expect(state.calls).toEqual([
      { provider: 'newapi', model: 'qwen-plus' },
      { provider: 'newapi', model: 'qwen-plus' },
    ]);
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
    // WP-24's engine also passes a third `{ signal }` options argument, so
    // assert on the first two arguments only.
    expect(provider.checkOutput).toHaveBeenCalledTimes(1);
    const [outputText, outCtx] = provider.checkOutput.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(outputText).toBe('deepseek says hello');
    expect(outCtx).toMatchObject({ brand: 'goapply', callId: ctx.callId });
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

  it('runs no check when the call has no route (nothing was going to be sent)', async () => {
    // GoApply's own default model as a bare id, with no provider of its own.
    delete process.env.CN_LLM_PROVIDER;
    const provider = spyProvider();
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'ai_unavailable', reason: 'no_model' });
    expect(provider.checkInput).not.toHaveBeenCalled();
    // Nor behind the wall: without a mainland model there is no call to check...
    delete process.env.CN_LLM_MODEL;
    wall();
    await expect(go(() => new LLMService().chat(msgs))).rejects.toMatchObject({ code: 'ai_unavailable', reason: 'no_model' });
    expect(provider.checkInput).not.toHaveBeenCalled();
    // ...and a route the wall refuses is never checked either.
    await expect(go(() => new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' }))).rejects.toMatchObject({ code: 'brand_policy' });
    expect(provider.checkInput).not.toHaveBeenCalled();
  });

  it('checks a GoApply call on the shared route exactly as on its own provider', async () => {
    delete process.env.CN_LLM_PROVIDER;
    delete process.env.CN_LLM_MODEL;
    const provider = spyProvider();
    await go(() => new LLMService().chat(msgs, { task: 'rewrite' }));
    expect(state.calls).toEqual([{ provider: 'openrouter', model: 'openai/gpt-6-luna' }]);
    expect(provider.checkInput).toHaveBeenCalledTimes(1);
    expect(provider.checkOutput).toHaveBeenCalledTimes(1);
    const [outputText, outCtx] = provider.checkOutput.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(outputText).toBe('openrouter says hello');
    expect(outCtx).toMatchObject({ brand: 'goapply', task: 'rewrite' });
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
      profile: 'domestic_cn',
      selector: 'qwen-plus',
      source: 'env',
      inheritsDefault: true,
      providerType: 'qwen',
      host: 'dashscope.aliyuncs.com',
      hasKey: true,
      allowed: true,
      toolsSupported: true,
    });
    // A key it has not overridden shows the shared selector and says where it comes from.
    expect(svc.explainRoute('fallback', 'goapply')).toMatchObject({
      selector: 'openrouter/google/gemini-3.8-flash',
      source: 'shared',
      providerType: 'openrouter',
      host: 'openrouter.ai',
      allowed: true,
    });
    wall();
    // Behind the wall the international shared fallback is set aside, not inherited and then refused.
    expect(svc.explainRoute('fallback', 'goapply')).toMatchObject({
      selector: null,
      source: 'none',
      allowed: false,
      policyCode: 'missing_route',
      sharedWalledOff: 'openrouter/google/gemini-3.8-flash',
    });
    expect(svc.explainRoute('copilot', 'goapply')).toMatchObject({ allowed: true });
    expect(state.calls).toEqual([]);
  });

  it('GoApply rows on the shared stack show the shared selector and the global profile, as RoboApply\'s do', () => {
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna-copilot';
    const svc = new LLMService();
    const goRow = svc.explainRoute('copilot', 'goapply');
    const roboRow = svc.explainRoute('copilot', 'roboapply');
    expect(goRow).toMatchObject({ brand: 'goapply', profile: 'global', selector: 'openrouter/openai/gpt-6-luna-copilot', source: 'shared', providerType: 'openrouter', allowed: true, toolsSupported: true });
    expect(roboRow).toMatchObject({ brand: 'roboapply', profile: 'global', selector: 'openrouter/openai/gpt-6-luna-copilot', source: 'env', providerType: 'openrouter', allowed: true });
    expect({ ...goRow, brand: null, source: null }).toEqual({ ...roboRow, brand: null, source: null });
    expect(svc.explainRoute('default', 'goapply')).toMatchObject({ selector: 'openrouter/openai/gpt-6-luna', source: 'shared', inheritsDefault: false });
    expect(svc.explainRoute('enrich', 'goapply')).toMatchObject({ selector: 'openrouter/openai/gpt-6-luna', source: 'shared', inheritsDefault: true });
    // No model anywhere.
    delete process.env.LLM_FALLBACK_MODEL;
    expect(svc.explainRoute('fallback', 'goapply')).toMatchObject({ selector: null, allowed: false, policyCode: 'missing_route' });
    expect(state.calls).toEqual([]);
  });

  it('probe: an international model answers for GoApply by default and is refused behind the wall without a call', async () => {
    const open = await go(() => new LLMService().probeModel('openrouter/openai/gpt-6-luna', 'goapply'));
    expect(open).toMatchObject({ ok: true, provider: 'openrouter' });
    expect(state.calls).toHaveLength(1);

    wall();
    state.calls.length = 0;
    const result = await go(() => new LLMService().probeModel('openrouter/openai/gpt-6-luna', 'goapply'));
    expect(result.ok).toBe(false);
    expect(state.calls).toEqual([]);
  });
});
