// server/src/platform/credits/summary.ts
//
// The entitlement summary `/auth/me` returns (ARCHITECTURE.md §7.2; WP-10
// wires it into `/auth/me.entitlements`). The client never computes
// entitlements; it reads caps, usage and reset times from here and prints
// them ("Uses 1 of your 2 left today", "Up to 50 a day"), never "unlimited".

import type { BrandId } from '../brand/registry.js';
import type { PlanProfile } from '../billing/planCatalog.js';
import type { EntitlementValues, WindowBucket } from './catalog.js';
import { creditService as defaultCredits, type CreditService } from './CreditService.js';
import { entitlementService as defaultEntitlements, type EntitlementService } from './EntitlementService.js';
import type { CreditWindow } from './windows.js';

export interface BucketSummary {
  cap: number;
  window: CreditWindow;
  used: number;
  /** Window allowance left (cap − used − in-flight). */
  remaining: number;
  /** Bonus credits usable after the window allowance. */
  grantRemaining: number;
  /** ISO time the window refills (user's local midnight / Monday / 1st). */
  resetsAt: string;
}

export interface EntitlementSummary {
  planKey: string;
  planProfile: PlanProfile;
  legacyPlan: boolean;
  interval: string | null;
  periodEnd: string | null;
  timezone: string;
  /** A sellable Pro plan exists on this brand (drives "See Pro" links). */
  upgradable: boolean;
  buckets: Record<WindowBucket, BucketSummary>;
  entitlements: EntitlementValues;
}

export async function summarizeEntitlementsForMe(
  userId: string,
  options: { brand?: BrandId; credits?: CreditService; entitlements?: EntitlementService } = {},
): Promise<EntitlementSummary> {
  const entSvc = options.entitlements ?? defaultEntitlements;
  const credits = options.credits ?? defaultCredits;
  const ent = await entSvc.resolve(userId, options.brand ? { brand: options.brand } : undefined);
  const usage = await credits.usage(userId, { entitlements: ent });
  const buckets = {} as Record<WindowBucket, BucketSummary>;
  for (const u of usage) {
    buckets[u.bucket] = {
      cap: u.cap,
      window: u.window,
      used: u.used,
      remaining: u.remaining,
      grantRemaining: u.grantRemaining,
      resetsAt: u.resetsAt.toISOString(),
    };
  }
  return {
    planKey: ent.planKey,
    planProfile: ent.planProfile,
    legacyPlan: ent.legacyPlan,
    interval: ent.interval,
    periodEnd: ent.periodEnd ? ent.periodEnd.toISOString() : null,
    timezone: ent.timezone,
    upgradable: ent.planProfile === 'free' && ent.proSellable,
    buckets,
    entitlements: ent.entitlements,
  };
}
