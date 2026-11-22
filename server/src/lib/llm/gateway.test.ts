// @vitest-environment node
//
// The LLM gateway: named provider entries (gatewayProviders.ts), functionality
// areas assigned to them (llmStackConfigSchema.ts `routes`), and how an
// assignment reaches a call (llmModels.ts → providerPrefixes.ts →
// systemCredentials.ts → LLMService).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: {} as Record<string, string>, audits: [] as Array<Record<string, unknown>> }));
vi.mock('../prisma.js', () => {
  const prisma = {
    appConfig: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        db.rows[where.key] ? { key: where.key, value: db.rows[where.key], updatedAt: new Date('2026-11-22T00:00:00Z'), updatedBy: 'admin' } : null,
      ),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        db.rows[where.key] = create.value;
        return { key: where.key, value: create.value };
      }),
    },
    adminAdjustment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.audits.push(data);
        return data;
      }),
    },
  };
  return { prisma, default: prisma };
});
vi.mock('../../services/LoggerService.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), logLLMCall: vi.fn(), getRequestSnapshot: vi.fn() },
  generateRequestId: () => 'req_test',
}));

const prefixes = await import('../../services/llm/providerPrefixes.js');
const providers = await import('./gatewayProviders.js');
const admin = await import('./gatewayAdmin.js');
const models = await import('./llmModels.js');
const tasks = await import('./llmTaskSettings.js');
const resolver = await import('./llmStackConfigResolver.js');
const schema = await import('./llmStackConfigSchema.js');
const creds = await import('./systemCredentials.js');
const { checkLlmEgress } = await import('../../platform/llm/egressPolicy.js');
const { supportsToolStreaming } = await import('../../services/llm/toolStreaming.js');

const NAMES = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_MATCHING_MODEL', 'LLM_EXTRACT_MODEL', 'LLM_VISION_MODEL', 'LLM_EVALUATION', 'LLM_INTERVIEW_MODEL',
  'LLM_COPILOT_MODEL', 'RA_V2_CAREER_INSIGHT_MODEL', 'LLM_PROXY_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY',
  'CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_MATCHING_MODEL', 'CN_LLM_DOMESTIC_ONLY', 'CN_RESIDENCY_STRICT',
  'LLM_SETTINGS_DB_DISABLED', 'NODE_ENV', 'FIELD_ENCRYPTION_KEY', 'BRAND_LOCK', 'ALLOWED_BRANDS',
];
let saved: Record<string, string | undefined> = {};
const KEY = 'sk-test-1234567890abcdef';

async function warm(): Promise<void> {
  resolver.invalidateLlmStack();
  providers.invalidateGatewayProviders();
  await Promise.all([resolver.getLlmStack('roboapply'), resolver.getLlmStack('goapply'), providers.warmupGatewayProviders()]);
}

