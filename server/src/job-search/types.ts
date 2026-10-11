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
  /** Who published the posting (the employer's board, the recruiter bank); null when unknown. */
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
  /** Empty for `index`, the service's own index of ingested postings. */
  homepage: string;
  sourceType: 'aggregator' | 'ats' | 'board' | 'index';
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
    /**
     * The topics that took part in the order of this search's results. Present
     * only when the caller asked for an order (the planned search does; a
     * keyword search never does) AND every source that returned rows said it
     * used them (a result with no rows was ordered by nothing). Absent means
     * "each source's own order". One input to an order, never a filter and
     * never a checked fact about a job.
     */
    rankedBy?: string[];
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
    /** Always false: no site can restrict a search to LinkedIn. Kept for clients that read it. */
    linkedinOnly: boolean;
    /**
     * Topics of the request (an industry, a technology) that the sources used
     * when they ordered each query's results: one input to the order, beside
     * others such as how recent a posting is, so a result need not mention
     * them. They are not verified facts about a job: nothing was checked
     * against them. Empty when the request names no such topic, when nothing
     * was found, and whenever a source that returned results did not say it
     * ordered by them (the topics are then listed in `unverifiedPreferences`).
     */
    rankedBy: string[];
  };
  searches: Array<{
    query: string;
    providers: ProviderStatus[];
    error?: { code: string; message: string };
  }>;
}
