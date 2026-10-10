'use client';

// hooks/useJobSearch.ts
//
// URL-driven Job Search. Wraps `raV2Api.search.run` with TanStack Query and
// the SearchRunParams shape from `lib/api/v2/types`. The page builds params
// from URLSearchParams (per CTO FE-2) and passes them in; this hook just
// keys the cache off the params and returns the response.
//
// @deprecated The job search is the feed (`queryFeed({ q })`, lib/api/feed.ts).
// The ⌘K palette moved there in INT-12 and the /job-search page is deleted;
// the one importer left is components/v3/resume-editor/TailorModal.tsx, which
// INT-10 retires. Delete this file with that import (post-merge join J6),
// together with the frozen client's `search` slice.

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
