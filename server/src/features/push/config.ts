// server/src/features/push/config.ts — VAPID credentials (ARCHITECTURE.md §8.4).
//
// Web push serves both brands (owner ruling D5; GOAPPLY_PARITY_PLAN.md §3.4).
// `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto: or https:)
// are read through `brandEnv`, where they form the `push` group: RoboApply
// reads the unprefixed set. GoApply reads the same shared set unless
// `CN_VAPID_PUBLIC_KEY` is set, which starts a set of its own (`CN_VAPID_*`,
// all three, never mixed with the shared one). `FLAG_GOAPPLY_WEB_PUSH=false`
// turns it off for GoApply. Nothing is simulated when a key is missing: the
// area answers 501 `provider_not_configured` and the delivery channel reports
// itself unconfigured.

import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { BRAND_IDS, getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';

/** Brands web push serves: every brand. Whether it runs for one is the `webPush` flag plus that brand's VAPID set. */
export const WEB_PUSH_BRANDS: readonly BrandId[] = BRAND_IDS;

/**
 * True for every brand: web push serves both (D5). What turns push off for a
 * brand is its `webPush` flag (`FLAG_<BRAND>_WEB_PUSH=false`) or a missing
 * VAPID set, which the service, the channel and the worker check; none of
 * them refuses a brand by its market any more.
 */
export function webPushServesBrand(brand: BrandId | ProductBrand): boolean {
  const b = typeof brand === 'string' ? getBrand(brand) : brand;
  return WEB_PUSH_BRANDS.includes(b.id);
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** The brand's VAPID config, or null when any part is missing or the subject is not mailto:/https:. */
export function vapidConfig(brand: BrandId | ProductBrand, env: EnvSource = process.env): VapidConfig | null {
  const publicKey = brandEnv(brand, 'VAPID_PUBLIC_KEY', env)?.trim();
  const privateKey = brandEnv(brand, 'VAPID_PRIVATE_KEY', env)?.trim();
  const subject = brandEnv(brand, 'VAPID_SUBJECT', env)?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/i.test(subject)) return null;
  return { publicKey, privateKey, subject };
}
