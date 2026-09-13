/** Transport-neutral contract shared by the service, HTTP API, and browser. */
export type ProviderId = string;
export type DatePosted = 'all' | 'today' | '3days' | 'week' | 'month';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship';

export interface SearchInput {
  query: string;
  location?: string;
  country: string;
  remote?: boolean;
  datePosted?: DatePosted;
  employmentTypes?: EmploymentType[];
  providers?: ProviderId[];
  limit?: number;
}

export interface SearchSource {
  provider: ProviderId;
  id: string;
  applyUrl: string;
  publisher: string | null;
  /** Original source posting retained when direct-apply URLs replace it. */
  sourceUrl?: string | null;
}

export interface SearchJob {
  id: string;
  title: string;
  company: string;
  companyLogoUrl: string | null;
  location: string | null;
  country: string | null;
  description: string;
  applyUrl: string;
  sourceUrl: string | null;
  applyIsDirect: boolean;
  provider: ProviderId;
  sources: SearchSource[];
  /** Null when the source has no trustworthy publication date. */
  postedAt: string | null;
  /** Original upstream fetch time, retained on cache hits. */
  fetchedAt: string;
  /** Only an explicit provider signal establishes remote; null means unknown. */
  remote: boolean | null;
  employmentType: EmploymentType | null;
  salary: {
    min: number | null;
    max: number | null;
    currency: string | null;
    period: string | null;
  } | null;
}

export type ProviderUnavailableReason = 'disabled' | 'not_licensed' | 'missing_credentials' | 'budget_or_circuit';
export interface ProviderInfo {
  id: ProviderId;
  name: string;
  enabled: boolean;
  reason?: ProviderUnavailableReason;
  homepage: string;
  sourceType: 'aggregator' | 'ats' | 'board';
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  status: 'ok' | 'empty' | 'unavailable' | 'error' | 'timeout';
  reason?: ProviderUnavailableReason | 'failed' | 'deadline';
  /** Number of valid jobs after requested filters, before cross-provider dedup. */
  resultCount: number;
}

export interface SearchResult {
  jobs: SearchJob[];
  meta: {
    requestId?: string;
    totalReturned: number;
    deduplicated: number;
    partial: boolean;
    providers: ProviderStatus[];
    searchedAt: string;
    cache: 'hit' | 'miss' | 'coalesced';
  };
}

/** Natural-language intent plus only explicitly supplied filter overrides. */
export interface AgentSearchInput {
  request: string;
  country?: string;
  location?: string;
  remote?: boolean;
  datePosted?: DatePosted;
  employmentTypes?: EmploymentType[];
  providers?: ProviderId[];
  limit?: number;
  locale?: string;
  linkedinOnly?: boolean;
}

export interface AgentSearchResult extends SearchResult {
  agent: {
    queries: string[];
    mode: 'planned';
    criteria: { country: string; location?: string; remote?: boolean; datePosted?: DatePosted; employmentTypes?: EmploymentType[] };
    unverifiedPreferences: string[];
    linkedinOnly: boolean;
  };
  searches: Array<{
    query: string;
    providers: ProviderStatus[];
    error?: { code: string; message: string };
  }>;
}
