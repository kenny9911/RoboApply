// proxyPaths — the edge-proxy login gate's path matcher.
//
// The list is load-bearing twice over: the proxy 302s logged-out visitors to
// /login?next=…, and lib/api/client.ts only runs its stale-session recovery on
// a path this matcher accepts. A destination missing from the list re-opens the
// 401-stranding bug that commit 212a2e6 fixed, so every destination is asserted
// by name rather than by iterating the array (which would pass trivially if the
// array were emptied).

import { describe, it, expect } from 'vitest';
import { isProtectedPath, PROTECTED_PREFIXES } from '../../lib/proxyPaths';

describe('proxyPaths.isProtectedPath', () => {
  it('protects all four destinations and their sub-routes', () => {
    for (const p of ['/jobs', '/resume', '/applications', '/practice']) {
      expect(isProtectedPath(p), p).toBe(true);
      expect(isProtectedPath(`${p}/cm_abc123`), `${p}/cm_abc123`).toBe(true);
    }
  });

  it('protects /settings and /admin', () => {
    expect(isProtectedPath('/settings')).toBe(true);
    expect(isProtectedPath('/settings/billing/history')).toBe(true);
    expect(isProtectedPath('/admin')).toBe(true);
    expect(isProtectedPath('/admin/users/cm_u1')).toBe(true);
  });

  it('lists exactly the six protected prefixes', () => {
    expect([...PROTECTED_PREFIXES]).toEqual([
      '/jobs',
      '/resume',
      '/applications',
      '/practice',
      '/settings',
      '/admin',
    ]);
  });

  it('does NOT protect public paths', () => {
    for (const p of ['/login', '/signup', '/']) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it('no longer protects the routes this wave deleted — next.config redirects() forwards them', () => {
    for (const p of ['/home', '/tracker', '/resumes', '/mock-interview', '/queue', '/preferences', '/plans', '/account', '/onboarding', '/choose-plan', '/activity', '/mission', '/apps', '/search', '/insights']) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it('matches by path segment, not substring (/jobseeker is not protected)', () => {
    expect(isProtectedPath('/jobseeker')).toBe(false);
    expect(isProtectedPath('/settings-export')).toBe(false);
  });
});
