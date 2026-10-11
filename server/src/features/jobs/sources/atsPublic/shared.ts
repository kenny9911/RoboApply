// server/src/features/jobs/sources/atsPublic/shared.ts — small pure helpers
// shared by the connectors, the ingest adapter, the admin service and the
// market hooks (WP-42).

import { parseBoolEnv, type EnvSource, type Market } from '../../../../platform/brand/index.js';
import { BOARD_TOKEN_PATTERN, PUBLIC_ATS, PUBLIC_ATS_NAMES, TENANT_LABEL_PATTERN, type BoardAts, type CareerSourceState } from './contract.js';

// -- Reading a board ---------------------------------------------------------

/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Largest response body read (characters). Greenhouse and Ashby send a whole
 * board in one answer: 5.6 MB for 728 postings, 11.0 MB for the densest seeded
 * board (673 postings, 2026-10-11), 31.2 MB for the largest board measured
 * (2,725 postings). It was 15 MB until MKT-5B; a seeded board that grew past
 * it would have been refused three times, switched off and its postings
 * archived in both markets (requests/waveM4-carryover.md, MKT-5B.1).
 *
 * The limit is what ONE answer may hold; what a run holds at once is bounded
 * by `LARGE_BOARD_POSTINGS` below: boards known to be large are read one at a
 * time, so a run never holds more than one answer of this size next to the
 * answers of small boards.
 */
export const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
/**
 * A board whose last listing held at least this many postings is "large": the
 * board sync reads large boards one at a time (ingest/boards.ts), whatever
 * ATS_BOARDS_CONCURRENCY allows for the others. At the densest answer measured
 * (16,416 characters a posting) a board under this size answers with under
 * 10 MB, which is what six answers in flight were allowed before the limit
 * was raised.
 */
export const LARGE_BOARD_POSTINGS = 600;
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

// -- Switches of single connectors (MKT-5B; JI-8, JC-8) -------------------------

/** true turns the Workable connector off (Workable does not document its widget listing for third parties; default: on). */
export const WORKABLE_KILL_SWITCH = 'ATS_WORKABLE_DISABLED';
/** true registers the 北森 connector. Default false: it needs counsel's sign-off first (MARKET_STRATEGY 1.4 tier 2, 7 item 14). */
export const BEISEN_FLAG = 'CN_ATS_BEISEN_ENABLED';
/** Hard cap of postings read per 北森 tenant and run (default 200, 1-2000). A capped listing is incomplete and closes nothing. */
export const BEISEN_MAX_POSTINGS_ENV = 'CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN';
/** Comma list of tenant board ids that are never read; their postings are archived (the takedown path). */
export const TENANT_DENYLIST_ENV = 'CN_ATS_TENANT_DENYLIST';

export function workableEnabled(env: EnvSource = process.env): boolean {
  return !parseBoolEnv(env[WORKABLE_KILL_SWITCH]);
}

export function beisenEnabled(env: EnvSource = process.env): boolean {
  return parseBoolEnv(env[BEISEN_FLAG]);
}

export function beisenMaxPostingsPerRun(env: EnvSource = process.env): number {
  return intEnv(env, BEISEN_MAX_POSTINGS_ENV, 200, 1, 2000);
}

/**
 * Systems whose boards are mainland tenant boards (北森): they feed market cn
 * and no other, are always asked as the mainland brand, at most two at a time
 * and never twice within 30 minutes, and can be taken down by the tenant
 * denylist. One list, so every one of those rules asks the same question.
 */
export const MAINLAND_ONLY_ATS: readonly string[] = ['beisen'];

export function isMainlandOnlyAts(ats: string | null | undefined): boolean {
  return typeof ats === 'string' && MAINLAND_ONLY_ATS.includes(ats);
}

/** 北森 tenants read at the same time by one board sync, whatever ATS_BOARDS_CONCURRENCY says (MARKET_STRATEGY 1.4 tier 2). */
export const BEISEN_TENANTS_IN_FLIGHT = 2;
/** The least time between two reads of the same 北森 tenant, whatever the adaptive interval says. */
export const BEISEN_TENANT_FLOOR_MS = 30 * 60 * 1000;

/** The tenant board ids of CN_ATS_TENANT_DENYLIST: lower case, each once; anything that is not a sub-domain label is ignored. */
export function tenantDenylist(env: EnvSource = process.env): string[] {
  const out = new Set<string>();
  for (const part of String(env[TENANT_DENYLIST_ENV] ?? '').split(',')) {
    const label = part.trim().toLowerCase();
    if (TENANT_LABEL_PATTERN.test(label)) out.add(label);
  }
  return [...out].sort();
}

/**
 * Is this source on the tenant denylist? The list names mainland tenant
 * boards (北森 today); a denylisted tenant is never read, and every board sync
 * archives whatever postings of it are still open, whatever state its source
 * is in (ingest/boards.ts `archiveDeniedTenants`; docs/job-search/ATS_BOARDS.md).
 */
export function tenantDenied(source: { ats: string; boardToken: string }, env: EnvSource = process.env): boolean {
  return isMainlandOnlyAts(source.ats) && tenantDenylist(env).includes(source.boardToken.trim().toLowerCase());
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
 * other than CN. A mainland tenant board (`ats` in MAINLAND_ONLY_ATS) feeds
 * cn and nothing else, whatever its `countries` say; a caller that does not
 * pass the system gets the answer by the countries alone.
 */
export function sourceFeedsMarket(source: { countries?: readonly string[] | null; ats?: string | null }, market: Market): boolean {
  if (isMainlandOnlyAts(source.ats)) return market === 'cn';
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

/** Any system of PUBLIC_ATS (the name is from when the list held four). */
export function isPublicAts(value: unknown): value is BoardAts {
  return typeof value === 'string' && (PUBLIC_ATS as readonly string[]).includes(value);
}

/** "Appier" + greenhouse → "Appier · Greenhouse" (RAJob.sourceName = company + job board). */
export function atsSourceName(companyName: string, ats: BoardAts): string {
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
