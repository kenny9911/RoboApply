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

/** Days in a window, to compare caps that refill on different schedules. */
const WINDOW_DAYS: Record<CreditWindow, number> = { day: 1, week: 7, month: 30 };

/**
 * Does the Pro column allow more of this than the cap the user has now?
 * Compared per day so "1 a week" → "3 a day" counts as more, and an admin
 * override above the Pro cap does not.
 */
export function proAllowsMore(current: { cap: number; window: CreditWindow }, pro: { cap: number; window: CreditWindow }): boolean {
  return pro.cap / WINDOW_DAYS[pro.window] > current.cap / WINDOW_DAYS[current.window];
}

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
  /**
   * The cap the Pro plan gives for this bucket, per `proWindow` — only when
   * that is more than the cap above (so "Pro: up to 30 kits a week" can be
   * printed from the catalog, never from copy). Absent when Pro gives no more:
   * the user is on Pro, or an override already lifts the cap.
   */
  proCap?: number;
  /** The window `proCap` refills on. Present exactly when `proCap` is. */
  proWindow?: CreditWindow;
}

export interface EntitlementSummary {
  planKey: string;
  planProfile: PlanProfile;
  legacyPlan: boolean;
  interval: string | null;
  periodEnd: string | null;
  /**
   * The paid plan was cancelled and ends at `periodEnd` (no further charge).
   * False for Free, for passes and for a plan that still renews.
   */
  cancelAtPeriodEnd: boolean;
  timezone: string;
  /** Pro can be bought now: a Pro plan is on sale and a rail can charge (drives "See Pro" links). */
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
    const resolved = ent.buckets[u.bucket];
    const pro = resolved ? { cap: resolved.proCap, window: resolved.proWindow ?? resolved.window } : null;
    buckets[u.bucket] = {
      cap: u.cap,
      window: u.window,
      used: u.used,
      remaining: u.remaining,
      grantRemaining: u.grantRemaining,
      resetsAt: u.resetsAt.toISOString(),
      ...(pro && proAllowsMore({ cap: u.cap, window: u.window }, pro) ? { proCap: pro.cap, proWindow: pro.window } : {}),
    };
  }
  return {
    planKey: ent.planKey,
    planProfile: ent.planProfile,
    legacyPlan: ent.legacyPlan,
    interval: ent.interval,
    periodEnd: ent.periodEnd ? ent.periodEnd.toISOString() : null,
    cancelAtPeriodEnd: ent.cancelAtPeriodEnd === true,
    timezone: ent.timezone,
    upgradable: ent.planProfile === 'free' && ent.proSellable,
    buckets,
    entitlements: ent.entitlements,
  };
}
