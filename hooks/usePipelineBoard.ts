'use client';

// hooks/usePipelineBoard.ts
//
// Data layer for /applications. Reads the whole tracker once (the views are
// not paginated; 200 is the API max) and exposes:
//
//   • the entries + statusCounts + total (every view, the nav badge and the
//     header counts share this one TanStack cache entry),
//   • `usePatchPipelineStatus` (optimistic) used by drag-to-move and the
//     card's stage menu.
//
// The read and the stage move are the pre-clone calls on the frozen
// lib/api/v2 client (TASK_PLAN.md §2.1 rule 9: existing calls may stay;
// new ones go through lib/api/tracker.ts). The server response gained the
// clone fields additively, so the entries are typed with the tracker
// contract's `TrackerEntryView` here.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type { RATrackerStatus } from '../lib/api/v2';
import type { TrackerEntryView, TrackerStatus } from '../lib/api/contracts/tracker';

export const pipelineKeys = {
  all: ['v3', 'pipeline'] as const,
  board: () => ['v3', 'pipeline', 'board'] as const,
};

const BOARD_LIMIT = 200;

export interface PipelineBoardData {
  entries: TrackerEntryView[];
  statusCounts: Record<string, number>;
  total: number;
}

/** Read the full tracker for /applications (entries + counts). */
export function usePipelineBoard(): UseQueryResult<PipelineBoardData, Error> {
  return useQuery({
    queryKey: pipelineKeys.board(),
    queryFn: async () => {
      const res = await raV2Api.tracker.list({ limit: BOARD_LIMIT });
      return {
        entries: res.entries as unknown as TrackerEntryView[],
        statusCounts: res.statusCounts as Record<string, number>,
        total: res.total,
      } satisfies PipelineBoardData;
    },
  });
}

/** Replace one entry in the cached board (after a drawer save or a create). */
export function upsertBoardEntry(prev: PipelineBoardData | undefined, entry: TrackerEntryView): PipelineBoardData | undefined {
  if (!prev) return prev;
  const exists = prev.entries.some((e) => e.id === entry.id);
  const before = prev.entries.find((e) => e.id === entry.id);
  const statusCounts = { ...prev.statusCounts };
  if (before && before.status !== entry.status) {
    statusCounts[before.status] = Math.max(0, (statusCounts[before.status] ?? 0) - 1);
    statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  }
  if (!exists) statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  return {
    entries: exists ? prev.entries.map((e) => (e.id === entry.id ? entry : e)) : [entry, ...prev.entries],
    statusCounts,
    total: exists ? prev.total : prev.total + 1,
  };
}

/**
 * Move a tracker entry to a new status (column). Optimistic: the card jumps
 * columns immediately, rolling back if the write fails. On settle we refetch so
 * the board re-syncs with the server-derived `dateApplied` / `outcome`.
 */
export function usePatchPipelineStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: TrackerStatus }) =>
      raV2Api.tracker.patch(id, { status: status as RATrackerStatus }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: pipelineKeys.board() });
      const prev = qc.getQueryData<PipelineBoardData>(pipelineKeys.board());
      const moved = prev?.entries.find((e) => e.id === id);
      if (prev && moved) {
        const nowIso = new Date().toISOString();
        const applied = (status === 'applied' || status === 'applying') && !moved.dateApplied;
        qc.setQueryData<PipelineBoardData>(
          pipelineKeys.board(),
          upsertBoardEntry(prev, { ...moved, status, dateApplied: applied ? nowIso : moved.dateApplied, updatedAt: nowIso }),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(pipelineKeys.board(), ctx.prev);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: pipelineKeys.board() });
      qc.invalidateQueries({ queryKey: ['tracker', 'events', vars.id] });
      qc.invalidateQueries({ queryKey: ['tracker', 'follow-ups'] });
    },
  });
}
