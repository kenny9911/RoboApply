import { createHash } from 'node:crypto';
import { externalProviders } from '../roboapply/v2/lib/raJobProviders.js';
import type { ExternalSearchParams } from '../roboapply/v2/lib/raExternalJobTypes.js';
import type { ProviderInfo, ProviderStatus, SearchInput, SearchJob, SearchResult } from './types.js';
import { deduplicateJobs, matchesFilters, normalizeJob, type ProviderJob } from './normalization.js';
import { parseSearchInput } from './validation.js';
import { isHiringIndexEnabled, searchHiringIndex } from './hiring-index.js';
import { createIndexProvider, INDEX_PROVIDER_ID } from './index-provider.js';
import { brandEnv, getCurrentBrandOrDefault, type BrandId, type ProductBrand } from '../platform/brand/index.js';

export { parseSearchInput, JobSearchValidationError } from './validation.js';
export type { SearchInput, SearchJob, SearchResult, ProviderInfo, ProviderStatus } from './types.js';

export type SearchAudience = 'website' | 'api';
export interface SearchOptions {
  requestId?: string; signal?: AbortSignal; audience?: SearchAudience;
  /** The brand the search is for (default: the brand of the current request). */
  brand?: ProductBrand;
  /** The session user or the key's owner: the reader for a provider that reads our own index. */
  userId?: string;
}
export interface SearchProvider {
  id: string;
  /** True when results depend on the reader, so a cached result is never shared between users. */
  perUser?: boolean;
  isEnabled(): boolean;
  search(params: ExternalSearchParams, opts?: { requestId?: string; signal?: AbortSignal; userId?: string; input?: SearchInput }): Promise<ProviderJob[] | null>;
}

const INFO: Record<string, Omit<ProviderInfo, 'id' | 'enabled' | 'reason'>> = {
  activejobs: { name: 'Active Jobs DB', homepage: 'https://www.fantastic.jobs/api', sourceType: 'ats' },
  hiringindex: { name: 'Hiring Index', homepage: 'https://hiringindex.org/docs', sourceType: 'ats' },
  linkedin: { name: 'LinkedIn Jobs (Fantastic Jobs)', homepage: 'https://www.fantastic.jobs/api', sourceType: 'board' },
  jsearch: { name: 'JSearch', homepage: 'https://www.openwebninja.com/api/jsearch', sourceType: 'aggregator' },
  // Our own index of ingested postings. It has no vendor page.
  [INDEX_PROVIDER_ID]: { name: 'Job index', homepage: '', sourceType: 'index' },
};
const DISABLED_ENV: Record<string, string> = {
  activejobs: 'RA_ONBOARDING_ACTIVEJOBS_DISABLED', linkedin: 'RA_ONBOARDING_LINKEDIN_JOBS_DISABLED',
  jsearch: 'RA_ONBOARDING_JSEARCH_DISABLED', hiringindex: 'JOB_SEARCH_HIRINGINDEX_DISABLED',
};
const DEFAULT_PROVIDERS: readonly SearchProvider[] = [
  externalProviders[0],
  { id: 'hiringindex', isEnabled: isHiringIndexEnabled, search: searchHiringIndex },
  ...externalProviders.slice(1),
];
const INDEX_PROVIDERS: readonly SearchProvider[] = [createIndexProvider()];

/**
 * The job-search sources of a brand (GOAPPLY_PARITY_PLAN §3.10). The capability
 * is the same on both brands; the sources are what differs (D5):
 *   - RoboApply: the RapidAPI providers and the hiring index, as before.
 *   - GoApply: `index`, our own market `cn` rows. No RapidAPI provider is ever
 *     called for GoApply (JSearch is not a GoApply source: MARKET_STRATEGY M-6).
 */
export function providersForBrand(brand: Pick<ProductBrand, 'market'>): readonly SearchProvider[] {
  return brand.market === 'cn' ? INDEX_PROVIDERS : DEFAULT_PROVIDERS;
}

function envList(value: string): Set<string> { return new Set(value.split(',').map((id) => id.trim()).filter(Boolean)); }
function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function abortError(): Error { return new DOMException('Search cancelled.', 'AbortError'); }

export class JobSearchCapacityError extends Error {
  readonly code = 'SEARCH_BUSY';
  constructor() { super('Search capacity is temporarily full. Retry shortly.'); this.name = 'JobSearchCapacityError'; }
}

interface Flight { promise: Promise<SearchResult>; controller: AbortController; consumers: number }

/** HTTP-independent service. Cache/breakers are local optimizations; routes add
 * durable account/global limits for deployments with multiple server instances. */
