// lib/brand/metadata.ts
//
// Root <head> metadata per brand (ARCHITECTURE.md §1.5; catalog F-MKT-01's
// metadata seam). app/layout.tsx `generateMetadata()` / `generateViewport()`
// call these with the request's brand; pages still override title,
// description, canonical and Open Graph as before.
//
//   metadataBase  brand.canonicalOrigin
//   title         brand.name as the default title. No title template yet:
//                 existing page titles already end in "| <brand>"
//                 (lib/seo.ts landing, components/job-search/metadata.ts), so
//                 a "%s · <brand>" template would print the name twice. The
//                 template lands when those producers drop their suffix
//                 (BRAND_TITLE_TEMPLATE is ready for it).
//   icons         brand.assets (favicon, shortcut, apple-touch)
//   themeColor    brand.theme (light + dark), via generateViewport
//   verification  Baidu site verification on brands indexed by Baidu
//                 (`BAIDU_SITE_VERIFICATION`, GoApply only; CN plan §2.1)
//
// Pure (env passed in), server-safe and client-safe.

import type { Metadata, Viewport } from 'next';

import type { ProductBrand } from './registry.generated';

export type MetadataEnv = Record<string, string | undefined>;

/** Description shown when a page sets none. Brand-neutral on purpose. */
export const ROOT_DESCRIPTION =
  "Find out why you're not getting interviews. Drop your resume — we read 1,000+ open roles, show you the ones you can actually get, and name exactly what's missing.";

/** The title template new pages will get once the legacy brand suffixes are gone. */
export function brandTitleTemplate(brand: Pick<ProductBrand, 'name'>): string {
  return `%s · ${brand.name}`;
}

/** Baidu verification token for this brand, or null. */
export function baiduVerification(brand: ProductBrand, env: MetadataEnv = process.env): string | null {
  if (!brand.seo.searchEngines.includes('baidu')) return null;
  const token = env.BAIDU_SITE_VERIFICATION?.trim();
  return token ? token : null;
}

export function buildRootMetadata(brand: ProductBrand, env: MetadataEnv = process.env): Metadata {
  const baidu = baiduVerification(brand, env);
  return {
    metadataBase: new URL(brand.canonicalOrigin),
    title: brand.name,
    applicationName: brand.name,
    description: ROOT_DESCRIPTION,
    icons: {
      icon: brand.assets.favicon,
      shortcut: brand.assets.favicon,
      apple: brand.assets.appleTouch,
    },
    // Host-aware manifest route (WP-61, app/manifest.webmanifest; Wave 4 gate).
    manifest: '/manifest.webmanifest',
    ...(baidu ? { verification: { other: { 'baidu-site-verification': baidu } } } : {}),
  };
}

export function buildRootViewport(brand: ProductBrand): Viewport {
  return {
    themeColor: [
      { media: '(prefers-color-scheme: light)', color: brand.theme.themeColorLight },
      { media: '(prefers-color-scheme: dark)', color: brand.theme.themeColorDark },
    ],
  };
}
