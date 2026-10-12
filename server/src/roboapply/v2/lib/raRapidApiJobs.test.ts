// backend/src/roboapply/v2/lib/raRapidApiJobs.test.ts
//
// Regression tests for the JSearch client's /search-v2 migration: the endpoint
// path changed and the jobs array moved under `data.jobs` (classic /search
// returned a bare `data[]`). Verifies the client hits /search-v2, unwraps
// data.jobs, still tolerates the legacy bare shape, stamps sourceBoard, and
// keeps the never-throws contract. Run:
//   npx vitest run server/src/roboapply/v2/lib/raRapidApiJobs.test.ts
//
// MKT-3A: the apply link is chosen by its host (JI-6: the provider sends one
// apply option per job and never sets is_direct); the client keeps no call
// counter of its own: it asks the call gate before every upstream call and
// tells the quota listener what every upstream response said (JI-1). Every row
// and header below is SYNTHETIC; no test reaches the network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isJSearchEnabled, searchJSearchJobs, normalizeJSearchJob, setCallGate, setQuotaListener, __test } from './raRapidApiJobs.js';
import type { ProviderQuotaObservation } from './raExternalJobTypes.js';

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
  it('a LinkedIn page is never the row\'s source link: the first link that is not on LinkedIn is (MARKET_STRATEGY 1.5)', () => {
    const link = 'https://www.linkedin.com/jobs/view/1234567890';
    const n = normalizeJSearchJob(rawJob({ job_apply_link: link, job_publisher: 'LinkedIn' }), { country: 'us', fetchedAt: new Date() })!;
    expect(n.applyIsDirect).toBe(true);
    expect(n.applyUrl).toContain('careers.caterpillar.com');
    expect(n.sourceUrl).toBe(n.applyUrl);
  });
  it('a LinkedIn posting among the alternative apply options changes nothing', () => {
    const link = 'https://tw.linkedin.com/jobs/view/software-engineer-1234567890?trackingId=example';
    const raw = rawJob();
    raw.apply_options.push({ apply_link: link, is_direct: false, publisher: 'LinkedIn' });
    const n = normalizeJSearchJob(raw, { country: 'us', fetchedAt: new Date() })!;
    expect(n.sourceUrl).toBe(raw.job_apply_link);
    expect(n.applyUrl).toBe(raw.job_apply_link);
  });
  it('a row whose only link is on LinkedIn has no source link at all', () => {
    const link = 'https://www.linkedin.com/jobs/view/1234567890';
    const n = normalizeJSearchJob(rawJob({ job_apply_link: link, apply_options: [{ apply_link: link, is_direct: false, publisher: 'LinkedIn' }] }), { country: 'us', fetchedAt: new Date() })!;
    expect(n.sourceUrl).toBeNull();
  });
  it.each([
    'https://linkedin.com.example.org/jobs/view/123',
    'https://notlinkedin.com/jobs/view/123',
    'https://linkedin.com@evil.example/jobs/view/123',
    'https://linkedin.com/company/example',
    'javascript:linkedin.com/jobs/view/123',
  ])('does not prefer a lookalike or non-posting source URL: %s', (link) => {
    const raw = rawJob();
    raw.apply_options.push({ apply_link: link, is_direct: false, publisher: 'LinkedIn' });
    const n = normalizeJSearchJob(raw, { country: 'us', fetchedAt: new Date() })!;
    expect(n.sourceUrl).toBe(raw.job_apply_link);
  });
});

