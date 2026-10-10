// lib/server/publicApi.ts — SERVER-ONLY reads of the public SEO API for
// Next server components and route handlers (ARCHITECTURE.md §9.2; WP-56).
//
// Why not `fetch(…, { next: { revalidate, tags } })`: the root layout is
// `force-dynamic` (app/layout.tsx), which makes every fetch in pages
// `no-store`. So:
//   - each read is wrapped in `unstable_cache`, keyed by brand × page type ×
//     slug (the brand is always the first key part: two brands never share
//     an entry) and tagged `seo:<brand>:<type>:<slug>`; `seo-rebuild` calls
//     app/api/revalidate, which runs `revalidateTag` on the changed tags;
//   - the API is fetched through the brand's PUBLIC origin on Vercel
//     (production: `CANONICAL_ORIGIN` / `CN_CANONICAL_ORIGIN`, else the
//     registry origin; preview: `https://$VERCEL_URL`), so Vercel's CDN
//     honours the API's Cache-Control. Off Vercel (development, tests, a
//     local `next start`) it is NEXT_PUBLIC_API_URL or the local API, never
//     the live site. Every request sends `x-ra-brand` and a `brand=<id>`
//     query (separate CDN entries on shared preview hosts), plus
//     `x-ra-internal` when INTERNAL_API_SECRET is set;
//   - F-TRUST-02: the page loaders pass the visitor's IP, and a cache miss
//     forwards it as `x-ra-client-ip` (with the secret only), so the API's
//     persisted per-IP limit counts the visitor, not the Next server. A
//     visitor over the limit gets a 429 from the API, which throws here
//     (never cached) and the page shows its error boundary.
//
// Results: `ok` / `not_found` (with the API's reason) / `gone` (closed job,
// 410) / `disabled` (feature off) are cached; network, 429 and 5xx errors
// throw, so they are never cached and the page shows its error boundary.
//
// This is the only web file besides lib/api/** allowed to hold a raw
// `/api/v1/` path (scripts/check-api-boundary.mjs).

import { unstable_cache } from 'next/cache';

import { getBrand, type BrandId, type ProductBrand } from '../brand/registry.generated';
import { classifyBrowseSegments, parseJobIdSlug, seoCacheTag } from '../seo';
import type {
  PublicJobResponse,
  SeoHubResponse,
  SeoPageResponse,
  SitemapIndexResponse,
  SitemapPartResponse,
  TickerResponse,
} from '../api/contracts/seo';

const SEO_API = '/api/v1/public/seo';

/** Fallback lifetimes (seconds) on top of tag revalidation; match the API's s-maxage. */
export const PAGE_TTL = 900;
export const SITEMAP_TTL = 3600;
export const TICKER_TTL = 300;
/**
 * The home page's ticker is decoration: its read gives up after this long
 * (milliseconds) so a slow or hung API cannot hold the page. The other reads
 * are the page itself and keep the platform's own limits.
 */
export const TICKER_TIMEOUT_MS = 2500;

export type PublicResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_found'; reason: string | null }
  | { status: 'gone' }
  | { status: 'disabled' };

type Env = Record<string, string | undefined>;
export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; cache: 'no-store'; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Where the Next server reaches the API for this brand. */
export function publicApiOrigin(brand: ProductBrand, env: Env = process.env): string {
  const trim = (v: string) => v.replace(/\/+$/, '');
  const local = () => trim(env.NEXT_PUBLIC_API_URL?.trim() || 'http://localhost:4607');
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return local();
  // Off Vercel (a local `next start`): the configured API, never production by accident
  // (it would show live data and send this machine's INTERNAL_API_SECRET there).
  if (!env.VERCEL) return local();
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_URL) return `https://${trim(env.VERCEL_URL)}`;
  const configured = brand.market === 'cn' ? env.CN_CANONICAL_ORIGIN : env.CANONICAL_ORIGIN;
  return trim(configured?.trim() || brand.canonicalOrigin);
}

/** Visitor IP header the API trusts only together with a valid `x-ra-internal`. */
export const CLIENT_IP_HEADER = 'x-ra-client-ip';
const IP_SHAPE = /^[0-9A-Fa-f:.]{2,64}$/;

/**
 * The visitor's IP from the incoming request headers: `x-real-ip`, else the
 * first `x-forwarded-for` hop (Vercel sets both and overwrites client values).
 * Null when absent or not shaped like an IP.
 */
export function visitorIpFrom(get: (name: string) => string | null | undefined): string | null {
  const candidates = [get('x-real-ip'), get('x-forwarded-for')?.split(',')[0]];
  for (const raw of candidates) {
    const v = raw?.trim();
    if (v && IP_SHAPE.test(v)) return v;
  }
  return null;
}

export function publicApiHeaders(brand: ProductBrand, env: Env = process.env, clientIp?: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', 'x-ra-brand': brand.id };
  const secret = env.INTERNAL_API_SECRET?.trim();
  if (secret) {
    headers['x-ra-internal'] = secret;
    if (clientIp && IP_SHAPE.test(clientIp)) headers[CLIENT_IP_HEADER] = clientIp;
  }
  return headers;
}

/** Per-request context for a loader: the visitor the read is made for (F-TRUST-02). */
export interface LoadContext {
  clientIp?: string | null;
}

export function publicApiUrl(brand: ProductBrand, path: string, query: Record<string, string | undefined> = {}, env: Env = process.env): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, v);
  params.set('brand', brand.id);
  return `${publicApiOrigin(brand, env)}${SEO_API}${path}?${params.toString()}`;
}

class PublicApiError extends Error {
  constructor(readonly status: number) {
    super(`public SEO API answered ${status}`);
    this.name = 'PublicApiError';
  }
}

