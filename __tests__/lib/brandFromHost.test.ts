// @vitest-environment node
//
// Host → brand resolution on the web tier (lib/brand/runtime.ts, proxy.ts,
// lib/server/brand.ts) — ARCHITECTURE.md §1.3/§1.5, TASK_PLAN.md FND-2b.
// The rules must match Express (server/src/platform/brand/runtime.ts), so a
// page and the API it calls always agree on the brand.

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import {
  allowedBrands,
  allowedBrandsProblem,
  brandLock,
  clampLocalePath,
  parseBrandHostMap,
  parseBrandQuery,
  resolveWebBrand,
  type EnvSource,
} from '../../lib/brand/runtime';
import { getBrand } from '../../lib/brand/registry.generated';
import { brandIdFromRequestParts } from '../../lib/server/brand';
import { devBrandHeader } from '../../lib/api/client';
import * as server from '../../server/src/platform/brand/runtime';
import { resolveBrandFromRequest } from '../../server/src/platform/brand/runtime';
import { proxy } from '../../proxy';
import { CLAMPED_FROM_COOKIE } from '../../lib/proxyPaths';
import { CLAMPED_FROM_COOKIE as NUDGE_CLAMPED_FROM_COOKIE } from '../../components/features/brand/nudge';

const DEV: EnvSource = { NODE_ENV: 'development' };
const PROD: EnvSource = { NODE_ENV: 'production' };
const PROD_BOTH: EnvSource = { NODE_ENV: 'production', ALLOWED_BRANDS: 'roboapply,goapply' };

describe('resolveWebBrand — host table', () => {
  const table: [string, 'roboapply' | 'goapply'][] = [
    ['roboapply.io', 'roboapply'],
    ['www.roboapply.io', 'roboapply'],
    ['api.roboapply.io', 'roboapply'],
    ['WWW.RoboApply.io:443', 'roboapply'],
    ['goapply.top', 'goapply'],
    ['www.goapply.top', 'goapply'],
    ['cdn.goapply.top', 'goapply'],
    ['localhost:3611', 'roboapply'],
    ['127.0.0.1:3621', 'roboapply'],
    ['goapply.localhost:3621', 'goapply'],
    ['goapply.localhost:3611', 'goapply'],
    ['unknown.example.com', 'roboapply'],
    ['preview-123.vercel.app', 'roboapply'],
  ];
  it.each(table)('%s → %s', (host, expected) => {
    expect(resolveWebBrand({ host }, PROD_BOTH).brandId).toBe(expected);
    expect(resolveWebBrand({ host }, DEV).brandId).toBe(expected);
  });

  it('x-forwarded-host wins over Host (Next dev proxy, Vercel)', () => {
    const r = resolveWebBrand({ host: 'localhost:3621', forwardedHost: 'goapply.localhost:3621' }, DEV);
    expect(r.brandId).toBe('goapply');
    expect(r.host).toBe('goapply.localhost');
  });

  it('BRAND_HOST_MAP maps staging hosts', () => {
    const env = { ...PROD_BOTH, BRAND_HOST_MAP: 'beta.example.com=goapply, x.example.com=intl' };
    expect(resolveWebBrand({ host: 'beta.example.com' }, env)).toMatchObject({ brandId: 'goapply', source: 'host_map' });
    expect(resolveWebBrand({ host: 'x.example.com' }, env).brandId).toBe('roboapply');
    expect(parseBrandHostMap('a.com=cn,bad,b.com=nope').get('a.com')).toBe('goapply');
    expect(parseBrandHostMap('a.com=cn,bad,b.com=nope').has('b.com')).toBe(false);
  });
});

