import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These tests run without a brand context, i.e. as RoboApply. Since WP-14 the
// RoboApply egress rule applies: a prompt with user data never reaches a
// mainland-China endpoint, so direct DeepSeek is no longer a RoboApply
// fallback (see the "egress" cases below and LLMService.brand.test.ts).

const state = vi.hoisted(() => ({
  calls: [] as Array<{ provider: string; model: string | undefined; maxTokens?: number; responseFormat?: string; temperature?: number }>,
  providerMode: 'openrouter',
  fallbackModel: 'openrouter/google/fallback-model' as string,
  /** Platform keys by provider type; a missing entry means "no key". */
  keys: {} as Record<string, string>,
  behavior: {} as Record<string, 'ok' | Error>,
  byok: null as null | { rowId: string; apiKey: string; baseUrl: string | null },
  userId: null as string | null,
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  logLLMCall: vi.fn(),
}));

vi.mock('../LoggerService.js', () => ({
  generateRequestId: () => 'req_test',
  logger: loggerMock,
}));

vi.mock('../../lib/requestContext.js', () => ({
  getCurrentUserId: () => state.userId,
  getCurrentRequestId: () => null,
  setByokInRequest: vi.fn(),
}));

// The real brand predicate (isByokAllowedForBrand); only the key lookup is faked.
vi.mock('../../lib/byokService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/byokService.js')>()),
  resolveByok: vi.fn(async () => state.byok),
  touchByok: vi.fn(),
}));

vi.mock('../../lib/llm/systemCredentials.js', () => ({
  resolveProviderCredential: (provider: string) => ({ apiKey: state.keys[provider.toLowerCase()] ?? '', tuning: {} }),
}));

vi.mock('../../lib/llm/llmModels.js', () => ({
  // What lib/llm resolves for RoboApply: the configured provider mode and default model.
  getLlmRoutingDefaults: () => ({ profile: 'global', providerMode: state.providerMode, model: 'openrouter/openai/default-model' }),
  getFallbackModelSetting: () => state.fallbackModel,
}));

function makeProvider(name: string) {
  return class {
    constructor(..._args: unknown[]) {}
    getProviderName() { return name; }
    async chat(_messages: unknown, options: { model?: string; maxTokens?: number; responseFormat?: string; temperature?: number }) {
      state.calls.push({
        provider: name,
        model: options.model,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.responseFormat ? { responseFormat: options.responseFormat } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      });
      const b = state.behavior[name] ?? 'ok';
      if (b !== 'ok') throw b;
      return {
        content: `${name} response`,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        model: options.model ?? '',
      };
    }
  };
}

vi.mock('./DeepSeekProvider.js', () => ({ DeepSeekProvider: makeProvider('deepseek') }));
vi.mock('./OpenRouterProvider.js', () => ({ OpenRouterProvider: makeProvider('openrouter') }));
vi.mock('./GoogleProvider.js', () => ({ GoogleProvider: makeProvider('google') }));
vi.mock('./AnthropicProvider.js', () => ({ AnthropicProvider: makeProvider('anthropic') }));
vi.mock('./OpenAIProvider.js', () => ({ OpenAIProvider: makeProvider('openai') }));
vi.mock('./KimiProvider.js', () => ({ KimiProvider: makeProvider('kimi') }));

const { LLMService } = await import('./LLMService.js');
const routing = await import('./fallbackRouting.js');

const msgs = [{ role: 'user' as const, content: 'hello' }];
const err = (message: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(message), extra);
const ALL_KEYS = { openrouter: 'or-key', google: 'g-key', anthropic: 'a-key', deepseek: 'd-key' };

