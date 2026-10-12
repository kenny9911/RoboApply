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
export {
  BRAND_ENV_GROUPS,
  BRAND_ENV_GROUP_IDS,
  BRAND_OWN_ENV,
  BRAND_STACK_IDS,
  brandEnv,
  brandEnvFlag,
  brandEnvGroupProblems,
  brandEnvName,
  brandEnvSource,
  brandOwnEnv,
  brandStack,
  brandUsesSharedStack,
  cnLlmDomesticOnly,
  cnResidencyStrict,
  envSet,
  parseBoolEnv,
} from './brandEnv.js';
export { brandOfUser, setUserBrandLookup } from './userBrand.js';
export type { UserBrandLookup } from './userBrand.js';
export type { BrandEnvGroup, BrandEnvGroupId, BrandEnvGroupProblem, BrandEnvSource, BrandStackId, EnvSource } from './brandEnv.js';
export {
  BRAND_HEADER,
  BRAND_OVERRIDE_COOKIE,
  INTERNAL_HEADER,
  allowedBrands,
  allowedBrandsProblem,
  brandLock,
  cookieDomainFor,
  corsOrigins,
  isBrandAllowed,
  parseBrandHostMap,
  requestHost,
  resolveBrand,
  resolveBrandFromRequest,
} from './runtime.js';
export type { AllowedBrandsProblem, BrandRequestLike, BrandResolution } from './runtime.js';
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
