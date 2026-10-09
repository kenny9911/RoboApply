// server/src/features/jobs/ingest/pipeline.ts — fetch → normalize → upsert → dedupe → enrich (ARCH §4.4).
//
// `runIngestQuery` runs ONE leased RAIngestQuery:
//   1. metered providers reserve a call in RAProviderUsage (atomic; over the
//      daily budget → no call, the query waits for the next UTC day);
//   2. the adapter fetches (never throws);
//   3. `processJobs`: normalizeProviderJob → marketHooks.afterNormalize →
//      RACompany upsert → batched RAJob upsert (xmax = 0 counts new rows) →
//      dedupe → enqueue `job.enrich` for new or materially changed rows;
//   4. bank closures are archived ('bank_closed');
//   5. the query's stats, cursor and next run are written (raw SQL, so the
//      planner's `updatedAt` "last demanded" stamp is not touched);
//   6. with Schema request SR-16b-1 in place (`perQueryTracking`), a search
//      run that returned postings is counted and stamps them (tracking.ts),
//      which the missed-refresh archive in `jobs-maintain` reads.

import { Prisma } from '../../../generated/prisma/client.js';
import type { BrandId, Market } from '../../../platform/brand/index.js';
import { enqueueMany as platformEnqueueMany, type EnqueueManyItem } from '../../../platform/queue/index.js';
import { afterNormalize, type MarketHookJob } from '../marketHooks.js';
import { asMarketHookJob, normalizeProviderJob, PROVIDER_META, type NormalizedJob, type ProviderJobInput } from '../normalize/index.js';
import { companyKey, upsertCompanies } from '../companies/index.js';
import type { IngestOrigin, IngestQueryParams, JobSourceAdapter, SourceQuery } from '../sources/index.js';
import { publicDisplayProviders, seedBudgetShare } from './config.js';
import { dayKey, type IngestDb } from './db.js';
import { nextRunDelayMs, REFRESH } from './planner.js';
import { recordCountedRun } from './tracking.js';
import { applyDedupe, archiveClosedBankJobs, contentHash, existingKey, prefetchExisting, toUpsertRow, upsertJobRows } from './upsert.js';

export const ENRICH_KIND = 'job.enrich';

export type EnqueueManyFn = (items: EnqueueManyItem[]) => Promise<{ inserted: number }>;

export interface PipelineContext {
  db: IngestDb;
  brand: BrandId;
  market: Market;
  now: Date;
  /** Override for tests (default: the platform queue). */
  enqueueMany?: EnqueueManyFn;
  /** Providers whose licence allows public redisplay (default: env PUBLIC_DISPLAY_PROVIDERS, empty). */
  publicDisplayProviders?: readonly string[];
  /** SR-16b-1 columns exist: count runs and stamp seen jobs (default false). */
  perQueryTracking?: boolean;
  signal?: AbortSignal;
}

export interface ProcessResult {
  received: number;
  written: number;
  inserted: number;
  updated: number;
  skipped: number;
  enrichQueued: number;
  /** RAJob ids written by this page (inserted or updated). */
  jobIds: string[];
  notes: Record<string, number>;
}

function bump(notes: Record<string, number>, key: string): void {
  notes[key] = (notes[key] ?? 0) + 1;
}

/** The RAJob.sourceBoard an input will be written under (mirrors normalize/source.ts). */
function boardFor(input: ProviderJobInput, adapter: Pick<JobSourceAdapter, 'provider'>): string {
  const own = typeof input.sourceBoard === 'string' ? input.sourceBoard.trim().toLowerCase() : '';
  return own || PROVIDER_META[adapter.provider].sourceBoard;
}

