// @vitest-environment node
//
// USCIS H-1B Employer Data Hub importer (JI-11): header detection by name (the
// two headers read from the official site, and nothing else), the pure parser
// and aggregator, the fixture as a dry run (the default: nothing is written
// without `apply`), and the write through a fake database: one row per
// (source, employer, period) however often a file is imported, and no write at
// all for a file the importer does not recognise. A count is never made up: a
// line cut short, or a row that states no count, is left out. No network (the
// importer downloads nothing) and no database. Every employer name here is an
// invented placeholder.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { normalizeCompanyName } from '../normalize/index.js';
import { importUscisFile, parseUscisArgs, runUscisCli, uscisReportLines } from './importUscis.js';
import {
  DRY_RUN_LINE,
  REGISTER_WRITE_CHUNK,
  RegisterHeaderError,
  RegisterWriteError,
  databaseTarget,
  delimiterOf,
  headerKey,
  parseAsOf,
  replaceRegisterRows,
  requireDatabaseTarget,
  type SponsorRegisterDb,
  type SponsorRegisterRow,
} from './sponsorRegister.js';
import { USCIS_H1B_HUB_SOURCE, USCIS_H1B_HUB_URL, fiscalYearOfPeriod, uscisPeriod } from './sponsorSources.js';
import { aggregateUscis, parseCount, parseUscisRow, resolveUscisLayout, uscisRegisterRows } from './uscis.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'uscis.sample.csv');
const EXAMPLE = normalizeCompanyName('EXAMPLE EMPLOYER LLC');
const SAMPLE = normalizeCompanyName('SAMPLE ROBOTICS INC');
const PLACEHOLDER = normalizeCompanyName('PLACEHOLDER ANALYTICS CORP');
const AS_OF = new Date('2025-07-01T00:00:00.000Z');
const IMPORTED = new Date('2026-10-12T08:00:00.000Z');

/** The header of h1b_datahubexport-2023.csv, as the file writes it (read 2026-10-12). */
const HEADER_2023 = ['Fiscal Year', 'Employer', 'Initial Approval', 'Initial Denial', 'Continuing Approval', 'Continuing Denial', 'NAICS', 'Tax ID', 'State', 'City', 'ZIP'];
/** The header of h1b_datahubexport-2009.csv: the four counts in the plural. */
const HEADER_2009 = ['Fiscal Year', 'Employer', 'Initial Approvals', 'Initial Denials', 'Continuing Approvals', 'Continuing Denials', 'NAICS', 'Tax ID', 'State', 'City', 'ZIP'];
/** The glossary terms of the hub's current fields (no file of this layout was read). */
const KINDS = ['New Employment', 'Continuation', 'Change with Same Employer', 'New Concurrent', 'Change of Employer', 'Amended'];
const HEADER_HUB = ['Fiscal Year', 'Employer Name', 'NAICS', 'Tax ID', 'State', 'City', 'ZIP', ...KINDS.flatMap((k) => [`${k} Approval`, `${k} Denial`])];

const row = (over: Record<string, unknown> = {}) => ({
  'Fiscal Year': '2023',
  Employer: 'EXAMPLE EMPLOYER LLC',
  'Initial Approval': '3',
  'Initial Denial': '1',
  'Continuing Approval': '5',
  'Continuing Denial': '0',
  NAICS: '54',
  'Tax ID': '0000',
  State: 'ZZ',
  City: 'EXAMPLE CITY',
  ZIP: '00000',
  ...over,
});

