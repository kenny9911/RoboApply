// server/src/features/jobs/data/importUscis.ts — import a USCIS H-1B Employer
// Data Hub export into RASponsorRegisterEntry (source 'uscis_h1b_hub'; the
// company sponsorship route reads it; flag `h1bHistory`).
//
//   npx tsx server/src/features/jobs/data/importUscis.ts <file.csv> --as-of YYYY-MM-DD [--apply] [--allow-shrink] [--encoding latin1]
//
// WITHOUT --apply NOTHING IS WRITTEN: the file is read and the report printed
// (a dry run; `--dry-run` says the same and may be given). Read the report,
// then run the same command with --apply. With --apply the tool first prints
// the host and name of the database it writes to (DATABASE_URL of the
// repository's .env unless the shell sets one), then replaces the stored rows.
// An owner step, never run by a work-package agent and never in CI.
//
// The file is one you downloaded yourself: a yearly file from
// https://www.uscis.gov/archive/h-1b-employer-data-hub-files, or a CSV export of
// the hub (https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub).
// This script downloads nothing, and no government file belongs in the repository.
//   - --as-of is the publication date of the file as its page states it. It is
//     shown with every count ("as of {date}"), so give the real date.
//   - The columns are found by header name (uscis.ts lists the two headers this
//     importer knows), comma- or tab-separated. A file with any other header
//     stops with the names of the missing columns and nothing is written.
//   - Export the WHOLE fiscal year: each fiscal year in the file replaces the
//     stored rows of that year (one transaction). A file filtered by state, city
//     or industry would replace a year with part of it; the importer refuses a
//     file with fewer than half the stored rows unless --allow-shrink is given.
//   - A row that does not state its counts is left out, never stored as 0
//     (uscis.ts says which rows); the report counts them.
//   - Names with characters that could not be read mean the file is not UTF-8:
//     the write is refused until --encoding names the encoding.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDirectDatabaseUrl, resolvePooledDatabaseUrl } from '../../../lib/databaseUrl.js';
import {
  assertNamesReadable,
  hasUndecodedText,
  loadImporterEnv,
  parseRegisterArgs,
  readRegisterCsv,
  readingLines,
  replaceRegisterRows,
  runRegisterCli,
  type RegisterCliOptions,
  type RegisterCsvInfo,
  type SponsorRegisterDb,
} from './sponsorRegister.js';
import { USCIS_H1B_HUB_SOURCE, uscisPeriod } from './sponsorSources.js';
import { createUscisAggregator, resolveUscisLayout, uscisRegisterRows, type UscisAggregateResult, type UscisLayout, type UscisLayoutId } from './uscis.js';

export interface UscisImportOptions extends Omit<RegisterCliOptions, 'apply' | 'allowShrink'> {
  /** Write the rows. Default false: the file is read and nothing is written. */
  apply?: boolean;
  allowShrink?: boolean;
  /** Database for the write (default: the app Prisma client, loaded only when writing). */
  db?: SponsorRegisterDb;
  now?: () => Date;
  /** Called once with the report of the file, after every check and before the first row is written. */
  beforeWrite?: (report: UscisImportReport) => void | Promise<void>;
}

export interface UscisImportReport extends UscisAggregateResult {
  sourceFile: string;
  asOf: Date;
  layout: UscisLayoutId;
  /** How the file was read: its separator and encoding, and the lines left out for their number of cells. */
  reading: RegisterCsvInfo;
  /** Employer names with characters the encoding could not read (the file needs --encoding). */
  undecodedNames: number;
  /** Stored rows of the file's fiscal years that the import replaced. */
  replaced: number;
  written: number;
  dryRun: boolean;
}