async function addProvider(input: Partial<Parameters<typeof providers.saveGatewayProvider>[0]> = {}) {
  return providers.saveGatewayProvider({ name: 'Aigw', type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: KEY, ...input }, 'admin_1');
}

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
  process.env.NODE_ENV = 'test';
  process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.LLM_PROVIDER = 'openrouter';
  process.env.LLM_MODEL = 'google/gemini-3.8-flash';
  process.env.LLM_MATCHING_MODEL = 'openrouter/openai/gpt-6-luna';
  db.rows = {};
  db.audits = [];
  resolver.invalidateLlmStack();
  providers.invalidateGatewayProviders();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('provider entry references', () => {
  it('reads `<type>@<entry>` as a routing prefix that pins the entry on every profile and mode', () => {
    expect(prefixes.resolveProviderPrefix('newapi@aigw')).toBe('newapi@aigw');
    expect(prefixes.resolveProviderPrefix('NewAPI@Aigw', 'domestic_cn')).toBe('newapi@aigw');
    expect(prefixes.resolveProviderPrefix('gemini@main')).toBe('google@main');
    expect(prefixes.splitSelectorPrefix('openrouter@backup/google/gemini-3')).toEqual({ providerType: 'openrouter@backup', model: 'google/gemini-3' });
    expect(prefixes.resolveSelectorRoute('newapi@aigw/gpt-6.1-sol', 'google')).toEqual({ providerType: 'newapi@aigw', model: 'gpt-6.1-sol' });
    expect(prefixes.qualifySelector('newapi@aigw/gpt-6.1-sol', 'direct', 'google/gemini-3')).toBe('newapi@aigw/gpt-6.1-sol');
  });

  it('refuses a reference with an unknown type or a malformed entry id', () => {
    expect(prefixes.resolveProviderPrefix('nosuch@aigw')).toBeNull();
    expect(prefixes.resolveProviderPrefix('newapi@')).toBeNull();
    expect(prefixes.resolveProviderPrefix('@aigw')).toBeNull();
    expect(prefixes.resolveProviderPrefix('newapi@a b')).toBeNull();
    expect(prefixes.resolveProviderPrefix('newapi@a@b')).toBeNull();
    // `qwen/` is not a routing prefix on the global profile, with or without an entry.
    expect(prefixes.resolveProviderPrefix('qwen@x')).toBeNull();
  });

  it('gives the base type and the entry id', () => {
    expect(prefixes.providerBaseType('newapi@aigw')).toBe('newapi');
    expect(prefixes.providerBaseType('OpenRouter')).toBe('openrouter');
    expect(prefixes.providerEntryId('newapi@aigw')).toBe('aigw');
    expect(prefixes.providerEntryId('newapi')).toBeNull();
    expect(prefixes.providerEntrySelector('newapi', 'aigw', 'gpt-6.1-sol')).toBe('newapi@aigw/gpt-6.1-sol');
    expect(supportsToolStreaming('newapi@aigw')).toBe(true);
    expect(supportsToolStreaming('google@main')).toBe(false);
  });
});

