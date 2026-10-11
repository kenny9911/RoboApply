// @vitest-environment node
//
// UK Register of Licensed Sponsors importer (JI-11): the register's columns by
// header name, one entry per organisation with its routes and its type and
// rating, the fixture as a dry run (the default: nothing is written without
// `apply`), and the write through a fake database: each import replaces the
// stored snapshot, so an organisation that left the register is gone. No
// network (the importer downloads nothing) and no database. Every organisation
// and place here is an invented placeholder.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { normalizeCompanyName } from '../normalize/index.js';
import { importUkSponsorsFile, parseUkSponsorArgs, runUkSponsorCli, ukSponsorReportLines } from './importUkSponsors.js';
import { DRY_RUN_LINE, RegisterHeaderError, type SponsorRegisterDb, type SponsorRegisterRow } from './sponsorRegister.js';
import { UK_SPONSOR_REGISTER_LICENCE, UK_SPONSOR_REGISTER_URL } from './sponsorSources.js';
import { aggregateUkSponsors, parseUkSponsorRow, resolveUkSponsorColumns } from './ukSponsors.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'uk-sponsors.sample.csv');
const EXAMPLE = normalizeCompanyName('Example Employer Ltd');
const SAMPLE = normalizeCompanyName('Sample Robotics Limited');
const CARE = normalizeCompanyName('Placeholder Care Services Ltd');
const AS_OF = new Date('2026-10-09T00:00:00.000Z');
const IMPORTED = new Date('2026-10-12T08:00:00.000Z');

/** The register's header, as the page's preview of the file shows it (read 2026-10-12). */
const HEADER = ['Organisation Name', 'Town/City', 'County', 'Type & Rating', 'Route'];

const line = (over: Record<string, unknown> = {}) => ({
  'Organisation Name': 'Example Employer Ltd',
  'Town/City': 'Exampletown',
  County: 'Exampleshire',
  'Type & Rating': 'Worker (A rating)',
  Route: 'Skilled Worker',
  ...over,
});

