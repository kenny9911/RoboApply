// server/src/features/jobs/sources/atsPublic/service.ts — the admin career-source
// service (WP-42; MARKET_STRATEGY JI-3, JI-4, JC-4, JT-5): the list of company
// job boards read through their public posting APIs, bulk import, and
// "Check now". Both brands.
//
// One board, both sites. A board is ONE source ((ats, boardToken) is unique)
// and is read once; each posting lands in the market of its own location
// (mainland China -> GoApply, anything else -> RoboApply). So an admin on
// either site works on the same rows. `countries` says which countries a
// board is read for (empty = every country); a list request shows the boards
// that feed the admin's market: cn = `countries` is empty or contains CN,
// intl = `countries` is empty or contains any other code. The `market` column
// only records the console that added the board.
//
// Switching a source off or removing it archives its open jobs
// ('source_removed') in both markets: we no longer check them, so they leave
// the feeds instead of going stale. Switching it back on clears its failure
// count and makes it due at once; the upsert brings back rows archived as
// 'source_removed'. A removal is remembered (./removed.ts), so the board is
// not proposed again by the next posting that links to it; adding it again by
// hand or in an import forgets the removal.
//
// "Check now" reads the board's listing once (never the posting texts; for a
// listing that is paged without them, its first page and the board's own
// total; under one overall time limit, RUN_NOW_TIMEOUT_MS) to tell ops what
// it lists or why it cannot be read. The request says who is asking as the
// brand of the admin's site. When the board can be read, the source is
// marked due and the next board sync (cron `jobs-boards`, every 5 minutes)
// reads and saves its postings. This file writes no job and queues no work.
//
// A system whose connector is switched off (./connectors.ts `connectorEnabled`:
// Workable under ATS_WORKABLE_DISABLED, 北森 without CN_ATS_BEISEN_ENABLED)
// cannot be added: a create answers 400 with `details.reason
// 'connector_disabled'` and an import refuses the row with that reason. A
// source that exists already stays in the list and is passed over by the board
// sync; "Check now" on it reports 'connector_disabled' and makes no request.
// The id of a board on a tenant's own host (Recruitee, Personio, 北森) is the
// lower-case sub-domain label and nothing else (contract.ts `isBoardTokenFor`).
// A 北森 tenant is asked at most once in 30 minutes, "Check now" included, and
// always as the mainland brand: "Check now" refuses ('tenant_floor', no
// request) a tenant that was asked under 30 minutes ago, writes the time to
// the source BEFORE its own request, and makes no request to a tenant on the
// denylist ('tenant_denied'). Switching on a tenant that was only ever asked
// as a candidate keeps the time before which it must not be asked again
// (schedule.ts).
//
// Bulk import (CSV or JSON, at most IMPORT_MAX_ROWS rows) is the entry point
// for board lists built outside the repository. A new row gets origin
// 'import'. Imported with `enable: false` it is a candidate: the board sync
// reads its listing once and switches it on only when the board answers and
// its company matches. Imported with `enable: true` it is read directly and
// switched off by three failed reads like any source. For a board that is
// already in the list only its countries are merged (an empty list means
// every country and wins); its on/off state and origin never change.

import { parse as parseCsv } from 'csv-parse/sync';
import type { z } from 'zod';
import { Prisma } from '../../../../generated/prisma/client.js';
import type { EnvSource, Market } from '../../../../platform/brand/index.js';
import { httpError } from '../../../../platform/http.js';
import { atsPublicEnabled } from './adapter.js';
import {
  CONNECTOR_DISABLED,
  IMPORT_CSV_COLUMNS,
  IMPORT_MAX_INVALID_REPORTED,
  IMPORT_MAX_ROWS,
  isBoardTokenFor,
  type BoardAts,
  type CareerSourceBodySchema,
  type CareerSourceListResult,
  type CareerSourceRunResult,
  type CareerSourceView,
  type ImportCareerSourcesBodySchema,
  type ImportCareerSourcesResult,
  type ImportInvalidReason,
  type ListCareerSourcesQuerySchema,
  type PatchCareerSourceBodySchema,
  type PublicAts,
} from './contract.js';
import { connectorEnabled, connectorFor, enabledAts } from './connectors.js';
import { BoardFetchError, type FetchLike } from './http.js';
import { forgetRemovedBoards, rememberRemovedBoard, type RemovedBoardsDb } from './removed.js';
import { firstReadAfterSwitchOn, TENANT_DENIED, TENANT_FLOOR, tenantAskedRecently } from './schedule.js';
import { careerSourceState, externalIdPrefix, isMainlandOnlyAts, isPublicAts, mergeCountries, normalizeCountries, sourceFeedsMarket, tenantDenied } from './shared.js';
import { asBoardSource, toCareerSourceRow, type CareerSourceDb, type CareerSourceRow } from './sync.js';

