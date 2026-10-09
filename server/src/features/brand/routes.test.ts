// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrandPublicRouter, buildPublicBrand } from './routes.js';
import { PublicBrandSchema, type PublicBrand } from './contract.js';
import { BRANDS } from '../../platform/brand/registry.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';

describe('GET /api/v1/public/brand', () => {
  let h: RouteHarness;
  const env = { NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_x', GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 's' };
  beforeAll(async () => {
    h = await startRouteHarness({ env, mounts: [['/api/v1/public/brand', createBrandPublicRouter({ env })]] });
  });
  afterAll(() => h.close());

  it('returns RoboApply on localhost with only configured methods and rails', async () => {
    const res = await h.request<{ success: boolean; data: PublicBrand }>('GET', '/api/v1/public/brand', { host: 'localhost:3621' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(PublicBrandSchema.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ id: 'roboapply', market: 'intl', name: 'RoboApply', defaultLocale: 'en', currency: 'USD' });
    expect(d.authMethods).toEqual(['email_password', 'google']);
    expect(d.paymentRails).toEqual(['stripe']);
    expect(d.flags['pay.stripe']).toBe(true);
    expect(d.flags.hiringContacts).toBe('deeplinks_only');
    expect(d.otherBrand).toEqual({ id: 'goapply', name: 'GoApply', canonicalOrigin: 'https://www.goapply.top' });
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('returns GoApply on goapply.localhost with nothing it cannot deliver', async () => {
    const res = await h.request<{ data: PublicBrand }>('GET', '/api/v1/public/brand', { host: 'goapply.localhost:3621' });
    const d = res.body.data;
    expect(d).toMatchObject({ id: 'goapply', market: 'cn', defaultLocale: 'zh', locales: ['zh', 'en'], currency: 'CNY' });
    expect(d.authMethods).toEqual(['email_password']);
    expect(d.paymentRails).toEqual([]);
    expect(d.flags['jobs.feed']).toBe(false);
    expect(d.flags.eeoAnswers).toBe(false);
    expect(res.headers.get('x-ra-brand')).toBe('goapply');
  });

  it('is publicly cacheable on production hosts and exposes no secrets', async () => {
    const prodEnv = { NODE_ENV: 'production', ALLOWED_BRANDS: 'intl,cn', STRIPE_SECRET_KEY: 'sk_live_secret' };
    const prod = await startRouteHarness({ env: prodEnv, mounts: [['/b', createBrandPublicRouter({ env: prodEnv })]] });
    try {
      const res = await prod.request('GET', '/b', { host: 'www.goapply.top' });
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.text).not.toContain('sk_live_secret');
    } finally {
      await prod.close();
    }
  });

  it('buildPublicBrand validates for both brands', () => {
    for (const brand of [BRANDS.roboapply, BRANDS.goapply]) {
      expect(PublicBrandSchema.safeParse(buildPublicBrand(brand, {})).success).toBe(true);
    }
  });
});
