// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createJobSearchService, parseSearchInput, JobSearchValidationError, type SearchProvider } from './service.js';
import { canonicalApplyUrl, deduplicateJobs, normalizeJob, safeJobUrl, type ProviderJob } from './normalization.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const INPUT = { query: 'engineer', country: 'us' };
function row(overrides: Partial<ProviderJob> = {}): ProviderJob {
  return {
    externalId: 'activejobs:1', sourceBoard: 'activejobs', title: 'Software Engineer', company: 'Example Employer',
    companyLogoUrl: null, location: 'Boston, MA', locationCity: 'Boston', locationCountry: 'US',
    workType: 'unknown', employmentType: 'full_time', salaryMin: 100, salaryMax: 140,
    salaryCurrency: 'USD', salaryPeriod: 'hour', postedAt: '2026-09-11T12:00:00Z',
    fetchedAt: '2026-09-12T08:00:00Z', applyUrl: 'https://careers.example.com/jobs/1', applyIsDirect: true,
    description: 'Build software.', sourcePublisher: 'Greenhouse', ...overrides,
  };
}
function setup(adapters: SearchProvider[], extra: Record<string, string> = {}) {
  const env = { RAPID_API_KEY: 'fixture-key-not-a-secret', JOB_SEARCH_PROVIDERS: adapters.map((p) => p.id).join(','), ...extra };
  const service = createJobSearchService({ providers: adapters, env: () => env, now: () => NOW });
  return { service, env };
}
function provider(id: string, rows: ProviderJob[] | null = [row()]): SearchProvider {
  return { id, isEnabled: () => true, search: vi.fn(async () => rows) };
}

describe('search input boundary', () => {
  it('normalizes GET and JSON filters consistently', () => {
    expect(parseSearchInput({ query: '  engineer  ', country: 'TW', remote: 'true', limit: '8', employmentTypes: 'contract,full_time' }))
      .toEqual({ query: 'engineer', country: 'tw', remote: true, limit: 8, datePosted: 'all', employmentTypes: ['contract', 'full_time'] });
  });
  it.each([
    { query: '---' }, { query: 'x' }, { query: 'a'.repeat(161) }, { query: 'engineer', country: 'ZZ' },
    { query: 'engineer', limit: 51 }, { query: 'engineer', limit: {} }, { query: 'engineer', remote: 'yes' },
    { query: 'engineer', providers: ['unexpected'] }, { query: 'engineer', providers: [] },
    { query: 'engineer', datePosted: 'year' }, { query: 'engineer', salaryMin: 1 },
  ])('rejects invalid paid-search input %j', (input) => expect(() => parseSearchInput(input)).toThrow(JobSearchValidationError));
});