const tmp = mkdtempSync(path.join(tmpdir(), 'uk-sponsors-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
function csv(name: string, lines: string[]): string {
  const file = path.join(tmp, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function fakeDb(seed: Array<Partial<SponsorRegisterRow>> = []) {
  const fake = createFakePrisma({ seed: { rASponsorRegisterEntry: seed as Array<Record<string, unknown>> } });
  const rows = () => fake.$rows('rASponsorRegisterEntry') as unknown as Array<SponsorRegisterRow & { id: string }>;
  return { db: fake as unknown as SponsorRegisterDb, rows };
}

describe('header detection', () => {
  it('finds the four columns it reads by name; County is not needed', () => {
    expect(resolveUkSponsorColumns(HEADER)).toEqual({ organisation: 'Organisation Name', town: 'Town/City', rating: 'Type & Rating', route: 'Route' });
    expect(resolveUkSponsorColumns(['route', 'TYPE &  RATING', ' town/city', '\uFEFFOrganisation Name'])).toEqual({ organisation: '\uFEFFOrganisation Name', town: ' town/city', rating: 'TYPE &  RATING', route: 'route' });
  });

  it('refuses any other header and names the missing columns', () => {
    expect(() => resolveUkSponsorColumns(HEADER.filter((h) => h !== 'Route'))).toThrow(/Missing column: "Route"\..*Nothing was written\./s);
    try {
      resolveUkSponsorColumns(['Organisation', 'Town', 'Rating', 'Routes']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RegisterHeaderError);
      expect((err as RegisterHeaderError).missing).toEqual(['Organisation Name', 'Town/City', 'Type & Rating', 'Route']);
    }
  });
});

describe('parseUkSponsorRow', () => {
  const columns = resolveUkSponsorColumns(HEADER);

  it('keeps the name as published, the key the company table uses, the town, and the two register values', () => {
    expect(parseUkSponsorRow(line(), columns)).toEqual({ organisationName: 'Example Employer Ltd', employerNameNormalized: EXAMPLE, town: 'Exampletown', rating: 'Worker (A rating)', route: 'Skilled Worker' });
  });

  it('empty cells are null, stray spaces are not part of a value, and a line with no organisation is skipped', () => {
    expect(parseUkSponsorRow(line({ 'Town/City': '', 'Type & Rating': 'Worker (UK Expansion Worker: Provisional )', Route: '  Global Business Mobility:  UK Expansion Worker ' }), columns)).toMatchObject({
      town: null,
      rating: 'Worker (UK Expansion Worker: Provisional)',
      route: 'Global Business Mobility: UK Expansion Worker',
    });
    expect(parseUkSponsorRow(line({ 'Type & Rating': '', Route: '' }), columns)).toMatchObject({ rating: null, route: null });
    expect(parseUkSponsorRow(line({ 'Organisation Name': '  ' }), columns)).toEqual({ skip: 'no_organisation' });
  });
});

describe('aggregateUkSponsors', () => {
  it('one organisation on two routes is one entry with both routes, in file order, each once', () => {
    const { entries, rows, severalTowns } = aggregateUkSponsors([
      line(),
      line({ 'Type & Rating': 'Temporary Worker (A rating)', Route: 'Creative Worker' }),
      line({ 'Organisation Name': 'EXAMPLE EMPLOYER LIMITED', 'Town/City': 'EXAMPLETOWN' }), // the same route and rating again, another spelling
    ]);
    expect(rows).toEqual({ read: 3, counted: 3, skipped: { no_organisation: 0 } });
    expect(severalTowns).toBe(0);
    expect(entries).toEqual([
      {
        employerNameNormalized: EXAMPLE,
        employerName: 'Example Employer Ltd',
        town: 'Exampletown',
        // The lines of one organisation can carry different type-and-rating values: each distinct one is kept.
        rating: 'Worker (A rating); Temporary Worker (A rating)',
        routes: ['Skilled Worker', 'Creative Worker'],
      },
    ]);
  });

  it('a name whose lines state different towns is stored with no town: the register does not say which organisation is which', () => {
    const { entries, severalTowns } = aggregateUkSponsors([line({ 'Organisation Name': 'Placeholder Care Services Ltd' }), line({ 'Organisation Name': 'Placeholder Care Services Ltd', 'Town/City': 'Sampleton' })]);
    expect(severalTowns).toBe(1);
    expect(entries).toEqual([{ employerNameNormalized: CARE, employerName: 'Placeholder Care Services Ltd', town: null, rating: 'Worker (A rating)', routes: ['Skilled Worker'] }]);
  });
});

describe('the fixture file (the register\'s header, placeholder lines)', () => {
  it('dry run: three organisations, and nothing is written', async () => {
    const { db, rows } = fakeDb();
    const report = await importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, db });
    expect(report).toMatchObject({ sourceFile: 'uk-sponsors.sample.csv', asOf: AS_OF, severalTowns: 1, undecodedNames: 0, replaced: 0, written: 0, dryRun: true });
    expect(report.reading).toEqual({ delimiter: ',', encoding: 'utf8', unevenRows: 0, lastRowUneven: false });
    expect(report.rows).toEqual({ read: 6, counted: 5, skipped: { no_organisation: 1 } });
    expect(report.entries).toEqual([
      { employerNameNormalized: EXAMPLE, employerName: 'Example Employer Ltd', town: 'Exampletown', rating: 'Worker (A rating); Temporary Worker (A rating)', routes: ['Skilled Worker', 'Creative Worker'] },
      { employerNameNormalized: CARE, employerName: 'Placeholder Care Services Ltd', town: null, rating: 'Worker (A rating)', routes: ['Skilled Worker'] },
      { employerNameNormalized: SAMPLE, employerName: 'Sample Robotics Limited', town: 'Sampleton', rating: 'Worker (A rating)', routes: ['Skilled Worker'] },
    ]);
    expect(rows()).toHaveLength(0);
  });

  it('nothing is written unless the caller says apply: the stored register survives an import that was not told to write', async () => {
    const stored = new Date('2026-10-02T00:00:00.000Z');
    const { db, rows } = fakeDb([{ source: 'uk_sponsor_register', country: 'GB', employerNameNormalized: 'placeholder leaver', employerName: 'Placeholder Leaver Ltd', period: '', asOf: stored }]);
    const beforeWrite = vi.fn();
    for (const options of [{}, { apply: false }, { apply: undefined }, { allowShrink: true }]) {
      expect(await importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, db, beforeWrite, ...options })).toMatchObject({ dryRun: true, replaced: 0, written: 0 });
    }
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(rows().map((r) => r.employerNameNormalized)).toEqual(['placeholder leaver']);
    expect(ukSponsorReportLines(await importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, db }))).toEqual([
      'File: uk-sponsors.sample.csv',
      'As of: 2026-10-09',
      'Columns separated by: comma · read as: utf8',
      'Lines read: 6 · counted: 5 · skipped: no_organisation 1',
      'Organisations: 3 (1 with more than one town, stored without a town)',
    ]);
  });

  it('import: one row per organisation, with no period and no counts, the file and the register\'s date', async () => {
    const { db, rows } = fakeDb();
    const seen: number[] = [];
    // The caller is handed the report of the file before the first row is written.
    const report = await importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, now: () => IMPORTED, beforeWrite: (read) => void seen.push(read.entries.length, rows().length) });
    expect(seen).toEqual([3, 0]);
    expect(report).toMatchObject({ replaced: 0, written: 3, dryRun: false });
    expect(rows()).toHaveLength(3);
    expect(rows().find((r) => r.employerNameNormalized === EXAMPLE)).toMatchObject({
      source: 'uk_sponsor_register',
      country: 'GB',
      employerName: 'Example Employer Ltd',
      period: '',
      approvals: null,
      denials: null,
      town: 'Exampletown',
      rating: 'Worker (A rating); Temporary Worker (A rating)',
      routes: ['Skilled Worker', 'Creative Worker'],
      sourceFile: 'uk-sponsors.sample.csv',
      sourceUrl: UK_SPONSOR_REGISTER_URL,
      asOf: AS_OF,
      importedAt: IMPORTED,
    });
    // The same file again: the same three rows, none twice.
    expect(await importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, now: () => IMPORTED })).toMatchObject({ replaced: 3, written: 3 });
    expect(rows().map((r) => r.employerNameNormalized).sort()).toEqual([EXAMPLE, CARE, SAMPLE].sort());
  });
});

