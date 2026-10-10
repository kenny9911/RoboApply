// server/src/features/jobs/sources/atsPublic/sync.ts — reading one career source
// (WP-42). Shared by the ingest adapter (cron) and the admin "Check now" route.
//
// `readCareerSource` reads the board, works out which of our open rows for that
// board the board no longer lists, and stamps the source row (lastSyncedAt,
// lastJobCount, lastError). It writes NO jobs: normalize → upsert → dedupe →
// enrich is ingest's job (features/jobs/ingest/pipeline.ts).
//
// A board that cannot be read closes nothing; a board whose listing was cut
// short by the paging cap closes nothing either (we cannot tell "gone" from
// "not read").
//
// Our open rows of the board (externalId + lastSeenAt) are loaded once before
// the read: the connector uses them to read postings we do not have yet first
// and then the longest-unrefreshed ones (per-run caps), and the closure check
// compares the listing against them.
//
// A board is read for the market on its source row. The connector keeps the
// postings located in that market (mainland China → cn, anything else → intl)
// and counts the rest; the listing diff therefore compares like with like: our
// open rows of this board IN THAT MARKET against the board's postings of that
// market.
//
// `lastSyncedAt` is always the time of the read (both board managers print it
// as "Last checked"). A mainland board with postings still unread after the
// per-run caps is read again after BACKLOG_INTERVAL_MS instead of the usual
// interval: the ingest adapter remembers those boards in its own cursor and
// passes them to `dueCareerSources` as `backlogIds`. The source row is not
// used to carry that state.

import type prisma from '../../../../lib/prisma.js';
import type { Market } from '../../../../platform/brand/index.js';
import { connectorFor, type BoardRead } from './connectors.js';
import type { HttpDeps } from './http.js';
import { BoardFetchError } from './http.js';
import { BACKLOG_INTERVAL_MS, externalIdPrefix, isPublicAts, SYNC_INTERVAL_MS } from './shared.js';

/** Typed delegates this module reads and writes (no untyped client casts). */
export type CareerSourceDb = Pick<typeof prisma, 'rACareerSiteSource' | 'rAJob'>;

export interface CareerSourceRow {
  id: string;
  market: string;
  ats: string;
  boardToken: string;
  companyName: string;
  companyId: string | null;
  countryCode: string | null;
  enabled: boolean;
  lastSyncedAt: Date | null;
  lastJobCount: number | null;
  lastError: string | null;
}

export interface SourceReadResult {
  source: CareerSourceRow;
  read: BoardRead | null;
  /** externalIds of our open public rows that the board no longer lists. */
  closedExternalIds: string[];
  calls: number;
  error: string | null;
}

/** Max open rows compared per board (more than any board we read can list). */
const OPEN_ROWS_LIMIT = 10_000;

function errorText(err: unknown): string {
  if (err instanceof BoardFetchError) return err.message;
  return err instanceof Error ? `unexpected:${err.message.slice(0, 160)}` : 'unexpected';
}

const marketOf = (source: { market?: string | null }): Market | null => (source.market === 'cn' ? 'cn' : source.market === 'intl' ? 'intl' : null);

/**
 * Our open public rows of this board in the source's market: externalId →
 * RAJob.lastSeenAt (when ingest last saved it). A source without a market
 * (callers that pass only the board) compares every open row of the board.
 */
export async function loadOpenBoardRows(db: CareerSourceDb, source: Pick<CareerSourceRow, 'ats' | 'boardToken'> & { market?: string | null }): Promise<Map<string, Date | null>> {
  const market = marketOf(source);
  const open = await db.rAJob.findMany({
    where: { sourceBoard: source.ats, externalId: { startsWith: externalIdPrefix(source.boardToken) }, archivedAt: null, visibility: 'public', ...(market ? { market } : {}) },
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

/** Open public rows of this board that are not in the listing. */
export async function findClosedExternalIds(db: CareerSourceDb, source: Pick<CareerSourceRow, 'ats' | 'boardToken'> & { market?: string | null }, listedIds: readonly string[]): Promise<string[]> {
  return closedExternalIds(await loadOpenBoardRows(db, source), listedIds);
}

/** Reads one board, finds closures and stamps the source row. Never throws for board failures. */
export async function readCareerSource(db: CareerSourceDb, source: CareerSourceRow, deps: HttpDeps & { now: Date }): Promise<SourceReadResult> {
  let read: BoardRead | null = null;
  let error: string | null = null;
  let closed: string[] = [];
  if (!isPublicAts(source.ats)) {
    error = 'unsupported_job_board';
  } else {
    const open = await loadOpenBoardRows(db, source);
    try {
      read = await connectorFor(source.ats).read(
        { ats: source.ats, boardToken: source.boardToken, companyName: source.companyName, countryCode: source.countryCode },
        deps,
        { known: open, market: marketOf(source) ?? undefined },
      );
    } catch (err) {
      error = errorText(err);
    }
    if (read && read.complete) closed = closedExternalIds(open, read.listedIds);
  }
  await db.rACareerSiteSource.update({
    where: { id: source.id },
    data: {
      // Always the time of this read: the board managers show it as "Last checked".
      lastSyncedAt: deps.now,
      lastError: error,
      ...(read ? { lastJobCount: read.listedIds.length } : {}),
    },
  });
  return { source, read, closedExternalIds: closed, calls: read?.calls ?? (error === 'unsupported_job_board' ? 0 : 1), error };
}

/**
 * Up to `limit` due sources: never-read boards first, then the longest unread
 * (read more than SYNC_INTERVAL_MS ago), then the boards in `backlogIds` (still
 * holding postings we have not stored) that were read more than
 * BACKLOG_INTERVAL_MS ago.
 */
export async function dueCareerSources(
  db: CareerSourceDb,
  market: Market,
  now: Date,
  limit: number,
  options: { backlogIds?: readonly string[] } = {},
): Promise<CareerSourceRow[]> {
  if (limit <= 0) return [];
  const fresh = await db.rACareerSiteSource.findMany({
    where: { market, enabled: true, lastSyncedAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  if (fresh.length >= limit) return fresh;
  const stale = await db.rACareerSiteSource.findMany({
    where: { market, enabled: true, lastSyncedAt: { lt: new Date(now.getTime() - SYNC_INTERVAL_MS) } },
    orderBy: { lastSyncedAt: 'asc' },
    take: limit - fresh.length,
  });
  const due = [...fresh, ...stale];
  const backlogIds = [...new Set(options.backlogIds ?? [])].filter((id) => !due.some((s) => s.id === id));
  if (due.length >= limit || backlogIds.length === 0) return due;
  const backlog = await db.rACareerSiteSource.findMany({
    where: { id: { in: backlogIds }, market, enabled: true, lastSyncedAt: { lt: new Date(now.getTime() - BACKLOG_INTERVAL_MS) } },
    orderBy: { lastSyncedAt: 'asc' },
    take: limit - due.length,
  });
  return [...due, ...backlog];
}

/** The ids among `ids` that are still enabled sources of the market (a removed or switched-off board leaves the backlog list). */
export async function liveSourceIds(db: CareerSourceDb, market: Market, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.rACareerSiteSource.findMany({ where: { id: { in: [...ids] }, market, enabled: true }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}
