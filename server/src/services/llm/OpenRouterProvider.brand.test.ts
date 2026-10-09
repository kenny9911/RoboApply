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
});
