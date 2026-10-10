import { roboApi, RoboApiError } from './client';
import type { AgentSearchInput, AgentSearchResult, JobSearchKey, ProviderInfo, SearchInput, SearchResult } from './job-search-types';

const BASE = '/api/v1/roboapply/v2/job-search';
export const JOB_SEARCH_OPENAPI_URL = '/api/v1/job-search/openapi.json';

export const jobSearchApi = {
  providers: (signal?: AbortSignal) => roboApi.get<{ providers: ProviderInfo[] }>(`${BASE}/providers`, { signal }),
  search: (input: SearchInput, signal?: AbortSignal) => roboApi.post<SearchResult>(`${BASE}/search`, input, { signal }),
  agentSearch: (input: AgentSearchInput, signal?: AbortSignal) => roboApi.post<AgentSearchResult>(`${BASE}/agent/search`, input, { signal }),
  /** `sources` is what a key of this site can read right now (absent from an older server). */
  keys: (signal?: AbortSignal) => roboApi.get<{ keys: JobSearchKey[]; sources?: ProviderInfo[] }>(`${BASE}/keys`, { signal }),
  createKey: (name: string) => roboApi.post<{ key: JobSearchKey; token: string }>(`${BASE}/keys`, { name }),
  revokeKey: (id: string) => roboApi.delete<void>(`${BASE}/keys/${encodeURIComponent(id)}`),
};

/**
 * True when the server says a key of this site can read no job source right
 * now (the operator has granted none, or every source is off), so every call
 * made with a key answers an error. Unknown (an older server, a malformed
 * value) is false: nothing is claimed.
 */
export function keysReadNoSource(sources: unknown): boolean {
  return Array.isArray(sources) && sources.length > 0 && sources.every((source) => (source as { enabled?: unknown } | null)?.enabled !== true);
}

/** A failed fan-out may still include useful per-source diagnostics. */
export function failedSearchResult(error: unknown): SearchResult | null {
  if (!(error instanceof RoboApiError) || !error.payload || typeof error.payload !== 'object') return null;
  const data = (error.payload as { data?: SearchResult }).data;
  return data && Array.isArray(data.jobs) && Array.isArray(data.meta?.providers) ? data : null;
}

/** What one brand's request examples say (components/job-search/countries.ts holds the brand data). */
export interface JobSearchExampleSpec {
  /** Prefix of the two placeholder variables, e.g. `ROBOAPPLY` → `$ROBOAPPLY_ORIGIN`. */
  envPrefix: string;
  /** Body of the keyword-search example. */
  search: Record<string, unknown>;
  /** Body of the natural-language example. */
  agent: Record<string, unknown>;
}

export interface JobSearchExamples {
  originVar: string;
  keyVar: string;
  curl: string;
  agentCurl: string;
}

function curlFor(path: string, originVar: string, keyVar: string, body: Record<string, unknown>): string {
  return `curl --request POST "$${originVar}/api/v1/job-search/${path}" \\
  --header "Authorization: Bearer $${keyVar}" \\
  --header "Content-Type: application/json" \\
  --data '${JSON.stringify(body)}'`;
}

/** The two request examples of the developer guide, for one brand's spec. */
export function jobSearchExamples(spec: JobSearchExampleSpec): JobSearchExamples {
  const originVar = `${spec.envPrefix}_ORIGIN`;
  const keyVar = `${spec.envPrefix}_JOB_SEARCH_KEY`;
  return { originVar, keyVar, curl: curlFor('search', originVar, keyVar, spec.search), agentCurl: curlFor('agent/search', originVar, keyVar, spec.agent) };
}

const ROBOAPPLY_EXAMPLES = jobSearchExamples({
  envPrefix: 'ROBOAPPLY',
  search: { query: 'software engineer', country: 'US', remote: true, datePosted: 'week', limit: 20 },
  agent: { request: 'Find remote backend engineering jobs in Taiwan posted this week.', linkedinOnly: true, limit: 20 },
});

export const JOB_SEARCH_CURL_EXAMPLE = ROBOAPPLY_EXAMPLES.curl;
export const JOB_SEARCH_AGENT_CURL_EXAMPLE = ROBOAPPLY_EXAMPLES.agentCurl;
