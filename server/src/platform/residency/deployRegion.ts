// server/src/platform/residency/deployRegion.ts
//
// Where this deployment runs, and what that means for GoApply data
// (CN_TW_LAUNCH_PLAN.md §3, TASK_PLAN.md WP-15, ruling H6).
//
//   DEPLOY_REGION=cn-mainland → the mainland stack (CN-1/CN-2: Aliyun
//                               Shanghai, CN database, CN object storage).
//   unset                     → offshore (the Vercel + Neon stack). GoApply
//                               rows here are the CN-0 closed beta.
//
// Any other value is a configuration error: the startup assertions refuse to
// boot on it, because a typo such as `cn_mainland` would otherwise switch the
// mainland safeguards off silently. Until then it reads as offshore (the
// stricter GoApply storage rule: keep no original file).

import { getBrand, type BrandId, type ProductBrand } from '../brand/registry.js';
import type { EnvSource } from '../brand/brandEnv.js';

export type DeployRegion = 'cn-mainland' | 'offshore';

/** GoApply launch stage implied by the region (RoboApply is always 'intl'). */
export type ResidencyStage = 'intl' | 'cn0' | 'cn1';

export const CN_MAINLAND = 'cn-mainland' as const;

function raw(env: EnvSource): string {
  return (env.DEPLOY_REGION ?? '').trim().toLowerCase();
}

export function deployRegion(env: EnvSource = process.env): DeployRegion {
  return raw(env) === CN_MAINLAND ? CN_MAINLAND : 'offshore';
}

export function isCnMainland(env: EnvSource = process.env): boolean {
  return deployRegion(env) === CN_MAINLAND;
}

/** A non-empty DEPLOY_REGION that is not a known value (refused at startup). */
export function unknownDeployRegion(env: EnvSource = process.env): string | null {
  const v = raw(env);
  return v && v !== CN_MAINLAND ? (env.DEPLOY_REGION ?? '').trim() : null;
}

function toBrand(brand: BrandId | ProductBrand): ProductBrand {
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

/**
 * 'intl' for RoboApply; for GoApply 'cn1' on the mainland stack, otherwise
 * 'cn0' (offshore closed beta). CN-2 is CN-1 plus licences, so it reads 'cn1'.
 */
export function residencyStage(brand: BrandId | ProductBrand, env: EnvSource = process.env): ResidencyStage {
  if (toBrand(brand).market !== 'cn') return 'intl';
  return isCnMainland(env) ? 'cn1' : 'cn0';
}

/** GoApply running offshore (CN-0): no original upload, no photo, redact before storage. */
export function isCn0(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  return residencyStage(brand, env) === 'cn0';
}
