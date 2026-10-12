// server/src/features/jobs/data/uscis.ts — USCIS H-1B Employer Data Hub rows →
// per-employer, per-fiscal-year petition counts (RASponsorRegisterEntry, source
// 'uscis_h1b_hub'; JI-11).
//
// Pure: rows in, aggregates out. No file access, no database, no network —
// importUscis.ts (the CLI) reads the file and writes the rows.
//
// Source: U.S. Citizenship and Immigration Services, "H-1B Employer Data Hub"
//   https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub
// (a public record of a US federal agency). What the hub counts, in its own
// words (its page "Understanding Our H-1B Employer Data Hub", reviewed by USCIS
// 07/07/2025): the first decision USCIS made on a petition, in the fiscal year
// that decision was recorded; appeals, revocations and pending petitions are
// not in it; one employer with several addresses has several rows in a year.
// An approved petition is not a visa, an entry or a hire, and says nothing
// about any one job (the reader shows SPONSORSHIP_DISCLAIMER).
//
// COLUMNS ARE MAPPED BY HEADER NAME, and a file whose header is not one of the
// two below is refused before a row is read (RegisterHeaderError names the
// missing columns). The spellings were read from the official site on
// 2026-10-12; none is typed from memory.
//
//   1. The yearly files (one CSV per fiscal year, FY2009 to FY2023), linked
//      from https://www.uscis.gov/archive/h-1b-employer-data-hub-files as
//      https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-<year>.csv
//      Header of h1b_datahubexport-2023.csv:
//        "Fiscal Year",Employer,"Initial Approval","Initial Denial","Continuing Approval","Continuing Denial",NAICS,"Tax ID",State,City,ZIP
//      Header of h1b_datahubexport-2009.csv (the four counts in the plural):
//        "Fiscal Year","Employer","Initial Approvals","Initial Denials","Continuing Approvals","Continuing Denials","NAICS","Tax ID","State","City","ZIP"
//      Counts are whole numbers; some rows have an empty Employer cell.
//        approvals = Initial Approval + Continuing Approval
//        denials   = Initial Denial + Continuing Denial
//      The yearly files are comma-separated. Whether the hub's own export is
//      comma- or tab-separated was not seen: the reader takes the separator
//      from the header line (sponsorRegister.ts `delimiterOf`).
//
//   2. The hub's current fields. The hub itself (fiscal year 2009 to 2026
//      quarter 3 on the day it was read) is an interactive page whose export a
//      program cannot fetch, so NO FILE OF THIS LAYOUT WAS READ. The names are
//      the terms of the glossary on
//      https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub/understanding-our-h-1b-employer-data-hub
//      Fiscal Year, Employer Name, NAICS, Tax ID, State, City, ZIP, and six
//      kinds of decision, each as "<kind> Approval" and "<kind> Denial":
//      New Employment, Continuation, Change with Same Employer, New Concurrent,
//      Change of Employer, Amended.
//        approvals = the sum of the six Approval columns
//        denials   = the sum of the six Denial columns
//      If an export spells a column differently the import stops with the
//      missing names; add the spelling here once it has been read from a file.
//
// The employer key is `normalizeCompanyName`, the key RACompany.nameNormalized
// and the LCA loader use, so the facts route finds the rows. Rows of one key
// and fiscal year are added up (several addresses, several tax ids, several
// spellings of one name).
//
// A COUNT IS NEVER MADE UP. A row is counted only when it states its counts:
//   - a count cell that is missing (the row is shorter than the header: a line
//     cut short) or is not a whole number skips the row (`bad_count`);
//   - a row whose count cells are ALL empty states no count and is skipped
//     (`no_counts`): stored as 0 and 0 it would read "0 petitions approved and
//     0 denied", which the file does not say;
//   - an empty cell beside stated counts is read as 0 (a column left blank for
//     "none"), and the report says how many rows that happened in
//     (`withEmptyCount`), so the owner sees it before anything is written.

import { normalizeCompanyName } from '../normalize/index.js';
import { RegisterHeaderError, cellText, findColumn, type RegisterRawRow, type SponsorRegisterRow } from './sponsorRegister.js';
import { USCIS_COUNTRY, USCIS_H1B_HUB_SOURCE, USCIS_H1B_HUB_URL, uscisPeriod } from './sponsorSources.js';

const FISCAL_YEAR = ['Fiscal Year'];

