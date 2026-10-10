// @vitest-environment node
//
// US DOL LCA disclosure importer (WP-16b carry-over): the pure parser and
// aggregator on a small fictional fixture in the DOL column layout, the
// upsert by (employer, fiscal year) over a fake delegate, and the CLI options.
// No network (the importer downloads nothing) and no database.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import { MIN_SAMPLE } from '../../../platform/http.js';
import { H1bTopTitlesSchema } from '../companies/contract.js';
import { normalizeCompanyName } from '../normalize/index.js';
import { importLcaFile, parseLcaArgs } from './importLca.js';
import {
  LCA_SOURCE,
  aggregateLca,
  fiscalYearFromFileName,
  fiscalYearOf,
  parseLcaDate,
  parseLcaRow,
  parseMoney,
  upsertH1bStats,
  type H1bStatDb,
  type H1bStatWrite,
} from './lca.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'LCA_Disclosure_Data_FY2026_Q1.sample.csv');
const EXAMPLE = normalizeCompanyName('Example Analytics, Inc.');
const SAMPLE = normalizeCompanyName('Sample Robotics LLC');

const row = (over: Record<string, unknown> = {}) => ({
  CASE_STATUS: 'Certified',
  DECISION_DATE: '12/15/2025',
  VISA_CLASS: 'H-1B',
  JOB_TITLE: 'Software Engineer',
  EMPLOYER_NAME: 'Example Analytics, Inc.',
  WAGE_RATE_OF_PAY_FROM: '120000.00',
  WAGE_UNIT_OF_PAY: 'Year',
  ...over,
});

function fakeDb() {
  const rows = new Map<string, H1bStatWrite>();
  const db: H1bStatDb = {
    rAH1bEmployerStat: {
      async upsert({ where, create, update }) {
        const k = `${where.employerNameNormalized_fiscalYear.employerNameNormalized}|${where.employerNameNormalized_fiscalYear.fiscalYear}`;
        const prior = rows.get(k);
        rows.set(k, prior ? { ...prior, ...update } : create);
      },
    },
  };
  return { db, rows };
}

describe('parseLcaRow', () => {
  it('reads a certified H-1B row: employer key, fiscal year, title and the annualised offered wage', () => {
    expect(parseLcaRow(row())).toEqual({
      employerName: 'Example Analytics, Inc.',
      employerNameNormalized: EXAMPLE,
      fiscalYear: 2026,
      status: 'certified',
      jobTitle: 'Software Engineer',
      wageAnnualUsd: 120000,
    });
  });

  it('annualises by the stated unit; an unknown unit or no wage gives no wage (never a guess)', () => {
    const wage = (w: unknown, unit: string) => (parseLcaRow(row({ WAGE_RATE_OF_PAY_FROM: w, WAGE_UNIT_OF_PAY: unit })) as { wageAnnualUsd: number | null }).wageAnnualUsd;
    expect(wage('50.00', 'Hour')).toBe(104000);
    expect(wage('2,000', 'Week')).toBe(104000);
    expect(wage('4000', 'Bi-Weekly')).toBe(104000);
    expect(wage('$10,000.00', 'Month')).toBe(120000);
    expect(wage(95000, 'Year')).toBe(95000);
    expect(wage('1000', 'Piece')).toBeNull();
    expect(wage('', 'Year')).toBeNull();
    expect(wage('0', 'Year')).toBeNull();
  });

  it('counts "Certified - Withdrawn" and "Withdrawn" as withdrawn; a denied row is skipped', () => {
    expect(parseLcaRow(row({ CASE_STATUS: 'Certified - Withdrawn' }))).toMatchObject({ status: 'withdrawn' });
    expect(parseLcaRow(row({ CASE_STATUS: 'WITHDRAWN' }))).toMatchObject({ status: 'withdrawn' });
    expect(parseLcaRow(row({ CASE_STATUS: 'Denied' }))).toEqual({ skip: 'status' });
  });

  it('only H-1B: H-1B1 and E-3 are other programmes', () => {
    expect(parseLcaRow(row({ VISA_CLASS: 'H-1B1 Singapore' }))).toEqual({ skip: 'not_h1b' });
    expect(parseLcaRow(row({ VISA_CLASS: 'E-3 Australian' }))).toEqual({ skip: 'not_h1b' });
    expect(parseLcaRow(row({ VISA_CLASS: 'h-1b' }))).toMatchObject({ status: 'certified' });
  });

  it('header case and spacing do not matter; a row with no employer or no fiscal year is skipped', () => {
    expect(parseLcaRow({ ' case_status ': 'Certified', visa_class: 'H-1B', Employer_Name: 'Example Analytics, Inc.', decision_date: '2025-12-15' })).toMatchObject({ employerNameNormalized: EXAMPLE, fiscalYear: 2026 });
    expect(parseLcaRow(row({ EMPLOYER_NAME: '  ' }))).toEqual({ skip: 'no_employer' });
    expect(parseLcaRow(row({ DECISION_DATE: '' }))).toEqual({ skip: 'no_fiscal_year' });
    expect(parseLcaRow(row({ DECISION_DATE: '' }), { fiscalYear: 2025 })).toMatchObject({ fiscalYear: 2025 });
  });
});

