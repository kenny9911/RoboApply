// server/src/features/jobs/ingest/adapters/rapidApi.ts — RapidAPI search adapters (WP-16b).
//
// Wraps the existing clients as ingest fetchers (ARCH §4.2): Active Jobs DB
// (raFantasticJobs.ts) and JSearch /search-v2 (raRapidApiJobs.ts). These are
// RoboApply's search providers and serve market intl ONLY: no RapidAPI
// adapter ever serves market cn (MARKET_STRATEGY M-6: JSearch country=cn rows
// carry no apply link and are third-hand copies of a mainland board's
// postings). One RAPID_API_KEY; each API must be
// subscribed on app 8974502 (OPS-A3). The clients keep their own guards
// (LRU cache, circuit breaker, kill switches RA_ONBOARDING_*_DISABLED and
// RA_ONBOARDING_EXTERNAL_JOBS_DISABLED) and no call counter: the one budget
// per provider is ingest's (../quota.ts: the plan's quota headers and the
// day's RAProviderUsage row). An ingest call tells the client it is already
// counted (`reservedByIngest`), so it is counted once.
//
// Taiwan (WP-42 acceptance, asserted here): a query whose country is TW, or
// whose city is a Taiwanese city, searches with country=tw (JSearch) /
// location "Taiwan" (Fantastic Jobs). A Taiwan query whose role text is
// Chinese is sent to JSearch as `{職稱} {縣市}` with language=zh-TW (JT-3):
// Chinese text returns the local boards' postings, English text the
// multinationals' (JOB_SOURCES_TW §3.3, §5.1), so the planner sends both.

import { citiesNamed, countryByCode, findCity } from '../../geo/index.js';
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
import { answerForMarket, quotaAllows } from '../quota.js';
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

const HAN = /\p{Script=Han}/u;

/**
 * A Taiwan city as people there write it in a job search: the city table's
 * Traditional name, with 臺 written 台 (the table holds the official 臺北,
 * 臺中, 臺南, 臺東; postings and the job boards write 台北). The English name
 * when the table has no Traditional one; the text as given when the table
 * does not know the city.
 */
export function taiwanCityQueryName(city: string): string {
  const record = findCity(city, { country: 'TW' });
  if (!record) return city;
  return (record.zhHant ?? record.name).replace(/臺/g, '台');
}

/**
 * Planned query → the clients' search params (pure; the planner seam WP-42
 * asserts against). The city scopes the location.
 *
 * JSearch: role text in English is sent as "<role> in <city>" with no
 * language. For a Taiwan query whose role text is Chinese the query is
 * "<role> <city in Traditional Chinese>" with language=zh-TW; a Chinese query
 * for any other country keeps the English form and no language. Fantastic
 * Jobs keeps the English title and location name (it searches English ATS
 * postings).
 */
export function rapidApiSearchParams(params: IngestQueryParams, provider: ExternalSourceBoard): ExternalSearchParams {
  const country = rapidApiCountry(params).toLowerCase();
  const city = params.city?.trim() || undefined;
  const datePosted = (DATE_POSTED.has(params.datePosted) ? params.datePosted : 'week') as ExternalSearchParams['datePosted'];
  const zhTw = provider === 'jsearch' && country === 'tw' && HAN.test(params.q);
  const out: ExternalSearchParams = {
    query: provider !== 'jsearch' || !city ? params.q : zhTw ? `${params.q} ${taiwanCityQueryName(city)}` : `${params.q} in ${city}`,
    country,
    datePosted,
  };
  if (zhTw) out.language = 'zh-TW';
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

/** The one market every RapidAPI adapter serves (see the header). */
const ADAPTER_MARKET: Market = 'intl';

export function createRapidApiAdapter(id: ExternalSourceBoard, deps: RapidApiAdapterDeps = {}): JobSourceAdapter {
  // International only, for every RapidAPI provider (see the header).
  const markets: readonly Market[] = [ADAPTER_MARKET];
  return {
    provider: id,
    kind: 'search',
    markets,
    transport: () => 'rapidapi',
    sourceBoards: [id],
    // On for ingest: the client is usable (key, kill switches, breaker, a person's own search allowed)
    // AND the plan's quota allows an ingest call (not used up, not refused, above the reserve kept for
    // people's own searches). The planner plans nothing for an adapter that is off; a tick still leases
    // the due queries of a quota-stopped provider once, to park them (../run.ts).
    // The answer is for the adapter's own market (international), whatever brand the request that asks
    // belongs to: the clients' gate refuses a mainland request, and an admin on the GoApply host who
    // lists every site's sources must not read RoboApply's as off for that reason.
    isEnabled: () => {
      try {
        if (deps.isEnabled) return deps.isEnabled();
        return answerForMarket(ADAPTER_MARKET, () => enabledExternalProviders().some((p) => p.id === id)) && quotaAllows(id, 'ingest');
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
        // The pipeline reserved this call in RAProviderUsage before fetching: the client's gate must not count it again.
        const rows = await client.search(rapidApiSearchParams(query.params, id), { signal: ctx.signal, requestId: ctx.requestId, reservedByIngest: true });
        if (rows === null) return { jobs: [], calls: 1, error: 'provider_unavailable' };
        return { jobs: rows.map(inputFromRapidApiRow), calls: 1 };
      } catch (err) {
        return { jobs: [], calls: 1, error: err instanceof Error ? err.message.slice(0, 200) : 'provider_threw' };
      }
    },
  };
}
