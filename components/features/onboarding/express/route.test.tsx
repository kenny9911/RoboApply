// The /onboarding/start route file: RoboApply only. GoApply's setup has
// consent and identity steps the law requires, so the route is a 404 there,
// like /onboarding/goal.

import { describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';

const serverBrand = vi.hoisted(() => ({ id: 'roboapply' as 'roboapply' | 'goapply' }));
vi.mock('../../../../lib/server/brand', () => ({ getServerBrandId: async () => serverBrand.id }));

import OnboardingStartRoute from '../../../../app/(onboarding)/onboarding/start/page';
import { isOnboardingScreen } from '../flow';
import { ExpressOnboarding } from './ExpressOnboarding';

describe('/onboarding/start', () => {
  it('renders the two-screen flow on RoboApply', async () => {
    serverBrand.id = 'roboapply';
    const el = await OnboardingStartRoute();
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe(ExpressOnboarding);
  });

  it('is a 404 on GoApply', async () => {
    serverBrand.id = 'goapply';
    await expect(OnboardingStartRoute()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });

  it('is its own route file: `start` is not a stage of either brand, so /onboarding/[step] would 404 for it', () => {
    expect(isOnboardingScreen('roboapply', 'start')).toBe(false);
    expect(isOnboardingScreen('goapply', 'start')).toBe(false);
  });
});
