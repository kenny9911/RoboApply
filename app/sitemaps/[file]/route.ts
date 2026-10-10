// /sitemaps/<file>.xml — one sitemap of the index (ARCHITECTURE.md §9.5):
//   static.xml   home cluster (hreflang: brand.seoLocales + the cross-domain
//                alternates), marketing subpages, indexable feature pages,
//                signup, and /browse or /campus when live;
//   roles-<n>.xml, jobs-<n>.xml   from GET /api/v1/public/seo/sitemap/:part.
// Anything else → 404.

import { featuresFor } from '../../../components/features/marketing/catalog';
import { getBrand } from '../../../lib/brand/registry.generated';
import { brandUrl, staticSitemapEntries, urlsetXml } from '../../../lib/seo';
import { getServerBrandId } from '../../../lib/server/brand';
import { loadSitemapIndex, loadSitemapPart } from '../../../lib/server/publicApi';

const HEADERS = { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' };

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const brand = getBrand(await getServerBrandId());
  if (file === 'static.xml') {
    const surfaces = await loadSitemapIndex(brand.id)
      .then((r) => (r.status === 'ok' ? r.data.surfaces : { browse: false, campus: false }))
      .catch(() => ({ browse: false, campus: false }));
    const featurePaths = featuresFor(brand.id)
      .filter((f) => f.gate === null)
      .map((f) => `/features/${f.slug}`);
    return new Response(urlsetXml(staticSitemapEntries(brand.id, { featurePaths, surfaces })), { headers: HEADERS });
  }
  const m = /^((?:roles|jobs)-\d{1,4})\.xml$/.exec(file);
  if (!m) return new Response('Not found', { status: 404 });
  const res = await loadSitemapPart(brand.id, m[1]!).catch(() => null);
  if (!res) return new Response('Unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '300' } });
  if (res.status !== 'ok') return new Response('Not found', { status: 404 });
  return new Response(urlsetXml(res.data.urls.map((u) => ({ loc: brandUrl(brand.id, u.path), lastmod: u.lastmod }))), { headers: HEADERS });
}
