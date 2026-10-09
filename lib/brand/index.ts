// lib/brand/index.ts — the web brand core's public surface.
//
//   lib/brand/registry.generated.ts  byte copy of server/src/platform/brand/registry.ts
//                                    (npm run gen:brand; parity test in __tests__/lib/brandParity.test.ts)
//   lib/brand/client.ts              ClientBrand + publicBrand()
//   lib/brand/tokens.ts              %BRAND% / %OTHER_BRAND% substitution
//   lib/brand/BrandProvider.tsx      <BrandProvider>, useBrand()  ('use client')
//   lib/brand/runtime.ts             env-dependent host resolution + locale clamp.
//                                    NOT re-exported here: proxy.ts and lib/server/brand.ts
//                                    import it directly, client code never needs it.
//   lib/server/brand.ts              getServerBrand() for server components
//   lib/flags.ts                     useFlag(), useCapabilities()
//
// Everything exported here is safe in client components.

export {
  ALL_LOCALES,
  BRAND_IDS,
  BRANDS,
  DEFAULT_BRAND,
  brandIdFromHost,
  clampLocaleToBrand,
  getBrand,
  isBrandId,
  isDevOrPreviewHost,
  normalizeHost,
  parseBrandId,
} from './registry.generated';
export type {
  AuthMethod,
  BrandFlags,
  BrandId,
  HiringContactsMode,
  JobProvider,
  LlmProfile,
  Market,
  PaymentRail,
  ProductBrand,
  RoboLocale as BrandLocale,
} from './registry.generated';
export { publicBrand, clientBrandFor, type ClientBrand } from './client';
export { BRAND_TOKEN, OTHER_BRAND_TOKEN, substituteBrandString, substituteBrandTokens } from './tokens';
export { BrandProvider, useBrand, useBrandId, type BrandProviderProps } from './BrandProvider';
