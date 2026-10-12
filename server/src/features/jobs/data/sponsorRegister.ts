// server/src/features/jobs/data/sponsorRegister.ts — what the two sponsor-register
// loaders share (JI-11): the row they write to RASponsorRegisterEntry, the CSV
// reader that maps columns by header name, the command line and the one writer.
//
// The table sits beside RAH1bEmployerStat (the DOL LCA loader, lca.ts) and holds
// two public registers:
//   uscis_h1b_hub        USCIS H-1B Employer Data Hub (uscis.ts): per employer
//                        and fiscal year, petitions approved and denied
//   uk_sponsor_register  UK Register of Licensed Sponsors: Workers
//                        (ukSponsors.ts): per organisation, the type and
//                        rating and the routes it is licensed for
// Every row carries where it came from (`sourceFile`, `sourceUrl`) and the
// publication date of that file (`asOf`), so a fact is never shown without its
// source and date (D3). The employer key is `normalizeCompanyName`, the key
// RACompany.nameNormalized and RAH1bEmployerStat carry.
//
// NOTHING IS WRITTEN UNLESS THE CALLER SAYS SO. An import is a dry run (read the
// file, print the report) until it is given `apply` (`--apply` on the command
// line): a command that deletes and rewrites a stored scope must not be the
// default of a tool that loads the repository's .env.
//
// A file states the whole truth of its scope (one register snapshot, or one
// fiscal year of the hub), so an import REPLACES that scope in one transaction:
// rows of the scope are deleted and the file's rows written. Importing the same
// file twice leaves one row per (source, employer, period); an employer the new
// file no longer lists is gone. Four refusals protect a stored scope:
//   - an empty file never empties it;
//   - a file dated before what is stored never replaces it;
//   - a file with fewer than half the stored rows is refused unless the caller
//     says the drop is real (`allowShrink`): a download that was cut short
//     parses as a short, valid CSV;
//   - a file whose names hold characters the encoding could not read is refused
//     until the caller names the encoding: a wrong name matches no company.
//
// The reader never guesses a cell. A line with more or fewer cells than the
// header (a line cut short, an unquoted separator inside a name) is counted and
// left out, because its cells no longer sit under their columns.
// Nothing here downloads anything. The importers are command-line tools the
// owner runs against a chosen database; they are never run in CI.

import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SponsorRegisterSource } from './sponsorSources.js';

/** One row of RASponsorRegisterEntry as an importer writes it. */
export interface SponsorRegisterRow {
  source: SponsorRegisterSource;
  /** ISO alpha-2 of the register's country. */
  country: string;
  employerNameNormalized: string;
  /** The name as the register prints it (the first spelling seen for the key). */
  employerName: string;
  /** 'FY2025' for the hub; '' for the UK register (a current list, not a yearly count). */
  period: string;
  approvals: number | null;
  denials: number | null;
  town: string | null;
  rating: string | null;
  routes: string[];
  sourceFile: string;
  sourceUrl: string;
  /** Publication date of the file (given on the command line). */
  asOf: Date;
  importedAt: Date;
}

// ── Header names ──────────────────────────────────────────────────────────

