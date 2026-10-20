// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ create: vi.fn(), ctorOpts: [] as Array<Record<string, unknown>> }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: state.create } };
    constructor(opts: Record<string, unknown>) {
      state.ctorOpts.push(opts);
    }
  },
}));

const { OpenRouterProvider, openRouterBrandHeaders } = await import('./OpenRouterProvider.js');
const { runWithBrand } = await import('../../lib/requestContext.js');

describe('OpenRouter attribution headers follow the brand', () => {
  beforeEach(() => {
    state.create.mockReset();
    state.create.mockResolvedValue({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} });
  });

  it('defaults to RoboApply instead of the recruiter product', () => {
    expect(openRouterBrandHeaders()).toEqual({ 'HTTP-Referer': 'https://www.roboapply.io', 'X-Title': 'RoboApply' });
    new OpenRouterProvider('k', 'openai/gpt-4o');
    expect(state.ctorOpts.at(-1)!.defaultHeaders).toEqual({ 'HTTP-Referer': 'https://www.roboapply.io', 'X-Title': 'RoboApply' });
  });

  it('sends the current brand per request', async () => {
    const provider = new OpenRouterProvider('k', 'openai/gpt-4o');
    await runWithBrand('goapply', () => provider.chat([{ role: 'user', content: 'hi' }]));
    expect(state.create.mock.calls[0]![1]).toMatchObject({
      headers: { 'HTTP-Referer': 'https://www.goapply.top', 'X-Title': 'GoApply' },
      timeout: expect.any(Number),
    });
  });

  it('calls the endpoint in OPENROUTER_BASE_URL (an API root) when no credential base URL is set', () => {
    const saved = { root: process.env.OPENROUTER_BASE_URL, full: process.env.OPENROUTER_API_BASE_URL };
    try {
      delete process.env.OPENROUTER_BASE_URL;
      delete process.env.OPENROUTER_API_BASE_URL;
      new OpenRouterProvider('k', 'openai/gpt-4o');
      expect(state.ctorOpts.at(-1)!.baseURL).toBe('https://openrouter.ai/api/v1');

      process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
      new OpenRouterProvider('k', 'openai/gpt-4o');
      expect(state.ctorOpts.at(-1)!.baseURL).toBe('https://openrouter.ai/api/v1');

      process.env.OPENROUTER_BASE_URL = 'https://api.together.xyz';
      new OpenRouterProvider('k', 'openai/gpt-4o');
      expect(state.ctorOpts.at(-1)!.baseURL).toBe('https://api.together.xyz/v1');

      new OpenRouterProvider('k', 'openai/gpt-4o', { baseUrl: 'https://cred.example.com/v1' });
      expect(state.ctorOpts.at(-1)!.baseURL).toBe('https://cred.example.com/v1');
    } finally {
      if (saved.root === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = saved.root;
      if (saved.full === undefined) delete process.env.OPENROUTER_API_BASE_URL;
      else process.env.OPENROUTER_API_BASE_URL = saved.full;
    }
  });

  it('asks OpenRouter never to forward the prompt to a mainland-China upstream', async () => {
    const provider = new OpenRouterProvider('k', 'deepseek/deepseek-v4-flash');
    await runWithBrand('roboapply', () => provider.chat([{ role: 'user', content: 'hi' }]));
    expect(state.create.mock.calls[0]![0]).toMatchObject({
      provider: { ignore: expect.arrayContaining(['deepseek', 'alibaba', 'baidu', 'streamlake']) },
    });
  });
});
