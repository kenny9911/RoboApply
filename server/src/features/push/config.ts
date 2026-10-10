// server/src/features/push/config.ts — VAPID credentials (ARCHITECTURE.md §8.4).
//
// `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto: or https:),
// read through `brandEnv` (R-03): unprefixed = RoboApply. GoApply has no web
// push (`webPush` registry flag false), so its `CN_VAPID_*` names are never
// read in practice. Nothing is simulated when a key is missing: the area
// answers 501 `provider_not_configured` and the delivery channel reports
// itself unconfigured.

import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';

/** Brands web push serves. GoApply has none (mainland push services are unreliable). */
export const WEB_PUSH_BRANDS = ['roboapply'] as const;

/**
 * True when web push may run for the brand at all: listed in
 * `WEB_PUSH_BRANDS` and not a mainland (`cn`) brand. Checked by the service,
 * the delivery channel and the worker on top of the `webPush` flag, so an env
 * or per-user flag override can never turn push on for GoApply.
 */
export function webPushServesBrand(brand: BrandId | ProductBrand): boolean {
  const b = typeof brand === 'string' ? getBrand(brand) : brand;
  return (WEB_PUSH_BRANDS as readonly string[]).includes(b.id) && b.market !== 'cn';
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