/** Layout 1: the yearly files. Each count in the singular (FY2023 file) and the plural (FY2009 file). */
const YEARLY_FILE = {
  employer: ['Employer'],
  approvals: [
    ['Initial Approval', 'Initial Approvals'],
    ['Continuing Approval', 'Continuing Approvals'],
  ],
  denials: [
    ['Initial Denial', 'Initial Denials'],
    ['Continuing Denial', 'Continuing Denials'],
  ],
} as const;

/** Layout 2: the glossary terms of the hub's current fields (not read from a file; see the header). */
const HUB_DECISION_KINDS = ['New Employment', 'Continuation', 'Change with Same Employer', 'New Concurrent', 'Change of Employer', 'Amended'] as const;
const HUB_FIELDS = {
  employer: ['Employer Name'],
  approvals: HUB_DECISION_KINDS.map((kind) => [`${kind} Approval`]),
  denials: HUB_DECISION_KINDS.map((kind) => [`${kind} Denial`]),
} as const;

export type UscisLayoutId = 'yearly_file' | 'hub_fields';

/** Which cells of this file hold what, by the header cell as the file writes it. */
export interface UscisLayout {
  id: UscisLayoutId;
  fiscalYear: string;
  employer: string;
  approvals: string[];
  denials: string[];
}

const EXPECTED =
  'the yearly file (Fiscal Year, Employer, Initial Approval, Initial Denial, Continuing Approval, Continuing Denial) or the hub\'s current fields (Fiscal Year, Employer Name, and an Approval and a Denial column for each of: ' +
  `${HUB_DECISION_KINDS.join(', ')})`;

function tryLayout(id: UscisLayoutId, header: readonly string[], spec: { employer: readonly string[]; approvals: ReadonlyArray<readonly string[]>; denials: ReadonlyArray<readonly string[]> }): { layout: UscisLayout | null; missing: string[] } {
  const missing: string[] = [];
  const pick = (spellings: readonly string[]): string => {
    const cell = findColumn(header, spellings);
    if (!cell) missing.push(spellings[0]!);
    return cell ?? '';
  };
  const layout: UscisLayout = {
    id,
    fiscalYear: pick(FISCAL_YEAR),
    employer: pick(spec.employer),
    approvals: spec.approvals.map(pick),
    denials: spec.denials.map(pick),
  };
  return { layout: missing.length ? null : layout, missing };
}

/**
 * The layout of a file from its header row. Throws RegisterHeaderError (with
 * the missing columns of the layout the header is closest to) for any other
 * header: a renamed or missing count column never imports as zero.
 */
export function resolveUscisLayout(header: readonly string[]): UscisLayout {
  const yearly = tryLayout('yearly_file', header, YEARLY_FILE);
  if (yearly.layout) return yearly.layout;
  const hub = tryLayout('hub_fields', header, HUB_FIELDS);
  if (hub.layout) return hub.layout;
  const closest = hub.missing.length < yearly.missing.length ? hub : yearly;
  throw new RegisterHeaderError('USCIS H-1B Employer Data Hub', closest.missing, header, EXPECTED);
}

export interface UscisCase {
  fiscalYear: number;
  employerName: string;
  employerNameNormalized: string;
  /** Initial + continuing approvals (yearly file), or the six kinds of approval (hub fields). */
  approvals: number;
  denials: number;
  /** Count cells of the row that were empty and read as 0 (never all of them: such a row is skipped). */
  emptyCounts: number;
}

export type UscisSkipReason = 'no_employer' | 'no_fiscal_year' | 'bad_count' | 'no_counts';

/**
 * One count cell that is present: "1,234" / 1234 / "" → 1234 / 1234 / 0;
 * anything that is not a whole number ≥ 0 → null. Whether an empty cell may
 * be read as 0 at all is decided per row by `parseUscisRow` (the header says how).
 */
