// server/src/features/jobs/sources/atsPublic/adapter.ts — the `ats_public`
// ingest source (WP-42), registered with WP-16b's adapter registry.
//
// A 'cursor' adapter: ingest keeps ONE standing query for it per market
// (`ensureBankSyncQueries`, re-run every 30 minutes). Each leased run reads up
// to BOARDS_PER_FETCH due career sources (never read, or read more than
// SYNC_INTERVAL_MS ago) and answers `exhausted: false` while more are due, so
// the same tick keeps going. Postings go through ingest's normalize → hooks →
// upsert → dedupe → enrich; postings a board stopped listing come back as
// `closedExternalIds` and ingest archives them as 'source_removed' (a board
// is not a recruiter bank). Board postings never expire by date.
//
// Both markets (GOAPPLY_PARITY_PLAN.md §3.9, MARKET_STRATEGY JC-4). A run reads
// the career sources of ITS market (the market on the source row) and keeps
// the postings located in that market: mainland China → cn (GoApply), anything
// else → intl (RoboApply). Each posting is in exactly one market; the postings
// of the other market are counted as `wrong_market`, never written. This is
// the source that fills the GoApply feed: the employer's own posting, with the
// employer's own apply link. Unmetered (public APIs); kill switch
// ATS_PUBLIC_SOURCES_DISABLED=true.
//
// Backlog (market cn only). A mainland board can list more postings than one
// run may read (BoschGroup: about 1,300 against 100 posting texts per run), so
// a board that still has unread postings is read again after
// BACKLOG_INTERVAL_MS instead of SYNC_INTERVAL_MS. Which boards those are is
// the adapter's own state and lives in the standing query's cursor
// ("backlog:<sourceId>,<sourceId>"), never in the source row: `lastSyncedAt`
// stays the real time of the last read. International sources keep the usual
// interval, so their request volume is unchanged.

import type { EnvSource } from '../../../../platform/brand/index.js';
import { parseBoolEnv } from '../../../../platform/brand/index.js';
import type { JobSourceAdapter, SourceFetchResult } from '../index.js';
import type { ProviderJobInput } from '../../normalize/index.js';
import { PUBLIC_ATS } from './contract.js';
import type { FetchLike } from './http.js';
import { BOARDS_PER_FETCH } from './shared.js';
import { dueCareerSources, liveSourceIds, readCareerSource, type CareerSourceDb } from './sync.js';

export const ATS_PUBLIC_KILL_SWITCH = 'ATS_PUBLIC_SOURCES_DISABLED';

export interface AtsPublicAdapterDeps {
  /** Database (default: the app Prisma client, loaded lazily). */
  db?: () => Promise<CareerSourceDb> | CareerSourceDb;
  fetch?: FetchLike;
  env?: EnvSource;
}

async function defaultDb(): Promise<CareerSourceDb> {
  return (await import('../../../../lib/prisma.js')).default;
}

const BACKLOG_CURSOR_PREFIX = 'backlog:';
/** Boards remembered at most (far above the number of boards a market reads). */
const MAX_BACKLOG_IDS = 500;

/** The source ids a standing query's cursor remembers as holding unread postings. */
export function parseBacklogCursor(cursor: string | null | undefined): string[] {
  if (typeof cursor !== 'string' || !cursor.startsWith(BACKLOG_CURSOR_PREFIX)) return [];
  return [...new Set(cursor.slice(BACKLOG_CURSOR_PREFIX.length).split(',').map((id) => id.trim()).filter(Boolean))].slice(0, MAX_BACKLOG_IDS);
}

/** Always a non-empty string, so an emptied list is written too ("backlog:"). */
export function formatBacklogCursor(ids: Iterable<string>): string {
  return `${BACKLOG_CURSOR_PREFIX}${[...new Set(ids)].slice(0, MAX_BACKLOG_IDS).join(',')}`;
}

export function atsPublicEnabled(env: EnvSource = process.env): boolean {
  return !parseBoolEnv(env[ATS_PUBLIC_KILL_SWITCH]);
}

export function createAtsPublicAdapter(deps: AtsPublicAdapterDeps = {}): JobSourceAdapter {
  return {
    provider: 'ats_public',
    kind: 'cursor',
    markets: ['intl', 'cn'],
    sourceBoards: [...PUBLIC_ATS],
    transport: () => 'board_api',
    disabledReason: () => (atsPublicEnabled(deps.env ?? process.env) ? null : 'kill_switch'),
    isEnabled: () => {
      try {
        return atsPublicEnabled(deps.env ?? process.env);
      } catch {
        return false;
      }
    },
    // Boards are curated per company, not searched per country.
    supportsCountry: () => false,
    dailyCallLimit: () => null,
    async fetch(query, ctx): Promise<SourceFetchResult> {
      const market = query.market === 'cn' ? 'cn' : 'intl';
      const startedAt = Date.now();
      try {
        const db = await (deps.db ?? defaultDb)();
        // Mainland boards with postings still unread come back sooner (see the header).
        const remembered = market === 'cn' ? parseBacklogCursor(query.params.cursor) : [];
        const backlog = await liveSourceIds(db, market, remembered);
        const due = await dueCareerSources(db, market, ctx.now, BOARDS_PER_FETCH + 1, { backlogIds: [...backlog] });
        const jobs: ProviderJobInput[] = [];
        const closed: string[] = [];
        const notes: Record<string, number> = {};
        const bump = (key: string, by: number) => {
          if (by > 0) notes[key] = (notes[key] ?? 0) + by;
        };
        let calls = 0;
        let outOfTime = false;
        for (const source of due.slice(0, BOARDS_PER_FETCH)) {
          if (ctx.signal?.aborted) break;
          // The caller's remaining budget (the ingest tick): a board not started now is still due next time.
          if (calls > 0 && ctx.budgetMs !== undefined && Date.now() - startedAt >= ctx.budgetMs) {
            outOfTime = true;
            break;
          }
          const result = await readCareerSource(db, source, { now: ctx.now, fetch: deps.fetch, signal: ctx.signal });
          calls += result.calls;
          bump('boards_read', 1);
          if (result.error) bump('board_errors', 1);
          if (result.read) {
            jobs.push(...result.read.inputs);
            // Postings located in the other market: counted here, never handed to the normalizer.
            bump('wrong_market', result.read.wrongMarket);
            bump('board_backlog', result.read.pending);
          }
          // A board that was read leaves the list unless this read still left postings unread.
          if (market === 'cn' && result.read && result.read.pending > 0) backlog.add(source.id);
          else backlog.delete(source.id);
          closed.push(...result.closedExternalIds);
        }
        const changed = remembered.length !== backlog.size || remembered.some((id) => !backlog.has(id));
        return {
          jobs,
          calls,
          closedExternalIds: closed,
          closeReason: 'source_removed',
          notes,
          exhausted: !outOfTime && due.length <= BOARDS_PER_FETCH,
          // Written only when the list changed (ingest keeps the stored cursor for null).
          cursor: changed ? formatBacklogCursor(backlog) : null,
        };
      } catch (err) {
        return { jobs: [], calls: 0, error: err instanceof Error ? `career_sources:${err.message.slice(0, 160)}` : 'career_sources_failed' };
      }
    },
  };
}