describe('the apply link is decided by its host (JI-6)', () => {
  // SYNTHETIC rows in the shape the 2026-10-11 probes found: one apply option per job, is_direct false on all 58.
  const at = { country: 'us', fetchedAt: new Date('2026-10-11T00:00:00Z') };
  const row = (links: { apply: string | null; options?: Array<{ apply_link: unknown; is_direct?: boolean; publisher?: string }>; direct?: boolean }) =>
    rawJob({ job_apply_link: links.apply, job_apply_is_direct: links.direct ?? false, apply_options: links.options ?? (links.apply ? [{ apply_link: links.apply, is_direct: false, publisher: 'x' }] : []) });

  it('a single link on an ATS host is the employer\'s: direct', () => {
    const link = 'https://boards.greenhouse.io/acme/jobs/1';
    const n = normalizeJSearchJob(row({ apply: link }), at)!;
    expect(n.applyUrl).toBe(link);
    expect(n.applyIsDirect).toBe(true);
    expect(n.sourceUrl).toBe(link);
  });

  it('a LinkedIn link plus an employer option: applies on the employer site, which is the source link too', () => {
    const linkedin = 'https://www.linkedin.com/jobs/view/4000000001';
    const employer = 'https://careers.acme.com/jobs/88';
    const n = normalizeJSearchJob(
      row({ apply: linkedin, options: [{ apply_link: linkedin, is_direct: false, publisher: 'LinkedIn' }, { apply_link: employer, is_direct: false, publisher: 'Acme Careers' }] }),
      at,
    )!;
    expect(n.applyUrl).toBe(employer);
    expect(n.applyIsDirect).toBe(true);
    expect(n.sourceUrl).toBe(employer);
  });

  it('a row whose only link is a job board is not direct', () => {
    const link = 'https://www.ziprecruiter.com/c/Acme/Job/Engineer/-in-Austin,TX?jid=1';
    const n = normalizeJSearchJob(row({ apply: link }), at)!;
    expect(n.applyUrl).toBe(link);
    expect(n.applyIsDirect).toBe(false);
  });

  it('empty apply_options and is_direct false everywhere: the URL as before, the flag from the host', () => {
    const employer = normalizeJSearchJob(row({ apply: 'https://jobs.acme.example/role/7', options: [] }), at)!;
    expect(employer).toMatchObject({ applyUrl: 'https://jobs.acme.example/role/7', applyIsDirect: true });
    const board = normalizeJSearchJob(row({ apply: 'https://www.indeed.com/viewjob?jk=abc', options: [] }), at)!;
    expect(board).toMatchObject({ applyUrl: 'https://www.indeed.com/viewjob?jk=abc', applyIsDirect: false });
    // A LinkedIn-only row still leaves the client with its link; no caller shows it: the normalizer does not
    // ingest it and the job-search API drops it (job-search/normalization.ts).
    const linkedin = normalizeJSearchJob(row({ apply: 'https://www.linkedin.com/jobs/view/4000000002', options: [] }), at)!;
    expect(linkedin).toMatchObject({ applyUrl: 'https://www.linkedin.com/jobs/view/4000000002', applyIsDirect: false });
  });

  it('order: employer or ATS host, then a job board, then LinkedIn, whatever order the provider lists them in', () => {
    const pick = (j: unknown) => __test.pickApplyUrl(j);
    const linkedin = 'https://www.linkedin.com/jobs/view/4000000003';
    const board = 'https://www.glassdoor.com/job-listing/x?jl=1';
    const ats = 'https://jobs.lever.co/acme/abc';
    expect(pick({ job_apply_link: linkedin, apply_options: [{ apply_link: board }, { apply_link: ats }] })).toEqual({ url: ats, isDirect: true });
    expect(pick({ job_apply_link: linkedin, apply_options: [{ apply_link: linkedin }, { apply_link: board }] })).toEqual({ url: board, isDirect: false });
    expect(pick({ job_apply_link: linkedin, apply_options: [] })).toEqual({ url: linkedin, isDirect: false });
    // Google's own job search page is an aggregator; careers.google.com is an employer.
    expect(pick({ job_apply_link: 'https://www.google.com/search?q=jobs&ibp=htl;jobs', apply_options: [] })).toMatchObject({ isDirect: false });
    expect(pick({ job_apply_link: 'https://careers.google.com/jobs/results/1', apply_options: [] })).toMatchObject({ isDirect: true });
  });

  it('an explicit direct flag is still honoured on a job-board link, never on a LinkedIn link', () => {
    const pick = (j: unknown) => __test.pickApplyUrl(j);
    const a = 'https://www.monster.com/job-openings/a';
    const b = 'https://www.ziprecruiter.com/jobs/b';
    expect(pick({ job_apply_link: a, job_apply_is_direct: true, apply_options: [] })).toEqual({ url: a, isDirect: true });
    expect(pick({ job_apply_link: a, apply_options: [{ apply_link: a, is_direct: false }, { apply_link: b, is_direct: true }] })).toEqual({ url: b, isDirect: true });
    expect(pick({ job_apply_link: 'https://www.linkedin.com/jobs/view/4000000004', job_apply_is_direct: true, apply_options: [] })).toMatchObject({ isDirect: false });
  });

  it('an invalid URL is never a candidate', () => {
    const pick = (j: unknown) => __test.pickApplyUrl(j);
    const good = 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin/Engineer_R1';
    expect(
      pick({
        job_apply_link: 'javascript:alert(1)',
        apply_options: [{ apply_link: 'not a url' }, { apply_link: 42 }, { apply_link: 'ftp://files.acme.com/job' }, { apply_link: 'https://user:pw@careers.acme.com/1' }, null, { apply_link: good }],
      }),
    ).toEqual({ url: good, isDirect: true });
    expect(pick({ job_apply_link: 'javascript:alert(1)', apply_options: [{ apply_link: '' }] })).toEqual({ url: null, isDirect: false });
    expect(pick({ job_apply_link: null, apply_options: 'nope' })).toEqual({ url: null, isDirect: false });
    const n = normalizeJSearchJob(row({ apply: 'javascript:alert(1)', options: [{ apply_link: 'not a url' }] }), at)!;
    expect(n.applyUrl ?? null).toBeNull();
    expect(n.applyIsDirect).toBe(false);
  });

  it('nothing reads job_highlights (empty on every probed row): a row with and without it normalizes the same', () => {
    const base = row({ apply: 'https://boards.greenhouse.io/acme/jobs/1' });
    expect(normalizeJSearchJob({ ...base, job_highlights: { Qualifications: ['x'], Responsibilities: ['y'] } }, at)).toEqual(normalizeJSearchJob(base, at));
  });
});

