// WP-58 — the /campus route files: capability off (API 404 feature_disabled)
// ⇒ the page 404s (R-04); otherwise the first page is server-rendered and the
// unfiltered calendar is indexable. Plus the server read helper itself
// (next/headers and fetch mocked; no network).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ list: vi.fn(), company: vi.fn(), meta: vi.fn() }));
vi.mock('../serverData', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readCampusList: reads.list,
  readCampusCompany: reads.company,
  campusMetadata: reads.meta,
}));
const nav = vi.hoisted(() => ({ notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }) }));
vi.mock('next/navigation', () => ({ notFound: nav.notFound, useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/campus', useSearchParams: () => new URLSearchParams() }));
const hdrs = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => hdrs.map.get(k.toLowerCase()) ?? null }),
  cookies: async () => ({ get: () => undefined }),
}));

import CampusPage, { generateMetadata } from '../../../../app/campus/page';
import CampusCompanyPage from '../../../../app/campus/[company]/page';
import { campusSearch, readPublicCampus, trustedApiOrigin } from '../serverData';

const LIST = { items: [], cursor: null, asOf: '2026-10-10T00:00:00.000Z' };

beforeEach(() => {
  reads.list.mockReset();
  reads.company.mockReset();
  reads.meta.mockReset().mockResolvedValue({});
  nav.notFound.mockClear();
});

describe('/campus page', () => {
  it('404s when the capability is off', async () => {
    reads.list.mockResolvedValue({ status: 'disabled' });
    await expect(CampusPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('renders with the server read and passes the URL filter', async () => {
    reads.list.mockResolvedValue({ status: 'ok', data: LIST });
    const el = await CampusPage({ searchParams: Promise.resolve({ class: '2027', openNow: 'true', city: ['上海', 'x'] }) });
    expect(reads.list).toHaveBeenCalledWith(`?class=2027&city=${encodeURIComponent('上海')}&openNow=true`);
    expect(el).toBeTruthy();
    expect(nav.notFound).not.toHaveBeenCalled();
  });
  it('GoApply default (no CN_ switch): an empty calendar answers the page, with the server-read empty list handed to the client', async () => {
    reads.list.mockResolvedValue({ status: 'ok', data: LIST });
    const el = (await CampusPage({ searchParams: Promise.resolve({}) })) as { props: { children: { props: { initial: unknown; filter: unknown } } } };
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(reads.list).toHaveBeenCalledWith('');
    // The calendar gets the empty list and no filter: it renders the "being put together" state.
    expect(el.props.children.props).toMatchObject({ initial: LIST, filter: {} });
  });
  it('a failed read still renders (the client shows the error), never a 404', async () => {
    reads.list.mockResolvedValue({ status: 'error' });
    await expect(CampusPage({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
  });
  it('indexes only the unfiltered, readable calendar', async () => {
    reads.list.mockResolvedValue({ status: 'ok', data: LIST });
    await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(reads.meta).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/campus', indexable: true }));
    await generateMetadata({ searchParams: Promise.resolve({ class: '2027' }) });
    expect(reads.meta).toHaveBeenLastCalledWith(expect.objectContaining({ indexable: false }));
    reads.list.mockResolvedValue({ status: 'disabled' });
    await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(reads.meta).toHaveBeenLastCalledWith(expect.objectContaining({ indexable: false }));
  });
});

describe('/campus/[company] page', () => {
  it('404s for an unknown company or the capability off', async () => {
    reads.company.mockResolvedValue({ status: 'not_found' });
    await expect(CampusCompanyPage({ params: Promise.resolve({ company: 'nobody' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    reads.company.mockResolvedValue({ status: 'disabled' });
    await expect(CampusCompanyPage({ params: Promise.resolve({ company: 'x' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('decodes the slug', async () => {
    reads.company.mockResolvedValue({ status: 'ok', data: { ...LIST, companyName: '示例科技', companySlug: '示例科技' } });
    await CampusCompanyPage({ params: Promise.resolve({ company: encodeURIComponent('示例科技') }) });
    expect(reads.company).toHaveBeenCalledWith('示例科技');
  });
});

describe('serverData', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    hdrs.map.clear();
    vi.unstubAllEnvs();
  });

  it('campusSearch keeps only valid filters', () => {
    expect(campusSearch({ class: '1999', role: '  产品 ', openNow: 'yes' })).toEqual({ role: '产品' });
    expect(campusSearch({ class: '2027', openNow: 'true' })).toEqual({ class: 2027, openNow: true });
  });

  it('forwards the visitor host and brand; maps 404 feature_disabled to disabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4621');
    hdrs.map.set('host', 'goapply.localhost:3621');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: false, code: 'feature_disabled' }), { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(readPublicCampus('/api/v1/public/campus')).resolves.toEqual({ status: 'disabled' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:4621/api/v1/public/campus');
    expect((init.headers as Record<string, string>)['x-forwarded-host']).toBe('goapply.localhost:3621');
  });

  it('only fetches from a configured origin or a known brand host (spoofed Host is never an origin)', async () => {
    const prod = { NODE_ENV: 'production' };
    expect(trustedApiOrigin('evil.example.com', prod)).toBeNull();
    expect(trustedApiOrigin('evil.example.com', { ...prod, VERCEL_URL: 'roboapply-abc.vercel.app' })).toBe('https://roboapply-abc.vercel.app');
    expect(trustedApiOrigin('www.goapply.top', prod)).toBe('https://www.goapply.top');
    expect(trustedApiOrigin('www.goapply.top:6379', prod)).toBe('https://www.goapply.top');
    expect(trustedApiOrigin('roboapply.io, evil.example.com', prod)).toBe('https://roboapply.io');
    expect(trustedApiOrigin('localhost:6379', prod)).toBeNull();
    expect(trustedApiOrigin('evil.localhost', { NODE_ENV: 'development' })).toBeNull();
    expect(trustedApiOrigin('goapply.localhost:3621', { NODE_ENV: 'development' })).toBe('http://goapply.localhost:3621');
    expect(trustedApiOrigin('staging.example.com', { ...prod, BRAND_HOST_MAP: 'staging.example.com=goapply' })).toBe('https://staging.example.com');
    expect(trustedApiOrigin('evil.example.com', { ...prod, INTERNAL_API_ORIGIN: 'https://api.internal/' })).toBe('https://api.internal');
    expect(trustedApiOrigin('evil.example.com/x?y', { NODE_ENV: 'development' })).toBeNull();
  });

  it('a spoofed host gets no server read (and still no network call)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    vi.stubEnv('INTERNAL_API_ORIGIN', '');
    vi.stubEnv('VERCEL_URL', '');
    hdrs.map.set('x-forwarded-host', 'attacker.example.com');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(readPublicCampus('/api/v1/public/campus')).resolves.toEqual({ status: 'error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ok, plain 404 and network failure', async () => {
    hdrs.map.set('host', 'www.goapply.top');
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: LIST }), { status: 200 })) as typeof fetch;
    await expect(readPublicCampus('/x')).resolves.toEqual({ status: 'ok', data: LIST });
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, code: 'not_found' }), { status: 404 })) as typeof fetch;
    await expect(readPublicCampus('/x')).resolves.toEqual({ status: 'not_found' });
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(readPublicCampus('/x')).resolves.toEqual({ status: 'error' });
  });
});
