'use client';

// hooks/useJobSearch.ts
//
// URL-driven Job Search. Wraps `raV2Api.search.run` with TanStack Query and
// the SearchRunParams shape from `lib/api/v2/types`. The page builds params
// from URLSearchParams (per CTO FE-2) and passes them in; this hook just
// keys the cache off the params and returns the response.
//
// We do NOT paginate yet (V2.0 ships single-page results in the left rail
// — 50 fixture rows fit comfortably). When live ingest lands we can swap
// to `useInfiniteQuery` here without touching the call site.

import { useQuery } from '@tanstack/react-query';
import { raV2Api } from '../lib/api/v2';
import type { SearchRunParams, SearchRunResponse } from '../lib/api/v2';

const KEY = ['v2', 'search', 'run'] as const;

export function useJobSearch(params: SearchRunParams) {
  return useQuery<SearchRunResponse>({
    queryKey: [...KEY, JSON.stringify(params)] as const,
    queryFn: () => raV2Api.search.run(params),
  });
}
