import type { Metadata } from 'next';
import type { ProductBrand } from '../../lib/brand/registry.generated';
import { loadMessages } from '../../lib/i18n';
import { getServerBrand } from '../../lib/server/brand';
import { resolveLocale } from '../../lib/serverLocale';

/**
 * The Job Search API (reference page, key page, `/api/v1/job-search`) is
 * offered on both brands (D5; GOAPPLY_PARITY_PLAN §3.10). The sources differ
 * (server/src/job-search/service.ts `providersForBrand`), the pages do not.
 * The server closes the API only when the brand's `jobs.feed` capability is
 * off; the pages then say so (JobSearchUnavailable) instead of answering 404.
 * Pure.
 */
export function jobSearchAvailableFor(_brand: Pick<ProductBrand, 'market'>): boolean {
  return true;
}

/** `jobSearchAvailableFor` the brand of the current request. */
export async function jobSearchAvailable(): Promise<boolean> {
  return jobSearchAvailableFor(await getServerBrand());
}

export async function jobSearchMetadata(surface: 'search' | 'keys' | 'api'): Promise<Metadata> {
  const brand = await getServerBrand();
  // The brand's bundle: its copy overrides and its own name in every `%BRAND%`.
  const messages = loadMessages(await resolveLocale(), brand.id);
  const search = messages.jobSearch as Record<string, string>;
  const api = messages.jobSearchApi as Record<string, string>;
  const title = surface === 'api' ? `${api.docs} · ${search.title}` : surface === 'keys' ? api.keys_title : search.title;
  return {
    title: `${title} | ${brand.name}`,
    description: surface === 'api' ? api.intro : surface === 'keys' ? api.keys_intro : search.intro,
    ...(surface === 'api' ? { alternates: { canonical: '/developers/job-search' } } : { robots: { index: false, follow: false } }),
  };
}
