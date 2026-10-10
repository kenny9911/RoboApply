// server/src/platform/residency/index.ts — public surface of the data-residency
// platform (WP-15; D5 defaults, GOAPPLY_PARITY_PLAN.md §3.6): deploy region,
// egress policy, upload storage rule, startup assertions and the processing
// summary. The strict mainland posture is `CN_RESIDENCY_STRICT` (platform/brand).

export {
  CN_MAINLAND,
  deployRegion,
  isCn0,
  isCnMainland,
  residencyStage,
  unknownDeployRegion,
} from './deployRegion.js';
export type { DeployRegion, ResidencyStage } from './deployRegion.js';

export {
  DEFAULT_GOHIRE_API_BASE,
  EgressPolicyError,
  GOHIRE_HOST_SUFFIXES,
  MAINLAND_STORAGE_HOST_PATTERNS,
  NO_PI_HOST_SUFFIXES,
  allowedCnStorageHostSuffixes,
  assertEgress,
  assertNoPiInPayload,
  checkEgress,
  goHireParseActive,
  goHireParseAllowedFor,
  goHireParseBrands,
  isMainlandStorageHost,
  isNoPiVendorHost,
  isPrivateHost,
} from './egressPolicy.js';
export type { EgressCheckInput, EgressDecision, EgressPolicyCode, NoPiPayloadInput } from './egressPolicy.js';

export {
  CN_STORAGE_ENV,
  CN_STORAGE_MODES,
  StorageUnavailableError,
  applyResumeUploadPolicy,
  assertResumeUploadStorage,
  brandStorageConfigured,
  cnOwnStorageProblem,
  cnStorageMode,
  cnStorageModeProblem,
  isImageUpload,
  mayStoreOriginal,
  resumeUploadPolicy,
} from './uploadPolicy.js';
export type {
  AppliedResumeUploadPolicy,
  CnStorageMode,
  OriginalFileRule,
  ResumeUploadContent,
  ResumeUploadPolicy,
} from './uploadPolicy.js';

export {
  DEFAULT_CN_DB_HOST_SUFFIXES,
  ResidencyStartupError,
  TOPOLOGY_FAILURE_CODES,
  allowedDbHostSuffixes,
  assertResidencyAtStartup,
  checkResidency,
  cnLlmRouteFailures,
  resolveCnSelectorProvider,
  dbHostOf,
  isAllowedCnDbHost,
} from './startupAssertions.js';
export type { ResidencyFailure, ResidencyFailureCode, ResidencyReport } from './startupAssertions.js';

export { WriteBrandUnknownError, resolveOwnerWriteBrand, resolveWriteBrand } from './writeBrand.js';

export { residencySummary } from './summary.js';
export type { ResidencySummary } from './summary.js';