export function parseCount(value: unknown): number | null {
  const text = cellText(value).replace(/,/g, '');
  if (text === '') return 0;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/** Null when a cell is missing (the row is shorter than the header) or is not a whole number. */
function sum(row: RegisterRawRow, cells: readonly string[]): number | null {
  let total = 0;
  for (const cell of cells) {
    if (row[cell] === undefined || row[cell] === null) return null;
    const n = parseCount(row[cell]);
    if (n === null) return null;
    total += n;
  }
  return total;
}

/** One row of the file → the counts we keep, or why the row is skipped. */
export function parseUscisRow(raw: RegisterRawRow, layout: UscisLayout): UscisCase | { skip: UscisSkipReason } {
  const employerName = cellText(raw[layout.employer]);
  const employerNameNormalized = employerName ? normalizeCompanyName(employerName) : '';
  if (!employerNameNormalized) return { skip: 'no_employer' };
  const year = cellText(raw[layout.fiscalYear]);
  const fiscalYear = /^\d{4}$/.test(year) ? Number(year) : NaN;
  if (!(fiscalYear >= 2000 && fiscalYear <= 2100)) return { skip: 'no_fiscal_year' };
  const approvals = sum(raw, layout.approvals);
  const denials = sum(raw, layout.denials);
  if (approvals === null || denials === null) return { skip: 'bad_count' };
  const countCells = [...layout.approvals, ...layout.denials];
  const emptyCounts = countCells.filter((cell) => cellText(raw[cell]) === '').length;
  if (emptyCounts === countCells.length) return { skip: 'no_counts' };
  return { fiscalYear, employerName, employerNameNormalized, approvals, denials, emptyCounts };
}

/** One employer in one fiscal year. */
export interface UscisEmployerYear {
  employerNameNormalized: string;
  employerName: string;
  fiscalYear: number;
  approvals: number;
  denials: number;
}

export interface UscisAggregateResult {
  entries: UscisEmployerYear[];
  /** The fiscal years the file holds, ascending: the scope an import replaces. */
  fiscalYears: number[];
  rows: {
    read: number;
    counted: number;
    skipped: Record<UscisSkipReason, number>;
    /** Counted rows in which an empty count cell was read as 0. */
    withEmptyCount: number;
  };
}

/** Streaming aggregator: `add` every row, then `result()`. */
export function createUscisAggregator(layout: UscisLayout) {
  const buckets = new Map<string, UscisEmployerYear>();
  const rows = { read: 0, counted: 0, skipped: { no_employer: 0, no_fiscal_year: 0, bad_count: 0, no_counts: 0 } as Record<UscisSkipReason, number>, withEmptyCount: 0 };
  return {
    add(raw: RegisterRawRow): void {
      rows.read += 1;
      const c = parseUscisRow(raw, layout);
      if ('skip' in c) {
        rows.skipped[c.skip] += 1;
        return;
      }
      rows.counted += 1;
      if (c.emptyCounts > 0) rows.withEmptyCount += 1;
      const key = `${c.employerNameNormalized}\u0000${c.fiscalYear}`;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.approvals += c.approvals;
        bucket.denials += c.denials;
      } else {
        buckets.set(key, { employerNameNormalized: c.employerNameNormalized, employerName: c.employerName, fiscalYear: c.fiscalYear, approvals: c.approvals, denials: c.denials });
      }
    },
    result(): UscisAggregateResult {
      const entries = [...buckets.values()].sort((a, b) => a.employerNameNormalized.localeCompare(b.employerNameNormalized) || a.fiscalYear - b.fiscalYear);
      const fiscalYears = [...new Set(entries.map((e) => e.fiscalYear))].sort((a, b) => a - b);
      return { entries, fiscalYears, rows: { ...rows, skipped: { ...rows.skipped } } };
    },
  };
}

/** Aggregate rows already in memory (tests, small files). The header is the keys of the first row. */
export function aggregateUscis(rows: readonly RegisterRawRow[], header: readonly string[] = Object.keys(rows[0] ?? {})): UscisAggregateResult {
  const agg = createUscisAggregator(resolveUscisLayout(header));
  for (const row of rows) agg.add(row);
  return agg.result();
}

/** Aggregates → the rows written to RASponsorRegisterEntry. */
export function uscisRegisterRows(entries: readonly UscisEmployerYear[], meta: { sourceFile: string; asOf: Date; importedAt: Date }): SponsorRegisterRow[] {
  return entries.map((e) => ({
    source: USCIS_H1B_HUB_SOURCE,
    country: USCIS_COUNTRY,
    employerNameNormalized: e.employerNameNormalized,
    employerName: e.employerName,
    period: uscisPeriod(e.fiscalYear),
    approvals: e.approvals,
    denials: e.denials,
    town: null,
    rating: null,
    routes: [],
    sourceFile: meta.sourceFile,
    sourceUrl: USCIS_H1B_HUB_URL,
    asOf: meta.asOf,
    importedAt: meta.importedAt,
  }));
}
