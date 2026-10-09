// server/src/platform/brand/index.ts — public surface of the brand core.
// Import from here (or the individual files inside server/src/platform/**).

export {
  ALL_LOCALES,
  BRANDS,
  BRAND_IDS,
  DEFAULT_BRAND,
  brandIdFromHost,
  clampLocaleToBrand,
  getBrand,
  isBrandId,
  isDevOrPreviewHost,
  normalizeHost,
  parseBrandId,
} from './registry.js';
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
  RoboLocale,
} from './registry.js';
export { brandEnv, brandEnvFlag, brandEnvName, envSet, parseBoolEnv } from './brandEnv.js';
export { brandOfUser, setUserBrandLookup } from './userBrand.js';
export type { UserBrandLookup } from './userBrand.js';
export type { EnvSource } from './brandEnv.js';
export {
  BRAND_HEADER,
  BRAND_OVERRIDE_COOKIE,
  INTERNAL_HEADER,
  allowedBrands,
  brandLock,
  cookieDomainFor,
  corsOrigins,
  isBrandAllowed,
  parseBrandHostMap,
  requestHost,
  resolveBrand,
  resolveBrandFromRequest,
} from './runtime.js';
export type { BrandRequestLike, BrandResolution } from './runtime.js';
export {
  BrandContextMissingError,
  brandContext,
  createBrandContext,
  getCurrentBrand,
  getCurrentBrandOrDefault,
} from './brandContext.js';
export type { BrandedRequest } from './brandContext.js';
export { brandPersona, currentBrandPersona } from './persona.js';
export { getCurrentBrandId, runWithBrand } from '../../lib/requestContext.js';
