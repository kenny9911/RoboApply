'use client';

// hooks/useActivity.ts
//
// TanStack Query bindings for the V3 Activity log + agent-stats aggregate
// (Routes 1, 9). All calls route through `raV2Api.activity.*`. Query keys
// namespaced `['v3', 'activity', …]`.
//
// Surface:
//   - useActivityFeed(params?)   GET activity.feed (timeline, grouped by day)
//   - useAgentStats()            GET activity.orbStats (Activity strip, the
//                                sidebar badge, Plan usage — one call)
//
// `useAgentStats` is the cheap, reused aggregate; it's shared by the Activity
// hero strip, the sidebar nav badge and the Plan-usage section. The queue hooks
// invalidate `['v3','activity','orbStats']` so `inQueue` stays live.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  ActivityFeedParams,
  ActivityFeedResponse,
  AgentStatsResponse,
  RAAgentStats,
} from '../lib/api/v2';

/** The subset of `activity.orbStats` a screen is allowed to put in front of a
 *  user (ruling D9 — never display a number we did not measure).
 *
 *  `sent` and `draftsWritten` are `SELECT COUNT`s over RoboApplyRun rows.
 *  Everything else on `RAAgentStats` is excluded on purpose:
 *    • `replies` / `replyRate` — RAActivityService hardcodes `replies = 0`;
 *      there is no reply-tracking surface, so the rate is 0/n by construction.
 *    • `hoursSaved` / `hoursSavedLifetime` — literally `sent × 9 / 60`. A
 *      restatement of `sent` in a flattering unit, not a measurement.
 *    • `scannedOvernight` — hardcoded 0 server-side.
 *    • `matchedAboveThreshold` / `inQueue` — the pending count of the review
 *      queue, which is gated off for launch (QUEUE_REVIEW_ENABLED=false).
 *  They stay on the wire type until the server stops sending them; this alias
 *  is what the UI narrows to. `RAAgentStats` is structurally assignable to it,
 *  so callers can keep passing the whole aggregate. */
export type RAMeasuredStats = Pick<RAAgentStats, 'sent' | 'draftsWritten'>;

export const activityKeys = {
  all: ['v3', 'activity'] as const,
  feed: (days?: number) => ['v3', 'activity', 'feed', days ?? 7] as const,
  orbStats: () => ['v3', 'activity', 'orbStats'] as const,
};

export function useActivityFeed(
  params?: ActivityFeedParams,
): UseQueryResult<ActivityFeedResponse, Error> {
  return useQuery({
    queryKey: activityKeys.feed(params?.days),
    queryFn: () => raV2Api.activity.feed(params),
  });
}

export function useAgentStats(): UseQueryResult<AgentStatsResponse, Error> {
  return useQuery({
    queryKey: activityKeys.orbStats(),
    queryFn: () => raV2Api.activity.orbStats(),
  });
}
