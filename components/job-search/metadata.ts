import type { Metadata } from 'next';
import type { ProductBrand } from '../../lib/brand/registry.generated';
import { loadMessages } from '../../lib/i18n';
import { getServerBrand } from '../../lib/server/brand';
import { resolveLocale } from '../../lib/serverLocale';

/**
 * The Job Search API (reference page, key page, `/api/v1/job-search`) is a
 * RoboApply product. The server closes both routers on GoApply
 * (server/src/job-search/routes.ts `roboApplyOnly`); the pages follow the same
 * rule. Pure.
 */
export function jobSearchAvailableFor(brand: Pick<ProductBrand, 'market'>): boolean {
  return brand.market !== 'cn';
}

/** `jobSearchAvailableFor` the brand of the current request. */
export async function jobSearchAvailable(): Promise<boolean> {
  return jobSearchAvailableFor(await getServerBrand());
}

export async function jobSearchMetadata(surface: 'search' | 'keys' | 'api'): Promise<Metadata> {
  const brand = await getServerBrand();
  // Not offered on this brand: the page is a 404, so it gets no product title and is not indexed.
  if (!jobSearchAvailableFor(brand)) return { title: brand.name, robots: { index: false, follow: false } };
  const messages = loadMessages(await resolveLocale());
  const search = messages.jobSearch as Record<string, string>;
  const api = messages.jobSearchApi as Record<string, string>;
  const title = surface === 'api' ? `${api.docs} · ${search.title}` : surface === 'keys' ? api.keys_title : search.title;
  return {
    title: `${title} | ${brand.name}`,
    description: surface === 'api' ? api.intro : surface === 'keys' ? api.keys_intro : search.intro,
    ...(surface === 'api' ? { alternates: { canonical: '/developers/job-search' } } : { robots: { index: false, follow: false } }),
  };
}
