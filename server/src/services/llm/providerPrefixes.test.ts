// @vitest-environment node
//
// The selector → route rule and its two rewrites (GOAPPLY_PARITY_PLAN.md
// §3.3): `qualifySelector` pins a shared-stack selector to the route it has
// there, `pinDomesticSelector` keeps a GoApply selector's meaning on the
// global profile. Pure functions, no environment.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_MODE,
  normalizeProviderType,
  pinDomesticSelector,
  qualifySelector,
  resolveProviderPrefix,
  resolveSelectorRoute,
  splitSelectorPrefix,
  stripProviderPrefix,
} from './providerPrefixes.js';

describe('resolveSelectorRoute (the one routing rule)', () => {
  it('a recognised prefix pins its provider whatever the provider mode is', () => {
    expect(resolveSelectorRoute('google/gemini-3.8-flash', 'openrouter')).toEqual({ providerType: 'google', model: 'gemini-3.8-flash' });
    expect(resolveSelectorRoute('gemini/gemini-3.8-flash', 'openrouter')).toEqual({ providerType: 'google', model: 'gemini-3.8-flash' });
    expect(resolveSelectorRoute('openrouter/deepseek/deepseek-v4-pro', 'deepseek')).toEqual({ providerType: 'openrouter', model: 'deepseek/deepseek-v4-pro' });
    expect(resolveSelectorRoute('dashscope/qwen-plus', 'openrouter')).toEqual({ providerType: 'qwen', model: 'qwen-plus' });
  });

  it('qwen/ is a routing prefix only on the domestic profile', () => {
    expect(resolveSelectorRoute('qwen/qwen3.8-flash', 'openrouter')).toEqual({ providerType: 'openrouter', model: 'qwen/qwen3.8-flash' });
    expect(resolveSelectorRoute('qwen/qwen-plus', 'deepseek', null, 'domestic_cn')).toEqual({ providerType: 'qwen', model: 'qwen-plus' });
    expect(resolveProviderPrefix('qwen')).toBeNull();
    expect(resolveProviderPrefix('qwen', 'domestic_cn')).toBe('qwen');
    expect(splitSelectorPrefix('qwen/qwen-plus')).toBeNull();
    expect(splitSelectorPrefix('no-slash')).toBeNull();
  });

  it('an id without a routing prefix goes through the provider mode', () => {
    expect(resolveSelectorRoute('gpt-6-luna', 'openai')).toEqual({ providerType: 'openai', model: 'gpt-6-luna' });
    expect(resolveSelectorRoute('meta/llama-4', 'openrouter')).toEqual({ providerType: 'openrouter', model: 'meta/llama-4' });
    // No provider mode at all: no route.
    expect(resolveSelectorRoute('qwen-plus', '', null, 'domestic_cn')).toEqual({ providerType: '', model: 'qwen-plus' });
  });

  it("mode 'direct': vendor/model is OpenRouter's; a bare id follows the default model's prefix, else OpenRouter", () => {
    expect(resolveSelectorRoute('meta/llama-4', 'direct')).toEqual({ providerType: 'openrouter', model: 'meta/llama-4' });
    expect(resolveSelectorRoute('gpt-6-luna', 'direct', 'openai/gpt-6')).toEqual({ providerType: 'openai', model: 'gpt-6-luna' });
    expect(resolveSelectorRoute('gpt-6-luna', 'direct', 'meta/llama-4')).toEqual({ providerType: 'openrouter', model: 'gpt-6-luna' });
    expect(resolveSelectorRoute('gpt-6-luna', 'direct')).toEqual({ providerType: 'openrouter', model: 'gpt-6-luna' });
  });

  it('stripProviderPrefix drops only the prefix of the provider being called', () => {
    expect(stripProviderPrefix('google/gemini-3-flash', 'google')).toBe('gemini-3-flash');
    expect(stripProviderPrefix('Google/gemini-3-flash', 'google')).toBe('gemini-3-flash');
    expect(stripProviderPrefix('google/gemini-3-flash', 'openrouter')).toBe('google/gemini-3-flash');
    expect(stripProviderPrefix('gemini-3-flash', 'google')).toBe('gemini-3-flash');
  });
});

