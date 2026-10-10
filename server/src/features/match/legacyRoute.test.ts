// @vitest-environment node
// Brand LLM-route policy of the fit scorer (server/src/features/match/scorerRoute.ts, R-13).
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

describe('scorer route policy per brand (R-13)', () => {
  const goapply = getBrand('goapply');
  const roboapply = getBrand('roboapply');

  it('GoApply: an international model is refused; a domestic one is allowed', async () => {
    expect(await defaultScorerRouteAllowed(goapply, INTL_MODEL, {})).toBe(false);
    expect(await defaultScorerRouteAllowed(goapply, 'deepseek/deepseek-chat', {})).toBe(true);
    // Since WP-14, 'qwen/…' routes to DashScope (mainland) on GoApply, so it is allowed there.
    expect(await defaultScorerRouteAllowed(goapply, 'qwen/qwen-max', {})).toBe(true);
  });

  it('GoApply: an unprefixed model with no CN_LLM_PROVIDER fails closed (no fallback to the global provider, R-03)', async () => {
    expect(await defaultScorerRouteAllowed(goapply, 'some-model', { LLM_PROVIDER: 'deepseek' })).toBe(false);
    expect(await defaultScorerRouteAllowed(goapply, 'deepseek-chat', { CN_LLM_PROVIDER: 'deepseek' })).toBe(true);
  });

  it('RoboApply: user data never resolves to a mainland endpoint', async () => {
    expect(await defaultScorerRouteAllowed(roboapply, INTL_MODEL, {})).toBe(true);
    expect(await defaultScorerRouteAllowed(roboapply, 'deepseek/deepseek-chat', {})).toBe(false);
    // On RoboApply 'qwen/…' is the OpenRouter vendor slug (providerPrefixes
    // DOMESTIC_ONLY_PREFIXES), as LLMService resolves it — not DashScope.
    expect(await defaultScorerRouteAllowed(roboapply, 'qwen/qwen3.8-flash', {})).toBe(true);
    // The unambiguous native spelling is still mainland on RoboApply.
    expect(await defaultScorerRouteAllowed(roboapply, 'dashscope/qwen-max', {})).toBe(false);
  });

  it('scorerRoute resolves the prefix per brand profile and reads the domestic base-URL variables', () => {
    expect(prefixedProvider('qwen/qwen3.8-flash')).toBeNull();
    expect(prefixedProvider('qwen/qwen3.8-flash', 'domestic_cn')).toBe('qwen');
    expect(prefixedProvider('dashscope/qwen-max')).toBe('qwen');
    expect(scorerRoute('qwen/qwen3.8-flash', 'openrouter', {}, 'global')).toMatchObject({ provider: 'openrouter' });
    const env = { DASHSCOPE_BASE_URL: 'https://gw.example.cn/v1', GLM_API_BASE_URL: 'https://glm.example.cn/v1', ARK_BASE_URL: 'https://ark.example.cn/v1' };
    expect(scorerRoute('qwen/qwen-max', null, env, 'domestic_cn')).toMatchObject({ provider: 'qwen', baseUrl: 'https://gw.example.cn/v1' });
    expect(scorerRoute('zhipu/glm-5', null, env, 'domestic_cn')).toMatchObject({ provider: 'glm', baseUrl: 'https://glm.example.cn/v1' });
    expect(scorerRoute('ark/doubao-pro', null, env, 'domestic_cn')).toMatchObject({ provider: 'doubao', baseUrl: 'https://ark.example.cn/v1' });
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