describe('resolveWebBrand — overrides only on dev/preview hosts', () => {
  it('query beats cookie beats BRAND_FORCE on localhost, and asks to set the cookie', () => {
    const env = { ...DEV, BRAND_FORCE: 'roboapply' };
    expect(resolveWebBrand({ host: 'localhost:3621', queryOverride: 'goapply', cookieOverride: 'roboapply' }, env)).toMatchObject({
      brandId: 'goapply',
      source: 'override_query',
      overrideCookie: 'goapply',
    });
    expect(resolveWebBrand({ host: 'localhost:3621', cookieOverride: 'goapply' }, env)).toMatchObject({
      brandId: 'goapply',
      source: 'override_cookie',
      overrideCookie: null,
    });
    expect(resolveWebBrand({ host: 'goapply.localhost', cookieOverride: null }, { ...DEV, BRAND_FORCE: 'intl' })).toMatchObject({
      brandId: 'roboapply',
      source: 'brand_force',
    });
  });

  it('accepts the intl/cn aliases and clears the cookie on ?__brand=clear', () => {
    expect(resolveWebBrand({ host: 'localhost', queryOverride: 'cn' }, DEV).brandId).toBe('goapply');
    const cleared = resolveWebBrand({ host: 'localhost', queryOverride: 'clear', cookieOverride: 'goapply' }, DEV);
    expect(cleared).toMatchObject({ brandId: 'roboapply', overrideCookie: 'clear', source: 'host' });
    expect(parseBrandQuery(null)).toBeNull();
    expect(parseBrandQuery('')).toBe('clear');
    expect(parseBrandQuery('reset')).toBe('clear');
    expect(parseBrandQuery('robohire')).toBeNull();
  });

  it('a preview host (*.vercel.app) honours overrides even in production', () => {
    expect(resolveWebBrand({ host: 'pr-9.vercel.app', cookieOverride: 'goapply' }, PROD_BOTH).brandId).toBe('goapply');
  });

  it('production hosts ignore the query, the cookie and BRAND_FORCE', () => {
    const env = { ...PROD_BOTH, BRAND_FORCE: 'goapply' };
    const r = resolveWebBrand({ host: 'www.roboapply.io', queryOverride: 'goapply', cookieOverride: 'goapply' }, env);
    expect(r).toMatchObject({ brandId: 'roboapply', source: 'host', overrideCookie: null });
    expect(resolveWebBrand({ host: 'goapply.top', cookieOverride: 'roboapply' }, env).brandId).toBe('goapply');
  });

  it('garbage overrides are ignored', () => {
    expect(resolveWebBrand({ host: 'goapply.localhost', cookieOverride: 'robohire' }, DEV).brandId).toBe('goapply');
    expect(resolveWebBrand({ host: 'localhost', queryOverride: 'gohire' }, DEV)).toMatchObject({ brandId: 'roboapply', overrideCookie: null });
  });
});

