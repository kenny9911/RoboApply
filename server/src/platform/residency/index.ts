// server/src/platform/residency/index.ts — public surface of the data-residency
// platform (WP-15; D5 defaults, GOAPPLY_PARITY_PLAN.md §3.6): deploy region,
// egress policy, upload storage rule, startup assertions and the processing
// summary. The strict mainland posture is `CN_RESIDENCY_STRICT` (platform/brand).

export {
  isCnMainland,
} from './deployRegion.js';

export {
  EgressPolicyError,
  assertNoPiInPayload,
  goHireParseActive,
} from './egressPolicy.js';

export {
  applyResumeUploadPolicy,
  cnStorageModeProblem,
} from './uploadPolicy.js';

export {
  ResidencyStartupError,
  assertResidencyAtStartup,
} from './startupAssertions.js';