const tmp = mkdtempSync(path.join(tmpdir(), 'uscis-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
function csv(name: string, lines: string[]): string {
  const file = path.join(tmp, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
const HEADER_LINE = '"Fiscal Year",Employer,"Initial Approval","Initial Denial","Continuing Approval","Continuing Denial",NAICS,"Tax ID",State,City,ZIP';

function fakeDb(seed: Array<Partial<SponsorRegisterRow>> = []) {
  const fake = createFakePrisma({ seed: { rASponsorRegisterEntry: seed as Array<Record<string, unknown>> } });
  const rows = () => fake.$rows('rASponsorRegisterEntry') as unknown as Array<SponsorRegisterRow & { id: string }>;
  return { db: fake as unknown as SponsorRegisterDb, rows };
}

const keyOf = (r: Pick<SponsorRegisterRow, 'source' | 'employerNameNormalized' | 'period'>) => `${r.source}|${r.employerNameNormalized}|${r.period}`;

describe('header detection', () => {
  it('knows the yearly file in both spellings of its counts, whatever the case, spacing or column order', () => {
    expect(resolveUscisLayout(HEADER_2023)).toEqual({
      id: 'yearly_file',
      fiscalYear: 'Fiscal Year',
      employer: 'Employer',
      approvals: ['Initial Approval', 'Continuing Approval'],
      denials: ['Initial Denial', 'Continuing Denial'],
    });
    expect(resolveUscisLayout(HEADER_2009)).toMatchObject({ id: 'yearly_file', approvals: ['Initial Approvals', 'Continuing Approvals'], denials: ['Initial Denials', 'Continuing Denials'] });
    const shuffled = [' ZIP', 'continuing  denial', 'CONTINUING APPROVAL', 'Initial Denial ', 'initial approval', 'EMPLOYER', '\uFEFFfiscal year'];
    // The cells are returned as the file writes them: they are the keys of every row.
    expect(resolveUscisLayout(shuffled)).toEqual({ id: 'yearly_file', fiscalYear: '\uFEFFfiscal year', employer: 'EMPLOYER', approvals: ['initial approval', 'CONTINUING APPROVAL'], denials: ['Initial Denial ', 'continuing  denial'] });
    expect(headerKey('\uFEFF Fiscal   Year ')).toBe('fiscal year');
  });

  it('knows the hub\'s current fields: an Approval and a Denial column for each of the six kinds of decision', () => {
    const layout = resolveUscisLayout(HEADER_HUB);
    expect(layout).toMatchObject({ id: 'hub_fields', fiscalYear: 'Fiscal Year', employer: 'Employer Name' });
    expect(layout.approvals).toEqual(KINDS.map((k) => `${k} Approval`));
    expect(layout.denials).toEqual(KINDS.map((k) => `${k} Denial`));
  });

  it('refuses any other header and names the missing columns', () => {
    const missingOne = HEADER_2023.filter((h) => h !== 'Initial Denial');
    expect(() => resolveUscisLayout(missingOne)).toThrow(RegisterHeaderError);
    expect(() => resolveUscisLayout(missingOne)).toThrow(/Missing column: "Initial Denial"\..*Nothing was written\./s);
    // A count column under another name is a missing column, never a zero.
    const renamed = HEADER_2023.map((h) => (h === 'Continuing Approval' ? 'Continuing Approved' : h));
    expect(() => resolveUscisLayout(renamed)).toThrow(/"Continuing Approval"/);
    // The hub layout with one kind missing reports that kind, not the yearly file's columns.
    const hubMissing = HEADER_HUB.filter((h) => h !== 'Amended Denial');
    try {
      resolveUscisLayout(hubMissing);
      expect.unreachable();
    } catch (err) {
      expect((err as RegisterHeaderError).missing).toEqual(['Amended Denial']);
      expect((err as RegisterHeaderError).found).toEqual(hubMissing);
    }
    // Another government file altogether (the LCA layout): every required column is named.
    try {
      resolveUscisLayout(['CASE_NUMBER', 'CASE_STATUS', 'EMPLOYER_NAME']);
      expect.unreachable();
    } catch (err) {
      expect((err as RegisterHeaderError).missing).toEqual(['Fiscal Year', 'Employer', 'Initial Approval', 'Continuing Approval', 'Initial Denial', 'Continuing Denial']);
    }
    expect(() => resolveUscisLayout([])).toThrow(/Columns found: \(none\)/);
  });
});

describe('parseUscisRow', () => {
  const yearly = resolveUscisLayout(HEADER_2023);

  it('approvals = initial + continuing approvals, denials = initial + continuing denials', () => {
    expect(parseUscisRow(row(), yearly)).toEqual({ fiscalYear: 2023, employerName: 'EXAMPLE EMPLOYER LLC', employerNameNormalized: EXAMPLE, approvals: 8, denials: 1, emptyCounts: 0 });
  });

  it('the hub fields add up the six kinds of approval and the six kinds of denial', () => {
    const hub = resolveUscisLayout(HEADER_HUB);
    const cells: Record<string, unknown> = { 'Fiscal Year': '2025', 'Employer Name': 'EXAMPLE EMPLOYER LLC' };
    KINDS.forEach((k, i) => {
      cells[`${k} Approval`] = String(i + 1); // 1..6 → 21
      cells[`${k} Denial`] = i === 0 ? '2' : '0';
    });
    expect(parseUscisRow(cells, hub)).toEqual({ fiscalYear: 2025, employerName: 'EXAMPLE EMPLOYER LLC', employerNameNormalized: EXAMPLE, approvals: 21, denials: 2, emptyCounts: 0 });
  });

  it('reads counts as whole numbers: a thousands separator is accepted, anything that is not a whole number skips the row', () => {
    expect(parseCount('1,234')).toBe(1234);
    expect(parseCount(17)).toBe(17);
    expect(parseCount(' 0 ')).toBe(0);
    for (const bad of ['n/a', '-1', '1.5', 'D', '1e3']) expect(parseCount(bad), bad).toBeNull();
    expect(parseUscisRow(row({ 'Continuing Approval': '1,200' }), yearly)).toMatchObject({ approvals: 1203 });
    expect(parseUscisRow(row({ 'Initial Denial': 'n/a' }), yearly)).toEqual({ skip: 'bad_count' });
  });

  it('never makes up a count: a missing cell skips the row, and so does a row whose count cells are all empty', () => {
    // A line cut after two counts: the continuing counts are not in the row at all. Not 7 approved and 2 denied.
    const { 'Continuing Approval': _a, 'Continuing Denial': _d, ...cutShort } = row({ Employer: 'SAMPLE ROBOTICS INC', 'Initial Approval': '7', 'Initial Denial': '2' });
    expect(parseUscisRow(cutShort, yearly)).toEqual({ skip: 'bad_count' });
    expect(parseUscisRow(row({ 'Initial Denial': undefined }), yearly)).toEqual({ skip: 'bad_count' });
    // No count stated in any of the four cells: not "0 approved and 0 denied".
    const blank = { 'Initial Approval': '', 'Initial Denial': ' ', 'Continuing Approval': '', 'Continuing Denial': '' };
    expect(parseUscisRow(row(blank), yearly)).toEqual({ skip: 'no_counts' });
    // An employer the file gives four zeros for is a stated fact and is kept.
    expect(parseUscisRow(row({ 'Initial Approval': '0', 'Initial Denial': '0', 'Continuing Approval': '0', 'Continuing Denial': '0' }), yearly)).toMatchObject({ approvals: 0, denials: 0, emptyCounts: 0 });
  });

  it('an empty cell beside stated counts is read as 0, and the row says how many cells that was', () => {
    expect(parseCount('')).toBe(0);
    expect(parseUscisRow(row({ 'Initial Denial': '', 'Continuing Denial': '' }), yearly)).toMatchObject({ approvals: 8, denials: 0, emptyCounts: 2 });
    const counted = aggregateUscis([row(), row({ Employer: 'SAMPLE ROBOTICS INC', 'Continuing Approval': '' }), row({ Employer: 'PLACEHOLDER ANALYTICS CORP', 'Initial Approval': '', 'Initial Denial': '', 'Continuing Approval': '', 'Continuing Denial': '' })]);
    expect(counted.rows).toEqual({ read: 3, counted: 2, skipped: { no_employer: 0, no_fiscal_year: 0, bad_count: 0, no_counts: 1 }, withEmptyCount: 1 });
    expect(counted.entries.map((e) => e.employerNameNormalized)).toEqual([EXAMPLE, SAMPLE]);
  });

  it('skips a row with no employer (the files have some) or no fiscal year', () => {
    expect(parseUscisRow(row({ Employer: '' }), yearly)).toEqual({ skip: 'no_employer' });
    expect(parseUscisRow(row({ Employer: '   ' }), yearly)).toEqual({ skip: 'no_employer' });
    expect(parseUscisRow(row({ 'Fiscal Year': '' }), yearly)).toEqual({ skip: 'no_fiscal_year' });
    expect(parseUscisRow(row({ 'Fiscal Year': 'FY23' }), yearly)).toEqual({ skip: 'no_fiscal_year' });
    expect(parseUscisRow(row({ 'Fiscal Year': '1890' }), yearly)).toEqual({ skip: 'no_fiscal_year' });
  });
});

describe('aggregateUscis', () => {
  it('adds up the rows of one employer and fiscal year (several addresses, several spellings); years stay apart', () => {
    const { entries, fiscalYears, rows } = aggregateUscis([
      row(),
      row({ City: 'SAMPLE TOWN', 'Initial Approval': '2', 'Initial Denial': '0', 'Continuing Approval': '1', 'Continuing Denial': '1' }),
      row({ Employer: 'Example Employer, L.L.C.', 'Initial Approval': '1', 'Initial Denial': '0', 'Continuing Approval': '0', 'Continuing Denial': '0' }),
      row({ 'Fiscal Year': '2022', 'Initial Approval': '4', 'Initial Denial': '0', 'Continuing Approval': '0', 'Continuing Denial': '0' }),
      row({ Employer: '' }),
    ]);
    expect(rows).toEqual({ read: 5, counted: 4, skipped: { no_employer: 1, no_fiscal_year: 0, bad_count: 0, no_counts: 0 }, withEmptyCount: 0 });
    expect(fiscalYears).toEqual([2022, 2023]);
    expect(entries).toEqual([
      { employerNameNormalized: EXAMPLE, employerName: 'EXAMPLE EMPLOYER LLC', fiscalYear: 2022, approvals: 4, denials: 0 },
      // The first spelling seen is the one kept.
      { employerNameNormalized: EXAMPLE, employerName: 'EXAMPLE EMPLOYER LLC', fiscalYear: 2023, approvals: 12, denials: 2 },
    ]);
  });

  it('the period is the fiscal year, both ways', () => {
    expect(uscisPeriod(2025)).toBe('FY2025');
    expect(fiscalYearOfPeriod('FY2025')).toBe(2025);
    for (const other of ['', '2025', 'FY25', 'fy2025']) expect(fiscalYearOfPeriod(other), other).toBeNull();
  });
});

describe('the fixture file (the yearly file\'s header, placeholder rows)', () => {
  it('dry run: three aggregated rows with the right sums, and nothing is written', async () => {
    const { db, rows } = fakeDb();
    const report = await importUscisFile({ file: FIXTURE, asOf: AS_OF, db });
    expect(report).toMatchObject({ sourceFile: 'uscis.sample.csv', asOf: AS_OF, layout: 'yearly_file', fiscalYears: [2023], undecodedNames: 0, replaced: 0, written: 0, dryRun: true });
    expect(report.reading).toEqual({ delimiter: ',', encoding: 'utf8', unevenRows: 0, lastRowUneven: false });
    expect(report.rows).toEqual({ read: 5, counted: 4, skipped: { no_employer: 1, no_fiscal_year: 0, bad_count: 0, no_counts: 0 }, withEmptyCount: 0 });
    expect(report.entries).toEqual([
      // Two rows (two cities): 3 + 5 + 2 + 1 approved, 1 + 0 + 0 + 1 denied.
      { employerNameNormalized: EXAMPLE, employerName: 'EXAMPLE EMPLOYER LLC', fiscalYear: 2023, approvals: 11, denials: 2 },
      { employerNameNormalized: PLACEHOLDER, employerName: 'PLACEHOLDER ANALYTICS CORP', fiscalYear: 2023, approvals: 35, denials: 3 },
      // No approval at all is a fact too: two petitions, both denied.
      { employerNameNormalized: SAMPLE, employerName: 'SAMPLE ROBOTICS INC', fiscalYear: 2023, approvals: 0, denials: 2 },
    ]);
    expect(rows()).toHaveLength(0);
  });

  it('nothing is written unless the caller says apply: a stored year survives an import that was not told to write', async () => {
    const stored = new Date('2025-01-01T00:00:00.000Z');
    const { db, rows } = fakeDb([{ source: 'uscis_h1b_hub', country: 'US', employerNameNormalized: EXAMPLE, employerName: 'EXAMPLE EMPLOYER LLC', period: 'FY2023', approvals: 4, denials: 0, asOf: stored }]);
    const beforeWrite = vi.fn();
    for (const options of [{}, { apply: false }, { apply: undefined }, { allowShrink: true }]) {
      const report = await importUscisFile({ file: FIXTURE, asOf: AS_OF, db, beforeWrite, ...options });
      expect(report).toMatchObject({ dryRun: true, replaced: 0, written: 0 });
      expect(report.entries).toHaveLength(3);
    }
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ approvals: 4, asOf: stored });
    // What the owner reads; the command line adds the last line, which says nothing was written and how to write.
    expect(uscisReportLines(await importUscisFile({ file: FIXTURE, asOf: AS_OF, db }))).toEqual([
      'File: uscis.sample.csv (yearly file columns)',
      'As of: 2025-07-01',
      'Columns separated by: comma · read as: utf8',
      'Fiscal years: 2023',
      'Rows read: 5 · counted: 4 · skipped: no_employer 1, no_fiscal_year 0, bad_count 0, no_counts 0',
      'Employer-years: 3',
    ]);
    expect(DRY_RUN_LINE).toBe('Dry run: nothing was written. Run again with --apply to write.');
  });

  it('import: each row says where it came from and when that file was published', async () => {
    const { db, rows } = fakeDb();
    const seen: number[] = [];
    // The caller is handed the report of the file before the first row is written.
    const report = await importUscisFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, now: () => IMPORTED, beforeWrite: (read) => void seen.push(read.entries.length, rows().length) });
    expect(seen).toEqual([3, 0]);
    expect(report).toMatchObject({ replaced: 0, written: 3, dryRun: false });
    expect(rows().find((r) => r.employerNameNormalized === EXAMPLE)).toMatchObject({
      source: 'uscis_h1b_hub',
      country: 'US',
      employerNameNormalized: EXAMPLE,
      employerName: 'EXAMPLE EMPLOYER LLC',
      period: 'FY2023',
      approvals: 11,
      denials: 2,
      town: null,
      rating: null,
      routes: [],
      sourceFile: 'uscis.sample.csv',
      sourceUrl: USCIS_H1B_HUB_URL,
      asOf: AS_OF,
      importedAt: IMPORTED,
    });
    expect(USCIS_H1B_HUB_SOURCE).toBe('uscis_h1b_hub');
  });

  it('importing the same file twice leaves one row per (source, employer, period)', async () => {
    const { db, rows } = fakeDb();
    await importUscisFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, now: () => IMPORTED });
    const second = await importUscisFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, now: () => new Date('2026-10-13T08:00:00.000Z') });
    expect(second).toMatchObject({ replaced: 3, written: 3 });
    expect(rows()).toHaveLength(3);
    expect(new Set(rows().map(keyOf)).size).toBe(3);
    expect(rows().map(keyOf).sort()).toEqual([EXAMPLE, PLACEHOLDER, SAMPLE].map((n) => `uscis_h1b_hub|${n}|FY2023`).sort());
  });
});

