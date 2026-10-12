// server/src/platform/queue/enqueue.ts
//
// Producer side of the durable work queue (`RAWorkItem`, ARCHITECTURE.md §2.3
// and §4.6). One row per unit of work; `drain.ts` leases and runs them.
//
//   await enqueue('job.enrich', { jobId }, { dedupeKey: `job.enrich:${jobId}:v3` });
//
// - `brand` defaults to the current unit of work's brand (request, cron or
//   worker context) so the worker later runs inside the same brand. Outside
//   any brand context, a user's item takes the user's stored `User.brand`
//   (never the default brand: a GoApply user's work must not run as
//   RoboApply); only unowned system work falls back to the default brand.
// - `dedupeKey` makes enqueue idempotent: a second call with the same key
//   returns the existing item untouched (`onConflict: 'keep'`), or puts a
//   finished/dead item back in the queue (`onConflict: 'requeue'`). A leased
//   item is never disturbed.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { getCurrentBrandId } from '../../lib/requestContext.js';
import { DEFAULT_BRAND, type BrandId } from '../brand/registry.js';
import { brandOfUser } from '../brand/userBrand.js';

export type WorkStatus = 'queued' | 'leased' | 'done' | 'failed' | 'dead';

export const WORK_STATUSES: readonly WorkStatus[] = ['queued', 'leased', 'done', 'failed', 'dead'];

/** Default retry ceiling (schema default). */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Default priority (schema default; lower runs first). */
export const DEFAULT_PRIORITY = 100;

export type QueueDb = Pick<typeof prisma, 'rAWorkItem' | '$queryRaw' | '$executeRaw'>;

export interface EnqueueOptions {
  dedupeKey?: string;
  /** Earliest time the item may run (default now). */
  runAfter?: Date;
  /** Delay in ms from now; ignored when `runAfter` is set. */
  delayMs?: number;
  priority?: number;
  maxAttempts?: number;
  /** Defaults to the current context's brand, then the user's stored brand (`userId`), then the default brand (no user). */
  brand?: BrandId;
  userId?: string | null;
  /** What to do when `dedupeKey` already exists (default 'keep'). */
  onConflict?: 'keep' | 'requeue';
  db?: QueueDb;
  now?: () => Date;
}

export interface EnqueuedItem {
  id: string;
  kind: string;
  status: WorkStatus;
  dedupeKey: string | null;
  /** False when an existing item was returned for the dedupe key. */
  created: boolean;
}

const KIND_RE = /^[a-z][a-z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;

export function assertValidKind(kind: string): void {
  if (!KIND_RE.test(kind) || kind.length > 64) {
    throw new Error(`queue: invalid work kind "${kind}" (use dotted lowercase, e.g. "job.enrich")`);
  }
}

async function resolveBrand(brand: BrandId | undefined, userId: string | null | undefined): Promise<BrandId> {
  const known = brand ?? getCurrentBrandId();
  if (known) return known;
  if (!userId) return DEFAULT_BRAND;
  const stored = await brandOfUser(userId);
  if (!stored) throw new Error(`queue: cannot enqueue for user ${userId} without a brand (no brand context and no stored User.brand)`);
  return stored;
}

function toJson(payload: unknown): Prisma.InputJsonValue {
  if (payload === undefined) return {};
  // Round-trip drops undefined/functions and fails fast on cycles or BigInt.
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === 'P2002';
}

/** Add one unit of work. Idempotent per `dedupeKey`. */
export async function enqueue(kind: string, payload: unknown, options: EnqueueOptions = {}): Promise<EnqueuedItem> {
  assertValidKind(kind);
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  const runAfter = options.runAfter ?? new Date(now().getTime() + Math.max(0, options.delayMs ?? 0));
  const data = {
    kind,
    payload: toJson(payload),
    brand: await resolveBrand(options.brand, options.userId),
    userId: options.userId ?? null,
    priority: options.priority ?? DEFAULT_PRIORITY,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    runAfter,
    dedupeKey: options.dedupeKey ?? null,
  };
  const select = { id: true, kind: true, status: true, dedupeKey: true } as const;

  if (!options.dedupeKey) {
    const row = await db.rAWorkItem.create({ data, select });
    return { ...row, status: row.status as WorkStatus, created: true };
  }

  const existing = await db.rAWorkItem.findUnique({ where: { dedupeKey: options.dedupeKey }, select });
  if (!existing) {
    try {
      const row = await db.rAWorkItem.create({ data, select });
      return { ...row, status: row.status as WorkStatus, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race with a concurrent producer: fall through to the conflict rule.
    }
  }

  const current = existing ?? (await db.rAWorkItem.findUnique({ where: { dedupeKey: options.dedupeKey }, select }));
  if (!current) throw new Error(`queue: dedupe item ${options.dedupeKey} vanished during enqueue`);
  if (options.onConflict === 'requeue' && current.status !== 'queued' && current.status !== 'leased') {
    const { count } = await db.rAWorkItem.updateMany({
      where: { id: current.id, status: { notIn: ['queued', 'leased'] } },
      data: {
        status: 'queued',
        payload: data.payload,
        runAfter: data.runAfter,
        priority: data.priority,
        maxAttempts: data.maxAttempts,
        attempts: 0,
        lastError: null,
        leasedUntil: null,
        leaseOwner: null,
      },
    });
    if (count > 0) return { ...current, status: 'queued', created: false };
  }
  return { ...current, status: current.status as WorkStatus, created: false };
}

export interface EnqueueManyItem {
  kind: string;
  payload: unknown;
  options?: Omit<EnqueueOptions, 'db' | 'now' | 'onConflict'>;
}

/**
 * Bulk enqueue (e.g. a reminders producer). Items whose dedupe key already
 * exists are skipped (never re-queued). Returns how many rows were inserted.
 */
export async function enqueueMany(
  items: EnqueueManyItem[],
  options: { db?: QueueDb; now?: () => Date } = {},
): Promise<{ inserted: number }> {
  if (items.length === 0) return { inserted: 0 };
  const db = options.db ?? prisma;
  const now = options.now ?? (() => new Date());
  for (const { kind } of items) assertValidKind(kind);
  const brands = await Promise.all(items.map(({ options: o = {} }) => resolveBrand(o.brand, o.userId)));
  const rows = items.map(({ kind, payload, options: o = {} }, i) => {
    return {
      kind,
      payload: toJson(payload),
      brand: brands[i]!,
      userId: o.userId ?? null,
      priority: o.priority ?? DEFAULT_PRIORITY,
      maxAttempts: Math.max(1, o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      runAfter: o.runAfter ?? new Date(now().getTime() + Math.max(0, o.delayMs ?? 0)),
      dedupeKey: o.dedupeKey ?? null,
    };
  });
  const { count } = await db.rAWorkItem.createMany({ data: rows, skipDuplicates: true });
  return { inserted: count };
}
