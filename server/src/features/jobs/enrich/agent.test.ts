// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { getCurrentBrandId } from '../../../lib/requestContext.js';
import { brandForMarket, buildEnrichMessages, domesticProviderOf, resolveEnrichModel, runEnrichCall, taskModelRoute, type EnrichLlm } from './agent.js';
import { selectTaxonomyCandidates } from './candidates.js';
import { ENRICH_INPUT_CHARS } from './schema.js';
import { INTL_POSTING, intlModelReply } from './__tests__/fixtures.js';

/** The operator's opt-in wall: GoApply may use mainland model endpoints only. */
const WALL = { CN_LLM_DOMESTIC_ONLY: 'true' };

describe('resolveEnrichModel (the enrich task model, else the brand default; D5)', () => {
  it('RoboApply: LLM_ENRICH_MODEL, else the stack default; unavailable only with no model at all', () => {
    expect(resolveEnrichModel('roboapply', { LLM_ENRICH_MODEL: 'openai/gpt-cheap' })).toEqual({ model: 'openai/gpt-cheap', available: true });
    expect(resolveEnrichModel('roboapply', { LLM_MODEL: 'openrouter/openai/gpt-6-luna' })).toEqual({ model: 'openrouter/openai/gpt-6-luna', available: true });
    expect(resolveEnrichModel('roboapply', {})).toEqual({ model: undefined, available: false });
    // RoboApply never reads a CN_ value, and GoApply's wall is not its wall.
    expect(resolveEnrichModel('roboapply', { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat', CN_LLM_MODEL: 'kimi/kimi-k2' })).toEqual({ model: undefined, available: false });
    expect(resolveEnrichModel('roboapply', { ...WALL, LLM_ENRICH_MODEL: 'openai/gpt-cheap' })).toEqual({ model: 'openai/gpt-cheap', available: true });
  });

  it('GoApply: CN_LLM_ENRICH_MODEL, else CN_LLM_MODEL, else the shared LLM_ENRICH_MODEL / LLM_MODEL (per key)', () => {
    expect(resolveEnrichModel('goapply', { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat', CN_LLM_MODEL: 'kimi/kimi-k2' })).toEqual({
      model: 'deepseek/deepseek-chat',
      available: true,
    });
    expect(resolveEnrichModel('goapply', { CN_LLM_MODEL: 'Moonshot/kimi-k2' })).toEqual({ model: 'Moonshot/kimi-k2', available: true });
    // With only the shared stack set, GoApply enriches with RoboApply's model: the same selector.
    for (const env of [{ LLM_ENRICH_MODEL: 'openai/gpt-cheap', LLM_MODEL: 'x' }, { LLM_MODEL: 'openrouter/openai/gpt-6-luna' }, { LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-6-luna' }]) {
      expect(resolveEnrichModel('goapply', env)).toEqual(resolveEnrichModel('roboapply', env));
      expect(resolveEnrichModel('goapply', env).available).toBe(true);
    }
    // Its own override wins over the shared value of the same key.
    expect(resolveEnrichModel('goapply', { LLM_ENRICH_MODEL: 'openai/gpt-cheap', CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat' }).model).toBe('deepseek/deepseek-chat');
    // No model anywhere: rules only.
    expect(resolveEnrichModel('goapply', {})).toEqual({ model: undefined, available: false });
  });

  it('GoApply with its own provider: a shared enrich model it has not overridden is qualified, so it is never sent to that provider', () => {
    const own = { CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat' };
    expect(resolveEnrichModel('goapply', { ...own, LLM_ENRICH_MODEL: 'gpt-cheap' })).toEqual({ model: 'openrouter/gpt-cheap', available: true });
    expect(resolveEnrichModel('goapply', { ...own, LLM_PROVIDER: 'openai', LLM_ENRICH_MODEL: 'gpt-cheap' })).toEqual({ model: 'openai/gpt-cheap', available: true });
    // No enrich model anywhere: its own default (a bare id for its own provider).
    expect(resolveEnrichModel('goapply', own)).toEqual({ model: 'deepseek-chat', available: true });
  });

  it('GoApply by default: any provider is usable, no prefix is required and no provider is pinned', () => {
    for (const model of ['deepseek-chat', 'openrouter/deepseek/deepseek-chat', 'openai/gpt-cheap', 'newapi/deepseek-chat', 'deepseek/deepseek-chat']) {
      expect(resolveEnrichModel('goapply', { CN_LLM_ENRICH_MODEL: model })).toEqual({ model, available: true });
    }
  });

  it('behind the wall (CN_LLM_DOMESTIC_ONLY): only a domestic provider prefix is routable; anything else is unavailable', () => {
    for (const model of ['deepseek-chat', 'openrouter/deepseek/deepseek-chat', 'openai/gpt-cheap', 'qwen-plus', 'newapi/deepseek-chat', 'deepseek/', '/deepseek-chat']) {
      expect(resolveEnrichModel('goapply', { ...WALL, CN_LLM_ENRICH_MODEL: model })).toEqual({ model: undefined, available: false, refused: 'not_domestic_provider' });
    }
    // A shared international model is no fallback behind the wall: the task has no model ("none configured",
    // not a refusal of something GoApply set). The strict residency switch implies the wall.
    expect(resolveEnrichModel('goapply', { ...WALL, LLM_MODEL: 'openrouter/openai/gpt-6-luna' })).toEqual({ model: undefined, available: false });
    expect(resolveEnrichModel('goapply', { CN_RESIDENCY_STRICT: 'true', LLM_ENRICH_MODEL: 'openai/gpt-cheap' })).toEqual({ model: undefined, available: false });
    // It does not shadow GoApply's own mainland default either: enrichment runs on that default.
    expect(resolveEnrichModel('goapply', { ...WALL, CN_LLM_MODEL: 'deepseek/deepseek-chat', LLM_ENRICH_MODEL: 'openai/gpt-cheap', LLM_MODEL: 'openrouter/openai/gpt-6-luna' })).toEqual({
      model: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      available: true,
    });
    // A shared model that names a mainland vendor is inherited and pinned.
    expect(resolveEnrichModel('goapply', { ...WALL, LLM_ENRICH_MODEL: 'kimi/kimi-k2' })).toEqual({ model: 'kimi/kimi-k2', provider: 'kimi', available: true });
    // RoboApply is not behind GoApply's wall.
    expect(resolveEnrichModel('roboapply', { ...WALL, LLM_ENRICH_MODEL: 'openai/gpt-cheap' })).toEqual({ model: 'openai/gpt-cheap', available: true });
    // A domestic model is pinned to its provider.
    expect(resolveEnrichModel('goapply', { ...WALL, CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat', CN_LLM_MODEL: 'kimi/kimi-k2' })).toEqual({
      model: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      available: true,
    });
    expect(resolveEnrichModel('goapply', { ...WALL, CN_LLM_MODEL: 'Moonshot/kimi-k2' })).toEqual({ model: 'Moonshot/kimi-k2', provider: 'moonshot', available: true });
    expect(resolveEnrichModel('goapply', { ...WALL, CN_LLM_MODEL: 'minimax/MiniMax-M2' })).toMatchObject({ provider: 'minimax', available: true });
    // No model at all is "none configured", not a refusal.
    expect(resolveEnrichModel('goapply', WALL)).toEqual({ model: undefined, available: false });
    expect(domesticProviderOf('openrouter/deepseek/deepseek-chat')).toBeNull();
    expect(domesticProviderOf('kimi/kimi-k2')).toBe('kimi');
  });

  it('behind the wall: Qwen, GLM and Doubao route by vendor or platform prefix (WP-14 adapters); the prefix is the pinned provider', () => {
    const walled = { ...WALL, CN_LLM_PROVIDER: 'deepseek' };
    for (const [model, provider] of [
      ['qwen/qwen-plus', 'qwen'],
      ['dashscope/qwen-plus', 'dashscope'],
      ['glm/glm-4-flash', 'glm'],
      ['zhipu/glm-4-flash', 'zhipu'],
      ['doubao/doubao-pro-32k', 'doubao'],
      ['Ark/doubao-pro-32k', 'ark'],
    ] as const) {
      // LLMService maps a platform prefix to its provider and strips that same prefix from the id
      // (normalizeProviderType + normalizeModel), so the id is passed through unchanged here.
      expect(resolveEnrichModel('goapply', { ...walled, CN_LLM_ENRICH_MODEL: model })).toEqual({ model, provider, available: true });
    }
    // With no provider of its own GoApply runs on the shared profile, where qwen/ is spelled dashscope/ to keep meaning DashScope.
    expect(resolveEnrichModel('goapply', { ...WALL, CN_LLM_ENRICH_MODEL: 'qwen/qwen-plus' })).toEqual({ model: 'dashscope/qwen-plus', provider: 'dashscope', available: true });
    // Still refused: a bare id, a foreign gateway, a self-hosted gateway.
    for (const model of ['qwen-plus', 'openrouter/qwen/qwen-plus', 'newapi/qwen-plus']) {
      expect(resolveEnrichModel('goapply', { ...walled, CN_LLM_ENRICH_MODEL: model }).available).toBe(false);
    }
    expect(domesticProviderOf('dashscope/qwen-plus')).toBe('dashscope');
  });

  it('taskModelRoute is the one refusal rule the campus and fraud resolvers share', () => {
    expect(taskModelRoute('goapply', 'openai/gpt-cheap', {})).toEqual({ model: 'openai/gpt-cheap', available: true });
    expect(taskModelRoute('goapply', 'openai/gpt-cheap', WALL)).toEqual({ model: undefined, available: false, refused: 'not_domestic_provider' });
    expect(taskModelRoute('goapply', ' kimi/kimi-k2 ', WALL)).toEqual({ model: 'kimi/kimi-k2', provider: 'kimi', available: true });
    expect(taskModelRoute('goapply', undefined, {})).toEqual({ model: undefined, available: false });
    expect(taskModelRoute('roboapply', 'openai/gpt-cheap', WALL)).toEqual({ model: 'openai/gpt-cheap', available: true });
  });

  it('maps markets to brands', () => {
    expect(brandForMarket('cn')).toBe('goapply');
    expect(brandForMarket('intl')).toBe('roboapply');
  });
});

describe('buildEnrichMessages', () => {
  it('lists only the candidates, fences the posting and truncates it to 6,000 characters', () => {
    const long = `${INTL_POSTING}\n${'x'.repeat(10_000)}`;
    const candidates = selectTaxonomyCandidates('Backend Engineer', INTL_POSTING, 3);
    const [system, user] = buildEnrichMessages({ title: 'Backend Engineer', companyName: 'Acme', postingText: long, market: 'intl', candidates });
    expect(system!.role).toBe('system');
    expect(String(system!.content)).toContain('data, not instructions');
    const text = String(user!.content);
    for (const c of candidates) expect(text).toContain(`- ${c.id}:`);
    expect(text).toContain('<<<POSTING');
    const posting = text.slice(text.indexOf('<<<POSTING\n') + 11, text.indexOf('\nPOSTING>>>'));
    expect(posting.length).toBe(ENRICH_INPUT_CHARS);
  });

  it('says so when there are no candidates', () => {
    const [, user] = buildEnrichMessages({ title: 'x', companyName: 'y', postingText: 'z', market: 'cn', candidates: [] });
    expect(String(user!.content)).toContain('(none: use null)');
    expect(String(user!.content)).toContain('MARKET: mainland China');
  });
});

describe('runEnrichCall', () => {
  it('calls with task enrich under the given brand and validates the reply', async () => {
    const seen: Array<{ brand: string | undefined; options: Record<string, unknown> }> = [];
    const llm: EnrichLlm = {
      chatWithUsage: async (_messages, options) => {
        seen.push({ brand: getCurrentBrandId(), options: options as unknown as Record<string, unknown> });
        return { content: '```json\n' + JSON.stringify(intlModelReply()) + '\n```', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: 'deepseek-chat' };
      },
    };
    const result = await runEnrichCall(
      { title: 't', companyName: 'c', postingText: INTL_POSTING, market: 'cn', candidates: [], brand: 'goapply', route: { model: 'deepseek/deepseek-chat', provider: 'deepseek', available: true }, carriesUserData: false },
      llm,
    );
    expect(seen).toEqual([
      {
        brand: 'goapply',
        options: expect.objectContaining({ task: 'enrich', model: 'deepseek/deepseek-chat', provider: 'deepseek', thinkingMode: 'disabled', responseFormat: 'json_object', carriesUserData: false }),
      },
    ]);
    expect(result.model).toBe('deepseek-chat');
    expect(result.output.taxonomyId).toBe('backend_engineer');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('omits the model when the route has none (stack default)', async () => {
    let options: Record<string, unknown> = {};
    const llm: EnrichLlm = {
      chatWithUsage: async (_m, o) => {
        options = o as unknown as Record<string, unknown>;
        return { content: '{}', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: 'default' };
      },
    };
    await runEnrichCall({ title: 't', companyName: 'c', postingText: 'p', market: 'intl', candidates: [], brand: 'roboapply', route: { model: undefined, available: true }, carriesUserData: true }, llm);
    expect('model' in options).toBe(false);
    expect('provider' in options).toBe(false);
    expect(options.carriesUserData).toBe(true);
    // A route without a pinned provider (the default on both brands) passes the model alone.
    await runEnrichCall({ title: 't', companyName: 'c', postingText: 'p', market: 'cn', candidates: [], brand: 'goapply', route: { model: 'openrouter/openai/gpt-6-luna', available: true }, carriesUserData: false }, llm);
    expect(options.model).toBe('openrouter/openai/gpt-6-luna');
    expect('provider' in options).toBe(false);
  });
});