export function createJobSearchService(deps: {
  /** RoboApply's sources (default: the RapidAPI providers and the hiring index). */
  providers?: readonly SearchProvider[];
  /** Sources per brand; wins over `providers` for the brands it names. */
  brandProviders?: Partial<Record<BrandId, readonly SearchProvider[]>>;
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
} = {}) {
  const env = deps.env ?? (() => process.env);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { expires: number; result: SearchResult }>();
  const flights = new Map<string, Flight>();

  function adaptersFor(brand: ProductBrand): readonly SearchProvider[] {
    return deps.brandProviders?.[brand.id] ?? (brand.market === 'cn' ? INDEX_PROVIDERS : deps.providers ?? DEFAULT_PROVIDERS);
  }

  /** The ids a website search covers when the request names no source. */
  function configuredIds(brand: ProductBrand): Set<string> {
    // GoApply's sources are its own list (job sources are per market), never RoboApply's allowlist.
    if (brand.market === 'cn') return new Set(adaptersFor(brand).map((adapter) => adapter.id));
    return envList(env().JOB_SEARCH_PROVIDERS ?? 'jsearch,activejobs');
  }

  /** Sources granted to integration keys. One rule for both brands: a source is redistributed only when the operator names it. */
  function apiGrants(brand: ProductBrand): Set<string> {
    return envList(brandEnv(brand, 'JOB_SEARCH_API_PROVIDERS', env()) ?? '');
  }

  function providers(audience: SearchAudience = 'website', brand: ProductBrand = getCurrentBrandOrDefault()): ProviderInfo[] {
    const config = env();
    const adapters = adaptersFor(brand);
    const allowed = configuredIds(brand);
    // A marketplace subscription alone does not grant raw-data redistribution.
    const apiAllowed = apiGrants(brand);
    const off = brandEnv(brand, 'JOB_SEARCH_DISABLED', config) === 'true';
    return adapters.map((adapter): ProviderInfo => {
      const base = { id: adapter.id, ...(INFO[adapter.id] ?? { name: adapter.id, homepage: '', sourceType: 'aggregator' as const }) };
      if (audience === 'api' && !apiAllowed.has(adapter.id)) return { ...base, enabled: false, reason: 'not_licensed' };
      if (brand.market === 'cn') {
        // Our own index: no vendor credential, no external-provider switch.
        if (off || !allowed.has(adapter.id)) return { ...base, enabled: false, reason: 'disabled' };
        try {
          return adapter.isEnabled() ? { ...base, enabled: true } : { ...base, enabled: false, reason: 'budget_or_circuit' };
        } catch { return { ...base, enabled: false, reason: 'budget_or_circuit' }; }
      }
      if (config.JOB_SEARCH_DISABLED === 'true' || config.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED === 'true'
        || !allowed.has(adapter.id) || config[DISABLED_ENV[adapter.id]] === 'true') return { ...base, enabled: false, reason: 'disabled' };
      if (!config.RAPID_API_KEY?.trim()) return { ...base, enabled: false, reason: 'missing_credentials' };
      try {
        return adapter.isEnabled() ? { ...base, enabled: true } : { ...base, enabled: false, reason: 'budget_or_circuit' };
      } catch { return { ...base, enabled: false, reason: 'budget_or_circuit' }; }
    });
  }

  function providerParams(input: SearchInput): ExternalSearchParams {
    const employmentMap = { full_time: 'FULLTIME', part_time: 'PARTTIME', contract: 'CONTRACTOR', internship: 'INTERN' };
    return {
      query: [input.query, input.location].filter(Boolean).join(' in '), titleQuery: input.query,
      country: input.country, locationText: input.location,
      workFromHome: input.remote, datePosted: input.datePosted,
      employmentTypes: input.employmentTypes?.map((value) => employmentMap[value]).join(','),
      numPages: 1,
    };
  }

  async function execute(input: SearchInput, selected: ProviderInfo[], controller: AbortController, run: { requestId?: string; userId?: string; adapters: readonly SearchProvider[] }): Promise<SearchResult> {
    const config = env();
    const { requestId, userId, adapters } = run;
    const timeoutMs = boundedNumber(config.JOB_SEARCH_TIMEOUT_MS, 20_000, 50, 25_000);
    const params = providerParams(input);
    const searchedAt = new Date(now()).toISOString();
    const outcomes = await Promise.all(selected.map(async (info) => {
      const status: ProviderStatus = { id: info.id, name: info.name, status: 'unavailable', resultCount: 0 };
      if (!info.enabled) return { jobs: [], status: { ...status, reason: info.reason } };
      const adapter = adapters.find((item) => item.id === info.id)!;
      const timerController = new AbortController();
      const signal = AbortSignal.any([controller.signal, timerController.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        if (signal.aborted) throw abortError();
        const stopped = new Promise<never>((_, reject) => {
          onAbort = () => reject(abortError());
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => timerController.abort(), timeoutMs);
        });
        const raw = await Promise.race([adapter.search(params, { signal, requestId, userId, input }), stopped]);
        if (signal.aborted) throw abortError();
        if (!raw) return { jobs: [], status: { ...status, status: 'error' as const, reason: 'failed' as const } };
        const jobs = raw.slice(0, 100).map((job) => normalizeJob(job, searchedAt))
          .filter((job): job is SearchJob => job !== null && matchesFilters(job, input, now()));
        return { jobs, status: { ...status, status: jobs.length ? 'ok' as const : 'empty' as const, resultCount: jobs.length } };
      } catch {
        return { jobs: [], status: { ...status, status: timerController.signal.aborted ? 'timeout' as const : 'error' as const,
          reason: timerController.signal.aborted ? 'deadline' as const : 'failed' as const } };
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    }));
    const merged = deduplicateJobs(outcomes.flatMap((outcome) => outcome.jobs));
    const jobs = merged.jobs.slice(0, input.limit ?? 20);
    return { jobs, meta: {
      totalReturned: jobs.length, deduplicated: merged.deduplicated,
      partial: outcomes.length === 0 || outcomes.some(({ status }) => !['ok', 'empty'].includes(status.status)),
      providers: outcomes.map(({ status }) => status), searchedAt, cache: 'miss',
    } };
  }

  async function waitFor(flight: Flight, opts: SearchOptions): Promise<SearchResult> {
    flight.consumers += 1;
    let onAbort: (() => void) | undefined;
    try {
      if (opts.signal?.aborted) throw abortError();
      if (!opts.signal) return await flight.promise;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        opts.signal!.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([flight.promise, cancelled]);
    } finally {
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      flight.consumers -= 1;
      if (!flight.consumers) flight.controller.abort();
    }
  }

  async function search(value: SearchInput | unknown, opts: SearchOptions = {}): Promise<SearchResult> {
    const brand = opts.brand ?? getCurrentBrandOrDefault();
    const input = parseSearchInput(value, { country: brand.defaultCountry });
    if (opts.signal?.aborted) throw abortError();
    const audience = opts.audience ?? 'website';
    const adapters = adaptersFor(brand);
    const available = providers(audience, brand);
    const configured = configuredIds(brand);
    const grants = apiGrants(brand);
    const audienceDefaults = new Set([...configured].filter(id => audience === 'website' || grants.has(id)));
    // Default API searches cover the granted intersection. Unrelated website
    // sources must not force permanent partial results and disable API caching.
    // Keep diagnostics for an entirely unlicensed service or explicit requests.
    const defaults = audience === 'api' && audienceDefaults.size === 0 ? configured : audienceDefaults;
    const selected = available.filter((info) => input.providers ? input.providers.includes(info.id)
      : defaults.has(info.id));
    const credentialVersion = createHash('sha256').update(env().RAPID_API_KEY ?? '').digest('hex').slice(0, 12);
    // A source that reads as the user (our own index) is cached per reader.
    const reader = selected.some((info) => adapters.find((adapter) => adapter.id === info.id)?.perUser) ? opts.userId ?? '' : null;
    const key = JSON.stringify([input, audience, selected.map(({ id, enabled, reason }) => [id, enabled, reason]), credentialVersion, brand.id, reader]);
    const ttl = boundedNumber(env().JOB_SEARCH_CACHE_TTL_MS, 300_000, 0, 21_600_000);
    if (!ttl) cache.clear();
    const cached = ttl ? cache.get(key) : undefined;
    if (cached && cached.expires > now()) {
      cache.delete(key); cache.set(key, cached);
      const result = structuredClone(cached.result);
      result.meta.cache = 'hit'; result.meta.requestId = opts.requestId;
      return result;
    }
    cache.delete(key);
    let flight = flights.get(key);
    // A sole cancelled consumer must not poison a later caller's fresh search.
    if (flight?.controller.signal.aborted) { flights.delete(key); flight = undefined; }
    const coalesced = Boolean(flight);
    if (!flight) {
      if (flights.size >= 100) throw new JobSearchCapacityError();
      const controller = new AbortController();
      const created: Flight = { controller, consumers: 0, promise: Promise.resolve(null as unknown as SearchResult) };
      created.promise = execute(input, selected, controller, { requestId: opts.requestId, userId: opts.userId, adapters }).then((result) => {
        if (ttl && !controller.signal.aborted && !result.meta.partial) {
          cache.set(key, { expires: now() + ttl, result: structuredClone(result) });
          while (cache.size > 200) cache.delete(cache.keys().next().value!);
        }
        return result;
      }).finally(() => { if (flights.get(key) === created) flights.delete(key); });
      flights.set(key, created); flight = created;
    }
    const result = structuredClone(await waitFor(flight, opts));
    result.meta.cache = coalesced ? 'coalesced' : 'miss'; result.meta.requestId = opts.requestId;
    return result;
  }

  return { search, providers };
}

export const jobSearchService = createJobSearchService();
