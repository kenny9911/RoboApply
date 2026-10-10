// server/src/features/feed/marketStats.ts — posted-pay aggregates over the job
// index (REQ-50-01, REQ-64-01; ARCH "MarketStatsService"; D3).
//
// "Salary advice cites posted ranges with counts; never invents market data."
// One reader for every area that needs posted pay for a role (the Assistant's
// salary_context, the offer benchmark): they call `marketStats` instead of
// reading RAJob themselves (TASK_PLAN §2.1 rule 4).
//
// Rows counted (TASK_PLAN §2.2, the public-aggregate filter):
//   visibility = 'public' AND isCanonical AND archivedAt IS NULL AND
//   market = brand.market — a user's own imported job never counts — still
//   open (closedAt IS NULL), posted in the last 365 days.
// On GoApply additionally: not fraud-flagged, and the recruitment-info rule
// (`cnAggregateWhere`, equal to cn/jobs `cnPostingsWhere(null)`): postings are
// counted by default (D5); with CN_RECRUITMENT_INFO_MODE set to `off` the
// brand shows no third-party posting, so the filter matches nothing and every
// figure is suppressed.
//
// Pay per posting is the midpoint of its stated range, in ONE currency and
// period (the largest group). Fewer than MIN_SAMPLE (20) postings → the
// aggregate is null and only the counts are returned ("Not enough data").
//
// Read-only and typed (`MarketStatsDb` is a Pick of the client; the Prisma
// client is imported lazily, so importing the area opens no pool).

import { Prisma } from '../../generated/prisma/client.js';
import { getCurrentBrandOrDefault } from '../../platform/brand/brandContext.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { Market } from '../../platform/brand/registry.js';
import { cnRecruitmentInfoMode } from '../../platform/flags.js';
import { MIN_SAMPLE, meetsMinSample, type Sourced } from '../../platform/http.js';

export const SALARY_LOOKBACK_DAYS = 365;
/** Rows read per aggregate (the newest first). */
export const SALARY_ROW_CAP = 3000;

export interface SalaryStatsInput {
  /** Defaults to the current brand's market. */
  market?: Market;
  taxonomyId?: string | null;
  title?: string | null;
  /** ISO 3166-1 alpha-2. */
  country?: string | null;
  city?: string | null;
  now?: Date;
}

export interface PayRow {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}

export interface SalaryStatsResult {
  /** Postings that matched (pay listed or not). */
  totalCount: number;
  /** Of those, postings that list pay in the reported currency and period. */
  listedCount: number;
  currency: string | null;
  period: string | null;
  /** Null when `listedCount < MIN_SAMPLE` (render "Not enough data"). */
  median: Sourced<number> | null;
  p25: Sourced<number> | null;
  p75: Sourced<number> | null;
  /** What the rows were filtered on (shown with the source line). */
  scope: { taxonomyId: string | null; title: string | null; country: string | null; city: string | null };
  minSample: number;
}

/** The pay rows behind an aggregate (pay fields only: no ids, no text). */
export interface SalarySample {
  rows: PayRow[];
  /** Postings that matched the role and place (pay listed or not). */
  totalCount: number;
  asOf: Date;
}

/** The role and place fields of one job (what an offer benchmark scopes on). */
export interface JobRoleRow {
  title: string;
  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  locationCountry: string | null;
  locationCity: string | null;
}

export type MarketStatsDb = {
  rAJob: {
    findMany(args: { where: Prisma.RAJobWhereInput; select: Record<keyof PayRow, true>; orderBy: Prisma.RAJobOrderByWithRelationInput; take: number }): Promise<PayRow[]>;
    count(args: { where: Prisma.RAJobWhereInput }): Promise<number>;
    findFirst(args: { where: Prisma.RAJobWhereInput; select: Record<keyof JobRoleRow, true> }): Promise<JobRoleRow | null>;
  };
};

/**
 * `fraudFlags` is null or an empty list (`[{ rule, evidence, at }]` otherwise).
 * Same predicate as onboarding-cn's market snapshot; kept here so the feed
 * area does not import that area.
 */
export const NOT_FRAUD_FLAGGED: Prisma.RAJobWhereInput = {
  OR: [{ fraudFlags: { equals: Prisma.DbNull } }, { fraudFlags: { equals: Prisma.JsonNull } }, { fraudFlags: { equals: [] } }],
};

/**
 * The GoApply recruitment-info rule for an aggregate (no viewer): mode off →
 * a predicate no row matches; otherwise public postings. The same fragment
 * cn/jobs `cnPostingsWhere(null, env)` builds (a test keeps the two equal);
 * written here from the platform's mode resolver so the feed area does not
 * load the GoApply jobs area to count rows.
 */
export function cnAggregateWhere(env: EnvSource = process.env): Prisma.RAJobWhereInput {
  return cnRecruitmentInfoMode(env) === 'off' ? { OR: [{ id: { in: [] as string[] } }] } : { OR: [{ visibility: 'public' }] };
}

