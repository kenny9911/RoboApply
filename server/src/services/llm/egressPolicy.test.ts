// @vitest-environment node
//
// Tests for server/src/platform/llm/egressPolicy.ts (WP-14; kept in an owned
// directory). The decision is made on the host the client will really call.
import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_MAINLAND_UPSTREAMS,
  assertLlmEgress,
  checkLlmEgress,
  effectiveLlmBaseUrl,
  openRouterIgnoredUpstreams,
} from '../../platform/llm/egressPolicy.js';
import { LlmBrandPolicyError } from '../../platform/llm/brandPolicy.js';

describe('effectiveLlmBaseUrl', () => {
  it('credential base URL ?? provider env override ?? built-in default', () => {
    expect(effectiveLlmBaseUrl('deepseek', 'https://proxy.example.com/v1', { DEEPSEEK_API_BASE_URL: 'https://x' })).toBe('https://proxy.example.com/v1');
    expect(effectiveLlmBaseUrl('deepseek', null, { DEEPSEEK_API_BASE_URL: 'https://env.example.com' })).toBe('https://env.example.com');
    expect(effectiveLlmBaseUrl('deepseek', undefined, {})).toBe('https://api.deepseek.com');
    expect(effectiveLlmBaseUrl('dashscope', undefined, {})).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(effectiveLlmBaseUrl('newapi', undefined, {})).toBeNull();
    expect(effectiveLlmBaseUrl('unknown', undefined, {})).toBeNull();
  });
});

describe('checkLlmEgress', () => {
  it('RoboApply: refuses a provider whose env override points at a mainland host', () => {
    const d = checkLlmEgress({ brand: 'roboapply', provider: 'openai', env: { OPENAI_BASE_URL: 'https://gw.volces.com/v1' } });
    expect(d).toMatchObject({ allowed: false, code: 'mainland_endpoint_for_intl', host: 'gw.volces.com' });
  });

  it('RoboApply: allows DeepSeek behind an international proxy, and prompts without user data', () => {
    expect(checkLlmEgress({ brand: 'roboapply', provider: 'deepseek', credentialBaseUrl: 'https://llm-proxy.example.com', env: {} }).allowed).toBe(true);
    expect(checkLlmEgress({ brand: 'roboapply', provider: 'deepseek', carriesUserData: false, env: {} }).allowed).toBe(true);
  });

  it('GoApply: refuses DeepSeek behind an international proxy and any BYOK', () => {
    expect(checkLlmEgress({ brand: 'goapply', provider: 'deepseek', credentialBaseUrl: 'https://llm-proxy.example.com', env: {} })).toMatchObject({
      allowed: false,
      code: 'host_not_domestic',
    });
    expect(checkLlmEgress({ brand: 'goapply', provider: 'deepseek', byok: true, env: {} })).toMatchObject({ allowed: false, code: 'byok_not_allowed' });
    expect(checkLlmEgress({ brand: 'goapply', provider: 'glm', env: {} })).toMatchObject({ allowed: true, host: 'open.bigmodel.cn' });
  });

  it('assertLlmEgress throws a client-safe LlmBrandPolicyError', () => {
    try {
      assertLlmEgress({ brand: 'goapply', provider: 'anthropic', env: {} });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmBrandPolicyError);
      expect((err as Error).message).toBe('This request cannot be routed for this site.');
      expect((err as LlmBrandPolicyError).reason).toContain('anthropic');
    }
  });
});

describe('OpenRouter mainland upstreams', () => {
  it('always ignores the mainland-China upstreams; the env can only add to the list', () => {
    expect(openRouterIgnoredUpstreams({})).toEqual([...OPENROUTER_MAINLAND_UPSTREAMS]);
    expect(OPENROUTER_MAINLAND_UPSTREAMS).toEqual(expect.arrayContaining(['deepseek', 'alibaba']));
    const withExtra = openRouterIgnoredUpstreams({ OPENROUTER_IGNORE_PROVIDERS: ' Tencent, deepseek ,' });
    expect(withExtra).toEqual([...OPENROUTER_MAINLAND_UPSTREAMS, 'tencent']);
  });
});
