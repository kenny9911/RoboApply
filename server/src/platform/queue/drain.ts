// server/src/platform/queue/drain.ts
//
// Consumer side of the work queue (ARCHITECTURE.md §4.6):
//   - a handler registry: each area exports `workers` from
//     server/src/features/<area>/workers.ts; server/src/platform/queue/registry.ts
//     (FND-5) imports them all and calls `registerWorkers(...)`;
//   - `drain(kinds, { budgetMs, concurrency })`: leases due items with
//     `FOR UPDATE SKIP LOCKED`, sets `leasedUntil = now + 5 min`, runs each
//     inside `runWithBrand(item.brand)`, retries with exponential backoff up
//     to `maxAttempts`, then marks the item `dead`.
//
// Only kinds that have a registered handler are leased: items of a kind whose
// area is still a stub stay `queued` until the owner registers it.
// An expired lease (a worker that crashed or ran out of time) is picked up
// again; the attempt it used counts.

import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { runWithBrand } from '../../lib/requestContext.js';
import { logger } from '../../services/LoggerService.js';
import { allowedBrands } from '../brand/runtime.js';
import { DEFAULT_BRAND, isBrandId, type BrandId } from '../brand/registry.js';
import { createBudget, type Budget, type Clock } from './runForBudget.js';
import { assertValidKind, type QueueDb } from './enqueue.js';

/** Lease length (ARCH §4.6). */
export const LEASE_MS = 5 * 60_000;
/** Backoff base and ceiling for retries: 30 s, 60 s, 120 s … capped at 6 h. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** A leased item as handed to a worker. */
export interface LeasedWorkItem<P = Prisma.JsonValue> {
  id: string;
  kind: string;
  brand: BrandId;
  userId: string | null;
  payload: P;
  /** This run's attempt number (1-based). */
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  priority: number;
}

export interface WorkerContext {
  /** The drain's budget; a long handler should check `budget.remainingMs()`. */
  budget: Budget;
  leaseOwner: string;
}

export type WorkerHandler<P = Prisma.JsonValue> = (item: LeasedWorkItem<P>, ctx: WorkerContext) => Promise<void>;

export interface WorkerDefinition<P = Prisma.JsonValue> {
  kind: string;
  handler: WorkerHandler<P>;
  /** Concurrency cap for this kind within one drain call (default: the drain's). */
  concurrency?: number;
}

/** Throw from a handler to skip retries and mark the item `dead` at once. */
export class PermanentWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentWorkError';
  }
}

/**
 * Throw from a handler to put the item back without spending an attempt
 * (e.g. a provider budget is exhausted until tomorrow).
 */
export class DeferWorkError extends Error {
  readonly delayMs: number;
  constructor(delayMs: number, message = 'deferred') {
    super(message);
    this.name = 'DeferWorkError';
    this.delayMs = Math.max(0, delayMs);
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

const registry = new Map<string, WorkerDefinition<any>>();

export function registerWorker<P = Prisma.JsonValue>(def: WorkerDefinition<P>): void {
  assertValidKind(def.kind);
  const existing = registry.get(def.kind);
  if (existing && existing.handler !== def.handler) {
    throw new Error(`queue: a worker for "${def.kind}" is already registered`);
  }
  registry.set(def.kind, def as WorkerDefinition<any>);
}

export function registerWorkers(defs: readonly WorkerDefinition<any>[]): void {
  for (const def of defs) registerWorker(def);
}

export function registeredKinds(): string[] {
  return [...registry.keys()].sort();
}

export function getWorker(kind: string): WorkerDefinition<any> | undefined {
  return registry.get(kind);
}

/** Tests only. */
export function resetWorkerRegistryForTests(): void {
  registry.clear();
}

// ── Backoff ──────────────────────────────────────────────────────────────

/** Delay before retry number `attempt + 1` (attempt is the 1-based attempt that just failed). */
export function backoffMs(attempt: number, baseMs: number = BACKOFF_BASE_MS, maxMs: number = BACKOFF_MAX_MS): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** (n - 1));
}

// ── Lease ────────────────────────────────────────────────────────────────

interface LeasedRow {
  id: string;
  kind: string;
  brand: string | null;
  userId: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  priority: number;
}

export interface LeaseOptions {
  kinds: string[];
  brands: BrandId[];
  limit: number;
  owner: string;
  now: Date;
  leaseMs?: number;
  db?: QueueDb;
}

