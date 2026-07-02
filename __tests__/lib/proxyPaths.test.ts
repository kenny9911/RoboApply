// proxyPaths — the edge-proxy login gate's path matcher (req 1: "add a login
// check for entering RoboApply"). /plans must be protected so a logged-out hard
// load redirects to /login?next=/plans.

import { describe, it, expect } from 'vitest';
import { isProtectedPath, PROTECTED_PREFIXES } from '../../lib/proxyPaths';

describe('proxyPaths.isProtectedPath', () => {
  it('protects /plans and its sub-routes', () => {
    expect(isProtectedPath('/plans')).toBe(true);
    expect(isProtectedPath('/plans/anything')).toBe(true);
  });

  it('lists /plans in PROTECTED_PREFIXES', () => {
    expect(PROTECTED_PREFIXES).toContain('/plans');
  });

  it('protects the other authenticated surfaces', () => {
    for (const p of ['/home', '/resumes', '/mock-interview', '/onboarding', '/choose-plan', '/preferences']) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  it('does NOT protect public paths', () => {
    for (const p of ['/login', '/signup', '/']) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  it('matches by path segment, not substring (/plansomething is not protected)', () => {
    expect(isProtectedPath('/plansomething')).toBe(false);
  });
});
