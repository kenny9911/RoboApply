// backend/src/roboapply/v2/lib/raJobProviders.ts
//
// Provider seam + fan-out aggregator for the external RapidAPI job-search APIs
// consumed by the onboarding recommendation round (RAOnboardingRecommendService).
//
// Three implementations behind ONE RAPID_API_KEY (each separately subscribed on
// the RapidAPI app):
//   • jsearch    — raRapidApiJobs.ts   (JSearch / OpenWeb Ninja — Google-for-Jobs
//                                       aggregator; global + multilingual)
//   • activejobs — raFantasticJobs.ts  (Active Jobs DB — direct-from-employer ATS
//                                       postings; clean direct apply links)
//   • linkedin   — raFantasticJobs.ts  (LinkedIn Job Search API — LinkedIn feed)
//
// Every client honors the never-throws contract (null = unavailable/failed) and
// self-guards (per-provider LRU cache + circuit breaker + daily billed-call
// budget + kill switch). This module adds:
//   - a per-provider kill switch (RA_ONBOARDING_<PROVIDER>_DISABLED) layered on
//     each provider's own isEnabled();
//   - searchAllProviders(): fan out across every ENABLED provider in parallel
//     and return one merged list, ordered so that direct-apply sources win the
//     downstream fingerprint dedup (first occurrence survives).

import { logger } from '../../../services/LoggerService.js';
import { isJSearchEnabled, searchJSearchJobs } from './raRapidApiJobs.js';
import { activeJobsDbProvider, linkedInJobsProvider } from './raFantasticJobs.js';
import {
  EXTERNAL_SOURCE_BOARDS,
  EXTERNAL_SOURCE_BOARD_SET,
  isExternalSourceBoard,
  type ExternalJobNormalized,
  type ExternalSearchParams,
  type ExternalSourceBoard,
  type JobSearchProvider,
} from './raExternalJobTypes.js';

export type {
  ExternalJobNormalized,
  ExternalSearchParams,
  ExternalSourceBoard,
  JobSearchProvider,
} from './raExternalJobTypes.js';
export {
  EXTERNAL_SOURCE_BOARDS,
  EXTERNAL_SOURCE_BOARD_SET,
  isExternalSourceBoard,
} from './raExternalJobTypes.js';

// ─── Per-provider kill switch ──────────────────────────────────────────────
// Layered ON TOP of each client's own isEnabled() (which already checks the key,
// the global RA_ONBOARDING_EXTERNAL_JOBS_DISABLED switch, its circuit breaker,
// and its daily budget). Lets one provider be turned off without touching the
// shared key or the other two.

const PROVIDER_DISABLE_ENV: Record<ExternalSourceBoard, string> = {
  jsearch: 'RA_ONBOARDING_JSEARCH_DISABLED',
  activejobs: 'RA_ONBOARDING_ACTIVEJOBS_DISABLED',
  linkedin: 'RA_ONBOARDING_LINKEDIN_JOBS_DISABLED',
};

function providerKilled(id: ExternalSourceBoard): boolean {
  return process.env[PROVIDER_DISABLE_ENV[id]] === 'true';
}

// ─── Providers ─────────────────────────────────────────────────────────────
// JSearch wraps the existing client verbatim; the per-provider kill switch is
// applied here so the client file stays untouched. The Fantastic Jobs providers
// already fold their own kill switch into isEnabled(), so here we only add the
// generic providerKilled() layer for symmetry (double-checking is harmless).

export const jsearchProvider: JobSearchProvider = {
  id: 'jsearch',
  isEnabled: () => !providerKilled('jsearch') && isJSearchEnabled(),
  search: (params, opts) => searchJSearchJobs(params, opts),
};

/**
 * Registry, ordered by apply-link quality (dedup keeps the FIRST occurrence):
 * direct-employer ATS (Active Jobs DB) → LinkedIn → Google aggregator (JSearch).
 * So when the same posting is surfaced by more than one provider, the row with
 * the cleanest direct apply link wins.
 */
export const externalProviders: readonly JobSearchProvider[] = [
  activeJobsDbProvider,
  linkedInJobsProvider,
  jsearchProvider,
];

/** Enabled providers, in registry order. Swallows a throwing isEnabled(). */
export function enabledExternalProviders(): JobSearchProvider[] {
  return externalProviders.filter((p) => {
    if (providerKilled(p.id)) return false;
    try {
      return p.isEnabled();
    } catch {
      return false;
    }
  });
}

export interface AggregateSearchResult {
  /** Merged jobs, registry order (direct-ATS first → aggregator last). */
  jobs: ExternalJobNormalized[];
  /** Providers whose search() was invoked this round. */
  providersQueried: ExternalSourceBoard[];
  /** Providers that returned ≥1 job. */
  providersWithResults: ExternalSourceBoard[];
  /** Per-provider job counts (post-normalize, pre-dedup) for telemetry. */
  countsByProvider: Partial<Record<ExternalSourceBoard, number>>;
}

/**
 * Fan out ONE search across every enabled provider in parallel and merge into a
 * single ordered list. NEVER throws — a provider that fails/returns null simply
 * contributes nothing. The merged order follows `externalProviders`, so the
 * caller's fingerprint dedup keeps the cleanest-apply-link twin.
 *
 * `opts.providers` restricts the fan-out to a caller-chosen subset (the consumer
 * captures enabledExternalProviders() once, up front, so its status event and
 * the actual fetch agree on which providers ran).
 */
export async function searchAllProviders(
  params: ExternalSearchParams,
  opts?: { requestId?: string; signal?: AbortSignal; providers?: JobSearchProvider[] },
): Promise<AggregateSearchResult> {
  const active = opts?.providers ?? enabledExternalProviders();
  const empty: AggregateSearchResult = {
    jobs: [],
    providersQueried: [],
    providersWithResults: [],
    countsByProvider: {},
  };
  if (active.length === 0) return empty;

  const settled = await Promise.all(
    active.map(async (p) => {
      try {
        const jobs = await p.search(params, { requestId: opts?.requestId, signal: opts?.signal });
        return { id: p.id, jobs };
      } catch (err) {
        // The contract says clients never throw; a bug must not sink the round.
        logger.warn('RA_V2_EXTERNAL_PROVIDER_THREW', 'external provider threw (contract violation)', {
          requestId: opts?.requestId,
          provider: p.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { id: p.id, jobs: null as ExternalJobNormalized[] | null };
      }
    }),
  );

  const result: AggregateSearchResult = {
    jobs: [],
    providersQueried: [],
    providersWithResults: [],
    countsByProvider: {},
  };
  // `active` is a filtered slice of the ordered `externalProviders`, and
  // Promise.all preserves input order, so `settled` is already in registry order.
  for (const r of settled) {
    result.providersQueried.push(r.id);
    const n = r.jobs?.length ?? 0;
    result.countsByProvider[r.id] = n;
    if (n > 0 && r.jobs) {
      result.providersWithResults.push(r.id);
      result.jobs.push(...r.jobs);
    }
  }
  return result;
}
