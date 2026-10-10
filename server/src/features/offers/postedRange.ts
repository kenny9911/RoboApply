// server/src/features/offers/postedRange.ts — posted pay for an offer's role
// (WP-64; PRODUCT §5.15 "a negotiation draft grounded in posted ranges for
// the role (N shown)"; D3).
//
// Source: our own index only, over the rows every public aggregate uses
// (TASK_PLAN §2.2): visibility='public' AND isCanonical AND archivedAt IS NULL
// AND market = brand.market (users' imported jobs never count), still open,
// posted in the last 365 days; on GoApply also not fraud-flagged and only
// while CN_RECRUITMENT_INFO_MODE lets the brand show third-party postings
// (it does by default, D5; `cnPostingsWhere`; mode off → no rows, so no range and no posted pay in
// the AI facts — the Assistant's salary_context is gated the same way). Pay per
// posting is the midpoint of its stated range, in the OFFER'S currency, in one
// period (the offer's own when it has enough rows, else the largest group).
// Fewer than MIN_SAMPLE (20) rows → no range (null) and only the counts.
//
// The rows come from the feed area's `marketStats` (REQ-50-01 / REQ-64-01):
// this file no longer reads RAJob itself. `postedPayWhere` is that seam's
// filter (`marketSalaryWhere`), kept under its old name for callers and tests;
// the pure `summarizePostedPay` (the offer's currency and period) stays here.

import type { Prisma } from '../../generated/prisma/client.js';
import { MIN_SAMPLE, meetsMinSample, type Sourced } from '../../platform/http.js';
import type { EnvSource } from '../../platform/brand/index.js';
import type { Market } from '../../platform/brand/registry.js';
import { createMarketStats, marketSalaryWhere, type MarketStatsDb } from '../feed/index.js';
import { bestTaxonomyMatch, getTaxonomyNode } from '../jobs/taxonomy/index.js';
import type { PostedRange } from './contract.js';

export const POSTED_LOOKBACK_DAYS = 365;
export const POSTED_ROW_CAP = 3000;

export interface PostedPayRow {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}

export interface RoleScope {
  title: string | null;
  taxonomyId: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  city: string | null;
}

export interface PostedPayQuery extends RoleScope {
  market: Market;
  currency: string;
  now: Date;
}

export interface PostedPaySummary {
  postedRange: PostedRange | null;
  totalCount: number;
  listedCount: number;
}

/** What the lookup needs from the job behind a tracker entry. */
export interface JobScopeRow {
  title: string;
  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  locationCountry: string | null;
  locationCity: string | null;
}

/** The database the feed's market-stats reader needs (tests pass a fake). */
export type PostedPayDb = MarketStatsDb;

/**
 * The role for a job: its primary taxonomy node, else its most specific
 * tagged node, else the best title match at role-group level or deeper; with
 * none of those, the title itself (case-insensitive contains).
 */
export function roleScopeFor(job: JobScopeRow | null, fallbackTitle: string | null): RoleScope {
  const title = (job?.title ?? fallbackTitle ?? '').trim() || null;
  let taxonomyId: string | null = null;
  if (job?.primaryTaxonomyId && getTaxonomyNode(job.primaryTaxonomyId)) taxonomyId = job.primaryTaxonomyId;
  if (!taxonomyId && job?.taxonomyIds?.length) {
    const nodes = job.taxonomyIds.map((id) => getTaxonomyNode(id)).filter((n): n is NonNullable<typeof n> => Boolean(n));
    const deepest = nodes.sort((a, b) => b.level - a.level)[0];
    if (deepest && deepest.level >= 2) taxonomyId = deepest.id;
  }
  if (!taxonomyId && title) {
    const m = bestTaxonomyMatch(title);
    if (m && m.level >= 2) taxonomyId = m.id;
  }
  return {
    title: taxonomyId ? null : title,
    taxonomyId,
    country: job?.locationCountry ? job.locationCountry.toUpperCase() : null,
    city: job?.locationCity?.trim() || null,
  };
}