describe('each import replaces the stored snapshot', () => {
  const NEXT = new Date('2026-10-16T00:00:00.000Z');
  const next = () =>
    csv('SP_-_placeholder_register_-_2026-10-16.csv', [
      'Organisation Name,Town/City,County,Type & Rating,Route',
      'Example Employer Ltd,Exampletown,Exampleshire,Worker (A rating),Skilled Worker',
      'Placeholder Care Services Ltd,Exampletown,,Worker (A rating),Skilled Worker',
      'Placeholder Newcomer Ltd,Sampleton,,Worker (A rating),Skilled Worker',
    ]);

  it('an organisation missing from a newer file is gone; one that lost a route has lost it; the US rows are untouched', async () => {
    const { db, rows } = fakeDb([{ source: 'uscis_h1b_hub', country: 'US', employerNameNormalized: EXAMPLE, employerName: 'EXAMPLE EMPLOYER LLC', period: 'FY2023', approvals: 11, denials: 2, asOf: new Date('2025-07-01T00:00:00.000Z') }]);
    await importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, now: () => IMPORTED });
    const report = await importUkSponsorsFile({ file: next(), asOf: NEXT, apply: true, db, now: () => IMPORTED });
    expect(report).toMatchObject({ replaced: 3, written: 3 });
    const uk = rows().filter((r) => r.source === 'uk_sponsor_register');
    expect(uk.map((r) => r.employerNameNormalized).sort()).toEqual([EXAMPLE, CARE, normalizeCompanyName('Placeholder Newcomer Ltd')].sort());
    expect(uk.some((r) => r.employerNameNormalized === SAMPLE)).toBe(false);
    expect(uk.every((r) => r.asOf.getTime() === NEXT.getTime() && r.sourceFile === 'SP_-_placeholder_register_-_2026-10-16.csv')).toBe(true);
    expect(uk.find((r) => r.employerNameNormalized === EXAMPLE)).toMatchObject({ rating: 'Worker (A rating)', routes: ['Skilled Worker'] });
    // One town now: the name is no longer ambiguous.
    expect(uk.find((r) => r.employerNameNormalized === CARE)).toMatchObject({ town: 'Exampletown' });
    expect(rows().filter((r) => r.source === 'uscis_h1b_hub')).toHaveLength(1);
  });

  it('an older register never replaces a newer one, and a file with another header writes nothing', async () => {
    const { db, rows } = fakeDb();
    await importUkSponsorsFile({ file: next(), asOf: NEXT, apply: true, db, now: () => IMPORTED });
    await expect(importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, apply: true, db })).rejects.toMatchObject({ name: 'RegisterWriteError', reason: 'older_than_stored' });
    const renamed = csv('renamed.csv', ['Organisation Name,Town/City,County,Type & Rating,Routes', 'Example Employer Ltd,Exampletown,,Worker (A rating),Skilled Worker']);
    await expect(importUkSponsorsFile({ file: renamed, asOf: NEXT, apply: true, db })).rejects.toThrow(/Missing column: "Route"/);
    expect(rows().map((r) => r.employerNameNormalized).sort()).toEqual([EXAMPLE, CARE, normalizeCompanyName('Placeholder Newcomer Ltd')].sort());
    expect(rows().every((r) => r.asOf.getTime() === NEXT.getTime())).toBe(true);
  });

  it('a register cut short is refused: fewer than half the stored organisations needs --allow-shrink', async () => {
    const seed = Array.from({ length: 7 }, (_v, i) => ({ source: 'uk_sponsor_register' as const, country: 'GB', employerNameNormalized: `placeholder org ${i}`, employerName: `Placeholder Org ${i} Ltd`, period: '', asOf: new Date('2026-10-02T00:00:00.000Z') }));
    const { db, rows } = fakeDb(seed);
    await expect(importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, apply: true, db })).rejects.toMatchObject({ reason: 'shrinks_stored' });
    expect(rows()).toHaveLength(7);
    expect(await importUkSponsorsFile({ file: FIXTURE, asOf: AS_OF, apply: true, db, allowShrink: true })).toMatchObject({ replaced: 7, written: 3 });
  });

  it('reports names the file\'s encoding could not give, and never writes them: the write waits for the encoding', async () => {
    const { db, rows } = fakeDb();
    const file = path.join(tmp, 'latin1.csv');
    writeFileSync(file, Buffer.from('Organisation Name,Town/City,County,Type & Rating,Route\nPlaceholder Café Ltd,Exampletown,,Worker (A rating),Skilled Worker\n', 'latin1'));
    const dry = await importUkSponsorsFile({ file, asOf: AS_OF, db });
    expect(dry.undecodedNames).toBe(1);
    expect(ukSponsorReportLines(dry).join('\n')).toMatch(/Organisation names with unreadable characters: 1\. The file is not UTF-8: nothing can be written until --encoding/);
    await expect(importUkSponsorsFile({ file, asOf: AS_OF, apply: true, db })).rejects.toMatchObject({ name: 'RegisterWriteError', reason: 'unreadable_names' });
    expect(rows()).toHaveLength(0);
    const read = await importUkSponsorsFile({ file, asOf: AS_OF, apply: true, encoding: 'latin1', db, now: () => IMPORTED });
    expect(read).toMatchObject({ undecodedNames: 0, written: 1 });
    expect(read.entries[0]!.employerName).toBe('Placeholder Café Ltd');
    expect(rows()[0]).toMatchObject({ employerName: 'Placeholder Café Ltd' });
  });
});