/**
 * Atomically claim up to `limit` due items. Concurrent drains never claim the
 * same row: the inner SELECT locks with `FOR UPDATE SKIP LOCKED`. Expired
 * leases are claimable again. Rows with no brand are claimed only by a
 * deployment that serves the default brand.
 */
export async function leaseWorkItems(options: LeaseOptions): Promise<LeasedWorkItem[]> {
  const db = options.db ?? prisma;
  if (options.kinds.length === 0 || options.brands.length === 0 || options.limit <= 0) return [];
  const leaseUntil = new Date(options.now.getTime() + (options.leaseMs ?? LEASE_MS));
  const includeUnbranded = options.brands.includes(DEFAULT_BRAND);
  const rows = await db.$queryRaw<LeasedRow[]>`
    WITH picked AS (
      SELECT id FROM "RAWorkItem"
      WHERE kind = ANY(${options.kinds}::text[])
        AND (brand = ANY(${options.brands}::text[]) OR (brand IS NULL AND ${includeUnbranded}::boolean))
        AND (
          (status = 'queued' AND "runAfter" <= ${options.now})
          OR (status = 'leased' AND "leasedUntil" < ${options.now})
        )
      ORDER BY priority ASC, "runAfter" ASC, "createdAt" ASC
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "RAWorkItem" AS w
    SET status = 'leased',
        "leasedUntil" = ${leaseUntil},
        "leaseOwner" = ${options.owner},
        attempts = w.attempts + 1,
        "updatedAt" = ${options.now}
    FROM picked
    WHERE w.id = picked.id
    RETURNING w.id, w.kind, w.brand, w."userId", w.payload, w.attempts, w."maxAttempts", w."dedupeKey", w.priority`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    brand: isBrandId(r.brand) ? r.brand : DEFAULT_BRAND,
    userId: r.userId,
    payload: r.payload,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.maxAttempts),
    dedupeKey: r.dedupeKey,
    priority: Number(r.priority),
  }));
}

// ── Completion ───────────────────────────────────────────────────────────

type Outcome = 'done' | 'retried' | 'dead' | 'deferred' | 'lost';

function errorText(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, 2000);
}

/** Every write is guarded by `leaseOwner` so a worker whose lease expired never overwrites a newer run. */
async function settle(
  db: QueueDb,
  item: LeasedWorkItem,
  owner: string,
  now: Date,
  err: unknown | null,
): Promise<Outcome> {
  const where = { id: item.id, status: 'leased', leaseOwner: owner };
  let data: Prisma.RAWorkItemUpdateManyMutationInput;
  let outcome: Outcome;
  if (err === null) {
    data = { status: 'done', leasedUntil: null, lastError: null };
    outcome = 'done';
  } else if (err instanceof DeferWorkError) {
    data = {
      status: 'queued',
      leasedUntil: null,
      leaseOwner: null,
      runAfter: new Date(now.getTime() + err.delayMs),
      attempts: { decrement: 1 },
      lastError: errorText(err),
    };
    outcome = 'deferred';
  } else if (err instanceof PermanentWorkError || item.attempts >= item.maxAttempts) {
    data = { status: 'dead', leasedUntil: null, lastError: errorText(err) };
    outcome = 'dead';
  } else {
    data = {
      status: 'queued',
      leasedUntil: null,
      leaseOwner: null,
      runAfter: new Date(now.getTime() + backoffMs(item.attempts)),
      lastError: errorText(err),
    };
    outcome = 'retried';
  }
  const { count } = await db.rAWorkItem.updateMany({ where, data });
  return count > 0 ? outcome : 'lost';
}

// ── Drain ────────────────────────────────────────────────────────────────

export interface DrainOptions {
  budgetMs?: number;
  /** Items run in parallel per batch (default 4). */
  concurrency?: number;
  /** Stop leasing when this many ms remain (default 15 s: room to finish a batch). */
  reserveMs?: number;
  /** Brands this drain may run (default: the deployment's ALLOWED_BRANDS). */
  brands?: BrandId[];
  leaseMs?: number;
  db?: QueueDb;
  now?: Clock;
  /** Lease owner id (default random per call). */
  owner?: string;
}

export interface DrainResult {
  kinds: string[];
  leased: number;
  done: number;
  retried: number;
  dead: number;
  deferred: number;
  /** Items whose lease was taken over before they settled. */
  lost: number;
  batches: number;
  stoppedBy: 'no_handlers' | 'empty' | 'budget';
  ms: number;
}

/**
 * Lease and run due items of `kinds` (default: every registered kind) until
 * the queue is empty or the budget is spent. With no handlers registered it
 * returns at once without touching the database; with an empty queue it costs
 * one query.
 */
