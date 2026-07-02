'use client';

// hooks/useQueue.ts
//
// TanStack Query bindings for the V3 Review Queue (Route 2). All calls route
// through `raV2Api.queue.*` — the real Express backend by default; the
// in-memory stub only under NODE_ENV=test or an explicit
// NEXT_PUBLIC_USE_STUB_API=true. Query keys are namespaced `['v3', 'queue', …]`.
// NOTE: the /queue surface is hidden for launch (QUEUE_REVIEW_ENABLED in
// lib/jobApplying.ts) — these hooks stay for the re-enable.
//
// Surface:
//   - useQueue()                 GET  queue.list
//   - useSendQueueItem()         POST queue.send (removes from pending)
//   - useSkipQueueItem()         POST queue.skip (removes from pending)
//   - useUpdateQueueCover(id)    PATCH queue.updateCover

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useLocale } from 'next-intl';

import { raV2Api } from '../lib/api/v2';
import type {
  QueueItemResponse,
  QueueListResponse,
  QueueUpdateCoverBody,
} from '../lib/api/v2';

export const queueKeys = {
  all: ['v3', 'queue'] as const,
  // The backend localizes server-derived strings (check chips, fallbacks) per
  // the X-Robo-Locale header, so the cached payload is locale-specific — the
  // locale must be part of the key or a language switch shows stale text.
  list: (locale: string) => ['v3', 'queue', 'list', locale] as const,
};

/** Read the pending review queue. `pendingCount` drives the eyebrow + nav badge.
 *  `enabled: false` suppresses the request (Sidebar passes QUEUE_REVIEW_ENABLED
 *  so the hidden-for-launch queue costs no GET on every authed page). */
export function useQueue(opts?: {
  enabled?: boolean;
}): UseQueryResult<QueueListResponse, Error> {
  const locale = useLocale();
  return useQuery({
    queryKey: queueKeys.list(locale),
    queryFn: () => raV2Api.queue.list(),
    enabled: opts?.enabled ?? true,
  });
}

/** Fire an item now. On success the item flips to 'sent' and drops out of the
 *  pending list — we invalidate both the queue and the orb stats (`inQueue`). */
export function useSendQueueItem(): UseMutationResult<
  QueueItemResponse,
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => raV2Api.queue.send(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queueKeys.all });
      void qc.invalidateQueries({ queryKey: ['v3', 'activity', 'orbStats'] });
    },
  });
}

/** Skip an item. Same invalidations as send — it leaves the pending list. */
export function useSkipQueueItem(): UseMutationResult<
  QueueItemResponse,
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => raV2Api.queue.skip(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queueKeys.all });
      void qc.invalidateQueries({ queryKey: ['v3', 'activity', 'orbStats'] });
    },
  });
}

/** Edit the draft cover for a queue item. */
export function useUpdateQueueCover(
  id: string,
): UseMutationResult<QueueItemResponse, Error, QueueUpdateCoverBody> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: QueueUpdateCoverBody) =>
      raV2Api.queue.updateCover(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queueKeys.all });
    },
  });
}