/**
 * The public-aggregate `where` plus the role and place (no currency: that is
 * the "listed" part) — the feed seam's filter. On GoApply it also excludes
 * fraud-flagged postings and ANDs `cnPostingsWhere(null, env)`: with
 * CN_RECRUITMENT_INFO_MODE set to `off` that matches nothing; unset, it
 * matches the public postings (D5).
 */
export function postedPayWhere(q: Omit<PostedPayQuery, 'currency'>, env: EnvSource = process.env): Prisma.RAJobWhereInput {
  return marketSalaryWhere(q, env);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Pure: keep rows in `currency`, group by period, use `preferredPeriod` when it
 * meets the sample rule, else the largest group; quartiles of the midpoints.
 */
export function summarizePostedPay(
  rows: readonly PostedPayRow[],
  meta: { currency: string; preferredPeriod: string; totalCount: number; asOf: Date },
  min: number = MIN_SAMPLE,
): PostedPaySummary {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if ((r.salaryCurrency ?? '').toUpperCase() !== meta.currency || !r.salaryPeriod) continue;
    const lo = typeof r.salaryMin === 'number' && r.salaryMin > 0 ? r.salaryMin : null;
    const hi = typeof r.salaryMax === 'number' && r.salaryMax > 0 ? r.salaryMax : null;
    if (lo === null && hi === null) continue;
    const mid = lo !== null && hi !== null ? (lo + hi) / 2 : (lo ?? hi)!;
    const period = r.salaryPeriod.toLowerCase();
    groups.set(period, [...(groups.get(period) ?? []), mid]);
  }
  let period = meta.preferredPeriod;
  let best = groups.get(period) ?? [];
  if (!meetsMinSample(best.length, min)) {
    for (const [p, list] of groups) {
      if (list.length > best.length) {
        period = p;
        best = list;
      }
    }
  }
  const base = { totalCount: meta.totalCount, listedCount: best.length };
  if (!meetsMinSample(best.length, min)) return { ...base, postedRange: null };
  const sorted = [...best].sort((a, b) => a - b);
  const asOf = meta.asOf.toISOString();
  const s = (value: number): Sourced<number> => ({ value: Math.round(value), source: 'index', sampleSize: sorted.length, asOf, method: 'computed' });
  return {
    ...base,
    postedRange: {
      low: s(quantile(sorted, 0.25)),
      median: s(quantile(sorted, 0.5)),
      high: s(quantile(sorted, 0.75)),
      currency: meta.currency,
      period,
      sampleSize: sorted.length,
      source: 'index',
      asOf,
    },
  };
}

export interface PostedPaySource {
  /** The job's role/place fields (null when the job is gone). */
  jobScope(jobId: string): Promise<JobScopeRow | null>;
  /** Posted pay for the scope in `currency`. */
  summary(q: PostedPayQuery & { preferredPeriod: string }): Promise<PostedPaySummary>;
}

/**
 * Posted pay through the feed area's `marketStats` seam: the seam selects the
 * rows (public-aggregate filter, GoApply mode and fraud rules), this area
 * summarises them in the offer's currency and period.
 */
export function createPrismaPostedPay(getDb: () => Promise<PostedPayDb>, opts: { env?: EnvSource } = {}): PostedPaySource {
  const stats = createMarketStats({ db: getDb, env: opts.env });
  return {
    jobScope: (jobId) => stats.jobRole(jobId),
    async summary(q) {
      const sample = await stats.salarySample({ market: q.market, taxonomyId: q.taxonomyId, title: q.title, country: q.country, city: q.city, now: q.now, currency: q.currency });
      return summarizePostedPay(sample.rows, { currency: q.currency, preferredPeriod: q.preferredPeriod, totalCount: sample.totalCount, asOf: q.now });
    },
  };
}
