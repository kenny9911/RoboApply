// server/src/features/jobs/ingest/adapters/rapidApi.ts — RapidAPI search adapters (WP-16b).
//
// Wraps the existing clients as ingest fetchers (ARCH §4.2): Active Jobs DB
// (raFantasticJobs.ts) and JSearch /search-v2 (raRapidApiJobs.ts). One
// RAPID_API_KEY; each API must be subscribed on app 8974502 (OPS-A3; Active
// Jobs DB may instead run on a Fantastic.jobs key: FANTASTIC_TRANSPORT=direct).
// The clients keep their own guards (LRU cache, circuit breaker, kill switches
// RA_ONBOARDING_*_DISABLED and RA_ONBOARDING_EXTERNAL_JOBS_DISABLED) and no
// call counter: the one budget per provider is ingest's (../quota.ts: the
// plan's quota headers and the day's RAProviderUsage row). An ingest call
// tells the client it is already counted (`reservedByIngest`), so it is
// counted once.
//
// Markets (MARKET_STRATEGY M-6, §1.4 tier 1, JC-6):
//   jsearch     international only, for good: its country=cn rows carry no
//               apply link and are third-hand copies of a mainland board's
//               postings.
//   activejobs  international, and the mainland behind the licensed feed's
//               plan gate (../quota.ts `feedGateForMarket('cn')`: a plan of at
//               least 20,000 postings a month, CN_ACTIVEJOBS_ENABLED not
//               false). With today's free plan it is off for the mainland and
//               nothing is planned or fetched there. A mainland request
//               carries ROLE TEXT ONLY: the role's Simplified Chinese label
//               and its English label, both read from our own taxonomy, and
//               "China" or a city name from our own city table. Never text a
//               person typed, never a user id, a resume or an e-mail. A query
//               without a taxonomy role makes no request for the mainland.
//               Mainland calls are counted under `activejobs:cn`
//               (INGEST_ACTIVEJOBS_CN_DAILY_CALLS; 20 a day while the gate is
//               open).
//
// One posting, one market (Active Jobs DB; MARKET_STRATEGY JC-4's rule for a
// source both brands read). Its rows are keyed by the vendor's id whatever
// market asked, and the upsert writes the asking market onto the row. So a row
// belongs to the market of its OWN resolved location, in both directions and
// on both of the plan's paths (this search adapter and the window feed):
//   - a mainland query keeps mainland China only: what the provider files
//     under China and is in Hong Kong, Macau or Taiwan is dropped;
//   - an international query keeps everything else: a mainland posting is
//     dropped, or RoboApply's search and GoApply's sync would write the same
//     row in turn and it would move between the two sites with every refresh.
// Dropped rows are counted as 'wrong_market'. A stored international query
// for mainland China itself makes no request at all (every row it could
// return is the mainland's, and each would be billed): the planner plans none
// (../planner.ts), and one planned earlier answers 'other_market_location'
// here without a call. JSearch writes its own rows for RoboApply only and is
// not rerouted.
//
// Active Jobs DB asks a role as quoted phrases joined by OR: its own name and
// up to two other names of the role (`titleSynonyms`), so a per-job plan is
// not billed for loosely related titles (JOB_SOURCES_INTL §6.2).
//
// Taiwan (WP-42 acceptance, asserted here): a query whose country is TW, or
// whose city is a Taiwanese city, searches with country=tw (JSearch) /
// location "Taiwan" (Fantastic Jobs). A Taiwan query whose role text is
// Chinese is sent to JSearch as `{職稱} {縣市}` with language=zh-TW (JT-3):
// Chinese text returns the local boards' postings, English text the
// multinationals' (JOB_SOURCES_TW §3.3, §5.1), so the planner sends both.

