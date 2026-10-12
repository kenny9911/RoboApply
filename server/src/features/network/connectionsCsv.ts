// server/src/features/network/connectionsCsv.ts
//
// Parser for the user's own LinkedIn data export, `Connections.csv`
// (Settings → Data privacy → Get a copy of your data → Connections).
//
// The export starts with a few "Notes:" lines, then the header row:
//   First Name,Last Name,URL,Email Address,Company,Position,Connected On
// and one row per connection. "Connected On" is "15 Mar 2021" in current
// exports and "03/15/2021" in older ones.
//
// H16 (honesty review): we keep ONLY name, company, position and the
// connected-on date. The email column (and the profile URL) are discarded
// HERE, at parse time: the parsed row type has no field for them, and their
// values are never copied out of the raw cells. Nothing downstream can store
// what this function does not return.

import { LINKEDIN_IMPORT_MAX_ROWS } from './contract.js';

/** One connection as kept. There is deliberately no email or URL field. */
export interface ParsedConnection {
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  position: string | null;
  connectedOn: Date | null;
}

export interface ParsedConnections {
  /** Data rows after the header (blank lines excluded). */
  rowCount: number;
  /** Rows with a name and a company, de-duplicated within the file. */
  connections: ParsedConnection[];
  /** Rows dropped for a missing name or company. */
  skipped: number;
}

export class ConnectionsCsvError extends Error {
  constructor(message = 'This file is not a LinkedIn Connections export.') {
    super(message);
    this.name = 'ConnectionsCsvError';
  }
}

/** RFC 4180 tokenizer: quoted fields, doubled quotes, CR/LF/CRLF line ends, newlines inside quotes. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Header aliases (LinkedIn has used both spellings). Email and URL are recognised only so they can be skipped. */
const HEADERS = {
  firstName: ['first name', 'firstname'],
  lastName: ['last name', 'lastname'],
  company: ['company', 'company name'],
  position: ['position', 'title', 'job title'],
  connectedOn: ['connected on', 'connected'],
} as const;

type Columns = { [K in keyof typeof HEADERS]: number };

function findHeader(rows: string[][]): { index: number; columns: Columns } | null {
  const limit = Math.min(rows.length, 25);
  for (let r = 0; r < limit; r++) {
    const cells = rows[r]!.map(norm);
    const at = (aliases: readonly string[]) => cells.findIndex((c) => aliases.includes(c));
    const columns: Columns = {
      firstName: at(HEADERS.firstName),
      lastName: at(HEADERS.lastName),
      company: at(HEADERS.company),
      position: at(HEADERS.position),
      connectedOn: at(HEADERS.connectedOn),
    };
    if (columns.firstName >= 0 && columns.lastName >= 0 && columns.company >= 0) return { index: r, columns };
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function utcDate(y: number, m: number, d: number): Date | null {
  if (!Number.isInteger(y) || y < 2003 || y > 2100 || m < 0 || m > 11 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCMonth() === m ? date : null;
}

/** "15 Mar 2021" | "Mar 15, 2021" | "03/15/2021" | "2021-03-15" → UTC midnight; anything else → null (never guessed). */
export function parseConnectedOn(value: string | undefined): Date | null {
  const s = (value ?? '').trim();
  if (!s) return null;
  let m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    return month === undefined ? null : utcDate(Number(m[3]), month, Number(m[1]));
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    return month === undefined ? null : utcDate(Number(m[3]), month, Number(m[2]));
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return utcDate(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return utcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

const clip = (s: string | undefined, max: number) => (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A cell that is itself an email address is not a name, company or position (we never keep one). */
const looksLikeEmail = (s: string) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(s);

/**
 * Parse a LinkedIn Connections export. Throws ConnectionsCsvError when the
 * header row is missing. De-duplicates people within the file by name +
 * company (case-insensitive).
 */
export function parseLinkedInConnections(text: string, options: { maxRows?: number } = {}): ParsedConnections {
  const rows = parseCsvRows(text);
  const header = findHeader(rows);
  if (!header) throw new ConnectionsCsvError();
  const { columns } = header;
  const maxRows = options.maxRows ?? LINKEDIN_IMPORT_MAX_ROWS;
  const seen = new Set<string>();
  const connections: ParsedConnection[] = [];
  let rowCount = 0;
  let skipped = 0;
  for (let r = header.index + 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.every((c) => !c.trim())) continue;
    rowCount += 1;
    if (rowCount > maxRows) {
      skipped += 1;
      continue;
    }
    const cell = (i: number, max: number) => {
      const v = i >= 0 ? clip(cells[i], max) : '';
      return looksLikeEmail(v) ? '' : v;
    };
    const firstName = cell(columns.firstName, 80);
    const lastName = cell(columns.lastName, 80);
    const fullName = `${firstName} ${lastName}`.trim();
    const company = cell(columns.company, 160);
    if (!fullName || !company) {
      skipped += 1;
      continue;
    }
    const key = `${norm(fullName)}|${norm(company.replace(/[^\p{L}\p{N}]+/gu, ' '))}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    connections.push({
      firstName,
      lastName,
      fullName,
      company,
      position: cell(columns.position, 160) || null,
      connectedOn: columns.connectedOn >= 0 ? parseConnectedOn(cells[columns.connectedOn]) : null,
    });
  }
  return { rowCount, connections, skipped };
}