describe('normalization and deduplication', () => {
  it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'https://user:pass@example.com/job',
    'http://localhost/jobs/1', 'http://127.0.0.1/jobs', 'http://2130706433/jobs', 'http://[::1]/jobs', 'http://foo.internal/jobs'])
    ('rejects unsafe application URLs %s', (url) => expect(safeJobUrl(url)).toBeNull());

  it('retains requisition query IDs while removing tracking for dedup', () => {
    expect(canonicalApplyUrl('https://careers.example.com/job?req=123&utm_source=feed#apply')).toBe('careers.example.com/job?req=123');
    expect(canonicalApplyUrl('https://careers.example.com/job?req=124')).not.toBe(canonicalApplyUrl('https://careers.example.com/job?req=123'));
  });
  it('preserves source freshness and salary units without presenting inferred facts as evidence', () => {
    const result = normalizeJob(row({ salaryCurrencyInferred: true, locationCountryEstimated: true, postedAtEstimated: true }), new Date(NOW).toISOString())!;
    expect(result.postedAt).toBeNull();
    expect(result.country).toBeNull();
    expect(result.fetchedAt).toBe('2026-09-12T08:00:00.000Z');
    expect(result.remote).toBeNull();
    expect(result.salary).toEqual({ min: 100, max: 140, currency: null, period: 'hour' });
  });
  it('merges cross-source provenance and prefers an explicitly direct link', () => {
    const aggregator = normalizeJob(row({ sourceBoard: 'jsearch', externalId: 'jsearch:1', applyUrl: 'https://aggregator.example.com/job/1', applyIsDirect: false }), '')!;
    const ats = normalizeJob(row(), '')!;
    const merged = deduplicateJobs([aggregator, ats]);
    expect(merged.deduplicated).toBe(1);
    expect(merged.jobs).toHaveLength(1);
    expect(merged.jobs[0].provider).toBe('activejobs');
    expect(merged.jobs[0].sources.map((source) => source.provider)).toEqual(['jsearch', 'activejobs']);
  });
  it('does not merge unknown-location postings solely by title and company', () => {
    const jobs = ['1', '2'].map((id) => normalizeJob(row({ applyUrl: `https://careers.example.com/job/${id}`, location: null }), '')!);
    expect(deduplicateJobs(jobs).jobs).toHaveLength(2);
  });
  it('merges a bridge between URL and title-location duplicate groups', () => {
    const jobs = [
      row({ externalId: 'a1', title: 'Engineer', applyUrl: 'https://careers.example.com/job/1' }),
      row({ externalId: 'a2', sourceBoard: 'linkedin', title: 'Software Engineer', applyUrl: 'https://careers.example.com/job/2' }),
      row({ externalId: 'a3', sourceBoard: 'jsearch', title: 'Software Engineer', applyUrl: 'https://careers.example.com/job/1' }),
    ].map((value) => normalizeJob(value, '')!);
    const result = deduplicateJobs(jobs);
    expect(result.jobs).toHaveLength(1);
    expect(result.deduplicated).toBe(2);
    expect(result.jobs[0].sources).toHaveLength(3);
  });
});

