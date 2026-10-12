// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createJobSearchService, parseSearchInput, JobSearchValidationError, type SearchProvider } from './service.js';
import { canonicalApplyUrl, deduplicateJobs, normalizeJob, safeJobUrl, type ProviderJob } from './normalization.js';
import { createIndexProvider, type IndexFeedItem } from './index-provider.js';
import { getBrand } from '../platform/brand/registry.js';
import { FILTER_FIELDS } from '../features/search/contract.js';

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
  it('LinkedIn is never on a result: no LinkedIn source link, no LinkedIn publisher, and a row whose only apply link is LinkedIn is dropped (MARKET_STRATEGY M-3, M-4, 1.5)', () => {
    // A JSearch row as the client hands it on: applies at the employer, published "LinkedIn", with the LinkedIn page as provenance.
    const kept = normalizeJob(row({ sourceBoard: 'jsearch', externalId: 'jsearch:9', applyUrl: 'https://careers.example.com/job/9', sourceUrl: 'https://tw.linkedin.com/jobs/view/123', sourcePublisher: ' LinkedIn ' }), '')!;
    expect(kept.sourceUrl).toBe('https://careers.example.com/job/9');
    expect(kept.sources).toEqual([{ provider: 'jsearch', id: 'jsearch:9', applyUrl: 'https://careers.example.com/job/9', publisher: null, sourceUrl: 'https://careers.example.com/job/9' }]);
    expect(JSON.stringify(kept)).not.toMatch(/linkedin/i);
    // Another publisher and another source page are kept as stated.
    const board = normalizeJob(row({ sourceBoard: 'jsearch', applyUrl: 'https://careers.example.com/job/9', sourceUrl: 'https://www.ziprecruiter.com/c/x/job/9', sourcePublisher: 'ZipRecruiter' }), '')!;
    expect(board).toMatchObject({ sourceUrl: 'https://www.ziprecruiter.com/c/x/job/9', sources: [{ publisher: 'ZipRecruiter' }] });
    // The only link is LinkedIn: no usable apply link, so no result (ingest refuses the same row as linkedin_only_link).
    for (const applyUrl of ['https://www.linkedin.com/jobs/view/4000000002', 'https://linkedin.com/jobs/view/1', 'https://tw.linkedin.com/jobs/view/1?trk=x']) {
      expect(normalizeJob(row({ sourceBoard: 'jsearch', applyUrl }), ''), applyUrl).toBeNull();
    }
    // A lookalike host is not LinkedIn.
    expect(normalizeJob(row({ applyUrl: 'https://notlinkedin.com/jobs/view/1' }), '')).not.toBeNull();
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

describe('MKT-4H: ranking topics (`rankBy`) go to the one retrieval pipeline, never to a ranking of our own', () => {
  const GO = getBrand('goapply');
  const RA = getBrand('roboapply');
  const item = (jobId: string, title: string): IndexFeedItem => ({
    jobId, title, company: { name: '示例科技' }, location: '上海', workModel: 'onsite', employmentType: 'full_time', pay: null,
    postedAt: '2026-09-11T00:00:00Z', lastSeenAt: '2026-09-12T02:00:00Z', fromRecruiterBank: false,
    source: { name: 'Greenhouse', kind: 'ats_public', original: '示例科技', url: `https://boards.example.cn/${jobId}`, lastVerifiedAt: '2026-09-12T02:00:00Z', via: 'ats' },
    apply: { url: `https://careers.example.cn/jobs/${jobId}`, target: 'employer' },
  });
  // Two equally recent rows.
  const plain = item('plain', '数据分析师');
  const topical = item('topical', '数据分析师（新能源，SQL）');
  /**
   * What the fake of the feed's read function says about its order:
   *   'applied'   the feed used the text for the order and says so (the row that mentions it comes first)
   *   'unapplied' the feed took the text and says it did not order by it (its own order)
   *   'silent'    the feed answers rows only (a feed without the report): nothing is known about the order
   */
  type Report = 'applied' | 'unapplied' | 'silent';
  /** The index over a fake of the feed's read function, beside a RapidAPI provider that must stay untouched on GoApply. */
  function indexSetup(report: Report = 'applied', extra: Record<string, string> = {}) {
    const preview = vi.fn(async (_userId: string, input: { q?: string; relevance?: string }) => {
      if (!input.relevance) return [plain, topical];
      if (report === 'applied') return { items: [topical, plain], relevanceApplied: true };
      if (report === 'unapplied') return { items: [plain, topical], relevanceApplied: false };
      return [plain, topical];
    });
    const rapid = provider('jsearch');
    const env = { RAPID_API_KEY: 'fixture-key-not-a-secret', JOB_SEARCH_PROVIDERS: 'jsearch', ...extra };
    const service = createJobSearchService({ providers: [rapid], brandProviders: { goapply: [createIndexProvider({ preview, filterFields: async () => FILTER_FIELDS })] }, env: () => env, now: () => NOW });
    return { service, preview, rapid, env };
  }

  it('the index is read with the request\'s query as q and the topics as relevance; the rows keep the feed\'s order; the order is named because the feed said it applied it; no outside provider is fetched', async () => {
    const { service, preview, rapid } = indexSetup('applied');
    const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['新能源', 'SQL'] });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith('u1', expect.objectContaining({ q: '数据分析师', relevance: '新能源 SQL', limit: 50 }));
    // The row that mentions the topics precedes the equally recent one that does not: the feed's order, untouched here.
    expect(result.jobs.map((job) => job.title)).toEqual(['数据分析师（新能源，SQL）', '数据分析师']);
    expect(result.meta.rankedBy).toEqual(['新能源', 'SQL']);
    expect(result.meta.providers).toEqual([{ id: 'index', name: 'Job index', status: 'ok', resultCount: 2 }]);
    expect(rapid.search).not.toHaveBeenCalled();
  });

  it.each(['unapplied', 'silent'] as const)('a feed that did not say it ordered by the topics (%s): the text is still sent, the rows keep the feed\'s order, and NO order is named (D3)', async (report) => {
    const { service, preview, rapid } = indexSetup(report);
    const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['新能源', 'SQL'] });
    expect(preview).toHaveBeenCalledWith('u1', expect.objectContaining({ q: '数据分析师', relevance: '新能源 SQL' }));
    expect(result.jobs.map((job) => job.title)).toEqual(['数据分析师', '数据分析师（新能源，SQL）']);
    expect(result.meta).not.toHaveProperty('rankedBy');
    expect(result.meta.providers).toEqual([{ id: 'index', name: 'Job index', status: 'ok', resultCount: 2 }]);
    expect(rapid.search).not.toHaveBeenCalled();
  });

  it('the report is the feed\'s own word, read strictly: only `relevanceApplied: true` names an order', async () => {
    for (const said of [undefined, null, 'true', 1, {}]) {
      const preview = vi.fn(async () => ({ items: [topical, plain], relevanceApplied: said as never }));
      const service = createJobSearchService({ brandProviders: { goapply: [createIndexProvider({ preview, filterFields: async () => FILTER_FIELDS })] }, env: () => ({}), now: () => NOW });
      const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['SQL'] });
      expect(result.meta, String(said)).not.toHaveProperty('rankedBy');
      expect(result.jobs, String(said)).toHaveLength(2);
    }
  });

  it('a keyword search asks for no order: no relevance is sent and the result carries no rankedBy (its shape is what it was), whatever the feed would report', async () => {
    const { service, preview } = indexSetup('applied');
    const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' });
    expect((preview.mock.calls[0] as unknown[])[1]).toEqual({ q: '数据分析师', filters: expect.any(Object), limit: 50 });
    expect(result.jobs.map((job) => job.title)).toEqual(['数据分析师', '数据分析师（新能源，SQL）']);
    expect(Object.keys(result.meta).sort()).toEqual(['cache', 'deduplicated', 'partial', 'providers', 'requestId', 'searchedAt', 'totalReturned']);
    // Empty or blank topics are "none".
    const blank = await service.search({ query: '数据分析师', limit: 5 }, { brand: GO, userId: 'u1', rankBy: ['', '  '] });
    expect(blank.meta).not.toHaveProperty('rankedBy');
    expect((preview.mock.calls[1] as unknown[])[1]).not.toHaveProperty('relevance');
    // A feed that reports an applied order for a read that carried no text is not believed either.
    const eager = vi.fn(async () => ({ items: [plain], relevanceApplied: true }));
    const other = createJobSearchService({ brandProviders: { goapply: [createIndexProvider({ preview: eager, filterFields: async () => FILTER_FIELDS })] }, env: () => ({}), now: () => NOW });
    expect((await other.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' })).meta).not.toHaveProperty('rankedBy');
  });

  it('the cache keeps two orders of one query apart on the index, and a cached answer still says what it was ordered by', async () => {
    const { service, preview } = indexSetup('applied');
    const first = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['新能源'] });
    const plainSearch = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1' });
    const other = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['SQL'] });
    expect(preview).toHaveBeenCalledTimes(3);
    expect([first.meta.cache, plainSearch.meta.cache, other.meta.cache]).toEqual(['miss', 'miss', 'miss']);
    const again = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['新能源'] });
    expect(again.meta).toMatchObject({ cache: 'hit', rankedBy: ['新能源'] });
    expect(again.jobs.map((job) => job.title)).toEqual(first.jobs.map((job) => job.title));
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it('the index failed: nothing was ordered, so the result claims no order', async () => {
    const { service, preview } = indexSetup('applied');
    preview.mockRejectedValueOnce(new Error('index offline'));
    const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['新能源'] });
    expect(result.meta.providers[0]).toMatchObject({ status: 'error', reason: 'failed' });
    expect(result.meta).not.toHaveProperty('rankedBy');
  });

  it('RoboApply: a RapidAPI provider is never handed the topics, its rows stay in provider order, no order is claimed, and the cache is not split by topics', async () => {
    const rows = [row({ externalId: 'a1', title: 'Backend Engineer, Payments', applyUrl: 'https://careers.example.com/jobs/1' }), row({ externalId: 'a2', title: 'Backend Engineer (Rust), climate startup', applyUrl: 'https://careers.example.com/jobs/2' })];
    const adapter = provider('activejobs', rows);
    const { service } = setup([adapter]);
    const result = await service.search(INPUT, { brand: RA, rankBy: ['climate startups', 'Rust'] });
    expect((adapter.search as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('relevance');
    expect(result.jobs.map((job) => job.title)).toEqual(['Backend Engineer, Payments', 'Backend Engineer (Rust), climate startup']);
    expect(result.meta).not.toHaveProperty('rankedBy');
    // The same query with other topics, or none, is one paid provider call.
    expect((await service.search(INPUT, { brand: RA, rankBy: ['fintech'] })).meta.cache).toBe('hit');
    expect((await service.search(INPUT, { brand: RA })).meta.cache).toBe('hit');
    expect(adapter.search).toHaveBeenCalledTimes(1);
  });

  it('a source that can read the topics but answers rows alone claims nothing: a capability is never an applied order', async () => {
    const capable: SearchProvider = { id: 'activejobs', readsRelevance: true, isEnabled: () => true, search: vi.fn(async () => [row()]) };
    const { service } = setup([capable]);
    const result = await service.search(INPUT, { rankBy: ['Rust'] });
    expect((capable.search as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ relevance: 'Rust' });
    expect(result.jobs).toHaveLength(1);
    expect(result.meta).not.toHaveProperty('rankedBy');
  });

  it('a result with no rows was ordered by nothing: no order is named even when the source says it applied one', async () => {
    const preview = vi.fn(async () => ({ items: [], relevanceApplied: true }));
    const service = createJobSearchService({ brandProviders: { goapply: [createIndexProvider({ preview, filterFields: async () => FILTER_FIELDS })] }, env: () => ({}), now: () => NOW });
    const result = await service.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['SQL'] });
    expect(result.jobs).toEqual([]);
    expect(result.meta.providers[0]).toMatchObject({ status: 'empty' });
    expect(result.meta).not.toHaveProperty('rankedBy');
    // Rows that the shared normaliser drops (no apply link) are not rows of the result either.
    const dropped = vi.fn(async () => ({ items: [{ ...topical, apply: { url: null } }], relevanceApplied: true }));
    const other = createJobSearchService({ brandProviders: { goapply: [createIndexProvider({ preview: dropped, filterFields: async () => FILTER_FIELDS })] }, env: () => ({}), now: () => NOW });
    expect((await other.search({ query: '数据分析师' }, { brand: GO, userId: 'u1', rankBy: ['SQL'] })).meta).not.toHaveProperty('rankedBy');
  });

  it('a mixed source list claims an order only when every source that returned rows said it applied it', async () => {
    const ordering = (): SearchProvider => ({ id: 'activejobs', readsRelevance: true, isEnabled: () => true, search: vi.fn(async () => ({ jobs: [row()], rankedByRelevance: true })) });
    const other = provider('jsearch', [row({ externalId: 'j9', sourceBoard: 'jsearch', title: 'Data Engineer', applyUrl: 'https://careers.example.com/jobs/9' })]);
    const first = ordering();
    const mixed = setup([first, other]);
    const both = await mixed.service.search(INPUT, { rankBy: ['Rust'] });
    expect((first.search as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ relevance: 'Rust' });
    expect((other.search as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('relevance');
    expect(both.meta).not.toHaveProperty('rankedBy');
    // The other source did not answer, or answered with no rows: what came back is all ordered.
    const alone = setup([ordering(), provider('jsearch', null)]);
    expect((await alone.service.search(INPUT, { rankBy: ['Rust'] })).meta.rankedBy).toEqual(['Rust']);
    const empty = setup([ordering(), provider('jsearch', [])]);
    expect((await empty.service.search(INPUT, { rankBy: ['Rust'] })).meta.rankedBy).toEqual(['Rust']);
  });
});
