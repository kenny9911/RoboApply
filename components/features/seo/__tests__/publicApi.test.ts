// @vitest-environment node
// WP-56 lib/server/publicApi.ts: unstable_cache keyed per brand (two brands
// never share an entry) and tagged seo:<brand>:<type>:<slug>; the public
// origin per environment; brand + internal headers; result mapping.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({ calls: [] as Array<{ keys: string[]; opts: { tags: string[]; revalidate: number } }> }));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keys: string[], opts: { tags: string[]; revalidate: number }) => {
    cache.calls.push({ keys, opts });
    return fn;
  },
}));

import { getBrand } from '../../../../lib/brand/registry.generated';
import {
  PAGE_TTL,
  loadBrowsePage,
  loadPublicJob,
  loadSitemapPart,
  loadTicker,
  loadBrowseHub,
  publicApiHeaders,
  publicJobHtmlStatus,
  visitorIpFrom,
  publicApiOrigin,
  publicApiUrl,
  readPublic,
  type FetchImpl,
} from '../../../../lib/server/publicApi';

const reply = (status: number, body: unknown): FetchImpl => async () => ({ status, json: async () => body });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  cache.calls = [];
  fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ success: true, data: { ok: 1 } }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('origin and headers', () => {
  const ra = getBrand('roboapply');
  const ga = getBrand('goapply');

  it('production uses the brand public origin (CDN), preview the deployment URL, development the API URL', () => {
    const vercel = { NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production' };
    expect(publicApiOrigin(ra, vercel)).toBe('https://www.roboapply.io');
    expect(publicApiOrigin(ga, vercel)).toBe('https://www.goapply.top');
    expect(publicApiOrigin(ga, { ...vercel, CN_CANONICAL_ORIGIN: 'https://goapply.example/' })).toBe('https://goapply.example');
    expect(publicApiOrigin(ra, { ...vercel, VERCEL_ENV: 'preview', VERCEL_URL: 'pr-1.vercel.app' })).toBe('https://pr-1.vercel.app');
    expect(publicApiOrigin(ra, { NODE_ENV: 'development', NEXT_PUBLIC_API_URL: 'http://localhost:4621' })).toBe('http://localhost:4621');
  });

  it('a local production server (next start, no VERCEL) reads the local API, never the live site', () => {
    const local = { NODE_ENV: 'production', CANONICAL_ORIGIN: 'https://www.roboapply.io', INTERNAL_API_SECRET: 'local-secret' };
    expect(publicApiOrigin(ra, { ...local, NEXT_PUBLIC_API_URL: 'http://localhost:4611/' })).toBe('http://localhost:4611');
    expect(publicApiOrigin(ra, local)).toBe('http://localhost:4607');
    expect(publicApiOrigin(ga, { NODE_ENV: 'production', CN_CANONICAL_ORIGIN: 'https://www.goapply.top' })).toBe('http://localhost:4607');
    expect(publicApiUrl(ra, '/hub', {}, local)).toMatch(/^http:\/\/localhost:4607\//);
  });

  it('sends the brand (header and query) and the internal secret only when set', () => {
    expect(publicApiHeaders(ga, {})).toEqual({ accept: 'application/json', 'x-ra-brand': 'goapply' });
    expect(publicApiHeaders(ra, { INTERNAL_API_SECRET: 's' })).toMatchObject({ 'x-ra-internal': 's' });
    expect(publicApiUrl(ga, '/page', { path: 'a/b', country: undefined }, { NODE_ENV: 'production', VERCEL: '1' })).toBe('https://www.goapply.top/api/v1/public/seo/page?path=a%2Fb&brand=goapply');
  });

  it('forwards the visitor IP only with the secret, and only when shaped like an IP (F-TRUST-02)', () => {
    expect(publicApiHeaders(ra, { INTERNAL_API_SECRET: 's' }, '198.51.100.7')).toMatchObject({ 'x-ra-internal': 's', 'x-ra-client-ip': '198.51.100.7' });
    expect(publicApiHeaders(ra, {}, '198.51.100.7')).not.toHaveProperty('x-ra-client-ip');
    expect(publicApiHeaders(ra, { INTERNAL_API_SECRET: 's' }, 'evil\r\nx: y')).not.toHaveProperty('x-ra-client-ip');
    expect(publicApiHeaders(ra, { INTERNAL_API_SECRET: 's' }, null)).not.toHaveProperty('x-ra-client-ip');
  });

  it('visitorIpFrom: x-real-ip, else the first x-forwarded-for hop; junk → null', () => {
    const from = (h: Record<string, string>) => visitorIpFrom((n) => h[n] ?? null);
    expect(from({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.1' })).toBe('203.0.113.5');
    expect(from({ 'x-forwarded-for': '2001:db8::2, 10.0.0.1' })).toBe('2001:db8::2');
    expect(from({ 'x-real-ip': 'unknown' })).toBeNull();
    expect(from({})).toBeNull();
  });
});

describe('loaders forward the visitor IP on a miss (never part of the cache key)', () => {
  it('job, browse and hub reads send x-ra-client-ip; the key has no IP', async () => {
    process.env.INTERNAL_API_SECRET = 's';
    try {
      await loadPublicJob('roboapply', 'cm1', { clientIp: '198.51.100.7' });
      await loadBrowsePage('roboapply', ['backend-engineer'], null, { clientIp: '198.51.100.7' });
      await loadBrowseHub('roboapply', { clientIp: '198.51.100.7' });
      for (const call of fetchMock.mock.calls) expect((call[1] as { headers: Record<string, string> }).headers['x-ra-client-ip']).toBe('198.51.100.7');
      for (const c of cache.calls) expect(c.keys.join('|')).not.toContain('198.51.100.7');
    } finally {
      delete process.env.INTERNAL_API_SECRET;
    }
  });
});

describe('publicJobHtmlStatus (for proxy.ts, REQ-56-2)', () => {
  it('410 only for a closed public job page on RoboApply; anything else → null, never throws', async () => {
    expect(await publicJobHtmlStatus('roboapply', '/job/cm1-backend-engineer', { fetch: reply(410, { success: false, code: 'gone' }) })).toBe(410);
    expect(await publicJobHtmlStatus('roboapply', '/job/cm1-backend-engineer', { fetch: reply(200, { success: true, data: { job: {} } }) })).toBeNull();
    expect(await publicJobHtmlStatus('roboapply', '/job/cm1-x', { fetch: reply(404, { success: false, code: 'not_found' }) })).toBeNull();
    expect(await publicJobHtmlStatus('roboapply', '/job/cm1-x', { fetch: reply(503, null) })).toBeNull();
    expect(await publicJobHtmlStatus('roboapply', '/job/cm1-x', { fetch: async () => { throw new Error('down'); } })).toBeNull();
    const never: FetchImpl = async () => { throw new Error('must not fetch'); };
    expect(await publicJobHtmlStatus('roboapply', '/browse/backend-engineer', { fetch: never })).toBeNull();
    expect(await publicJobHtmlStatus('roboapply', '/job/%3Cscript%3E', { fetch: never })).toBeNull();
    expect(await publicJobHtmlStatus('goapply', '/job/cm1-x', { fetch: never })).toBeNull();
  });
});

describe('result mapping', () => {
  it('ok, gone (410), disabled, not_found with reason; 5xx throws (never cached)', async () => {
    expect(await readPublic('roboapply', '/x', {}, { fetch: reply(200, { success: true, data: 1 }) })).toEqual({ status: 'ok', data: 1 });
    expect(await readPublic('roboapply', '/x', {}, { fetch: reply(410, { success: false, code: 'gone' }) })).toEqual({ status: 'gone' });
    expect(await readPublic('roboapply', '/x', {}, { fetch: reply(404, { success: false, code: 'feature_disabled' }) })).toEqual({ status: 'disabled' });
    expect(await readPublic('roboapply', '/x', {}, { fetch: reply(404, { success: false, code: 'not_found', details: { reason: 'unknown_role' } }) })).toEqual({
      status: 'not_found',
      reason: 'unknown_role',
    });
    await expect(readPublic('roboapply', '/x', {}, { fetch: reply(503, null) })).rejects.toThrow(/503/);
    await expect(readPublic('roboapply', '/x', {}, { fetch: reply(429, { success: false, code: 'rate_limited' }) })).rejects.toThrow();
  });
});

describe('unstable_cache keys and tags', () => {
  it('browse pages: brand first in the key, tag seo:<brand>:<type>:<slug>', async () => {
    await loadBrowsePage('roboapply', ['backend-engineer', 'taipei']);
    await loadBrowsePage('goapply', ['backend-engineer', 'taipei']);
    const [ra, ga] = cache.calls;
    expect(ra!.keys.slice(0, 2)).toEqual(['seo', 'roboapply']);
    expect(ga!.keys.slice(0, 2)).toEqual(['seo', 'goapply']);
    expect(ra!.keys).not.toEqual(ga!.keys);
    expect(ra!.opts).toEqual({ tags: ['seo:roboapply:role_city:backend-engineer/taipei'], revalidate: PAGE_TTL });
    expect(ga!.opts.tags).toEqual(['seo:goapply:role_city:backend-engineer/taipei']);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('path=backend-engineer%2Ftaipei');
    expect(url).toContain('brand=roboapply');
  });

  it('a ?country view has its own entry but the same page tag', async () => {
    await loadBrowsePage('roboapply', ['backend-engineer'], 'us');
    expect(cache.calls[0]!.keys).toContain('US');
    expect(cache.calls[0]!.opts.tags).toEqual(['seo:roboapply:role:backend-engineer']);
  });

  it('not a browse shape → no read at all', () => {
    expect(loadBrowsePage('roboapply', ['a', 'b', 'c', 'd'])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('job, ticker and sitemap entries are per brand too', async () => {
    await loadPublicJob('roboapply', 'cm1');
    await loadPublicJob('goapply', 'cm1');
    await loadTicker('roboapply');
    await loadSitemapPart('roboapply', 'roles-1');
    expect(cache.calls.map((c) => c.opts.tags)).toEqual([
      ['seo:roboapply:job:cm1'],
      ['seo:goapply:job:cm1'],
      ['seo:roboapply:ticker:all'],
      ['seo:roboapply:sitemap:roles-1', 'seo:roboapply:sitemap:roles'],
    ]);
    expect(cache.calls[0]!.keys).not.toEqual(cache.calls[1]!.keys);
  });
});