import { citiesNamed, countryByCode, findCity } from '../../geo/index.js';
import { inputFromExternalJob, marketOfPosting, type ProviderJobInput } from '../../normalize/index.js';
import { getTaxonomyNode, providerQueryLabels } from '../../taxonomy/index.js';
import { externalProviders, enabledExternalProviders, externalProviderOffReason } from '../../../../roboapply/v2/lib/raJobProviders.js';
import {
  FANTASTIC_SEARCH_LIMIT,
  TITLE_SYNONYMS_MAX,
  fantasticCountryName,
  fantasticJobsOffReason,
  fantasticSearchDateWindow,
  fantasticTransport,
  isFantasticJobsUsable,
} from '../../../../roboapply/v2/lib/raFantasticJobs.js';
import type {
  ExternalJobNormalized,
  ExternalSearchParams,
  ExternalSourceBoard,
  JobSearchProvider,
} from '../../../../roboapply/v2/lib/raExternalJobTypes.js';
import type { Market } from '../../../../platform/brand/index.js';
import { FEED_GATE_REASON_CODE, dailyCallLimit, effectiveDailyLimit } from '../config.js';
import { answerForMarket, feedGateForMarket, marketOfCall, quotaAllows } from '../quota.js';
import { adapterCostModel } from '../../sources/index.js';
import type { IngestQueryParams, JobSourceAdapter, SourceFetchResult, SourceQueryLanguage } from '../../sources/index.js';

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

/** The role's English names for a provider query, best first (its label, then its synonyms); none for an id that is not a role. */
function englishRoleNames(taxonomyId: string | undefined, country: string): string[] {
  if (!taxonomyId) return [];
  return providerQueryLabels(taxonomyId, { market: 'intl', country })
    .filter((l) => l.language === 'en')
    .map((l) => l.text);
}

/**
 * Other names of the query's role for Active Jobs DB's OR of phrases: the
 * role's English names that are not the query text itself, at most two. Only
 * a taxonomy role has them (a title a person typed is asked as typed, alone).
 */
function roleSynonyms(params: IngestQueryParams, country: string): string[] {
  const asked = params.q.trim().toLowerCase();
  return englishRoleNames(params.taxonomyId, country)
    .filter((name) => name.trim().toLowerCase() !== asked)
    .slice(0, TITLE_SYNONYMS_MAX);
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
 * postings) and gets the role's other English names as `titleSynonyms`.
 *
 * A mainland query (`market` 'cn', Active Jobs DB only) is built by
 * `mainlandSearchParams`: role text from the taxonomy only.
 */
export function rapidApiSearchParams(params: IngestQueryParams, provider: ExternalSourceBoard, market: Market = 'intl'): ExternalSearchParams {
  if (market === 'cn') return mainlandSearchParams(params) ?? { query: '', country: 'cn', datePosted: 'week' };
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
    const synonyms = roleSynonyms(params, country.toUpperCase());
    if (synonyms.length) out.titleSynonyms = synonyms;
    out.locationText = city ?? fantasticCountryName(country) ?? undefined;
  }
  return out;
}

/**
 * The search params of a mainland query, or null when the query names no
 * taxonomy role (then no request is made: JC-6 "role text only").
 *
 * Nothing in the result is text a person typed, whatever the stored query
 * holds: the title is the role's first Simplified Chinese label and its first
 * English label, both read from the taxonomy by the role's id; the location
 * is the English name of a mainland city our city table knows, else "China".
 * No remote filter, no language, no free text.
 */
export function mainlandSearchParams(params: IngestQueryParams): ExternalSearchParams | null {
  const node = params.taxonomyId ? getTaxonomyNode(params.taxonomyId) : null;
  if (!node || node.level !== 3) return null;
  const zh = providerQueryLabels(node.id, { market: 'cn', country: 'CN' }).find((l) => l.language === 'zh-CN')?.text ?? null;
  const en = englishRoleNames(node.id, 'CN')[0] ?? null;
  const title = zh ?? en;
  if (!title) return null;
  const city = params.city ? findCity(params.city, { country: 'CN' }) : null;
  const out: ExternalSearchParams = {
    query: title,
    country: 'cn',
    datePosted: 'week',
    titleQuery: title,
    locationText: city?.country === 'CN' ? city.name : 'China',
  };
  if (zh && en && en.trim().toLowerCase() !== zh.trim().toLowerCase()) out.titleSynonyms = [en];
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
  /** Test seam: the adapter's answer for its own (international) market. */
  isEnabled?: () => boolean;
  /** Test seam: is Active Jobs DB on for the mainland? (default: the client, the feed's plan gate and the mainland call bound). */
  mainlandOpen?: () => boolean;
}