describe('LLMService fallback routing', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.providerMode = 'openrouter';
    state.fallbackModel = 'openrouter/google/fallback-model';
    state.keys = { ...ALL_KEYS };
    state.behavior = { deepseek: err('503 Service unavailable', { status: 503 }) };
    state.byok = null;
    state.userId = null;
    routing.resetCircuits();
    vi.clearAllMocks();
    delete process.env.MOCK_LLM;
    delete process.env.LLM_FALLBACK_AUTO;
  });

  afterEach(() => {
    delete process.env.MOCK_LLM;
    delete process.env.LLM_FALLBACK_AUTO;
    vi.useRealTimers();
  });

  it('routes an explicit OpenRouter fallback away from a native task provider', async () => {
    state.keys = { ...ALL_KEYS, openai: 'o-key' };
    state.behavior = { openai: err('503 Service unavailable', { status: 503 }) };
    const result = await new LLMService().chatWithUsage(msgs, { model: 'openai/native-primary' });

    expect(state.calls).toEqual([
      { provider: 'openai', model: 'native-primary' },
      { provider: 'openrouter', model: 'google/fallback-model' },
    ]);
    expect(result.model).toBe('google/fallback-model');
  });

  it('lets an explicit OpenRouter selector override a legacy provider mode', async () => {
    state.providerMode = 'deepseek';
    state.fallbackModel = '';
    state.behavior = {};

    const result = await new LLMService().chatWithUsage(msgs, { model: 'openrouter/anthropic/router-model' });

    expect(state.calls).toEqual([
      { provider: 'openrouter', model: 'anthropic/router-model' },
    ]);
    expect(result.model).toBe('anthropic/router-model');
  });

  it('keeps a transient primary failure on the primary when no fallback is configured (withLLMRetry owns it)', async () => {
    state.fallbackModel = '';
    state.behavior = { openrouter: err('503 Service unavailable', { status: 503 }) };

    await expect(new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' })).rejects.toMatchObject({ status: 503 });
    expect(state.calls.map((c) => c.provider)).toEqual(['openrouter']);
    expect(routing.listOpenCircuits()).toEqual([]);
  });

  describe.each([
    ['401 User not found.', 401, 'auth'],
    ['402 Payment Required: insufficient credits', 402, 'billing'],
    ['403 Forbidden', 403, 'auth'],
  ] as const)('credential failure %s', (message, status, kind) => {
    it('falls back to the configured model on another provider', async () => {
      state.fallbackModel = 'anthropic/claude-sonnet-4-6';
      state.behavior = { openrouter: err(message, { status }) };

      const result = await new LLMService().chatWithUsage(msgs, { model: 'openrouter/openai/gpt-6-luna' });

      expect(state.calls.map((c) => `${c.provider}/${c.model}`)).toEqual([
        'openrouter/openai/gpt-6-luna',
        'anthropic/claude-sonnet-4-6',
      ]);
      expect(result.content).toBe('anthropic response');
      expect(routing.listOpenCircuits()).toMatchObject([{ provider: 'openrouter', kind }]);
    });
  });

  it('matches credential failures on status even when the message is opaque', async () => {
    state.fallbackModel = '';
    state.behavior = { openrouter: err('Request failed', { status: 401 }) };

    const result = await new LLMService().chatWithUsage(msgs, { model: 'openrouter/openai/gpt-6-luna' });
    expect(result.model).toBe('gemini-3.8-flash');
  });

  it('auto-selects the first direct provider with a key when no fallback is configured', async () => {
    state.fallbackModel = '';
    state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

    const result = await new LLMService().chatWithUsage(msgs, {
      model: 'openrouter/openai/gpt-6-luna',
      responseFormat: 'json_object',
      temperature: 0.2,
      maxTokens: 700,
      requestId: 'req_auto',
    });

    expect(state.calls).toEqual([
      { provider: 'openrouter', model: 'openai/gpt-6-luna', maxTokens: 700, responseFormat: 'json_object', temperature: 0.2 },
      // Gemini counts thinking inside maxOutputTokens: answer budget + reasoning headroom.
      { provider: 'google', model: 'gemini-3.8-flash', maxTokens: 8700, responseFormat: 'json_object', temperature: 0.2 },
    ]);
    expect(result).toMatchObject({ content: 'google response', model: 'gemini-3.8-flash' });

    // Cost logging is attributed to the fallback's provider + model.
    const success = loggerMock.logLLMCall.mock.calls.map((c) => c[0]).find((c) => c.status === 'success');
    expect(success).toMatchObject({
      requestId: 'req_auto',
      provider: 'google',
      model: 'gemini-3.8-flash',
      options: expect.objectContaining({ fallbackFrom: 'openai/gpt-6-luna', fallbackReason: 'auth', fallbackSource: 'auto', responseFormat: 'json_object' }),
    });
    // The chosen route is announced.
    expect(loggerMock.warn).toHaveBeenCalledWith('LLM_SERVICE', expect.stringContaining('Auto-selected LLM fallback route'), expect.anything());
  });

  it('skips auto candidates without a key and never auto-selects openrouter', async () => {
    state.fallbackModel = '';
    state.keys = { openrouter: 'or-key', openai: 'o-key' };
    state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

    const result = await new LLMService().chatWithUsage(msgs, { model: 'openrouter/openai/gpt-6-luna' });

    expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'openai']);
    expect(result.model).toBe('gpt-6-luna');
  });

  describe('egress (RoboApply, WP-14)', () => {
    it('never auto-selects direct DeepSeek (a mainland endpoint) for a prompt with user data', async () => {
      state.fallbackModel = '';
      state.keys = { openrouter: 'or-key', deepseek: 'd-key' };
      state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

      const caught = await new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' }).catch((e: unknown) => e);

      expect(routing.isLLMUnavailableError(caught)).toBe(true);
      expect(state.calls.map((c) => c.provider)).toEqual(['openrouter']);
    });

    it('drops a configured DeepSeek fallback and continues to the allowed auto routes', async () => {
      state.fallbackModel = 'deepseek/deepseek-v4-flash';
      state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

      await new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });

      expect(state.calls.map((c) => `${c.provider}/${c.model}`)).toEqual([
        'openrouter/openai/gpt-6-luna',
        'google/gemini-3.8-flash',
      ]);
    });

    it('still allows DeepSeek when the caller declares the prompt carries no user data', async () => {
      state.fallbackModel = 'deepseek/deepseek-v4-flash';
      state.behavior = { openrouter: err('503 Service unavailable', { status: 503 }) };

      const result = await new LLMService().chatWithUsage(msgs, { model: 'openrouter/openai/gpt-6-luna', carriesUserData: false });

      expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'deepseek']);
      expect(result.content).toBe('deepseek response');
    });

    it('refuses a direct DeepSeek primary with brand_policy and never re-routes it', async () => {
      const caught = await new LLMService().chat(msgs, { model: 'deepseek/deepseek-v4-flash' }).catch((e: unknown) => e);

      expect(caught).toMatchObject({ code: 'brand_policy', policyCode: 'mainland_endpoint_for_intl', host: 'api.deepseek.com' });
      expect(state.calls).toEqual([]);
      expect(loggerMock.error).toHaveBeenCalledWith('LLM_POLICY', expect.stringContaining('Refused LLM route'), expect.anything(), expect.anything());
    });
  });

  it('skips a configured fallback on the same dead provider and continues to the auto routes', async () => {
    state.fallbackModel = 'openrouter/google/fallback-model';
    state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

    await new LLMService().chatWithUsage(msgs, { model: 'openrouter/openai/gpt-6-luna' });

    expect(state.calls.map((c) => `${c.provider}/${c.model}`)).toEqual([
      'openrouter/openai/gpt-6-luna',
      'google/gemini-3.8-flash',
    ]);
  });

  it('walks past a fallback that is itself out of credit (Anthropic reports it as 400)', async () => {
    state.fallbackModel = '';
    state.keys = { openrouter: 'or-key', anthropic: 'a-key', openai: 'o-key' };
    state.behavior = {
      openrouter: err('401 User not found.', { status: 401 }),
      anthropic: err('400 Your credit balance is too low to access the Anthropic API.', { status: 400 }),
    };

    const result = await new LLMService().chatWithUsage(msgs, { model: 'openrouter/openai/gpt-6-luna' });

    expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'anthropic', 'openai']);
    expect(result.content).toBe('openai response');
    expect(routing.listOpenCircuits().map((c) => c.provider).sort()).toEqual(['anthropic', 'openrouter']);
  });

  it('stops the chain on a non-credential fallback failure', async () => {
    state.fallbackModel = '';
    state.behavior = {
      openrouter: err('401 User not found.', { status: 401 }),
      google: err('400 Invalid argument', { status: 400 }),
    };

    await expect(new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' })).rejects.toThrow('400 Invalid argument');
    expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'google']);
  });

  describe('circuit breaker', () => {
    it('routes straight to the fallback while the circuit is open, then retries the primary after 10 minutes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
      state.fallbackModel = '';
      state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };
      const svc = new LLMService();

      await svc.chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });
      expect(state.calls.map((c) => c.provider)).toEqual(['openrouter', 'google']);

      state.calls.length = 0;
      await svc.chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });
      await svc.chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });
      // No wasted round-trip to the dead provider.
      expect(state.calls.map((c) => c.provider)).toEqual(['google', 'google']);
      const bypassLogs = loggerMock.warn.mock.calls.filter((c) => String(c[1]).startsWith('Circuit open for'));
      expect(bypassLogs).toHaveLength(1);

      // After the window the primary is tried again (the key may have been fixed).
      state.behavior = {};
      vi.setSystemTime(new Date(Date.now() + routing.CIRCUIT_OPEN_MS + 1));
      state.calls.length = 0;
      await svc.chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });
      expect(state.calls.map((c) => c.provider)).toEqual(['openrouter']);
    });

    it('closes immediately when the key is rotated', async () => {
      state.fallbackModel = '';
      state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };
      const svc = new LLMService();
      await svc.chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });

      state.keys.openrouter = 'rotated-key';
      state.behavior = {};
      state.calls.length = 0;
      await svc.chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });
      expect(state.calls.map((c) => c.provider)).toEqual(['openrouter']);
    });

    it('does not open on network or 5xx errors', async () => {
      state.fallbackModel = 'anthropic/claude-sonnet-4-6';
      state.behavior = { openrouter: err('503 Service unavailable', { status: 503 }) };
      await new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' });
      expect(routing.listOpenCircuits()).toEqual([]);
    });

    it('never short-circuits or falls back for a BYOK call', async () => {
      routing.openCircuit('openrouter', routing.credentialFingerprint('or-key'), 'auth', '401 User not found.');
      state.userId = 'user_1';
      state.byok = { rowId: 'row_1', apiKey: 'user-key', baseUrl: null };
      state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

      await expect(new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' })).rejects.toThrow('401 User not found.');
      expect(state.calls.map((c) => c.provider)).toEqual(['openrouter']);
    });
  });

  describe('no fallback available', () => {
    it('throws a clear, non-retryable llm_unavailable error without an HTTP status', async () => {
      state.fallbackModel = '';
      state.keys = { openrouter: 'or-key' };
      state.behavior = { openrouter: err('401 User not found.', { status: 401 }) };

      const caught = await new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' }).catch((e: unknown) => e);

      expect(routing.isLLMUnavailableError(caught)).toBe(true);
      const e = caught as InstanceType<typeof routing.LLMUnavailableError>;
      expect(e.code).toBe('llm_unavailable');
      expect(e.reason).toBe('auth');
      expect(e.upstreamStatus).toBe(401);
      expect(e.nonRetryable).toBe(true);
      expect((e as unknown as { status?: number }).status).toBeUndefined();
      expect(e.message).toContain('"openrouter" rejected its API key (401 User not found.)');
      expect(e.message).toContain('set LLM_FALLBACK_MODEL');
      // Only the auto routes this brand may use are suggested (no DeepSeek for RoboApply).
      expect(e.message).toContain('google, anthropic, openai');
    });

    it('respects LLM_FALLBACK_AUTO=false', async () => {
      process.env.LLM_FALLBACK_AUTO = 'false';
      state.fallbackModel = '';
      state.behavior = { openrouter: err('402 Payment Required', { status: 402 }) };

      const caught = await new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' }).catch((e: unknown) => e);
      expect(routing.isLLMUnavailableError(caught)).toBe(true);
      expect((caught as { reason: string }).reason).toBe('billing');
      expect(state.calls.map((c) => c.provider)).toEqual(['openrouter']);
    });

    it('reports every fallback that also failed', async () => {
      state.fallbackModel = '';
      state.keys = { openrouter: 'or-key', google: 'g-key' };
      state.behavior = {
        openrouter: err('401 User not found.', { status: 401 }),
        google: err('[GoogleGenerativeAI Error]: [403 Forbidden] API key not valid'),
      };

      const caught = await new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' }).catch((e: unknown) => e);
      expect(routing.isLLMUnavailableError(caught)).toBe(true);
      expect((caught as Error).message).toContain('Fallback routes also failed: google/gemini-3.8-flash');
      expect((caught as { attemptedFallbacks: string[] }).attemptedFallbacks).toEqual(['google/gemini-3.8-flash']);
    });

    it('reroutes a primary with no platform key at all', async () => {
      state.fallbackModel = '';
      state.keys = { google: 'g-key' };

      const result = await new LLMService().chatWithUsage(msgs, { model: 'openrouter/openai/gpt-6-luna' });
      expect(state.calls.map((c) => c.provider)).toEqual(['google']);
      expect(result.model).toBe('gemini-3.8-flash');
    });

    it('fails clearly when the primary has no key and nothing else does either', async () => {
      state.fallbackModel = '';
      state.keys = {};

      const caught = await new LLMService().chat(msgs, { model: 'openrouter/openai/gpt-6-luna' }).catch((e: unknown) => e);
      expect(routing.isLLMUnavailableError(caught)).toBe(true);
      expect((caught as { reason: string }).reason).toBe('missing_key');
      expect((caught as Error).message).toContain('has no API key configured');
    });
  });
});

