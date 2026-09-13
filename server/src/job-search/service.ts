import { createHash } from 'node:crypto';
import { externalProviders } from '../roboapply/v2/lib/raJobProviders.js';
import type { ExternalSearchParams } from '../roboapply/v2/lib/raExternalJobTypes.js';
import type { ProviderInfo, ProviderStatus, SearchInput, SearchJob, SearchResult } from './types.js';
import { deduplicateJobs, matchesFilters, normalizeJob, type ProviderJob } from './normalization.js';
import { parseSearchInput } from './validation.js';
import { isHiringIndexEnabled, searchHiringIndex } from './hiring-index.js';

export { parseSearchInput, JobSearchValidationError } from './validation.js';
export type { SearchInput, SearchJob, SearchResult, ProviderInfo, ProviderStatus } from './types.js';

export type SearchAudience = 'website' | 'api';
export interface SearchOptions { requestId?: string; signal?: AbortSignal; audience?: SearchAudience }
export interface SearchProvider {
  id: string;
  isEnabled(): boolean;
  search(params: ExternalSearchParams, opts?: { requestId?: string; signal?: AbortSignal }): Promise<ProviderJob[] | null>;
}

const INFO: Record<string, Omit<ProviderInfo, 'id' | 'enabled' | 'reason'>> = {
  activejobs: { name: 'Active Jobs DB', homepage: 'https://www.fantastic.jobs/api', sourceType: 'ats' },
  hiringindex: { name: 'Hiring Index', homepage: 'https://hiringindex.org/docs', sourceType: 'ats' },
  linkedin: { name: 'LinkedIn Jobs (Fantastic Jobs)', homepage: 'https://www.fantastic.jobs/api', sourceType: 'board' },
  jsearch: { name: 'JSearch', homepage: 'https://www.openwebninja.com/api/jsearch', sourceType: 'aggregator' },
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
  providers?: readonly SearchProvider[];
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
} = {}) {
  const adapters = deps.providers ?? DEFAULT_PROVIDERS;
  const env = deps.env ?? (() => process.env);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { expires: number; result: SearchResult }>();
  const flights = new Map<string, Flight>();

  function providers(audience: SearchAudience = 'website'): ProviderInfo[] {
    const config = env();
    const allowed = envList(config.JOB_SEARCH_PROVIDERS ?? 'jsearch,activejobs');
    // A marketplace subscription alone does not grant raw-data redistribution.
    const apiAllowed = envList(config.JOB_SEARCH_API_PROVIDERS ?? '');
    return adapters.map((adapter): ProviderInfo => {
      const base = { id: adapter.id, ...(INFO[adapter.id] ?? { name: adapter.id, homepage: '', sourceType: 'aggregator' as const }) };
      if (audience === 'api' && !apiAllowed.has(adapter.id)) return { ...base, enabled: false, reason: 'not_licensed' };
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

  async function execute(input: SearchInput, selected: ProviderInfo[], controller: AbortController, requestId?: string): Promise<SearchResult> {
    const config = env();
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
        const raw = await Promise.race([adapter.search(params, { signal, requestId }), stopped]);
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
    const input = parseSearchInput(value);
    if (opts.signal?.aborted) throw abortError();
    const audience = opts.audience ?? 'website';
    const available = providers(audience);
    const configured = envList(env().JOB_SEARCH_PROVIDERS ?? 'jsearch,activejobs');
    const grants = envList(env().JOB_SEARCH_API_PROVIDERS ?? '');
    const audienceDefaults = new Set([...configured].filter(id => audience === 'website' || grants.has(id)));
    // Default API searches cover the granted intersection. Unrelated website
    // sources must not force permanent partial results and disable API caching.
    // Keep diagnostics for an entirely unlicensed service or explicit requests.
    const defaults = audience === 'api' && audienceDefaults.size === 0 ? configured : audienceDefaults;
    const selected = available.filter((info) => input.providers ? input.providers.includes(info.id)
      : defaults.has(info.id));
    const credentialVersion = createHash('sha256').update(env().RAPID_API_KEY ?? '').digest('hex').slice(0, 12);
    const key = JSON.stringify([input, audience, selected.map(({ id, enabled, reason }) => [id, enabled, reason]), credentialVersion]);
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
      created.promise = execute(input, selected, controller, opts.requestId).then((result) => {
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
