// server/src/features/jobs/sources/atsPublic/service.ts — the admin career-source
// service (WP-42): the ops-curated list of company job boards read through
// their public posting APIs, and "Check now".
//
// A source belongs to one market: RoboApply (intl) or GoApply (cn). Every
// method takes the market of the brand the admin is on and never reads or
// changes a source of the other market (a foreign id is "not found"). A
// source feeds its market with the board's postings located there (mainland
// China → cn, anything else → intl). Turning a source off or removing it
// archives its open jobs ('source_removed'): we no longer check them, so they
// leave the feed instead of going stale. Turning it back on re-reads the
// board, and the upsert brings back rows archived as 'source_removed'.
//
// "Check now" reads the board's listing once — listing pages only, never the
// posting texts, under one overall time limit (RUN_NOW_TIMEOUT_MS) — to tell
// ops what it lists or why it cannot be read; it then marks the source due and queues ingest's standing
// `ats_public` query as an `ingest.query` work item, so the postings go through
// ingest's own normalize → save → dedupe → enrich path (this area may not
// call ingest internals; TASK_PLAN.md §2.1 rule 4).

import type { z } from 'zod';
import { Prisma } from '../../../../generated/prisma/client.js';
import type prisma from '../../../../lib/prisma.js';
import { BRAND_IDS, getBrand, type BrandId, type Market } from '../../../../platform/brand/index.js';
import { httpError } from '../../../../platform/http.js';
import { enqueue as platformEnqueue, kickDrain } from '../../../../platform/queue/index.js';
import { JOBS_INGEST_WORK_KINDS } from '../../ingest/index.js';
import type {
  CareerSourceBodySchema,
  CareerSourceRunResult,
  CareerSourceView,
  ListCareerSourcesQuerySchema,
  PatchCareerSourceBodySchema,
  PublicAts,
} from './contract.js';
import { connectorFor } from './connectors.js';
import { BoardFetchError, type FetchLike } from './http.js';
import { externalIdPrefix, isPublicAts } from './shared.js';
import type { CareerSourceDb, CareerSourceRow } from './sync.js';

export type CareerSourceBody = z.output<typeof CareerSourceBodySchema>;
export type PatchCareerSourceBody = z.output<typeof PatchCareerSourceBodySchema>;
export type ListCareerSourcesQuery = z.output<typeof ListCareerSourcesQuerySchema>;

/** Typed delegates the admin service uses (the standing ingest query is read and re-timed, never created). */
export type CareerSourcesServiceDb = CareerSourceDb & Pick<typeof prisma, 'rAIngestQuery'>;

export type EnqueueFn = (kind: string, payload: unknown, options: { dedupeKey?: string; brand?: BrandId }) => Promise<unknown>;

/** The brand whose feed a market's sources enter (intl → roboapply, cn → goapply). */
export function brandIdForMarket(market: Market): BrandId {
  return BRAND_IDS.find((id) => getBrand(id).market === market) ?? 'roboapply';
}

const marketOfRow = (row: Pick<CareerSourceRow, 'market'>): Market => (row.market === 'cn' ? 'cn' : 'intl');

/** Overall time limit for "Check now"'s listing read (inside the admin request). */
export const RUN_NOW_TIMEOUT_MS = 15_000;

export interface CareerSourcesServiceDeps {
  db: () => Promise<CareerSourcesServiceDb> | CareerSourcesServiceDb;
  fetch?: FetchLike;
  /** Overrides RUN_NOW_TIMEOUT_MS (tests). */
  runNowTimeoutMs?: number;
  now?: () => Date;
  enqueue?: EnqueueFn;
  kick?: (kinds: string[]) => unknown;
}

export function toView(row: CareerSourceRow): CareerSourceView {
  return {
    id: row.id,
    market: row.market === 'cn' ? 'cn' : 'intl',
    ats: row.ats as PublicAts,
    boardToken: row.boardToken,
    companyName: row.companyName,
    companyId: row.companyId,
    countryCode: row.countryCode,
    enabled: row.enabled,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastJobCount: row.lastJobCount,
    lastError: row.lastError,
  };
}

/** `details.reason` of the 409 answered when the board belongs to the other site's list. */
export const BOARD_ON_OTHER_SITE = 'board_on_other_site';

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