describe('qualifySelector (a shared selector keeps the route it has for RoboApply)', () => {
  /** Where a selector goes for RoboApply, and where its qualified form goes for GoApply on its own (domestic) stack. */
  function sameRoute(raw: string, sharedMode: string, sharedDefault?: string) {
    const forRobo = resolveSelectorRoute(raw, normalizeProviderType(sharedMode) || DEFAULT_PROVIDER_MODE, sharedDefault, 'global');
    const qualified = qualifySelector(raw, sharedMode, sharedDefault);
    // GoApply's own context: its own provider, its own default model, the domestic dialect.
    const forGo = resolveSelectorRoute(qualified, 'deepseek', 'deepseek-v4-flash', 'domestic_cn');
    return { forRobo, forGo, qualified };
  }

  it.each([
    ['gpt-6-luna', 'openrouter', undefined, 'openrouter/gpt-6-luna'],
    ['gpt-6-luna', 'openai', undefined, 'openai/gpt-6-luna'],
    ['gpt-6-luna', '', undefined, 'openrouter/gpt-6-luna'],
    ['meta/llama-4', 'openrouter', undefined, 'openrouter/meta/llama-4'],
    // An OpenRouter id on the shared stack; DashScope if GoApply read it unqualified.
    ['qwen/qwen3.8-flash', 'openrouter', undefined, 'openrouter/qwen/qwen3.8-flash'],
    ['google/gemini-3.8-flash', 'openrouter', undefined, 'google/gemini-3.8-flash'],
    ['gemini/gemini-3.8-flash', 'openrouter', undefined, 'google/gemini-3.8-flash'],
    ['openrouter/openai/gpt-6-luna', 'openrouter', undefined, 'openrouter/openai/gpt-6-luna'],
    ['openrouter/openai/gpt-6-luna', 'openai', undefined, 'openrouter/openai/gpt-6-luna'],
    ['anthropic/claude-sonnet-4-6', 'direct', undefined, 'anthropic/claude-sonnet-4-6'],
    ['meta/llama-4', 'direct', undefined, 'openrouter/meta/llama-4'],
    ['gpt-6-luna', 'direct', 'openai/gpt-6', 'openai/gpt-6-luna'],
    ['gpt-6-luna', 'direct', 'openrouter/openai/gpt-6', 'openrouter/gpt-6-luna'],
    ['gpt-6-luna', 'direct', undefined, 'openrouter/gpt-6-luna'],
    ['qwen-plus', 'dashscope', undefined, 'dashscope/qwen-plus'],
    ['deepseek-v4-flash', 'deepseek', undefined, 'deepseek/deepseek-v4-flash'],
  ] as const)('%s on a shared stack in mode "%s" (default %s) → %s', (raw, mode, sharedDefault, expected) => {
    const { forRobo, forGo, qualified } = sameRoute(raw, mode, sharedDefault);
    expect(qualified).toBe(expected);
    expect(forGo).toEqual(forRobo);
    // Qualifying twice changes nothing.
    expect(qualifySelector(qualified, mode, sharedDefault)).toBe(qualified);
  });

  it('leaves a selector alone when its provider cannot be pinned by a prefix, and blank input blank', () => {
    expect(qualifySelector('some-model', 'azure')).toBe('some-model');
    expect(qualifySelector('  ', 'openrouter')).toBe('');
    expect(qualifySelector('', 'openrouter')).toBe('');
  });
});

describe('pinDomesticSelector (a GoApply selector keeps its meaning on the global profile)', () => {
  it('spells qwen/ as dashscope/ and leaves everything else alone', () => {
    expect(pinDomesticSelector('qwen/qwen-plus')).toBe('dashscope/qwen-plus');
    expect(pinDomesticSelector('QWEN/qwen-plus')).toBe('dashscope/qwen-plus');
    expect(pinDomesticSelector('deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
    expect(pinDomesticSelector('openrouter/qwen/qwen3.8-flash')).toBe('openrouter/qwen/qwen3.8-flash');
    expect(pinDomesticSelector('qwen-plus')).toBe('qwen-plus');
    // Both spellings then reach the same provider on either profile.
    for (const profile of ['global', 'domestic_cn'] as const) {
      expect(resolveSelectorRoute(pinDomesticSelector('qwen/qwen-plus'), 'openrouter', null, profile)).toEqual({ providerType: 'qwen', model: 'qwen-plus' });
    }
  });
});
