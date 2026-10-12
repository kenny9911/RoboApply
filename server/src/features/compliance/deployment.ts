// server/src/features/compliance/deployment.ts
//
// Deployment facts the consent catalog and the disclosures both read. A leaf
// module (no imports from this area, the PAR-1 brand seam only), so
// consents.ts can build its prose from disclosures.ts without an import cycle.

import { brandUsesSharedStack, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';

/** This deployment runs outside the mainland (DEPLOY_REGION is not cn-mainland). */
export function isOffshore(env: EnvSource = process.env): boolean {
  return (env.DEPLOY_REGION ?? '').trim().toLowerCase() !== 'cn-mainland';
}

/**
 * Whether the brand's personal information leaves mainland China on this
 * deployment, as far as the environment shows: the deployment itself runs
 * offshore, or part of the brand's stack (text model, voice, speech, storage,
 * push, email) resolves to the shared stack, which is offshore
 * (GOAPPLY_PARITY_PLAN.md §3.6; D5 made the shared stack GoApply's fallback, so
 * a mainland deployment without CN providers sends data abroad too).
 *
 * One predicate for the consent catalog and for sign-up (auth-cn computes the
 * same expression), so the sign-up form and the consents panel agree. The
 * catalog additionally asks the AI routes really configured, database
 * overrides included (`crossBorderConsentApplies` in consents.ts).
 */
export function crossBorderApplies(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  return isOffshore(env) || brandUsesSharedStack(brand, env);
}