export function createCareerSourcesService(deps: CareerSourcesServiceDeps) {
  const now = () => (deps.now ? deps.now() : new Date());
  const db = async () => deps.db();

  /** The source, only when it belongs to `market` (another market's source is not found). */
  async function find(id: string, market: Market): Promise<CareerSourceRow> {
    const row = await (await db()).rACareerSiteSource.findUnique({ where: { id } });
    if (!row || marketOfRow(row) !== market) throw httpError('not_found', 'Career source not found.');
    return row;
  }

  /** Archives the board's open public rows in its market (we stop checking them). */
  async function archiveBoardJobs(row: Pick<CareerSourceRow, 'ats' | 'boardToken' | 'market'>): Promise<number> {
    const at = now();
    const { count } = await (await db()).rAJob.updateMany({
      where: { sourceBoard: row.ats, externalId: { startsWith: externalIdPrefix(row.boardToken) }, archivedAt: null, visibility: 'public', market: marketOfRow(row) },
      data: { archivedAt: at, closedAt: at, closeReason: 'source_removed' },
    });
    return count;
  }

  return {
    async list(query: ListCareerSourcesQuery, market: Market): Promise<{ items: CareerSourceView[]; cursor: null }> {
      // Another market's list is never returned: asking for it answers an empty list.
      if (query.market && query.market !== market) return { items: [], cursor: null };
      const rows = await (await db()).rACareerSiteSource.findMany({
        where: {
          market,
          ...(query.enabled ? { enabled: query.enabled === 'true' } : {}),
        },
        orderBy: [{ companyName: 'asc' }, { createdAt: 'asc' }],
        take: 1000,
      });
      return { items: rows.map(toView), cursor: null };
    },

    async create(body: CareerSourceBody, adminId: string | null, market: Market): Promise<CareerSourceView> {
      if (body.market && body.market !== market) {
        throw httpError('invalid_request', 'A job board is added on the site it feeds.', { issues: [{ path: 'market', message: 'other_market' }] });
      }
      try {
        const row = await (await db()).rACareerSiteSource.create({
          data: {
            market,
            ats: body.ats,
            boardToken: body.boardToken,
            companyName: body.companyName,
            companyId: body.companyId ?? null,
            countryCode: body.countryCode ?? null,
            enabled: body.enabled,
            createdBy: adminId,
          },
        });
        return toView(row);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A board is unique across both sites (one reading market per board). When the other site
        // has it, say so: this site's list does not show that board, so "already in the list" would mislead.
        const taken = await (await db()).rACareerSiteSource.findFirst({ where: { ats: body.ats, boardToken: body.boardToken }, select: { market: true } });
        if (taken && marketOfRow(taken) !== market) {
          throw httpError('conflict', 'This job board is already read for the other site, so it cannot be added here.', { field: 'boardToken', reason: BOARD_ON_OTHER_SITE });
        }
        throw httpError('conflict', 'This job board is already in the list.', { field: 'boardToken' });
      }
    },

    async update(id: string, patch: PatchCareerSourceBody, market: Market): Promise<CareerSourceView> {
      const before = await find(id, market);
      const data: Prisma.RACareerSiteSourceUpdateInput = {};
      if (patch.companyName !== undefined) data.companyName = patch.companyName;
      if (patch.companyId !== undefined) data.companyId = patch.companyId;
      if (patch.countryCode !== undefined) data.countryCode = patch.countryCode;
      if (patch.enabled !== undefined) {
        data.enabled = patch.enabled;
        // Re-read a board that is turned back on at the next run.
        if (patch.enabled && !before.enabled) data.lastSyncedAt = null;
      }
      const row = await (await db()).rACareerSiteSource.update({ where: { id }, data });
      if (patch.enabled === false && before.enabled) await archiveBoardJobs(before);
      return toView(row);
    },

    async remove(id: string, market: Market): Promise<{ archivedJobs: number }> {
      const row = await find(id, market);
      const archivedJobs = await archiveBoardJobs(row);
      await (await db()).rACareerSiteSource.delete({ where: { id } });
      return { archivedJobs };
    },

    /** "Check now": read the board, then queue ingest's standing ats_public query (see header). */
    async runNow(id: string, market: Market): Promise<CareerSourceRunResult> {
      const row = await find(id, market);
      if (!row.enabled) throw httpError('conflict', 'Turn the board on first.');
      const store = await db();
      const base: CareerSourceRunResult = { sourceId: id, status: 'scheduled', listed: 0, queued: false, error: null };
      let listed: number;
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), deps.runNowTimeoutMs ?? RUN_NOW_TIMEOUT_MS);
      try {
        if (!isPublicAts(row.ats)) throw new BoardFetchError('unsupported_job_board');
        // Listing only: the queued ingest run reads the posting texts. The count is the board's
        // postings located in this source's market (the ones the run will import).
        const read = await connectorFor(row.ats).read(
          { ats: row.ats, boardToken: row.boardToken, companyName: row.companyName, countryCode: row.countryCode },
          { now: now(), fetch: deps.fetch, signal: limit.signal },
          { listOnly: true, market },
        );
        listed = read.listedIds.length;
      } catch (err) {
        const error = err instanceof BoardFetchError ? err.message : 'unexpected';
        await store.rACareerSiteSource.update({ where: { id }, data: { lastError: error, lastSyncedAt: now() } });
        return { ...base, status: 'error', error };
      } finally {
        clearTimeout(timer);
      }
      // Due now: the adapter reads never-read boards first.
      await store.rACareerSiteSource.update({ where: { id }, data: { lastSyncedAt: null, lastError: null, lastJobCount: listed } });
      const standing = await store.rAIngestQuery.findFirst({
        where: { provider: 'ats_public', market, enabled: true },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!standing) return { ...base, listed };
      await store.rAIngestQuery.update({ where: { id: standing.id }, data: { nextRunAt: now() } });
      const kind = JOBS_INGEST_WORK_KINDS.ingestQuery;
      await (deps.enqueue ?? platformEnqueue)(kind, { queryId: standing.id }, { dedupeKey: `${kind}:${standing.id}:check:${id}:${now().getTime()}`, brand: brandIdForMarket(market) });
      // Best effort: the queue's own drain picks the item up if the kick fails.
      Promise.resolve()
        .then(() => (deps.kick ?? kickDrain)([kind]))
        .catch(() => undefined);
      return { ...base, listed, queued: true };
    },
  };
}

export type CareerSourcesService = ReturnType<typeof createCareerSourcesService>;

let defaultService: CareerSourcesService | null = null;

export function careerSourcesService(): CareerSourcesService {
  defaultService ??= createCareerSourcesService({ db: async () => (await import('../../../../lib/prisma.js')).default });
  return defaultService;
}
