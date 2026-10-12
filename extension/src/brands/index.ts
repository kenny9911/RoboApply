// extension/src/brands/index.ts — one extension codebase, two brand builds.
//
// Names, hosts and origins come from the canonical product-brand registry
// (server/src/platform/brand/registry.ts: zero imports, pure data), so the
// extension never hard-codes a brand name or host. Per-brand extension values
// live in brands/<id>/ (goapply/ is WP-71's).

import { BRANDS, brandIdFromHost, isBrandId, normalizeHost } from '../../../server/src/platform/brand/registry';
import { GOAPPLY_EXT } from './goapply/index';
import { ROBOAPPLY_EXT } from './roboapply/index';
import type { BrandId, ExtBrandConfig, ExtBrandValues } from './types';

export type { BrandId, ExtBrandConfig } from './types';

const VALUES: Record<BrandId, ExtBrandValues> = { roboapply: ROBOAPPLY_EXT, goapply: GOAPPLY_EXT };

export function getExtBrand(id: BrandId): ExtBrandConfig {
  const b = BRANDS[id];
  return {
    ...VALUES[id],
    id,
    market: b.market,
    name: b.name,
    otherBrandName: BRANDS[b.otherBrand].name,
    defaultLocale: b.defaultLocale,
    webHosts: [...b.hosts],
    devHosts: [...b.devHosts],
    apiOrigin: b.canonicalOrigin,
  };
}

export { isBrandId };

/**
 * May a web page at `origin` pair this brand's extension (or name `origin` as
 * its API origin)? Production: https + one of the brand's hosts. Dev builds
 * also accept the brand's dev origins and registry dev hosts over http.
 */
export function isTrustedBrandOrigin(brand: ExtBrandConfig, origin: string, dev: boolean): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin.replace(/\/$/, '')) return false;
  const host = normalizeHost(url.host);
  if (url.protocol === 'https:' && brand.webHosts.includes(host) && brandIdFromHost(host) === brand.id) return true;
  if (!dev) return false;
  if (brand.devWebOrigins.includes(url.origin)) return true;
  return (url.protocol === 'http:' || url.protocol === 'https:') && brand.devHosts.includes(host);
}
