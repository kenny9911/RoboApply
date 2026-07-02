// useStatusFunnel — derives the 6-bucket count strip from the current
// tracker query. The StatusFunnel chevron row needs counts for
// BOOKMARKED → APPLYING → APPLIED → INTERVIEWING → NEGOTIATING → ACCEPTED.
//
// We deliberately call `tracker.list()` WITHOUT a status filter here so
// the counts are total across all buckets — independent of whichever
// filter the user has applied to the table itself.

'use client';

import { useMemo } from 'react';
import { useTracker } from './useTracker';
import type { RATrackerStatus } from '../api/v2';

export const FUNNEL_STAGES: ReadonlyArray<RATrackerStatus> = [
  'bookmarked',
  'applying',
  'applied',
  'interviewing',
  'negotiating',
  'accepted',
] as const;

export interface FunnelBucket {
  status: RATrackerStatus;
  count: number;
}

/** Returns one bucket per funnel stage (in display order) with its count. */
export function useStatusFunnel(): {
  buckets: FunnelBucket[];
  isLoading: boolean;
} {
  // Empty params = unfiltered; counts are global.
  const { data, isLoading } = useTracker(undefined);
  const buckets = useMemo<FunnelBucket[]>(() => {
    const counts = data?.statusCounts;
    return FUNNEL_STAGES.map((status) => ({
      status,
      count: counts ? counts[status] : 0,
    }));
  }, [data]);
  return { buckets, isLoading };
}
