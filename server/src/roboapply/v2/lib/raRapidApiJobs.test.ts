// backend/src/roboapply/v2/lib/raRapidApiJobs.test.ts
//
// Regression tests for the JSearch client's /search-v2 migration: the endpoint
// path changed and the jobs array moved under `data.jobs` (classic /search
// returned a bare `data[]`). Verifies the client hits /search-v2, unwraps
// data.jobs, still tolerates the legacy bare shape, stamps sourceBoard, and
// keeps the never-throws contract. Run:
//   npx vitest run server/src/roboapply/v2/lib/raRapidApiJobs.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchJSearchJobs, normalizeJSearchJob, __test } from './raRapidApiJobs.js';

function rawJob(overrides: Record<string, unknown> = {}): any {
  return {
    job_id: 'BHjSRfumTmut48avAAAAAA==',
    job_title: 'Software Engineer',
    employer_name: 'Caterpillar',
    employer_logo: 'https://t0.gstatic.com/logo.png',
    job_city: 'Chicago',
    job_state: 'IL',
    job_country: 'US',
    job_is_remote: false,
    job_employment_types: ['FULLTIME'],
    job_apply_link: 'https://careers.caterpillar.com/en/jobs/r0000381373/',
    job_apply_is_direct: false,
    apply_options: [
      { apply_link: 'https://careers.caterpillar.com/en/jobs/r0000381373/', is_direct: true, publisher: 'Caterpillar Careers' },
    ],
    job_min_salary: 90000,
    job_max_salary: 130000,
    job_posted_at_datetime_utc: '2026-07-01T00:00:00.000Z',
    job_publisher: 'Caterpillar Careers',
    job_description: 'Build the future.',
    ...overrides,
  };
}

describe('normalizeJSearchJob', () => {
  it('stamps sourceBoard jsearch and the jsearch: externalId prefix', () => {
    const n = normalizeJSearchJob(rawJob(), { country: 'us', fetchedAt: new Date() })!;
    expect(n.sourceBoard).toBe('jsearch');
    expect(n.externalId).toBe('jsearch:BHjSRfumTmut48avAAAAAA==');
  });
  it('retains original fetch time and marks a missing publication date as estimated', () => {
    const fetchedAt = new Date('2026-09-12T12:00:00Z');
    const n = normalizeJSearchJob(rawJob({ job_posted_at_datetime_utc: null }), { country: 'us', fetchedAt })!;
    expect(n.postedAtEstimated).toBe(true);
    expect(n.fetchedAt).toBe(fetchedAt.toISOString());
    expect(n.salaryCurrencyInferred).toBe(true);
  });
});

describe('searchJSearchJobs — /search-v2 (fetch mocked)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    __test.reset();
    delete process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED;
    process.env.RAPID_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env = { ...saved };
    __test.reset();
    vi.unstubAllGlobals();
  });

  function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    const fn = vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('calls the /search-v2 endpoint', async () => {
    const fn = mockFetch(200, { status: 'OK', data: { jobs: [rawJob()] } });
    await searchJSearchJobs({ query: 'developer', country: 'us' });
    const url = fn.mock.calls[0][0] as string;
    expect(url).toContain('jsearch.p.rapidapi.com/search-v2?');
    expect(url).not.toContain('/search?');
  });

  it('unwraps data.jobs and normalizes', async () => {
    mockFetch(200, { status: 'OK', data: { jobs: [rawJob(), rawJob({ job_id: 'X2' })] } });
    const jobs = await searchJSearchJobs({ query: 'developer', country: 'us' });
    expect(jobs).toHaveLength(2);
    expect(jobs![0].sourceBoard).toBe('jsearch');
    expect(jobs![0].company).toBe('Caterpillar');
  });

  it('still tolerates the legacy bare data[] shape', async () => {
    mockFetch(200, { status: 'OK', data: [rawJob()] });
    const jobs = await searchJSearchJobs({ query: 'developer', country: 'us' });
    expect(jobs).toHaveLength(1);
  });

  it('non-OK envelope → null (never throws)', async () => {
    mockFetch(200, { status: 'ERROR', data: { jobs: [] } });
    expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toBeNull();
  });
  it('unknown success shape and wholly invalid rows are errors, not empty markets', async () => {
    mockFetch(200, { status: 'OK', data: { unexpected: [] } });
    expect(await searchJSearchJobs({ query: 'engineer', country: 'us' })).toBeNull();
    mockFetch(200, { status: 'OK', data: { jobs: [{ unexpected: 'row' }] } });
    expect(await searchJSearchJobs({ query: 'engineer', country: 'us' })).toBeNull();
  });
  it('zero daily budget refuses upstream calls', async () => {
    process.env.RA_ONBOARDING_JSEARCH_DAILY_BUDGET = '0';
    const fn = mockFetch(200, { status: 'OK', data: { jobs: [] } });
    expect(await searchJSearchJobs({ query: 'engineer', country: 'us' })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
  it('separates provider cache by language and page count', () => {
    const params = { query: 'engineer', country: 'us' };
    expect(__test.buildCacheKey({ ...params, language: 'en' })).not.toBe(__test.buildCacheKey({ ...params, language: 'fr' }));
    expect(__test.buildCacheKey({ ...params, numPages: 1 })).not.toBe(__test.buildCacheKey({ ...params, numPages: 2 }));
  });

  it('403 → null and opens the breaker', async () => {
    mockFetch(403, { message: 'You are not subscribed to this API.' });
    expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toBeNull();
    expect(__test.state().breakerOpen).toBe(true);
  });
});
