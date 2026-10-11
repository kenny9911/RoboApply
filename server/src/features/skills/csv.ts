// server/src/features/skills/csv.ts
//
// Reading and writing the CSV files of the review tooling (cli.ts). RFC 4180:
// a field with a comma, a quote or a line break is quoted, and a quote inside
// it is doubled. A tab-separated file is read with `delimiter: '\t'`. No
// dependency: these files are small and reviewed by hand in a spreadsheet.

/** Text → rows of fields. A leading byte-order mark and blank lines are dropped. */
export function parseCsv(text: string, options: { delimiter?: string } = {}): string[][] {
  const delimiter = options.delimiter ?? ',';
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === delimiter) endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (field !== '' || row.length || wasQuoted) endRow();
  return rows;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A cell a spreadsheet would run as a formula: it starts with "=", "+", "-",
 * "@", a tab or a carriage return. The files hold skill strings taken from
 * postings anyone can publish, and they are made to be opened in a
 * spreadsheet, so such a cell is written with a single quote in front (the
 * spreadsheet then shows it as text) and `parseTable` takes that one quote off
 * again. A cell that already starts with quotes and then such a character gets
 * one more, so reading back always gives the cell that was written.
 */
const FORMULA_START = /^'*[=+\-@\t\r]/;
const GUARDED = /^'+[=+\-@\t\r]/;

/** The text of a cell as it is written: never something a spreadsheet runs. */
export function guardCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** The cell that `guardCell` was given. */
export function unguardCell(value: string): string {
  return GUARDED.test(value) ? value.slice(1) : value;
}

/** Rows → text, one line per row, "\n" line ends. A number is written as it is; a string cell is guarded (`guardCell`). */
export function formatCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : quote(guardCell(v)));
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export interface Table {
  header: string[];
  rows: Array<Record<string, string>>;
}

/**
 * A file with a header row → one object per row, keyed by the header
 * (trimmed). A missing field reads ''. The quote `formatCsv` put in front of a
 * formula-like cell is taken off (`unguardCell`).
 */
export function parseTable(text: string, options: { delimiter?: string } = {}): Table {
  const [head, ...body] = parseCsv(text, options);
  const header = (head ?? []).map((h) => unguardCell(h).trim());
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, unguardCell(r[i] ?? '').trim()]))) };
}

/** The delimiter of a file by its name: a tab for .tsv and .txt, else a comma. */
export function delimiterOf(file: string): string {
  return /\.(tsv|txt)$/i.test(file) ? '\t' : ',';
}

/** Several values in one cell are separated by " | " (a name never holds a pipe). */
export const LIST_SEPARATOR = ' | ';

export function joinList(values: readonly string[]): string {
  return values.join(LIST_SEPARATOR);
}

export function splitList(cell: string): string[] {
  return cell
    .split(/\s*\|\s*|\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}
