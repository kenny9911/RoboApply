// server/src/features/admin/costs.ts — cost by SKU × brand × day
// (ARCHITECTURE.md §10.4: "The admin operations console groups cost by SKU ×
// brand × day"). Source: UsageDeductionLog.platformCostUsd (our spend, not
// what users pay). Brand = the row's `metadata.brand`, else the user's brand.
// Platform (shared) costs are classified by PLATFORM_SKUS (WP-17 request),
// not by the logging user id, so RA_SYSTEM_USER_ID may be any account.
//
// The database is shared with the recruiting product: only RoboApply SKUs
// (raFeatureCatalog) and rows of users with a seeker profile are counted.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { httpError } from '../../platform/http.js';
import { FEATURE_BY_SKU, PLATFORM_SKUS } from '../../roboapply/v2/lib/raFeatureCatalog.js';
import { MAX_COST_DAYS, type CostRow, type CostsResponse } from './contract.js';

const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_COST_DAYS = 30;

export interface CostQuery {
  from: Date;
  /** Exclusive end (the day after `to`). */
  toExclusive: Date;
  brand?: string;
  sku?: string;
}

export interface CostStore {
  costRows(query: CostQuery): Promise<Array<Omit<CostRow, 'platform'>>>;
}

/** Resolve `from`/`to` (YYYY-MM-DD, UTC, inclusive) with the defaults and the span cap. */
export function resolveCostRange(input: { from?: string; to?: string }, now: Date = new Date()): { from: string; to: string; fromDate: Date; toExclusive: Date } {
  const today = now.toISOString().slice(0, 10);
  const to = input.to ?? today;
  const toDate = new Date(`${to}T00:00:00.000Z`);
  const fromDate = input.from ? new Date(`${input.from}T00:00:00.000Z`) : new Date(toDate.getTime() - (DEFAULT_COST_DAYS - 1) * DAY_MS);
  if (Number.isNaN(toDate.getTime()) || Number.isNaN(fromDate.getTime())) throw httpError('invalid_request', 'Use dates like 2026-10-01.');
  if (fromDate > toDate) throw httpError('invalid_request', 'The start date is after the end date.');
  const days = Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
  if (days > MAX_COST_DAYS) throw httpError('invalid_request', `Choose at most ${MAX_COST_DAYS} days.`);
  return { from: fromDate.toISOString().slice(0, 10), to, fromDate, toExclusive: new Date(toDate.getTime() + DAY_MS) };
}

const num = (v: unknown): number => {
  const x = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export async function getCosts(store: CostStore, input: { from?: string; to?: string; brand?: string; sku?: string }, now?: Date): Promise<CostsResponse> {
  const range = resolveCostRange(input, now);
  const raw = await store.costRows({ from: range.fromDate, toExclusive: range.toExclusive, brand: input.brand, sku: input.sku });
  const rows: CostRow[] = raw
    .map((r) => ({ ...r, costUsd: Math.round(r.costUsd * 1e6) / 1e6, platform: PLATFORM_SKUS.has(r.sku) }))
    .sort((a, b) => (a.day === b.day ? b.costUsd - a.costUsd || a.sku.localeCompare(b.sku) || a.brand.localeCompare(b.brand) : a.day < b.day ? 1 : -1));
  const totals = rows.reduce((t, r) => ({ costUsd: t.costUsd + r.costUsd, units: t.units + r.units, rows: t.rows + r.rows }), { costUsd: 0, units: 0, rows: 0 });
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return { from: range.from, to: range.to, rows, totals };
}

export const COST_CSV_HEADERS = ['day', 'sku', 'brand', 'platform', 'costUsd', 'units', 'rows', 'unpricedRows'] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const raw = String(v);
  const s = typeof v === 'string' && /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV (UTF-8 with BOM, formula-safe) of a cost response. */
export function costsCsv(data: CostsResponse): string {
  const lines = [COST_CSV_HEADERS.join(',')];
  for (const r of data.rows) lines.push(COST_CSV_HEADERS.map((h) => csvCell(r[h])).join(','));
  return '﻿' + lines.join('\n');
}

type Db = Pick<typeof prisma, '$queryRaw'>;

export function createPrismaCostStore(db: Db = prisma): CostStore {
  const raSkus = Object.keys(FEATURE_BY_SKU);
  return {
    async costRows({ from, toExclusive, brand, sku }) {
      const rows = await db.$queryRaw<Array<{ day: string; sku: string; brand: string; cost: number | null; units: number | bigint | null; n_rows: number | bigint; unpriced: number | bigint }>>`
        SELECT day, sku, brand,
          COALESCE(SUM(cost), 0)::float8 AS cost,
          COALESCE(SUM(units), 0) AS units,
          COUNT(*) AS n_rows,
          COUNT(*) FILTER (WHERE cost IS NULL) AS unpriced
        FROM (
          SELECT to_char(d."createdAt", 'YYYY-MM-DD') AS day, d."sku" AS sku,
            COALESCE(NULLIF(d."metadata"->>'brand', ''), u."brand", 'unknown') AS brand,
            d."platformCostUsd" AS cost, d."units" AS units
          FROM "UsageDeductionLog" d
          LEFT JOIN "User" u ON u."id" = d."userId"
          WHERE d."createdAt" >= ${from} AND d."createdAt" < ${toExclusive}
            AND (d."sku" = ANY(${raSkus}) OR EXISTS (SELECT 1 FROM "SeekerProfile" sp WHERE sp."userId" = d."userId"))
            ${sku ? Prisma.sql`AND d."sku" = ${sku}` : Prisma.empty}
        ) t
        ${brand ? Prisma.sql`WHERE brand = ${brand}` : Prisma.empty}
        GROUP BY day, sku, brand`;
      return rows.map((r) => ({ day: r.day, sku: r.sku, brand: r.brand, costUsd: num(r.cost), units: num(r.units), rows: num(r.n_rows), unpricedRows: num(r.unpriced) }));
    },
  };
}
