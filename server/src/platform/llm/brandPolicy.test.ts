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
  llmDomesticOnlyApplies,
  routeHost,
} from './brandPolicy.js';

const go = BRANDS.goapply;
const robo = BRANDS.roboapply;
const env = {};
/** The operator's opt-in: GoApply may use mainland model endpoints only. */
const WALL = { CN_LLM_DOMESTIC_ONLY: 'true' };
/** LLMService's view of GoApply on the shared stack: the effective profile is the global one. */
const goOnSharedStack = { id: 'goapply', llmProfile: 'global' } as const;

describe('GoApply by default (D5): every route RoboApply may use, plus its domestic vendors', () => {
  it.each([
    ['openrouter', undefined, 'openrouter.ai'],
    ['openai', undefined, 'api.openai.com'],
    ['anthropic', undefined, 'api.anthropic.com'],
    ['google', undefined, 'generativelanguage.googleapis.com'],
    ['deepseek', undefined, 'api.deepseek.com'],
    ['qwen', undefined, 'dashscope.aliyuncs.com'],
    ['kimi', undefined, 'api.moonshot.cn'],
    ['glm', 'https://open.bigmodel.cn/api/paas/v4', 'open.bigmodel.cn'],
    ['doubao', 'https://ark.cn-beijing.volces.com/api/v3', 'ark.cn-beijing.volces.com'],
    ['minimax', 'https://api.minimax.io/v1', 'api.minimax.io'],
    ['deepseek', 'https://my-proxy.example.com/v1', 'my-proxy.example.com'],
    ['newapi', 'https://gateway.example.com/v1', 'gateway.example.com'],
  ])('allows %s %s', (provider, baseUrl, host) => {
    expect(checkLlmRoute({ brand: go, provider, baseUrl, env })).toEqual({ allowed: true, host });
    // The same answer for the effective-profile view LLMService passes.
    expect(checkLlmRoute({ brand: goOnSharedStack, provider, baseUrl, env })).toEqual({ allowed: true, host });
  });

  it('a call with no provider at all is still refused (missing_route)', () => {
    expect(checkLlmRoute({ brand: go, provider: '', env })).toMatchObject({ allowed: false, code: 'missing_route' });
    expect(checkLlmRoute({ brand: goOnSharedStack, provider: '', env })).toMatchObject({ allowed: false, code: 'missing_route' });
  });

  it('allows a personal key and a mainland endpoint for a prompt with user data (the RoboApply rule is not GoApply\'s)', () => {
    expect(checkLlmRoute({ brand: go, provider: 'openai', byok: true, env }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: go, provider: 'deepseek', byok: true, baseUrl: 'https://api.deepseek.com', env }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: goOnSharedStack, provider: 'deepseek', carriesUserData: true, env }).allowed).toBe(true);
  });

  it('the wall is off unless the operator switches it on', () => {
    expect(llmDomesticOnlyApplies(go, {})).toBe(false);
    expect(llmDomesticOnlyApplies(go, { CN_LLM_DOMESTIC_ONLY: 'false' })).toBe(false);
    expect(llmDomesticOnlyApplies(go, WALL)).toBe(true);
    expect(llmDomesticOnlyApplies(go, { CN_RESIDENCY_STRICT: 'true' })).toBe(true);
    expect(llmDomesticOnlyApplies(goOnSharedStack, WALL)).toBe(true);
    expect(llmDomesticOnlyApplies(robo, { ...WALL, CN_RESIDENCY_STRICT: 'true' })).toBe(false);
  });
});

