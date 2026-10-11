// server/src/features/jobs/sources/atsPublic/shared.ts — small pure helpers
// shared by the connectors, the ingest adapter, the admin service and the
// market hooks (WP-42).

import type { EnvSource, Market } from '../../../../platform/brand/index.js';
import { BOARD_TOKEN_PATTERN, PUBLIC_ATS, PUBLIC_ATS_NAMES, type CareerSourceState, type PublicAts } from './contract.js';

// -- Reading a board ---------------------------------------------------------

/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Largest response body read (characters). Greenhouse sends a whole board in one answer (5.6 MB for 728 postings). */
export const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
/**
 * Paging safety stops. A listing that reaches one is reported incomplete, so
 * nothing is closed for being beyond it. They are far above any board we have
 * measured (the largest: 1,322 postings); they only stop a listing that never
 * ends.
 */
export const LEVER_MAX_PAGES = 100;
export const SMARTRECRUITERS_MAX_PAGES = 200;

// -- The board sync's schedule (ingest/boards.ts; MARKET_STRATEGY 1.2 tier 0) --

/** A board whose postings changed in the last 48 hours is read every 2 hours. */
export const SYNC_HOT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const SYNC_HOT_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** One that changed in the last 14 days, every 12 hours. */
export const SYNC_WARM_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const SYNC_WARM_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Any other board, every 24 hours. */
export const SYNC_COLD_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A failed read is tried again after this long (a transient failure waits this long times the attempt number, at most 6). */
export const SYNC_RETRY_MS = 60 * 60 * 1000;
export const SYNC_RETRY_MAX_STEPS = 6;
/** A board that answers 401 or 403 is tried again after this long (6 h): three refusals in a row then span at least 12 hours. */
export const SYNC_REFUSED_RETRY_MS = SYNC_RETRY_MS * SYNC_RETRY_MAX_STEPS;
/** This many hard failures in a row switch a source off. */
export const SYNC_MAX_HARD_FAILURES = 3;
/** The open postings of a source switched off by failures are archived this long after it was switched off. */
export const DISABLED_ARCHIVE_AFTER_MS = 48 * 60 * 60 * 1000;

function intEnv(env: EnvSource, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return fallback;
  return Math.min(max, Math.max(min, Number.parseInt(raw, 10)));
}

/** Boards read in flight by the board sync: ATS_BOARDS_CONCURRENCY, clamped to 4-8 (default 6). */
export function boardsConcurrency(env: EnvSource = process.env): number {
  return intEnv(env, 'ATS_BOARDS_CONCURRENCY', 6, 4, 8);
}

/** SmartRecruiters posting texts read per board and run: ATS_SR_DETAILS_PER_RUN (default 100, 1-1000). */
export function smartRecruitersDetailsPerRun(env: EnvSource = process.env): number {
  return intEnv(env, 'ATS_SR_DETAILS_PER_RUN', 100, 1, 1000);
}

/** Candidate sources validated per board-sync run: ATS_DISCOVERY_VALIDATIONS_PER_RUN (default 20, 0-200). */
export function discoveryValidationsPerRun(env: EnvSource = process.env): number {
  return intEnv(env, 'ATS_DISCOVERY_VALIDATIONS_PER_RUN', 20, 0, 200);
}

// -- Countries and markets -----------------------------------------------------

/** Upper case, ISO alpha-2 shaped, each once, sorted. Anything else is dropped. */
export function normalizeCountries(list: readonly unknown[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const v of list ?? []) {
    const code = typeof v === 'string' ? v.trim().toUpperCase() : '';
    if (/^[A-Z]{2}$/.test(code)) out.add(code);
  }
  return [...out].sort();
}

/** Is the board read for this country? An empty list means every country. */
export function sourceCoversCountry(source: { countries?: readonly string[] | null }, iso: string): boolean {
  const countries = normalizeCountries(source.countries);
  return countries.length === 0 || countries.includes(iso.trim().toUpperCase());
}

/**
 * Does the board feed this market? cn (GoApply): `countries` is empty or
 * contains CN. intl (RoboApply): `countries` is empty or contains any code
 * other than CN.
 */
export function sourceFeedsMarket(source: { countries?: readonly string[] | null }, market: Market): boolean {
  const countries = normalizeCountries(source.countries);
  if (countries.length === 0) return true;
  return market === 'cn' ? countries.includes('CN') : countries.some((c) => c !== 'CN');
}

/** Two country lists merged: an empty list means every country, so it wins; otherwise the union. */
export function mergeCountries(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): string[] {
  const left = normalizeCountries(a);
  const right = normalizeCountries(b);
  if (left.length === 0 || right.length === 0) return [];
  return normalizeCountries([...left, ...right]);
}

export function isBoardToken(value: unknown): value is string {
  return typeof value === 'string' && BOARD_TOKEN_PATTERN.test(value);
}

/** `lastError` of a candidate whose list-only read did not match: 'validation:<reason>'. */
export const VALIDATION_ERROR_PREFIX = 'validation:';

/** The state the consoles show (contract.ts CareerSourceState). */
export function careerSourceState(row: { enabled: boolean; origin?: string | null; disabledAt?: Date | string | null; lastSyncedAt?: Date | string | null; lastError?: string | null }): CareerSourceState {
  if (row.enabled) return 'enabled';
  const found = row.origin === 'discovered' || row.origin === 'import';
  // A candidate was never switched on: it waits for its first list-only read, or that read did not match.
  if (found && !row.disabledAt && (!row.lastSyncedAt || (row.lastError ?? '').startsWith(VALIDATION_ERROR_PREFIX))) return 'candidate';
  return 'disabled';
}

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
