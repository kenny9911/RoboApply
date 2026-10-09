// server/src/platform/billing/rails/registry.ts
//
// Rail registry + brand lock (ARCHITECTURE.md §7.4; TASK_PLAN.md WP-21a).
//
//   registerRail(id, impl)        extension point (WP-62 adds 'wechatpay')
//   resolveRail(brand, requested) the rail for a NEW purchase:
//     - only rails in `brand.paymentRails` (GoApply: alipay/wechatpay, never
//       Stripe; RoboApply: Stripe only, so no new intl Alipay purchase);
//     - only rails whose `pay.<rail>` capability requirements are met AND
//       whose implementation reports itself configured;
//     - `?region=` / country never chooses a rail (R-08, §6.1 rule 6).
// Existing RoboApply Alipay passes keep working until they expire: their
// callback and fulfilment paths do not go through resolveRail.

import type { EnvSource } from '../../brand/brandEnv.js';
import type { PaymentRail, ProductBrand } from '../../brand/registry.js';
import { requirementsMet, type FlagKey } from '../../flags.js';
import { BillingError } from '../errors.js';
import type { PaymentRailImpl } from './types.js';

const rails = new Map<PaymentRail, PaymentRailImpl>();

/** Register (or replace) the implementation of a rail. */
export function registerRail(id: PaymentRail, impl: PaymentRailImpl): void {
  if (impl.id !== id) throw new Error(`registerRail: impl.id "${impl.id}" does not match "${id}"`);
  rails.set(id, impl);
}

/** Tests only. */
export function unregisterRail(id: PaymentRail): void {
  rails.delete(id);
}

export function getRegisteredRail(id: PaymentRail): PaymentRailImpl | null {
  return rails.get(id) ?? null;
}

export function registeredRailIds(): PaymentRail[] {
  return [...rails.keys()];
}

function capabilityKey(id: PaymentRail): FlagKey {
  return `pay.${id}` as FlagKey;
}

/** Is this rail usable for new purchases on the brand right now? */
export function railAvailable(brand: ProductBrand, id: PaymentRail, env: EnvSource = process.env): boolean {
  if (!brand.paymentRails.includes(id)) return false;
  const impl = rails.get(id);
  if (!impl) return false;
  return requirementsMet(capabilityKey(id), brand, env) && impl.isConfigured(brand, env);
}

/** The brand's rails that can take a new purchase now, in registry order. */
export function availableRails(brand: ProductBrand, env: EnvSource = process.env): PaymentRail[] {
  return brand.paymentRails.filter((id) => railAvailable(brand, id, env));
}

export function isPaymentRail(value: unknown): value is PaymentRail {
  return value === 'stripe' || value === 'alipay' || value === 'wechatpay';
}

/**
 * The rail for a new purchase. `requested` may only pick among the brand's
 * rails; without it the first available rail wins.
 */
export function resolveRail(brand: ProductBrand, requested?: PaymentRail | null, env: EnvSource = process.env): PaymentRailImpl {
  if (requested) {
    if (!brand.paymentRails.includes(requested)) {
      throw new BillingError('rail_not_allowed', `${brand.name} does not take ${requested} payments`, { rail: requested, brand: brand.id });
    }
    const impl = rails.get(requested);
    if (!impl) throw new BillingError('rail_not_registered', `${requested} is not available yet`, { rail: requested });
    if (!railAvailable(brand, requested, env)) {
      throw new BillingError('rail_not_configured', `${requested} is not set up on this deployment`, { rail: requested });
    }
    return impl;
  }
  for (const id of brand.paymentRails) {
    if (railAvailable(brand, id, env)) return rails.get(id)!;
  }
  throw new BillingError('rail_not_configured', 'Payments are not available right now', { brand: brand.id });
}
