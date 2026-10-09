// @vitest-environment node
//
// FND-5: the content-safety interface WP-24 fills and WP-14 wires.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapError } from '../../http.js';
import {
  ContentBlockedError,
  checkInput,
  checkOutput,
  contentSafetyApplies,
  getContentSafetyProvider,
  noopContentSafetyProvider,
  setContentSafetyProvider,
  type ContentSafetyProvider,
} from './index.js';

const ctx = (brand: 'roboapply' | 'goapply') => ({ brand, task: 'copilot', userId: 'u1' });

describe('contentSafety', () => {
  afterEach(() => setContentSafetyProvider(null));

  it('is a pass-through no-op until WP-24 installs a provider', async () => {
    expect(getContentSafetyProvider()).toBe(noopContentSafetyProvider);
    await expect(checkInput('hello', ctx('goapply'))).resolves.toMatchObject({ verdict: 'pass', provider: 'noop' });
    await expect(checkOutput('hello', ctx('goapply'))).resolves.toMatchObject({ verdict: 'pass' });
  });

  it('applies to GoApply only; RoboApply never reaches the provider', async () => {
    const provider: ContentSafetyProvider = {
      id: 'fake',
      checkInput: vi.fn(async () => ({ verdict: 'block' as const, labels: ['x'], provider: 'fake' })),
      checkOutput: vi.fn(async () => ({ verdict: 'pass' as const, labels: [], provider: 'fake' })),
    };
    setContentSafetyProvider(provider);
    expect(contentSafetyApplies('roboapply')).toBe(false);
    await expect(checkInput('x', ctx('roboapply'))).resolves.toMatchObject({ verdict: 'pass', provider: 'not_applicable' });
    expect(provider.checkInput).not.toHaveBeenCalled();
  });

  it('throws ContentBlockedError on block, mapped to 422 content_blocked', async () => {
    setContentSafetyProvider({
      id: 'fake',
      checkInput: async () => ({ verdict: 'pass', labels: [], provider: 'fake' }),
      checkOutput: async () => ({ verdict: 'block', labels: ['rule:7'], provider: 'fake' }),
    });
    await expect(checkInput('ok', ctx('goapply'))).resolves.toMatchObject({ verdict: 'pass' });
    const err = await checkOutput('bad', ctx('goapply')).catch((e) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    const mapped = mapError(err);
    expect(mapped.status).toBe(422);
    expect(mapped.body).toMatchObject({ code: 'content_blocked', details: { stage: 'output', labels: ['rule:7'] } });
  });

  it('propagates provider errors (WP-24 makes the caller fail closed)', async () => {
    setContentSafetyProvider({
      id: 'down',
      checkInput: async () => {
        throw new Error('provider timeout');
      },
      checkOutput: async () => ({ verdict: 'pass', labels: [], provider: 'down' }),
    });
    await expect(checkInput('x', ctx('goapply'))).rejects.toThrow('provider timeout');
  });
});