describe('a file is read as it is written, and a line is never guessed', () => {
  it('a line cut short is left out, not counted with the cells it has; the report says the file may be cut', async () => {
    // The last line ends after two counts. Read with its two missing cells as 0 it would be 7 approved and 2 denied.
    const file = csv('cut-short.csv', [HEADER_LINE, '2023,"EXAMPLE EMPLOYER LLC",3,1,5,0,54,0000,ZZ,"EXAMPLE CITY",00000', '2023,"SAMPLE ROBOTICS INC",7,2']);
    const report = await importUscisFile({ file, asOf: AS_OF });
    expect(report.reading).toMatchObject({ unevenRows: 1, lastRowUneven: true });
    expect(report.rows).toMatchObject({ read: 1, counted: 1 });
    expect(report.entries.map((e) => e.employerNameNormalized)).toEqual([EXAMPLE]);
    expect(uscisReportLines(report)).toContain('Lines with more or fewer cells than the header (left out): 1. The last line of the file is one of them: the download may have been cut short.');
  });

  it('a line with too many cells (a comma inside an unquoted name) is left out too: its counts no longer sit under their columns', async () => {
    const file = csv('too-long.csv', [HEADER_LINE, '2023,EXAMPLE EMPLOYER, LLC,3,1,5,0,54,0000,ZZ,EXAMPLE CITY,00000', '2023,"SAMPLE ROBOTICS INC",0,2,0,0,33,0000,ZZ,"EXAMPLE CITY",00000']);
    const report = await importUscisFile({ file, asOf: AS_OF });
    expect(report.reading).toMatchObject({ unevenRows: 1, lastRowUneven: false });
    expect(report.entries).toEqual([{ employerNameNormalized: SAMPLE, employerName: 'SAMPLE ROBOTICS INC', fiscalYear: 2023, approvals: 0, denials: 2 }]);
    expect(uscisReportLines(report)).toContain('Lines with more or fewer cells than the header (left out): 1');
  });

  it('a row with four empty count cells is not stored as 0 approved and 0 denied', async () => {
    const { db, rows } = fakeDb();
    const file = csv('no-counts.csv', [
      HEADER_LINE,
      '2023,"EXAMPLE EMPLOYER LLC",3,1,5,0,54,0000,ZZ,"EXAMPLE CITY",00000',
      '2023,"SAMPLE ROBOTICS INC",,,,,33,0000,ZZ,"EXAMPLE CITY",00000',
      '2023,"PLACEHOLDER ANALYTICS CORP",10,,25,,51,0000,ZZ,"EXAMPLE CITY",00000',
    ]);
    const report = await importUscisFile({ file, asOf: AS_OF, apply: true, db, now: () => IMPORTED });
    expect(report.rows).toEqual({ read: 3, counted: 2, skipped: { no_employer: 0, no_fiscal_year: 0, bad_count: 0, no_counts: 1 }, withEmptyCount: 1 });
    expect(rows().map((r) => r.employerNameNormalized).sort()).toEqual([EXAMPLE, PLACEHOLDER].sort());
    expect(rows().find((r) => r.employerNameNormalized === PLACEHOLDER)).toMatchObject({ approvals: 35, denials: 0 });
    expect(uscisReportLines(report)).toContain('Counted rows with an empty count cell, read as 0: 1');
  });

  it('the separator is taken from the header line: a tab-separated UTF-16 export reads like the comma-separated file', async () => {
    expect(delimiterOf(HEADER_LINE)).toBe(',');
    expect(delimiterOf(HEADER_2023.join('\t'))).toBe('\t');
    // A comma inside a quoted name is not a separator; a line with neither is read as comma-separated (and then refused by its header).
    expect(delimiterOf('"Employer, as filed"\t"Fiscal Year"\tCity')).toBe('\t');
    expect(delimiterOf('"Employer\tas filed","Fiscal Year"')).toBe(',');
    expect(delimiterOf('')).toBe(',');
    const lines = [
      HEADER_2023.join('\t'),
      ['2023', 'EXAMPLE EMPLOYER, LLC', '3', '1', '5', '0', '54', '0000', 'ZZ', 'EXAMPLE CITY', '00000'].join('\t'),
      ['2023', 'SAMPLE ROBOTICS INC', '0', '2', '0', '0', '33', '0000', 'ZZ', 'EXAMPLE CITY', '00000'].join('\t'),
    ];
    const text = `${lines.join('\r\n')}\r\n`;
    // UTF-16 with its byte-order mark, as a spreadsheet or a dashboard saves "Unicode text": read without --encoding.
    const marked = path.join(tmp, 'hub-export-utf16.csv');
    writeFileSync(marked, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    const report = await importUscisFile({ file: marked, asOf: AS_OF });
    expect(report.reading).toEqual({ delimiter: '\t', encoding: 'utf16le', unevenRows: 0, lastRowUneven: false });
    expect(report).toMatchObject({ layout: 'yearly_file', undecodedNames: 0 });
    expect(report.entries).toEqual([
      // The comma in the name is part of the name here.
      { employerNameNormalized: EXAMPLE, employerName: 'EXAMPLE EMPLOYER, LLC', fiscalYear: 2023, approvals: 8, denials: 1 },
      { employerNameNormalized: SAMPLE, employerName: 'SAMPLE ROBOTICS INC', fiscalYear: 2023, approvals: 0, denials: 2 },
    ]);
    expect(uscisReportLines(report)).toContain('Columns separated by: tab · read as: utf16le');
    // The same text without the mark needs the encoding named; tab-separated UTF-8 needs nothing.
    const unmarked = path.join(tmp, 'hub-export-utf16-nomark.csv');
    writeFileSync(unmarked, Buffer.from(text, 'utf16le'));
    expect((await importUscisFile({ file: unmarked, asOf: AS_OF, encoding: 'utf16le' })).entries).toEqual(report.entries);
    const utf8 = path.join(tmp, 'hub-export-tabs.csv');
    writeFileSync(utf8, text);
    const plain = await importUscisFile({ file: utf8, asOf: AS_OF });
    expect(plain.reading).toMatchObject({ delimiter: '\t', encoding: 'utf8' });
    expect(plain.entries).toEqual(report.entries);
  });

  it('names the file\'s encoding could not give are never written: the write is refused until the encoding is named', async () => {
    const { db, rows } = fakeDb();
    const file = path.join(tmp, 'latin1.csv');
    writeFileSync(file, Buffer.from(`${HEADER_LINE}\n2023,"EXAMPLE CAFÉ LLC",3,1,5,0,54,0000,ZZ,"EXAMPLE CITY",00000\n`, 'latin1'));
    // The dry run reads it, counts the name, and says what to do.
    const dry = await importUscisFile({ file, asOf: AS_OF, db });
    expect(dry.undecodedNames).toBe(1);
    expect(uscisReportLines(dry).join('\n')).toMatch(/Employer names with unreadable characters: 1\. The file is not UTF-8: nothing can be written until --encoding/);
    const beforeWrite = vi.fn();
    await expect(importUscisFile({ file, asOf: AS_OF, apply: true, db, beforeWrite })).rejects.toMatchObject({ name: 'RegisterWriteError', reason: 'unreadable_names' });
    await expect(importUscisFile({ file, asOf: AS_OF, apply: true, db })).rejects.toThrow(/1 employer name holds characters that could not be read.*--encoding latin1.*Nothing was written\./s);
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    const written = await importUscisFile({ file, asOf: AS_OF, apply: true, encoding: 'latin1', db, now: () => IMPORTED });
    expect(written).toMatchObject({ undecodedNames: 0, written: 1 });
    expect(rows()[0]).toMatchObject({ employerName: 'EXAMPLE CAFÉ LLC' });
  });
});

describe('the write replaces the fiscal years of the file and nothing else', () => {
  const stored = (employer: string, period: string, over: Partial<SponsorRegisterRow> = {}): Partial<SponsorRegisterRow> => ({
    source: 'uscis_h1b_hub',
    country: 'US',
    employerNameNormalized: normalizeCompanyName(employer),
    employerName: employer,
    period,
    approvals: 1,
    denials: 0,
    asOf: new Date('2025-01-01T00:00:00.000Z'),
    ...over,
  });

  it('a later file of a fiscal year is the truth for that year: other years, and the other register, stay', async () => {
    const { db, rows } = fakeDb([
      stored('EXAMPLE EMPLOYER LLC', 'FY2022'),
      stored('EXAMPLE EMPLOYER LLC', 'FY2023', { approvals: 4 }),
      // In the earlier FY2023 file under a spelling the later file no longer uses: gone afterwards, not left beside the new rows.
      stored('EXAMPLE EMPLOYER HOLDINGS LLC', 'FY2023'),
      { ...stored('EXAMPLE EMPLOYER LLC', ''), source: 'uk_sponsor_register', country: 'GB', approvals: null, denials: null },
    ]);
    const report = await importUscisFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, now: () => IMPORTED });
    expect(report).toMatchObject({ replaced: 2, written: 3 });
    expect(rows().map(keyOf).sort()).toEqual(
      [`uk_sponsor_register|${EXAMPLE}|`, `uscis_h1b_hub|${EXAMPLE}|FY2022`, `uscis_h1b_hub|${EXAMPLE}|FY2023`, `uscis_h1b_hub|${PLACEHOLDER}|FY2023`, `uscis_h1b_hub|${SAMPLE}|FY2023`].sort(),
    );
    expect(rows().find((r) => keyOf(r) === `uscis_h1b_hub|${EXAMPLE}|FY2023`)).toMatchObject({ approvals: 11, denials: 2, asOf: AS_OF });
  });

  it('a file with an unknown header fails with the missing column and writes nothing', async () => {
    const { db, rows } = fakeDb([stored('EXAMPLE EMPLOYER LLC', 'FY2023', { approvals: 4 })]);
    const file = csv('renamed.csv', ['"Fiscal Year",Employer,"Initial Approval","Initial Denial","Continuing Approved","Continuing Denial"', '2023,"EXAMPLE EMPLOYER LLC",3,1,5,0']);
    await expect(importUscisFile({ file, asOf: AS_OF, apply: true, db })).rejects.toThrow(/Missing column: "Continuing Approval"/);
    await expect(importUscisFile({ file, asOf: AS_OF, apply: true, db })).rejects.toBeInstanceOf(RegisterHeaderError);
    await expect(importUscisFile({ file: csv('empty.csv', []), asOf: AS_OF, apply: true, db })).rejects.toBeInstanceOf(RegisterHeaderError);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ approvals: 4 });
  });

  it('refuses a file dated before the stored rows, a file with no usable row, and a file that would drop most of a stored year', async () => {
    const many = Array.from({ length: 8 }, (_v, i) => stored(`PLACEHOLDER EMPLOYER ${i} LLC`, 'FY2023', { asOf: new Date('2025-06-01T00:00:00.000Z') }));
    const { db, rows } = fakeDb(many);
    // 3 employers in the file against 8 stored: fewer than half.
    await expect(importUscisFile({ file: FIXTURE, asOf: AS_OF, apply: true, db })).rejects.toMatchObject({ name: 'RegisterWriteError', reason: 'shrinks_stored' });
    await expect(importUscisFile({ file: FIXTURE, asOf: new Date('2025-05-01T00:00:00.000Z'), apply: true, db, allowShrink: true })).rejects.toMatchObject({ reason: 'older_than_stored' });
    const onlyHeader = csv('header-only.csv', ['"Fiscal Year",Employer,"Initial Approval","Initial Denial","Continuing Approval","Continuing Denial"']);
    await expect(importUscisFile({ file: onlyHeader, asOf: AS_OF, apply: true, db })).rejects.toMatchObject({ reason: 'empty_file' });
    expect(rows()).toHaveLength(8);
    // The owner says the drop is real: the year is replaced.
    expect(await importUscisFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, allowShrink: true })).toMatchObject({ replaced: 8, written: 3 });
    expect(rows()).toHaveLength(3);
  });

  it('a file that cannot be read fails; the write is one transaction, in chunks', async () => {
    const { db } = fakeDb();
    await expect(importUscisFile({ file: path.join(tmp, 'missing.csv'), asOf: AS_OF, apply: true, db })).rejects.toThrow(/ENOENT/);
    const calls: string[] = [];
    const chunks: number[] = [];
    const delegate = {
      count: async () => 0,
      findFirst: async () => null,
      deleteMany: async () => (calls.push('delete'), { count: 0 }),
      createMany: async ({ data }: { data: SponsorRegisterRow[] }) => (calls.push('create'), chunks.push(data.length), { count: data.length }),
    };
    const recording: SponsorRegisterDb = {
      rASponsorRegisterEntry: delegate,
      $transaction: async (fn, options) => {
        calls.push(`begin:${options?.timeout}`);
        const out = await fn({ rASponsorRegisterEntry: delegate });
        calls.push('commit');
        return out;
      },
    };
    const entries = Array.from({ length: REGISTER_WRITE_CHUNK + 5 }, (_v, i) => ({ employerNameNormalized: `placeholder ${i}`, employerName: `PLACEHOLDER ${i} LLC`, fiscalYear: 2023, approvals: 1, denials: 0 }));
    const result = await replaceRegisterRows(recording, { source: 'uscis_h1b_hub', periods: ['FY2023'] }, uscisRegisterRows(entries, { sourceFile: 'f.csv', asOf: AS_OF, importedAt: IMPORTED }), { asOf: AS_OF });
    expect(result).toEqual({ replaced: 0, written: REGISTER_WRITE_CHUNK + 5 });
    expect(calls).toEqual(['begin:600000', 'delete', 'create', 'create', 'commit']);
    expect(chunks).toEqual([REGISTER_WRITE_CHUNK, 5]);
    await expect(replaceRegisterRows(recording, { source: 'uscis_h1b_hub', periods: ['FY2023'] }, [], { asOf: AS_OF })).rejects.toBeInstanceOf(RegisterWriteError);
  });
});