/** A header cell as compared: no byte-order mark, trimmed, single spaces, lower case. */
export function headerKey(cell: string): string {
  return cell.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The header cell (as the file writes it) for one logical column, given the
 * spellings the importer knows; null when the file has none of them.
 */
export function findColumn(header: readonly string[], spellings: readonly string[]): string | null {
  const wanted = new Set(spellings.map(headerKey));
  return header.find((cell) => wanted.has(headerKey(cell))) ?? null;
}

/** A file whose header the importer does not recognise. Nothing is written when this is thrown. */
export class RegisterHeaderError extends Error {
  readonly missing: string[];
  readonly found: string[];
  constructor(dataset: string, missing: string[], found: readonly string[], expected: string) {
    super(
      `${dataset}: the file's header is not one this importer knows. Missing column${missing.length === 1 ? '' : 's'}: ${missing.map((m) => `"${m}"`).join(', ')}. ` +
        `Columns found: ${found.length ? found.map((f) => `"${f}"`).join(', ') : '(none)'}. Expected ${expected}. Nothing was written.`,
    );
    this.name = 'RegisterHeaderError';
    this.missing = missing;
    this.found = [...found];
  }
}

// ── Reading a CSV ─────────────────────────────────────────────────────────

export type RegisterRawRow = Record<string, unknown>;

/** How a file separates its columns. */
export type RegisterDelimiter = ',' | '\t';

export interface RegisterCsvOptions {
  /**
   * Text encoding of the file (default utf8). A register saved from a
   * spreadsheet may be latin1. A file that starts with a byte-order mark is
   * read in the encoding the mark names (UTF-8 or UTF-16), whatever is asked.
   */
  encoding?: BufferEncoding;
}

/** How a file was read. */
export interface RegisterCsvInfo {
  /** Decided from the file's first line: a tab when it holds more tabs than commas, else a comma. */
  delimiter: RegisterDelimiter;
  /** The encoding the file was read with: the one its byte-order mark names, else the one asked for, else utf8. */
  encoding: BufferEncoding;
  /** Lines with more or fewer cells than the header. They are counted and never handed to `onRow`. */
  unevenRows: number;
  /** True when the last line of the file is one of them: a download that was cut short ends like this. */
  lastRowUneven: boolean;
}

/**
 * The separator of a header line: a tab when the line has more tabs than
 * commas outside quotes, else a comma. A dashboard export is often
 * tab-separated; read with the wrong separator, every column would be missing.
 */
export function delimiterOf(headerLine: string): RegisterDelimiter {
  let tabs = 0;
  let commas = 0;
  let quoted = false;
  for (const ch of headerLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '\t') tabs += 1;
    else if (!quoted && ch === ',') commas += 1;
  }
  return tabs > commas ? '\t' : ',';
}

/** The byte-order marks the reader knows (the two csv-parse itself acts on). */
const BYTE_ORDER_MARKS: ReadonlyArray<{ encoding: BufferEncoding; bytes: readonly number[] }> = [
  { encoding: 'utf8', bytes: [0xef, 0xbb, 0xbf] },
  { encoding: 'utf16le', bytes: [0xff, 0xfe] },
];
/** How much of the file is read to find its first line. */
const SNIFF_BYTES = 64 * 1024;

/** The encoding and the separator of a file, from its first bytes and its first line. */
async function sniffRegisterCsv(file: string, asked: BufferEncoding | undefined): Promise<{ encoding: BufferEncoding; delimiter: RegisterDelimiter }> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    const head = buffer.subarray(0, bytesRead);
    const mark = BYTE_ORDER_MARKS.find((m) => head.length >= m.bytes.length && m.bytes.every((byte, i) => head[i] === byte));
    const encoding = mark?.encoding ?? asked ?? 'utf8';
    const text = head.subarray(mark ? mark.bytes.length : 0).toString(encoding);
    const firstLine = text.split(/\r\n|\n|\r/).find((line) => line.trim() !== '') ?? '';
    return { encoding, delimiter: delimiterOf(firstLine) };
  } finally {
    await handle.close();
  }
}

/**
 * Stream a CSV: `onHeader` gets the first line's cells before any row (throw
 * there to refuse the file), `onRow` each record keyed by those cells. A line
 * whose number of cells is not the header's is counted and not handed on (the
 * file header says why). Returns how the file was read.
 */
