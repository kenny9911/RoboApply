// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  allowedBrands,
  brandLock,
  cookieDomainFor,
  corsOrigins,
  parseBrandHostMap,
  resolveBrandFromRequest,
  type BrandRequestLike,
} from './runtime.js';
import { BRANDS } from './registry.js';

const DEV = { NODE_ENV: 'development' };
const PROD = { NODE_ENV: 'production', ALLOWED_BRANDS: 'roboapply,goapply' };

function req(host: string, extra: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}): BrandRequestLike {
  return { headers: { host, ...(extra.headers ?? {}) }, cookies: extra.cookies ?? {} };
}

describe('resolveBrandFromRequest — host table', () => {
  it.each([
    ['www.roboapply.io', PROD, 'roboapply'],
    ['roboapply.io', PROD, 'roboapply'],
    ['api.roboapply.io', PROD, 'roboapply'],
    ['www.goapply.top', PROD, 'goapply'],
    ['goapply.top', PROD, 'goapply'],
    ['goapply.localhost:3621', DEV, 'goapply'],
    ['localhost:3621', DEV, 'roboapply'],
    ['127.0.0.1:4621', DEV, 'roboapply'],
    ['unknown.example.com', DEV, 'roboapply'],
    ['unknown.example.com', PROD, 'roboapply'],
  ])('%s (%o) → %s', (host, env, expected) => {
    const r = resolveBrandFromRequest(req(host), env);
    expect(r.brandId).toBe(expected);
    expect(r.allowed).toBe(true);
  });

  it('reads x-forwarded-host before Host (Next dev proxy, Vercel)', () => {
    const r = resolveBrandFromRequest(
      { headers: { host: 'localhost:4621', 'x-forwarded-host': 'goapply.localhost:3621' } },
      DEV,
    );
    expect(r.brandId).toBe('goapply');
    expect(r.host).toBe('goapply.localhost');
  });

  it('honours BRAND_HOST_MAP for staging domains', () => {
    const env = { ...PROD, BRAND_HOST_MAP: 'staging.example.com=goapply, beta.example.com=intl' };
    expect(resolveBrandFromRequest(req('staging.example.com'), env)).toMatchObject({ brandId: 'goapply', source: 'host_map' });
    expect(resolveBrandFromRequest(req('beta.example.com'), env).brandId).toBe('roboapply');
    expect([...parseBrandHostMap('a.com=goapply,bad,b.com=nope').entries()]).toEqual([['a.com', 'goapply']]);
  });
});

describe('resolveBrandFromRequest — overrides', () => {
  it('honours the dev override cookie, then x-ra-brand, then BRAND_FORCE on dev hosts', () => {
    expect(resolveBrandFromRequest(req('localhost:3621', { cookies: { ra_brand_override: 'goapply' } }), DEV)).toMatchObject({
      brandId: 'goapply',
      source: 'override_cookie',
    });
    expect(resolveBrandFromRequest(req('localhost:3621', { headers: { 'x-ra-brand': 'goapply' } }), DEV)).toMatchObject({
      brandId: 'goapply',
      source: 'override_header',
    });
    expect(resolveBrandFromRequest(req('localhost:3621'), { ...DEV, BRAND_FORCE: 'cn' })).toMatchObject({
      brandId: 'goapply',
      source: 'brand_force',
    });
    // Cookie beats header.
    expect(
      resolveBrandFromRequest(
        req('goapply.localhost:3621', { cookies: { ra_brand_override: 'roboapply' }, headers: { 'x-ra-brand': 'goapply' } }),
        DEV,
      ).brandId,
    ).toBe('roboapply');
  });

  it('honours overrides on preview hosts in production mode', () => {
    const r = resolveBrandFromRequest(req('roboapply-git-x.vercel.app', { headers: { 'x-ra-brand': 'goapply' } }), PROD);
    expect(r.brandId).toBe('goapply');
  });

  it('ignores a client x-ra-brand header, override cookie and BRAND_FORCE on production hosts', () => {
    const r = resolveBrandFromRequest(
      req('www.roboapply.io', { headers: { 'x-ra-brand': 'goapply' }, cookies: { ra_brand_override: 'goapply' } }),
      { ...PROD, BRAND_FORCE: 'goapply' },
    );
    expect(r).toMatchObject({ brandId: 'roboapply', source: 'host' });
    expect(resolveBrandFromRequest(req('www.goapply.top', { headers: { 'x-ra-brand': 'roboapply' } }), PROD).brandId).toBe('goapply');
  });

  it('accepts x-ra-brand on a production host only with the internal secret', () => {
    const env = { ...PROD, INTERNAL_API_SECRET: 's3cret-value' };
    expect(
      resolveBrandFromRequest(req('api.roboapply.io', { headers: { 'x-ra-brand': 'goapply', 'x-ra-internal': 's3cret-value' } }), env),
    ).toMatchObject({ brandId: 'goapply', source: 'internal_header' });
    expect(
      resolveBrandFromRequest(req('api.roboapply.io', { headers: { 'x-ra-brand': 'goapply', 'x-ra-internal': 'wrong-value!' } }), env)
        .brandId,
    ).toBe('roboapply');
  });
});