describe('a file is read as it is written, and a line is never guessed', () => {
  const HEAD = 'Organisation Name,Town/City,County,Type & Rating,Route';

  it('a line cut short, or one with a comma inside an unquoted name, is left out: no organisation is stored from half a line', async () => {
    const file = csv('uneven.csv', [
      HEAD,
      'Example Employer Ltd,Exampletown,Exampleshire,Worker (A rating),Skilled Worker',
      // One cell too many: read by position, the town would be "Ltd" and the route "Worker (A rating)".
      'Sample Robotics, Ltd,Sampleton,,Worker (A rating),Skilled Worker',
      // The download ended inside this line: the name itself may be cut.
      'Placeholder Care Serv',
    ]);
    const report = await importUkSponsorsFile({ file, asOf: AS_OF });
    expect(report.reading).toEqual({ delimiter: ',', encoding: 'utf8', unevenRows: 2, lastRowUneven: true });
    expect(report.rows).toEqual({ read: 1, counted: 1, skipped: { no_organisation: 0 } });
    expect(report.entries.map((e) => e.employerName)).toEqual(['Example Employer Ltd']);
    expect(ukSponsorReportLines(report)).toContain('Lines with more or fewer cells than the header (left out): 2. The last line of the file is one of them: the download may have been cut short.');
    // The same name in quotes is one cell, and is read.
    const quoted = await importUkSponsorsFile({ file: csv('quoted.csv', [HEAD, '"Sample Robotics, Ltd",Sampleton,,Worker (A rating),Skilled Worker']), asOf: AS_OF });
    expect(quoted.reading.unevenRows).toBe(0);
    expect(quoted.entries).toEqual([{ employerNameNormalized: normalizeCompanyName('Sample Robotics, Ltd'), employerName: 'Sample Robotics, Ltd', town: 'Sampleton', rating: 'Worker (A rating)', routes: ['Skilled Worker'] }]);
  });

  it('a tab-separated register reads like the comma-separated one', async () => {
    const file = csv('tabs.csv', [HEAD.replace(/,/g, '\t'), ['Sample Robotics, Ltd', 'Sampleton', '', 'Worker (A rating)', 'Skilled Worker'].join('\t')]);
    const report = await importUkSponsorsFile({ file, asOf: AS_OF });
    expect(report.reading).toMatchObject({ delimiter: '\t', unevenRows: 0 });
    expect(report.entries).toEqual([{ employerNameNormalized: normalizeCompanyName('Sample Robotics, Ltd'), employerName: 'Sample Robotics, Ltd', town: 'Sampleton', rating: 'Worker (A rating)', routes: ['Skilled Worker'] }]);
  });
});