describe('employment type labels (PAR-7): Chinese display strings map like the English enums', () => {
  it.each([
    ['FULLTIME', 'full_time'],
    ['Contractor', 'contract'],
    ['全职', 'full_time'],
    ['兼职', 'part_time'],
    ['实习', 'internship'],
    ['合同', 'contract'],
    ['劳务', 'contract'],
    ['其他', null],
  ])('%s → %s', (label, expected) => {
    const job = normalizeJSearchJob({ job_id: 'x', job_title: '工程师', employer_name: 'Acme', job_employment_type: label }, { country: 'us', fetchedAt: new Date('2026-10-10T00:00:00Z') })!;
    expect(job.employmentType).toBe(expected);
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
  it('keeps no call counter of its own: the old client-local budget variable refuses nothing here', async () => {
    // RA_ONBOARDING_JSEARCH_DAILY_BUDGET is now a deprecated alias of INGEST_JSEARCH_DAILY_CALLS, read by the
    // one budget in features/jobs/ingest (quota.test.ts covers the refusal); with no gate registered every call is allowed.
    process.env.RA_ONBOARDING_JSEARCH_DAILY_BUDGET = '0';
    const fn = mockFetch(200, { status: 'OK', data: { jobs: [] } });
    expect(await searchJSearchJobs({ query: 'engineer', country: 'us' })).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(__test.state()).toEqual({ breakerOpen: false, cacheSize: 1 });
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

  describe('the call gate (one budget per provider)', () => {
    afterEach(() => setCallGate(null));

    it('a gate that refuses: no upstream call, null', async () => {
      const gate = vi.fn(() => false);
      setCallGate(gate);
      const fn = mockFetch(200, { status: 'OK', data: { jobs: [rawJob()] } });
      expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toBeNull();
      expect(fn).not.toHaveBeenCalled();
      expect(gate).toHaveBeenCalledWith('jsearch', 'interactive', undefined);
    });

    it("a gate that allows is asked once per upstream call: 'interactive' for a person's search, 'ingest' when ingest already counted it", async () => {
      const gate = vi.fn(() => true);
      setCallGate(gate);
      const fn = mockFetch(200, { status: 'OK', data: { jobs: [rawJob()] } });
      expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toHaveLength(1);
      expect(await searchJSearchJobs({ query: 'designer', country: 'us' }, { reservedByIngest: true })).toHaveLength(1);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(gate.mock.calls).toEqual([
        ['jsearch', 'interactive', undefined],
        ['jsearch', 'ingest', undefined],
      ]);
    });

    it('a cache hit never reaches the gate', async () => {
      const gate = vi.fn(() => true);
      setCallGate(gate);
      const fn = mockFetch(200, { status: 'OK', data: { jobs: [rawJob()] } });
      await searchJSearchJobs({ query: 'developer', country: 'us' });
      // The quota is now spent: the gate would refuse, but the cached answer costs nothing.
      gate.mockReturnValue(false);
      expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toHaveLength(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(gate).toHaveBeenCalledTimes(1);
    });

    it('isJSearchEnabled asks the gate without counting a call (probe); a gate that throws allows', async () => {
      const gate = vi.fn((_provider: string, _purpose: string, opts?: { probe?: boolean }) => opts?.probe !== true);
      setCallGate(gate);
      expect(isJSearchEnabled()).toBe(false);
      expect(gate).toHaveBeenCalledWith('jsearch', 'interactive', { probe: true });
      setCallGate(() => true);
      expect(isJSearchEnabled()).toBe(true);
      setCallGate(() => {
        throw new Error('gate broke');
      });
      expect(isJSearchEnabled()).toBe(true);
      const fn = mockFetch(200, { status: 'OK', data: { jobs: [] } });
      expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toEqual([]);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('the one retry after a per-second 429 is a second upstream call: the gate is asked again', async () => {
      const gate = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
      setCallGate(gate);
      const fn = mockFetch(429, { message: 'Too many requests' }, { 'x-ratelimit-requests-remaining': '9000' });
      expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toBeNull();
      expect(gate).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(__test.state().breakerOpen).toBe(false);
    });
  });

  describe('the quota listener (what every upstream response said about the plan)', () => {
    afterEach(() => setQuotaListener(null));
    const quota = { 'x-ratelimit-requests-limit': '10000', 'x-ratelimit-requests-remaining': '9773', 'x-ratelimit-requests-reset': '1460160' };

    it('200: limit, remaining and seconds to reset; once per upstream response, not for a cache hit', async () => {
      const seen: ProviderQuotaObservation[] = [];
      setQuotaListener((o) => seen.push(o));
      mockFetch(200, { status: 'OK', data: { jobs: [rawJob()] } }, quota);
      await searchJSearchJobs({ query: 'developer', country: 'us' });
      await searchJSearchJobs({ query: 'developer', country: 'us' }); // cache hit
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ provider: 'jsearch', status: 200, requestsLimit: 10_000, requestsRemaining: 9_773, resetSeconds: 1_460_160, jobsLimit: null, jobsRemaining: null, plan: null, reason: null });
      expect(seen[0]!.at).toBeInstanceOf(Date);
      expect(JSON.stringify(seen)).not.toContain('test-key');
    });

    it('429 with remaining 0: the monthly quota, with the plan name from the body', async () => {
      const seen: ProviderQuotaObservation[] = [];
      setQuotaListener((o) => seen.push(o));
      mockFetch(429, { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC. Upgrade your plan.' }, { ...quota, 'x-ratelimit-requests-remaining': '0' });
      expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ status: 429, requestsRemaining: 0, plan: 'BASIC', reason: 'monthly_quota', resetSeconds: 1_460_160 });
      expect(__test.state().breakerOpen).toBe(true);
    });

    it('403 not subscribed and 401 are reported with their reason', async () => {
      const seen: ProviderQuotaObservation[] = [];
      setQuotaListener((o) => seen.push(o));
      mockFetch(403, { message: 'You are not subscribed to this API.' });
      await searchJSearchJobs({ query: 'developer', country: 'us' });
      __test.reset();
      mockFetch(401, { message: 'Invalid API key' });
      await searchJSearchJobs({ query: 'developer', country: 'us' });
      expect(seen.map((o) => [o.status, o.reason, o.requestsRemaining])).toEqual([
        [403, 'not_subscribed', null],
        [401, null, null],
      ]);
    });

    it("a listener that answers with a promise (a reading being stored) is waited for by a person's search, at most 500 ms; never by an ingest call", async () => {
      vi.useFakeTimers();
      try {
        // A write that never finishes: the search must still return, after the bound.
        setQuotaListener(() => new Promise(() => undefined));
        mockFetch(200, { status: 'OK', data: { jobs: [rawJob()] } }, quota);
        let done = false;
        const search = searchJSearchJobs({ query: 'developer', country: 'us' }).then((rows) => {
          done = true;
          return rows;
        });
        await vi.advanceTimersByTimeAsync(499);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await search).toHaveLength(1);
        // The pipeline's own call returns without waiting: its tick awaits the writes.
        let ingestDone = false;
        const ingest = searchJSearchJobs({ query: 'designer', country: 'us' }, { reservedByIngest: true }).then((rows) => {
          ingestDone = true;
          return rows;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ingestDone).toBe(true);
        expect(await ingest).toHaveLength(1);
        // A write that finishes is not waited for any longer than it takes; one that fails does not fail the search.
        setQuotaListener(() => Promise.reject(new Error('db down')));
        expect(await searchJSearchJobs({ query: 'writer', country: 'us' })).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a listener that throws does not fail the search', async () => {
      setQuotaListener(() => {
        throw new Error('listener broke');
      });
      mockFetch(200, { status: 'OK', data: { jobs: [rawJob()] } }, quota);
      expect(await searchJSearchJobs({ query: 'developer', country: 'us' })).toHaveLength(1);
      mockFetch(429, { message: 'MONTHLY quota exceeded on your current plan, BASIC' }, { 'x-ratelimit-requests-remaining': '0' });
      expect(await searchJSearchJobs({ query: 'designer', country: 'us' })).toBeNull();
    });
  });
});
