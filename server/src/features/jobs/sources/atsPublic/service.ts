// server/src/features/jobs/sources/atsPublic/service.ts — the admin career-source
// service (WP-42): the ops-curated list of company job boards read through
// their public posting APIs, and "Check now".
//
// Sources are RoboApply-only (market 'intl'); GoApply never reads public ATS
// boards (CN plan L-5). Turning a source off or removing it archives its open
// jobs ('source_removed'): we no longer check them, so they leave the feed
// instead of going stale. Turning it back on re-reads the board, and the
// upsert brings back rows archived as 'source_removed'.
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

export type EnqueueFn = (kind: string, payload: unknown, options: { dedupeKey?: string; brand?: 'roboapply' }) => Promise<unknown>;

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

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

export function createCareerSourcesService(deps: CareerSourcesServiceDeps) {
  const now = () => (deps.now ? deps.now() : new Date());
  const db = async () => deps.db();

  async function find(id: string): Promise<CareerSourceRow> {
    const row = await (await db()).rACareerSiteSource.findUnique({ where: { id } });
    if (!row) throw httpError('not_found', 'Career source not found.');
    return row;
  }

  /** Archives the board's open public rows (we stop checking them). */
  async function archiveBoardJobs(row: Pick<CareerSourceRow, 'ats' | 'boardToken'>): Promise<number> {
    const at = now();
    const { count } = await (await db()).rAJob.updateMany({
      where: { sourceBoard: row.ats, externalId: { startsWith: externalIdPrefix(row.boardToken) }, archivedAt: null, visibility: 'public' },
      data: { archivedAt: at, closedAt: at, closeReason: 'source_removed' },
    });
    return count;
  }

  return {
    async list(query: ListCareerSourcesQuery): Promise<{ items: CareerSourceView[]; cursor: null }> {
      const rows = await (await db()).rACareerSiteSource.findMany({
        where: {
          ...(query.market ? { market: query.market } : {}),
          ...(query.enabled ? { enabled: query.enabled === 'true' } : {}),
        },
        orderBy: [{ companyName: 'asc' }, { createdAt: 'asc' }],
        take: 1000,
      });
      return { items: rows.map(toView), cursor: null };
    },

    async create(body: CareerSourceBody, adminId: string | null): Promise<CareerSourceView> {
      if (body.market !== 'intl') {
        throw httpError('invalid_request', 'Public job boards feed the international site only.', { issues: [{ path: 'market', message: 'intl_only' }] });
      }
      try {
        const row = await (await db()).rACareerSiteSource.create({
          data: {
            market: 'intl',
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
        if (isUniqueViolation(err)) throw httpError('conflict', 'This job board is already in the list.', { field: 'boardToken' });
        throw err;
      }
    },

    async update(id: string, patch: PatchCareerSourceBody): Promise<CareerSourceView> {
      const before = await find(id);
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

    async remove(id: string): Promise<{ archivedJobs: number }> {
      const row = await find(id);
      const archivedJobs = await archiveBoardJobs(row);
      await (await db()).rACareerSiteSource.delete({ where: { id } });
      return { archivedJobs };
    },

    /** "Check now": read the board, then queue ingest's standing ats_public query (see header). */
    async runNow(id: string): Promise<CareerSourceRunResult> {
      const row = await find(id);
      if (row.market !== 'intl') throw httpError('invalid_request', 'Public job boards feed the international site only.');
      if (!row.enabled) throw httpError('conflict', 'Turn the board on first.');
      const store = await db();
      const base: CareerSourceRunResult = { sourceId: id, status: 'scheduled', listed: 0, queued: false, error: null };
      let listed: number;
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), deps.runNowTimeoutMs ?? RUN_NOW_TIMEOUT_MS);
      try {
        if (!isPublicAts(row.ats)) throw new BoardFetchError('unsupported_job_board');
        // Listing only: the queued ingest run reads the posting texts.
        const read = await connectorFor(row.ats).read(
          { ats: row.ats, boardToken: row.boardToken, companyName: row.companyName, countryCode: row.countryCode },
          { now: now(), fetch: deps.fetch, signal: limit.signal },
          { listOnly: true },
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
        where: { provider: 'ats_public', market: 'intl', enabled: true },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!standing) return { ...base, listed };
      await store.rAIngestQuery.update({ where: { id: standing.id }, data: { nextRunAt: now() } });
      const kind = JOBS_INGEST_WORK_KINDS.ingestQuery;
      await (deps.enqueue ?? platformEnqueue)(kind, { queryId: standing.id }, { dedupeKey: `${kind}:${standing.id}:check:${id}:${now().getTime()}`, brand: 'roboapply' });
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