describe('deployment scope', () => {
  it('defaults to both brands outside production and RoboApply only in production', () => {
    expect(allowedBrands(DEV)).toEqual(['roboapply', 'goapply']);
    expect(allowedBrands({ NODE_ENV: 'production' })).toEqual(['roboapply']);
    expect(resolveBrandFromRequest(req('www.goapply.top'), { NODE_ENV: 'production' })).toMatchObject({
      brandId: 'goapply',
      allowed: false,
    });
  });

  it('parses ALLOWED_BRANDS with aliases', () => {
    expect(allowedBrands({ ALLOWED_BRANDS: 'intl,cn' })).toEqual(['roboapply', 'goapply']);
    expect(allowedBrands({ ALLOWED_BRANDS: 'nonsense', NODE_ENV: 'production' })).toEqual(['roboapply']);
  });

  it('BRAND_LOCK serves one brand: unknown hosts resolve to it, other brands are refused', () => {
    const env = { NODE_ENV: 'production', BRAND_LOCK: 'goapply' };
    expect(brandLock(env)).toBe('goapply');
    expect(allowedBrands(env)).toEqual(['goapply']);
    expect(resolveBrandFromRequest(req('gw.internal'), env)).toMatchObject({ brandId: 'goapply', source: 'lock', allowed: true });
    expect(resolveBrandFromRequest(req('roboapply-x.vercel.app'), env)).toMatchObject({ brandId: 'goapply', allowed: true });
    expect(resolveBrandFromRequest(req('www.roboapply.io'), env)).toMatchObject({ brandId: 'roboapply', allowed: false });
  });

  it('a single ALLOWED_BRANDS entry acts as the lock', () => {
    expect(brandLock({ ALLOWED_BRANDS: 'cn' })).toBe('goapply');
    expect(brandLock({ ALLOWED_BRANDS: 'intl,cn' })).toBeNull();
  });
});

describe('cookieDomainFor', () => {
  const env = { COOKIE_DOMAIN: '.roboapply.io', CN_COOKIE_DOMAIN: '.goapply.top' };
  it('applies the brand domain only on matching hosts', () => {
    expect(cookieDomainFor(BRANDS.roboapply, 'www.roboapply.io', env)).toBe('.roboapply.io');
    expect(cookieDomainFor(BRANDS.roboapply, 'roboapply.io', env)).toBe('.roboapply.io');
    expect(cookieDomainFor(BRANDS.goapply, 'www.goapply.top', env)).toBe('.goapply.top');
    expect(cookieDomainFor(BRANDS.roboapply, 'roboapply-git-x.vercel.app', env)).toBeUndefined();
    expect(cookieDomainFor(BRANDS.roboapply, 'localhost', env)).toBeUndefined();
    expect(cookieDomainFor(BRANDS.goapply, 'goapply.localhost', env)).toBeUndefined();
  });
  it('never falls back across brands and is host-only when unset', () => {
    expect(cookieDomainFor(BRANDS.goapply, 'www.goapply.top', { COOKIE_DOMAIN: '.roboapply.io' })).toBeUndefined();
    expect(cookieDomainFor(BRANDS.roboapply, 'www.roboapply.io', {})).toBeUndefined();
  });
  it('keeps the configured domain when no host is known (legacy callers)', () => {
    expect(cookieDomainFor(BRANDS.roboapply, undefined, env)).toBe('.roboapply.io');
  });
});

describe('corsOrigins', () => {
  it('builds production origins from the registry hosts of allowed brands', () => {
    const origins = corsOrigins({ NODE_ENV: 'production', ALLOWED_BRANDS: 'roboapply,goapply', FRONTEND_URLS: 'https://x.example.com' });
    expect(origins).toEqual(
      expect.arrayContaining([
        'https://roboapply.io',
        'https://www.roboapply.io',
        'https://api.roboapply.io',
        'https://goapply.top',
        'https://www.goapply.top',
        'https://x.example.com',
      ]),
    );
    expect(origins.some((o) => o instanceof RegExp && o.test('https://roboapply-git-x.vercel.app'))).toBe(true);
  });
  it('omits brands this deployment does not serve', () => {
    expect(corsOrigins({ NODE_ENV: 'production' })).not.toContain('https://www.goapply.top');
  });
  it('allows both dev hosts on the dev ports', () => {
    const origins = corsOrigins({ NODE_ENV: 'development' });
    expect(origins).toEqual(expect.arrayContaining(['http://localhost:3611', 'http://localhost:3621', 'http://goapply.localhost:3621', 'http://localhost:3000']));
  });
});
