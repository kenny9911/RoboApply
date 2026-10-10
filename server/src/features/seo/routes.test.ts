// @vitest-environment node
// WP-56 route tests over the in-memory repository (no database):
//   - Cache-Control on every public endpoint, success and error alike;
//   - below-floor pages are noindex; public counts ignore private rows;
//   - only PUBLIC_DISPLAY_PROVIDERS / consented bank jobs appear publicly;
//   - closed jobs answer 410;
//   - GoApply: browse and job pages deferred (404 feature_disabled), a seeded
//     GoHire posting appears on no route (R41-1b), the ticker is empty;
//   - per-IP limit (429 + Retry-After + no-store): direct callers by their IP,
//     the Next server by the visitor IP it forwards; the real limiter's key,
//     skip and fail-open paths;
//   - a brand-echo mismatch 404 is never publicly cacheable.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { SEO_CACHE_CONTROL, SEO_GONE_CACHE_CONTROL, SEO_MISSING_CACHE_CONTROL, SEO_SITEMAP_CACHE_CONTROL } from './contract.js';
import { rateLimitKey, type ConsumeOptions, type RateLimitResult } from '../../platform/ratelimit/index.js';
import {
  CLIENT_IP_HEADER,
  SEO_RATE_LIMIT_NAME,
  createSeoPublicRouter,
  isInternalRequest,
  seoLimitIp,
  seoRateLimiter,
  type SeoRouterDeps,
} from './routes.js';
import { createSeoService } from './service.js';
import { createMemorySeoRepo, seoJob, seoJobs } from './testkit.js';

const BASE = '/api/v1/public/seo';
const RA = 'localhost:3621';
const GA = 'goapply.localhost:3621';
const NOW = new Date('2026-10-10T00:00:00.000Z');
const ENV = { FLAG_ROBOAPPLY_SEO_BROWSE: 'true', FLAG_GOAPPLY_SEO_BROWSE: 'true', INTERNAL_API_SECRET: 'internal-secret' };

