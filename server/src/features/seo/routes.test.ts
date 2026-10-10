// @vitest-environment node
// WP-56 route tests over the in-memory repository (no database):
//   - Cache-Control on every public endpoint, success and error alike;
//   - below-floor pages are noindex; public counts ignore private rows;
//   - only PUBLIC_DISPLAY_PROVIDERS / consented bank jobs appear publicly;
//   - closed jobs answer 410;
//   - GoApply runs under the same gates (D5): a listable cn posting has a
//     public page and is in the cn ticker, sitemap and browse pages; a row of
//     a provider outside PUBLIC_DISPLAY_PROVIDERS never is; seo.browse off is
//     404 on both brands; CN_RECRUITMENT_INFO_MODE=off shows it on no route
//     (R41-1b); the brands never read each other's market;
//   - a job page carries the last-checked date; GoApply's carries GoHire's
//     licence on a GoHire bank posting only when both env values are set;
//   - visa-sponsorship browse pages are RoboApply's: 404 on GoApply, never in
//     its hub or roles sitemap;
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
  seoJob({ id: 'job_gh', market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', title: '产品经理', companyName: '示例科技', location: '上海', locationCountry: 'CN', locationCity: '上海', taxonomyIds: ['product', 'product_management', 'product_manager'] }),
  // A cn row of a provider that is not in PUBLIC_DISPLAY_PROVIDERS: never public.
  seoJob({ id: 'job_cn_board', market: 'cn', fromRecruiterBank: false, sourceBoard: 'greenhouse', sourceName: 'Example careers', title: 'CN BOARD ROW', companyName: '未列出的来源', locationCountry: 'CN', locationCity: '北京' }),
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

describe('GoApply: the same gates as RoboApply (D5)', () => {
  const OFF = { ...ENV, CN_RECRUITMENT_INFO_MODE: 'off' };

  it('a listable cn posting has a public job page, with no CN_ switch set', async () => {
    const res = await h.request<{ data: { job: Record<string, unknown> } }>('GET', `${BASE}/jobs/job_gh`, { host: GA });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(SEO_CACHE_CONTROL);
    // A CJK title has no ASCII slug: the canonical path is the id alone.
    expect(res.body.data.job).toMatchObject({ id: 'job_gh', title: '产品经理', companyName: '示例科技', canonicalPath: '/job/job_gh' });
    // Mainland display rule: the date we last found the posting at its source. No licence is configured: none is sent.
    expect(res.body.data.job).toMatchObject({ lastVerifiedAt: '2026-10-01T00:00:00.000Z', licence: null, sourceName: 'GoHire' });
  });

  it('the licence line: a GoHire bank posting on GoApply, only when holder and number are both set; never on another source or on RoboApply', async () => {
    const licence = { holder: '示例人力资源有限公司', number: '(沪)人服证字[2026]第0100001号' };
    const read = async (env: Record<string, string>, id: string, host: string) => {
      const hh = await harness(deps({}, env), env);
      try {
        const res = await hh.request<{ data: { job: { licence: unknown; lastVerifiedAt: unknown } } }>('GET', `${BASE}/jobs/${id}`, { host });
        expect(res.status, `${id} ${host}`).toBe(200);
        return res.body.data.job;
      } finally {
        await hh.close();
      }
    };
    const both = { ...ENV, PUBLIC_DISPLAY_PROVIDERS: 'ats_public', CN_HR_LICENCE_HOLDER: licence.holder, CN_HR_LICENCE_NUMBER: licence.number };
    expect((await read(both, 'job_gh', GA)).licence).toEqual(licence);
    // An employer-board posting is not GoHire's: the last-checked date, no licence.
    expect(await read(both, 'job_cn_board', GA)).toMatchObject({ licence: null, lastVerifiedAt: '2026-10-01T00:00:00.000Z' });
    // Half a licence is no licence (D3).
    expect((await read({ ...ENV, CN_HR_LICENCE_HOLDER: licence.holder }, 'job_gh', GA)).licence).toBeNull();
    // RoboApply never prints it, whatever GoApply has configured.
    expect(await read(both, 'job1', RA)).toMatchObject({ licence: null, lastVerifiedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('visa-sponsorship browse pages are RoboApply\'s: 404 on GoApply, and a stored one is in neither its hub nor its roles sitemap', async () => {
    const quoted = { sponsorship: 'offered', sponsorshipEvidence: 'Visa sponsorship is available.', taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'] };
    const r = createMemorySeoRepo(
      [
        ...seoJobs(6, { ...quoted, market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', locationCountry: 'CN', locationCity: '上海', location: '上海' }),
        ...seoJobs(6, { ...quoted, locationCountry: 'US', locationCity: 'Austin', location: 'Austin' }),
      ],
      (['goapply', 'roboapply'] as const).flatMap((brand) => [
        { brand, locale: 'x', type: 'sponsorship_role', slug: 'cn/backend-engineer', params: { taxonomyId: 'backend_engineer', country: brand === 'goapply' ? 'CN' : 'US', segment: 'visa-sponsorship' }, title: 't', h1: 't', intro: '', stats: {}, jobCount: 6, indexable: true, lastBuiltAt: NOW },
        { brand, locale: 'x', type: 'role', slug: 'backend-engineer', params: { taxonomyId: 'backend_engineer' }, title: 't', h1: 't', intro: '', stats: {}, jobCount: 6, indexable: true, lastBuiltAt: NOW },
      ]),
    );
    const hh = await harness({ env: ENV, service: createSeoService({ repo: r, env: ENV, now: () => NOW, isEnabled: async () => true }), limit: async () => undefined });
    try {
      const cn = await hh.request<Body>('GET', `${BASE}/page?path=visa-sponsorship/cn/backend-engineer`, { host: GA });
      expect(cn.status).toBe(404);
      expect(cn.body.code).toBe('not_found');
      // The role page over the same rows is live on GoApply.
      expect((await hh.request<Body>('GET', `${BASE}/page?path=backend-engineer`, { host: GA })).status).toBe(200);
      const kinds = async (host: string) => ((await hh.request<{ data: { pages: Array<{ kind: string }> } }>('GET', `${BASE}/hub`, { host })).body.data.pages.map((p) => p.kind).sort());
      expect(await kinds(GA)).toEqual(['role']);
      expect(await kinds(RA)).toEqual(['role', 'sponsorship']);
      const paths = async (host: string) => ((await hh.request<{ data: { urls: Array<{ path: string }> } }>('GET', `${BASE}/sitemap/roles-1`, { host })).body.data.urls.map((u) => u.path).sort());
      expect(await paths(GA)).toEqual(['/browse/backend-engineer']);
      expect(await paths(RA)).toEqual(['/browse/backend-engineer', '/browse/visa-sponsorship/us/backend-engineer']);
      // RoboApply keeps its sponsorship pages.
      const us = await hh.request<Body>('GET', `${BASE}/page?path=visa-sponsorship/us/backend-engineer`, { host: RA });
      expect(us.status).toBe(200);
      expect((us.body.data as Record<string, any>).type).toBe('sponsorship_role');
    } finally {
      await hh.close();
    }
  });

  it('it appears in the cn ticker and the cn sitemap; RoboApply rows do not', async () => {
    const ticker = await h.request<{ data: { items: Array<{ id: string; path: string }> } }>('GET', `${BASE}/ticker`, { host: GA });
    expect(ticker.status).toBe(200);
    expect(ticker.body.data.items).toEqual([expect.objectContaining({ id: 'job_gh', path: '/job/job_gh' })]);
    const idx = await h.request<{ data: { parts: Array<{ name: string; count: number }>; surfaces: { browse: boolean } } }>('GET', `${BASE}/sitemap`, { host: GA });
    expect(idx.body.data.parts).toEqual([{ name: 'jobs-1', count: 1, lastmod: null }]);
    expect(idx.body.data.surfaces.browse).toBe(true);
    const part = await h.request<{ data: { urls: Array<{ path: string }> } }>('GET', `${BASE}/sitemap/jobs-1`, { host: GA });
    expect(part.status).toBe(200);
    expect(part.body.data.urls.map((u) => u.path)).toEqual(['/job/job_gh']);
  });

  it('browse pages and the hub answer on GoApply over cn rows only', async () => {
    const page = await h.request<Body>('GET', `${BASE}/page?path=product-manager`, { host: GA });
    expect(page.status).toBe(200);
    const d = page.body.data as Record<string, any>;
    expect(d.stats.jobCount).toMatchObject({ value: 1, source: 'index' });
    expect(d.jobs.map((j: { title: string }) => j.title)).toEqual(['产品经理']);
    // Every public card carries the source and the date we last found the posting there.
    expect(d.jobs[0]).toMatchObject({ sourceName: 'GoHire', lastVerifiedAt: '2026-10-01T00:00:00.000Z' });
    // One job is below the floor: the page renders and is noindex, exactly as on RoboApply.
    expect(d.indexable).toBe(false);
    const hub = await h.request<Body>('GET', `${BASE}/hub`, { host: GA });
    expect(hub.status).toBe(200);
    expect(hub.body.data).toMatchObject({ pages: [] });
    // The backend rows are intl rows: none of them is counted on GoApply.
    const other = await h.request<Body>('GET', `${BASE}/page?path=backend-engineer`, { host: GA });
    expect((other.body.data as Record<string, any>).stats.jobCount.value).toBe(0);
  });

  it('a row from a provider outside PUBLIC_DISPLAY_PROVIDERS is on no GoApply route; listing the provider opens it', async () => {
    const job = await h.request<Body>('GET', `${BASE}/jobs/job_cn_board`, { host: GA });
    expect(job.status).toBe(404);
    const ticker = await h.request<Body>('GET', `${BASE}/ticker`, { host: GA });
    const part = await h.request<Body>('GET', `${BASE}/sitemap/jobs-1`, { host: GA });
    expect(JSON.stringify([job.body, ticker.body, part.body])).not.toMatch(/CN BOARD ROW|job_cn_board/);

    const env = { ...ENV, PUBLIC_DISPLAY_PROVIDERS: 'ats_public' };
    const listed = await harness(deps({}, env), env);
    try {
      expect((await listed.request<Body>('GET', `${BASE}/jobs/job_cn_board`, { host: GA })).status).toBe(200);
      const t = await listed.request<{ data: { items: Array<{ id: string }> } }>('GET', `${BASE}/ticker`, { host: GA });
      expect(t.body.data.items.map((i) => i.id).sort()).toEqual(['job_cn_board', 'job_gh']);
    } finally {
      await listed.close();
    }
  });

  it('seo.browse off: /page and /hub are 404 feature_disabled on both brands; job pages do not depend on it', async () => {
    const env = { INTERNAL_API_SECRET: 'internal-secret' };
    // The real flag resolver (registry default: off on both brands).
    const off = await startRouteHarness({ env, mounts: [[BASE, createSeoPublicRouter({ env, service: createSeoService({ repo, env, now: () => NOW }), limit: async () => undefined })]] });
    try {
      for (const host of [RA, GA]) {
        for (const p of ['/page?path=backend-engineer', '/hub']) {
          const res = await off.request<Body>('GET', `${BASE}${p}`, { host });
          expect(res.status, `${host} ${p}`).toBe(404);
          expect(res.body.code, `${host} ${p}`).toBe('feature_disabled');
        }
        const idx = await off.request<{ data: { parts: Array<{ name: string }>; surfaces: { browse: boolean; alerts: boolean } } }>('GET', `${BASE}/sitemap`, { host });
        expect(idx.body.data.surfaces.browse, host).toBe(false);
        // Signed-out job alerts are on by default on both brands: /tools/job-alerts may be listed and indexed.
        expect(idx.body.data.surfaces.alerts, host).toBe(true);
        expect(idx.body.data.parts.map((x) => x.name), host).toEqual(['jobs-1']);
        expect((await off.request<Body>('GET', `${BASE}/sitemap/roles-1`, { host })).status, host).toBe(404);
      }
      expect((await off.request<Body>('GET', `${BASE}/jobs/job_gh`, { host: GA })).status).toBe(200);
      expect((await off.request<Body>('GET', `${BASE}/jobs/job1`, { host: RA })).status).toBe(200);
    } finally {
      await off.close();
    }
  });

  it('CN_RECRUITMENT_INFO_MODE=off: the posting appears on no route; ticker and sitemap answer empty [R41-1b]', async () => {
    const off = await harness(deps({}, OFF), OFF);
    try {
      for (const p of ['/jobs/job_gh', '/page?path=product-manager', '/hub']) {
        const res = await off.request<Body>('GET', `${BASE}${p}`, { host: GA });
        expect(res.status, p).toBe(404);
        expect(res.body.code, p).toBe('feature_disabled');
        expect(res.text, p).not.toContain('产品经理');
      }
      const ticker = await off.request<Body>('GET', `${BASE}/ticker`, { host: GA });
      expect(ticker.status).toBe(200);
      expect(ticker.body.data).toMatchObject({ items: [] });
      const sitemap = await off.request<Body>('GET', `${BASE}/sitemap`, { host: GA });
      expect(sitemap.body.data).toMatchObject({ parts: [], surfaces: { browse: false } });
      expect((await off.request<Body>('GET', `${BASE}/sitemap/jobs-1`, { host: GA })).status).toBe(404);
      expect(JSON.stringify([ticker.body, sitemap.body])).not.toContain('产品经理');
      // The switch is GoApply's: RoboApply answers as before.
      expect((await off.request<Body>('GET', `${BASE}/jobs/job1`, { host: RA })).status).toBe(200);
      expect((await off.request<{ data: { items: unknown[] } }>('GET', `${BASE}/ticker`, { host: RA })).body.data.items.length).toBeGreaterThan(0);
    } finally {
      await off.close();
    }
  });

  it('surfaces.alerts follows the brand\'s jobs.alerts capability (its off switches included)', async () => {
    const alertsOn = async (env: Record<string, string>, host: string) => {
      const hh = await startRouteHarness({ env, mounts: [[BASE, createSeoPublicRouter({ env, service: createSeoService({ repo, env, now: () => NOW }), limit: async () => undefined })]] });
      try {
        return (await hh.request<{ data: { surfaces: { alerts: boolean } } }>('GET', `${BASE}/sitemap`, { host })).body.data.surfaces.alerts;
      } finally {
        await hh.close();
      }
    };
    expect(await alertsOn({}, GA)).toBe(true);
    expect(await alertsOn({ CN_RECRUITMENT_INFO_MODE: 'off' }, GA)).toBe(false);
    expect(await alertsOn({ FLAG_GOAPPLY_JOBS_ALERTS: 'false' }, GA)).toBe(false);
    // GoApply's switches do not reach RoboApply, and RoboApply has its own.
    expect(await alertsOn({ CN_RECRUITMENT_INFO_MODE: 'off', FLAG_GOAPPLY_JOBS_ALERTS: 'false' }, RA)).toBe(true);
    expect(await alertsOn({ FLAG_ROBOAPPLY_JOBS_ALERTS: 'false' }, RA)).toBe(false);
  });

  it('the per-IP limit covers GoApply reads too', async () => {
    const limited = await harness(deps({ limit: async () => { throw new HttpError('rate_limited', undefined, { retryAfterSec: 30 }); } }));
    try {
      for (const p of ['/ticker', '/sitemap', '/sitemap/jobs-1', '/jobs/job_gh']) {
        const res = await limited.request<Body>('GET', `${BASE}${p}`, { host: GA });
        expect(res.status, p).toBe(429);
        expect(res.headers.get('cache-control'), p).toBe('no-store');
      }
    } finally {
      await limited.close();
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