describe('provider orchestration', () => {
  it('distinguishes genuine empty, failed, and unavailable providers', async () => {
    const active = provider('activejobs', []);
    const bad = provider('jsearch', null);
    const disabled = provider('linkedin');
    const { service } = setup([active, bad, disabled], { RA_ONBOARDING_LINKEDIN_JOBS_DISABLED: 'true' });
    const result = await service.search(INPUT);
    expect(result.meta.providers.map((status) => status.status)).toEqual(['empty', 'error', 'unavailable']);
    expect(result.meta.partial).toBe(true);
    expect(disabled.search).not.toHaveBeenCalled();
  });
  it('never treats missing credentials as a successful empty market', async () => {
    const adapter = provider('jsearch');
    const { service } = setup([adapter], { RAPID_API_KEY: '' });
    const result = await service.search(INPUT);
    expect(result.meta.providers[0]).toMatchObject({ status: 'unavailable', reason: 'missing_credentials' });
    expect(adapter.search).not.toHaveBeenCalled();
    expect(result.meta.partial).toBe(true);
  });
  it('requires an independent redistribution grant for API audience', async () => {
    const adapter = provider('activejobs');
    const { service, env } = setup([adapter]);
    expect((await service.search(INPUT, { audience: 'api' })).meta.providers[0]).toMatchObject({ reason: 'not_licensed' });
    expect(adapter.search).not.toHaveBeenCalled();
    env.JOB_SEARCH_API_PROVIDERS = 'activejobs';
    expect((await service.search(INPUT, { audience: 'api' })).jobs).toHaveLength(1);
  });
  it('applies remote, employment, date, and country filters without null-pass', async () => {
    const adapter = provider('activejobs', [
      row({ workType: 'remote' }),
      row({ externalId: 'a2', workType: 'remote', postedAtEstimated: true }),
      row({ externalId: 'a3', workType: 'unknown' }),
      row({ externalId: 'a4', workType: 'remote', employmentType: null }),
      row({ externalId: 'a5', workType: 'remote', locationCountry: 'Taiwan' }),
    ]);
    const { service } = setup([adapter]);
    const result = await service.search({ ...INPUT, remote: true, employmentTypes: ['full_time'], datePosted: 'week' });
    expect(result.jobs).toHaveLength(1);
    expect(result.meta.providers[0].resultCount).toBe(1);
  });
  it('caches cloned responses and retains original fetch time', async () => {
    const adapter = provider('activejobs');
    const { service } = setup([adapter]);
    const first = await service.search(INPUT, { requestId: 'first' });
    first.jobs[0].title = 'Caller mutation';
    const second = await service.search(INPUT, { requestId: 'second' });
    expect(second.meta).toMatchObject({ cache: 'hit', requestId: 'second' });
    expect(second.jobs[0].title).toBe('Software Engineer');
    expect(second.jobs[0].fetchedAt).toBe('2026-09-12T08:00:00.000Z');
    expect(adapter.search).toHaveBeenCalledTimes(1);
  });
  it('honors kill switches after a cache fill', async () => {
    const adapter = provider('activejobs');
    const { service, env } = setup([adapter]);
    await service.search(INPUT);
    env.JOB_SEARCH_DISABLED = 'true';
    const result = await service.search(INPUT);
    expect(result.jobs).toEqual([]);
    expect(result.meta.providers[0].reason).toBe('disabled');
    expect(adapter.search).toHaveBeenCalledTimes(1);
  });
  it('disables the service cache when TTL is zero', async () => {
    const adapter = provider('activejobs');
    const { service } = setup([adapter], { JOB_SEARCH_CACHE_TTL_MS: '0' });
    await service.search(INPUT);
    const second = await service.search(INPUT);
    expect(second.meta.cache).toBe('miss');
    expect(adapter.search).toHaveBeenCalledTimes(2);
  });
  it('retries a failed provider on a subsequent search instead of caching the failure', async () => {
    const adapter = provider('activejobs', null);
    const { service } = setup([adapter]);
    await service.search(INPUT); await service.search(INPUT);
    expect(adapter.search).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent searches but one caller cancellation does not abort another', async () => {
    let resolve!: (rows: ProviderJob[]) => void;
    let upstreamSignal: AbortSignal | undefined;
    const adapter: SearchProvider = { id: 'activejobs', isEnabled: () => true, search: vi.fn((_params, opts) => {
      upstreamSignal = opts?.signal;
      return new Promise((done) => { resolve = done; });
    }) };
    const { service } = setup([adapter]);
    const cancelled = new AbortController();
    const first = service.search(INPUT, { signal: cancelled.signal });
    const second = service.search(INPUT, { requestId: 'survivor' });
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstreamSignal?.aborted).toBe(false);
    resolve([row()]);
    const result = await second;
    expect(result.meta).toMatchObject({ cache: 'coalesced', requestId: 'survivor' });
    expect(result.jobs).toHaveLength(1);
    expect(adapter.search).toHaveBeenCalledTimes(1);
  });
  it('aborts upstream work when its only consumer cancels', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const adapter: SearchProvider = { id: 'activejobs', isEnabled: () => true, search: vi.fn((_params, opts) => {
      upstreamSignal = opts?.signal; return new Promise(() => {});
    }) };
    const { service } = setup([adapter]);
    const controller = new AbortController();
    const pending = service.search(INPUT, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstreamSignal?.aborted).toBe(true);
  });
  it('bounds a provider that ignores abort and reports a timeout', async () => {
    const adapter: SearchProvider = { id: 'activejobs', isEnabled: () => true, search: () => new Promise(() => {}) };
    const { service } = setup([adapter], { JOB_SEARCH_TIMEOUT_MS: '50' });
    const result = await service.search(INPUT);
    expect(result.meta.providers[0]).toMatchObject({ status: 'timeout', reason: 'deadline' });
    expect(result.meta.partial).toBe(true);
  });
  it('does not call providers for already-aborted or invalid input', async () => {
    const adapter = provider('activejobs');
    const { service } = setup([adapter]);
    await expect(service.search({ query: '?' })).rejects.toBeInstanceOf(JobSearchValidationError);
    await expect(service.search(INPUT, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.search).not.toHaveBeenCalled();
  });
});
