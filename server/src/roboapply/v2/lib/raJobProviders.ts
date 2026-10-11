// backend/src/roboapply/v2/lib/raJobProviders.ts
//
// Provider seam + fan-out aggregator for the external RapidAPI job-search APIs
// retained from onboarding and reused by the HTTP-independent job-search service.
//
// Two implementations behind ONE RAPID_API_KEY (each separately subscribed on
// the RapidAPI app):
//   • activejobs — raFantasticJobs.ts  (Active Jobs DB — direct-from-employer ATS
//                                       postings; clean direct apply links)
//   • jsearch    — raRapidApiJobs.ts   (JSearch / OpenWeb Ninja — Google-for-Jobs
//                                       aggregator; global + multilingual)
//
// The LinkedIn Job Search API is NOT a provider (MARKET_STRATEGY M-4, JI-2: not
// subscribed and not to be). It is in no list here, and the fan-out refuses a
// provider with that id whoever hands it one (`isDroppedProvider`), so no
// request of any brand reaches a LinkedIn client through this module.
//
// Every client honors the never-throws contract (null = unavailable/failed) and
// self-guards (per-provider LRU cache + circuit breaker + kill switch) and asks
// the call gate before every upstream call (features/jobs/ingest/quota.ts: one
// budget per provider; the clients keep no counter). This module adds:
//   - a per-provider kill switch (RA_ONBOARDING_<PROVIDER>_DISABLED) layered on
//     each provider's own isEnabled();
//   - searchAllProviders(): fan out across every ENABLED provider in parallel
//     and return one merged list, ordered so that direct-apply sources win the
//     downstream fingerprint dedup (first occurrence survives).

import { logger } from '../../../services/LoggerService.js';
import { isJSearchEnabled, searchJSearchJobs } from './raRapidApiJobs.js';
import { activeJobsDbProvider } from './raFantasticJobs.js';
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
// and the call gate of features/jobs/ingest/quota.ts). Lets one provider be turned off without touching the shared
// key or the other one.

const PROVIDER_DISABLE_ENV: Readonly<Record<string, string>> = {
  jsearch: 'RA_ONBOARDING_JSEARCH_DISABLED',
  activejobs: 'RA_ONBOARDING_ACTIVEJOBS_DISABLED',
};

function providerKilled(id: string): boolean {
  const name = PROVIDER_DISABLE_ENV[id];
  return name !== undefined && process.env[name] === 'true';
}

/**
 * Why a provider of this registry is off by configuration, as the short code
 * the job-source registry shows: a kill switch (the shared one or its own)
 * first, then the shared key. Null when neither applies: the provider is on,
 * or off for a reason of the moment (its breaker, its plan's quota).
 */
export function externalProviderOffReason(id: string): 'kill_switch' | 'no_api_key' | null {
  if (process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true' || providerKilled(id)) return 'kill_switch';
  if (!process.env.RAPID_API_KEY?.trim()) return 'no_api_key';
  return null;
}

// ─── Dropped providers ─────────────────────────────────────────────────────
// A provider id that must never be called, whatever is exported, registered or
// passed in. Plain strings: the rule outlives the id's removal from the
// provider unions.

const DROPPED_PROVIDER_IDS: ReadonlySet<string> = new Set(['linkedin']);

/** True for a provider that was dropped by decision and is never called (the LinkedIn feed: MARKET_STRATEGY M-4). */
export function isDroppedProvider(id: string): boolean {
  return DROPPED_PROVIDER_IDS.has(id);
}

// ─── Providers ─────────────────────────────────────────────────────────────
// JSearch wraps the existing client verbatim; the per-provider kill switch is
// applied here so the client file stays untouched. The Active Jobs DB provider
// already folds its own kill switch into isEnabled(), so here we only add the
// generic providerKilled() layer for symmetry (double-checking is harmless).

export const jsearchProvider: JobSearchProvider = {
  id: 'jsearch',
  isEnabled: () => !providerKilled('jsearch') && isJSearchEnabled(),
  search: (params, opts) => searchJSearchJobs(params, opts),
};

/**
 * Registry, ordered by apply-link quality (dedup keeps the FIRST occurrence):
 * direct-employer ATS (Active Jobs DB) → Google aggregator (JSearch). So when
 * the same posting is surfaced by both, the row with the cleanest direct apply
 * link wins. These are the two RapidAPI providers the product runs.
 */
export const externalProviders: readonly JobSearchProvider[] = [activeJobsDbProvider, jsearchProvider];

/** Enabled providers, in registry order. Swallows a throwing isEnabled(). Never a dropped provider. */
export function enabledExternalProviders(): JobSearchProvider[] {
  return externalProviders.filter((p) => {
    if (isDroppedProvider(p.id) || providerKilled(p.id)) return false;
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
 * the actual fetch agree on which providers ran). A dropped provider in that
 * subset is left out: it is not queried and not reported.
 */
export async function searchAllProviders(
  params: ExternalSearchParams,
  opts?: { requestId?: string; signal?: AbortSignal; providers?: JobSearchProvider[] },
): Promise<AggregateSearchResult> {
  const active = (opts?.providers ?? enabledExternalProviders()).filter((p) => !isDroppedProvider(p.id));
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