describe('deployment scope (ALLOWED_BRANDS / BRAND_LOCK)', () => {
  it('unset = both brands in every environment, production included (D5)', () => {
    expect(allowedBrands(DEV)).toEqual(['roboapply', 'goapply']);
    expect(allowedBrands(PROD)).toEqual(['roboapply', 'goapply']);
    expect(allowedBrands({})).toEqual(['roboapply', 'goapply']);
    expect(brandLock(PROD)).toBeNull();
    expect(resolveWebBrand({ host: 'goapply.top' }, PROD)).toMatchObject({ brandId: 'goapply', source: 'host', allowed: true });
    expect(resolveWebBrand({ host: 'www.goapply.top' }, PROD)).toMatchObject({ brandId: 'goapply', allowed: true });
    expect(resolveWebBrand({ host: 'roboapply.io' }, PROD).allowed).toBe(true);
    expect(resolveWebBrand({ host: 'internal.example' }, PROD)).toMatchObject({ brandId: 'roboapply', source: 'default', allowed: true });
  });

  it('ALLOWED_BRANDS narrows a deployment in every environment', () => {
    const intlOnly = { ...PROD, ALLOWED_BRANDS: 'roboapply' };
    expect(allowedBrands(intlOnly)).toEqual(['roboapply']);
    expect(resolveWebBrand({ host: 'goapply.top' }, intlOnly)).toMatchObject({ brandId: 'goapply', allowed: false });
    expect(resolveWebBrand({ host: 'roboapply.io' }, intlOnly).allowed).toBe(true);
    const cnOnly = { ...PROD, ALLOWED_BRANDS: 'goapply' };
    expect(resolveWebBrand({ host: 'goapply.top' }, cnOnly).allowed).toBe(true);
    expect(resolveWebBrand({ host: 'roboapply.io' }, cnOnly)).toMatchObject({ brandId: 'roboapply', allowed: false });
    expect(resolveWebBrand({ host: 'goapply.localhost' }, { ...DEV, ALLOWED_BRANDS: 'roboapply' })).toMatchObject({ brandId: 'goapply', allowed: false });
  });

  it('agrees with the Express twin (server/src/platform/brand/runtime.ts) on the scope of every configuration', () => {
    for (const env of [
      {},
      DEV,
      PROD,
      PROD_BOTH,
      { ...PROD, ALLOWED_BRANDS: 'roboapply' },
      { ...PROD, ALLOWED_BRANDS: 'cn' },
      { ...PROD, ALLOWED_BRANDS: 'nonsense' },
      { ...DEV, ALLOWED_BRANDS: 'roboaply' },
      { ...PROD, ALLOWED_BRANDS: 'roboapply,gopply' },
      { ...PROD, ALLOWED_BRANDS: ',' },
      { ...PROD, ALLOWED_BRANDS: 'goapply,' },
      { ...PROD, ALLOWED_BRANDS: '  ' },
      { ...PROD, BRAND_LOCK: 'goapply' },
      { ...PROD, BRAND_LOCK: 'gopply' },
      { ...PROD, BRAND_LOCK: 'gopply', ALLOWED_BRANDS: 'cn' },
      { ...DEV, BRAND_LOCK: 'intl', ALLOWED_BRANDS: 'cn' },
      { ...DEV, BRAND_LOCK: 'intl', ALLOWED_BRANDS: 'nonsense' },
    ]) {
      expect(allowedBrands(env), JSON.stringify(env)).toEqual(server.allowedBrands(env));
      expect(brandLock(env), JSON.stringify(env)).toEqual(server.brandLock(env));
      expect(allowedBrandsProblem(env), JSON.stringify(env)).toEqual(server.allowedBrandsProblem(env));
    }
  });

  it('a scope variable that names no brand fails closed to the default brand, never open to both', () => {
    for (const env of [
      { ...PROD, ALLOWED_BRANDS: 'roboaply' },
      { ...DEV, ALLOWED_BRANDS: 'nonsense' },
      { ...PROD, BRAND_LOCK: 'gopply' },
    ]) {
      expect(allowedBrands(env), JSON.stringify(env)).toEqual(['roboapply']);
      expect(resolveWebBrand({ host: 'goapply.top' }, env)).toMatchObject({ brandId: 'goapply', allowed: false });
      expect(resolveWebBrand({ host: 'roboapply.io' }, env).allowed).toBe(true);
      expect(allowedBrandsProblem(env)).toMatchObject({ failedClosed: true, serves: ['roboapply'] });
    }
    expect(allowedBrandsProblem(PROD)).toBeNull();
  });

  it('a locked deployment serves unknown hosts as its brand', () => {
    const env = { ...PROD, BRAND_LOCK: 'cn' };
    expect(brandLock(env)).toBe('goapply');
    expect(resolveWebBrand({ host: 'internal.example' }, env)).toMatchObject({ brandId: 'goapply', source: 'lock', allowed: true });
    expect(resolveWebBrand({ host: 'roboapply.io' }, env).allowed).toBe(false);
    expect(brandLock({ ...PROD, ALLOWED_BRANDS: 'cn' })).toBe('goapply');
    expect(brandLock(PROD_BOTH)).toBeNull();
  });
});

