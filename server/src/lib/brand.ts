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
import { getBrand, type BrandConfig } from '../brands/index.js';

let cached: BrandConfig | null = null;

export function getActiveBrand(): BrandConfig {
  if (!cached) {
    cached = getBrand(process.env.APP_NAME ?? process.env.BRAND);
  }
  return cached;
}