describe('dates and money', () => {
  it('the US federal fiscal year starts on 1 October', () => {
    expect(fiscalYearOf(new Date('2025-09-30T00:00:00Z'))).toBe(2025);
    expect(fiscalYearOf(new Date('2025-10-01T00:00:00Z'))).toBe(2026);
    expect(fiscalYearOf(new Date('2026-03-15T00:00:00Z'))).toBe(2026);
  });

  it('reads US and ISO dates, Excel serial days and Date cells', () => {
    expect(parseLcaDate('12/15/2025')?.toISOString()).toBe('2025-12-15T00:00:00.000Z');
    expect(parseLcaDate('2025-12-15')?.toISOString()).toBe('2025-12-15T00:00:00.000Z');
    expect(parseLcaDate(46006)?.toISOString().slice(0, 10)).toBe('2025-12-15');
    expect(parseLcaDate(new Date('2025-12-15T00:00:00Z'))?.toISOString()).toBe('2025-12-15T00:00:00.000Z');
    expect(parseLcaDate('not a date')).toBeNull();
    expect(parseLcaDate(null)).toBeNull();
  });

  it('money and the file-name fiscal year', () => {
    expect(parseMoney('$120,000.50')).toBe(120000.5);
    expect(parseMoney('n/a')).toBeNull();
    expect(parseMoney(-5)).toBeNull();
    expect(fiscalYearFromFileName('LCA_Disclosure_Data_FY2026_Q3.xlsx')).toBe(2026);
    expect(fiscalYearFromFileName('lca-fy_2024.csv')).toBe(2024);
    expect(fiscalYearFromFileName('export.csv')).toBeNull();
  });
});

describe('aggregateLca', () => {
  it('counts per employer and fiscal year; the median needs N ≥ MIN_SAMPLE certified wages (D3)', () => {
    const rows = [
      ...Array.from({ length: MIN_SAMPLE }, (_, i) => row({ WAGE_RATE_OF_PAY_FROM: String(100000 + i * 1000) })),
      row({ CASE_STATUS: 'Withdrawn' }),
      row({ EMPLOYER_NAME: 'Sample Robotics LLC', WAGE_RATE_OF_PAY_FROM: '150000' }),
      row({ EMPLOYER_NAME: 'Example Analytics, Inc.', DECISION_DATE: '09/15/2025', WAGE_RATE_OF_PAY_FROM: '90000' }), // FY2025
    ];
    const { stats, rows: counts } = aggregateLca(rows);
    expect(counts).toEqual({ read: MIN_SAMPLE + 3, counted: MIN_SAMPLE + 3, skipped: { not_h1b: 0, status: 0, no_employer: 0, no_fiscal_year: 0 } });
    const fy26 = stats.find((s) => s.employerNameNormalized === EXAMPLE && s.fiscalYear === 2026)!;
    expect(fy26).toMatchObject({ certifiedCount: MIN_SAMPLE, withdrawnCount: 1, medianWageAnnualUsd: 109500 });
    // One filing: the count is published, the wage is not (it would be one person's pay).
    expect(stats.find((s) => s.employerNameNormalized === SAMPLE)).toMatchObject({ certifiedCount: 1, medianWageAnnualUsd: null });
    expect(stats.find((s) => s.employerNameNormalized === EXAMPLE && s.fiscalYear === 2025)).toMatchObject({ certifiedCount: 1, medianWageAnnualUsd: null });
  });

  it('top titles by certified count, case-insensitive, each with its own median rule; withdrawn rows are not in titles', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ JOB_TITLE: 'software engineer' })),
      ...Array.from({ length: 2 }, () => row({ JOB_TITLE: 'Data Analyst', WAGE_RATE_OF_PAY_FROM: '80000' })),
      row({ JOB_TITLE: 'Software  Engineer' }),
      row({ JOB_TITLE: 'Withdrawn Role', CASE_STATUS: 'Withdrawn' }),
    ];
    const { stats } = aggregateLca(rows, { minWageSample: 2 });
    expect(stats[0]!.topTitles).toEqual([
      { title: 'software engineer', count: 4, medianWageAnnualUsd: 120000 },
      { title: 'Data Analyst', count: 2, medianWageAnnualUsd: 80000 },
    ]);
    expect(H1bTopTitlesSchema.safeParse(stats[0]!.topTitles).success).toBe(true);
    expect(aggregateLca(rows, { topTitles: 1 }).stats[0]!.topTitles).toHaveLength(1);
  });

  it('a fixed fiscal year (file name or --fiscal-year) applies to every row', () => {
    const { stats } = aggregateLca([row({ DECISION_DATE: '09/15/2025' }), row({ DECISION_DATE: '' })], { fiscalYear: 2026 });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ fiscalYear: 2026, certifiedCount: 2 });
  });
});