describe('web and Express agree', () => {
  const cases: { host: string; fwd?: string; cookie?: string }[] = [
    { host: 'roboapply.io' },
    { host: 'goapply.top' },
    { host: 'localhost:3621', cookie: 'goapply' },
    { host: 'goapply.localhost:3621' },
    { host: 'localhost:3621', fwd: 'goapply.localhost:3621' },
    { host: 'www.roboapply.io', cookie: 'goapply' },
    { host: 'pr-1.vercel.app', cookie: 'goapply' },
    { host: 'unknown.example' },
  ];
  for (const env of [DEV, PROD, PROD_BOTH, { ...PROD, BRAND_LOCK: 'goapply' }, { ...DEV, BRAND_FORCE: 'goapply' }]) {
    it(`same brand and allowed flag (${JSON.stringify(env)})`, () => {
      for (const c of cases) {
        const web = resolveWebBrand({ host: c.host, forwardedHost: c.fwd ?? null, cookieOverride: c.cookie ?? null }, env);
        const api = resolveBrandFromRequest(
          {
            headers: { host: c.host, ...(c.fwd ? { 'x-forwarded-host': c.fwd } : {}) },
            cookies: c.cookie ? { ra_brand_override: c.cookie } : {},
          },
          env,
        );
        expect({ case: c, id: web.brandId, allowed: web.allowed }).toEqual({ case: c, id: api.brandId, allowed: api.allowed });
      }
    });
  }
});

describe('clampLocalePath', () => {
  const goapply = getBrand('goapply');
  const roboapply = getBrand('roboapply');
  it('redirects locales GoApply does not serve to its default locale', () => {
    expect(clampLocalePath('/zh-TW', goapply)).toBe('/zh');
    expect(clampLocalePath('/zh-TW/anything/deep', goapply)).toBe('/zh/anything/deep');
    expect(clampLocalePath('/ja', goapply)).toBe('/zh');
  });
  it('leaves served locales and ordinary routes alone', () => {
    expect(clampLocalePath('/zh', goapply)).toBeNull();
    expect(clampLocalePath('/en', goapply)).toBeNull();
    expect(clampLocalePath('/jobs', goapply)).toBeNull();
    expect(clampLocalePath('/', goapply)).toBeNull();
    for (const l of ['/zh-TW', '/ja', '/de/x']) expect(clampLocalePath(l, roboapply)).toBeNull();
  });
});

describe('lib/server/brand brandIdFromRequestParts', () => {
  const bag = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  const jar = (c: Record<string, string>) => ({ get: (n: string) => (c[n] ? { value: c[n]! } : undefined) });
  it('trusts the proxy-stamped header on dev hosts (carries ?__brand= on the first request)', () => {
    expect(brandIdFromRequestParts(bag({ host: 'localhost:3621', 'x-ra-brand': 'goapply' }), jar({}), DEV)).toBe('goapply');
  });
  it('recomputes from the host on production hosts, ignoring a spoofed header', () => {
    expect(brandIdFromRequestParts(bag({ host: 'www.roboapply.io', 'x-ra-brand': 'goapply' }), jar({}), PROD_BOTH)).toBe('roboapply');
    expect(brandIdFromRequestParts(bag({ host: 'goapply.top' }), null, PROD_BOTH)).toBe('goapply');
  });
  it('falls back to the override cookie on dev hosts without a stamp', () => {
    expect(brandIdFromRequestParts(bag({ host: 'localhost:3621' }), jar({ ra_brand_override: 'goapply' }), DEV)).toBe('goapply');
  });
});

describe('lib/api/client devBrandHeader', () => {
  it('echoes a valid override cookie outside production', () => {
    expect(devBrandHeader('a=1; ra_brand_override=goapply; robo_locale=zh')).toBe('goapply');
    expect(devBrandHeader('ra_brand_override=robohire')).toBeNull();
    expect(devBrandHeader('robo_locale=zh')).toBeNull();
  });
});

