// useTracker — TanStack Query bindings for the tracker endpoints.
//
// Wraps `raV2Api.tracker.*` so the page + components don't talk to the API
// directly. Provides optimistic UI on patch/delete/create so status pill
// clicks and excitement-star edits feel instant — per FE arch §6.
//
// Query-key shape:
//   ['v2', 'tracker', 'list', <serialised filter>]
//   ['v2', 'tracker', 'detail', id]
//
// The serialised filter is the params object passed to `list()` — we
// JSON-stringify so two equivalent filters share a cache entry.

'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { raV2Api } from '../api/v2';
import type {
  RATrackerEntryView,
  RATrackerStatus,
  TrackerBulkBody,
  TrackerCreateBody,
  TrackerListParams,
  TrackerListResponse,
  TrackerPatchBody,
} from '../api/v2';

const KEY_BASE = ['v2', 'tracker'] as const;

function listKey(params?: TrackerListParams) {
  return [...KEY_BASE, 'list', JSON.stringify(params ?? {})] as const;
}

/** GET the tracker list (entries + statusCounts + total). */
export function useTracker(
  params?: TrackerListParams,
): UseQueryResult<TrackerListResponse> {
  return useQuery({
    queryKey: listKey(params),
    queryFn: () => raV2Api.tracker.list(params),
  });
}

/** PATCH a tracker entry — optimistic. */
export function useUpdateEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TrackerPatchBody }) =>
      raV2Api.tracker.patch(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: [...KEY_BASE, 'list'] });
      const snapshots: Array<{ key: readonly unknown[]; data: unknown }> = [];
      const caches = qc.getQueriesData<TrackerListResponse>({
        queryKey: [...KEY_BASE, 'list'],
      });
      for (const [key, data] of caches) {
        snapshots.push({ key, data });
        if (!data) continue;
        const nextEntries = data.entries.map((e) => {
          if (e.id !== id) return e;
          const merged: RATrackerEntryView = {
            ...e,
            status: patch.status ?? e.status,
            excitementStars:
              patch.excitementStars !== undefined
                ? patch.excitementStars
                : e.excitementStars,
            deadline:
              patch.deadline !== undefined ? patch.deadline : e.deadline,
            followUpAt:
              patch.followUpAt !== undefined ? patch.followUpAt : e.followUpAt,
            dateApplied:
              patch.dateApplied !== undefined
                ? patch.dateApplied
                : patch.status === 'applied' && !e.dateApplied
                  ? new Date().toISOString()
                  : e.dateApplied,
            maxSalary:
              patch.maxSalary !== undefined ? patch.maxSalary : e.maxSalary,
            maxSalaryCurrency:
              patch.maxSalaryCurrency !== undefined
                ? patch.maxSalaryCurrency
                : e.maxSalaryCurrency,
            notesMarkdown:
              patch.notesMarkdown !== undefined
                ? patch.notesMarkdown
                : e.notesMarkdown,
            updatedAt: new Date().toISOString(),
          };
          return merged;
        });
        const nextCounts: Record<RATrackerStatus, number> = {
          bookmarked: 0,
          applying: 0,
          applied: 0,
          interviewing: 0,
          negotiating: 0,
          accepted: 0,
          rejected: 0,
          withdrawn: 0,
        };
        for (const e of nextEntries) nextCounts[e.status] += 1;
        qc.setQueryData<TrackerListResponse>(key, {
          ...data,
          entries: nextEntries,
          statusCounts: nextCounts,
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      for (const s of ctx.snapshots) {
        qc.setQueryData(s.key, s.data);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [...KEY_BASE, 'list'] });
    },
  });
}

/** DELETE a tracker entry — optimistic. */
export function useDeleteEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => raV2Api.tracker.delete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [...KEY_BASE, 'list'] });
      const snapshots: Array<{ key: readonly unknown[]; data: unknown }> = [];
      const caches = qc.getQueriesData<TrackerListResponse>({
        queryKey: [...KEY_BASE, 'list'],
      });
      for (const [key, data] of caches) {
        snapshots.push({ key, data });
        if (!data) continue;
        const removed = data.entries.find((e) => e.id === id);
        const nextEntries = data.entries.filter((e) => e.id !== id);
        const counts = { ...data.statusCounts };
        if (removed) counts[removed.status] = Math.max(0, counts[removed.status] - 1);
        qc.setQueryData<TrackerListResponse>(key, {
          ...data,
          entries: nextEntries,
          statusCounts: counts,
          total: Math.max(0, data.total - 1),
        });
      }
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      for (const s of ctx.snapshots) {
        qc.setQueryData(s.key, s.data);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [...KEY_BASE, 'list'] });
    },
  });
}

/** POST a new tracker entry. */
export function useAddEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TrackerCreateBody) => raV2Api.tracker.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY_BASE, 'list'] });
    },
  });
}

/** Bulk-patch entries (multi-select toolbar — V2.1, exposed today for tests). */
export function useBulkEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TrackerBulkBody) => raV2Api.tracker.bulk(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY_BASE, 'list'] });
    },
  });
}