export type CareerSourceBody = z.output<typeof CareerSourceBodySchema>;
export type PatchCareerSourceBody = z.output<typeof PatchCareerSourceBodySchema>;
export type ListCareerSourcesQuery = z.output<typeof ListCareerSourcesQuerySchema>;
export type ImportCareerSourcesBody = z.output<typeof ImportCareerSourcesBodySchema>;

/** Typed delegates the admin service uses: the sources, their jobs, and the list of removed boards. */
export type CareerSourcesServiceDb = CareerSourceDb & RemovedBoardsDb;

/** Overall time limit for "Check now"'s listing read (inside the admin request). */
export const RUN_NOW_TIMEOUT_MS = 15_000;
/** Sources read for one list request, and the most a list answers. */
const LIST_SCAN_LIMIT = 20_000;
export const LIST_LIMIT = 2_000;
const IMPORT_CHUNK = 500;

/** `details.reason` of the 409 answered when the board is in the list but read for other countries than this site's. */
export const BOARD_READ_FOR_OTHER_COUNTRIES = 'board_read_for_other_countries';
/** `error` of "Check now" while the kill switch is on. */
export const SOURCES_OFF = 'sources_off';

export interface CareerSourcesServiceDeps {
  db: () => Promise<CareerSourcesServiceDb> | CareerSourcesServiceDb;
  fetch?: FetchLike;
  /** Overrides RUN_NOW_TIMEOUT_MS (tests). */
  runNowTimeoutMs?: number;
  now?: () => Date;
  env?: EnvSource;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The view of a source row, with every field set. */
export function toView(raw: CareerSourceRow | Record<string, unknown>): Required<CareerSourceView> {
  const row = toCareerSourceRow(raw as Record<string, unknown>);
  return {
    id: row.id,
    market: row.market === 'cn' ? 'cn' : 'intl',
    ats: row.ats as PublicAts,
    boardToken: row.boardToken,
    companyName: row.companyName,
    companyId: row.companyId,
    countryCode: row.countryCode,
    enabled: row.enabled,
    lastSyncedAt: iso(row.lastSyncedAt),
    lastJobCount: row.lastJobCount,
    lastError: row.lastError,
    origin: row.origin === 'seed' || row.origin === 'import' || row.origin === 'discovered' ? row.origin : 'admin',
    discoveredFrom: row.discoveredFrom,
    countries: row.countries,
    failCount: row.failCount,
    lastChangeAt: iso(row.lastChangeAt),
    nextSyncAt: iso(row.nextSyncAt),
    disabledAt: iso(row.disabledAt),
    state: careerSourceState(row),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

// -- Bulk import: reading the file -------------------------------------------

interface ImportRow {
  /** 1-based: the row's number in a JSON list; the file line in a CSV (its header is line 1). */
  line: number;
  ats: unknown;
  boardToken: unknown;
  companyName: unknown;
  countries: unknown;
  /** The row is not an object with fields (a JSON list may hold anything). */
  unreadable?: boolean;
}

/** One entry of a JSON list as an import row: anything that is not an object with fields is unreadable. */
export function jsonImportRow(value: unknown, line: number): ImportRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { line, ats: null, boardToken: null, companyName: null, countries: null, unreadable: true };
  const row = value as Record<string, unknown>;
  return { line, ats: row.ats, boardToken: row.boardToken, companyName: row.companyName ?? null, countries: row.countries ?? [] };
}

interface ValidImportRow {
  line: number;
  ats: BoardAts;
  boardToken: string;
  /** Null when the file gives none: the board id stands in until a sync learns the board's stated name. */
  companyName: string | null;
  countries: string[];
}

const COUNTRY_SEPARATOR = '|';

/** The rows of a CSV with the header ats,boardToken,companyName,countries (the last two optional). Throws invalid_request for a file that is not that. */
export function readImportCsv(csv: string): ImportRow[] {
  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parseCsv(csv, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true, info: true }) as unknown as typeof records;
  } catch {
    throw httpError('invalid_request', 'The file could not be read as CSV.', { issues: [{ path: 'csv', message: 'not_csv' }] });
  }
  const header = records.shift();
  const names = (header?.record ?? []).map((h) => String(h).trim().toLowerCase());
  const col = (name: string): number => names.indexOf(name.toLowerCase());
  const [atsCol, tokenCol, nameCol, countriesCol] = IMPORT_CSV_COLUMNS.map(col) as [number, number, number, number];
  if (atsCol < 0 || tokenCol < 0) {
    throw httpError('invalid_request', `The first line must name the columns: ${IMPORT_CSV_COLUMNS.join(',')}.`, { issues: [{ path: 'csv', message: 'missing_header' }] });
  }
  if (records.length > IMPORT_MAX_ROWS) {
    throw httpError('invalid_request', `A file holds at most ${IMPORT_MAX_ROWS} boards.`, { issues: [{ path: 'csv', message: 'too_many_rows' }] });
  }
  return records.map(({ record, info }) => ({
    line: info.lines,
    ats: record[atsCol],
    boardToken: record[tokenCol],
    companyName: nameCol >= 0 ? record[nameCol] : null,
    countries: countriesCol >= 0 ? String(record[countriesCol] ?? '').split(COUNTRY_SEPARATOR) : [],
  }));
}

