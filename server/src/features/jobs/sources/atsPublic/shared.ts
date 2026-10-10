// server/src/features/jobs/sources/atsPublic/shared.ts — small pure helpers
// shared by the connectors, the ingest adapter, the admin service and the
// market hooks (WP-42).

import { PUBLIC_ATS, PUBLIC_ATS_NAMES, type PublicAts } from './contract.js';

/** How often one board is read (the standing ingest query runs every 30 min and picks due boards). */
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Boards read per adapter fetch (one fetch = one leased run of the standing query). */
export const BOARDS_PER_FETCH = 3;
/** Postings handed to the normalizer per board and run. */
export const MAX_POSTINGS_PER_BOARD = 500;
/**
 * Listing entries read per board and run for a mainland (market cn) source.
 * A global board lists a few mainland postings among thousands, so its
 * listing is paged to the end (up to this many entries) and filtered by
 * location BEFORE the per-run input cap; otherwise those postings could sit
 * outside the cap on every run and never be stored.
 */
export const MAX_LISTED_PER_BOARD_CN = 3000;
/** A board that still has postings we have not stored is read again after this long instead of SYNC_INTERVAL_MS. */
export const BACKLOG_INTERVAL_MS = 30 * 60 * 1000;
/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Largest response body read (bytes). */
export const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

export function isPublicAts(value: unknown): value is PublicAts {
  return typeof value === 'string' && (PUBLIC_ATS as readonly string[]).includes(value);
}

/** "Appier" + greenhouse → "Appier · Greenhouse" (RAJob.sourceName = company + job board). */
export function atsSourceName(companyName: string, ats: PublicAts): string {
  const company = companyName.trim();
  const board = PUBLIC_ATS_NAMES[ats];
  return company ? `${company} · ${board}` : board;
}

/**
 * RAJob.externalId for a posting: `<boardToken>:<postingId>`. RAJob is unique
 * on (externalId, sourceBoard) and sourceBoard is the ATS name, so the board
 * token keeps two companies on the same ATS apart and lets the sync find a
 * board's open rows by prefix.
 */
export function externalIdFor(boardToken: string, postingId: string | number): string {
  return `${boardToken}:${String(postingId)}`;
}

export function externalIdPrefix(boardToken: string): string {
  return `${boardToken}:`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Greenhouse sends `content` HTML-escaped ("&lt;p&gt;"); decode one level. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key]!;
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
