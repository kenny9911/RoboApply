// server/src/features/copilot/salaryStats.ts — posted pay ranges for the
// Assistant's `salary_context` tool (ARCH §5.2; PRODUCT F-ORION-09; D3).
//
// "Salary advice cites posted ranges with counts; never invents market data."
// The aggregate comes from our own index only, over the rows every public
// aggregate uses (TASK_PLAN §2.2): visibility='public' AND isCanonical AND
// archivedAt IS NULL AND market = brand.market (users' imported jobs never
// count), still open, posted in the last 365 days. Pay is taken per posting
// as the midpoint of its stated range, in ONE currency and period (the
// largest group). Fewer than MIN_SAMPLE postings → the aggregate is
// suppressed (null) and only the counts are returned.
//
// Read-only. ARCH names a MarketStatsService for this; none exists yet, so
// the query lives here behind `SalaryStatsDb` (a typed Pick of the client).
// That bypasses the cross-area seam rule (TASK_PLAN §2.1 rule 4) and repeats
// the public-aggregate filter outside the jobs/feed area: REQ-50-01 asks the
// owner to expose `marketStats.salary(input)` on its index.ts; switch to it
// and delete `salaryStats()` once it lands. `summarizePay` (pure) can move
// with it.

import type { Prisma } from '../../generated/prisma/client.js';
import { MIN_SAMPLE, meetsMinSample, type Sourced } from '../../platform/http.js';
import type { Market } from '../../platform/brand/registry.js';

export const SALARY_LOOKBACK_DAYS = 365;
/** Rows read per aggregate (the newest first). */
export const SALARY_ROW_CAP = 3000;

export interface SalaryStatsInput {
  market: Market;
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

export type SalaryStatsDb = {
  rAJob: {
    findMany(args: { where: Prisma.RAJobWhereInput; select: Record<keyof PayRow, true>; orderBy: Prisma.RAJobOrderByWithRelationInput; take: number }): Promise<PayRow[]>;
    count(args: { where: Prisma.RAJobWhereInput }): Promise<number>;
  };
};

/** The public-aggregate `where` (TASK_PLAN §2.2) plus the role and place scope. */
export function salaryWhere(input: SalaryStatsInput): Prisma.RAJobWhereInput {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - SALARY_LOOKBACK_DAYS * 86_400_000);
  const and: Prisma.RAJobWhereInput[] = [
    { market: input.market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
    { postedAt: { gte: since } },
  ];
  if (input.taxonomyId) and.push({ taxonomyIds: { has: input.taxonomyId } });
  else if (input.title?.trim()) and.push({ title: { contains: input.title.trim(), mode: 'insensitive' } });
  if (input.country) and.push({ locationCountry: input.country.toUpperCase() });
  if (input.city?.trim()) and.push({ locationCity: { equals: input.city.trim(), mode: 'insensitive' } });
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

/**
 * @deprecated Direct `RAJob` read outside the jobs/feed area. Replace with
 * `marketStats.salary()` from the owning area's index.ts (REQ-50-01).
 */
export async function salaryStats(db: SalaryStatsDb, input: SalaryStatsInput): Promise<SalaryStatsResult> {
  const now = input.now ?? new Date();
  const where = salaryWhere({ ...input, now });
  const [rows, totalCount] = await Promise.all([
    db.rAJob.findMany({
      where,
      select: { salaryMin: true, salaryMax: true, salaryCurrency: true, salaryPeriod: true },
      orderBy: { postedAt: 'desc' },
      take: SALARY_ROW_CAP,
    }),
    db.rAJob.count({ where }),
  ]);
  return summarizePay(rows, {
    totalCount,
    asOf: now,
    scope: { taxonomyId: input.taxonomyId ?? null, title: input.taxonomyId ? null : (input.title?.trim() || null), country: input.country ?? null, city: input.city ?? null },
  });
}
