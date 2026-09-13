import { roboApi, RoboApiError } from './client';
import type { JobSearchKey, ProviderInfo, SearchInput, SearchResult } from './job-search-types';

const BASE = '/api/v1/roboapply/v2/job-search';
export const JOB_SEARCH_OPENAPI_URL = '/api/v1/job-search/openapi.json';

export const jobSearchApi = {
  providers: (signal?: AbortSignal) => roboApi.get<{ providers: ProviderInfo[] }>(`${BASE}/providers`, { signal }),
  search: (input: SearchInput, signal?: AbortSignal) => roboApi.post<SearchResult>(`${BASE}/search`, input, { signal }),
  keys: (signal?: AbortSignal) => roboApi.get<{ keys: JobSearchKey[] }>(`${BASE}/keys`, { signal }),
  createKey: (name: string) => roboApi.post<{ key: JobSearchKey; token: string }>(`${BASE}/keys`, { name }),
  revokeKey: (id: string) => roboApi.delete<void>(`${BASE}/keys/${encodeURIComponent(id)}`),
};

/** A failed fan-out may still include useful per-source diagnostics. */
export function failedSearchResult(error: unknown): SearchResult | null {
  if (!(error instanceof RoboApiError) || !error.payload || typeof error.payload !== 'object') return null;
  const data = (error.payload as { data?: SearchResult }).data;
  return data && Array.isArray(data.jobs) && Array.isArray(data.meta?.providers) ? data : null;
}

export const JOB_SEARCH_CURL_EXAMPLE = `curl --request POST "$ROBOAPPLY_ORIGIN/api/v1/job-search/search" \\
  --header "Authorization: Bearer $ROBOAPPLY_JOB_SEARCH_KEY" \\
  --header "Content-Type: application/json" \\
  --data '{"query":"software engineer","country":"US","remote":true,"datePosted":"week","limit":20}'`;
