import type { BrandConfig, BrandId } from './types.js';
import { robohireBrand } from './robohire.js';
import { gohireBrand } from './gohire.js';

export const BRANDS: Record<BrandId, BrandConfig> = {
  robohire: robohireBrand,
  gohire: gohireBrand,
};

export const DEFAULT_BRAND_ID: BrandId = 'robohire';

export function getBrand(id: string | undefined | null): BrandConfig {
  if (!id) return BRANDS[DEFAULT_BRAND_ID];
  // Case-insensitive lookup so BRAND=RoboHire / robohire / ROBOHIRE all resolve.
  const normalized = id.trim().toLowerCase();
  if (normalized in BRANDS) {
    return BRANDS[normalized as BrandId];
  }
  return BRANDS[DEFAULT_BRAND_ID];
}

export type { BrandConfig, } from './types.js';