/**
 * One uncached read, mapped to a PublicResult (throws on transient failures).
 * `timeoutMs` aborts the request after that long; the abort throws like any
 * other transient failure, so it is never cached.
 */
export async function readPublic<T>(
  brandId: BrandId,
  path: string,
  query: Record<string, string | undefined> = {},
  deps: { fetch?: FetchImpl; env?: Env; clientIp?: string | null; timeoutMs?: number } = {},
): Promise<PublicResult<T>> {
  const brand = getBrand(brandId);
  const env = deps.env ?? process.env;
  const doFetch: FetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  const res = await doFetch(publicApiUrl(brand, path, query, env), {
    headers: publicApiHeaders(brand, env, deps.clientIp),
    cache: 'no-store',
    ...(deps.timeoutMs ? { signal: AbortSignal.timeout(deps.timeoutMs) } : {}),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; code?: string; details?: { reason?: unknown } } | null;
  if (res.status === 200 && body?.success) return { status: 'ok', data: body.data as T };
  if (res.status === 410) return { status: 'gone' };
  if (res.status === 404) {
    if (body?.code === 'feature_disabled') return { status: 'disabled' };
    const reason = body?.details?.reason;
    return { status: 'not_found', reason: typeof reason === 'string' ? reason : null };
  }
  throw new PublicApiError(res.status);
}

/**
 * `unstable_cache` with the brand as the first key part and the given tags.
 * `load` runs only on a miss, with the context of the request that missed;
 * the visitor IP is never part of the key.
 */
function cachedRead<T>(brandId: BrandId, key: readonly string[], tags: string[], ttl: number, load: () => Promise<PublicResult<T>>): Promise<PublicResult<T>> {
  return unstable_cache(load, ['seo', brandId, ...key], { tags, revalidate: ttl })();
}

/** Browse page data for `/browse/<segments>` (null when the path is not a browse shape). */
export function loadBrowsePage(
  brandId: BrandId,
  segments: readonly string[],
  country?: string | null,
  ctx: LoadContext = {},
): Promise<PublicResult<SeoPageResponse>> | null {
  const cls = classifyBrowseSegments(segments);
  if (!cls) return null;
  const c = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined;
  return cachedRead(brandId, ['page', cls.type, cls.slug, c ?? ''], [seoCacheTag(brandId, cls.type, cls.slug)], PAGE_TTL, () =>
    readPublic<SeoPageResponse>(brandId, '/page', { path: segments.map((s) => decodeSafe(s)).join('/'), country: c }, { clientIp: ctx.clientIp }),
  );
}

export function loadBrowseHub(brandId: BrandId, ctx: LoadContext = {}): Promise<PublicResult<SeoHubResponse>> {
  return cachedRead(brandId, ['hub'], [seoCacheTag(brandId, 'hub', 'all')], PAGE_TTL, () => readPublic<SeoHubResponse>(brandId, '/hub', {}, { clientIp: ctx.clientIp }));
}

export function loadPublicJob(brandId: BrandId, id: string, ctx: LoadContext = {}): Promise<PublicResult<PublicJobResponse>> {
  return cachedRead(brandId, ['job', id], [seoCacheTag(brandId, 'job', id)], PAGE_TTL, () =>
    readPublic<PublicJobResponse>(brandId, `/jobs/${encodeURIComponent(id)}`, {}, { clientIp: ctx.clientIp }),
  );
}

export function loadTicker(brandId: BrandId): Promise<PublicResult<TickerResponse>> {
  return cachedRead(brandId, ['ticker'], [seoCacheTag(brandId, 'ticker', 'all')], TICKER_TTL, () =>
    readPublic<TickerResponse>(brandId, '/ticker', {}, { timeoutMs: TICKER_TIMEOUT_MS }),
  );
}

export function loadSitemapIndex(brandId: BrandId): Promise<PublicResult<SitemapIndexResponse>> {
  return cachedRead(brandId, ['sitemap', 'index'], [seoCacheTag(brandId, 'sitemap', 'index')], SITEMAP_TTL, () => readPublic<SitemapIndexResponse>(brandId, '/sitemap'));
}

export function loadSitemapPart(brandId: BrandId, part: string): Promise<PublicResult<SitemapPartResponse>> {
  const tags = [seoCacheTag(brandId, 'sitemap', part), ...(part.startsWith('roles-') ? [seoCacheTag(brandId, 'sitemap', 'roles')] : [])];
  return cachedRead(brandId, ['sitemap', part], tags, SITEMAP_TTL, () => readPublic<SitemapPartResponse>(brandId, `/sitemap/${encodeURIComponent(part)}`));
}

/**
 * For proxy.ts (REQ-56-2, INT-owned): the HTTP status the HTML at `pathname`
 * should answer when it is a public job page whose job has closed — 410 —
 * else null (let the page render: ok, 404, redirect). An App Router page can
 * only answer 404, so the proxy returns the 410 itself. Uncached in Next (the
 * proxy has no `unstable_cache` store); on Vercel the read goes through the
 * public origin, whose CDN caches the API's 410 (`SEO_GONE_CACHE_CONTROL`).
 * Never throws: any failure → null (the page then answers as usual).
 */
export async function publicJobHtmlStatus(
  brandId: BrandId,
  pathname: string,
  deps: { fetch?: FetchImpl; env?: Env; clientIp?: string | null } = {},
): Promise<410 | null> {
  const m = /^\/job\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  if (getBrand(brandId).market === 'cn') return null; // GoApply job pages are deferred (404)
  const id = parseJobIdSlug(m[1]!);
  if (!id) return null;
  try {
    const res = await readPublic<PublicJobResponse>(brandId, `/jobs/${encodeURIComponent(id)}`, {}, deps);
    return res.status === 'gone' ? 410 : null;
  } catch {
    return null;
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
