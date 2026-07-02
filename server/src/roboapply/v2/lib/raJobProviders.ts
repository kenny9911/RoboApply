// backend/src/roboapply/v2/lib/raJobProviders.ts
//
// Provider seam for external job-search APIs consumed by the onboarding
// recommendation round (RAOnboardingRecommendService).
//
// Exactly ONE implementation exists today: JSearch via RapidAPI
// (raRapidApiJobs.ts). The interface is the slot where Active Jobs DB or
// Jobs API14 could plug in later WITHOUT touching the orchestrator — but per
// the design spec (§4.1) this file stays interface + single impl until a
// second provider is actually subscribed. Do not add speculative adapters.

import {
  isJSearchEnabled,
  searchJSearchJobs,
  type ExternalJobNormalized,
} from './raRapidApiJobs.js';

export type { ExternalJobNormalized } from './raRapidApiJobs.js';

export interface ExternalSearchParams {
  query: string;
  /** ISO-3166 alpha-2, lowercase (Google for Jobs market). */
  country: string;
  language?: string;
  datePosted?: 'all' | 'today' | '3days' | 'week' | 'month';
  workFromHome?: boolean;
  /** Comma-separated JSearch enums, e.g. 'FULLTIME,CONTRACTOR'. */
  employmentTypes?: string;
  /** Pages per billed call (extra pages are free). Default 2 → 20 jobs. */
  numPages?: number;
}

export interface JobSearchProvider {
  /** Future: 'activejobsdb' | 'jobsapi14'. */
  readonly id: 'jsearch';
  /** Key present && kill switch off && circuit breaker closed && daily budget left. */
  isEnabled(): boolean;
  /** `null` = unavailable/failed — NEVER throws. Callers degrade to internal-only. */
  search(
    params: ExternalSearchParams,
    opts?: { requestId?: string; signal?: AbortSignal },
  ): Promise<ExternalJobNormalized[] | null>;
}

export const jsearchProvider: JobSearchProvider = {
  id: 'jsearch',
  isEnabled: () => isJSearchEnabled(),
  search: (params, opts) => searchJSearchJobs(params, opts),
};
