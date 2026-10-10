// server/src/platform/billing/proPurchase.ts
//
// "Can this brand take a payment for Pro right now?" One rule, the one behind
// `paymentsOpen` in GET /billing/plans (features/credits/service.ts): a Pro
// plan is on sale AND at least one of the brand's rails can charge.
//
// It drives `upgradable` on every credit wall (402 `credits_exhausted`, the
// out-of-credits sheet, the entitlement summary). The catalog alone is not
// enough: GoApply's plans are on sale by default (D5, D6) while the brand
// cannot charge until ALIPAY_CALLBACK_SECRET is set, and a "Get Pro" link
// must not lead to a plan sheet that says payment is not open yet.
//
// Importing ./rails/index.js registers the built-in rails, so the answer is
// the same in a process that never loaded the billing routes.

import type { EnvSource } from '../brand/brandEnv.js';
import { getBrand, type BrandId } from '../brand/registry.js';
import { hasSellableProPlan } from './planCatalog.js';
import { availableRails } from './rails/index.js';

export function canBuyPro(brand: BrandId, env: EnvSource = process.env): boolean {
  return hasSellableProPlan(brand, env) && availableRails(getBrand(brand), env).length > 0;
}
