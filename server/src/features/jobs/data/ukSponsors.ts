// server/src/features/jobs/data/ukSponsors.ts — UK "Register of licensed
// sponsors: workers" rows → one entry per organisation (RASponsorRegisterEntry,
// source 'uk_sponsor_register'; JI-11).
//
// Pure: rows in, aggregates out. No file access, no database, no network —
// importUkSponsors.ts (the CLI) reads the file and writes the rows.
//
// Source: UK Visas and Immigration (Home Office), "Register of licensed
// sponsors: workers"
//   https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
// "List of organisations licensed to sponsor workers on the Worker and
// Temporary Worker immigration routes", published as one CSV ("Register of
// Worker and Temporary Worker licensed sponsors") that the publisher replaces
// with each update (the page lists them; the file name carries the date).
// The page is under the Open Government Licence v3.0, which asks for an
// acknowledgement wherever the information is used: UK_SPONSOR_REGISTER_LICENCE
// (sponsorSources.ts) carries the licence's own statement and link, and the
// reader prints it with the fact. A licence is permission to sponsor; it does not say the
// organisation will sponsor any one job (the reader shows SPONSORSHIP_DISCLAIMER).
//
// COLUMNS ARE MAPPED BY HEADER NAME, and a file with another header is refused
// before a row is read (RegisterHeaderError names the missing columns). The
// spellings were read on 2026-10-12 from the page's own preview of the file
// SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-10-09.csv (10.4 MB,
// "Last updated 9 October 2026"); none is typed from memory:
//   Organisation Name, Town/City, County, Type & Rating, Route
// Values seen there, for the shape only: Type & Rating "Worker (A rating)",
// "Temporary Worker (A rating)"; Route "Skilled Worker", "Creative Worker",
// "Global Business Mobility: Senior or Specialist Worker".
//
// One organisation is on several lines, one per route, and those lines can
// carry different Type & Rating values (Worker for one route, Temporary Worker
// for another). Lines are merged per normalised organisation name
// (`normalizeCompanyName`, the key RACompany.nameNormalized carries):
//   routes  the distinct Route values, in file order
//   rating  the distinct Type & Rating values, in file order, joined with "; "
//   town    the Town/City when every line of the name states the same one;
//           null when they differ (two organisations that share a name, or one
//           with several sites: the register does not say which, so we do not)
// County is read by nobody and is not stored. The register is a current list:
// `period` is '', approvals and denials are null, and each import replaces the
// stored snapshot, so an organisation that left the register is no longer
// shown as a licensed sponsor.

import { normalizeCompanyName } from '../normalize/index.js';
import { RegisterHeaderError, cellText, findColumn, type RegisterRawRow, type SponsorRegisterRow } from './sponsorRegister.js';
import { UK_RATING_SEPARATOR, UK_SPONSOR_REGISTER_COUNTRY, UK_SPONSOR_REGISTER_SOURCE, UK_SPONSOR_REGISTER_URL } from './sponsorSources.js';

const COLUMNS = {
  organisation: 'Organisation Name',
  town: 'Town/City',
  rating: 'Type & Rating',
  route: 'Route',
} as const;

/** Which cells of this file hold what, by the header cell as the file writes it. */
export interface UkSponsorColumns {
  organisation: string;
  town: string;
  rating: string;
  route: string;
}

/** The register's columns from its header row; RegisterHeaderError for any other header. */
export function resolveUkSponsorColumns(header: readonly string[]): UkSponsorColumns {
  const missing: string[] = [];
  const pick = (name: string): string => {
    const cell = findColumn(header, [name]);
    if (!cell) missing.push(name);
    return cell ?? '';
  };
  const columns: UkSponsorColumns = { organisation: pick(COLUMNS.organisation), town: pick(COLUMNS.town), rating: pick(COLUMNS.rating), route: pick(COLUMNS.route) };
  if (missing.length) throw new RegisterHeaderError('UK Register of Licensed Sponsors', missing, header, `the register's columns (${Object.values(COLUMNS).join(', ')})`);
  return columns;
}

export interface UkSponsorLine {
  organisationName: string;
  employerNameNormalized: string;
  town: string | null;
  /** "Type & Rating" as published, e.g. "Worker (A rating)". */
  rating: string | null;
  route: string | null;
}

export type UkSponsorSkipReason = 'no_organisation';

/** Spaces just inside a bracket are noise ("Provisional )" in the file), not part of the value. */
const tidy = (value: string): string => value.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