/** Read the file and, only with `apply`, replace the stored rows of its fiscal years. */
export async function importUscisFile(options: UscisImportOptions): Promise<UscisImportReport> {
  const sourceFile = path.basename(options.file);
  // Filled by the header callback, which runs before any row (or throws and ends the read).
  const file: { layout: UscisLayout | null; agg: ReturnType<typeof createUscisAggregator> | null } = { layout: null, agg: null };
  let undecodedNames = 0;
  const reading = await readRegisterCsv(
    options.file,
    { encoding: options.encoding },
    (header) => {
      file.layout = resolveUscisLayout(header);
      file.agg = createUscisAggregator(file.layout);
    },
    (row) => {
      if (hasUndecodedText(String(row[file.layout!.employer] ?? ''))) undecodedNames += 1;
      file.agg!.add(row);
    },
  );
  const result = file.agg!.result();
  const read: UscisImportReport = { ...result, sourceFile, asOf: options.asOf, layout: file.layout!.id, reading, undecodedNames, replaced: 0, written: 0, dryRun: options.apply !== true };
  if (options.apply !== true) return read;
  assertNamesReadable(undecodedNames, options.encoding, 'employer');
  await options.beforeWrite?.(read);
  const db = options.db ?? ((await import('../../../lib/prisma.js')).default as unknown as SponsorRegisterDb);
  const rows = uscisRegisterRows(result.entries, { sourceFile, asOf: options.asOf, importedAt: (options.now ?? (() => new Date()))() });
  const { replaced, written } = await replaceRegisterRows(db, { source: USCIS_H1B_HUB_SOURCE, periods: result.fiscalYears.map(uscisPeriod) }, rows, { asOf: options.asOf, allowShrink: options.allowShrink });
  return { ...read, replaced, written };
}

/** Command line → options (exported for tests). Throws with a usage line on bad input. */
export function parseUscisArgs(argv: string[], now: Date = new Date()): RegisterCliOptions {
  return parseRegisterArgs(argv, 'importUscis.ts', now);
}

/** What the file holds, as the owner reads it before anything is written. */
export function uscisReportLines(report: UscisImportReport): string[] {
  const skipped = Object.entries(report.rows.skipped).map(([k, n]) => `${k} ${n}`).join(', ');
  return [
    `File: ${report.sourceFile} (${report.layout === 'yearly_file' ? 'yearly file columns' : 'hub field columns'})`,
    `As of: ${report.asOf.toISOString().slice(0, 10)}`,
    ...readingLines(report.reading),
    `Fiscal years: ${report.fiscalYears.join(', ') || 'none'}`,
    `Rows read: ${report.rows.read} · counted: ${report.rows.counted} · skipped: ${skipped}`,
    ...(report.rows.withEmptyCount ? [`Counted rows with an empty count cell, read as 0: ${report.rows.withEmptyCount}`] : []),
    `Employer-years: ${report.entries.length}`,
    ...(report.undecodedNames ? [`Employer names with unreadable characters: ${report.undecodedNames}. The file is not UTF-8: nothing can be written until --encoding names its encoding (latin1 or utf16le).`] : []),
  ];
}

/** What the command line may be handed instead of the process's own (tests: a fake database, a clock, a printer). */
export interface UscisCliDeps {
  /** The address a write goes to. It is never printed: the owner is shown its host and database name. */
  databaseUrl: string | null | undefined;
  print: (lines: string[]) => void;
  db?: SponsorRegisterDb;
  now?: () => Date;
}

/** One run of the command line: arguments in, the lines the owner reads out (sponsorRegister.ts `runRegisterCli`). */
export async function runUscisCli(argv: string[], deps: UscisCliDeps): Promise<UscisImportReport> {
  return runRegisterCli<UscisImportReport>({
    options: parseUscisArgs(argv, deps.now?.()),
    databaseUrl: deps.databaseUrl,
    print: deps.print,
    importFile: (options) => importUscisFile({ ...options, db: deps.db, now: deps.now }),
    reportLines: uscisReportLines,
    writtenLine: (report) => `Rows replaced: ${report.replaced} · written: ${report.written}`,
  });
}

async function main(): Promise<void> {
  await loadImporterEnv();
  await runUscisCli(process.argv.slice(2), {
    // The address lib/prisma.ts opens its pool on (pooled, else direct).
    databaseUrl: resolvePooledDatabaseUrl() || resolveDirectDatabaseUrl(),
    // eslint-disable-next-line no-console
    print: (lines) => console.log(lines.join('\n')),
  });
}

// Run only as a script (`npx tsx …/importUscis.ts`), never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
