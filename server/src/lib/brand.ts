/**
 * getActiveBrand() — backend singleton returning the deploy-active brand.
 *
 * Resolution order:
 *   1. process.env.APP_NAME — preferred name (set per Render service)
 *   2. process.env.BRAND    — fallback / legacy spelling
 *   3. DEFAULT_BRAND_ID ('robohire') if neither is set or value is unknown
 *
 * Value matching is case-insensitive: APP_NAME=RoboHire, APP_NAME=robohire,
 * and APP_NAME=ROBOHIRE all resolve to the same bundle.
 */
import { getBrand, type BrandConfig, type BrandId } from '../brands/index.js';

let cached: BrandConfig | null = null;

export function getActiveBrand(): BrandConfig {
  if (!cached) {
    cached = getBrand(process.env.APP_NAME ?? process.env.BRAND);
  }
  return cached;
}

/** Which env var actually supplied the active brand (for admin UI display). */
export function getActiveBrandEnvVar(): { name: string; value: string | null } {
  if (process.env.APP_NAME !== undefined) {
    return { name: 'APP_NAME', value: process.env.APP_NAME };
  }
  if (process.env.BRAND !== undefined) {
    return { name: 'BRAND', value: process.env.BRAND };
  }
  return { name: 'APP_NAME', value: null };
}

export function getActiveBrandId(): BrandId {
  return getActiveBrand().id;
}

/** Test-only — clears the cached resolution so a test can flip env mid-run. */
export function _resetBrandCacheForTests(): void {
  cached = null;
}