export async function drain(kinds?: string[] | null, options: DrainOptions = {}): Promise<DrainResult> {
  const db = options.db ?? prisma;
  const clock = options.now ?? Date.now;
  const budget = createBudget(options.budgetMs ?? 240_000, clock);
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const reserveMs = options.reserveMs ?? Math.min(15_000, Math.floor(budget.budgetMs / 4));
  const owner = options.owner ?? `drain-${crypto.randomUUID()}`;
  const brands = options.brands ?? allowedBrands();
  const wanted = (kinds && kinds.length ? kinds : registeredKinds()).filter((k) => registry.has(k));
  const result: DrainResult = {
    kinds: wanted,
    leased: 0,
    done: 0,
    retried: 0,
    dead: 0,
    deferred: 0,
    lost: 0,
    batches: 0,
    stoppedBy: 'empty',
    ms: 0,
  };
  if (wanted.length === 0) {
    result.stoppedBy = 'no_handlers';
    return result;
  }

  for (;;) {
    if (budget.exhausted(reserveMs)) {
      result.stoppedBy = 'budget';
      break;
    }
    const items = await leaseWorkItems({
      kinds: wanted,
      brands,
      limit: concurrency,
      owner,
      now: new Date(clock()),
      leaseMs: options.leaseMs,
      db,
    });
    if (items.length === 0) {
      result.stoppedBy = 'empty';
      break;
    }
    result.batches += 1;
    result.leased += items.length;
    const outcomes = await Promise.all(items.map((item) => runOne(db, item, owner, budget, clock)));
    for (const o of outcomes) result[o] += 1;
  }
  result.ms = budget.elapsedMs();
  return result;
}

async function runOne(db: QueueDb, item: LeasedWorkItem, owner: string, budget: Budget, clock: Clock): Promise<Outcome> {
  const def = registry.get(item.kind);
  let err: unknown | null = null;
  if (!def) {
    err = new PermanentWorkError(`no worker registered for ${item.kind}`);
  } else if (item.attempts > item.maxAttempts) {
    // An expired lease pushed the count past the ceiling.
    err = new PermanentWorkError('attempts exhausted');
  } else {
    try {
      await runWithBrand(item.brand, () => def.handler(item, { budget, leaseOwner: owner }));
    } catch (e) {
      err = e ?? new Error('worker failed');
    }
  }
  try {
    const outcome = await settle(db, item, owner, new Date(clock()), err);
    if (outcome === 'dead') {
      logger.warn('QUEUE', `work item dead: ${item.kind}`, { id: item.id, attempts: item.attempts, error: errorText(err) });
    } else if (outcome === 'retried') {
      logger.info('QUEUE', `work item retry scheduled: ${item.kind}`, { id: item.id, attempts: item.attempts });
    }
    return outcome;
  } catch (settleErr) {
    // The lease expires and the item is retried by a later drain.
    logger.error('QUEUE', `could not settle work item ${item.id}`, { error: errorText(settleErr) });
    return 'lost';
  }
}

// ── Maintenance ──────────────────────────────────────────────────────────

/** Delete settled items older than `olderThanDays` (done: 7 d default; dead kept 30 d for review). */
export async function pruneWorkItems(
  options: { db?: QueueDb; now?: Date; doneDays?: number; deadDays?: number } = {},
): Promise<{ deleted: number }> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const day = 24 * 60 * 60_000;
  const doneBefore = new Date(now.getTime() - (options.doneDays ?? 7) * day);
  const deadBefore = new Date(now.getTime() - (options.deadDays ?? 30) * day);
  const { count } = await db.rAWorkItem.deleteMany({
    where: {
      OR: [
        { status: 'done', updatedAt: { lt: doneBefore } },
        { status: { in: ['dead', 'failed'] }, updatedAt: { lt: deadBefore } },
      ],
    },
  });
  return { deleted: count };
}

/** Admin "retry": put a dead item back in the queue with fresh attempts. */
export async function retryDeadItem(id: string, options: { db?: QueueDb; now?: Date } = {}): Promise<boolean> {
  const db = options.db ?? prisma;
  const { count } = await db.rAWorkItem.updateMany({
    where: { id, status: { in: ['dead', 'failed'] } },
    data: {
      status: 'queued',
      attempts: 0,
      runAfter: options.now ?? new Date(),
      leasedUntil: null,
      leaseOwner: null,
      lastError: null,
    },
  });
  return count > 0;
}

