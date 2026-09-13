// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/LoggerService.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { createJobSearchService, type SearchProvider } from './service.js';
import type { ProviderJob } from './normalization.js';

/** Forward test for the reusable integration skill: "Enable the external API
 * using the jobs already cached by our website." All providers are fixtures. */
describe('website cache cannot confer integration data rights', () => {
  const query = { query: 'engineer', country: 'us' };
  function fixture(id: string): SearchProvider {
    const job: ProviderJob = {
      externalId: `${id}:fixture`, sourceBoard: id, title: 'Engineer', company: 'Fixture Employer',
      companyLogoUrl: null, location: 'Boston', locationCity: 'Boston', locationCountry: 'US',
      workType: 'remote', employmentType: 'full_time', salaryMin: null, salaryMax: null,
      salaryCurrency: null, salaryPeriod: null, postedAt: '2026-09-12T00:00:00Z',
      fetchedAt: '2026-09-12T01:00:00Z', applyUrl: 'https://careers.example.com/jobs/same-id',
      applyIsDirect: id === 'activejobs', description: `${id} fixture description`, sourcePublisher: id,
    };
    return { id, isEnabled: () => true, search: vi.fn(async () => [job]) };
  }

  it('excludes restricted source content and attribution after cross-source website dedup', async () => {
    const active = fixture('activejobs'); const jsearch = fixture('jsearch');
    const env: NodeJS.ProcessEnv = { RAPID_API_KEY: 'fixture', JOB_SEARCH_PROVIDERS: 'activejobs,jsearch' };
    const service = createJobSearchService({ providers: [active, jsearch], env: () => env });
    const website = await service.search(query);
    expect(website.jobs[0].sources.map(s => s.provider)).toEqual(['activejobs', 'jsearch']);
    expect(website.jobs[0].description).toBe('activejobs fixture description');
    expect((await service.search(query)).meta.cache).toBe('hit');

    const unlicensed = await service.search(query, { audience: 'api' });
    expect(unlicensed.jobs).toEqual([]);
    expect(unlicensed.meta.providers.every(p => p.reason === 'not_licensed')).toBe(true);
    expect(active.search).toHaveBeenCalledTimes(1);
    expect(jsearch.search).toHaveBeenCalledTimes(1);

    env.JOB_SEARCH_API_PROVIDERS = 'jsearch';
    const licensed = await service.search(query, { audience: 'api' });
    expect(licensed.jobs).toHaveLength(1);
    expect(licensed.jobs[0].sources.map(s => s.provider)).toEqual(['jsearch']);
    expect(licensed.jobs[0].description).toBe('jsearch fixture description');
    expect(active.search).toHaveBeenCalledTimes(1);
    expect(jsearch.search).toHaveBeenCalledTimes(2);
    expect(licensed.meta.partial).toBe(false);
    expect(licensed.meta.providers.map(p => p.id)).toEqual(['jsearch']);
    expect((await service.search(query, { audience: 'api' })).meta.cache).toBe('hit');
    const explicitlyDenied = await service.search({ ...query, providers: ['activejobs'] }, { audience: 'api' });
    expect(explicitlyDenied.jobs).toEqual([]);
    expect(active.search).toHaveBeenCalledTimes(1);
  });

  it('revoking an API grant or website allowlist prevents access to a warmed API cache', async () => {
    const adapter = fixture('jsearch');
    const env: NodeJS.ProcessEnv = { RAPID_API_KEY: 'fixture', JOB_SEARCH_PROVIDERS: 'jsearch', JOB_SEARCH_API_PROVIDERS: 'jsearch' };
    const service = createJobSearchService({ providers: [adapter], env: () => env });
    await service.search(query, { audience: 'api' });
    expect((await service.search(query, { audience: 'api' })).meta.cache).toBe('hit');
    env.JOB_SEARCH_API_PROVIDERS = '';
    expect((await service.search(query, { audience: 'api' })).jobs).toEqual([]);
    env.JOB_SEARCH_API_PROVIDERS = 'jsearch';
    env.JOB_SEARCH_PROVIDERS = '';
    const result = await service.search({ ...query, providers: ['jsearch'] }, { audience: 'api' });
    expect(result.jobs).toEqual([]);
    expect(result.meta.providers[0].reason).toBe('disabled');
    expect(adapter.search).toHaveBeenCalledTimes(1);
  });
});