describe('licence and command line', () => {
  it('the register is under the Open Government Licence v3.0, whose own statement is kept for the reader', () => {
    expect(UK_SPONSOR_REGISTER_LICENCE).toEqual({
      name: 'Open Government Licence v3.0',
      url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
      statement: 'Contains public sector information licensed under the Open Government Licence v3.0.',
    });
  });

  it('reads the file and the register\'s date, and writes only with --apply', () => {
    const now = new Date('2026-10-12T12:00:00.000Z');
    expect(parseUkSponsorArgs(['register.csv', '--as-of', '2026-10-09'], now)).toEqual({ file: 'register.csv', asOf: AS_OF, apply: false, allowShrink: false });
    expect(parseUkSponsorArgs(['register.csv', '--as-of', '2026-10-09', '--dry-run'], now)).toEqual({ file: 'register.csv', asOf: AS_OF, apply: false, allowShrink: false });
    expect(parseUkSponsorArgs(['register.csv', '--as-of', '2026-10-09', '--apply', '--allow-shrink'], now)).toEqual({ file: 'register.csv', asOf: AS_OF, apply: true, allowShrink: true });
    expect(() => parseUkSponsorArgs(['register.csv', '--as-of', '2026-10-09', '--dry-run', '--apply'], now)).toThrow(/not both/);
    expect(() => parseUkSponsorArgs(['register.csv'], now)).toThrow(/Usage: npx tsx server\/src\/features\/jobs\/data\/importUkSponsors\.ts <file\.csv> --as-of YYYY-MM-DD \[--apply\]/);
  });

  it('one run of the command line: a dry run by default; with --apply the register and the database are named before the write', async () => {
    const now = () => new Date('2026-10-12T12:00:00.000Z');
    const { db, rows } = fakeDb();
    const dry: string[][] = [];
    const first = await runUkSponsorCli([FIXTURE, '--as-of', '2026-10-09'], { databaseUrl: undefined, print: (lines) => dry.push(lines), db, now });
    expect(dry).toEqual([[...ukSponsorReportLines(first), DRY_RUN_LINE]]);
    expect(rows()).toHaveLength(0);
    // A made-up address: only its host and database name may reach a printed line.
    const database = 'postgresql://placeholder_user:placeholder-secret@db.example.test/placeholder_db?sslmode=require';
    const printed: Array<{ lines: string[]; stored: number }> = [];
    const report = await runUkSponsorCli([FIXTURE, '--as-of', '2026-10-09', '--apply'], { databaseUrl: database, print: (lines) => printed.push({ lines, stored: rows().length }), db, now });
    expect(printed).toEqual([
      { lines: [...ukSponsorReportLines(report), 'Writing to database: db.example.test/placeholder_db'], stored: 0 },
      { lines: ['Organisations replaced: 0 · written: 3'], stored: 3 },
    ]);
    expect(printed.flatMap((p) => p.lines).join('\n')).not.toMatch(/placeholder-secret|placeholder_user|sslmode/);
    await expect(runUkSponsorCli([FIXTURE, '--as-of', '2026-10-09', '--apply'], { databaseUrl: null, print: () => undefined, db, now })).rejects.toThrow(/--apply needs a database/);
  });
});
