// server/src/features/jobs/data/importLca.ts — import a US DOL LCA disclosure
// file into RAH1bEmployerStat (the H-1B route reads it; flag `h1bHistory`).
//
//   npx tsx server/src/features/jobs/data/importLca.ts <file.csv|file.xlsx> [--fiscal-year 2026] [--min-wage-sample 20] [--dry-run]
//
// The file is one you downloaded yourself from the DOL OFLC performance-data
// page (https://www.dol.gov/agencies/eta/foreign-labor/performance, "LCA
// Programs (H-1B, H-1B1, E-3)"). This script downloads nothing.
//   - .csv is read as a stream (use it for a full fiscal year: export the
//     sheet to CSV first); .xlsx is read whole into memory (fine for one
//     quarter, heavy for a year).
//   - The fiscal year comes from --fiscal-year, else the file name (FY2026),
//     else each row's DECISION_DATE.
//   - Each DOL file is cumulative for its fiscal year: importing a newer file
//     of the same year replaces that year's rows (upsert by employer + year).
//   - --dry-run parses and prints the report without touching the database.
// Without --dry-run it writes to the database in DATABASE_URL: an owner step
// (use the clone's database, never production by accident).

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLcaAggregator, fiscalYearFromFileName, upsertH1bStats, type H1bStatDb, type LcaAggregateResult, type LcaRawRow } from './lca.js';

export interface LcaImportOptions {
  file: string;
  fiscalYear?: number | null;
  minWageSample?: number;
  dryRun?: boolean;
  /** Database for the upsert (default: the app Prisma client, loaded only when writing). */
  db?: H1bStatDb;
  now?: () => Date;
}

export interface LcaImportReport extends LcaAggregateResult {
  sourceFile: string;
  /** The fiscal year applied to every row, or null when rows decided by their own date. */
  fiscalYear: number | null;
  written: number;
  dryRun: boolean;
}

async function readCsv(file: string, onRow: (row: LcaRawRow) => void): Promise<void> {
  const { parse } = await import('csv-parse');
  const parser = createReadStream(file).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true }));
  for await (const row of parser) onRow(row as LcaRawRow);
}

async function readXlsx(file: string, onRow: (row: LcaRawRow) => void): Promise<void> {
  const XLSX = await import('xlsx');
  const book = XLSX.readFile(file, { cellDates: true, dense: true });
  const sheet = book.Sheets[book.SheetNames[0]!];
  if (!sheet) return;
  for (const row of XLSX.utils.sheet_to_json<LcaRawRow>(sheet, { defval: null })) onRow(row);
}

/** Parse the file and (unless `dryRun`) upsert the statistics. */
export async function importLcaFile(options: LcaImportOptions): Promise<LcaImportReport> {
  const sourceFile = path.basename(options.file);
  const fiscalYear = options.fiscalYear ?? fiscalYearFromFileName(sourceFile);
  const agg = createLcaAggregator({ fiscalYear, minWageSample: options.minWageSample });
  const ext = path.extname(options.file).toLowerCase();
  if (ext === '.csv') await readCsv(options.file, (r) => agg.add(r));
  else if (ext === '.xlsx' || ext === '.xls') await readXlsx(options.file, (r) => agg.add(r));
  else throw new Error(`Unsupported file type "${ext}". Use the DOL .xlsx file or a .csv export of it.`);
  const result = agg.result();
  let written = 0;
  if (!options.dryRun) {
    const db = options.db ?? ((await import('../../../lib/prisma.js')).default as unknown as H1bStatDb);
    written = await upsertH1bStats(db, result.stats, { sourceFile, importedAt: (options.now ?? (() => new Date()))() });
  }
  return { ...result, sourceFile, fiscalYear, written, dryRun: options.dryRun === true };
}

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : null;
}

/** Command line → options (exported for tests). Throws with a usage line on bad input. */
export function parseLcaArgs(argv: string[]): Omit<LcaImportOptions, 'db' | 'now'> {
  const valueFlags = new Set(['--fiscal-year', '--min-wage-sample']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1] ?? ''));
  const file = positional[0];
  if (!file) throw new Error('Usage: npx tsx server/src/features/jobs/data/importLca.ts <file.csv|file.xlsx> [--fiscal-year 2026] [--min-wage-sample 20] [--dry-run]');
  const fy = arg(argv, 'fiscal-year');
  const min = arg(argv, 'min-wage-sample');
  const fiscalYear = fy ? Number(fy) : null;
  if (fy && (!Number.isInteger(fiscalYear) || fiscalYear! < 2000 || fiscalYear! > 2100)) throw new Error(`--fiscal-year must be a year such as 2026 (got "${fy}")`);
  const minWageSample = min ? Number(min) : undefined;
  if (min && (!Number.isInteger(minWageSample) || minWageSample! < 1)) throw new Error(`--min-wage-sample must be a whole number of 1 or more (got "${min}")`);
  return { file, fiscalYear, minWageSample, dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(here, '../../../../../.env'), override: false });
  dotenv.config({ path: path.resolve(here, '../../../../../.env.local'), override: false });
  const options = parseLcaArgs(process.argv.slice(2));
  const report = await importLcaFile(options);
  const skipped = Object.entries(report.rows.skipped).map(([k, n]) => `${k} ${n}`).join(', ');
  // eslint-disable-next-line no-console
  console.log(
    [
      `File: ${report.sourceFile}`,
      `Fiscal year: ${report.fiscalYear ?? 'from each row’s decision date'}`,
      `Rows read: ${report.rows.read} · counted: ${report.rows.counted} · skipped: ${skipped}`,
      `Employer-years: ${report.stats.length}`,
      report.dryRun ? 'Dry run: nothing was written.' : `Rows written: ${report.written}`,
    ].join('\n'),
  );
}

// Run only as a script (`npx tsx …/importLca.ts`), never when imported.
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
