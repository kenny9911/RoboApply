// @vitest-environment node
// Brand LLM-route policy of the fit scorer (server/src/features/match/scorerRoute.ts; D5).
//
// This file used to drive the legacy V2 job routes (`POST /v2/jobs/:id/score`,
// `GET /v2/jobs/:id`) and the `legacyView.ts` helpers. Both were deleted in the
// integration wave (INT-13; wave5 WP-93 #44): the router sent the unstripped
// resume to the model and had no daily cap, and nothing called it. What stays
// are the route-policy checks that were asserted through `legacyAiGate`, now
// asserted directly on `defaultScorerRouteAllowed`. No network, no database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getBrand } from '../../platform/brand/registry.js';
import { defaultScorerRouteAllowed, prefixedProvider, scorerRoute } from './scorerRoute.js';

const INTL_MODEL = 'openrouter/openai/gpt-5.6-luna';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

describe('scorer route policy per brand (D5)', () => {
  const goapply = getBrand('goapply');
  const roboapply = getBrand('roboapply');
  /** The operator's opt-in wall: GoApply may use mainland model endpoints only. */
  const WALL = { CN_LLM_DOMESTIC_ONLY: 'true' };

  it('GoApply by default: the model RoboApply scores with is allowed, and so is a domestic one', async () => {
    expect(await defaultScorerRouteAllowed(goapply, INTL_MODEL, {})).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, INTL_MODEL, { LLM_PROVIDER: 'openrouter', LLM_MODEL: INTL_MODEL })).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, 'anthropic/claude-sonnet-4-6', {})).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, 'deepseek/deepseek-chat', {})).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, 'dashscope/qwen-max', {})).toBe(true);
    // An unprefixed id goes through the shared provider mode (OpenRouter when none is set), as for RoboApply.
    expect(await defaultScorerRouteAllowed(goapply, 'some-model', {})).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, 'some-model', { LLM_PROVIDER: 'openai' })).toBe(true);
    // GoApply may use a mainland provider that RoboApply may not.
    expect(await defaultScorerRouteAllowed(goapply, 'some-model', { LLM_PROVIDER: 'deepseek' })).toBe(true);
    expect(await defaultScorerRouteAllowed(roboapply, 'some-model', { LLM_PROVIDER: 'deepseek' })).toBe(false);
  });

  it('GoApply behind the wall (CN_LLM_DOMESTIC_ONLY): an international model is refused; a domestic one is allowed', async () => {
    expect(await defaultScorerRouteAllowed(goapply, INTL_MODEL, WALL)).toBe(false);
    expect(await defaultScorerRouteAllowed(goapply, 'some-model', WALL)).toBe(false);
    expect(await defaultScorerRouteAllowed(goapply, 'deepseek/deepseek-chat', WALL)).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, 'dashscope/qwen-max', WALL)).toBe(true);
    // 'qwen/…' is DashScope (mainland) on GoApply's own stack, so it is allowed there.
    expect(await defaultScorerRouteAllowed(goapply, 'qwen/qwen-max', { ...WALL, CN_LLM_PROVIDER: 'deepseek' })).toBe(true);
    // On the shared profile 'qwen/…' is an OpenRouter id: refused behind the wall.
    expect(await defaultScorerRouteAllowed(goapply, 'qwen/qwen-max', WALL)).toBe(false);
    expect(await defaultScorerRouteAllowed(goapply, 'deepseek-chat', { ...WALL, CN_LLM_PROVIDER: 'deepseek' })).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, INTL_MODEL, { CN_RESIDENCY_STRICT: 'true' })).toBe(false);
    // RoboApply is not behind GoApply's wall.
    expect(await defaultScorerRouteAllowed(roboapply, INTL_MODEL, WALL)).toBe(true);
  });

  it('GoApply on its own domestic stack: an unprefixed id needs a provider of its own (the shared provider mode is not borrowed)', async () => {
    // Its own default model, no provider of its own: a bare id has no route.
    expect(await defaultScorerRouteAllowed(goapply, 'some-model', { CN_LLM_MODEL: 'deepseek-chat', LLM_PROVIDER: 'openrouter' })).toBe(false);
    expect(await defaultScorerRouteAllowed(goapply, 'deepseek-chat', { CN_LLM_PROVIDER: 'deepseek' })).toBe(true);
    // A prefixed id still routes by its prefix, on any provider.
    expect(await defaultScorerRouteAllowed(goapply, INTL_MODEL, { CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat' })).toBe(true);
    expect(await defaultScorerRouteAllowed(goapply, 'qwen/qwen-max', { CN_LLM_PROVIDER: 'deepseek' })).toBe(true);
  });

  it('RoboApply: user data never resolves to a mainland endpoint', async () => {
    expect(await defaultScorerRouteAllowed(roboapply, INTL_MODEL, {})).toBe(true);
    expect(await defaultScorerRouteAllowed(roboapply, 'deepseek/deepseek-chat', {})).toBe(false);
    // On RoboApply 'qwen/…' is the OpenRouter vendor slug (providerPrefixes
    // DOMESTIC_ONLY_PREFIXES), as LLMService resolves it — not DashScope.
    expect(await defaultScorerRouteAllowed(roboapply, 'qwen/qwen3.8-flash', {})).toBe(true);
    // The unambiguous native spelling is still mainland on RoboApply.
    expect(await defaultScorerRouteAllowed(roboapply, 'dashscope/qwen-max', {})).toBe(false);
    // CN_ values are never read for RoboApply.
    expect(await defaultScorerRouteAllowed(roboapply, 'some-model', { CN_LLM_PROVIDER: 'deepseek', CN_LLM_MODEL: 'deepseek-chat' })).toBe(true);
  });

  it('scorerRoute resolves the prefix per LLM profile and reads the domestic base-URL variables', () => {
    expect(prefixedProvider('qwen/qwen3.8-flash')).toBeNull();
    expect(prefixedProvider('qwen/qwen3.8-flash', 'domestic_cn')).toBe('qwen');
    expect(prefixedProvider('dashscope/qwen-max')).toBe('qwen');
    expect(scorerRoute('qwen/qwen3.8-flash', 'openrouter', {}, 'global')).toMatchObject({ provider: 'openrouter' });
    const env = { DASHSCOPE_BASE_URL: 'https://gw.example.cn/v1', GLM_API_BASE_URL: 'https://glm.example.cn/v1', ARK_BASE_URL: 'https://ark.example.cn/v1' };
    expect(scorerRoute('qwen/qwen-max', null, env, 'domestic_cn')).toMatchObject({ provider: 'qwen', baseUrl: 'https://gw.example.cn/v1' });
    expect(scorerRoute('zhipu/glm-5', null, env, 'domestic_cn')).toMatchObject({ provider: 'glm', baseUrl: 'https://glm.example.cn/v1' });
    expect(scorerRoute('ark/doubao-pro', null, env, 'domestic_cn')).toMatchObject({ provider: 'doubao', baseUrl: 'https://ark.example.cn/v1' });
    // An unprefixed id: the provider mode; with none, OpenRouter on the global profile and no route on the domestic one.
    expect(scorerRoute('some-model', 'openai', {})).toMatchObject({ provider: 'openai', model: 'some-model' });
    expect(scorerRoute('some-model', null, {})).toMatchObject({ provider: 'openrouter' });
    expect(scorerRoute('some-model', null, {}, 'domestic_cn')).toMatchObject({ provider: '' });
    // 'direct' mode: a vendor/model id is OpenRouter's; a bare id follows the default model's prefix.
    expect(scorerRoute('meta/llama-4', 'direct', {})).toMatchObject({ provider: 'openrouter' });
    expect(scorerRoute('gpt-6-luna', 'direct', {}, 'global', 'openai/gpt-6')).toMatchObject({ provider: 'openai' });
    expect(scorerRoute('gpt-6-luna', 'direct', {})).toMatchObject({ provider: 'openrouter' });
  });
});

describe('the legacy job score/detail route is gone', () => {
  it.each([
    'roboapply/v2/routes/jobs.ts',
    'roboapply/v2/routes/jobs.score.test.ts',
    'features/match/legacyView.ts',
  ])('%s is deleted', (rel) => {
    expect(fs.existsSync(path.join(SRC, rel))).toBe(false);
  });
});
