// @vitest-environment node
// WP-32: the personalisation switch the feed reads (GoApply: a live 个性化推荐 grant, fail closed; RoboApply: always).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hasLiveConsent = vi.fn();
vi.mock('../../platform/consent/index.js', () => ({ hasLiveConsent: (...a: unknown[]) => hasLiveConsent(...a) }));

import { isFeedPersonalized } from './index.js';

beforeEach(() => hasLiveConsent.mockReset());

describe('isFeedPersonalized', () => {
  it('RoboApply is always personalised and reads no consent', async () => {
    expect(await isFeedPersonalized('u1', 'intl')).toBe(true);
    expect(hasLiveConsent).not.toHaveBeenCalled();
  });

  it('GoApply needs a live personalized_recommendation grant (unset or off → recency order)', async () => {
    hasLiveConsent.mockResolvedValueOnce(true);
    expect(await isFeedPersonalized('u1', 'cn')).toBe(true);
    expect(hasLiveConsent).toHaveBeenCalledWith('u1', 'personalized_recommendation');
    hasLiveConsent.mockResolvedValueOnce(false);
    expect(await isFeedPersonalized('u1', 'cn')).toBe(false);
  });

  it('fails closed when the consent lookup fails', async () => {
    hasLiveConsent.mockRejectedValueOnce(new Error('db down'));
    expect(await isFeedPersonalized('u1', 'cn')).toBe(false);
  });
});
