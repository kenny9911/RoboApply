// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Router } from 'express';
import { startRouteHarness, fakeAuth, type RouteHarness } from '../../test/routeHarness.js';
import {
  getCurrentBrandId,
  getCurrentRequestHost,
  getCurrentUserId,
  runWithBrand,
  withRequestContext,
} from '../../lib/requestContext.js';
import { BrandContextMissingError, getCurrentBrand, getCurrentBrandOrDefault } from './brandContext.js';

describe('brand middleware + request context', () => {
  let h: RouteHarness;

  beforeAll(async () => {
    const router = Router();
    router.get('/whoami', async (req, res) => {
      await new Promise((r) => setTimeout(r, 5)); // context survives async hops
      res.json({
        userId: getCurrentUserId() ?? null,
        brandId: getCurrentBrandId() ?? null,
        brandName: getCurrentBrand().name,
        host: getCurrentRequestHost() ?? null,
        reqBrand: (req as unknown as { brand: { id: string } }).brand.id,
      });
    });
    h = await startRouteHarness({
      env: { NODE_ENV: 'development' },
      before: [fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null))],
      mounts: [['/t', router]],
    });
  });
  afterAll(() => h.close());

  it('sets getCurrentUserId() and getCurrentBrandId() inside a handler', async () => {
    const res = await h.request<Record<string, string>>('GET', '/t/whoami', {
      host: 'goapply.localhost:3621',
      headers: { 'x-test-user': 'user-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'user-1', brandId: 'goapply', brandName: 'GoApply', host: 'goapply.localhost', reqBrand: 'goapply' });
    expect(res.headers.get('x-ra-brand')).toBe('goapply');
  });

  it('isolates concurrent requests', async () => {
    const [a, b] = await Promise.all([
      h.request<Record<string, string>>('GET', '/t/whoami', { host: 'localhost:3621', headers: { 'x-test-user': 'a' } }),
      h.request<Record<string, string>>('GET', '/t/whoami', { host: 'goapply.localhost:3621', headers: { 'x-test-user': 'b' } }),
    ]);
    expect([a.body.userId, a.body.brandId]).toEqual(['a', 'roboapply']);
    expect([b.body.userId, b.body.brandId]).toEqual(['b', 'goapply']);
  });

  it('refuses a brand the deployment does not serve', async () => {
    const locked = await startRouteHarness({ env: { NODE_ENV: 'production' }, mounts: [['/t', Router().get('/x', (_q, r) => { r.json({ ok: true }); })]] });
    try {
      const res = await locked.request<{ code: string }>('GET', '/t/x', { host: 'www.goapply.top' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('brand_unavailable');
      const ok = await locked.request('GET', '/t/x', { host: 'www.roboapply.io' });
      expect(ok.status).toBe(200);
    } finally {
      await locked.close();
    }
  });
});

describe('getCurrentBrand outside a context', () => {
  it('throws BrandContextMissingError outside production', () => {
    expect(() => getCurrentBrand()).toThrow(BrandContextMissingError);
  });

  it('the lenient variant falls back to the default brand', () => {
    expect(getCurrentBrandOrDefault().id).toBe('roboapply');
  });

  it('runWithBrand sets the brand for crons and workers without inheriting the user', () => {
    withRequestContext({ requestId: 'r1', brandId: 'roboapply', userId: 'u1' }, () => {
      runWithBrand('goapply', () => {
        expect(getCurrentBrand().id).toBe('goapply');
        expect(getCurrentUserId()).toBeUndefined();
      });
      expect(getCurrentBrandId()).toBe('roboapply');
    });
  });

  it('the string form of withRequestContext keeps the enclosing brand', () => {
    runWithBrand('goapply', () => {
      withRequestContext('nested-request', () => {
        expect(getCurrentBrandId()).toBe('goapply');
      });
    });
    withRequestContext('no-parent', () => {
      expect(getCurrentBrandId()).toBeUndefined();
    });
  });
});
