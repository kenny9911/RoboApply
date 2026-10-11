// server/src/features/jobs/ingest/run.ts — the ingest tick and targeted ingest (ARCH §4.4, §4.6).
//
// `runIngestTick`: lease → run → repeat inside the cron's 240 s budget
// (`runForBudget`); returns in well under 2 s when nothing is due (one lease
// statement). Queries of a disabled provider are not leased at all, with one
// exception: a metered provider whose plan quota stops ingest is leased once,
// so its due queries are parked in one statement (until the quota stops
// blocking, at most a day at a time: quota.ts `quotaParkUntil`) and the
// provider is reported under `budgetStops` (quota.ts).
// Fairness: a cursor source that keeps reporting more rows (a multi-run sweep,
// a feed backfill) steps aside once it has used INGEST_CURSOR_TICK_SHARE of
// the tick's budget (default 0.4), and each of its fetches is handed only
// what is left of that share, so users' demand queries are never starved
// (MARKET_STRATEGY §1.3). Its query stays due. When nothing else is due and
// the tick still has time, the sources that stepped aside get another share
// (the time would be idle otherwise: a tick with one cursor source and no
// demand gives it the whole tick, a share at a time); what is still unread at
// the end continues on the next tick. A source that finishes inside its share
// is not affected.
// `ingestForProfile(searchProfileId, budgetMs)`: onboarding O6 (WP-30) — plans
// the profile's demand tuples now and runs the due ones within the budget;
// whatever does not fit is queued as `ingest.query` work items.

import type { EnvSource, Market, ProductBrand } from '../../../platform/brand/index.js';
import { runForBudget, type Budget, type EnqueueManyItem } from '../../../platform/queue/index.js';
import { adapterEnabledFor } from '../sources/index.js';
import type { JobSourceAdapter } from '../sources/index.js';
import { cursorTickShare, leaseBatch } from './config.js';
import type { IngestDb } from './db.js';
import { deferQuery, leaseDueQueries, runIngestQuery, type EnqueueManyFn, type PipelineContext, type QueryRunResult } from './pipeline.js';
import { ensureBankSyncQueries, planQueries, tuplesFromFilters, upsertPlannedQueries } from './planner.js';
import { emptyRunStatus, isSourceStatusNote, writeSourceStatus, type SourceRunStatus } from './status.js';
import { flushProviderQuota, quotaAllows } from './quota.js';
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
  if (r.status === 'quota' || r.status === 'budget' || r.status === 'seed_budget' || r.status === 'disabled') return;
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
  // The provider's day is spent ('budget') or its plan's quota stops ingest ('quota').
  if ((r.status === 'budget' || r.status === 'quota') && !t.budgetStops.includes(r.provider)) t.budgetStops.push(r.provider);
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
  /** Millisecond clock of the tick's time budget (default Date.now; tests pass a fake). */
  clock?: () => number;
}

/** A metered adapter whose plan quota stops ingest right now (used up, refused, or down to the reserve). */
export function quotaStopsIngest(adapter: Pick<JobSourceAdapter, 'provider' | 'dailyCallLimit'>, now: Date, env: EnvSource = process.env): boolean {
  try {
    return adapter.dailyCallLimit() !== null && !quotaAllows(adapter.provider, 'ingest', now, env);
  } catch {
    return false;
  }
}

/**
 * Does the tick lease this adapter's queries? Yes when the adapter is on for
 * the market, and also when only its quota stops it: those queries are leased
 * once so they can be parked together (see the header).
 */
export function adapterRunsInTick(adapter: JobSourceAdapter, market: Market, now: Date, env: EnvSource = process.env): boolean {
  return adapterEnabledFor(adapter, market) || quotaStopsIngest(adapter, now, env);
}