export async function readRegisterCsv(file: string, options: RegisterCsvOptions, onHeader: (header: string[]) => void, onRow: (row: RegisterRawRow) => void): Promise<RegisterCsvInfo> {
  const { parse } = await import('csv-parse');
  // A file that cannot be opened fails here, before a parser exists.
  const { encoding, delimiter } = await sniffRegisterCsv(file, options.encoding);
  let sawHeader = false;
  const parser = parse({
    columns: (header: string[]) => {
      const cells = header.map((cell) => String(cell ?? ''));
      sawHeader = true;
      onHeader(cells);
      return cells;
    },
    bom: true,
    delimiter,
    skip_empty_lines: true,
    // An uneven line is not an error that ends the read: it arrives with `info.error` set and is left out below.
    relax_column_count: true,
    info: true,
    trim: true,
    encoding,
  });
  const source = createReadStream(file);
  // A file that cannot be read ends the parser with that error (a pipe alone does not pass it on).
  source.on('error', (err) => parser.destroy(err));
  source.pipe(parser);
  let unevenRows = 0;
  let lastRowUneven = false;
  for await (const item of parser) {
    const { record, info } = item as { record: RegisterRawRow; info: { error?: unknown } };
    lastRowUneven = info.error !== undefined && info.error !== null;
    if (lastRowUneven) unevenRows += 1;
    else onRow(record);
  }
  // A file with no line at all never reaches the header callback.
  if (!sawHeader) onHeader([]);
  return { delimiter, encoding, unevenRows, lastRowUneven };
}

/** The report lines every importer prints about how its file was read. */
export function readingLines(info: RegisterCsvInfo): string[] {
  return [
    `Columns separated by: ${info.delimiter === '\t' ? 'tab' : 'comma'} · read as: ${info.encoding}`,
    ...(info.unevenRows
      ? [`Lines with more or fewer cells than the header (left out): ${info.unevenRows}${info.lastRowUneven ? '. The last line of the file is one of them: the download may have been cut short.' : ''}`]
      : []),
  ];
}

/** A cell as text ('' for an empty or missing cell). */
export function cellText(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** U+FFFD in a name: the file was not in the encoding it was read with. */
export function hasUndecodedText(value: string): boolean {
  return value.includes('\uFFFD');
}

// ── Command line ──────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → that calendar day at 00:00 UTC, or null. Never a date that does not exist (2026-02-30). */
export function parseAsOf(value: string | null | undefined): Date | null {
  const m = typeof value === 'string' ? value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]) ? date : null;
}

export interface RegisterCliOptions {
  file: string;
  asOf: Date;
  /** True only with `--apply`: without it an import reads the file and writes nothing. */
  apply: boolean;
  allowShrink: boolean;
  encoding?: BufferEncoding;
}

const CLI_ENCODINGS: readonly BufferEncoding[] = ['utf8', 'latin1', 'utf16le'];
const DAY_MS = 86_400_000;

/** The last line of a report that wrote nothing. */
export const DRY_RUN_LINE = 'Dry run: nothing was written. Run again with --apply to write.';

/**
 * `<file.csv> --as-of YYYY-MM-DD [--apply] [--allow-shrink] [--encoding latin1]`
 * → options. Throws with the usage line on bad input. Without `--apply` the
 * import is a dry run (`--dry-run` says the same thing and may be given; the
 * two together contradict each other and are refused). `--as-of` is the
 * publication date of the file as its page states it; a date after today is a
 * typing mistake and is refused.
 */