/** One line of the register → what we keep of it, or why the line is skipped. */
export function parseUkSponsorRow(raw: RegisterRawRow, columns: UkSponsorColumns): UkSponsorLine | { skip: UkSponsorSkipReason } {
  const organisationName = cellText(raw[columns.organisation]);
  const employerNameNormalized = organisationName ? normalizeCompanyName(organisationName) : '';
  if (!employerNameNormalized) return { skip: 'no_organisation' };
  return {
    organisationName,
    employerNameNormalized,
    town: cellText(raw[columns.town]) || null,
    rating: tidy(cellText(raw[columns.rating])) || null,
    route: tidy(cellText(raw[columns.route])) || null,
  };
}

/** One organisation name on the register. */
export interface UkSponsorEntry {
  employerNameNormalized: string;
  /** The name as the register prints it (the first spelling seen for the key). */
  employerName: string;
  town: string | null;
  rating: string | null;
  routes: string[];
}

export interface UkSponsorAggregateResult {
  entries: UkSponsorEntry[];
  rows: { read: number; counted: number; skipped: Record<UkSponsorSkipReason, number> };
  /** Names whose lines state more than one town (stored with no town). */
  severalTowns: number;
}

interface Bucket {
  employerNameNormalized: string;
  employerName: string;
  /** The first town as published, and every distinct town (compared without capitals). */
  town: string | null;
  towns: Set<string>;
  ratings: string[];
  routes: string[];
}

/** Streaming aggregator: `add` every line, then `result()`. */
export function createUkSponsorAggregator(columns: UkSponsorColumns) {
  const buckets = new Map<string, Bucket>();
  const rows = { read: 0, counted: 0, skipped: { no_organisation: 0 } as Record<UkSponsorSkipReason, number> };
  return {
    add(raw: RegisterRawRow): void {
      rows.read += 1;
      const line = parseUkSponsorRow(raw, columns);
      if ('skip' in line) {
        rows.skipped[line.skip] += 1;
        return;
      }
      rows.counted += 1;
      let bucket = buckets.get(line.employerNameNormalized);
      if (!bucket) {
        bucket = { employerNameNormalized: line.employerNameNormalized, employerName: line.organisationName, town: null, towns: new Set(), ratings: [], routes: [] };
        buckets.set(line.employerNameNormalized, bucket);
      }
      if (line.town) {
        bucket.town ??= line.town;
        bucket.towns.add(line.town.toLowerCase());
      }
      if (line.rating && !bucket.ratings.includes(line.rating)) bucket.ratings.push(line.rating);
      if (line.route && !bucket.routes.includes(line.route)) bucket.routes.push(line.route);
    },
    result(): UkSponsorAggregateResult {
      const all = [...buckets.values()];
      const entries = all
        .map(
          (b): UkSponsorEntry => ({
            employerNameNormalized: b.employerNameNormalized,
            employerName: b.employerName,
            town: b.towns.size === 1 ? b.town : null,
            rating: b.ratings.length ? b.ratings.join(UK_RATING_SEPARATOR) : null,
            routes: [...b.routes],
          }),
        )
        .sort((a, b) => a.employerNameNormalized.localeCompare(b.employerNameNormalized));
      return { entries, rows: { ...rows, skipped: { ...rows.skipped } }, severalTowns: all.filter((b) => b.towns.size > 1).length };
    },
  };
}

/** Aggregate lines already in memory (tests, small files). The header is the keys of the first line. */
export function aggregateUkSponsors(rows: readonly RegisterRawRow[], header: readonly string[] = Object.keys(rows[0] ?? {})): UkSponsorAggregateResult {
  const agg = createUkSponsorAggregator(resolveUkSponsorColumns(header));
  for (const row of rows) agg.add(row);
  return agg.result();
}

/** Aggregates → the rows written to RASponsorRegisterEntry. */
export function ukSponsorRegisterRows(entries: readonly UkSponsorEntry[], meta: { sourceFile: string; asOf: Date; importedAt: Date }): SponsorRegisterRow[] {
  return entries.map((e) => ({
    source: UK_SPONSOR_REGISTER_SOURCE,
    country: UK_SPONSOR_REGISTER_COUNTRY,
    employerNameNormalized: e.employerNameNormalized,
    employerName: e.employerName,
    period: '',
    approvals: null,
    denials: null,
    town: e.town,
    rating: e.rating,
    routes: e.routes,
    sourceFile: meta.sourceFile,
    sourceUrl: UK_SPONSOR_REGISTER_URL,
    asOf: meta.asOf,
    importedAt: meta.importedAt,
  }));
}
