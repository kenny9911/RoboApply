// server/src/features/jobs/backfill/clearImplausiblePay.ts
//
// Backfill for SM-10: pay figures that cannot be pay for their period
// ("$60,000,000 an hour", "$15 a year") on rows stored before the normalizer
// refused them (normalize/salary.ts `payPlausible`). New rows never store such
// figures, and every reader already ignores them (feed/ranking.ts annualPay,
// the feed card, job detail); this removes them from what SQL still sees: the
// pay-floor filter, the "highest pay" order and pay statistics.
//
// For each such row of one market that is not archived: salaryMin, salaryMax,
// salaryAnnualMin and salaryAnnualMax become null and salaryDisclosed false.
// The words the posting used (`salaryText`) stay, as do the currency and the
// period, so the card can still say what the posting said. Pages of 500 in id
// order; a dry run (the default) writes nothing. A second run finds nothing.

import { payPlausible } from '../normalize/index.js';
import type { BackfillMarket } from './rematchRoles.js';

/** Rows read per page. */
export const PAY_PAGE_SIZE = 500;

export interface PayRow {
  id: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryMonths: number | null;
  salaryText: string | null;
}

/** The slice of the Prisma client the pay backfill uses. */
export interface PayDb {
  rAJob: {
    findMany(args: {
      where: { market: string; archivedAt: null; OR: [{ salaryMin: { not: null } }, { salaryMax: { not: null } }]; id?: { gt: string } };
      orderBy: { id: 'asc' };
      take: number;
      select: Record<keyof PayRow, true>;
    }): Promise<PayRow[]>;
    update(args: { where: { id: string }; data: typeof CLEARED_PAY; select: { id: true } }): Promise<unknown>;
  };
}

/** What a row with implausible figures is set to (`salaryText` is not touched). */
export const CLEARED_PAY = { salaryMin: null, salaryMax: null, salaryAnnualMin: null, salaryAnnualMax: null, salaryDisclosed: false } as const;

export interface PayChange {
  jobId: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  /** The posting's own words, which are kept. */
  salaryText: string | null;
}

export interface ClearPayOptions {
  market: BackfillMarket;
  /** False (the default) is a dry run: nothing is written. */
  apply?: boolean;
  /** Stop after this many rows with a pay figure. */
  limit?: number | null;
  pageSize?: number;
  db: PayDb;
  onChange?: (change: PayChange) => void;
}

export interface ClearPayReport {
  task: 'clear-implausible-pay';
  market: BackfillMarket;
  apply: boolean;
  /** Rows with a pay figure that were read. */
  scanned: number;
  /** Rows whose figures are not plausible pay (cleared, or in a dry run: that would be cleared). */
  cleared: number;
  changes: PayChange[];
}

const SELECT = { id: true, salaryMin: true, salaryMax: true, salaryCurrency: true, salaryPeriod: true, salaryMonths: true, salaryText: true } as const;

/** Clear stored pay figures that are not plausible pay. Dry run unless `apply`. */
export async function clearImplausiblePay(options: ClearPayOptions): Promise<ClearPayReport> {
  const apply = options.apply === true;
  const pageSize = Math.max(1, options.pageSize ?? PAY_PAGE_SIZE);
  const limit = options.limit && options.limit > 0 ? options.limit : Infinity;
  const report: ClearPayReport = { task: 'clear-implausible-pay', market: options.market, apply, scanned: 0, cleared: 0, changes: [] };
  let cursor: string | null = null;
  while (report.scanned < limit) {
    const take = Math.min(pageSize, limit - report.scanned);
    const rows: PayRow[] = await options.db.rAJob.findMany({
      where: { market: options.market, archivedAt: null, OR: [{ salaryMin: { not: null } }, { salaryMax: { not: null } }], ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take,
      select: SELECT,
    });
    if (!rows.length) break;
    for (const row of rows) {
      report.scanned++;
      if (payPlausible({ min: row.salaryMin, max: row.salaryMax, currency: row.salaryCurrency, period: row.salaryPeriod, months: row.salaryMonths })) continue;
      if (apply) await options.db.rAJob.update({ where: { id: row.id }, data: CLEARED_PAY, select: { id: true } });
      const change: PayChange = { jobId: row.id, salaryMin: row.salaryMin, salaryMax: row.salaryMax, salaryCurrency: row.salaryCurrency, salaryPeriod: row.salaryPeriod, salaryText: row.salaryText };
      report.cleared++;
      report.changes.push(change);
      options.onChange?.(change);
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < take) break;
  }
  return report;
}