/** Lease-and-run loop. A provider whose budget or quota is spent is dropped for the rest of the tick. */
export async function runIngestTick(options: TickOptions): Promise<IngestTally & { stoppedBy: string }> {
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const clock = options.clock ?? Date.now;
  const market = options.brand.market;
  const tally = emptyTally();
  const running = new Map(options.adapters.filter((a) => adapterRunsInTick(a, market, now(), env)).map((a) => [a.provider as string, a]));
  if (running.size === 0) return { ...tally, stoppedBy: 'no_providers' };
  // The sources still leased in this tick (a spent day, a quota stop or a used share takes one out).
  const enabled = new Map(running);
  const batch = leaseBatch(options.env);
  // Keep a margin to finish the query in flight: 5 s for a cron, 10% of a short (targeted) budget.
  const reserveMs = Math.min(5_000, Math.floor(options.budgetMs * 0.1));
  let tracking = options.perQueryTracking;
  const statuses = new Map<string, SourceRunStatus>();
  // Milliseconds each cursor source has used in this tick, and what one source may use while it reports more rows.
  const cursorMs = new Map<string, number>();
  const cursorShareMs = options.budgetMs * cursorTickShare(env);
  // Cursor sources that stepped aside because their share is used (their leased queries are handed back).
  const shareSpent = new Set<string>();
  const shareLeft = (provider: string): number => cursorShareMs - (cursorMs.get(provider) ?? 0);
  /** Gives the sources that stepped aside another share. False when none did. */
  const readmitShareSpent = (): boolean => {
    if (shareSpent.size === 0) return false;
    for (const provider of shareSpent) {
      const adapter = running.get(provider);
      if (adapter) enabled.set(provider, adapter);
      cursorMs.delete(provider);
    }
    shareSpent.clear();
    return true;
  };

  const run = await runForBudget(
    async (budget: Budget) => {
      const providers = [...enabled.keys()];
      const leased = providers.length > 0 ? await leaseDueQueries(options.db, options.brand.market, providers, batch, options.queryIds ?? null) : [];
      // Nothing else is due. Time that is left would be idle, so the cursor sources that stepped aside
      // for their share go on (demand that becomes due meanwhile is still leased with them, by priority).
      if (leased.length === 0) return { processed: 0, more: readmitShareSpent() };
      tracking ??= await perQueryTrackingAvailable(options.db);
      for (const [index, row] of leased.entries()) {
        let adapter = enabled.get(row.provider);
        // A cursor source whose share was used up by an earlier query of this tick does not start another one yet.
        if (adapter?.kind === 'cursor' && cursorMs.has(row.provider) && shareLeft(row.provider) <= reserveMs) {
          shareSpent.add(row.provider);
          enabled.delete(row.provider);
          adapter = undefined;
        }
        if (!adapter) {
          // Leased before its source stepped aside for its share: handed back, so it is due again at once
          // (a budget or quota stop already moved the provider's queries in one statement).
          if (shareSpent.has(row.provider)) await deferQuery(options.db, row.id, now());
          continue;
        }
        const ctx: PipelineContext = {
          db: options.db,
          brand: options.brand.id,
          market: options.brand.market,
          now: now(),
          enqueueMany: options.enqueueMany,
          publicDisplayProviders: options.publicDisplayProviders,
          perQueryTracking: tracking,
          // A source that makes several requests per fetch (the bank's HTTPS pass, the employer
          // boards) must stop inside what is left of this tick, not inside a budget of its own;
          // a cursor source also inside what is left of its share of the tick.
          budgetMs: Math.max(0, Math.min(budget.remainingMs() - reserveMs, adapter.kind === 'cursor' ? shareLeft(row.provider) : Number.POSITIVE_INFINITY)),
          env,
        };
        const startedAt = clock();
        const result = await runIngestQuery(ctx, adapter, row);
        addToTally(tally, result);
        if (adapter.kind === 'cursor') {
          cursorMs.set(row.provider, (cursorMs.get(row.provider) ?? 0) + Math.max(0, clock() - startedAt));
          // Still more rows and its share of the tick is used (less than the tick's own margin is left of it:
          // too little for another useful fetch): the query stays due and the source steps aside.
          if (result.more === true && shareLeft(row.provider) <= reserveMs) {
            shareSpent.add(row.provider);
            enabled.delete(row.provider);
          }
        }
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
        if (result.status === 'budget' || result.status === 'quota') enabled.delete(row.provider);
        if (budget.exhausted(reserveMs)) {
          // The tick is over. What was leased with this query and not run is made due again, so the next
          // tick runs it instead of waiting out a 15-minute lease (a cursor source that uses the tick to
          // its end makes this the usual way a tick stops). Queries a spent day or a quota stop already
          // moved stay where that statement put them.
          for (const rest of leased.slice(index + 1)) {
            if (enabled.has(rest.provider) || shareSpent.has(rest.provider)) await deferQuery(options.db, rest.id, now());
          }
          break;
        }
      }
      return { processed: leased.length, more: true };
    },
    { budgetMs: options.budgetMs, reserveMs, maxSteps: 500, now: clock },
  );
  // The quota readings and counted calls of this tick are written before the function returns.
  await flushProviderQuota();
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
  const search = deps.adapters.filter((a) => a.kind === 'search' && adapterEnabledFor(a, deps.brand.market));
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
