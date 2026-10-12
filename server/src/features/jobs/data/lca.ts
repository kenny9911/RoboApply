// server/src/features/jobs/data/lca.ts — US DOL LCA disclosure rows → per-employer
// H-1B statistics (RAH1bEmployerStat; PRODUCT "H-1B history", flag `h1bHistory`).
//
// Pure: rows in, aggregates out. No file access, no database, no network —
// importLca.ts (the CLI) reads the file and writes the rows.
//
// Source: the US Department of Labor, Office of Foreign Labor Certification,
// "LCA Programs (H-1B, H-1B1, E-3)" disclosure files (public domain; one
// cumulative file per fiscal-year quarter). What is kept per employer and
// fiscal year (D3: counts and a median of the source's own figures, nothing
// estimated):
//   certifiedCount       H-1B applications with CASE_STATUS "Certified"
//   withdrawnCount       "Certified - Withdrawn" and "Withdrawn"
//   medianWageAnnualUsd  median offered wage (WAGE_RATE_OF_PAY_FROM) of the
//                        certified applications, annualised; null below
//                        `minWageSample` filings (the platform's N ≥ 20 rule)
//   topTitles            the job titles with the most certified applications
// A certified application is not a visa approval or a hire; the reader says so
// (H1B_DISCLAIMER). H-1B1 (Chile / Singapore) and E-3 rows are not H-1B and
// are skipped. The employer key is `normalizeCompanyName`, the same key
// RACompany.nameNormalized carries, so the H-1B route finds the rows.

import { MIN_SAMPLE } from '../../../platform/http.js';
import { normalizeCompanyName } from '../normalize/index.js';

/** `source` of every figure read from these rows (contract H1bHistoryResponse). */
export const LCA_SOURCE = 'dol_lca' as const;
export const LCA_TOP_TITLES = 5;
/** Hours, weeks, pay periods and months in a work year, for annualising a stated wage. */
export const LCA_ANNUAL_FACTOR: Readonly<Record<string, number>> = { year: 1, month: 12, 'bi-weekly': 26, week: 52, hour: 2080 };

/** One disclosure row, keyed by the file's column headers (any case). */
export type LcaRawRow = Record<string, unknown>;

export interface LcaCase {
  employerName: string;
  employerNameNormalized: string;
  fiscalYear: number;
  status: 'certified' | 'withdrawn';
  jobTitle: string | null;
  /** Offered wage, annualised in USD; null when the row states none we can annualise. */
  wageAnnualUsd: number | null;
}

export type LcaSkipReason = 'not_h1b' | 'status' | 'no_employer' | 'no_fiscal_year';

export interface H1bEmployerStat {
  employerNameNormalized: string;
  fiscalYear: number;
  certifiedCount: number;
  withdrawnCount: number;
  medianWageAnnualUsd: number | null;
  topTitles: Array<{ title: string; count: number; medianWageAnnualUsd: number | null }>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : v instanceof Date ? v.toISOString() : '');

/** A row with upper-case, trimmed header keys (files differ in case and stray spaces). */
function byHeader(row: LcaRawRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.trim().toUpperCase()] = v;
  return out;
}

/** "$120,000.00" / 120000 → 120000; anything else → null. */
export function parseMoney(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const n = Number(text(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** US federal fiscal year of a date (1 October – 30 September; FY2026 starts 2025-10-01). */
export function fiscalYearOf(date: Date): number {
  return date.getUTCMonth() >= 9 ? date.getUTCFullYear() + 1 : date.getUTCFullYear();
}

/** A date cell: a Date, an ISO / US date string, or an Excel serial day number. */
export function parseLcaDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && Number.isFinite(v) && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86_400_000));
  const s = text(v);
  if (!s) return null;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const d = us ? new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]))) : new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The fiscal year a disclosure file covers, from its name ("LCA_Disclosure_Data_FY2026_Q3.xlsx" → 2026). */
