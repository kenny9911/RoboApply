// server/src/features/jobs/ingest/run.ts — the ingest tick and targeted ingest (ARCH §4.4, §4.6).
//
// `runIngestTick`: lease → run → repeat inside the cron's 240 s budget
// (`runForBudget`); returns in well under 2 s when nothing is due (one lease
// statement). Queries of a disabled provider are not leased at all.
// `ingestForProfile(searchProfileId, budgetMs)`: onboarding O6 (WP-30) — plans
// the profile's demand tuples now and runs the due ones within the budget;
// whatever does not fit is queued as `ingest.query` work items.

import type { EnvSource, ProductBrand } from '../../../platform/brand/index.js';
import { runForBudget, type Budget, type EnqueueManyItem } from '../../../platform/queue/index.js';
import type { JobSourceAdapter } from '../sources/index.js';
import { leaseBatch } from './config.js';
import type { IngestDb } from './db.js';
import { leaseDueQueries, runIngestQuery, type EnqueueManyFn, type PipelineContext, type QueryRunResult } from './pipeline.js';
import { ensureBankSyncQueries, planQueries, tuplesFromFilters, upsertPlannedQueries } from './planner.js';
import { emptyRunStatus, isSourceStatusNote, writeSourceStatus, type SourceRunStatus } from './status.js';
import { perQueryTrackingAvailable } from './tracking.js';

export const INGEST_QUERY_KIND = 'ingest.query';

/** A run's tally (logged by the cron runner). */
export interface IngestTally {
  queries: number;
  calls: number;
  received: number;
  inserted: number;
  updated: number;
  /** Postings dropped before the upsert (no apply link, private row, normalizer refusal …). */
  skippedRows: number;
  enrichQueued: number;
  closed: number;
  errors: number;
  budgetStops: string[];
  /** Skip tallies by reason, over every source of the run (wrong_market, no_apply_url, bank_no_public_page …). */
  notes: Record<string, number>;
}

export function emptyTally(): IngestTally {
  return { queries: 0, calls: 0, received: 0, inserted: 0, updated: 0, skippedRows: 0, enrichQueued: 0, closed: 0, errors: 0, budgetStops: [], notes: {} };
}

/** Adds one query's result to its source's run status (the admin sources panel reads it). */
export function addToSourceStatus(status: SourceRunStatus, r: QueryRunResult): void {
  if (r.status === 'budget' || r.status === 'seed_budget' || r.status === 'disabled') return;
  status.queries += 1;
  status.calls += r.calls;
  status.closed += r.closed ?? 0;
  if (r.status === 'error') {
    status.ok = false;
    status.error = r.error ?? 'error';
  }
  if (r.process) {
    status.received += r.process.received;
    status.written += r.process.written;
    status.inserted += r.process.inserted;
    status.skipped += r.process.skipped;
  }
  // Skip reasons and source counts only; informational notes stay in the log tally (addToTally).
  for (const [k, v] of Object.entries(r.notes ?? {})) if (isSourceStatusNote(k)) status.notes[k] = (status.notes[k] ?? 0) + v;
}

export function addToTally(t: IngestTally, r: QueryRunResult): void {
  t.queries += 1;
  t.calls += r.calls;
  if (r.status === 'error') t.errors += 1;
  if (r.status === 'budget' && !t.budgetStops.includes(r.provider)) t.budgetStops.push(r.provider);
  t.closed += r.closed ?? 0;
  for (const [k, v] of Object.entries(r.notes ?? {})) t.notes[k] = (t.notes[k] ?? 0) + v;
  if (r.process) {
    t.received += r.process.received;
    t.inserted += r.process.inserted;
    t.updated += r.process.updated;
    t.skippedRows += r.process.skipped;
    t.enrichQueued += r.process.enrichQueued;
  }
}

export interface TickOptions {
  db: IngestDb;
  brand: ProductBrand;
  adapters: readonly JobSourceAdapter[];
  budgetMs: number;
  now?: () => Date;
  env?: EnvSource;
  enqueueMany?: EnqueueManyFn;
  publicDisplayProviders?: readonly string[];
  /** Restrict to these query ids (targeted ingest / worker). */
  queryIds?: string[];
  /** SR-16b-1 tracking override (default: probed once, when the first query is leased). */
  perQueryTracking?: boolean;
}