/** Normalize → hooks → company → upsert → dedupe → enrich, for one fetched page. */
export async function processJobs(
  ctx: PipelineContext,
  adapter: Pick<JobSourceAdapter, 'provider'>,
  inputs: ProviderJobInput[],
  options: { countryHint?: string | null } = {},
): Promise<ProcessResult> {
  const notes: Record<string, number> = {};
  const result: ProcessResult = { received: inputs.length, written: 0, inserted: 0, updated: 0, skipped: 0, enrichQueued: 0, jobIds: [], notes };
  if (inputs.length === 0) return result;

  // One posting per (board, externalId) per page.
  const unique = new Map<string, ProviderJobInput>();
  for (const input of inputs) {
    const ext = typeof input.externalId === 'string' ? input.externalId.trim() : '';
    if (!ext) {
      result.skipped += 1;
      bump(notes, 'no_external_id');
      continue;
    }
    unique.set(existingKey(boardFor(input, adapter), ext), input);
  }
  const keys = [...unique.keys()].map((k) => {
    const [sourceBoard, externalId] = k.split('\u0000') as [string, string];
    return { sourceBoard, externalId };
  });
  const existing = await prefetchExisting(ctx.db, keys);
  const display = ctx.publicDisplayProviders ?? publicDisplayProviders();
  const country = options.countryHint && options.countryHint !== '*' ? options.countryHint : null;

  const jobs: NormalizedJob[] = [];
  for (const [key, input] of unique) {
    const prior = existing.get(key);
    if (prior && prior.visibility !== 'public') {
      result.skipped += 1;
      bump(notes, 'private_row');
      continue;
    }
    let job: NormalizedJob;
    try {
      job = normalizeProviderJob(input, adapter.provider, {
        market: ctx.market,
        now: ctx.now,
        publicDisplayProviders: display,
        countryHint: country,
        firstSeenAt: prior?.firstSeenAt ?? null,
      });
      const hooked: MarketHookJob = await afterNormalize(asMarketHookJob(job), { brand: ctx.brand, market: ctx.market, stage: 'ingest' });
      job = hooked as NormalizedJob;
    } catch {
      result.skipped += 1;
      bump(notes, 'normalize_failed');
      continue;
    }
    for (const n of job.notes) bump(notes, n.split(':')[0]!);
    if (!job.applyUrl) {
      result.skipped += 1;
      continue;
    }
    if (!job.title || !job.companyName || job.market !== ctx.market) {
      result.skipped += 1;
      bump(notes, job.market !== ctx.market ? 'wrong_market' : 'missing_title_or_company');
      continue;
    }
    jobs.push(job);
  }
  if (jobs.length === 0) return result;

  const companyIds = await upsertCompanies(ctx.db, jobs.map((j) => j.company));
  const rows = jobs.map((j) => toUpsertRow(j, companyIds.get(companyKey(j.company.market, j.company.nameNormalized)) ?? null));
  const upserted = await upsertJobRows(ctx.db, rows);
  result.written = upserted.length;
  result.jobIds = upserted.map((u) => u.id);

  const byKey = new Map(jobs.map((j) => [existingKey(j.sourceBoard, j.externalId), j]));
  const enrich: EnqueueManyItem[] = [];
  for (const u of upserted) {
    const job = byKey.get(existingKey(u.sourceBoard, u.externalId));
    if (!job) continue;
    const hash = contentHash(job.title, job.descriptionPlain);
    const prior = existing.get(existingKey(u.sourceBoard, u.externalId));
    if (u.inserted) result.inserted += 1;
    else result.updated += 1;
    if (u.inserted || !prior || prior.contentHash !== hash) {
      // A materially changed posting (an existing row whose title/description
      // hash moved) is re-enriched with `force`: WP-17's enrichJob otherwise
      // answers `already_enriched` for a row at ENRICH_VERSION and would keep
      // quotes, tags and the summary from text the posting no longer has (D3).
      const changed = !u.inserted && !!prior;
      enrich.push({
        kind: ENRICH_KIND,
        payload: changed ? { jobId: u.id, force: true } : { jobId: u.id },
        options: { dedupeKey: `${ENRICH_KIND}:${u.id}:v${hash.slice(0, 12)}`, brand: ctx.brand },
      });
    }
  }
  await applyDedupe(ctx.db, ctx.market, jobs.map((j) => j.dedupeKey));
  if (enrich.length) {
    const enqueue = ctx.enqueueMany ?? ((items: EnqueueManyItem[]) => platformEnqueueMany(items));
    result.enrichQueued = (await enqueue(enrich)).inserted;
  }
  return result;
}

// ── Leasing, budgets and query bookkeeping ───────────────────────────────

export interface LeasedQueryRow {
  id: string;
  market: string;
  provider: string;
  params: unknown;
  origin: string;
  demandScore: number;
  priority: number;
  consecutiveEmpty: number;
}

/** The lease statement (exported for the SQL snapshot test). */
export function buildLeaseSql(market: Market, providers: string[], limit: number, ids: string[] | null = null): Prisma.Sql {
  const idFilter = ids ? Prisma.sql`AND "id" = ANY(${ids}::text[])` : Prisma.empty;
  return Prisma.sql`
    UPDATE "RAIngestQuery" SET "nextRunAt" = now() + interval '15 minutes'
    WHERE "id" IN (
      SELECT "id" FROM "RAIngestQuery"
      WHERE "enabled" = true AND "market" = ${market} AND "provider" = ANY(${providers}::text[]) AND "nextRunAt" <= now() ${idFilter}
      ORDER BY "priority" ASC, "nextRunAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "market", "provider", "params", "origin", "demandScore", "priority", "consecutiveEmpty"`;
}

