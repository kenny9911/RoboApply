// server/src/features/admin/queue.ts — work items list and the dead-item retry
// (ARCHITECTURE.md §10.4 "queue: depth by kind, dead items with retry").

import prisma from '../../lib/prisma.js';
import { httpError } from '../../platform/http.js';
import { retryDeadItem } from '../../platform/queue/index.js';
import type { WorkItemView, WorkItemsResponse } from './contract.js';

export const QUEUE_PAGE_SIZE = 50;
const ERROR_CHARS = 300;

export interface QueueStore {
  list(query: { status?: string; kind?: string; cursor?: string; take: number }): Promise<WorkItemView[]>;
  find(id: string): Promise<{ id: string; status: string; kind: string; brand: string | null; userId: string | null } | null>;
  retry(id: string): Promise<boolean>;
}

type Db = Pick<typeof prisma, 'rAWorkItem' | '$queryRaw' | '$executeRaw'>;

export function createPrismaQueueStore(db: Db = prisma): QueueStore {
  return {
    async list({ status, kind, cursor, take }) {
      const rows = await db.rAWorkItem.findMany({
        where: { ...(status ? { status } : { status: { in: ['dead', 'failed'] } }), ...(kind ? { kind } : {}) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, kind: true, status: true, brand: true, attempts: true, maxAttempts: true, runAfter: true, lastError: true, createdAt: true, updatedAt: true },
      });
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        brand: r.brand,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        runAfter: r.runAfter.toISOString(),
        lastError: r.lastError ? r.lastError.slice(0, ERROR_CHARS) : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
    find(id) {
      return db.rAWorkItem.findUnique({ where: { id }, select: { id: true, status: true, kind: true, brand: true, userId: true } });
    },
    retry(id) {
      return retryDeadItem(id, { db });
    },
  };
}

/** GET /system/queue — dead and failed items by default (newest first). */
export async function listWorkItems(store: QueueStore, query: { status?: string; kind?: string; cursor?: string }): Promise<WorkItemsResponse> {
  const rows = await store.list({ ...query, take: QUEUE_PAGE_SIZE + 1 });
  const items = rows.slice(0, QUEUE_PAGE_SIZE);
  return { items, cursor: rows.length > QUEUE_PAGE_SIZE ? items[items.length - 1]!.id : null };
}

/** POST /system/queue/:id/retry — only dead or failed items go back in the queue. */
export async function retryWorkItem(store: QueueStore, id: string): Promise<{ id: string; kind: string; status: 'queued' }> {
  const item = await store.find(id);
  if (!item) throw httpError('not_found', 'No work item with this id.');
  if (item.status !== 'dead' && item.status !== 'failed') throw httpError('conflict', 'Only dead or failed items can be retried.');
  if (!(await store.retry(id))) throw httpError('conflict', 'The item changed before it could be retried.');
  return { id, kind: item.kind, status: 'queued' };
}
