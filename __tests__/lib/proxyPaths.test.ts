// proxyPaths — the edge-proxy login gate's path matcher.
//
// The list is load-bearing twice over: the proxy 302s logged-out visitors to
// /login?next=…, and lib/api/client.ts only runs its stale-session recovery on
// a path this matcher accepts. A destination missing from the list re-opens the
// 401-stranding bug that commit 212a2e6 fixed, so every destination is asserted
// by name rather than by iterating the array (which would pass trivially if the
// array were emptied).

//
// INT-12 (WP-93 "no dead ends" (c)) adds the check against the route tree:
// every page under app/(auth) and app/(onboarding) is protected, every other
// page is public, and no prefix is left guarding nothing.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isProtectedPath, PROTECTED_PREFIXES } from '../../lib/proxyPaths';

const APP = join(process.cwd(), 'app');

/** Route groups whose pages need a session. */
const SIGNED_IN_GROUPS = ['(auth)', '(onboarding)'];

interface AppPage {
  /** Path under app/, e.g. `(auth)/jobs/[id]`. */
  dir: string;
  /** A concrete URL for the route. */
  url: string;
  signedIn: boolean;
}

function appPages(): AppPage[] {
  const out: AppPage[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(APP, dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(join(APP, rel)).isDirectory()) walk(rel);
      else if (name === 'page.tsx') {
        const segments = dir.split('/').filter(Boolean);
        const url =
          '/' +
          segments
            .filter((seg) => !/^\(.+\)$/.test(seg))
            .map((seg) => (seg.startsWith('[...') ? 'a/b' : seg.startsWith('[') ? 'x1' : seg))
            .join('/');
        out.push({ dir, url, signedIn: SIGNED_IN_GROUPS.includes(segments[0] ?? '') });
      }
    }
  };
  walk('');
  return out;
}

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

  it('protects external search and key management', () => {
    expect(isProtectedPath('/job-search')).toBe(true);
    expect(isProtectedPath('/job-search/developers')).toBe(true);
    expect(isProtectedPath('/developers/job-search')).toBe(false);
    expect(isProtectedPath('/job-searching')).toBe(false);
  });

  it('protects the clone\'s authenticated routes (FND-6a; PRODUCT_PLAN.md §3.4)', () => {
    for (const p of ['/onboarding', '/profile', '/assistant', '/ready', '/inbox', '/invite', '/coaching', '/referrals']) {
      expect(isProtectedPath(p), p).toBe(true);
      expect(isProtectedPath(`${p}/x`), `${p}/x`).toBe(true);
    }
    expect(isProtectedPath('/onboarding/situation')).toBe(true);
    expect(isProtectedPath('/ready/setup')).toBe(true);
  });

  it('leaves the public pages signed-in users also use (HybridShell) open', () => {
    for (const p of ['/campus', '/job/cm1-staff-engineer', '/browse/engineering', '/extension', '/pricing', '/tools/resume-check', '/r/ABC123', '/unsubscribe/t0k']) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it('lists exactly the fifteen protected prefixes', () => {
    expect([...PROTECTED_PREFIXES]).toEqual([
      '/jobs',
      '/job-search',
      '/resume',
      '/applications',
      '/practice',
      '/settings',
      '/admin',
      '/onboarding',
      '/profile',
      '/assistant',
      '/ready',
      '/inbox',
      '/invite',
      '/coaching',
      '/referrals',
    ]);
  });

  it('does NOT protect public paths', () => {
    for (const p of ['/login', '/signup', '/']) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it('no longer protects the routes this wave deleted — next.config redirects() forwards them', () => {
    for (const p of ['/home', '/tracker', '/resumes', '/mock-interview', '/queue', '/preferences', '/plans', '/account', '/choose-plan', '/activity', '/mission', '/apps', '/search', '/insights']) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it('matches by path segment, not substring (/jobseeker is not protected)', () => {
    expect(isProtectedPath('/jobseeker')).toBe(false);
    expect(isProtectedPath('/settings-export')).toBe(false);
  });

  describe('against the route tree (app/)', () => {
    const pages = appPages();

    it('finds the pages (guards the checks below against running on nothing)', () => {
      expect(pages.filter((p) => p.signedIn).length).toBeGreaterThan(30);
      expect(pages.filter((p) => !p.signedIn).length).toBeGreaterThan(20);
    });

    it('every shipped signed-in route is protected', () => {
      const open = pages.filter((p) => p.signedIn && !isProtectedPath(p.url)).map((p) => `${p.dir} → ${p.url}`);
      expect(open).toEqual([]);
    });

    it('every public route is public', () => {
      const gated = pages.filter((p) => !p.signedIn && isProtectedPath(p.url)).map((p) => `${p.dir} → ${p.url}`);
      expect(gated).toEqual([]);
    });

    it('every protected prefix still guards at least one signed-in page (no dead prefix)', () => {
      const dead = PROTECTED_PREFIXES.filter((prefix) => !pages.some((p) => p.signedIn && (p.url === prefix || p.url.startsWith(`${prefix}/`))));
      expect(dead).toEqual([]);
    });

    it('the first segment of every signed-in page is a protected prefix (the list and the tree agree)', () => {
      const firsts = new Set(pages.filter((p) => p.signedIn).map((p) => `/${p.url.split('/')[1]}`));
      expect([...firsts].sort()).toEqual([...PROTECTED_PREFIXES].sort());
    });

    it('/job-search keeps its prefix: the old search page is gone, the API-key page under it is not, and the bare path redirects', () => {
      expect(existsSync(join(APP, '(auth)/job-search/page.tsx'))).toBe(false);
      expect(existsSync(join(APP, '(auth)/job-search/developers/page.tsx'))).toBe(true);
      const nextConfig = readFileSync(join(process.cwd(), 'next.config.mjs'), 'utf8');
      expect(nextConfig).toMatch(/source: '\/job-search', destination: '\/jobs\/explore'/);
      // The redirect lands on a protected path, so a signed-out visitor still ends at /login.
      expect(isProtectedPath('/jobs/explore')).toBe(true);
      expect(isProtectedPath('/job-search/developers')).toBe(true);
    });
  });
});