const backend = { taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'] };

const repo = createMemorySeoRepo([
  // 22 public, displayable backend jobs in Taipei (role page above the floor of 20).
  ...seoJobs(22, { ...backend, salaryDisclosed: true, salaryMin: 1_000_000, salaryMax: 1_400_000, salaryCurrency: 'TWD', salaryPeriod: 'year' }),
  // Planted rows that must never count or show.
  ...seoJobs(30, { ...backend, visibility: 'private', title: 'PRIVATE IMPORT' }),
  ...seoJobs(5, { ...backend, publicDisplay: false, title: 'NOT DISPLAYABLE' }),
  ...seoJobs(5, { ...backend, fromRecruiterBank: false, sourceBoard: 'jsearch', title: 'PROVIDER NOT LISTED' }),
  // 3 in Hsinchu: a role × city page below the floor of 5.
  ...seoJobs(3, { ...backend, locationCity: 'Hsinchu', location: 'Hsinchu' }),
  seoJob({ id: 'closedjob', ...backend, closedAt: new Date('2026-10-05T00:00:00Z'), title: 'Closed Role' }),
  seoJob({ id: 'estjob', ...backend, title: 'Estimated Date Role', postedAtEstimated: true, firstSeenAt: new Date('2026-10-09T23:00:00Z') }),
  seoJob({ id: 'privjob', ...backend, visibility: 'private', title: 'Own import' }),
  // A GoHire posting on the cn market (public display recorded).
  seoJob({ id: 'job_gh', market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', title: '产品经理', companyName: '示例科技', locationCountry: 'CN', locationCity: '上海' }),
]);

function deps(over: Partial<SeoRouterDeps> = {}, env: Record<string, string> = ENV): SeoRouterDeps {
  return { env, service: createSeoService({ repo, env, now: () => NOW, isEnabled: async () => true }), limit: async () => undefined, ...over };
}

async function harness(d: SeoRouterDeps, env: Record<string, string> = ENV): Promise<RouteHarness> {
  return startRouteHarness({ env, mounts: [[BASE, createSeoPublicRouter(d)]] });
}

let h: RouteHarness;
beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  h = await harness(deps());
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await h?.close();
});

type Body = { success: boolean; code?: string; data?: Record<string, unknown> & { jobs?: Array<{ title: string }> } };

describe('Cache-Control on every public endpoint', () => {
  it.each([
    ['/page?path=backend-engineer', SEO_CACHE_CONTROL, 200],
    ['/hub', SEO_CACHE_CONTROL, 200],
    ['/ticker', SEO_CACHE_CONTROL, 200],
    ['/sitemap', SEO_SITEMAP_CACHE_CONTROL, 200],
    ['/sitemap/jobs-1', SEO_SITEMAP_CACHE_CONTROL, 200],
    ['/jobs/job1', SEO_CACHE_CONTROL, 200],
    ['/jobs/nope', SEO_MISSING_CACHE_CONTROL, 404],
    ['/jobs/closedjob', SEO_GONE_CACHE_CONTROL, 410],
    ['/sitemap/jobs-99', SEO_MISSING_CACHE_CONTROL, 404],
    ['/page?path=zzqx-not-a-role', SEO_MISSING_CACHE_CONTROL, 404],
    ['/page', 'no-store', 422],
  ])('%s', async (path, cache, status) => {
    const res = await h.request<Body>('GET', `${BASE}${path}`, { host: RA });
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe(cache);
  });
});

describe('browse pages (RoboApply)', () => {
  it('role page: counts only public, displayable rows; indexable above the floor', async () => {
    const res = await h.request<Body>('GET', `${BASE}/page?path=backend-engineer`, { host: RA });
    const d = res.body.data as Record<string, any>;
    // 22 Taipei + 3 Hsinchu + the estimated-date job = 26; planted rows excluded.
    expect(d.stats.jobCount).toMatchObject({ value: 26, source: 'index' });
    expect(d.indexable).toBe(true);
    expect(d.jobs.length).toBe(20);
    expect(JSON.stringify(d.jobs)).not.toMatch(/PRIVATE IMPORT|NOT DISPLAYABLE|PROVIDER NOT LISTED|Closed Role|Own import/);
    expect(d.stats.medianPay).toMatchObject({ value: { currency: 'TWD', value: 1_200_000 }, sampleSize: 22 });
    expect(d.intro.params.count).toBe(26);
    // The Taipei city page qualifies as a child; Hsinchu (3) does not.
    expect(d.children.map((c: { path: string }) => c.path)).toContain('/browse/backend-engineer/taipei');
    expect(d.children.map((c: { path: string }) => c.path)).not.toContain('/browse/backend-engineer/hsinchu');
  });

  it('below the floor: noindex, still renders the real jobs', async () => {
    const res = await h.request<Body>('GET', `${BASE}/page?path=backend-engineer/hsinchu`, { host: RA });
    const d = res.body.data as Record<string, any>;
    expect(d.indexable).toBe(false);
    expect(d.stats.jobCount.value).toBe(3);
    expect(d.up.path).toBe('/browse/backend-engineer');
  });

  it('a ?country= view is never indexable', async () => {
    const res = await h.request<Body>('GET', `${BASE}/page?path=backend-engineer&country=tw`, { host: RA });
    expect((res.body.data as Record<string, any>).indexable).toBe(false);
    expect((res.body.data as Record<string, any>).country).toBe('TW');
  });

  it('unknown role → 404 with the reason the web shows', async () => {
    const res = await h.request<{ code: string; details: { reason: string } }>('GET', `${BASE}/page?path=zzqx-not-a-role`, { host: RA });
    expect(res.body).toMatchObject({ code: 'not_found', details: { reason: 'unknown_role' } });
  });

  it('flag seo.browse off → 404 feature_disabled', async () => {
    const off = await harness(deps({}, { ...ENV, FLAG_ROBOAPPLY_SEO_BROWSE: 'false' }), { ...ENV, FLAG_ROBOAPPLY_SEO_BROWSE: 'false' });
    try {
      const res = await off.request<Body>('GET', `${BASE}/page?path=backend-engineer`, { host: RA });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    } finally {
      await off.close();
    }
  });

  it('a brand echo that disagrees with the host is refused, and the 404 is not publicly cacheable', async () => {
    for (const p of ['/page?path=backend-engineer&brand=goapply', '/ticker?brand=goapply', '/sitemap?brand=goapply', '/jobs/job1?brand=goapply']) {
      const res = await h.request<Body>('GET', `${BASE}${p}`, { host: RA });
      expect(res.status, p).toBe(404);
      expect(res.headers.get('cache-control'), p).toBe('no-store');
    }
  });
});

describe('public job pages', () => {
  it('returns the card with posted date omitted when estimated', async () => {
    const res = await h.request<{ data: { job: Record<string, unknown> } }>('GET', `${BASE}/jobs/estjob`, { host: RA });
    expect(res.status).toBe(200);
    expect(res.body.data.job).toMatchObject({ id: 'estjob', postedAt: null });
    expect(res.body.data.job.canonicalPath).toMatch(/^\/job\/estjob-estimated-date-role-company-\d+$/);
  });

  it('closed → 410 gone; private import → 404', async () => {
    expect((await h.request<Body>('GET', `${BASE}/jobs/closedjob`, { host: RA })).body.code).toBe('gone');
    expect((await h.request<Body>('GET', `${BASE}/jobs/privjob`, { host: RA })).status).toBe(404);
  });

  it('a cn job is not readable on the RoboApply host', async () => {
    expect((await h.request<Body>('GET', `${BASE}/jobs/job_gh`, { host: RA })).status).toBe(404);
  });
});

describe('GoApply', () => {
  it('browse pages are deferred: 404 feature_disabled', async () => {
    for (const p of ['/page?path=backend-engineer', '/hub']) {
      const res = await h.request<Body>('GET', `${BASE}${p}`, { host: GA });
      expect(res.status, p).toBe(404);
      expect(res.body.code, p).toBe('feature_disabled');
    }
  });

  it('mode off: the seeded GoHire posting appears on no route; ticker and sitemap answer empty [R41-1b]', async () => {
    const job = await h.request<Body>('GET', `${BASE}/jobs/job_gh`, { host: GA });
    expect(job.status).toBe(404);
    const ticker = await h.request<Body>('GET', `${BASE}/ticker`, { host: GA });
    expect(ticker.status).toBe(200);
    expect(ticker.body.data).toMatchObject({ items: [] });
    const sitemap = await h.request<Body>('GET', `${BASE}/sitemap`, { host: GA });
    expect(sitemap.body.data).toMatchObject({ parts: [] });
    expect(JSON.stringify([job.body, ticker.body, sitemap.body])).not.toContain('产品经理');
  });

  it('job pages stay deferred even with the mode allowing postings (PRODUCT F-SEO-05 cn = DEFER)', async () => {
    const env = { ...ENV, CN_RECRUITMENT_INFO_MODE: 'licensed' };
    const on = await harness(deps({}, env), env);
    try {
      const res = await on.request<Body>('GET', `${BASE}/jobs/job_gh`, { host: GA });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
      expect(res.text).not.toContain('产品经理');
    } finally {
      await on.close();
    }
  });
});

describe('ticker and sitemaps', () => {
  it('ticker: newest public jobs by first seen, posted date null when estimated', async () => {
    const res = await h.request<{ data: { items: Array<{ id: string; postedAt: string | null }> } }>('GET', `${BASE}/ticker`, { host: RA });
    expect(res.body.data.items[0]).toMatchObject({ id: 'estjob', postedAt: null });
    expect(res.body.data.items.length).toBeLessThanOrEqual(10);
  });

  it('sitemap index lists job partitions; parts list canonical job paths', async () => {
    const idx = await h.request<{ data: { parts: Array<{ name: string; count: number }> } }>('GET', `${BASE}/sitemap`, { host: RA });
    expect(idx.body.data.parts).toEqual([{ name: 'jobs-1', count: 26, lastmod: null }]);
    const part = await h.request<{ data: { urls: Array<{ path: string }> } }>('GET', `${BASE}/sitemap/jobs-1`, { host: RA });
    expect(part.body.data.urls.length).toBe(26);
    expect(part.body.data.urls.every((u) => u.path.startsWith('/job/'))).toBe(true);
  });
});

describe('rate limit (F-TRUST-02)', () => {
  const allowed: RateLimitResult = { allowed: true, retryAfterSec: 0, remaining: 119, windows: [] };
  const refused: RateLimitResult = { allowed: false, retryAfterSec: 42, remaining: 0, windows: [] };
  const fakeReq = (headers: Record<string, string> = {}, ip = '203.0.113.9') => ({ headers, ip, socket: {} }) as unknown as Request;

  it('429 + Retry-After + no-store when the limiter refuses', async () => {
    const limited = await harness(deps({ limit: async () => { throw new HttpError('rate_limited', undefined, { retryAfterSec: 30 }); } }));
    try {
      const res = await limited.request<Body>('GET', `${BASE}/page?path=backend-engineer`, { host: RA });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      await limited.close();
    }
  });

  it('the Next server (shared secret) is recognised; a wrong secret is not', () => {
    const req = (v?: string) => ({ headers: v ? { 'x-ra-internal': v } : {} }) as unknown as Request;
    expect(isInternalRequest(req('internal-secret'), ENV)).toBe(true);
    expect(isInternalRequest(req('nope'), ENV)).toBe(false);
    expect(isInternalRequest(req(), ENV)).toBe(false);
    expect(isInternalRequest(req('internal-secret'), {})).toBe(false);
  });

  it('which IP is counted: direct callers by their own IP; the Next server by the visitor IP it forwards', () => {
    expect(seoLimitIp(fakeReq(), ENV)).toBe('203.0.113.9');
    // Internal + forwarded visitor IP → the visitor.
    expect(seoLimitIp(fakeReq({ 'x-ra-internal': 'internal-secret', [CLIENT_IP_HEADER]: '198.51.100.7' }), ENV)).toBe('198.51.100.7');
    expect(seoLimitIp(fakeReq({ 'x-ra-internal': 'internal-secret', [CLIENT_IP_HEADER]: '2001:db8::1' }), ENV)).toBe('2001:db8::1');
    // Internal without a visitor IP (sitemaps, the cron) → not counted.
    expect(seoLimitIp(fakeReq({ 'x-ra-internal': 'internal-secret' }), ENV)).toBeNull();
    expect(seoLimitIp(fakeReq({ 'x-ra-internal': 'internal-secret', [CLIENT_IP_HEADER]: 'not an ip; drop' }), ENV)).toBeNull();
    // A forwarded IP without the secret is ignored: the caller's own IP counts.
    expect(seoLimitIp(fakeReq({ [CLIENT_IP_HEADER]: '198.51.100.7' }), ENV)).toBe('203.0.113.9');
    expect(seoLimitIp(fakeReq({ 'x-ra-internal': 'wrong', [CLIENT_IP_HEADER]: '198.51.100.7' }), ENV)).toBe('203.0.113.9');
  });

  it('seoRateLimiter: allowed passes; refused throws rate_limited with Retry-After; a counter error fails open', async () => {
    const calls: ConsumeOptions[] = [];
    const ok = seoRateLimiter(ENV, { consume: async (o) => (calls.push(o), allowed) });
    await expect(ok(fakeReq())).resolves.toBeUndefined();
    expect(calls[0]!.key).toBe(rateLimitKey(SEO_RATE_LIMIT_NAME, 'ip', '203.0.113.9'));
    expect(calls[0]!.key).toMatch(/:seoPublicPerIp:ip:/);
    expect(calls[0]!.windows).toEqual([{ limit: 120, windowSec: 60 }]);

    const no = seoRateLimiter(ENV, { consume: async () => refused });
    await expect(no(fakeReq())).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterSec: 42 } });

    const broken = seoRateLimiter(ENV, { consume: async () => { throw new Error('db down'); } });
    await expect(broken(fakeReq())).resolves.toBeUndefined();
  });

  it('seoRateLimiter: the Next server without a visitor IP is not counted; with one, the visitor is', async () => {
    const calls: ConsumeOptions[] = [];
    const lim = seoRateLimiter(ENV, { consume: async (o) => (calls.push(o), allowed) });
    await lim(fakeReq({ 'x-ra-internal': 'internal-secret' }));
    expect(calls).toHaveLength(0);
    await lim(fakeReq({ 'x-ra-internal': 'internal-secret', [CLIENT_IP_HEADER]: '198.51.100.7' }));
    expect(calls.map((c) => c.key)).toEqual([rateLimitKey(SEO_RATE_LIMIT_NAME, 'ip', '198.51.100.7')]);
  });

  it('a public page render for a throttled visitor (internal request + visitor IP) answers 429 no-store', async () => {
    const visitorKey = rateLimitKey(SEO_RATE_LIMIT_NAME, 'ip', '198.51.100.7');
    const consume = async (o: ConsumeOptions) => (o.key.endsWith(visitorKey.split(':').pop()!) ? refused : allowed);
    const limited = await harness(deps({ limit: seoRateLimiter(ENV, { consume }) }));
    try {
      const internal = { 'x-ra-internal': 'internal-secret' };
      for (const p of ['/page?path=backend-engineer', '/jobs/job1', '/hub']) {
        const res = await limited.request<Body>('GET', `${BASE}${p}`, { host: RA, headers: { ...internal, [CLIENT_IP_HEADER]: '198.51.100.7' } });
        expect(res.status, p).toBe(429);
        expect(res.headers.get('retry-after'), p).toBe('42');
        expect(res.headers.get('cache-control'), p).toBe('no-store');
      }
      // Another visitor through the same Next server is unaffected.
      const other = await limited.request<Body>('GET', `${BASE}/jobs/job1`, { host: RA, headers: { ...internal, [CLIENT_IP_HEADER]: '198.51.100.8' } });
      expect(other.status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
