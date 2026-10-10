// app/tools/meta.ts — SERVER-ONLY metadata helper for the free tools pages (WP-57).
// Title/description come from `tools.meta.<key>.*` in the brand × locale bundle.

import type { Metadata } from 'next';

import { getBrand, type BrandId } from '../../lib/brand/registry.generated';
import { getServerBrandId } from '../../lib/server/brand';
import { resolveLocale } from '../../lib/serverLocale';
import { marketingMetadata, messageAt } from '../../lib/seo';

export async function toolsMetadata(key: 'hub' | 'resumeCheck' | 'resumeJobMatch', path: string): Promise<Metadata> {
  const brand = getBrand(await getServerBrandId());
  const locale = await resolveLocale(brand);
  const title = `${messageAt(locale, brand.id, `tools.meta.${key}.title`, brand.name)} | ${brand.name}`;
  return marketingMetadata({
    brandId: brand.id,
    locale,
    path,
    title,
    description: messageAt(locale, brand.id, `tools.meta.${key}.description`),
  });
}

/**
 * Whether the free tools run for this brand. Mirrors the server's `toolsOpen`
 * (server/src/features/tools/service.ts): open on both brands and on every
 * stack (D5). GoApply's extra step is the processing notice the visitor ticks
 * on the tool page, not a closed page.
 */
export function freeToolsOpen(_brandId: BrandId): boolean {
  return true;
}
