// server/src/features/jobs/sources/atsPublic/sync.ts — reading one career source
// (WP-42; MARKET_STRATEGY JI-4, JC-4). Used by the board sync (ingest/boards.ts)
// and, for its row type, by the admin service.
//
// `readBoard` reads the board ONCE through its connector, routes every posting
// to the market of its own location (./market.ts) and works out which of our
// open rows of that board the board no longer lists. It writes nothing: no
// job (normalize -> upsert -> dedupe -> enrich is ingest's job) and no stamp
// on the source row (ingest/boards.ts stamps it once it knows what the run
// added or closed; the rules are ./schedule.ts).
//
// A board that cannot be read closes nothing; a board whose listing was cut
// short by a paging safety stop closes nothing either (we cannot tell "gone"
// from "not read").
//
// Our open rows of the board (externalId + lastSeenAt, both markets, the
// `#cn` copies included) are loaded once before the read: SmartRecruiters uses
// them to ask only for the posting texts we do not have yet, and the closure
// check compares the listing against them.

import type prisma from '../../../../lib/prisma.js';
import type { Market } from '../../../../platform/brand/index.js';
import { connectorFor, type BoardRead, type BoardSource, type ConnectorDeps } from './connectors.js';
import { BoardFetchError } from './http.js';
import { routeBoardRead, storedIdsOf, type RoutedBoard } from './market.js';
import { externalIdPrefix, isPublicAts, normalizeCountries } from './shared.js';

/** Typed delegates this module reads and writes (no untyped client casts). */
export type CareerSourceDb = Pick<typeof prisma, 'rACareerSiteSource' | 'rAJob'>;

/** A `RACareerSiteSource` row as this area reads it. */
export interface CareerSourceRow {
  id: string;
  /** The console that added the board. Display only: it decides nothing. */
  market: string;
  ats: string;
  boardToken: string;
  companyName: string;
  companyId: string | null;
  /** A weak hint for an ambiguous city. Never a filter. */
  countryCode: string | null;
  enabled: boolean;
  lastSyncedAt: Date | null;
  lastJobCount: number | null;
  lastError: string | null;
  origin: string;
  discoveredFrom: string | null;
  /** ISO codes the board is read for; empty = every country the brands serve. */
  countries: string[];
  failCount: number;
  lastChangeAt: Date | null;
  nextSyncAt: Date | null;
  disabledAt: Date | null;
}

/** The columns of a source row, in the order raw statements return them. */
export const CAREER_SOURCE_COLUMNS = [
  'id',
  'market',
  'ats',
  'boardToken',
  'companyName',
  'companyId',
  'countryCode',
  'enabled',
  'lastSyncedAt',
  'lastJobCount',
  'lastError',
  'origin',
  'discoveredFrom',
  'countries',
  'failCount',
  'lastChangeAt',
  'nextSyncAt',
  'disabledAt',
] as const;

const asDate = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

/** A row from the database (typed delegate or raw statement), with the defaults of a row written before the market wave. */
export function toCareerSourceRow(raw: Record<string, unknown>): CareerSourceRow {
  const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    id: String(raw.id),
    market: raw.market === 'cn' ? 'cn' : 'intl',
    ats: String(raw.ats ?? ''),
    boardToken: String(raw.boardToken ?? ''),
    companyName: String(raw.companyName ?? ''),
    companyId: text(raw.companyId),
    countryCode: text(raw.countryCode),
    enabled: raw.enabled === true,
    lastSyncedAt: asDate(raw.lastSyncedAt),
    lastJobCount: typeof raw.lastJobCount === 'number' ? raw.lastJobCount : null,
    lastError: text(raw.lastError),
    origin: text(raw.origin) ?? 'admin',
    discoveredFrom: text(raw.discoveredFrom),
    countries: normalizeCountries(Array.isArray(raw.countries) ? raw.countries : []),
    failCount: typeof raw.failCount === 'number' && raw.failCount > 0 ? Math.floor(raw.failCount) : 0,
    lastChangeAt: asDate(raw.lastChangeAt),
    nextSyncAt: asDate(raw.nextSyncAt),
    disabledAt: asDate(raw.disabledAt),
  };
}

/** What a connector needs of a source row. */
export function asBoardSource(source: Pick<CareerSourceRow, 'ats' | 'boardToken' | 'companyName' | 'countryCode' | 'countries'>): BoardSource | null {
  if (!isPublicAts(source.ats)) return null;
  return { ats: source.ats, boardToken: source.boardToken, companyName: source.companyName, countryCode: source.countryCode, countries: source.countries };
}

export interface BoardReadOutcome {
  source: CareerSourceRow;
  read: BoardRead | null;
  /** The read's postings per market and the externalIds the listing maps to (null when the board could not be read). */
  routed: RoutedBoard | null;
  /** externalIds of our open public rows that a complete listing no longer holds. */
  closedExternalIds: string[];
  calls: number;
  error: string | null;
}

/** Max open rows compared per board (more than any board we read can list). */
const OPEN_ROWS_LIMIT = 20_000;

export function boardErrorText(err: unknown): string {
  if (err instanceof BoardFetchError) return err.message;
  return err instanceof Error ? `unexpected:${err.message.slice(0, 160)}` : 'unexpected';
}

/**
 * Our open public rows of this board, in both markets: externalId ->
 * RAJob.lastSeenAt (when ingest last saved it).
 */
export async function loadOpenBoardRows(db: CareerSourceDb, source: Pick<CareerSourceRow, 'ats' | 'boardToken'>): Promise<Map<string, Date | null>> {
  const open = await db.rAJob.findMany({
    where: { sourceBoard: source.ats, externalId: { startsWith: externalIdPrefix(source.boardToken) }, archivedAt: null, visibility: 'public' },
    select: { externalId: true, lastSeenAt: true },
    take: OPEN_ROWS_LIMIT,
  });
  return new Map(open.map((r) => [r.externalId, r.lastSeenAt instanceof Date ? r.lastSeenAt : null]));
}

/** Open rows that are not in the listing. */
export function closedExternalIds(open: ReadonlyMap<string, unknown>, listedIds: readonly string[]): string[] {
  const listed = new Set(listedIds);
  return [...open.keys()].filter((id) => !listed.has(id));
}

export interface ReadBoardOptions {
  /** The markets this deployment writes (a posting of another market is never asked for its text). */
  markets: readonly Market[];
  /** SmartRecruiters posting texts read this run. */
  detailsBudget?: number;
}

/** Reads one board and routes it. Never throws for a board failure; writes nothing. */
export async function readBoard(db: CareerSourceDb, source: CareerSourceRow, deps: ConnectorDeps, opts: ReadBoardOptions): Promise<BoardReadOutcome> {
  const board = asBoardSource(source);
  if (!board) return { source, read: null, routed: null, closedExternalIds: [], calls: 0, error: 'unsupported_job_board' };
  let read: BoardRead | null = null;
  let error: string | null = null;
  let open = new Map<string, Date | null>();
  try {
    open = await loadOpenBoardRows(db, source);
    read = await connectorFor(board.ats).read(board, deps, {
      known: open,
      storedIds: (listed) => storedIdsOf(listed, source.countries, opts.markets),
      ...(opts.detailsBudget !== undefined ? { detailsBudget: opts.detailsBudget } : {}),
    });
  } catch (err) {
    error = boardErrorText(err);
  }
  if (!read) return { source, read: null, routed: null, closedExternalIds: [], calls: 1, error };
  const routed = routeBoardRead(read, source.countries);
  return { source, read, routed, closedExternalIds: read.complete ? closedExternalIds(open, routed.listedIds) : [], calls: read.calls, error: null };
}
