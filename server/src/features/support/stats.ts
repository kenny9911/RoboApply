// server/src/features/support/stats.ts
//
// The public counts the marketing site prints (TASK_PLAN.md WP-40; PRODUCT
// §9.3 "Marketing counters"). Pure helpers plus one cached reader.
//
// D3 rules carried here, tested in support.test.ts:
//   - every count filters the public-count predicate (`publicCountWhere`):
//     visibility='public' AND isCanonical AND archivedAt IS NULL AND
//     closedAt IS NULL AND market = brand.market, so a user's imported
//     (private) job never counts;
//   - fraud-flagged jobs never count;
//   - each number is rounded DOWN to two significant figures (12,345 → 12,000)
//     so the page never claims more than we hold;
//   - counts are cached for an hour per brand, never stored in copy;
//   - popular job lists link only roles whose jobs may be shown publicly
//     (`publicDisplay`, ARCH §9.4) and that meet the role floor (≥ 20).

import { Prisma } from '../../generated/prisma/client.js';
import { getTaxonomyNode } from '../jobs/taxonomy/index.js';
import type { Market } from '../../platform/brand/registry.js';
import { sourced } from '../../platform/http.js';
import {
  INDEX_COUNT_METHOD,
  INDEX_STATS_PARTIAL_TTL_MS,
  INDEX_STATS_TTL_MS,
  POPULAR_LIST_MAX,
  POPULAR_LIST_MIN_JOBS,
  type IndexStatsResponse,
  type PopularJobList,
} from './contract.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Round a non-negative count DOWN to `digits` significant figures (12,345 → 12,000; 950 → 950; 0 → 0). */
export function roundDownSignificant(n: number, digits = 2): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n);
  const magnitude = Math.floor(Math.log10(whole));
  const unit = 10 ** Math.max(0, magnitude - digits + 1);
  return Math.floor(whole / unit) * unit;
}

/** The public-count predicate (TASK_PLAN.md §2.2) for one market. */
export function publicCountWhere(market: Market): Prisma.RAJobWhereInput {
  return {
    market,
    visibility: 'public',
    isCanonical: true,
    archivedAt: null,
    closedAt: null,
    // Jobs flagged by the anti-fraud classifier are excluded until reviewed
    // (WP-41): no flags = SQL/JSON null or an empty list.
    OR: [{ fraudFlags: { equals: Prisma.AnyNull } }, { fraudFlags: { equals: [] } }],
  };
}

/** The narrow Prisma surface the counter needs (tests pass a fake). */
export interface IndexStatsDb {
  rAJob: {
    count(args: { where: Prisma.RAJobWhereInput }): Promise<number>;
    groupBy(args: {
      by: ['primaryTaxonomyId'];
      where: Prisma.RAJobWhereInput;
      _count: { _all: true };
      orderBy: { _count: { primaryTaxonomyId: 'desc' } };
      having: { primaryTaxonomyId: { _count: { gte: number } } };
      take: number;
    }): Promise<Array<{ primaryTaxonomyId: string | null; _count: { _all: number } }>>;
  };
}

function sourcedCount(raw: number | null, asOf: Date) {
  if (raw === null) return null;
  return sourced(roundDownSignificant(raw), { source: 'index', method: INDEX_COUNT_METHOD, asOf });
}

/**
 * Compute the stats once (no cache). Each part fails soft to "unknown"
 * (null / []), never to 0, and a failed part sets `partial` so neither the
 * cache nor the CDN keeps the gap for long.
 */
export async function computeIndexStats(db: IndexStatsDb, market: Market, now: Date = new Date()): Promise<IndexStatsResponse> {
  const where = publicCountWhere(market);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  let partial = false;
  const failed = <T>(fallback: T) => () => {
    partial = true;
    return fallback;
  };
  const [open, week, groups] = await Promise.all([
    db.rAJob.count({ where }).catch(failed<number | null>(null)),
    db.rAJob.count({ where: { ...where, firstSeenAt: { gte: weekAgo } } }).catch(failed<number | null>(null)),
    db.rAJob
      .groupBy({
        by: ['primaryTaxonomyId'],
        where: { ...where, publicDisplay: true, primaryTaxonomyId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { primaryTaxonomyId: 'desc' } },
        having: { primaryTaxonomyId: { _count: { gte: POPULAR_LIST_MIN_JOBS } } },
        take: POPULAR_LIST_MAX * 2,
      })
      .catch(failed<Array<{ primaryTaxonomyId: string | null; _count: { _all: number } }>>([])),
  ]);

  const popularLists: PopularJobList[] = [];
  for (const g of groups) {
    if (popularLists.length >= POPULAR_LIST_MAX) break;
    if (!g.primaryTaxonomyId || g._count._all < POPULAR_LIST_MIN_JOBS) continue;
    const node = getTaxonomyNode(g.primaryTaxonomyId);
    if (!node) continue;
    popularLists.push({ taxonomyId: node.id, label: node.en, labelZh: node.zh });
  }

  return {
    openRoles: sourcedCount(open, now),
    addedThisWeek: sourcedCount(week, now),
    popularLists,
    asOf: now.toISOString(),
    partial,
  };
}

export interface IndexStatsCache {
  get(market: Market, now?: Date): Promise<IndexStatsResponse>;
  clear(): void;
}

/**
 * Hourly cache per market. Concurrent misses share one computation. A partial
 * result (a query failed) is kept only `partialTtlMs`; a rejected one not at all.
 */
export function createIndexStatsCache(
  db: () => Promise<IndexStatsDb> | IndexStatsDb,
  ttlMs: number = INDEX_STATS_TTL_MS,
  partialTtlMs: number = INDEX_STATS_PARTIAL_TTL_MS,
): IndexStatsCache {
  const entries = new Map<Market, { at: number; ttl: number; value: Promise<IndexStatsResponse> }>();
  return {
    async get(market, now = new Date()) {
      const hit = entries.get(market);
      if (hit && now.getTime() - hit.at < hit.ttl) return hit.value;
      const value = Promise.resolve(db()).then((d) => computeIndexStats(d, market, now));
      const entry = { at: now.getTime(), ttl: ttlMs, value };
      entries.set(market, entry);
      try {
        const result = await value;
        if (result.partial) entry.ttl = Math.min(ttlMs, partialTtlMs);
        return result;
      } catch (err) {
        if (entries.get(market) === entry) entries.delete(market);
        throw err;
      }
    },
    clear() {
      entries.clear();
    },
  };
}