/**
 * One row checked: the board it names, or why it is refused. `enabled` says
 * whether a system's connector is switched on (default: every system); a row
 * that names one that is off is refused as 'connector_disabled'.
 */
export function checkImportRow(row: ImportRow, enabled: (ats: BoardAts) => boolean = () => true): ValidImportRow | ImportInvalidReason {
  if (row.unreadable) return 'unreadable_row';
  const ats = typeof row.ats === 'string' ? row.ats.trim().toLowerCase() : '';
  if (!isPublicAts(ats)) return 'unknown_job_board';
  if (!enabled(ats)) return CONNECTOR_DISABLED;
  const boardToken = typeof row.boardToken === 'string' ? row.boardToken.trim() : '';
  // A board on a tenant's own host: the lower-case sub-domain label only (it becomes a host name).
  if (!isBoardTokenFor(ats, boardToken)) return 'invalid_board_id';
  // A name that is not text (a number, a list) is a row we cannot read, not a row without a name.
  if (row.companyName !== null && row.companyName !== undefined && typeof row.companyName !== 'string') return 'unreadable_row';
  const name = typeof row.companyName === 'string' ? row.companyName.trim() : '';
  if (name.length > 200) return 'company_name_too_long';
  if (row.countries !== null && row.countries !== undefined && !Array.isArray(row.countries)) return 'unreadable_row';
  const given = ((row.countries as unknown[] | null | undefined) ?? []).map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : c)).filter((c) => c !== '');
  if (given.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))) return 'invalid_country';
  const countries = normalizeCountries(given);
  if (countries.length > 60) return 'too_many_countries';
  return { line: row.line, ats, boardToken, companyName: name || null, countries };
}

const boardKey = (b: { ats: string; boardToken: string }): string => `${b.ats}:${b.boardToken}`;

