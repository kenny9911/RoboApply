// server/src/features/jobs/ingest/adapters/rapidApi.ts — RapidAPI search adapters (WP-16b).
//
// Wraps the existing clients as ingest fetchers (ARCH §4.2): Active Jobs DB
// (raFantasticJobs.ts) and JSearch /search-v2 (raRapidApiJobs.ts). These are
// RoboApply's search providers and serve market intl ONLY: no RapidAPI
// adapter ever serves market cn (MARKET_STRATEGY M-6: JSearch country=cn rows
// carry no apply link and are third-hand copies of a mainland board's
// postings). One RAPID_API_KEY; each API must be
// subscribed on app 8974502 (OPS-A3). The clients keep their own guards
// (LRU cache, circuit breaker, in-memory daily budget, kill switches
// RA_ONBOARDING_*_DISABLED and RA_ONBOARDING_EXTERNAL_JOBS_DISABLED); ingest
// adds the DB-backed daily budget (RAProviderUsage) on top.
//
// Taiwan (WP-42 acceptance, asserted here): a query whose country is TW, or
// whose city is a Taiwanese city, searches with country=tw (JSearch) /
// location "Taiwan" (Fantastic Jobs).

import { citiesNamed, countryByCode } from '../../geo/index.js';
import { inputFromExternalJob, type ProviderJobInput } from '../../normalize/index.js';
import { externalProviders, enabledExternalProviders } from '../../../../roboapply/v2/lib/raJobProviders.js';
import { fantasticCountryName } from '../../../../roboapply/v2/lib/raFantasticJobs.js';
import type {
  ExternalJobNormalized,
  ExternalSearchParams,
  ExternalSourceBoard,
  JobSearchProvider,
} from '../../../../roboapply/v2/lib/raExternalJobTypes.js';
import type { Market } from '../../../../platform/brand/index.js';
import { dailyCallLimit } from '../config.js';
import type { IngestQueryParams, JobSourceAdapter, SourceFetchResult } from '../../sources/index.js';

const DATE_POSTED = new Set(['all', 'today', '3days', 'week', 'month']);

/** The ISO country a RapidAPI search runs in: TW whenever the city is in Taiwan. */
export function rapidApiCountry(params: Pick<IngestQueryParams, 'country' | 'city'>): string {
  const country = params.country.trim().toUpperCase();
  if (params.city) {
    const named = citiesNamed(params.city);
    const inCountry = named.some((c) => c.country === country);
    if (!inCountry && named.length > 0 && named.every((c) => c.country === named[0]!.country)) return named[0]!.country;
  }
  return country;
}

/**
 * Planned query → the clients' search params (pure; the planner seam WP-42
 * asserts against). Role text in English; the city scopes the location.
 */
export function rapidApiSearchParams(params: IngestQueryParams, provider: ExternalSourceBoard): ExternalSearchParams {
  const country = rapidApiCountry(params).toLowerCase();
  const city = params.city?.trim() || undefined;
  const datePosted = (DATE_POSTED.has(params.datePosted) ? params.datePosted : 'week') as ExternalSearchParams['datePosted'];
  const out: ExternalSearchParams = {
    query: provider === 'jsearch' && city ? `${params.q} in ${city}` : params.q,
    country,
    datePosted,
  };
  if (params.remote === true) out.workFromHome = true;
  if (provider !== 'jsearch') {
    out.titleQuery = params.q;
    out.locationText = city ?? fantasticCountryName(country) ?? undefined;
  }
  return out;
}

/** ExternalJobNormalized → normalizer input, with the provider-stated company website as a sourced fact. */
export function inputFromRapidApiRow(row: ExternalJobNormalized): ProviderJobInput {
  const input = { ...inputFromExternalJob(row) };
  if (row.companyWebsite) {
    input.companyFacts = { source: `provider:${row.sourceBoard}`, website: row.companyWebsite, fetchedAt: row.fetchedAt ?? null };
  }
  return input;
}

function providerById(id: ExternalSourceBoard): JobSearchProvider | null {
  return externalProviders.find((p) => p.id === id) ?? null;
}

/** Can this provider scope a search to the country? */
export function rapidApiSupportsCountry(provider: ExternalSourceBoard, country: string): boolean {
  if (!/^[A-Za-z]{2}$/.test(country) || !countryByCode(country.toUpperCase())) return false;
  // JSearch takes any ISO country; Fantastic Jobs needs a location name it matches.
  return provider === 'jsearch' ? true : fantasticCountryName(country) !== null;
}

export interface RapidApiAdapterDeps {
  /** Test seam: the client to call (default: the registry provider). */
  provider?: JobSearchProvider;
  isEnabled?: () => boolean;
}

export function createRapidApiAdapter(id: ExternalSourceBoard, deps: RapidApiAdapterDeps = {}): JobSourceAdapter {
  // International only, for every RapidAPI provider (see the header).
  const markets: readonly Market[] = ['intl'];
  return {
    provider: id,
    kind: 'search',
    markets,
    transport: () => 'rapidapi',
    sourceBoards: [id],
    isEnabled: () => {
      try {
        if (deps.isEnabled) return deps.isEnabled();
        return enabledExternalProviders().some((p) => p.id === id);
      } catch {
        return false;
      }
    },
    supportsCountry: (country) => rapidApiSupportsCountry(id, country),
    dailyCallLimit: () => dailyCallLimit(id),
    async fetch(query, ctx): Promise<SourceFetchResult> {
      const client = deps.provider ?? providerById(id);
      if (!client) return { jobs: [], calls: 0, error: 'provider_missing' };
      try {
        const rows = await client.search(rapidApiSearchParams(query.params, id), { signal: ctx.signal, requestId: ctx.requestId });
        if (rows === null) return { jobs: [], calls: 1, error: 'provider_unavailable' };
        return { jobs: rows.map(inputFromRapidApiRow), calls: 1 };
      } catch (err) {
        return { jobs: [], calls: 1, error: err instanceof Error ? err.message.slice(0, 200) : 'provider_threw' };
      }
    },
  };
}