describe('command line', () => {
  const NOW = new Date('2026-10-12T12:00:00.000Z');

  it('writes only with --apply: without it the command is a dry run', () => {
    expect(parseUscisArgs(['h1b_datahubexport-2023.csv', '--as-of', '2025-07-01'], NOW)).toEqual({ file: 'h1b_datahubexport-2023.csv', asOf: AS_OF, apply: false, allowShrink: false });
    // --dry-run says what the default already is, so the command as first documented still writes nothing.
    expect(parseUscisArgs(['--dry-run', '--as-of', '2025-07-01', '--encoding', 'latin1', 'export.CSV', '--allow-shrink'], NOW)).toEqual({ file: 'export.CSV', asOf: AS_OF, apply: false, allowShrink: true, encoding: 'latin1' });
    expect(parseUscisArgs(['h1b_datahubexport-2023.csv', '--as-of', '2025-07-01', '--apply'], NOW)).toEqual({ file: 'h1b_datahubexport-2023.csv', asOf: AS_OF, apply: true, allowShrink: false });
    // --allow-shrink is not a write switch, and the two that contradict each other are refused.
    expect(parseUscisArgs(['f.csv', '--as-of', '2025-07-01', '--allow-shrink'], NOW).apply).toBe(false);
    expect(() => parseUscisArgs(['f.csv', '--as-of', '2025-07-01', '--apply', '--dry-run'], NOW)).toThrow(/Give --apply \(write\) or --dry-run \(write nothing\), not both/);
  });

  it('says how to use it when the input is wrong; the date is required, real and not in the future', () => {
    expect(() => parseUscisArgs([], NOW)).toThrow(/Usage: npx tsx server\/src\/features\/jobs\/data\/importUscis\.ts <file\.csv> --as-of YYYY-MM-DD \[--apply\]/);
    expect(() => parseUscisArgs([], NOW)).toThrow(/Without --apply nothing is written/);
    expect(() => parseUscisArgs(['f.csv'], NOW)).toThrow(/--as-of is required/);
    expect(() => parseUscisArgs(['f.csv', '--as-of', '07/01/2025'], NOW)).toThrow(/--as-of is required.*got "07\/01\/2025"/s);
    expect(() => parseUscisArgs(['f.csv', '--as-of', '2025-02-30'], NOW)).toThrow(/--as-of is required/);
    expect(() => parseUscisArgs(['f.csv', '--as-of', '2027-01-01'], NOW)).toThrow(/in the future/);
    expect(() => parseUscisArgs(['f.xlsx', '--as-of', '2025-07-01'], NOW)).toThrow(/must be a \.csv file/);
    expect(() => parseUscisArgs(['f.csv', '--as-of', '2025-07-01', '--fiscal-year', '2023'], NOW)).toThrow(/Unknown option --fiscal-year/);
    expect(() => parseUscisArgs(['f.csv', '--as-of', '2025-07-01', '--encoding', 'big5'], NOW)).toThrow(/--encoding must be one of/);
    expect(parseAsOf('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(parseAsOf('2025-02-29')).toBeNull();
    expect(parseAsOf(null)).toBeNull();
  });

  it('names the database a write goes to by host and name only, and refuses to write when there is none', () => {
    // A made-up address: the user and the password never reach the line the owner reads.
    const url = 'postgresql://placeholder_user:placeholder-secret@db.example.test:5432/placeholder_db?sslmode=require&channel_binding=require';
    expect(databaseTarget(url)).toBe('db.example.test/placeholder_db');
    expect(databaseTarget('postgres://db.example.test')).toBe('db.example.test');
    for (const part of ['placeholder_user', 'placeholder-secret', 'sslmode', '5432', '@']) expect(databaseTarget(url)).not.toContain(part);
    for (const none of [undefined, null, '', 'not a url', 'https://db.example.test/placeholder_db', 'postgresql:///placeholder_db']) expect(databaseTarget(none), String(none)).toBeNull();
    expect(requireDatabaseTarget(url)).toBe('db.example.test/placeholder_db');
    expect(() => requireDatabaseTarget(undefined)).toThrow(/--apply needs a database: DATABASE_URL is not set.*Nothing was written\./s);
    // The message never repeats what it was given.
    try {
      requireDatabaseTarget('mysql://placeholder_user:placeholder-secret@db.example.test/x');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toMatch(/placeholder/);
    }
  });
});

describe('one run of the command line', () => {
  // A made-up address: only its host and database name may reach a printed line.
  const DATABASE = 'postgresql://placeholder_user:placeholder-secret@db.example.test:5432/placeholder_db?sslmode=require';
  const now = () => new Date('2026-10-12T12:00:00.000Z');

  it('without --apply: the report, then the line that says nothing was written; no database is asked for', async () => {
    const { db, rows } = fakeDb();
    const printed: string[][] = [];
    const report = await runUscisCli([FIXTURE, '--as-of', '2025-07-01'], { databaseUrl: undefined, print: (lines) => printed.push(lines), db, now });
    expect(report).toMatchObject({ dryRun: true, written: 0 });
    expect(printed).toEqual([[...uscisReportLines(report), DRY_RUN_LINE]]);
    expect(rows()).toHaveLength(0);
  });

  it('with --apply: the report of the file and the database, by host and name, are printed before the first row is written', async () => {
    const { db, rows } = fakeDb();
    const printed: Array<{ lines: string[]; stored: number }> = [];
    const report = await runUscisCli([FIXTURE, '--as-of', '2025-07-01', '--apply'], { databaseUrl: DATABASE, print: (lines) => printed.push({ lines, stored: rows().length }), db, now });
    expect(report).toMatchObject({ dryRun: false, replaced: 0, written: 3 });
    expect(printed).toEqual([
      { lines: [...uscisReportLines(report), 'Writing to database: db.example.test/placeholder_db'], stored: 0 },
      { lines: ['Rows replaced: 0 · written: 3'], stored: 3 },
    ]);
    expect(printed.flatMap((p) => p.lines).join('\n')).not.toMatch(/placeholder-secret|placeholder_user|sslmode|5432/);
    expect(rows().every((r) => r.importedAt.getTime() === now().getTime())).toBe(true);
  });

  it('with --apply and no database: refused before the file is opened, and nothing is printed', async () => {
    const print = vi.fn();
    const missing = path.join(tmp, 'never-written.csv');
    await expect(runUscisCli([missing, '--as-of', '2025-07-01', '--apply'], { databaseUrl: undefined, print, now })).rejects.toThrow(/--apply needs a database/);
    await expect(runUscisCli([missing, '--as-of', '2025-07-01', '--apply'], { databaseUrl: 'not an address', print, now })).rejects.toThrow(/--apply needs a database/);
    expect(print).not.toHaveBeenCalled();
    // Without --apply the same call fails on the file: the database was never the question.
    await expect(runUscisCli([missing, '--as-of', '2025-07-01'], { databaseUrl: undefined, print, now })).rejects.toThrow(/ENOENT/);
  });

  it('a write the importer refuses still shows the owner the file and the database it was refused for', async () => {
    const stored = Array.from({ length: 8 }, (_v, i) => ({ source: 'uscis_h1b_hub' as const, country: 'US', employerNameNormalized: `placeholder employer ${i}`, employerName: `PLACEHOLDER EMPLOYER ${i} LLC`, period: 'FY2023', approvals: 1, denials: 0, asOf: new Date('2025-06-01T00:00:00.000Z') }));
    const { db, rows } = fakeDb(stored);
    const printed: string[][] = [];
    await expect(runUscisCli([FIXTURE, '--as-of', '2025-07-01', '--apply'], { databaseUrl: DATABASE, print: (lines) => printed.push(lines), db, now })).rejects.toMatchObject({ reason: 'shrinks_stored' });
    expect(printed).toHaveLength(1);
    expect(printed[0]!.at(-1)).toBe('Writing to database: db.example.test/placeholder_db');
    expect(rows()).toHaveLength(8);
  });
});