export function createCareerSourcesService(deps: CareerSourcesServiceDeps) {
  const now = () => (deps.now ? deps.now() : new Date());
  const db = async () => deps.db();
  const env = () => deps.env ?? process.env;

  async function find(id: string): Promise<CareerSourceRow> {
    const row = await (await db()).rACareerSiteSource.findUnique({ where: { id } });
    if (!row) throw httpError('not_found', 'Career source not found.');
    return toCareerSourceRow(row as unknown as Record<string, unknown>);
  }

  /** Archives the board's open public rows, in both markets (we stop checking them). */
  async function archiveBoardJobs(row: Pick<CareerSourceRow, 'ats' | 'boardToken'>): Promise<number> {
    const at = now();
    const { count } = await (await db()).rAJob.updateMany({
      where: { sourceBoard: row.ats, externalId: { startsWith: externalIdPrefix(row.boardToken) }, archivedAt: null, visibility: 'public' },
      data: { archivedAt: at, closedAt: at, closeReason: 'source_removed' },
    });
    return count;
  }

  return {
    /** The boards that feed `query.market` (default: the market of the brand the admin is on). */
    async list(query: ListCareerSourcesQuery, market: Market): Promise<CareerSourceListResult & { systems: BoardAts[] }> {
      const feeds = query.market ?? market;
      const rows = await (await db()).rACareerSiteSource.findMany({
        where: {
          ...(query.enabled ? { enabled: query.enabled === 'true' } : {}),
          ...(query.origin ? { origin: query.origin } : {}),
        },
        orderBy: [{ companyName: 'asc' }, { createdAt: 'asc' }],
        take: LIST_SCAN_LIMIT,
      });
      const items = rows
        .map((r) => toView(r as unknown as Record<string, unknown>))
        .filter((v) => sourceFeedsMarket(v, feeds) && (!query.state || v.state === query.state))
        .slice(0, LIST_LIMIT);
      // The systems a board can be added for here: those whose connector is switched on.
      return { items, cursor: null, systems: enabledAts(env()) };
    },

    async create(body: CareerSourceBody, adminId: string | null, market: Market): Promise<CareerSourceView> {
      // A system whose connector is switched off cannot be added (see the header).
      if (!connectorEnabled(body.ats, env())) {
        throw httpError('invalid_request', 'This job board system is switched off.', { field: 'ats', reason: CONNECTOR_DISABLED, issues: [{ path: 'ats', message: CONNECTOR_DISABLED }] });
      }
      const store = await db();
      try {
        const row = await store.rACareerSiteSource.create({
          data: {
            // The console that added it: display only (body.market is ignored).
            market,
            ats: body.ats,
            boardToken: body.boardToken,
            companyName: body.companyName,
            companyId: body.companyId ?? null,
            countryCode: body.countryCode ?? null,
            countries: normalizeCountries(body.countries),
            origin: 'admin',
            enabled: body.enabled,
            createdBy: adminId,
          },
        });
        // Added again by hand: an earlier removal no longer stands. (Tidying only: the board is in the list either way.)
        await forgetRemovedBoards(store, [body], adminId).catch(() => 0);
        return toView(row as unknown as Record<string, unknown>);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // One row per board, shared by both sites. When it is read for other countries than this site's,
        // this site's list does not show it: say so, with what the console needs to offer "read it for
        // this site too" (the row's id, the countries it is read for now, and this site's market).
        const taken = await store.rACareerSiteSource.findFirst({ where: { ats: body.ats, boardToken: body.boardToken }, select: { id: true, countries: true } });
        if (taken && !sourceFeedsMarket(taken, market)) {
          throw httpError('conflict', 'This job board is already in the list, read for other countries. It can be read for this site too.', {
            field: 'boardToken',
            reason: BOARD_READ_FOR_OTHER_COUNTRIES,
            id: taken.id,
            countries: normalizeCountries(taken.countries),
            market,
          });
        }
        throw httpError('conflict', 'This job board is already in the list.', { field: 'boardToken' });
      }
    },

    async update(id: string, patch: PatchCareerSourceBody): Promise<CareerSourceView> {
      const before = await find(id);
      const data: Prisma.RACareerSiteSourceUpdateInput = {};
      if (patch.companyName !== undefined) data.companyName = patch.companyName;
      if (patch.companyId !== undefined) data.companyId = patch.companyId;
      if (patch.countryCode !== undefined) data.countryCode = patch.countryCode;
      if (patch.countries !== undefined) {
        const next = normalizeCountries(patch.countries);
        data.countries = next;
        // Read again at once: postings of a country that left the list are closed by that read's listing diff.
        // Only for a source that is (or is being switched) on: on one that failed reads switched off,
        // `nextSyncAt` is the time its open postings are archived (schedule.ts) and must stand.
        if (next.join(',') !== before.countries.join(',') && (patch.enabled ?? before.enabled)) data.nextSyncAt = null;
      }
      if (patch.enabled !== undefined) {
        data.enabled = patch.enabled;
        if (patch.enabled && !before.enabled) {
          // Back on: a clean slate, due at the next board sync (a 北森 tenant never before its 30 minutes are over).
          data.failCount = 0;
          data.disabledAt = null;
          data.nextSyncAt = firstReadAfterSwitchOn(before, now());
          data.lastError = null;
        }
        // Off by an admin: stamped, so it is never mistaken for a candidate. Its open jobs are archived
        // right below, so no later archive is scheduled (`nextSyncAt` null; see schedule.ts).
        if (!patch.enabled && before.enabled) {
          data.disabledAt = now();
          data.nextSyncAt = null;
        }
      }
      const row = await (await db()).rACareerSiteSource.update({ where: { id }, data });
      if (patch.enabled === false && before.enabled) await archiveBoardJobs(before);
      return toView(row as unknown as Record<string, unknown>);
    },

    async remove(id: string, adminId: string | null = null): Promise<{ archivedJobs: number }> {
      const row = await find(id);
      const store = await db();
      const archivedJobs = await archiveBoardJobs(row);
      // Remembered before the row goes, so a removal is never unrecorded: discovery and the seed list leave the board alone.
      await rememberRemovedBoard(store, row, adminId);
      await store.rACareerSiteSource.delete({ where: { id } });
      return { archivedJobs };
    },

    /**
     * "Check now": read the board's listing once, then mark the source due (see the header).
     * `market`: the market of the brand the admin is on; its brand signs the request.
     */
    async runNow(id: string, market?: Market): Promise<CareerSourceRunResult> {
      const row = await find(id);
      if (!row.enabled) throw httpError('conflict', 'Turn the board on first.');
      const store = await db();
      const base: CareerSourceRunResult = { sourceId: id, status: 'scheduled', listed: 0, queued: false, error: null };
      // The kill switch stops every public job-board read, this one included.
      if (!atsPublicEnabled(env())) return { ...base, status: 'error', error: SOURCES_OFF };
      const tenantBoard = isMainlandOnlyAts(row.ats);
      const at = now();
      // A 北森 tenant is asked at most once in 30 minutes, whoever asks: no request inside that time.
      if (tenantAskedRecently(row, at)) return { ...base, status: 'error', error: TENANT_FLOOR };
      let listed: number;
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), deps.runNowTimeoutMs ?? RUN_NOW_TIMEOUT_MS);
      try {
        const board = asBoardSource(row);
        if (!board) throw new BoardFetchError('unsupported_job_board');
        // A connector that is switched off is never asked ('connector_disabled'), and neither is a denylisted tenant.
        const connector = connectorFor(board.ats, env());
        if (tenantBoard) {
          if (tenantDenied(row, env())) throw new BoardFetchError(TENANT_DENIED);
          // Asked from here on: the time is written before the request, so the 30 minutes count from it whatever
          // becomes of this request (it fails, it is cut off by the time limit, the process dies).
          await store.rACareerSiteSource.update({ where: { id }, data: { lastSyncedAt: at } });
        }
        // Listing only, and of a paged listing its first page: the board sync reads the rest and the posting texts.
        // A tenant board of the mainland is asked as the mainland brand, whichever site the admin is on.
        const read = await connector.read(board, { now: at, fetch: deps.fetch, signal: limit.signal, env: env(), market: tenantBoard ? 'cn' : market }, { listOnly: true, firstPage: true });
        listed = read.listedCount;
      } catch (err) {
        const error = err instanceof BoardFetchError ? err.message : 'unexpected';
        await store.rACareerSiteSource.update({ where: { id }, data: { lastError: error.slice(0, 300) } });
        return { ...base, status: 'error', error };
      } finally {
        clearTimeout(timer);
      }
      // Due now: the board sync leases boards with no `nextSyncAt` first (a 北森 tenant once its 30 minutes have passed).
      await store.rACareerSiteSource.update({ where: { id }, data: { nextSyncAt: null, lastError: null, lastJobCount: listed } });
      return { ...base, listed, queued: true };
    },

    /** Bulk import (see the header). */
    async importMany(body: ImportCareerSourcesBody, adminId: string | null, market: Market): Promise<ImportCareerSourcesResult> {
      const raw: ImportRow[] = body.format === 'csv' ? readImportCsv(body.csv ?? '') : (body.rows ?? []).map((r, i) => jsonImportRow(r, i + 1));
      const invalid: ImportCareerSourcesResult['invalid'] = [];
      let invalidCount = 0;
      const refuse = (line: number, reason: ImportInvalidReason) => {
        invalidCount += 1;
        if (invalid.length < IMPORT_MAX_INVALID_REPORTED) invalid.push({ line, reason });
      };
      const valid = new Map<string, ValidImportRow>();
      const enabled = (ats: BoardAts): boolean => connectorEnabled(ats, env());
      for (const row of raw) {
        const checked = checkImportRow(row, enabled);
        if (typeof checked === 'string') refuse(row.line, checked);
        else if (valid.has(boardKey(checked))) refuse(row.line, 'duplicate_in_file');
        else valid.set(boardKey(checked), checked);
      }

      const store = await db();
      const rows = [...valid.values()];
      let created = 0;
      let merged = 0;
      for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
        const chunk = rows.slice(i, i + IMPORT_CHUNK);
        const present = await store.rACareerSiteSource.findMany({
          where: { ats: { in: [...new Set(chunk.map((r) => r.ats))] }, boardToken: { in: chunk.map((r) => r.boardToken) } },
          select: { id: true, ats: true, boardToken: true, countries: true, enabled: true },
        });
        const byKey = new Map(present.map((p) => [boardKey(p), p]));
        const fresh = chunk.filter((r) => !byKey.has(boardKey(r)));
        for (const row of chunk) {
          const have = byKey.get(boardKey(row));
          if (!have) continue;
          merged += 1;
          const before = normalizeCountries(have.countries);
          const next = mergeCountries(before, row.countries);
          // Only the countries change: never its on/off state, its origin or its name.
          if (next.join(',') !== before.join(',')) {
            await store.rACareerSiteSource.update({ where: { id: have.id }, data: { countries: next, ...(have.enabled ? { nextSyncAt: null } : {}) } });
          }
        }
        if (fresh.length > 0) {
          const res = await store.rACareerSiteSource.createMany({
            data: fresh.map((r) => ({
              market,
              ats: r.ats,
              boardToken: r.boardToken,
              companyName: r.companyName ?? r.boardToken,
              countries: r.countries,
              origin: 'import',
              enabled: body.enable,
              createdBy: adminId,
            })),
            skipDuplicates: true,
          });
          created += res.count;
          // A board another request added in between is in the list all the same.
          merged += fresh.length - res.count;
        }
      }
      // Imported boards an admin had removed earlier are back by an admin's own doing.
      await forgetRemovedBoards(store, rows, adminId).catch(() => 0);
      return { total: raw.length, created, merged, invalid, invalidCount };
    },
  };
}

export type CareerSourcesService = ReturnType<typeof createCareerSourcesService>;

let defaultService: CareerSourcesService | null = null;

export function careerSourcesService(): CareerSourcesService {
  defaultService ??= createCareerSourcesService({ db: async () => (await import('../../../../lib/prisma.js')).default });
  return defaultService;
}
