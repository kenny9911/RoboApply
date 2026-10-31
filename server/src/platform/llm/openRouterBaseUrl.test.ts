// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OPENROUTER_DEFAULT_BASE_URL, openAICompatibleBaseUrl, openRouterBaseUrlFromEnv } from './openRouterBaseUrl.js';

describe('openAICompatibleBaseUrl', () => {
  it('adds /v1 to an API root', () => {
    expect(openAICompatibleBaseUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1');
    expect(openAICompatibleBaseUrl(' https://openrouter.ai/api/ ')).toBe('https://openrouter.ai/api/v1');
    expect(openAICompatibleBaseUrl('https://api.together.xyz')).toBe('https://api.together.xyz/v1');
    expect(openAICompatibleBaseUrl('https://llm-proxy.example.com/openrouter')).toBe('https://llm-proxy.example.com/openrouter/v1');
  });

  it('gives the bare openrouter.ai host its /api/v1 path', () => {
    expect(openAICompatibleBaseUrl('https://openrouter.ai')).toBe(OPENROUTER_DEFAULT_BASE_URL);
  });

  it('keeps a URL whose path already names a version', () => {
    for (const url of [
      'https://openrouter.ai/api/v1',
      'https://api.groq.com/openai/v1',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://generativelanguage.googleapis.com/v1beta/openai',
    ]) {
      expect(openAICompatibleBaseUrl(url), url).toBe(url);
    }
    expect(openAICompatibleBaseUrl('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1');
  });

  it('returns a value that is not a URL trimmed', () => {
    expect(openAICompatibleBaseUrl(' not a url ')).toBe('not a url');
  });
});

describe('openRouterBaseUrlFromEnv', () => {
  it('is undefined when neither variable is set', () => {
    expect(openRouterBaseUrlFromEnv({})).toBeUndefined();
    expect(openRouterBaseUrlFromEnv({ OPENROUTER_BASE_URL: '  ', OPENROUTER_API_BASE_URL: '' })).toBeUndefined();
  });

  it('reads OPENROUTER_BASE_URL as an API root', () => {
    expect(openRouterBaseUrlFromEnv({ OPENROUTER_BASE_URL: 'https://openrouter.ai/api' })).toBe('https://openrouter.ai/api/v1');
    expect(openRouterBaseUrlFromEnv({ OPENROUTER_BASE_URL: 'https://api.together.xyz' })).toBe('https://api.together.xyz/v1');
  });

  it('uses the older OPENROUTER_API_BASE_URL as given, and OPENROUTER_BASE_URL wins over it', () => {
    expect(openRouterBaseUrlFromEnv({ OPENROUTER_API_BASE_URL: ' https://proxy.example.com/openrouter ' })).toBe('https://proxy.example.com/openrouter');
    expect(openRouterBaseUrlFromEnv({
      OPENROUTER_BASE_URL: 'https://api.together.xyz',
      OPENROUTER_API_BASE_URL: 'https://proxy.example.com/openrouter',
    })).toBe('https://api.together.xyz/v1');
  });
});