describe('classifyCredentialFailure', () => {
  const c = routing.classifyCredentialFailure;
  it.each([
    [{ status: 401, message: 'x' }, 'auth'],
    [{ status: 403, message: 'x' }, 'auth'],
    [{ status: 402, message: 'x' }, 'billing'],
    [{ response: { status: 401 }, message: 'x' }, 'auth'],
    [new Error('401 User not found.'), 'auth'],
    [new Error('Invalid API key provided'), 'auth'],
    [new Error('UNAUTHORIZED'), 'auth'],
    [new Error('Payment Required'), 'billing'],
    [new Error('Insufficient credits on account'), 'billing'],
    [{ status: 400, message: '400 Your credit balance is too low to access the Anthropic API.' }, 'billing'],
    [{ status: 429, message: '429 You exceeded your current quota, please check your plan' }, 'billing'],
    [new Error('[GoogleGenerativeAI Error]: [403 Forbidden] API key not valid'), 'auth'],
    [{ status: 403, message: '403 Key limit exceeded (total limit)' }, 'billing'],
  ] as Array<[unknown, string]>)('%o → %s', (input, expected) => {
    expect(c(input)).toBe(expected);
  });

  it.each([
    [{ status: 503, message: 'Service unavailable' }],
    [{ status: 429, message: 'Too many requests' }],
    [{ status: 404, message: '404 Not found the model kimi-k2.5 or Permission denied' }],
    [{ status: 400, message: '400 invalid temperature' }],
    [new Error('fetch failed')],
    [Object.assign(new Error('unauthorized'), { name: 'AbortError' })],
    // Per-request 403s say nothing about the key: no provider-wide circuit.
    [{ status: 403, message: '403 openai/gpt-6-luna requires moderation on OpenRouter. Your input was flagged for "harassment"' }],
    [{ status: 403, message: '403 Country, region, or territory not supported' }],
    [{ status: 403, message: '403 Project proj_x does not have access to model gpt-6-sol' }],
  ] as Array<[unknown]>)('%o → null', (input) => {
    expect(c(input)).toBeNull();
  });
});

describe('fallbackMaxTokens', () => {
  it('adds reasoning headroom only for providers whose cap includes thinking', () => {
    expect(routing.fallbackMaxTokens('google', 700, undefined)).toBe(8700);
    expect(routing.fallbackMaxTokens('anthropic', 1000, 2000)).toBe(3000);
    expect(routing.fallbackMaxTokens('deepseek', 700, undefined)).toBe(700);
    expect(routing.fallbackMaxTokens('google', undefined, undefined)).toBeUndefined();
    expect(routing.fallbackMaxTokens('google', 60_000, undefined)).toBe(64_000);
  });
});
