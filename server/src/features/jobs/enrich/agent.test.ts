// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { getCurrentBrandId } from '../../../lib/requestContext.js';
import { brandForMarket, buildEnrichMessages, domesticProviderOf, resolveEnrichModel, runEnrichCall, type EnrichLlm } from './agent.js';
import { selectTaxonomyCandidates } from './candidates.js';
import { ENRICH_INPUT_CHARS } from './schema.js';
import { INTL_POSTING, intlModelReply } from './__tests__/fixtures.js';

describe('resolveEnrichModel (R-03 / R-13)', () => {
  it('RoboApply: LLM_ENRICH_MODEL, else the stack default', () => {
    expect(resolveEnrichModel('roboapply', { LLM_ENRICH_MODEL: 'openai/gpt-cheap' })).toEqual({ model: 'openai/gpt-cheap', available: true });
    expect(resolveEnrichModel('roboapply', {})).toEqual({ model: undefined, available: true });
  });

  it('GoApply: CN_LLM_ENRICH_MODEL, else CN_LLM_MODEL, never an unprefixed key', () => {
    expect(resolveEnrichModel('goapply', { CN_LLM_ENRICH_MODEL: 'deepseek/deepseek-chat', CN_LLM_MODEL: 'kimi/kimi-k2' })).toEqual({
      model: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      available: true,
    });
    expect(resolveEnrichModel('goapply', { CN_LLM_MODEL: 'Moonshot/kimi-k2' })).toEqual({ model: 'Moonshot/kimi-k2', provider: 'moonshot', available: true });
    expect(resolveEnrichModel('goapply', { CN_LLM_MODEL: 'minimax/MiniMax-M2' })).toMatchObject({ provider: 'minimax', available: true });
    expect(resolveEnrichModel('goapply', { LLM_ENRICH_MODEL: 'openai/gpt-cheap', LLM_MODEL: 'x' })).toEqual({ model: undefined, available: false });
  });

  it('GoApply: only a domestic provider prefix is routable (R-13); anything else is unavailable', () => {
    for (const model of ['deepseek-chat', 'openrouter/deepseek/deepseek-chat', 'openai/gpt-cheap', 'qwen-plus', 'newapi/deepseek-chat', 'deepseek/', '/deepseek-chat']) {
      expect(resolveEnrichModel('goapply', { CN_LLM_ENRICH_MODEL: model })).toEqual({ model: undefined, available: false, refused: 'not_domestic_provider' });
    }
    expect(domesticProviderOf('openrouter/deepseek/deepseek-chat')).toBeNull();
    expect(domesticProviderOf('kimi/kimi-k2')).toBe('kimi');
  });

  it('GoApply: Qwen, GLM and Doubao route by vendor or platform prefix (WP-14 adapters); the prefix is the pinned provider', () => {
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
      expect(resolveEnrichModel('goapply', { CN_LLM_ENRICH_MODEL: model })).toEqual({ model, provider, available: true });
    }
    // Still refused: a bare id, a foreign gateway, a self-hosted gateway.
    for (const model of ['qwen-plus', 'openrouter/qwen/qwen-plus', 'newapi/qwen-plus']) {
      expect(resolveEnrichModel('goapply', { CN_LLM_ENRICH_MODEL: model }).available).toBe(false);
    }
    expect(domesticProviderOf('dashscope/qwen-plus')).toBe('dashscope');
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
  });
});
