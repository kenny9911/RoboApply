// server/src/features/support/contract.ts
//
// Support contact form and the public facts the marketing site prints
// (TASK_PLAN.md WP-40; F-TRUST-07, F-MKT-01/02, F-BILL-02). Mount:
// /api/v1/roboapply/support (optional session).
//
//   POST /support/contact       → the brand's support inbox (5/day/IP). Sends
//                                 to SUPPORT_EMAIL / CN_SUPPORT_EMAIL (brandEnv,
//                                 no fallback across brands), else the
//                                 registry's support address. Nothing is
//                                 promised about response times.
//   GET  /support/index-stats   → real counts for the marketing counters and
//                                 the hero clause (cached hourly per brand).
//   GET  /support/credit-caps   → the effective credit catalog (Free vs Pro
//                                 caps) for the public /pricing table.
//
// D3: every count filters visibility='public' AND isCanonical AND
// archivedAt IS NULL AND closedAt IS NULL AND market = brand.market (users'
// imported jobs never count), is rounded DOWN to two significant figures and
// travels as a Sourced<number>. The hero clause is dropped below
// HERO_COUNT_MIN. No user counts are published.

import { z } from 'zod';
import type { Sourced } from '../../platform/http.js';

export const SUPPORT_TOPICS = ['account', 'billing', 'jobs', 'resume', 'practice', 'extension', 'privacy', 'bug', 'other'] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export const SupportContactBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().max(120).optional(),
    topic: z.enum(SUPPORT_TOPICS),
    message: z.string().trim().min(10).max(5000),
    pageUrl: z.string().max(2000).optional(),
    locale: z.string().max(8).optional(),
  })
  .strict();
export interface SupportContactResponse {
  received: true;
}
export const SUPPORT_LIMITS = { perIpPerDay: 5 } as const;

// ── Public index counts (marketing counters, hero clause, popular lists) ──

/** Below this many open roles the hero drops its "{count} open roles" clause (H20). */
export const HERO_COUNT_MIN = 1000;
/** Counts are recomputed at most once an hour per brand. */
export const INDEX_STATS_TTL_MS = 60 * 60 * 1000;
/**
 * A result with a failed part ("unknown" because a query failed, not because
 * there is nothing) is kept only this long, so one transient database error
 * doesn't blank the counters for an hour.
 */
export const INDEX_STATS_PARTIAL_TTL_MS = 60 * 1000;
/** A role list is linked only when it has at least this many live public jobs (ARCH §9.2 role floor). */
export const POPULAR_LIST_MIN_JOBS = 20;
/** At most this many "Popular job lists" links. */
export const POPULAR_LIST_MAX = 8;
/** `Sourced.method` of every marketing count. */
export const INDEX_COUNT_METHOD = 'rounded_down_2_significant_figures';

export interface PopularJobList {
  /** Taxonomy L3 role id (taxonomy.v1). */
  taxonomyId: string;
  /** English and Chinese labels from the taxonomy. */
  label: string;
  labelZh: string;
}

export interface IndexStatsResponse {
  /** Live public canonical jobs of the brand's market, rounded down; null when unknown. */
  openRoles: Sourced<number> | null;
  /** Of those, first seen in the last 7 days, rounded down; null when unknown. */
  addedThisWeek: Sourced<number> | null;
  /** Roles with ≥ POPULAR_LIST_MIN_JOBS publicly displayable live jobs, most first. */
  popularLists: PopularJobList[];
  /** When the counts were taken (ISO). */
  asOf: string;
  /** True when a query failed, so some part is unknown for now. Never cached long (CDN or process). */
  partial: boolean;
}

// ── Public credit caps (/pricing credits table) ─────────────────────────

export type CapWindow = 'day' | 'week';
export interface PublicCap {
  cap: number;
  window: CapWindow;
}

/** Buckets the public table lists, in display order (PRODUCT §6.2). */
export const PUBLIC_CAP_BUCKETS = [
  'fit_analysis',
  'tailor',
  'cover_letter',
  'resume_check',
  'rewrite',
  'outreach',
  'assistant',
  'job_import',
  'ready_kits',
  'autofill',
] as const;
export type PublicCapBucket = (typeof PUBLIC_CAP_BUCKETS)[number];

export interface CreditCapsResponse {
  buckets: Array<{ bucket: PublicCapBucket; free: PublicCap; pro: PublicCap }>;
  entitlements: {
    free: { saved_searches: number; instant_alerts: number };
    pro: { saved_searches: number; instant_alerts: number };
  };
}