describe('the fixture file (DOL column layout)', () => {
  it('dry run: parses the CSV, reports what was counted and skipped, and writes nothing', async () => {
    const { db, rows } = fakeDb();
    const report = await importLcaFile({ file: FIXTURE, dryRun: true, db });
    expect(report).toMatchObject({ sourceFile: 'LCA_Disclosure_Data_FY2026_Q1.sample.csv', fiscalYear: 2026, written: 0, dryRun: true });
    expect(report.rows).toEqual({ read: 34, counted: 30, skipped: { not_h1b: 2, status: 1, no_employer: 1, no_fiscal_year: 0 } });
    expect(rows.size).toBe(0);
    const example = report.stats.find((s) => s.employerNameNormalized === EXAMPLE)!;
    // 22 software engineers at 120k..141k and 3 analysts at $50..52 an hour (104,000..108,160): 25 certified (median = the 13th wage, 129,000), 2 withdrawn.
    expect(example).toMatchObject({ fiscalYear: 2026, certifiedCount: 25, withdrawnCount: 2, medianWageAnnualUsd: 129000 });
    expect(example.topTitles).toEqual([
      { title: 'Software Engineer', count: 22, medianWageAnnualUsd: 130500 },
      { title: 'Data Analyst', count: 3, medianWageAnnualUsd: null },
    ]);
    // Two wages and one row with a unit we cannot annualise: three certified, no median.
    expect(report.stats.find((s) => s.employerNameNormalized === SAMPLE)).toMatchObject({ certifiedCount: 3, withdrawnCount: 0, medianWageAnnualUsd: null });
  });

  it('import: one row per employer and fiscal year, with the source file and the import time as asOf', async () => {
    const { db, rows } = fakeDb();
    const at = new Date('2026-10-10T08:00:00.000Z');
    const report = await importLcaFile({ file: FIXTURE, db, now: () => at });
    expect(report.written).toBe(2);
    expect(rows.get(`${EXAMPLE}|2026`)).toMatchObject({
      employerNameNormalized: EXAMPLE,
      fiscalYear: 2026,
      certifiedCount: 25,
      withdrawnCount: 2,
      medianWageAnnualUsd: 129000,
      sourceFile: 'LCA_Disclosure_Data_FY2026_Q1.sample.csv',
      importedAt: at,
    });
    // The reader shows these with source 'dol_lca' and asOf = importedAt.
    expect(LCA_SOURCE).toBe('dol_lca');
  });

  it('a later cumulative file of the same year replaces that year’s row (upsert by employer + fiscal year)', async () => {
    const { db, rows } = fakeDb();
    const q1 = aggregateLca([row(), row()], { fiscalYear: 2026 }).stats;
    const q2 = aggregateLca([row(), row(), row(), row({ CASE_STATUS: 'Withdrawn' })], { fiscalYear: 2026 }).stats;
    expect(await upsertH1bStats(db, q1, { sourceFile: 'FY2026_Q1.xlsx', importedAt: new Date('2026-01-10T00:00:00Z') })).toBe(1);
    await upsertH1bStats(db, q2, { sourceFile: 'FY2026_Q2.xlsx', importedAt: new Date('2026-04-10T00:00:00Z') });
    expect(rows.size).toBe(1);
    expect(rows.get(`${EXAMPLE}|2026`)).toMatchObject({ certifiedCount: 3, withdrawnCount: 1, sourceFile: 'FY2026_Q2.xlsx', importedAt: new Date('2026-04-10T00:00:00Z') });
  });

  it('refuses a file type it cannot read', async () => {
    await expect(importLcaFile({ file: '/tmp/lca.pdf', dryRun: true })).rejects.toThrow(/Unsupported file type/);
  });
});

describe('command line', () => {
  it('reads the file, the options and --dry-run', () => {
    expect(parseLcaArgs(['LCA_FY2026_Q3.xlsx'])).toEqual({ file: 'LCA_FY2026_Q3.xlsx', fiscalYear: null, minWageSample: undefined, dryRun: false });
    expect(parseLcaArgs(['--dry-run', '--fiscal-year', '2025', 'lca.csv', '--min-wage-sample', '5'])).toEqual({ file: 'lca.csv', fiscalYear: 2025, minWageSample: 5, dryRun: true });
  });

  it('says how to use it when the input is wrong', () => {
    expect(() => parseLcaArgs([])).toThrow(/Usage: npx tsx server\/src\/features\/jobs\/data\/importLca\.ts/);
    expect(() => parseLcaArgs(['f.csv', '--fiscal-year', '26'])).toThrow(/--fiscal-year/);
    expect(() => parseLcaArgs(['f.csv', '--min-wage-sample', '0'])).toThrow(/--min-wage-sample/);
  });
});