export function fiscalYearFromFileName(name: string): number | null {
  const m = name.match(/FY[\s_-]?(20\d{2})/i);
  return m ? Number(m[1]) : null;
}

/**
 * One disclosure row → a case we count, or why it is skipped. `fiscalYear`
 * (from the file name or the command line) wins; otherwise the row's
 * DECISION_DATE decides.
 */
export function parseLcaRow(raw: LcaRawRow, options: { fiscalYear?: number | null } = {}): LcaCase | { skip: LcaSkipReason } {
  const row = byHeader(raw);
  // "H-1B" only: "H-1B1 Chile", "H-1B1 Singapore" and "E-3 Australian" are other programmes.
  if (text(row.VISA_CLASS).toUpperCase() !== 'H-1B') return { skip: 'not_h1b' };
  const rawStatus = text(row.CASE_STATUS).toLowerCase().replace(/\s+/g, ' ');
  const status = rawStatus === 'certified' ? 'certified' : rawStatus === 'certified - withdrawn' || rawStatus === 'certified-withdrawn' || rawStatus === 'withdrawn' ? 'withdrawn' : null;
  if (!status) return { skip: 'status' };
  const employerName = text(row.EMPLOYER_NAME);
  const employerNameNormalized = employerName ? normalizeCompanyName(employerName) : '';
  if (!employerNameNormalized) return { skip: 'no_employer' };
  const decided = parseLcaDate(row.DECISION_DATE);
  const fiscalYear = options.fiscalYear ?? (decided ? fiscalYearOf(decided) : null);
  if (!fiscalYear || fiscalYear < 2000 || fiscalYear > 2100) return { skip: 'no_fiscal_year' };
  const wage = parseMoney(row.WAGE_RATE_OF_PAY_FROM);
  const factor = LCA_ANNUAL_FACTOR[text(row.WAGE_UNIT_OF_PAY).toLowerCase()];
  return {
    employerName,
    employerNameNormalized,
    fiscalYear,
    status,
    jobTitle: text(row.JOB_TITLE) || null,
    wageAnnualUsd: wage !== null && factor ? Math.round(wage * factor) : null,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

interface Bucket {
  employerNameNormalized: string;
  fiscalYear: number;
  certified: number;
  withdrawn: number;
  wages: number[];
  titles: Map<string, { title: string; count: number; wages: number[] }>;
}

export interface LcaAggregateResult {
  stats: H1bEmployerStat[];
  /** Rows read, counted and skipped (by reason), for the import report. */
  rows: { read: number; counted: number; skipped: Record<LcaSkipReason, number> };
}

/**
 * Streaming aggregator: `add` every row, then `result()`. A median is
 * published only from `minWageSample` certified wages or more (default
 * MIN_SAMPLE, 20): fewer filings would describe individual people's pay.
 */
export function createLcaAggregator(options: { fiscalYear?: number | null; minWageSample?: number; topTitles?: number } = {}) {
  const minWageSample = Math.max(1, Math.floor(options.minWageSample ?? MIN_SAMPLE));
  const top = Math.max(0, Math.floor(options.topTitles ?? LCA_TOP_TITLES));
  const buckets = new Map<string, Bucket>();
  const rows = { read: 0, counted: 0, skipped: { not_h1b: 0, status: 0, no_employer: 0, no_fiscal_year: 0 } as Record<LcaSkipReason, number> };
  const wageMedian = (wages: number[]) => (wages.length >= minWageSample ? median(wages) : null);

  return {
    add(raw: LcaRawRow): void {
      rows.read += 1;
      const c = parseLcaRow(raw, { fiscalYear: options.fiscalYear });
      if ('skip' in c) {
        rows.skipped[c.skip] += 1;
        return;
      }
      rows.counted += 1;
      const key = `${c.employerNameNormalized}\u0000${c.fiscalYear}`;
      let b = buckets.get(key);
      if (!b) {
        b = { employerNameNormalized: c.employerNameNormalized, fiscalYear: c.fiscalYear, certified: 0, withdrawn: 0, wages: [], titles: new Map() };
        buckets.set(key, b);
      }
      if (c.status === 'withdrawn') {
        b.withdrawn += 1;
        return;
      }
      b.certified += 1;
      if (c.wageAnnualUsd !== null) b.wages.push(c.wageAnnualUsd);
      if (c.jobTitle) {
        const titleKey = c.jobTitle.toLowerCase().replace(/\s+/g, ' ');
        const t = b.titles.get(titleKey) ?? { title: c.jobTitle.replace(/\s+/g, ' '), count: 0, wages: [] };
        t.count += 1;
        if (c.wageAnnualUsd !== null) t.wages.push(c.wageAnnualUsd);
        b.titles.set(titleKey, t);
      }
    },
    result(): LcaAggregateResult {
      const stats = [...buckets.values()]
        .map((b): H1bEmployerStat => ({
          employerNameNormalized: b.employerNameNormalized,
          fiscalYear: b.fiscalYear,
          certifiedCount: b.certified,
          withdrawnCount: b.withdrawn,
          medianWageAnnualUsd: wageMedian(b.wages),
          topTitles: [...b.titles.values()]
            .sort((x, y) => y.count - x.count || x.title.localeCompare(y.title))
            .slice(0, top)
            .map((t) => ({ title: t.title, count: t.count, medianWageAnnualUsd: wageMedian(t.wages) })),
        }))
        .sort((x, y) => x.employerNameNormalized.localeCompare(y.employerNameNormalized) || x.fiscalYear - y.fiscalYear);
      return { stats, rows: { ...rows, skipped: { ...rows.skipped } } };
    },
  };
}

/** Aggregate rows already in memory (tests, small files). */
export function aggregateLca(rows: Iterable<LcaRawRow>, options: Parameters<typeof createLcaAggregator>[0] = {}): LcaAggregateResult {
  const agg = createLcaAggregator(options);
  for (const r of rows) agg.add(r);
  return agg.result();
}

/** The delegate the upsert needs (typed Prisma in production, a fake in tests). */
export interface H1bStatDb {
  rAH1bEmployerStat: {
    upsert(args: {
      where: { employerNameNormalized_fiscalYear: { employerNameNormalized: string; fiscalYear: number } };
      create: H1bStatWrite;
      update: Omit<H1bStatWrite, 'employerNameNormalized' | 'fiscalYear'>;
    }): Promise<unknown>;
  };
}

export interface H1bStatWrite extends H1bEmployerStat {
  sourceFile: string;
  /** When the file was imported: the `asOf` the reader shows with source 'dol_lca'. */
  importedAt: Date;
}

/**
 * Write the statistics: one row per (employer, fiscal year), replaced on a
 * re-import (each quarterly file is cumulative for its fiscal year, so the
 * newest file of a year is the truth for that year). Returns rows written.
 */
export async function upsertH1bStats(db: H1bStatDb, stats: readonly H1bEmployerStat[], meta: { sourceFile: string; importedAt: Date }): Promise<number> {
  let written = 0;
  for (const s of stats) {
    const data = {
      certifiedCount: s.certifiedCount,
      withdrawnCount: s.withdrawnCount,
      medianWageAnnualUsd: s.medianWageAnnualUsd,
      topTitles: s.topTitles,
      sourceFile: meta.sourceFile,
      importedAt: meta.importedAt,
    };
    await db.rAH1bEmployerStat.upsert({
      where: { employerNameNormalized_fiscalYear: { employerNameNormalized: s.employerNameNormalized, fiscalYear: s.fiscalYear } },
      create: { employerNameNormalized: s.employerNameNormalized, fiscalYear: s.fiscalYear, ...data },
      update: data,
    });
    written += 1;
  }
  return written;
}