/** Leases up to `limit` due queries of the given providers (SKIP LOCKED: concurrent ticks never share one). */
export async function leaseDueQueries(db: IngestDb, market: Market, providers: string[], limit: number, ids: string[] | null = null): Promise<LeasedQueryRow[]> {
  if (providers.length === 0 || limit <= 0 || (ids && ids.length === 0)) return [];
  return db.$queryRaw<LeasedQueryRow[]>(buildLeaseSql(market, providers, limit, ids));
}

/** Atomically reserves one call against the provider's daily budget. False = budget spent. */
export async function reserveProviderCall(db: IngestDb, provider: string, day: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const rows = await db.$queryRaw<Array<{ calls: number }>>`
    INSERT INTO "RAProviderUsage" ("provider", "dayKey", "calls") VALUES (${provider}, ${day}, 1)
    ON CONFLICT ("provider", "dayKey") DO UPDATE SET "calls" = "RAProviderUsage"."calls" + 1
    WHERE "RAProviderUsage"."calls" < ${limit}::int
    RETURNING "calls"`;
  return rows.length > 0;
}

/** Adds yield counters (and, for unmetered sources, the calls) to today's usage row. */
export async function recordProviderUsage(
  db: IngestDb,
  provider: string,
  day: string,
  counts: { calls?: number; returned?: number; inserted?: number; errors?: number },
): Promise<void> {
  const calls = counts.calls ?? 0;
  const returned = counts.returned ?? 0;
  const inserted = counts.inserted ?? 0;
  const errors = counts.errors ?? 0;
  await db.$executeRaw`
    INSERT INTO "RAProviderUsage" ("provider", "dayKey", "calls", "jobsReturned", "jobsNew", "errors")
    VALUES (${provider}, ${day}, ${calls}::int, ${returned}::int, ${inserted}::int, ${errors}::int)
    ON CONFLICT ("provider", "dayKey") DO UPDATE SET
      "calls" = "RAProviderUsage"."calls" + EXCLUDED."calls",
      "jobsReturned" = "RAProviderUsage"."jobsReturned" + EXCLUDED."jobsReturned",
      "jobsNew" = "RAProviderUsage"."jobsNew" + EXCLUDED."jobsNew",
      "errors" = "RAProviderUsage"."errors" + EXCLUDED."errors"`;
}

/** Next UTC midnight + 5 minutes (a provider's budget resets with the day key). */
export function nextBudgetDay(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
  return d;
}

async function deferQuery(db: IngestDb, id: string, until: Date): Promise<void> {
  await db.$executeRaw`UPDATE "RAIngestQuery" SET "nextRunAt" = ${until}::timestamp(3) WHERE "id" = ${id}`;
}

/**
 * Pushes every due query of a provider (optionally of one origin) to `until`
 * in one statement, so later ticks do not lease them only to find the budget
 * spent. Includes the query just leased (its nextRunAt is in the future).
 */
export function buildDeferProviderSql(market: Market, provider: string, until: Date, origin: IngestOrigin | null): Prisma.Sql {
  const originFilter = origin ? Prisma.sql`AND "origin" = ${origin}` : Prisma.empty;
  return Prisma.sql`
    UPDATE "RAIngestQuery" SET "nextRunAt" = ${until}::timestamp(3)
    WHERE "market" = ${market} AND "provider" = ${provider} AND "enabled" = true
      AND "nextRunAt" < ${until}::timestamp(3) ${originFilter}`;
}

async function finishQuery(
  db: IngestDb,
  id: string,
  data: { now: Date; next: Date; seen: number; inserted: number; consecutiveEmpty: number; error: string | null; params: IngestQueryParams },
): Promise<void> {
  await db.$executeRaw`
    UPDATE "RAIngestQuery" SET
      "lastRunAt" = ${data.now}::timestamp(3),
      "nextRunAt" = ${data.next}::timestamp(3),
      "lastSeenCount" = ${data.seen}::int,
      "lastNewCount" = ${data.inserted}::int,
      "consecutiveEmpty" = ${data.consecutiveEmpty}::int,
      "lastError" = ${data.error}::text,
      "params" = ${JSON.stringify(data.params)}::jsonb
    WHERE "id" = ${id}`;
}

