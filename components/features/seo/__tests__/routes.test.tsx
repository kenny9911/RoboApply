// @vitest-environment node
// WP-56 route files: robots / sitemap index / sitemaps / llms.txt per host
// (snapshots for both hosts), the secret-gated revalidate route, and the
// browse and job pages (GoApply deferred → 404, canonical 301, noindex below
// the floor, unknown role, JobPosting JSON-LD).

import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  brand: { id: 'roboapply' as 'roboapply' | 'goapply' },
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  revalidateTag: vi.fn(),
  api: {
    loadBrowsePage: vi.fn(),
    loadBrowseHub: vi.fn(),
    loadPublicJob: vi.fn(),
    loadSitemapIndex: vi.fn(),
    loadSitemapPart: vi.fn(),
    loadTicker: vi.fn(),
    visitorIpFrom: (get: (n: string) => string | null) => get('x-real-ip'),
  },
  headers: new Map<string, string>([['x-real-ip', '198.51.100.7']]),
}));

vi.mock('next/navigation', () => ({ notFound: h.notFound, permanentRedirect: h.permanentRedirect, redirect: vi.fn(), usePathname: () => '/', useRouter: () => ({}), useSearchParams: () => null }));
vi.mock('next/cache', () => ({ revalidateTag: h.revalidateTag, unstable_cache: (fn: unknown) => fn }));
vi.mock('../../../../lib/server/brand', () => ({ getServerBrandId: async () => h.brand.id }));
vi.mock('../../../../lib/server/publicApi', () => h.api);
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (n: string) => h.headers.get(n) ?? null }),
  cookies: async () => ({ get: () => undefined }),
}));

import robots from '../../../../app/robots';
import { GET as sitemapIndex } from '../../../../app/sitemap.xml/route';
import { GET as sitemapFile } from '../../../../app/sitemaps/[file]/route';
import { GET as llms } from '../../../../app/llms.txt/route';
import { POST as revalidate } from '../../../../app/api/revalidate/route';
import BrowseRoute, { generateMetadata as browseMetadata } from '../../../../app/browse/[...path]/page';
import JobRoute, { generateMetadata as jobMetadata } from '../../../../app/job/[idSlug]/page';
import { JsonLd } from '../../../features/marketing';
import { VisitorFeed } from '../../../features/visitor';
import { BrowsePage } from '../BrowsePage';
import { BrowseUnknown } from '../BrowseHub';
import { JobPage } from '../JobPage';
import { JobTicker } from '../JobTicker';
import { JobTickerView } from '../JobTickerView';
import { TICKER, job, page } from './fixtures';

const ok = <T,>(data: T) => ({ status: 'ok' as const, data });
type El = React.ReactElement<{ children?: unknown; json?: string; data?: unknown; query?: unknown; job?: unknown }>;
const kids = (el: El): El[] => (Array.isArray(el.props.children) ? (el.props.children as El[]) : [el.props.children as El]).filter(Boolean);

beforeEach(() => {
  h.brand.id = 'roboapply';
  for (const fn of Object.values(h.api)) if ('mockReset' in fn) fn.mockReset();
  h.api.loadSitemapIndex.mockResolvedValue(ok({ parts: [{ name: 'roles-1', count: 3, lastmod: null }, { name: 'jobs-1', count: 9, lastmod: null }], surfaces: { browse: true, campus: true } }));
  h.notFound.mockClear();
  h.permanentRedirect.mockClear();
  h.revalidateTag.mockClear();
});
afterEach(() => {
  delete process.env.INTERNAL_API_SECRET;
});

describe.each(['roboapply', 'goapply'] as const)('crawl files on the %s host', (brand) => {
  beforeEach(() => {
    h.brand.id = brand;
    if (brand === 'goapply') h.api.loadSitemapIndex.mockResolvedValue(ok({ parts: [], surfaces: { browse: false, campus: true } }));
  });

  it('robots.txt', async () => {
    expect(await robots()).toMatchSnapshot();
  });

  it('sitemap.xml', async () => {
    const res = await sitemapIndex();
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600');
    expect(await res.text()).toMatchSnapshot();
  });

  it('sitemaps/static.xml', async () => {
    const res = await sitemapFile(new Request('https://x/'), { params: Promise.resolve({ file: 'static.xml' }) });
    const xml = await res.text();
    expect(xml).toMatchSnapshot();
    const own = brand === 'goapply' ? 'https://www.goapply.top/' : 'https://www.roboapply.io/';
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) expect(m[1]!.startsWith(own)).toBe(true);
  });

  it('llms.txt', async () => {
    const res = await llms();
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toMatchSnapshot();
    expect(text).not.toMatch(/auto[- ]?apply/i);
  });
});

