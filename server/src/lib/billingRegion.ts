// server/src/lib/billingRegion.ts
//
// Which currency and payment rail a purchase uses. Since the Jobright clone
// (TASK_PLAN.md R-08, WP-21a; PRODUCT_PLAN.md §6.1 rule 6) the BRAND decides,
// nothing else: RoboApply (international, Taiwan included) pays USD by card
// through Stripe; GoApply (mainland China) pays CNY through Alipay (WeChat
// Pay when WP-62 registers it). The old `?region=` / country / locale signals
// no longer choose a rail; for new purchases use `resolveRail(brand)` in
// platform/billing. This module keeps the plan view's `region` field and the
// edge-country helper (used for the EU/UK/TW withdrawal-waiver box).

import type { Request } from 'express';
import type { ProductBrand } from '../platform/brand/registry.js';

export type BillingMarket = 'cn' | 'other';

export interface BillingRegion {
  market: BillingMarket;
  currency: 'CNY' | 'USD';
  method: 'alipay' | 'stripe';
  /** Always the brand now (kept for the plan view's shape). */
  source: 'brand';
}

/** The brand's currency and primary rail. */
export function billingRegionForBrand(brand: Pick<ProductBrand, 'market'>): BillingRegion {
  return brand.market === 'cn'
    ? { market: 'cn', currency: 'CNY', method: 'alipay', source: 'brand' }
    : { market: 'other', currency: 'USD', method: 'stripe', source: 'brand' };
}

/** The best-available country header off an Express request (edge proxies). */
export function countryHeaderFromRequest(req: Pick<Request, 'headers'>): string | null {
  const h = req.headers;
  const raw =
    (h['cf-ipcountry'] as string | undefined) ||
    (h['x-vercel-ip-country'] as string | undefined) ||
    (h['x-country'] as string | undefined) ||
    (h['x-geo-country'] as string | undefined) ||
    null;
  if (!raw) return null;
  const v = String(raw).trim().toUpperCase();
  // Cloudflare uses 'XX'/'T1' for unknown/Tor — treat as no signal.
  if (!v || v === 'XX' || v === 'T1') return null;
  return v;
}