describe('provider entries', () => {
  it('saves an entry with an encrypted key and never returns or audits the key', async () => {
    const summary = await addProvider({ notes: 'Shared gateway' });
    expect(summary).toMatchObject({ id: 'aigw', name: 'Aigw', type: 'newapi', baseUrl: 'https://aigw.example.com/v1', enabled: true, hasKey: true, usable: true, keyUnreadable: false });
    expect(summary.keyPreview).toBe('sk-t…cdef');
    const row = db.rows['llm_providers.development'];
    expect(row).not.toContain(KEY);
    expect(JSON.stringify(summary)).not.toContain(KEY);
    expect(JSON.stringify(db.audits)).not.toContain(KEY);
    expect(db.audits[0]).toMatchObject({ type: 'llm_provider:development', adminId: 'admin_1' });
    expect(String(db.audits[0].newValue)).not.toContain('encryptedKey');
  });

  it('gives each entry its own id, and refuses a second entry with the same name', async () => {
    await addProvider();
    await expect(addProvider()).rejects.toMatchObject({ code: 'duplicate_name' });
    const second = await addProvider({ name: 'Aigw (backup)' });
    expect(second.id).toBe('aigw-backup');
    expect((await providers.listGatewayProviders()).map((p) => p.id)).toEqual(['aigw', 'aigw-backup']);
  });

  it('keeps the stored key on an update without one, but asks for it again when the endpoint host changes', async () => {
    await addProvider();
    const renamed = await providers.saveGatewayProvider({ id: 'aigw', name: 'Aigw EU', type: 'newapi', baseUrl: 'https://aigw.example.com/v1' }, 'admin_1');
    expect(renamed).toMatchObject({ id: 'aigw', name: 'Aigw EU', hasKey: true, usable: true });
    await expect(
      providers.saveGatewayProvider({ id: 'aigw', name: 'Aigw EU', type: 'newapi', baseUrl: 'https://other.example.net/v1' }, 'admin_1'),
    ).rejects.toMatchObject({ code: 'key_required_for_new_url' });
    const moved = await providers.saveGatewayProvider({ id: 'aigw', name: 'Aigw EU', type: 'newapi', baseUrl: 'https://other.example.net/v1', apiKey: 'sk-other-key-000000' }, 'admin_1');
    expect(moved.baseUrl).toBe('https://other.example.net/v1');
  });

  it('validates the name, the type, the key and the base URL', async () => {
    await expect(addProvider({ name: ' ' })).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(addProvider({ type: 'nosuch' })).rejects.toMatchObject({ code: 'invalid_type' });
    await expect(addProvider({ apiKey: '' })).rejects.toMatchObject({ code: 'key_required' });
    await expect(addProvider({ baseUrl: '' })).rejects.toMatchObject({ code: 'invalid_base_url' }); // newapi needs one
    await expect(addProvider({ baseUrl: 'https://aigw.example.com/v1/chat/completions' })).rejects.toMatchObject({ code: 'invalid_base_url' });
    // A vendor type may not point at a private host (SSRF), and may omit the URL.
    await expect(addProvider({ name: 'OpenAI', type: 'openai', baseUrl: 'https://169.254.169.254/v1' })).rejects.toMatchObject({ code: 'invalid_base_url' });
    const openai = await addProvider({ name: 'OpenAI', type: 'openai', baseUrl: '' });
    expect(openai).toMatchObject({ baseUrl: null, effectiveBaseUrl: 'https://api.openai.com/v1' });
  });

  it('reports a key that does not decrypt as unreadable and unusable, without throwing', async () => {
    await addProvider();
    process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(64);
    const cryptoMod = await import('../crypto.js');
    // lib/crypto caches its key; a different deployment key is a fresh process.
    vi.spyOn(cryptoMod, 'decryptField').mockImplementation(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    const [entry] = await providers.listGatewayProviders();
    expect(entry).toMatchObject({ hasKey: true, keyUnreadable: true, usable: false, keyPreview: '••••' });
    await providers.warmupGatewayProviders();
    expect(providers.getGatewayProviderSync('aigw')).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('model lists', () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init ?? {}));
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('lists an OpenAI-compatible provider with the key as a bearer token, sorted and deduplicated, following no redirect', async () => {
    const fetchMock = stubFetch(() => json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'claude-fable-5-2' }, { id: 'gpt-6.1-sol' }, { id: '' }, { nope: 1 }] }));
    const result = await providers.fetchProviderModels({ type: 'newapi', baseUrl: 'https://aigw.example.com/v1/', apiKey: KEY });
    expect(result).toMatchObject({ ok: true, models: ['claude-fable-5-2', 'gpt-6.1-sol'], truncated: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://aigw.example.com/v1/models');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('tries /v1/models when a base URL was entered without its version path', async () => {
    const fetchMock = stubFetch((url) => (url.endsWith('/v1/models') ? json({ data: [{ id: 'm1' }] }) : json({}, 404)));
    const result = await providers.fetchProviderModels({ type: 'newapi', baseUrl: 'https://aigw.example.com', apiKey: KEY });
    expect(result).toMatchObject({ ok: true, models: ['m1'] });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://aigw.example.com/models', 'https://aigw.example.com/v1/models']);
  });

  it('lists Google models that generate content, with the key in a header and not in the URL', async () => {
    const fetchMock = stubFetch(() =>
      json({ models: [
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
      ] }),
    );
    const result = await providers.fetchProviderModels({ type: 'google', apiKey: KEY });
    expect(result).toMatchObject({ ok: true, models: ['gemini-3.8-flash'] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
  });

  it('lists Anthropic models with its own headers', async () => {
    const fetchMock = stubFetch(() => json({ data: [{ id: 'claude-opus-5-5' }] }));
    const result = await providers.fetchProviderModels({ type: 'anthropic', apiKey: KEY });
    expect(result).toMatchObject({ ok: true, models: ['claude-opus-5-5'] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('answers a fixed code for each failure and never the provider error text', async () => {
    stubFetch(() => new Response('{"error":"secret upstream detail"}', { status: 401 }));
    const rejected = await providers.fetchProviderModels({ type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: KEY });
    expect(rejected).toMatchObject({ ok: false, code: 'auth_rejected', status: 401 });
    expect(JSON.stringify(rejected)).not.toContain('secret upstream detail');

    stubFetch(() => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    expect(await providers.fetchProviderModels({ type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: KEY })).toMatchObject({ ok: false, code: 'provider_error' });

    stubFetch(() => new Response('<html>', { status: 200 }));
    expect(await providers.fetchProviderModels({ type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: KEY })).toMatchObject({ ok: false, code: 'invalid_response' });

    stubFetch(() => json({ data: [] }, 429));
    expect(await providers.fetchProviderModels({ type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: KEY })).toMatchObject({ ok: false, code: 'rate_limited' });

    const none = stubFetch(() => json({ data: [] }));
    expect(await providers.fetchProviderModels({ type: 'openai', baseUrl: 'https://10.0.0.8/v1', apiKey: KEY })).toMatchObject({ ok: false, code: 'invalid_base_url' });
    expect(await providers.fetchProviderModels({ type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: ' ' })).toMatchObject({ ok: false, code: 'key_required' });
    expect(none).not.toHaveBeenCalled();
  });

  it('saves the fetched list with the entry, and drops it when the key is replaced', async () => {
    await addProvider();
    stubFetch(() => json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gemini-3.8-flash' }] }));
    const { result, provider } = await providers.refreshGatewayProviderModels('aigw', 'admin_1');
    expect(result.ok).toBe(true);
    expect(provider.models).toEqual(['gemini-3.8-flash', 'gpt-6.1-sol']);
    expect(provider.modelsFetchedAt).toBeTruthy();
    expect((await providers.listGatewayProviders())[0].models).toHaveLength(2);
    const rekeyed = await providers.saveGatewayProvider({ id: 'aigw', name: 'Aigw', type: 'newapi', baseUrl: 'https://aigw.example.com/v1', apiKey: 'sk-new-key-99999999' }, 'admin_1');
    expect(rekeyed.models).toEqual([]);
  });
});

describe('areas', () => {
  it('every area key is a model key, and no key is in two areas', () => {
    const all = schema.LLM_AREAS.flatMap((a) => schema.AREA_MODEL_KEYS[a]);
    expect(new Set(all).size).toBe(all.length);
    const known = new Set<string>(['defaultModel', 'fallbackModel', ...schema.PURPOSE_KEYS]);
    for (const key of all) expect(known.has(key), key).toBe(true);
    // The voice interview model is not assignable: LiveKit accepts a fixed list.
    expect(schema.areaOfModelKey('interview')).toBeNull();
    expect(schema.areaOfModelKey('matching')).toBe('matchResume');
  });

  it('a blob saved before the gateway existed parses with every area unassigned', () => {
    const blob = schema.parseLlmStackBlob(JSON.stringify({ provider: null, defaultModel: 'x/y', fallbackModel: null, purposes: {}, tuning: {} }));
    expect(blob?.routes).toEqual(schema.emptyRoutes());
    expect(blob?.defaultModel).toBe('x/y');
  });

  it('an assigned area sets every key it owns to its provider entry and model; other keys are untouched', async () => {
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', { matchResume: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    await warm();
    for (const key of schema.AREA_MODEL_KEYS.matchResume) {
      expect(models.getModelSetting(key, 'roboapply'), key).toBe('newapi@aigw/gpt-6.1-sol');
    }
    expect(models.resolveModelKey('matching', 'roboapply')).toMatchObject({ source: 'override', env: 'openrouter/openai/gpt-6-luna' });
    expect(models.getModelSetting('extract', 'roboapply')).toBeUndefined();
    expect(models.getDefaultModel('roboapply')).toBe('google/gemini-3.8-flash');
  });

  it('the Default area is the default model, so every unset key ends on it', async () => {
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', { default: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    await warm();
    expect(models.getDefaultModel('roboapply')).toBe('newapi@aigw/gpt-6.1-sol');
    expect(tasks.getTaskModelOrDefault('writing', 'roboapply')).toBe('newapi@aigw/gpt-6.1-sol');
    // A key with an env value of its own keeps it: only its own area overrides it.
    expect(models.getModelSetting('matching', 'roboapply')).toBe('openrouter/openai/gpt-6-luna');
  });

  it('Visual, Evaluation and Insights fall back to what served them before the areas existed', async () => {
    process.env.LLM_EXTRACT_MODEL = 'google/gemini-3.8-flash';
    process.env.LLM_INTERVIEW_MODEL = 'openai/gpt-6-luna';
    expect(tasks.getVisionModel('roboapply')).toBe('google/gemini-3.8-flash');
    expect(tasks.getEvaluationModel('roboapply')).toBe('openai/gpt-6-luna');
    expect(tasks.getInsightsModel('roboapply')).toBeUndefined();
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', {
      visual: { providerId: 'aigw', model: 'vision-1' },
      evaluation: { providerId: 'aigw', model: 'eval-1' },
      insights: { providerId: 'aigw', model: 'insight-1' },
    }, 'admin_1');
    await warm();
    expect(tasks.getVisionModel('roboapply')).toBe('newapi@aigw/vision-1');
    expect(tasks.getEvaluationModel('roboapply')).toBe('newapi@aigw/eval-1');
    expect(tasks.getInsightsModel('roboapply')).toBe('newapi@aigw/insight-1');
    // Parsing text and the live interview are not moved by those three areas.
    expect(tasks.getTaskModel('extract', 'roboapply')).toBe('google/gemini-3.8-flash');
    expect(tasks.getTaskModel('interview', 'roboapply')).toBe('openai/gpt-6-luna');
  });

  it('an area whose entry is disabled or removed resolves as if it were not assigned', async () => {
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', { matchResume: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    await providers.saveGatewayProvider({ id: 'aigw', name: 'Aigw', type: 'newapi', baseUrl: 'https://aigw.example.com/v1', enabled: false }, 'admin_1');
    await warm();
    expect(models.getModelSetting('matching', 'roboapply')).toBe('openrouter/openai/gpt-6-luna');
    const overview = await admin.getGatewayOverview('roboapply');
    expect(overview.areas.find((a) => a.area === 'matchResume')).toMatchObject({ routeStatus: 'provider_disabled' });
  });

  it('LLM_SETTINGS_DB_DISABLED ignores every assignment', async () => {
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', { matchResume: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    await warm();
    process.env.LLM_SETTINGS_DB_DISABLED = 'true';
    expect(models.getModelSetting('matching', 'roboapply')).toBe('openrouter/openai/gpt-6-luna');
  });

  it('GoApply uses the shared assignment, its own when it has one, and none of the shared ones behind the domestic-only wall', async () => {
    await addProvider();
    await addProvider({ name: 'CN gateway', baseUrl: 'https://llm.example.cn/v1' });
    await admin.saveGatewayRoutes('roboapply', { matchResume: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    await warm();
    expect(models.getModelSetting('matching', 'goapply')).toBe('newapi@aigw/gpt-6.1-sol');
    expect(models.resolveModelKey('matching', 'goapply').source).toBe('shared');

    await admin.saveGatewayRoutes('goapply', { matchResume: { providerId: 'cn-gateway', model: 'qwen-max' } }, 'admin_1');
    await warm();
    expect(models.getModelSetting('matching', 'goapply')).toBe('newapi@cn-gateway/qwen-max');
    expect(models.getModelSetting('matching', 'roboapply')).toBe('newapi@aigw/gpt-6.1-sol');

    await admin.saveGatewayRoutes('goapply', { matchResume: null }, 'admin_1');
    await warm();
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    expect(models.getModelSetting('matching', 'goapply')).toBeUndefined();
    expect(models.resolveModelKey('matching', 'goapply').sharedWalledOff).toBe('newapi@aigw/gpt-6.1-sol');
  });

  it('refuses an unknown area, an unknown provider, and a provider that cannot stream tools for the Assistant', async () => {
    await addProvider();
    await addProvider({ name: 'Gemini', type: 'google', baseUrl: '' });
    await expect(admin.saveGatewayRoutes('roboapply', { nosuch: null }, 'admin_1')).rejects.toMatchObject({ code: 'invalid_area' });
    await expect(admin.saveGatewayRoutes('roboapply', { default: { providerId: 'gone', model: 'm' } }, 'admin_1')).rejects.toMatchObject({ code: 'unknown_provider' });
    await expect(admin.saveGatewayRoutes('roboapply', { default: { providerId: 'aigw', model: ' ' } }, 'admin_1')).rejects.toMatchObject({ code: 'invalid_route' });
    await expect(admin.saveGatewayRoutes('roboapply', { assistant: { providerId: 'gemini', model: 'gemini-3.8-flash' } }, 'admin_1')).rejects.toMatchObject({ code: 'tools_unsupported' });
    await admin.saveGatewayRoutes('roboapply', { assistant: { providerId: 'aigw', model: 'gpt-6.1-sol' }, visual: { providerId: 'gemini', model: 'gemini-3.8-flash' } }, 'admin_1');
    await warm();
    expect(models.getModelSetting('copilot', 'roboapply')).toBe('newapi@aigw/gpt-6.1-sol');
    expect(models.getModelSetting('vision', 'roboapply')).toBe('google@gemini/gemini-3.8-flash');
  });

  it('keeps per-key overrides and tuning of the blob when assignments are saved', async () => {
    const blob = { ...schema.emptyLlmStackBlob(), fallbackModel: 'deepseek/deepseek-v4-flash', tuning: { ...schema.emptyTuning(), timeoutMs: 90000 } };
    await resolver.saveLlmStack('development', blob, 'admin_1', 'seed');
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', { insights: { providerId: 'aigw', model: 'm' } }, 'admin_1');
    const { blob: after } = await resolver.getLlmStackForEnvironment('development');
    expect(after.fallbackModel).toBe('deepseek/deepseek-v4-flash');
    expect(after.tuning.timeoutMs).toBe(90000);
    expect(after.routes.insights).toEqual({ providerId: 'aigw', model: 'm' });
  });

  it('does not remove a provider an area of either brand is assigned to', async () => {
    await addProvider();
    await admin.saveGatewayRoutes('goapply', { writing: { providerId: 'aigw', model: 'm' } }, 'admin_1');
    await expect(admin.removeGatewayProvider('aigw', 'admin_1')).rejects.toMatchObject({ code: 'provider_in_use', detail: { areas: [{ brand: 'goapply', area: 'writing' }] } });
    await admin.saveGatewayRoutes('goapply', { writing: null }, 'admin_1');
    await admin.removeGatewayProvider('aigw', 'admin_1');
    expect(await providers.listGatewayProviders()).toEqual([]);
  });

  it('the overview names what every area resolves to and where it comes from', async () => {
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', { parseResume: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    const overview = await admin.getGatewayOverview('roboapply');
    expect(overview).toMatchObject({ environment: 'development', brand: 'roboapply', dbDisabled: false, encryptionReady: true, defaultModel: 'google/gemini-3.8-flash' });
    expect(overview.areas.map((a) => a.area)).toEqual([...schema.LLM_AREAS]);
    const parse = overview.areas.find((a) => a.area === 'parseResume')!;
    expect(parse).toMatchObject({ route: { providerId: 'aigw', model: 'gpt-6.1-sol' }, routeStatus: 'ok', modelListed: null });
    expect(parse.keys[0]).toMatchObject({ key: 'extract', source: 'override', providerId: 'aigw', providerType: 'newapi', model: 'gpt-6.1-sol', envName: 'LLM_EXTRACT_MODEL' });
    const match = overview.areas.find((a) => a.area === 'matchResume')!;
    expect(match).toMatchObject({ route: null, routeStatus: null });
    expect(match.keys[0]).toMatchObject({ key: 'matching', source: 'env', providerId: null, providerType: 'openrouter', model: 'openai/gpt-6-luna' });
    expect(overview.areas.find((a) => a.area === 'assistant')?.needsTools).toBe(true);
    expect(overview.providerTypes.find((t) => t.type === 'google')).toMatchObject({ tools: false, baseUrl: 'optional' });
    expect(JSON.stringify(overview)).not.toContain(KEY);
  });
});

describe('credentials and policy of a provider entry', () => {
  it('resolves the entry key and base URL, and never the type key, an env proxy URL or the proxy secret', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-openai';
    process.env.OPENAI_BASE_URL = 'https://proxy.internal.example/v1';
    process.env.LLM_PROXY_KEY = 'proxy-secret';
    await addProvider({ name: 'OpenAI two', type: 'openai', baseUrl: '' });
    await warm();
    const cred = creds.resolveProviderCredential('openai@openai-two');
    expect(cred).toMatchObject({ apiKey: KEY, baseUrl: 'https://api.openai.com/v1', source: 'gateway' });
    expect(cred.tuning.proxyKey).toBe('');
    // The plain type still resolves as before.
    expect(creds.resolveProviderCredential('openai')).toMatchObject({ apiKey: 'sk-env-openai', baseUrl: 'https://proxy.internal.example/v1', source: 'env' });
  });

  it('a call for an assigned area goes to the entry endpoint with the entry key, and without the proxy secret', async () => {
    process.env.LLM_PROXY_KEY = 'proxy-secret';
    await addProvider();
    await admin.saveGatewayRoutes('roboapply', { insights: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    await warm();
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const req = url instanceof Request ? url : new Request(String(url), init);
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) as Record<string, unknown> });
      return new Response(
        JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'gpt-6.1-sol', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
    const { llmService } = await import('../../services/llm/LLMService.js');
    const result = await llmService.chatWithUsage([{ role: 'user', content: 'ping' }], { model: tasks.getInsightsModel('roboapply'), brand: 'roboapply' });
    expect(result.content).toBe('pong');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://aigw.example.com/v1/chat/completions');
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(requests[0].headers.get('x-proxy-key')).toBeNull();
    expect(requests[0].body.model).toBe('gpt-6.1-sol');
    // The route as the service explains it: the entry, its host, a key, allowed.
    await admin.saveGatewayRoutes('roboapply', { matchResume: { providerId: 'aigw', model: 'gpt-6.1-sol' } }, 'admin_1');
    await warm();
    expect(llmService.explainRoute('matching', 'roboapply')).toMatchObject({
      selector: 'newapi@aigw/gpt-6.1-sol', providerType: 'newapi@aigw', model: 'gpt-6.1-sol', host: 'aigw.example.com', hasKey: true, allowed: true, toolsSupported: true,
    });
  });

  it('an entry that does not exist, or of another type, has no key', async () => {
    await addProvider();
    await warm();
    expect(creds.resolveProviderCredential('newapi@gone').apiKey).toBe('');
    expect(creds.resolveProviderCredential('openai@aigw').apiKey).toBe('');
    expect(creds.resolveProviderCredential('newapi@aigw').apiKey).toBe(KEY);
  });

  it('is judged on its own host: RoboApply user data never goes to an entry on a mainland endpoint', async () => {
    await addProvider({ name: 'CN gateway', baseUrl: 'https://api.deepseek.com/v1' });
    await addProvider();
    await warm();
    const cn = creds.resolveProviderCredential('newapi@cn-gateway');
    expect(checkLlmEgress({ brand: 'roboapply', provider: 'newapi@cn-gateway', credentialBaseUrl: cn.baseUrl })).toMatchObject({ allowed: false, code: 'mainland_endpoint_for_intl', host: 'api.deepseek.com' });
    const ok = creds.resolveProviderCredential('newapi@aigw');
    expect(checkLlmEgress({ brand: 'roboapply', provider: 'newapi@aigw', credentialBaseUrl: ok.baseUrl })).toMatchObject({ allowed: true, host: 'aigw.example.com' });
    // Behind GoApply's wall a gateway entry is allowed only on an allowlisted mainland host.
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    expect(checkLlmEgress({ brand: 'goapply', provider: 'newapi@aigw', credentialBaseUrl: ok.baseUrl })).toMatchObject({ allowed: false, code: 'newapi_host_not_allowlisted' });
    expect(checkLlmEgress({ brand: 'goapply', provider: 'newapi@cn-gateway', credentialBaseUrl: cn.baseUrl })).toMatchObject({ allowed: true });
  });
});