/** Lease-and-run loop. A provider whose budget is spent is dropped for the rest of the tick. */
export async function runIngestTick(options: TickOptions): Promise<IngestTally & { stoppedBy: string }> {
  const now = options.now ?? (() => new Date());
  const tally = emptyTally();
  const enabled = new Map(options.adapters.filter((a) => a.isEnabled()).map((a) => [a.provider as string, a]));
  if (enabled.size === 0) return { ...tally, stoppedBy: 'no_providers' };
  const batch = leaseBatch(options.env);
  // Keep a margin to finish the query in flight: 5 s for a cron, 10% of a short (targeted) budget.
  const reserveMs = Math.min(5_000, Math.floor(options.budgetMs * 0.1));
  let tracking = options.perQueryTracking;
  const statuses = new Map<string, SourceRunStatus>();

  const run = await runForBudget(
    async (budget: Budget) => {
      const providers = [...enabled.keys()];
      if (providers.length === 0) return { processed: 0, more: false };
      const leased = await leaseDueQueries(options.db, options.brand.market, providers, batch, options.queryIds ?? null);
      if (leased.length === 0) return { processed: 0, more: false };
      tracking ??= await perQueryTrackingAvailable(options.db);
      for (const row of leased) {
        const adapter = enabled.get(row.provider);
        if (!adapter) continue;
        const ctx: PipelineContext = {
          db: options.db,
          brand: options.brand.id,
          market: options.brand.market,
          now: now(),
          enqueueMany: options.enqueueMany,
          publicDisplayProviders: options.publicDisplayProviders,
          perQueryTracking: tracking,
          // A source that makes several requests per fetch (the bank's HTTPS pass, the employer
          // boards) must stop inside what is left of this tick, not inside a budget of its own.
          budgetMs: Math.max(0, budget.remainingMs() - reserveMs),
        };
        const result = await runIngestQuery(ctx, adapter, row);
        addToTally(tally, result);
        let status = statuses.get(row.provider);
        if (!status) {
          let transport: string | null = null;
          try {
            transport = adapter.transport?.() ?? null;
          } catch {
            transport = null;
          }
          status = emptyRunStatus(ctx.now, transport);
          statuses.set(row.provider, status);
        }
        addToSourceStatus(status, result);
        if (result.status === 'budget') enabled.delete(row.provider);
        if (budget.exhausted(reserveMs)) break;
      }
      return { processed: leased.length, more: true };
    },
    { budgetMs: options.budgetMs, reserveMs, maxSteps: 500 },
  );
  // One status document per source that ran (never fails the tick).
  const finishedAt = now().toISOString();
  for (const [provider, status] of statuses) {
    if (status.queries === 0) continue;
    await writeSourceStatus(options.db, options.brand.market, provider, { ...status, at: finishedAt });
  }
  return { ...tally, stoppedBy: run.stoppedBy };
}

export interface TargetedIngestDeps {
  db: IngestDb;
  brand: ProductBrand;
  adapters: readonly JobSourceAdapter[];
  now?: () => Date;
  env?: EnvSource;
  enqueueMany?: EnqueueManyFn;
  publicDisplayProviders?: readonly string[];
  perQueryTracking?: boolean;
}

export interface TargetedIngestResult extends IngestTally {
  planned: number;
  /** Queries left for the queue (`ingest.query` items). */
  deferred: number;
}

/**
 * Targeted ingest for one search profile (onboarding O6, WP-30): plans its
 * demand tuples (origin 'demand', 1 user), runs the due ones within
 * `budgetMs`, and queues the rest. Queries refreshed recently are not re-run.
 */
export async function ingestForProfileWith(deps: TargetedIngestDeps, searchProfileId: string, budgetMs: number): Promise<TargetedIngestResult> {
  const now = deps.now ?? (() => new Date());
  const profile = await deps.db.rASearchProfile.findUnique({ where: { id: searchProfileId }, select: { id: true, userId: true, filters: true } });
  if (!profile) return { ...emptyTally(), planned: 0, deferred: 0 };
  const tuples = tuplesFromFilters(profile.filters, deps.brand).map((t) => ({ ...t, users: 1 }));
  const search = deps.adapters.filter((a) => a.kind === 'search' && a.isEnabled());
  const planned = planQueries(tuples, search);
  if (planned.length === 0) return { ...emptyTally(), planned: 0, deferred: 0 };
  await upsertPlannedQueries(deps.db, planned, now(), { targeted: true });
  await ensureBankSyncQueries(deps.db, deps.brand.market, deps.adapters);

  const ids = (
    await deps.db.rAIngestQuery.findMany({
      where: { OR: planned.map((p) => ({ provider: p.provider, paramsHash: p.paramsHash })) },
      select: { id: true },
    })
  ).map((r) => r.id);
  const tally = await runIngestTick({ ...deps, budgetMs, queryIds: ids });

  // Anything still due goes to the queue (the worker leases it by id).
  const left = await deps.db.rAIngestQuery.findMany({ where: { id: { in: ids }, enabled: true, nextRunAt: { lte: now() } }, select: { id: true } });
  let deferred = 0;
  if (left.length) {
    const day = now().toISOString().slice(0, 10);
    const items: EnqueueManyItem[] = left.map((r) => ({
      kind: INGEST_QUERY_KIND,
      payload: { queryId: r.id },
      options: { dedupeKey: `${INGEST_QUERY_KIND}:${r.id}:${day}`, brand: deps.brand.id, userId: profile.userId },
    }));
    const enqueue = deps.enqueueMany ?? (async (list: EnqueueManyItem[]) => (await import('../../../platform/queue/index.js')).enqueueMany(list));
    deferred = (await enqueue(items)).inserted;
  }
  return { ...tally, planned: planned.length, deferred };
}
