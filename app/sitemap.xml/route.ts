// /sitemap.xml — host-aware sitemap index (ARCHITECTURE.md §9.5): the static
// set (/sitemaps/static.xml) plus the API's partitions (`roles-<n>` browse
// pages above the floor, `jobs-<n>` public job pages; ≤ 45,000 URLs each).
// GoApply lists the static set only (browse and job pages are deferred).

import { getBrand } from '../../lib/brand/registry.generated';
import { brandUrl, sitemapIndexXml } from '../../lib/seo';
import { getServerBrandId } from '../../lib/server/brand';
import { loadSitemapIndex } from '../../lib/server/publicApi';

export const XML_HEADERS = { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' };

export async function GET(): Promise<Response> {
  const brand = getBrand(await getServerBrandId());
  const parts = await loadSitemapIndex(brand.id)
    .then((r) => (r.status === 'ok' ? r.data.parts : []))
    .catch(() => []);
  const sitemaps = [{ loc: brandUrl(brand.id, '/sitemaps/static.xml') }, ...parts.map((p) => ({ loc: brandUrl(brand.id, `/sitemaps/${p.name}.xml`), lastmod: p.lastmod }))];
  return new Response(sitemapIndexXml(sitemaps), { headers: XML_HEADERS });
}
