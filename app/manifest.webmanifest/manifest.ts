// app/manifest.webmanifest/manifest.ts — the host-aware web app manifest (WP-61; ARCHITECTURE.md §8.4).
//
// Pure builder (tested in components/features/pwa/__tests__/manifest.test.ts):
// name, icons and theme colour come from the request's brand, so
// roboapply.io and goapply.top install as their own apps. No offline mode
// (public/sw.js handles push only), so nothing here promises one.

import type { ProductBrand } from '../../lib/brand/registry.generated';

/** PNG icon sizes rendered by ./icon/[size]/route.tsx from the brand mark. */
export const MANIFEST_ICON_SIZES = [192, 512] as const;
export type ManifestIconSize = (typeof MANIFEST_ICON_SIZES)[number];

export const MANIFEST_ICON_PATH = '/manifest.webmanifest/icon';

export interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  lang: string;
  dir: 'ltr';
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: 'any' }>;
}

export function buildManifest(brand: ProductBrand): WebAppManifest {
  return {
    id: '/',
    name: brand.name,
    short_name: brand.name,
    lang: brand.defaultLocale,
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: brand.theme.themeColorLight,
    theme_color: brand.theme.themeColorLight,
    icons: [
      { src: brand.assets.mark, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ...MANIFEST_ICON_SIZES.map((size) => ({ src: `${MANIFEST_ICON_PATH}/${size}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' as const })),
    ],
  };
}

export function isManifestIconSize(value: string): value is `${ManifestIconSize}` {
  return (MANIFEST_ICON_SIZES as readonly number[]).includes(Number(value)) && /^\d+$/.test(value);
}