describe('proxy', () => {
  function request(url: string, init: { headers?: Record<string, string>; cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('cookie', init.cookie);
    return new NextRequest(url, { headers });
  }
  /** The value the proxy forwards for a request header (Next encodes overrides on the response). */
  function forwarded(res: Response, name: string): string | null {
    return res.headers.get(`x-middleware-request-${name}`);
  }

  it('stamps x-ra-brand and x-pathname, replacing a client-sent x-ra-brand', () => {
    const res = proxy(request('http://goapply.localhost:3621/zh', { headers: { host: 'goapply.localhost:3621', 'x-ra-brand': 'roboapply' } }));
    expect(forwarded(res, 'x-ra-brand')).toBe('goapply');
    expect(forwarded(res, 'x-pathname')).toBe('/zh');
  });

  it('a production host ignores a spoofed x-ra-brand', () => {
    const res = proxy(request('https://www.roboapply.io/', { headers: { host: 'www.roboapply.io', 'x-ra-brand': 'goapply' } }));
    expect(forwarded(res, 'x-ra-brand')).toBe('roboapply');
  });

  it('redirects /zh-TW/... on goapply to /zh/... (locale clamp)', () => {
    const res = proxy(request('http://goapply.localhost:3621/zh-TW/x?y=1', { headers: { host: 'goapply.localhost:3621' } }));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/zh/x');
    expect(loc.search).toBe('?y=1');
  });

  it('the clamp remembers the dropped locale in a short-lived, client-readable cookie for the wrong-brand nudge', () => {
    const res = proxy(request('http://goapply.localhost:3621/zh-TW/x', { headers: { host: 'goapply.localhost:3621' } }));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${NUDGE_CLAMPED_FROM_COOKIE}=zh-TW`);
    expect(setCookie).toMatch(/Max-Age=600/i);
    expect(setCookie).toMatch(/Path=\//i);
    expect(setCookie).not.toMatch(/HttpOnly/i);
    expect(CLAMPED_FROM_COOKIE).toBe(NUDGE_CLAMPED_FROM_COOKIE);
  });

  it('does not clamp /zh-TW on roboapply', () => {
    const res = proxy(request('http://localhost:3621/zh-TW', { headers: { host: 'localhost:3621' } }));
    expect(res.headers.get('location')).toBeNull();
    expect(forwarded(res, 'x-ra-brand')).toBe('roboapply');
  });

  it('?__brand=goapply on a dev host sets the override cookie and serves GoApply at once', () => {
    const res = proxy(request('http://localhost:3621/?__brand=goapply', { headers: { host: 'localhost:3621' } }));
    expect(forwarded(res, 'x-ra-brand')).toBe('goapply');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('ra_brand_override=goapply');
    expect(setCookie).toMatch(/Max-Age=604800/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).not.toMatch(/HttpOnly/i);
  });

  it('the override cookie switches the brand on a dev host, and ?__brand=clear deletes it', () => {
    const res = proxy(request('http://localhost:3621/', { headers: { host: 'localhost:3621' }, cookie: 'ra_brand_override=goapply' }));
    expect(forwarded(res, 'x-ra-brand')).toBe('goapply');
    const cleared = proxy(request('http://localhost:3621/?__brand=clear', { headers: { host: 'localhost:3621' }, cookie: 'ra_brand_override=goapply' }));
    expect(forwarded(cleared, 'x-ra-brand')).toBe('roboapply');
    expect(cleared.headers.get('set-cookie') ?? '').toMatch(/ra_brand_override=;/);
  });

  it('keeps the auth gate: a protected path without a session redirects to /login?next=', () => {
    const res = proxy(request('http://localhost:3621/jobs?tab=new', { headers: { host: 'localhost:3621' } }));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe('/jobs?tab=new');
  });

  it('lets a protected path through with a session cookie', () => {
    const res = proxy(request('http://localhost:3621/jobs', { headers: { host: 'localhost:3621' }, cookie: 'ra_session_token=abc' }));
    expect(res.headers.get('location')).toBeNull();
    expect(forwarded(res, 'x-pathname')).toBe('/jobs');
  });
});