describe('GoApply behind the domestic-only wall (CN_LLM_DOMESTIC_ONLY=true): the allowlist', () => {
  it.each([
    ['deepseek', undefined],
    ['qwen', undefined],
    ['dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['kimi', undefined],
    ['glm', 'https://open.bigmodel.cn/api/paas/v4'],
    ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['minimax', undefined],
  ])('allows %s', (provider, baseUrl) => {
    expect(checkLlmRoute({ brand: go, provider, baseUrl, env: WALL })).toMatchObject({ allowed: true });
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
    expect(checkLlmRoute({ brand: go, provider, baseUrl, env: WALL })).toMatchObject({ allowed: false, code });
    // The wall holds whatever profile the caller resolved: it follows the brand, not the stack in use.
    expect(checkLlmRoute({ brand: goOnSharedStack, provider, baseUrl, env: WALL })).toMatchObject({ allowed: false, code });
    // The strict residency switch implies the wall.
    expect(checkLlmRoute({ brand: go, provider, baseUrl, env: { CN_RESIDENCY_STRICT: 'true' } })).toMatchObject({ allowed: false, code });
  });

  it('allows newapi only when its host is a domestic endpoint or on CN_LLM_DOMESTIC_HOSTS', () => {
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', env: WALL }).allowed).toBe(true);
    const custom = { ...WALL, CN_LLM_DOMESTIC_HOSTS: 'llm.goapply.top, https://gw2.example.cn/' };
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://llm.goapply.top/v1', env: custom }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://gw2.example.cn/v1', env: custom }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: go, provider: 'newapi', baseUrl: 'https://evil-llm.goapply.top.attacker.com', env: custom }).allowed).toBe(false);
  });

  it('refuses BYOK and applies even when the prompt carries no user data', () => {
    expect(checkLlmRoute({ brand: go, provider: 'deepseek', byok: true, env: WALL })).toMatchObject({ allowed: false, code: 'byok_not_allowed' });
    expect(checkLlmRoute({ brand: go, provider: 'openai', carriesUserData: false, env: WALL }).allowed).toBe(false);
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

describe('RoboApply is not touched by GoApply\'s wall', () => {
  it.each([{}, WALL, { CN_RESIDENCY_STRICT: 'true' }])('same decisions with %o', (wallEnv) => {
    expect(checkLlmRoute({ brand: robo, provider: 'openrouter', env: wallEnv }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: robo, provider: 'openai', byok: true, env: wallEnv }).allowed).toBe(true);
    expect(checkLlmRoute({ brand: robo, provider: 'deepseek', env: wallEnv })).toMatchObject({ allowed: false, code: 'mainland_endpoint_for_intl' });
    expect(checkLlmRoute({ brand: robo, provider: '', env: wallEnv }).allowed).toBe(true);
  });
});

describe('chains and helpers', () => {
  const chain = [
    { provider: 'openrouter', model: 'openai/gpt-6' },
    { provider: 'deepseek', model: 'deepseek-v4-flash' },
    { provider: 'qwen', model: 'qwen-max' },
  ];

  it('filters a fallback chain per brand, keeping order: GoApply keeps every hop by default', () => {
    expect(filterLlmChain(robo, chain, { env }).allowed.map((r) => r.provider)).toEqual(['openrouter']);
    const goChain = filterLlmChain(go, chain, { env });
    expect(goChain.allowed.map((r) => r.provider)).toEqual(['openrouter', 'deepseek', 'qwen']);
    expect(goChain.rejected).toEqual([]);
  });

  it('behind the wall GoApply never falls back to an international hop', () => {
    const goChain = filterLlmChain(go, chain, { env: WALL });
    expect(goChain.allowed.map((r) => r.provider)).toEqual(['deepseek', 'qwen']);
    expect(goChain.rejected).toEqual([{ route: chain[0], code: 'provider_not_domestic', reason: expect.any(String) }]);
    // RoboApply's chain is the same with or without GoApply's wall.
    expect(filterLlmChain(robo, chain, { env: WALL }).allowed.map((r) => r.provider)).toEqual(['openrouter']);
  });

  it('assertLlmRoute throws LlmBrandPolicyError with code brand_policy', () => {
    expect(() => assertLlmRoute({ brand: go, provider: 'openai', env })).not.toThrow();
    expect(() => assertLlmRoute({ brand: go, provider: 'openai', env: WALL })).toThrow(LlmBrandPolicyError);
    try {
      assertLlmRoute({ brand: robo, provider: 'deepseek', env });
      expect.unreachable();
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
