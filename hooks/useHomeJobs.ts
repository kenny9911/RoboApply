'use client';

// hooks/useHomeJobs.ts
//
// Fetches the 6 most recent jobs for the Home page's "Recent {goal} jobs"
// grid. Calls `raV2Api.search.run` with the user's `targetTitle` as the query
// and `sortBy: 'recent'` so we get freshly-posted matches.
//
// Re-fetches whenever the goal's targetTitle changes — the page wires the
// goal query result into `targetTitle` here.

import { useQuery } from '@tanstack/react-query';
import { raV2Api } from '../lib/api/v2';
import type { SearchRunResponse } from '../lib/api/v2';

const HOME_JOBS_KEY_BASE = ['v2', 'home', 'jobs'] as const;

export function useHomeJobs(targetTitle: string | null | undefined) {
  return useQuery<SearchRunResponse>({
    queryKey: [...HOME_JOBS_KEY_BASE, targetTitle ?? ''],
    queryFn: () =>
      raV2Api.search.run({
        q: targetTitle || undefined,
        limit: 6,
        sortBy: 'recent',
      }),
  });
}
