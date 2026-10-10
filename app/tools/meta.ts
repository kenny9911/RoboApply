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
 * Whether the free tools run for this brand and stage. Mirrors the server's
 * `toolsOpen` (server/src/features/tools/service.ts): GoApply on the offshore
 * stack (CN-0, the invite-only closed beta; DEPLOY_REGION is not
 * `cn-mainland`) has no free tools, so their pages 404 and the hub lists none.
 */
export function freeToolsOpen(brandId: BrandId, env: Record<string, string | undefined> = process.env): boolean {
  if (getBrand(brandId).market !== 'cn') return true;
  return (env.DEPLOY_REGION ?? '').trim().toLowerCase() === 'cn-mainland';
}

/** `freeToolsOpen` for the brand of this request. */
export async function freeToolsOpenForRequest(): Promise<boolean> {
  return freeToolsOpen(await getServerBrandId());
}
