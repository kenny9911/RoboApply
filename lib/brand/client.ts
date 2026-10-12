// lib/brand/client.ts
//
// The brand as the browser sees it (ARCHITECTURE.md §1.5: `publicBrand()`
// strips fields the client does not need). Static registry facts only:
// identity, locales, currency, assets, legal paths, the other brand.
//
// Deliberately NOT included:
//   - `flags` / `authMethods` / `paymentRails`: what is actually ON depends on
//     credentials and env that only the API knows. Gate UI with
//     `useFlag(key)` / `useCapabilities()` (lib/flags.ts), never with the
//     registry defaults.
//   - email, LLM, interview and job-provider settings (server concerns).
//
// Client-safe: no env, no bundle imports.

import {
  DEFAULT_BRAND,
  getBrand,
  type BrandId,
  type Market,
  type ProductBrand,
  type RoboLocale,
} from './registry.generated';

export interface ClientBrand {
  id: BrandId;
  market: Market;
  name: string;
  canonicalOrigin: string;
  defaultLocale: RoboLocale;
  locales: RoboLocale[];
  seoLocales: RoboLocale[];
  defaultTimezone: string;
  defaultCountry: string;
  countries: string[];
  currency: 'USD' | 'CNY';
  assets: ProductBrand['assets'];
  theme: ProductBrand['theme'];
  legal: { termsPath: string; privacyPath: string; aiModelDisclosure: boolean };
  otherBrand: { id: BrandId; name: string; canonicalOrigin: string };
}

export function publicBrand(brand: ProductBrand): ClientBrand {
  const other = getBrand(brand.otherBrand);
  return {
    id: brand.id,
    market: brand.market,
    name: brand.name,
    canonicalOrigin: brand.canonicalOrigin,
    defaultLocale: brand.defaultLocale,
    locales: [...brand.locales],
    seoLocales: [...brand.seoLocales],
    defaultTimezone: brand.defaultTimezone,
    defaultCountry: brand.defaultCountry,
    countries: [...brand.countries],
    currency: brand.currency,
    assets: { ...brand.assets },
    theme: { ...brand.theme },
    legal: {
      termsPath: brand.legal.termsPath,
      privacyPath: brand.legal.privacyPath,
      aiModelDisclosure: brand.legal.aiModelDisclosure === true,
    },
    otherBrand: { id: other.id, name: other.name, canonicalOrigin: other.canonicalOrigin },
  };
}

/** The client brand for an id (used as the provider default and in tests). */
export function clientBrandFor(id: BrandId = DEFAULT_BRAND): ClientBrand {
  return publicBrand(getBrand(id));
}