/** The public-aggregate `where` plus the role and place scope (see the header). */
export function salaryWhere(input: SalaryStatsInput & { market: Market }, env: EnvSource = process.env): Prisma.RAJobWhereInput {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - SALARY_LOOKBACK_DAYS * 86_400_000);
  const and: Prisma.RAJobWhereInput[] = [
    { market: input.market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
    { postedAt: { gte: since } },
  ];
  if (input.market === 'cn') and.push(NOT_FRAUD_FLAGGED, cnAggregateWhere(env));
  const title = input.title?.trim();
  if (input.taxonomyId) and.push({ taxonomyIds: { has: input.taxonomyId } });
  else if (title) and.push({ title: { contains: title, mode: 'insensitive' } });
  if (input.country) and.push({ locationCountry: input.country.toUpperCase() });
  const city = input.city?.trim();
  if (city) and.push({ locationCity: { equals: city, mode: 'insensitive' } });
  return { AND: and };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Pure: group by currency+period, take the largest group, compute the quartiles. */
export function summarizePay(
  rows: readonly PayRow[],
  meta: { totalCount: number; asOf: Date; scope: SalaryStatsResult['scope'] },
  min: number = MIN_SAMPLE,
): SalaryStatsResult {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const lo = typeof r.salaryMin === 'number' && r.salaryMin > 0 ? r.salaryMin : null;
    const hi = typeof r.salaryMax === 'number' && r.salaryMax > 0 ? r.salaryMax : null;
    if (lo === null && hi === null) continue;
    if (!r.salaryCurrency || !r.salaryPeriod) continue;
    const mid = lo !== null && hi !== null ? (lo + hi) / 2 : (lo ?? hi)!;
    const key = `${r.salaryCurrency}|${r.salaryPeriod}`;
    const list = groups.get(key) ?? [];
    list.push(mid);
    groups.set(key, list);
  }
  let bestKey: string | null = null;
  let best: number[] = [];
  for (const [k, list] of groups) {
    if (list.length > best.length) {
      bestKey = k;
      best = list;
    }
  }
  const [currency, period] = bestKey ? (bestKey.split('|') as [string, string]) : [null, null];
  const base = { totalCount: meta.totalCount, listedCount: best.length, currency, period, scope: meta.scope, minSample: min };
  if (!meetsMinSample(best.length, min)) return { ...base, median: null, p25: null, p75: null };
  const sorted = [...best].sort((a, b) => a - b);
  const asOf = meta.asOf.toISOString();
  const s = (value: number): Sourced<number> => ({ value: Math.round(value), source: 'index', sampleSize: sorted.length, asOf, method: 'computed' });
  return { ...base, median: s(quantile(sorted, 0.5)), p25: s(quantile(sorted, 0.25)), p75: s(quantile(sorted, 0.75)) };
}

export interface MarketStats {
  /** Posted pay for a role and place: counts always, quartiles only at N ≥ MIN_SAMPLE. */
  salary(input: SalaryStatsInput): Promise<SalaryStatsResult>;
  /**
   * The pay rows behind `salary` for callers that summarise in their own
   * currency and period (the offer benchmark). `currency` keeps only rows
   * that list pay in it; `totalCount` still counts every matching posting.
   */
  salarySample(input: SalaryStatsInput & { currency?: string | null }): Promise<SalarySample>;
  /** The role and place fields of one job, or null when it is gone. */
  jobRole(jobId: string): Promise<JobRoleRow | null>;
}

export interface MarketStatsDeps {
  db?: () => Promise<MarketStatsDb>;
  env?: EnvSource;
  market?: () => Market;
}

const defaultDb = async (): Promise<MarketStatsDb> => (await import('../../lib/prisma.js')).default as unknown as MarketStatsDb;

export function createMarketStats(deps: MarketStatsDeps = {}): MarketStats {
  const getDb = deps.db ?? defaultDb;
  const env = () => deps.env ?? process.env;
  const marketOf = (input: SalaryStatsInput): Market => input.market ?? (deps.market ?? (() => getCurrentBrandOrDefault().market))();

  async function salarySample(input: SalaryStatsInput & { currency?: string | null }): Promise<SalarySample> {
    const now = input.now ?? new Date();
    const where = salaryWhere({ ...input, market: marketOf(input), now }, env());
    const listedWhere: Prisma.RAJobWhereInput = input.currency
      ? { AND: [where, { salaryCurrency: input.currency }, { OR: [{ salaryMin: { gt: 0 } }, { salaryMax: { gt: 0 } }] }] }
      : where;
    const db = await getDb();
    const [rows, totalCount] = await Promise.all([
      db.rAJob.findMany({
        where: listedWhere,
        select: { salaryMin: true, salaryMax: true, salaryCurrency: true, salaryPeriod: true },
        orderBy: { postedAt: 'desc' },
        take: SALARY_ROW_CAP,
      }),
      db.rAJob.count({ where }),
    ]);
    return { rows, totalCount, asOf: now };
  }

  return {
    salarySample,
    async salary(input) {
      const sample = await salarySample(input);
      return summarizePay(sample.rows, {
        totalCount: sample.totalCount,
        asOf: sample.asOf,
        scope: {
          taxonomyId: input.taxonomyId ?? null,
          title: input.taxonomyId ? null : (input.title?.trim() || null),
          country: input.country ?? null,
          city: input.city ?? null,
        },
      });
    },
    async jobRole(jobId) {
      const db = await getDb();
      return db.rAJob.findFirst({
        where: { id: jobId },
        select: { title: true, taxonomyIds: true, primaryTaxonomyId: true, locationCountry: true, locationCity: true },
      });
    },
  };
}

/** The process-wide reader (runs in the brand of the current request). */
export const marketStats: MarketStats = createMarketStats();
