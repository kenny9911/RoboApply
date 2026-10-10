// /llms.txt — brand-aware and accurate (ARCHITECTURE.md §9.5; replaces the
// stale public/llms.txt, which advertised auto-apply). Text from lib/seo.ts
// `llmsTxt(brand)`: what the product does today, that the user applies
// themselves (D1), no prices, and that /job/* is closed to AI crawlers. The
// campus calendar is mentioned only while it is live (sitemap surfaces).

import { llmsTxt } from '../../lib/seo';
import { getServerBrandId } from '../../lib/server/brand';
import { loadSitemapIndex } from '../../lib/server/publicApi';

export async function GET(): Promise<Response> {
  const brandId = await getServerBrandId();
  const campus = await loadSitemapIndex(brandId)
    .then((r) => r.status === 'ok' && r.data.surfaces.campus)
    .catch(() => false);
  return new Response(llmsTxt(brandId, { campus }), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, s-maxage=86400, stale-while-revalidate=86400' },
  });
}
