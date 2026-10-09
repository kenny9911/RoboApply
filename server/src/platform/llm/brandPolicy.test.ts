// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BRANDS } from '../brand/registry.js';
import {
  LlmBrandPolicyError,
  assertLlmRoute,
  checkLlmRoute,
  filterLlmChain,
  hostOf,
  isMainlandLlmHost,
  routeHost,
} from './brandPolicy.js';

const go = BRANDS.goapply;
const robo = BRANDS.roboapply;
const env = {};

describe('GoApply (domestic_cn): allowlist per R-13', () => {
  it.each([
    ['deepseek', undefined],
    ['qwen', undefined],
    ['dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['kimi', undefined],
    ['glm', 'https://open.bigmodel.cn/api/paas/v4'],
    ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['minimax', undefined],
  ])('allows %s', (provider, baseUrl) => {
    expect(checkLlmRoute({ brand: go, provider, baseUrl, env })).toMatchObject({ allowed: true });
  });

  it.each([
    ['openrouter', undefined, 'provider_not_domestic'],
    ['openai', undefined, 'provider_not_domestic'],
    ['anthropic', undefined, 'provider_not_domestic'],
    ['google', undefined, 'provider_not_domestic'],
    ['minimax', 'https://api.minimax.io/v1', 'host_not_domestic'],
    ['qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'host_not_domestic'],
    ['deepseek', 'https://my-proxy.example.com/v1', 'host_not_domestic'],
    ['newapi', 'https://gateway.example.com/v1', 'newapi_host_not_allowlisted'],
    ['newapi', undefined, 'newapi_host_not_allowlisted'],
    ['', undefined, 'missing_route'],
  ])('refuses %s %s', (provider, baseUrl, code) => {
    expect(checkLlmRoute({ brand: go, provider, baseUrl, env })).toMatchObject({ allowed: false, code });
  });

  it('allows newapi only when its host is a domestic endpoint or on CN_LLM_DOMESTIC_HOSTS', () => {
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', env }).allowed).toBe(true);
    const custom = { CN_LLM_DOMESTIC_HOSTS: 'llm.goapply.top, https://gw2.example.cn/' };
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://llm.goapply.top/v1', env: custom }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://gw2.example.cn/v1', env: custom }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://evil-llm.goapply.top.attacker.com', env: custom }).allowed).toBe(false);
  });

  it('refuses BYOK and applies even when the prompt carries no user data', () => {
    expect(checkLlmRoute({ brand: go, provider: 'deepseek', byok: true, env })).toMatchObject({ allowed: false, code: 'byok_not_allowed' });
    expect(checkLlmRoute({ brand: go, provider: 'openai', carriesUserData: false, env }).allowed).toBe(false);
  });
});

describe('RoboApply (global): no mainland endpoint for prompts with user data', () => {
  it.each([
    ['deepseek', undefined],
    ['kimi', undefined],
    ['qwen', undefined],
    ['glm', undefined],
    ['doubao', undefined],
    ['minimax', undefined],
    ['newapi', 'https://api.deepseek.com/v1'],
    ['openai', 'https://open.bigmodel.cn/api/paas/v4'],
  ])('refuses %s %s', (provider, baseUrl) => {
    expect(checkLlmRoute({ brand: robo, provider, baseUrl, env })).toMatchObject({
      allowed: false,
      code: 'mainland_endpoint_for_intl',
    });
  });

  it('matches by host, not provider name: OpenRouter serving a DeepSeek model is fine', () => {
    expect(checkLlmRoute({ brand: robo, provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', env })).toMatchObject({
      allowed: true,
      host: 'openrouter.ai',
    });
    expect(checkLlmRoute({ brand: robo, provider: 'minimax', baseUrl: 'https://api.minimax.io/v1', env }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: robo, provider: 'anthropic', env }).allowed).toBe(true);
  });

  it('lets prompts without user data through', () => {
    expect(checkLlmRoute({ brand: robo, provider: 'deepseek', carriesUserData: false, env }).allowed).toBe(true);
  });
});

describe('chains and helpers', () => {
  it('filters a fallback chain per brand, keeping order', () => {
    const chain = [
      { provider: 'openrouter', model: 'openai/gpt-6' },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'qwen', model: 'qwen-max' },
    ];
    expect(filterLlmChain(robo, chain).allowed.map((r) => r.provider)).toEqual(['openrouter']);
    const goChain = filterLlmChain(go, chain);
    expect(goChain.allowed.map((r) => r.provider)).toEqual(['deepseek', 'qwen']);
    expect(goChain.rejected).toEqual([{ route: chain[0], code: 'provider_not_domestic', reason: expect.any(String) }]);
  });

  it('assertLlmRoute throws LlmBrandPolicyError with code brand_policy', () => {
    expect(() => assertLlmRoute({ brand: go, provider: 'openai', env })).toThrow(LlmBrandPolicyError);
    try {
      assertLlmRoute({ brand: robo, provider: 'deepseek', env });
    } catch (err) {
      expect(err).toMatchObject({ code: 'brand_policy', policyCode: 'mainland_endpoint_for_intl', host: 'api.deepseek.com' });
    }
    expect(() => assertLlmRoute({ brand: robo, provider: 'openai', env })).not.toThrow();
  });

  it('parses hosts and suffixes strictly', () => {
    expect(hostOf('https://API.DeepSeek.com/v1')).toBe('api.deepseek.com');
    expect(hostOf('open.bigmodel.cn')).toBe('open.bigmodel.cn');
    expect(hostOf('')).toBeNull();
    expect(isMainlandLlmHost('x.volces.com', env)).toBe(true);
    expect(isMainlandLlmHost('notvolces.com', env)).toBe(false);
    expect(isMainlandLlmHost('dashscope-intl.aliyuncs.com', env)).toBe(false);
    expect(routeHost({ provider: 'kimi' })).toBe('api.moonshot.cn');
    expect(routeHost({ provider: 'unknown' })).toBeNull();
  });
});