/** The market every RapidAPI adapter serves; Active Jobs DB serves the mainland too, behind the plan gate (see the header). */
const HOME_MARKET: Market = 'intl';
const MARKETS: Readonly<Partial<Record<ExternalSourceBoard, readonly Market[]>>> = { activejobs: ['intl', 'cn'] };
/** The country whose postings belong to the mainland market (normalize `marketOfPosting`). */
const MAINLAND_COUNTRY = 'CN';
/** The languages a role label may be sent in: JSearch reads Traditional Chinese for Taiwan; Active Jobs DB gets the mainland's Simplified label (its request adds the English one). */
const QUERY_LANGUAGES: Readonly<Partial<Record<ExternalSourceBoard, readonly SourceQueryLanguage[]>>> = {
  jsearch: ['en', 'zh-TW'],
  activejobs: ['en', 'zh-CN'],
};
/** Rows of a page that belong to `market` by their own resolved location, and how many did not. */
export function rowsOfMarket(inputs: readonly ProviderJobInput[], market: Market): { kept: ProviderJobInput[]; dropped: number } {
  const kept = inputs.filter((input) => marketOfPosting(input) === market);
  return { kept, dropped: inputs.length - kept.length };
}

export function createRapidApiAdapter(id: ExternalSourceBoard, deps: RapidApiAdapterDeps = {}): JobSourceAdapter {
  const markets: readonly Market[] = MARKETS[id] ?? [HOME_MARKET];
  const costModel = adapterCostModel({ provider: id });
  const offByConfig = (): string | null => (id === 'activejobs' ? fantasticJobsOffReason() : externalProviderOffReason(id));

  // On for ingest in the home market: the client is usable (key, kill switches, breaker, a person's own search
  // allowed) AND the plan's quota allows an ingest call (not used up, not refused, above the reserve kept for
  // people's own searches). The planner plans nothing for an adapter that is off; a tick still leases the due
  // queries of a quota-stopped provider once, to park them (../run.ts).
  // The answer is for the adapter's own market, whatever brand the request that asks belongs to: the clients'
  // gate refuses a mainland request, and an admin on the GoApply host who lists every site's sources must not
  // read RoboApply's as off for that reason.
  const homeEnabled = (): boolean => {
    if (deps.isEnabled) return deps.isEnabled();
    return answerForMarket(HOME_MARKET, () => enabledExternalProviders().some((p) => p.id === id)) && quotaAllows(id, 'ingest');
  };
  // On for the mainland: the client can be called at all, the licensed feed's plan gate is open for the mainland
  // (a paid plan, CN_ACTIVEJOBS_ENABLED not false, the quota allows an ingest call) and the mainland call bound
  // is above 0 (an operator's INGEST_ACTIVEJOBS_CN_DAILY_CALLS=0 keeps the search off while the feed runs).
  const mainlandEnabled = (): boolean => {
    if (!markets.includes('cn')) return false;
    if (deps.mainlandOpen) return deps.mainlandOpen();
    return isFantasticJobsUsable() && feedGateForMarket('cn').open && (effectiveDailyLimit(id, 'cn') ?? 0) > 0;
  };
  const enabledFor = (market: Market): boolean => {
    try {
      return market === 'cn' ? mainlandEnabled() : homeEnabled();
    } catch {
      return false;
    }
  };

  const adapter: JobSourceAdapter = {
    provider: id,
    kind: 'search',
    markets,
    costModel,
    queryLanguages: QUERY_LANGUAGES[id] ?? ['en'],
    transport: () => (id === 'activejobs' && fantasticTransport() === 'direct' ? 'api' : 'rapidapi'),
    sourceBoards: [id],
    isEnabled: () => enabledFor(HOME_MARKET),
    isEnabledFor: (market) => enabledFor(market),
    // Why it is off for the market the question is asked for, for the admin panels.
    //   home market   a kill switch or the missing key first (configuration), then 'quota' when the plan
    //                 stops ingest (used up, refused, or down to the reserve);
    //   the mainland  the plan gate's own reason as its registry code (../config.ts FEED_GATE_REASON_CODE), in
    //                 the gate's order: a switch, then 'plan_too_small' until a paid plan exists or while nothing
    //                 states the plan's size (the System panel shows that as 'gated'), then the key, then the
    //                 quota; a mainland call bound the operator set to 0 reads as a switch.
    // Null when it is on, or off for a reason of the moment that has no code (the client's breaker).
    disabledReason: () => {
      try {
        if (deps.isEnabled) return null;
        if (markets.includes('cn') && marketOfCall() === 'cn') {
          const gate = feedGateForMarket('cn');
          if (!gate.open) return gate.reason === 'ok' ? 'disabled' : (FEED_GATE_REASON_CODE[gate.reason] ?? 'disabled');
          return (effectiveDailyLimit(id, 'cn') ?? 0) > 0 ? null : 'kill_switch';
        }
        return offByConfig() ?? (quotaAllows(id, 'ingest') ? null : 'quota');
      } catch {
        return null;
      }
    },
    supportsCountry: (country) => rapidApiSupportsCountry(id, country),
    dailyCallLimit: () => dailyCallLimit(id),
    async fetch(query, ctx): Promise<SourceFetchResult> {
      const client = deps.provider ?? providerById(id);
      if (!client) return { jobs: [], calls: 0, error: 'provider_missing' };
      // A market the adapter does not serve is never asked (JSearch and the mainland: MARKET_STRATEGY M-6).
      if (!markets.includes(query.market)) return { jobs: [], calls: 0, error: 'market_not_served' };
      const mainland = query.market === 'cn';
      // One posting, one market: a source that serves both keeps each row in the market of its own location.
      const routed = markets.length > 1;
      // An international query for mainland China could only return rows of the other market: nothing is asked (or billed).
      if (routed && !mainland && rapidApiCountry(query.params) === MAINLAND_COUNTRY) return { jobs: [], calls: 0, notes: { other_market_location: 1 } };
      // A mainland request is role text from the taxonomy only: a query that names no role asks nothing.
      const params = mainland ? mainlandSearchParams(query.params) : rapidApiSearchParams(query.params, id);
      if (!params) return { jobs: [], calls: 0, notes: { cn_no_role_text: 1 } };
      try {
        // The pipeline reserved this call in RAProviderUsage before fetching: the client's gate must not count it again.
        const rows = await client.search(params, { signal: ctx.signal, requestId: ctx.requestId, reservedByIngest: true });
        if (rows === null) return { jobs: [], calls: 1, error: 'provider_unavailable' };
        const inputs = rows.map(inputFromRapidApiRow);
        // In both directions (see the header): the mainland index holds mainland postings only (what the provider
        // files under "China" and is in Hong Kong, Macau or Taiwan belongs to the international site, which reads
        // it through its own queries), and an international query never writes a mainland posting.
        const page = routed ? rowsOfMarket(inputs, query.market) : { kept: inputs, dropped: 0 };
        // The answer is not everything the query can return when
        //   - the provider is billed per request (JSearch answers the first pages of a ranked search: 2 pages of
        //     about 10 rows, with a cursor for more: JOB_SOURCES_INTL §3.1), or
        //   - a per-job answer is a full page (Active Jobs DB returns at most FANTASTIC_SEARCH_LIMIT rows).
        // Such a run must not count for the "missed twice" archive, or a live posting outside the page on two
        // runs would be closed as removed by its source.
        const partial = costModel === 'per_request' || (id === 'activejobs' && rows.length >= FANTASTIC_SEARCH_LIMIT);
        return {
          jobs: page.kept,
          calls: 1,
          ...(partial ? { complete: false } : {}),
          ...(page.dropped > 0 ? { notes: { wrong_market: page.dropped } } : {}),
        };
      } catch (err) {
        return { jobs: [], calls: 1, error: err instanceof Error ? err.message.slice(0, 200) : 'provider_threw' };
      }
    },
  };
  if (id === 'activejobs') {
    // Active Jobs DB asks one fixed frame whatever a query says (raFantasticJobs.ts `windowSuffix`): the window
    // stored on its queries is that frame ('week', or 'today' under RA_ONBOARDING_FANTASTIC_WINDOW=24h), read
    // when it is asked. JSearch honours the value it is given (no list).
    Object.defineProperty(adapter, 'dateWindows', { enumerable: true, get: (): readonly string[] => [fantasticSearchDateWindow()] });
  }
  return adapter;
}
