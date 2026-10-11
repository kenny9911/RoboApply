// server/src/features/jobs/data/importUkSponsors.ts — import the UK "Register
// of licensed sponsors: workers" into RASponsorRegisterEntry (source
// 'uk_sponsor_register'; the company sponsorship route reads it; flag
// `h1bHistory`).
//
//   npx tsx server/src/features/jobs/data/importUkSponsors.ts <file.csv> --as-of YYYY-MM-DD [--apply] [--allow-shrink] [--encoding latin1]
//
// WITHOUT --apply NOTHING IS WRITTEN: the file is read and the report printed
// (a dry run; `--dry-run` says the same and may be given). Read the report,
// then run the same command with --apply. With --apply the tool first prints
// the host and name of the database it writes to (DATABASE_URL of the
// repository's .env unless the shell sets one), then replaces the stored
// snapshot. An owner step, never run by a work-package agent and never in CI.
//
// The file is the CSV you downloaded yourself from
// https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
// ("Register of Worker and Temporary Worker licensed sponsors"). This script
// downloads nothing, and no government file belongs in the repository.
//   - --as-of is the register's publication date: the date in the file name
//     and the page's "Last updated". It is shown with the fact ("as of {date}").
//   - The columns are found by header name (ukSponsors.ts lists them), comma-
//     or tab-separated. A file with another header stops with the names of the
//     missing columns and nothing is written.
//   - The register is a current list, so each import REPLACES the stored
//     snapshot in one transaction: an organisation that is no longer on the
//     register is no longer shown as a licensed sponsor. A file dated before the
//     stored snapshot is refused, and so is a file with fewer than half the
//     stored organisations (a download that was cut short) unless
//     --allow-shrink is given.
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
import { UK_SPONSOR_REGISTER_SOURCE } from './sponsorSources.js';
import { createUkSponsorAggregator, resolveUkSponsorColumns, ukSponsorRegisterRows, type UkSponsorAggregateResult, type UkSponsorColumns } from './ukSponsors.js';

export interface UkSponsorImportOptions extends Omit<RegisterCliOptions, 'apply' | 'allowShrink'> {
  /** Write the rows. Default false: the file is read and nothing is written. */
  apply?: boolean;
  allowShrink?: boolean;
  /** Database for the write (default: the app Prisma client, loaded only when writing). */
  db?: SponsorRegisterDb;
  now?: () => Date;
  /** Called once with the report of the file, after every check and before the first row is written. */
  beforeWrite?: (report: UkSponsorImportReport) => void | Promise<void>;
}

export interface UkSponsorImportReport extends UkSponsorAggregateResult {
  sourceFile: string;
  asOf: Date;
  /** How the file was read: its separator and encoding, and the lines left out for their number of cells. */
  reading: RegisterCsvInfo;
  /** Organisation names with characters the encoding could not read (the file needs --encoding). */
  undecodedNames: number;
  /** Stored organisations of the previous snapshot that the import replaced. */
  replaced: number;
  written: number;
  dryRun: boolean;
}

/** Read the file and, only with `apply`, replace the stored snapshot of the register. */
export async function importUkSponsorsFile(options: UkSponsorImportOptions): Promise<UkSponsorImportReport> {
  const sourceFile = path.basename(options.file);
  // Filled by the header callback, which runs before any line (or throws and ends the read).
  const file: { columns: UkSponsorColumns | null; agg: ReturnType<typeof createUkSponsorAggregator> | null } = { columns: null, agg: null };
  let undecodedNames = 0;
  const reading = await readRegisterCsv(
    options.file,
    { encoding: options.encoding },
    (header) => {
      file.columns = resolveUkSponsorColumns(header);
      file.agg = createUkSponsorAggregator(file.columns);
    },
    (row) => {
      if (hasUndecodedText(String(row[file.columns!.organisation] ?? ''))) undecodedNames += 1;
      file.agg!.add(row);
    },
  );
  const result = file.agg!.result();
  const read: UkSponsorImportReport = { ...result, sourceFile, asOf: options.asOf, reading, undecodedNames, replaced: 0, written: 0, dryRun: options.apply !== true };
  if (options.apply !== true) return read;
  assertNamesReadable(undecodedNames, options.encoding, 'organisation');
  await options.beforeWrite?.(read);
  const db = options.db ?? ((await import('../../../lib/prisma.js')).default as unknown as SponsorRegisterDb);
  const rows = ukSponsorRegisterRows(result.entries, { sourceFile, asOf: options.asOf, importedAt: (options.now ?? (() => new Date()))() });
  const { replaced, written } = await replaceRegisterRows(db, { source: UK_SPONSOR_REGISTER_SOURCE }, rows, { asOf: options.asOf, allowShrink: options.allowShrink });
  return { ...read, replaced, written };
}

/** Command line → options (exported for tests). Throws with a usage line on bad input. */
export function parseUkSponsorArgs(argv: string[], now: Date = new Date()): RegisterCliOptions {
  return parseRegisterArgs(argv, 'importUkSponsors.ts', now);
}

/** What the file holds, as the owner reads it before anything is written. */
export function ukSponsorReportLines(report: UkSponsorImportReport): string[] {
  return [
    `File: ${report.sourceFile}`,
    `As of: ${report.asOf.toISOString().slice(0, 10)}`,
    ...readingLines(report.reading),
    `Lines read: ${report.rows.read} · counted: ${report.rows.counted} · skipped: no_organisation ${report.rows.skipped.no_organisation}`,
    `Organisations: ${report.entries.length} (${report.severalTowns} with more than one town, stored without a town)`,
    ...(report.undecodedNames ? [`Organisation names with unreadable characters: ${report.undecodedNames}. The file is not UTF-8: nothing can be written until --encoding names its encoding (latin1 or utf16le).`] : []),
  ];
}

/** What the command line may be handed instead of the process's own (tests: a fake database, a clock, a printer). */
export interface UkSponsorCliDeps {
  /** The address a write goes to. It is never printed: the owner is shown its host and database name. */
  databaseUrl: string | null | undefined;
  print: (lines: string[]) => void;
  db?: SponsorRegisterDb;
  now?: () => Date;
}

/** One run of the command line: arguments in, the lines the owner reads out (sponsorRegister.ts `runRegisterCli`). */
export async function runUkSponsorCli(argv: string[], deps: UkSponsorCliDeps): Promise<UkSponsorImportReport> {
  return runRegisterCli<UkSponsorImportReport>({
    options: parseUkSponsorArgs(argv, deps.now?.()),
    databaseUrl: deps.databaseUrl,
    print: deps.print,
    importFile: (options) => importUkSponsorsFile({ ...options, db: deps.db, now: deps.now }),
    reportLines: ukSponsorReportLines,
    writtenLine: (report) => `Organisations replaced: ${report.replaced} · written: ${report.written}`,
  });
}

async function main(): Promise<void> {
  await loadImporterEnv();
  await runUkSponsorCli(process.argv.slice(2), {
    // The address lib/prisma.ts opens its pool on (pooled, else direct).
    databaseUrl: resolvePooledDatabaseUrl() || resolveDirectDatabaseUrl(),
    // eslint-disable-next-line no-console
    print: (lines) => console.log(lines.join('\n')),
  });
}

// Run only as a script (`npx tsx …/importUkSponsors.ts`), never when imported.
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
