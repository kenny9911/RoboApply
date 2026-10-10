// server/src/features/onboarding/snapshot.ts — O2 "Open roles right now" (WP-30; F-SAL-02 adapted).
//
// Computed from our own RAJob inventory for the last 30 days. D3 rules
// (TASK_PLAN.md §2.2, H17/H18):
//   - counts only public, canonical, live rows of the brand's market
//     (`visibility='public' AND isCanonical AND archivedAt IS NULL AND
//     market = brand.market`); a user's imported job never counts;
//   - N is always returned (as `Sourced`, source 'index');
//   - pay only when ≥ MIN_SAMPLE (20) rows list pay in ONE currency and
//     period (the most common pair); never mixes currencies; "Pay listed on
//     {X} of {N} posts";
//   - top skills only when N ≥ MIN_SAMPLE;
//   - cached for 6 hours per (market, title, country, city).

import { MIN_SAMPLE } from '../../platform/http.js';
import type { MarketSnapshotResponse } from './contract.js';

export const SNAPSHOT_WINDOW_DAYS = 30;
export const SNAPSHOT_CACHE_MS = 6 * 60 * 60 * 1000;
/** Rows read for the pay/skills aggregates (N itself is an exact count). */
export const SNAPSHOT_ROW_CAP = 5000;
export const SNAPSHOT_TOP_SKILLS = 6;

export interface SnapshotQuery {
  market: 'intl' | 'cn';
  taxonomyId: string;
  country: string;
  city?: string;
}

export interface SnapshotRow {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryDisclosed: boolean;
  skills: string[];
}

/** The Prisma `where` for snapshot rows: the D3 public-count predicate + title, place and window. */
export function snapshotWhere(q: SnapshotQuery, now: Date) {
  const since = new Date(now.getTime() - SNAPSHOT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    market: q.market,
    visibility: 'public',
    isCanonical: true,
    archivedAt: null,
    taxonomyIds: { has: q.taxonomyId },
    locationCountry: q.country,
    ...(q.city ? { locationCity: { equals: q.city, mode: 'insensitive' as const } } : {}),
    OR: [{ postedAt: { gte: since } }, { postedAt: null, createdAt: { gte: since } }],
  };
}

const PAY_PERIODS = new Set(['year', 'month', 'hour']);

/** Rows of `snapshotWhere` that list pay (the "X" of "Pay listed on X of N"); same test as computeSnapshot. */
export function payListedWhere(q: SnapshotQuery, now: Date) {
  return {
    AND: [
      snapshotWhere(q, now),
      {
        salaryDisclosed: true,
        salaryCurrency: { not: null },
        salaryPeriod: { in: [...PAY_PERIODS] },
        OR: [{ salaryMin: { not: null } }, { salaryMax: { not: null } }],
      },
    ],
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Pure aggregate over the loaded rows. `listedTotal` is the exact number of
 * pay-listing rows when the loaded rows were capped (else they are all here).
 */
export function computeSnapshot(count: number, rows: SnapshotRow[], asOf: Date, listedTotal?: number): MarketSnapshotResponse {
  const iso = asOf.toISOString();
  const listed = rows.filter(
    (r) => r.salaryDisclosed && r.salaryCurrency && r.salaryPeriod && PAY_PERIODS.has(r.salaryPeriod) && (r.salaryMin ?? r.salaryMax) != null,
  );
  // The most common (currency, period); ties break alphabetically so the answer is stable.
  const groups = new Map<string, SnapshotRow[]>();
  for (const r of listed) {
    const key = `${r.salaryCurrency}|${r.salaryPeriod}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const top = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  let pay: MarketSnapshotResponse['pay'] = null;
  if (top && top[1].length >= MIN_SAMPLE) {
    const [currency, period] = top[0].split('|');
    const lows = top[1].map((r) => (r.salaryMin ?? r.salaryMax) as number);
    const highs = top[1].map((r) => (r.salaryMax ?? r.salaryMin) as number);
    pay = {
      listedCount: Math.max(listedTotal ?? 0, listed.length),
      sampleSize: top[1].length,
      currency,
      period: period as 'year' | 'month' | 'hour',
      low: median(lows),
      high: median(highs),
      source: 'index',
      asOf: iso,
    };
  }
  const topSkills: MarketSnapshotResponse['topSkills'] = [];
  if (count >= MIN_SAMPLE) {
    const freq = new Map<string, number>();
    for (const r of rows) for (const s of new Set(r.skills.map((x) => x.trim().toLowerCase()).filter(Boolean))) freq.set(s, (freq.get(s) ?? 0) + 1);
    for (const [value, c] of [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, SNAPSHOT_TOP_SKILLS)) {
      topSkills.push({ value, count: c, sampleSize: rows.length, source: 'index', asOf: iso });
    }
  }
  return {
    jobCount: { value: count, source: 'index', sampleSize: count, asOf: iso },
    windowDays: SNAPSHOT_WINDOW_DAYS,
    pay,
    topSkills,
  };
}

/** The narrow DB surface the snapshot needs (typed Prisma satisfies it; tests pass a fake). */
export interface SnapshotDb {
  rAJob: {
    count(args: { where: ReturnType<typeof snapshotWhere> | ReturnType<typeof payListedWhere> }): Promise<number>;
    findMany(args: {
      where: ReturnType<typeof snapshotWhere>;
      select: Record<keyof SnapshotRow, true>;
      take: number;
      orderBy: { postedAt: 'desc' };
    }): Promise<SnapshotRow[]>;
  };
}

const SELECT = {
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryDisclosed: true,
  skills: true,
} as const;

export function createSnapshotLoader(getDb: () => Promise<SnapshotDb>, now: () => Date = () => new Date(), rowCap: number = SNAPSHOT_ROW_CAP) {
  const cache = new Map<string, { at: number; value: MarketSnapshotResponse }>();
  return async function load(q: SnapshotQuery): Promise<MarketSnapshotResponse> {
    const key = [q.market, q.taxonomyId, q.country, (q.city ?? '').toLowerCase()].join('|');
    const t = now();
    const hit = cache.get(key);
    if (hit && t.getTime() - hit.at < SNAPSHOT_CACHE_MS) return hit.value;
    const db = await getDb();
    const where = snapshotWhere(q, t);
    const [count, rows] = await Promise.all([
      db.rAJob.count({ where }),
      db.rAJob.findMany({ where, select: SELECT, take: rowCap, orderBy: { postedAt: 'desc' } }),
    ]);
    // Above the row cap the loaded rows are a sample: count the pay-listing rows exactly so "X of N" is not undercounted.
    const listedTotal = count > rows.length ? await db.rAJob.count({ where: payListedWhere(q, t) }) : undefined;
    const value = computeSnapshot(count, rows, t, listedTotal);
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: t.getTime(), value });
    return value;
  };
}