export function parseRegisterArgs(argv: readonly string[], script: string, now: Date = new Date()): RegisterCliOptions {
  const usage = `Usage: npx tsx server/src/features/jobs/data/${script} <file.csv> --as-of YYYY-MM-DD [--apply] [--allow-shrink] [--encoding latin1]\nWithout --apply nothing is written: the file is read and the report printed.`;
  const valueFlags = new Set(['--as-of', '--encoding']);
  const known = new Set([...valueFlags, '--apply', '--dry-run', '--allow-shrink']);
  const unknown = argv.filter((a) => a.startsWith('--') && !known.has(a));
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(', ')}.\n${usage}`);
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : null;
  };
  const file = argv.find((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''));
  if (!file) throw new Error(usage);
  if (!/\.csv$/i.test(file)) throw new Error(`The file must be a .csv file (got "${file}"). Export or save the register as CSV first.\n${usage}`);
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error(`Give --apply (write) or --dry-run (write nothing), not both.\n${usage}`);
  const rawAsOf = value('--as-of');
  const asOf = parseAsOf(rawAsOf);
  if (!asOf) throw new Error(`--as-of is required: the publication date of the file, as YYYY-MM-DD${rawAsOf ? ` (got "${rawAsOf}")` : ''}.\n${usage}`);
  if (asOf.getTime() > now.getTime() + DAY_MS) throw new Error(`--as-of ${rawAsOf} is in the future. Give the date the file was published.`);
  const rawEncoding = value('--encoding');
  if (argv.includes('--encoding') && !CLI_ENCODINGS.includes(rawEncoding as BufferEncoding)) throw new Error(`--encoding must be one of ${CLI_ENCODINGS.join(', ')} (got "${rawEncoding ?? ''}").`);
  return {
    file,
    asOf,
    apply: argv.includes('--apply'),
    allowShrink: argv.includes('--allow-shrink'),
    ...(rawEncoding ? { encoding: rawEncoding as BufferEncoding } : {}),
  };
}

/**
 * The repository's .env files, loaded as the app loads them and never over a
 * value the shell already set. Called by an importer's `main` only: nothing is
 * loaded when a module is imported.
 */
export async function loadImporterEnv(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(here, '../../../../../.env'), override: false });
  dotenv.config({ path: path.resolve(here, '../../../../../.env.local'), override: false });
}

/**
 * Where a connection string points, for a line the owner reads before a
 * write: the host and the database name. Never the string itself, its user,
 * its password or its options. Null for a missing or unreadable string.
 */
export function databaseTarget(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^postgres(ql)?:$/.test(parsed.protocol) || !parsed.hostname) return null;
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return database ? `${parsed.hostname}/${database}` : parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * The database a write goes to, as `databaseTarget` names it. Throws when the
 * process has none configured: an importer told to write must be able to say
 * where, before it reads a line.
 */
export function requireDatabaseTarget(url: string | null | undefined): string {
  const target = databaseTarget(url);
  if (!target) throw new Error('--apply needs a database: DATABASE_URL is not set, or is not a PostgreSQL address. Nothing was written.');
  return target;
}

/** What an importer's report says, as far as the command line needs to know. */
interface RegisterCliReport {
  dryRun: boolean;
}

/**
 * One run of an importer's command line, the same for every register:
 *   - with `apply`, the database is resolved FIRST (no database, no read) and
 *     named to the owner, after the report of the file, before the first row
 *     is written;
 *   - without it the report is printed and ends with `DRY_RUN_LINE`.
 * `print` receives the lines; nothing else writes to the terminal.
 */
export async function runRegisterCli<R extends RegisterCliReport>(run: {
  options: RegisterCliOptions;
  /** The address the write would go to (never printed; `databaseTarget` names it). */
  databaseUrl: string | null | undefined;
  print: (lines: string[]) => void;
  importFile: (options: RegisterCliOptions & { beforeWrite: (read: R) => void }) => Promise<R>;
  reportLines: (report: R) => string[];
  writtenLine: (report: R) => string;
}): Promise<R> {
  const target = run.options.apply ? requireDatabaseTarget(run.databaseUrl) : null;
  const report = await run.importFile({
    ...run.options,
    beforeWrite: (read) => run.print([...run.reportLines(read), `Writing to database: ${target}`]),
  });
  run.print(report.dryRun ? [...run.reportLines(report), DRY_RUN_LINE] : [run.writtenLine(report)]);
  return report;
}

// ── The writer ────────────────────────────────────────────────────────────

/** The rows one import replaces: a whole source, or the named periods of it. */
export interface RegisterScope {
  source: SponsorRegisterSource;
  /** Only these periods ('FY2025', …). Absent = every row of the source. */
  periods?: string[];
}

type ScopeWhere = { source: string; period?: { in: string[] } };

interface RegisterDelegate {
  count(args: { where: ScopeWhere }): Promise<number>;
  findFirst(args: { where: ScopeWhere; orderBy: { asOf: 'desc' }; select: { asOf: true } }): Promise<{ asOf: Date } | null>;
  deleteMany(args: { where: ScopeWhere }): Promise<{ count: number }>;
  createMany(args: { data: SponsorRegisterRow[] }): Promise<{ count: number }>;
}

/** The part of the Prisma client the writer needs (the typed client in production, a fake in tests). */
export interface SponsorRegisterDb {
  rASponsorRegisterEntry: RegisterDelegate;
  $transaction<T>(fn: (tx: { rASponsorRegisterEntry: RegisterDelegate }) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
}

export type RegisterWriteRefusal = 'empty_file' | 'older_than_stored' | 'shrinks_stored' | 'unreadable_names';

/** An import the writer refused. Nothing was written. */
export class RegisterWriteError extends Error {
  readonly reason: RegisterWriteRefusal;
  constructor(reason: RegisterWriteRefusal, message: string) {
    super(`${message} Nothing was written.`);
    this.name = 'RegisterWriteError';
    this.reason = reason;
  }
}

/**
 * Refuse a write when names hold U+FFFD and the caller named no encoding: the
 * file was read as UTF-8 and is something else, so those names are wrong and
 * would match no company. With an encoding given the caller has decided.
 */
export function assertNamesReadable(undecodedNames: number, encoding: BufferEncoding | undefined, what: string): void {
  if (undecodedNames > 0 && !encoding) {
    throw new RegisterWriteError(
      'unreadable_names',
      `${undecodedNames} ${what} name${undecodedNames === 1 ? ' holds' : 's hold'} characters that could not be read: the file is not UTF-8. Run again with --encoding latin1 (or utf16le), check the names in the report, then apply.`,
    );
  }
}

/** Rows per INSERT (14 columns a row; far under the 65,535 parameters one statement may carry). */
export const REGISTER_WRITE_CHUNK = 1000;
/** A new file with fewer rows than this share of the stored scope is refused without `allowShrink`. */
export const REGISTER_MIN_KEPT_SHARE = 0.5;
/** One transaction for a whole register (about a hundred thousand rows in chunks). */
export const REGISTER_TRANSACTION_MS = 10 * 60_000;

const day = (d: Date) => d.toISOString().slice(0, 10);

export interface RegisterWriteResult {
  /** Rows of the scope that were stored before. */
  replaced: number;
  written: number;
}

/**
 * Replace a scope with the rows of one file, in one transaction (the header
 * says why and what is refused). All `rows` belong to `scope` and share `asOf`.
 */
export async function replaceRegisterRows(
  db: SponsorRegisterDb,
  scope: RegisterScope,
  rows: readonly SponsorRegisterRow[],
  options: { asOf: Date; allowShrink?: boolean },
): Promise<RegisterWriteResult> {
  const where: ScopeWhere = { source: scope.source, ...(scope.periods ? { period: { in: [...scope.periods] } } : {}) };
  const what = scope.periods ? `${scope.source} ${scope.periods.join(', ')}` : scope.source;
  if (rows.length === 0) throw new RegisterWriteError('empty_file', `The file holds no row for ${what}.`);
  const [stored, newest] = await Promise.all([
    db.rASponsorRegisterEntry.count({ where }),
    db.rASponsorRegisterEntry.findFirst({ where, orderBy: { asOf: 'desc' }, select: { asOf: true } }),
  ]);
  if (newest && newest.asOf.getTime() > options.asOf.getTime()) {
    throw new RegisterWriteError('older_than_stored', `The stored rows of ${what} are dated ${day(newest.asOf)}, after this file (${day(options.asOf)}).`);
  }
  if (!options.allowShrink && stored > 0 && rows.length < stored * REGISTER_MIN_KEPT_SHARE) {
    throw new RegisterWriteError(
      'shrinks_stored',
      `The file holds ${rows.length} rows for ${what} and ${stored} are stored: fewer than half. A download that was cut short looks like this. If the drop is real, run again with --allow-shrink.`,
    );
  }
  return db.$transaction(
    async (tx) => {
      const { count: replaced } = await tx.rASponsorRegisterEntry.deleteMany({ where });
      let written = 0;
      for (let i = 0; i < rows.length; i += REGISTER_WRITE_CHUNK) {
        const { count } = await tx.rASponsorRegisterEntry.createMany({ data: rows.slice(i, i + REGISTER_WRITE_CHUNK) });
        written += count;
      }
      return { replaced, written };
    },
    { maxWait: 15_000, timeout: REGISTER_TRANSACTION_MS },
  );
}
