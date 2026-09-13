// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeHiringIndexJob, searchHiringIndex, __test } from './hiring-index.js';
import { normalizeJob } from './normalization.js';

const RAW = {
  _id: 'fixture1', title: 'Engineer', company_name: 'Example Robotics', source_platform: 'greenhouse',
  city: 'Berlin', region: 'Berlin', country: 'Germany', country_code: 'DE', remote_flag: 'true', employment_type: 'FullTime',
  salary: { min: 85000, max: 110000, currency: 'EUR', period: '1 YEAR' }, posted_at: '2026-09-06',
  fetched_at: '2026-09-07T02:40:29Z', apply_url: 'https://careers.example.com/job/1', posting_url: 'https://careers.example.com/job/1', description: '<p>Build robots.</p>',
};

describe('Hiring Index documented contract', () => {
  beforeEach(() => { __test.reset(); vi.stubEnv('RAPID_API_KEY', 'fixture-key'); });
  afterEach(() => { __test.reset(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it('maps a documented result without inventing absent facts', () => {
    const raw = normalizeHiringIndexJob(RAW, '2026-09-12T00:00:00Z')!;
    const job = normalizeJob(raw, '2026-09-12T00:00:00Z')!;
    expect(job.location).toBe('Berlin, Germany');
    expect(job.salary).toEqual({ min: 85000, max: 110000, currency: 'EUR', period: 'year' });
    expect(job.fetchedAt).toBe('2026-09-07T02:40:29.000Z');
    expect(job.description).toContain('Build robots.');
    expect(job.description).not.toContain('<p>');
    expect(normalizeHiringIndexJob({ ...RAW, posted_at: undefined }, '2026-09-12T00:00:00Z')?.postedAtEstimated).toBe(true);
  });
  it('uses the documented POST schema, country codes, source response, and no guessed pagination', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ jobs: [RAW], total_count: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const jobs = await searchHiringIndex({ query: 'Engineer', country: 'de', locationText: 'Berlin', workFromHome: true, datePosted: 'week' });
    expect(jobs).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hiringindex.p.rapidapi.com/jobs/search');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ job_titles: ['Engineer'], country_codes: ['DE'], cities: ['Berlin'], remote_flag: ['true'], days_ago: 7, page: 1, limit: 20 });
  });
  it('does not present a malformed response as an empty market', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    expect(await searchHiringIndex({ query: 'Engineer', country: 'de' })).toBeNull();
  });
  it('honors zero upstream budget and minimum query length before billing', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await searchHiringIndex({ query: 'Go', country: 'de' })).toBeNull();
    vi.stubEnv('JOB_SEARCH_HIRINGINDEX_DAILY_BUDGET', '0');
    expect(await searchHiringIndex({ query: 'Engineer', country: 'de' })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('opens a cooldown for subscription failure without leaking upstream messages', async () => {
    const fetcher = vi.fn(async () => new Response('secret upstream body', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await searchHiringIndex({ query: 'Engineer', country: 'de' })).toBeNull();
    expect(await searchHiringIndex({ query: 'Other engineer', country: 'de' })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
