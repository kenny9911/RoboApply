'use client';

// hooks/usePipelineBoard.ts
//
// Data layer for the V3 Pipeline screen (IA Route 8, `/tracker`). Reads the
// full tracker via `tracker.list()` and exposes:
//
//   • the raw entries + statusCounts + total (for the header count line),
//   • a `patchStatus` mutation (optimistic) used by both drag-to-move and the
//     per-card status <select> fallback,
//
// Query key is namespaced `['v3', 'pipeline', 'board']` so it doesn't collide
// with the V2 tracker caches (`['v2','tracker',…]`) or the Home funnel
// (`['v2','home','tracker']`) — those keep their own lifecycles.
//
// Column model lives in `lib/v3/pipelineColumns.ts` (shared with the board so
// the mapping is defined exactly once). The mutation writes a single canonical
// `RATrackerStatus` (the column's `status`), which keeps drag targets
// unambiguous and the `count(visible) = Σ column counts` invariant intact.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  RATrackerEntryView,
  RATrackerStatus,
  TrackerListResponse,
} from '../lib/api/v2';

export const pipelineKeys = {
  all: ['v3', 'pipeline'] as const,
  board: () => ['v3', 'pipeline', 'board'] as const,
};

// Pull a generous page so every active conversation lands on the board in one
// read (the board is not paginated). 200 is the stub/API max.
const BOARD_LIMIT = 200;

export interface PipelineBoardData {
  entries: RATrackerEntryView[];
  statusCounts: Record<RATrackerStatus, number>;
  total: number;
}

/** Read the full tracker for the Pipeline board (entries + counts). */
export function usePipelineBoard(): UseQueryResult<PipelineBoardData, Error> {
  return useQuery({
    queryKey: pipelineKeys.board(),
    queryFn: async () => {
      const res = await raV2Api.tracker.list({ limit: BOARD_LIMIT });
      return {
        entries: res.entries,
        statusCounts: res.statusCounts,
        total: res.total,
      } satisfies PipelineBoardData;
    },
  });
}

/**
 * Move a tracker entry to a new status (column). Optimistic: the card jumps
 * columns immediately, rolling back if the write fails. On settle we refetch so
 * the board re-syncs with the server-derived `dateApplied` / `updatedAt`.
 */
export function usePatchPipelineStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: RATrackerStatus }) =>
      raV2Api.tracker.patch(id, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: pipelineKeys.board() });
      const prev = qc.getQueryData<PipelineBoardData>(pipelineKeys.board());
      if (prev) {
        const nowIso = new Date().toISOString();
        const nextEntries = prev.entries.map((e) =>
          e.id === id
            ? {
                ...e,
                status,
                // Mirror the stub/API: first move into `applied` stamps a date.
                dateApplied:
                  status === 'applied' && !e.dateApplied ? nowIso : e.dateApplied,
                updatedAt: nowIso,
              }
            : e,
        );
        const moved = prev.entries.find((e) => e.id === id);
        const nextCounts = { ...prev.statusCounts };
        if (moved && moved.status !== status) {
          nextCounts[moved.status] = Math.max(0, nextCounts[moved.status] - 1);
          nextCounts[status] = (nextCounts[status] ?? 0) + 1;
        }
        qc.setQueryData<PipelineBoardData>(pipelineKeys.board(), {
          ...prev,
          entries: nextEntries,
          statusCounts: nextCounts,
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(pipelineKeys.board(), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.board() });
    },
  });
}

/**
 * Soft-delete a tracker entry (server stamps `deletedAt`; the row is retained
 * but hidden from every read). Optimistic: the card vanishes from the board
 * immediately and its column count drops by one, rolling back if the write
 * fails. On settle we refetch so the board re-syncs with the server.
 */
export function useDeletePipelineEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => raV2Api.tracker.delete(id),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: pipelineKeys.board() });
      const prev = qc.getQueryData<PipelineBoardData>(pipelineKeys.board());
      if (prev) {
        const removed = prev.entries.find((e) => e.id === id);
        const nextCounts = { ...prev.statusCounts };
        if (removed) {
          nextCounts[removed.status] = Math.max(
            0,
            (nextCounts[removed.status] ?? 0) - 1,
          );
        }
        qc.setQueryData<PipelineBoardData>(pipelineKeys.board(), {
          ...prev,
          entries: prev.entries.filter((e) => e.id !== id),
          statusCounts: nextCounts,
          total: Math.max(0, prev.total - (removed ? 1 : 0)),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(pipelineKeys.board(), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: pipelineKeys.board() });
    },
  });
}