function toSourceQuery(row: LeasedQueryRow): SourceQuery {
  const p = (row.params && typeof row.params === 'object' ? row.params : {}) as Partial<IngestQueryParams>;
  return {
    id: row.id,
    provider: row.provider as SourceQuery['provider'],
    market: row.market as Market,
    origin: row.origin as IngestOrigin,
    params: { q: p.q ?? '', country: p.country ?? '*', datePosted: p.datePosted ?? 'week', ...p },
  };
}

export interface QueryRunResult {
  queryId: string;
  provider: string;
  /** 'budget': the provider's day is spent; 'seed_budget': only the seeds' share is. */
  status: 'ok' | 'error' | 'budget' | 'seed_budget' | 'disabled';
  calls: number;
  process?: ProcessResult;
  closed?: number;
  /** Cursor sources with more rows waiting. */
  more?: boolean;
}

/** Runs one leased query end to end. Never throws for provider failures (DB errors propagate). */
export async function runIngestQuery(ctx: PipelineContext, adapter: JobSourceAdapter, row: LeasedQueryRow): Promise<QueryRunResult> {
  const query = toSourceQuery(row);
  const day = dayKey(ctx.now);
  const base: QueryRunResult = { queryId: query.id, provider: adapter.provider, status: 'ok', calls: 0 };
  if (!adapter.isEnabled()) {
    await deferQuery(ctx.db, query.id, new Date(ctx.now.getTime() + REFRESH.errorRetryMs));
    return { ...base, status: 'disabled' };
  }
  const limit = adapter.dailyCallLimit();
  if (limit !== null) {
    // SEO seeds may use only part of the day's calls, so demand (users' own
    // searches, onboarding) always finds budget left.
    const isSeed = query.origin === 'seo_seed';
    const effective = isSeed ? Math.floor(limit * seedBudgetShare()) : limit;
    if (!(await reserveProviderCall(ctx.db, adapter.provider, day, effective))) {
      await ctx.db.$executeRaw(buildDeferProviderSql(ctx.market, adapter.provider, nextBudgetDay(ctx.now), isSeed ? 'seo_seed' : null));
      return { ...base, status: isSeed ? 'seed_budget' : 'budget' };
    }
  }

  const fetched = await adapter.fetch(query, { now: ctx.now, signal: ctx.signal });
  const extraCalls = limit === null ? fetched.calls : Math.max(0, fetched.calls - 1);
  if (fetched.error) {
    await recordProviderUsage(ctx.db, adapter.provider, day, { calls: extraCalls, errors: 1 });
    await finishQuery(ctx.db, query.id, {
      now: ctx.now,
      next: new Date(ctx.now.getTime() + REFRESH.errorRetryMs),
      seen: 0,
      inserted: 0,
      consecutiveEmpty: row.consecutiveEmpty,
      error: fetched.error.slice(0, 300),
      params: query.params,
    });
    return { ...base, status: 'error', calls: fetched.calls };
  }

  const processed = await processJobs(ctx, adapter, fetched.jobs, { countryHint: query.params.country });
  let closed = 0;
  if (fetched.closedExternalIds?.length) {
    for (const board of adapter.sourceBoards) closed += await archiveClosedBankJobs(ctx.db, board, fetched.closedExternalIds, ctx.now);
  }
  await recordProviderUsage(ctx.db, adapter.provider, day, { calls: extraCalls, returned: fetched.jobs.length, inserted: processed.inserted });
  // SR-16b-1: only a search run that returned postings counts (an empty page is inconclusive).
  if (ctx.perQueryTracking && adapter.kind === 'search' && fetched.jobs.length > 0) {
    await recordCountedRun(ctx.db, query.id, processed.jobIds);
  }

  const seen = fetched.jobs.length;
  const isCursor = adapter.kind === 'cursor';
  const more = isCursor && fetched.exhausted === false;
  const consecutiveEmpty = isCursor ? 0 : seen === 0 ? row.consecutiveEmpty + 1 : 0;
  const params: IngestQueryParams = isCursor && fetched.cursor ? { ...query.params, cursor: fetched.cursor } : query.params;
  const next = more
    ? ctx.now
    : new Date(ctx.now.getTime() + nextRunDelayMs({ origin: query.origin, demandScore: row.demandScore, consecutiveEmpty }));
  await finishQuery(ctx.db, query.id, { now: ctx.now, next, seen, inserted: processed.inserted, consecutiveEmpty, error: null, params });
  return { ...base, calls: fetched.calls, process: processed, closed, more };
}
