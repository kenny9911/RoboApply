// components/features/marketing/serverPage.ts — SERVER-ONLY helpers for the
// marketing route files (app/{pricing,about,security,help,features}). Not
// exported from index.ts: it pulls the message bundles (lib/seo → lib/i18n),
// which must never reach a client bundle.

import type { Metadata } from 'next';

import { getBrand, type ProductBrand } from '../../../lib/brand/registry.generated';
import type { RoboLocale } from '../../../lib/localeConfig';
import { getServerBrandId } from '../../../lib/server/brand';
import { resolveLocale } from '../../../lib/serverLocale';
import { faqFromMessages, marketingJsonLd, marketingMetadata, messageAt } from '../../../lib/seo';

export interface MarketingRequest {
  brand: ProductBrand;
  locale: RoboLocale;
}

export async function marketingRequest(): Promise<MarketingRequest> {
  const brand = getBrand(await getServerBrandId());
  return { brand, locale: await resolveLocale(brand) };
}

/** `<title> | <brand>` metadata for a subpage from `<ns>.metaTitle` / `<ns>.metaDescription`. */
export function subpageMetadata(req: MarketingRequest, ns: string, path: string, opts: { noindex?: boolean } = {}): Metadata {
  const { brand, locale } = req;
  const title = `${messageAt(locale, brand.id, `${ns}.metaTitle`, brand.name)} | ${brand.name}`;
  return marketingMetadata({
    brandId: brand.id,
    locale,
    path,
    title,
    description: messageAt(locale, brand.id, `${ns}.metaDescription`),
    noindex: opts.noindex,
  });
}

/** The JSON-LD graph for a subpage, with a FAQPage when it renders `<faqBase>.<key>.q/a`. */
export function subpageJsonLd(req: MarketingRequest, ns: string, path: string, faq?: { base: string; keys: readonly string[] }): string {
  const { brand, locale } = req;
  return marketingJsonLd({
    brandId: brand.id,
    locale,
    path,
    name: messageAt(locale, brand.id, `${ns}.metaTitle`, brand.name),
    description: messageAt(locale, brand.id, `${ns}.metaDescription`),
    faq: faq ? faqFromMessages(locale, brand.id, faq.base, faq.keys) : undefined,
  });
}
