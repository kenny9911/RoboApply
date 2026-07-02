'use client';

// hooks/useActivity.ts
//
// TanStack Query bindings for the V3 Activity log + agent-stats aggregate
// (Routes 1, 9, sidebar). All calls route through `raV2Api.activity.*`. Query
// keys namespaced `['v3', 'activity', …]`.
//
// Surface:
//   - useActivityFeed(params?)   GET activity.feed (timeline, grouped by day)
//   - useAgentStats()            GET activity.orbStats (sidebar orb + Today
//                                strip + Activity strip + Plan usage — one call)
//
// `useAgentStats` is the cheap, reused aggregate; it's shared by Today, the
// sidebar orb, the Activity hero strip, and the Plan-usage section. The queue
// hooks invalidate `['v3','activity','orbStats']` so `inQueue` stays live.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { raV2Api } from '../lib/api/v2';
import type {
  ActivityFeedParams,
  ActivityFeedResponse,
  AgentStatsResponse,
} from '../lib/api/v2';

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
