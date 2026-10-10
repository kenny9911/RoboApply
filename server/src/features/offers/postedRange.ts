// server/src/features/offers/postedRange.ts — posted pay for an offer's role
// (WP-64; PRODUCT §5.15 "a negotiation draft grounded in posted ranges for
// the role (N shown)"; D3).
//
// Source: our own index only, over the rows every public aggregate uses
// (TASK_PLAN §2.2): visibility='public' AND isCanonical AND archivedAt IS NULL
// AND market = brand.market (users' imported jobs never count), still open,
// posted in the last 365 days; on GoApply also not fraud-flagged. Pay per
// posting is the midpoint of its stated range, in the OFFER'S currency, in one
// period (the offer's own when it has enough rows, else the largest group).
// Fewer than MIN_SAMPLE (20) rows → no range (null) and only the counts.
//
// Read-only and typed (`PostedPayDb` is a Pick of the client). The same query
// shape lives in copilot/salaryStats.ts (REQ-50-01 asks the jobs/feed owner
// for `marketStats.salary()`); when that seam lands, swap `createPrismaPostedPay`
// for it (request REQ-64-01) — the pure `summarizePostedPay` stays.

import type { Prisma } from '../../generated/prisma/client.js';
import { MIN_SAMPLE, meetsMinSample, type Sourced } from '../../platform/http.js';
import type { Market } from '../../platform/brand/registry.js';
import { NOT_FRAUD_FLAGGED } from '../onboarding-cn/index.js';
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

export type PostedPayDb = {
  rAJob: {
    findMany(args: { where: Prisma.RAJobWhereInput; select: Record<keyof PostedPayRow, true>; orderBy: Prisma.RAJobOrderByWithRelationInput; take: number }): Promise<PostedPayRow[]>;
    count(args: { where: Prisma.RAJobWhereInput }): Promise<number>;
    findFirst(args: { where: Prisma.RAJobWhereInput; select: Record<keyof JobScopeRow, true> }): Promise<JobScopeRow | null>;
  };
};

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

/** The public-aggregate `where` plus the role and place (no currency: that is the "listed" part). */
export function postedPayWhere(q: Omit<PostedPayQuery, 'currency'>): Prisma.RAJobWhereInput {
  const since = new Date(q.now.getTime() - POSTED_LOOKBACK_DAYS * 86_400_000);
  const and: Prisma.RAJobWhereInput[] = [
    { market: q.market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
    { postedAt: { gte: since } },
  ];
  if (q.market === 'cn') and.push(NOT_FRAUD_FLAGGED);
  if (q.taxonomyId) and.push({ taxonomyIds: { has: q.taxonomyId } });
  else if (q.title) and.push({ title: { contains: q.title, mode: 'insensitive' } });
  if (q.country) and.push({ locationCountry: q.country });
  if (q.city) and.push({ locationCity: { equals: q.city, mode: 'insensitive' } });
  return { AND: and };
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

export function createPrismaPostedPay(getDb: () => Promise<PostedPayDb>): PostedPaySource {
  return {
    async jobScope(jobId) {
      const db = await getDb();
      return db.rAJob.findFirst({
        where: { id: jobId },
        select: { title: true, taxonomyIds: true, primaryTaxonomyId: true, locationCountry: true, locationCity: true },
      });
    },
    async summary(q) {
      const db = await getDb();
      const where = postedPayWhere(q);
      const listedWhere: Prisma.RAJobWhereInput = {
        AND: [where, { salaryCurrency: q.currency }, { OR: [{ salaryMin: { gt: 0 } }, { salaryMax: { gt: 0 } }] }],
      };
      const [rows, totalCount] = await Promise.all([
        db.rAJob.findMany({
          where: listedWhere,
          select: { salaryMin: true, salaryMax: true, salaryCurrency: true, salaryPeriod: true },
          orderBy: { postedAt: 'desc' },
          take: POSTED_ROW_CAP,
        }),
        db.rAJob.count({ where }),
      ]);
      return summarizePostedPay(rows, { currency: q.currency, preferredPeriod: q.preferredPeriod, totalCount, asOf: q.now });
    },
  };
}