// INT-06 (wave4 WP-93 #13, wave5 WP-93 #30): tools in /sitemaps/static.xml per brand and stage.
describe('sitemaps/static.xml — free tools', () => {
  const staticLocs = async () => {
    const res = await sitemapFile(new Request('https://x/'), { params: Promise.resolve({ file: 'static.xml' }) });
    return [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  };
  afterEach(() => {
    delete process.env.DEPLOY_REGION;
  });

  it('RoboApply: /tools, /tools/resume-check, /tools/resume-job-match and /tools/job-alerts', async () => {
    const locs = await staticLocs();
    for (const p of ['/tools', '/tools/resume-check', '/tools/resume-job-match', '/tools/job-alerts', '/help/ranking']) expect(locs).toContain(`https://www.roboapply.io${p}`);
  });

  it('GoApply while CN-0 (offshore stack): /tools only', async () => {
    h.brand.id = 'goapply';
    h.api.loadSitemapIndex.mockResolvedValue(ok({ parts: [], surfaces: { browse: false, campus: true } }));
    const locs = await staticLocs();
    expect(locs).toContain('https://www.goapply.top/tools');
    for (const p of ['/tools/resume-check', '/tools/resume-job-match', '/tools/job-alerts']) expect(locs).not.toContain(`https://www.goapply.top${p}`);
  });

  it('GoApply on the mainland stack (CN-1): the two tool pages are listed, job alerts still are not', async () => {
    h.brand.id = 'goapply';
    process.env.DEPLOY_REGION = 'cn-mainland';
    h.api.loadSitemapIndex.mockResolvedValue(ok({ parts: [], surfaces: { browse: false, campus: true } }));
    const locs = await staticLocs();
    for (const p of ['/tools', '/tools/resume-check', '/tools/resume-job-match']) expect(locs).toContain(`https://www.goapply.top${p}`);
    expect(locs).not.toContain('https://www.goapply.top/tools/job-alerts');
  });

  it('there is no campus-<n> partition (the campus API lists programmes, not URLs)', async () => {
    h.brand.id = 'goapply';
    expect((await sitemapFile(new Request('https://x/'), { params: Promise.resolve({ file: 'campus-1.xml' }) })).status).toBe(404);
    expect(h.api.loadSitemapPart).not.toHaveBeenCalled();
  });
});

// INT-06 (wave4 WP-93 #13): the server ticker shows real jobs or nothing.
describe('<JobTicker /> (server)', () => {
  it('renders the view with the public jobs the API returned', async () => {
    h.api.loadTicker.mockResolvedValue(ok({ items: TICKER }));
    const el = (await JobTicker()) as React.ReactElement<{ items: unknown[]; now: string }> | null;
    expect(el?.type).toBe(JobTickerView);
    expect(el?.props.items).toEqual(TICKER);
    expect(Number.isNaN(Date.parse(el!.props.now))).toBe(false);
    expect(h.api.loadTicker).toHaveBeenCalledWith('roboapply');
  });

  it('renders nothing when there are no public jobs, when the API is unavailable, or when the read throws', async () => {
    h.api.loadTicker.mockResolvedValue(ok({ items: [] }));
    expect(await JobTicker()).toBeNull();
    h.api.loadTicker.mockResolvedValue({ status: 'not_found', reason: null });
    expect(await JobTicker()).toBeNull();
    h.api.loadTicker.mockRejectedValue(new Error('down'));
    expect(await JobTicker()).toBeNull();
  });
});

describe('sitemap partitions', () => {
  it('serves a partition from the API with absolute URLs on the brand origin', async () => {
    h.api.loadSitemapPart.mockResolvedValue(ok({ urls: [{ path: '/browse/backend-engineer', lastmod: '2026-10-10T04:00:00.000Z' }] }));
    const res = await sitemapFile(new Request('https://x/'), { params: Promise.resolve({ file: 'roles-1.xml' }) });
    expect(h.api.loadSitemapPart).toHaveBeenCalledWith('roboapply', 'roles-1');
    expect(await res.text()).toContain('<loc>https://www.roboapply.io/browse/backend-engineer</loc>');
  });

  it('unknown file → 404; missing partition → 404; API down → 503 no-store', async () => {
    expect((await sitemapFile(new Request('https://x/'), { params: Promise.resolve({ file: 'evil.xml' }) })).status).toBe(404);
    h.api.loadSitemapPart.mockResolvedValue({ status: 'not_found', reason: null });
    expect((await sitemapFile(new Request('https://x/'), { params: Promise.resolve({ file: 'jobs-9.xml' }) })).status).toBe(404);
    h.api.loadSitemapPart.mockRejectedValue(new Error('down'));
    const down = await sitemapFile(new Request('https://x/'), { params: Promise.resolve({ file: 'jobs-1.xml' }) });
    expect(down.status).toBe(503);
    expect(down.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/revalidate', () => {
  const post = (body: unknown, secret?: string) =>
    revalidate(new Request('https://x/api/revalidate', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-ra-internal': secret } : {}) }, body: JSON.stringify(body) }));

  it('refuses without the shared secret, or when none is configured', async () => {
    expect((await post({ tags: ['seo:roboapply:role:x'] }, 's')).status).toBe(401);
    process.env.INTERNAL_API_SECRET = 's';
    expect((await post({ tags: ['seo:roboapply:role:x'] })).status).toBe(401);
    expect((await post({ tags: ['seo:roboapply:role:x'] }, 'wrong')).status).toBe(401);
    expect(h.revalidateTag).not.toHaveBeenCalled();
  });

  it('accepts only seo:<brand>:<type>:<slug> tags and revalidates each once (profile max)', async () => {
    process.env.INTERNAL_API_SECRET = 's';
    expect((await post({ tags: ['users'] }, 's')).status).toBe(422);
    expect((await post({ tags: [] }, 's')).status).toBe(422);
    const res = await post({ tags: ['seo:roboapply:role_city:backend-engineer/taipei', 'seo:roboapply:role_city:backend-engineer/taipei', 'seo:goapply:hub:all'] }, 's');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.revalidateTag.mock.calls).toEqual([
      ['seo:roboapply:role_city:backend-engineer/taipei', 'max'],
      ['seo:goapply:hub:all', 'max'],
    ]);
  });
});

describe('/browse/[...path]', () => {
  const props = (path: string[], search: Record<string, string> = {}) => ({ params: Promise.resolve({ path }), searchParams: Promise.resolve(search) });

  it('renders the list, breadcrumbs JSON-LD and the VisitorFeed seam', async () => {
    h.api.loadBrowsePage.mockResolvedValue(ok(page()));
    const el = (await BrowseRoute(props(['backend-engineer', 'taipei']))) as El;
    const children = kids(el);
    expect(children.find((c) => c.type === BrowsePage)?.props.data).toMatchObject({ path: '/browse/backend-engineer/taipei' });
    expect(children.find((c) => c.type === VisitorFeed)?.props.query).toEqual({ role: 'Backend engineer', city: 'Taipei', country: 'TW' });
    const json = JSON.parse(children.find((c) => c.type === JsonLd)!.props.json!);
    expect(json['@graph'][0]['@type']).toBe('BreadcrumbList');
    const meta = await browseMetadata(props(['backend-engineer', 'taipei']));
    expect(meta.alternates?.canonical).toBe('https://www.roboapply.io/browse/backend-engineer/taipei');
    expect(meta.robots).toMatchObject({ index: true });
    expect(String(meta.title)).toBe('Backend engineer jobs in Taipei | RoboApply');
  });

  it('below the floor (or a ?country view) → noindex, canonical stays the base path', async () => {
    h.api.loadBrowsePage.mockResolvedValue(ok(page({ indexable: false, country: 'US' })));
    const meta = await browseMetadata(props(['backend-engineer'], { country: 'us' }));
    expect(meta.robots).toMatchObject({ index: false });
    expect(meta.alternates?.canonical).toBe('https://www.roboapply.io/browse/backend-engineer/taipei');
    // The visitor's IP goes with the read (counted by the API's per-IP limit on a cache miss, F-TRUST-02).
    expect(h.api.loadBrowsePage).toHaveBeenCalledWith('roboapply', ['backend-engineer'], 'us', { clientIp: '198.51.100.7' });
  });

  it('a non-canonical path 301s to the canonical one', async () => {
    h.api.loadBrowsePage.mockResolvedValue(ok(page({ redirect: true })));
    await expect(BrowseRoute(props(['backend_engineer', 'taipei']))).rejects.toThrow('NEXT_REDIRECT /browse/backend-engineer/taipei');
  });

  it('unknown role → noindex page that points at the real lists', async () => {
    h.api.loadBrowsePage.mockResolvedValue({ status: 'not_found', reason: 'unknown_role' });
    h.api.loadBrowseHub.mockResolvedValue(ok({ pages: [{ kind: 'role', path: '/browse/backend-engineer', jobCount: null }], asOf: '' }));
    const el = (await BrowseRoute(props(['underwater-basket-weaver']))) as El;
    expect(kids(el).find((c) => c.type === BrowseUnknown)?.props).toMatchObject({ query: { kind: 'role', role: 'underwater basket weaver', city: null } });
    expect(kids(el).find((c) => c.type === VisitorFeed)?.props.query).toEqual({ role: 'underwater basket weaver' });
    expect((await browseMetadata(props(['underwater-basket-weaver']))).robots).toMatchObject({ index: false });
  });

  it('unknown city → names the city; the visitor feed searches the role, not the city', async () => {
    h.api.loadBrowsePage.mockResolvedValue({ status: 'not_found', reason: 'unknown_city' });
    h.api.loadBrowseHub.mockResolvedValue(ok({ pages: [], asOf: '' }));
    const el = (await BrowseRoute(props(['backend-engineer', 'atlantis']))) as El;
    expect(kids(el).find((c) => c.type === BrowseUnknown)?.props).toMatchObject({ query: { kind: 'city', role: 'backend engineer', city: 'atlantis' } });
    expect(kids(el).find((c) => c.type === VisitorFeed)?.props.query).toEqual({ role: 'backend engineer' });
    // An unknown role in a role × city path is still the role.
    h.api.loadBrowsePage.mockResolvedValue({ status: 'not_found', reason: 'unknown_role' });
    const el2 = (await BrowseRoute(props(['zzqx', 'taipei']))) as El;
    expect(kids(el2).find((c) => c.type === BrowseUnknown)?.props).toMatchObject({ query: { kind: 'role', role: 'zzqx' } });
  });

  it('GoApply (deferred), flag off and other misses → 404', async () => {
    h.brand.id = 'goapply';
    await expect(BrowseRoute(props(['backend-engineer']))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.api.loadBrowsePage).not.toHaveBeenCalled();
    h.brand.id = 'roboapply';
    h.api.loadBrowsePage.mockResolvedValue({ status: 'disabled' });
    await expect(BrowseRoute(props(['backend-engineer']))).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('/job/[idSlug]', () => {
  const props = (idSlug: string) => ({ params: Promise.resolve({ idSlug }) });

  it('renders the job with JobPosting JSON-LD and canonical metadata', async () => {
    h.api.loadPublicJob.mockResolvedValue(ok({ job: job() }));
    const el = (await JobRoute(props('cmjob1-backend-engineer-acme'))) as El;
    const children = kids(el);
    expect(children.find((c) => c.type === JobPage)?.props.job).toMatchObject({ id: 'cmjob1' });
    const json = JSON.parse(children.find((c) => c.type === JsonLd)!.props.json!);
    expect(json['@graph'].map((n: { '@type': string }) => n['@type'])).toEqual(['JobPosting', 'BreadcrumbList']);
    const meta = await jobMetadata(props('cmjob1-backend-engineer-acme'));
    expect(meta.alternates?.canonical).toBe('https://www.roboapply.io/job/cmjob1-backend-engineer-acme');
    expect(String(meta.title)).toBe('Backend Engineer at Acme | RoboApply');
    expect(h.api.loadPublicJob).toHaveBeenCalledWith('roboapply', 'cmjob1', { clientIp: '198.51.100.7' });
  });

  it('a wrong slug 301s to the canonical path', async () => {
    h.api.loadPublicJob.mockResolvedValue(ok({ job: job() }));
    await expect(JobRoute(props('cmjob1-old-title'))).rejects.toThrow('NEXT_REDIRECT /job/cmjob1-backend-engineer-acme');
  });

  it('closed (410 from the API), not public, bad id, GoApply → not found', async () => {
    h.api.loadPublicJob.mockResolvedValue({ status: 'gone' });
    await expect(JobRoute(props('cmjob1-x'))).rejects.toThrow('NEXT_NOT_FOUND');
    h.api.loadPublicJob.mockResolvedValue({ status: 'not_found', reason: null });
    await expect(JobRoute(props('cmjob1-x'))).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(JobRoute(props('%3Cscript%3E'))).rejects.toThrow('NEXT_NOT_FOUND');
    h.brand.id = 'goapply';
    h.api.loadPublicJob.mockClear();
    await expect(JobRoute(props('cmjob1-x'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.api.loadPublicJob).not.toHaveBeenCalled();
    expect((await jobMetadata(props('cmjob1-x'))).robots).toMatchObject({ index: false });
  });
});
