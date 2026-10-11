// backend/src/roboapply/v2/lib/raFantasticJobs.test.ts
//
// Unit tests for the Fantastic Jobs client (Active Jobs DB; the LinkedIn
// board was removed at the M3 gate of the market wave). Focus: the load-bearing normalizer mapping (the synthesis §1 table),
// request building, window/kill-switch gating, and the never-throws
// contract. Run: npx vitest run server/src/roboapply/v2/lib/raFantasticJobs.test.ts
//
// MKT-3A: the client keeps no call counter of its own. It asks the call gate
// before every upstream call and tells the quota listener what every upstream
// response said about the plan (requests and jobs limit / remaining, the reset,
// the plan's name on a 429). Rows and headers are SYNTHETIC; no network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeFantasticJob,
  searchFantasticJobs,
  isFantasticJobsEnabled,
  setCallGate,
  setQuotaListener,
  __test,
} from './raFantasticJobs.js';
import type { ProviderQuotaObservation } from './raExternalJobTypes.js';

const FETCH_AT = new Date('2026-07-13T12:00:00.000Z');

// A representative Active Jobs DB row (raw RapidAPI field names).
function atsRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: '1737000000-0d4f2c9e5b7a41e8b0c2f3a1',
    title: 'Senior Software Engineer',
    organization: 'Acme Corporation',
    organization_logo: 'https://media.example.com/acme.png',
    organization_url: 'https://www.linkedin.com/company/acme',
    locations_derived: ['San Francisco, California, United States'],
    cities_derived: ['San Francisco'],
    regions_derived: ['California'],
    countries_derived: ['United States'],
    locations_raw: [
      { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'US', addressLocality: 'San Francisco' } },
    ],
    location_type: null,
    remote_derived: false,
    employment_type: ['FULL_TIME'],
    salary_raw: {
      '@type': 'MonetaryAmount',
      currency: 'USD',
      value: { '@type': 'QuantitativeValue', minValue: 120000, maxValue: 180000, unitText: 'YEAR' },
    },
    date_posted: '2026-07-10T00:00:00',
    date_created: '2026-07-11T08:30:00Z',
    url: 'https://careers.acme.com/jobs/123',
    source_type: 'ats',
    source: 'greenhouse',
    source_domain: 'boards.greenhouse.io',
    description_text: 'We are hiring a senior engineer.',
    ...overrides,
  };
}

describe('normalizeFantasticJob — identity + prefix', () => {
  it('normalizes the current September marketplace salary/location field names', () => {
    const job = normalizeFantasticJob(atsRow({
      locations_raw: undefined, locations: [{ address: { addressCountry: 'DE' } }],
      salary_raw: undefined, salary: { currency: 'EUR', value: { minValue: 5000, maxValue: 7000, unitText: 'MONTH' } },
    }), 'activejobs', FETCH_AT)!;
    expect(job.locationCountry).toBe('DE');
    expect(job.salaryMin).toBe(5000);
    expect(job.salaryCurrency).toBe('EUR');
    expect(job.salaryPeriod).toBe('month');
    const enriched = normalizeFantasticJob(atsRow({ salary_raw: undefined, ai_salary_min_value: 100, ai_salary_max_value: 150, ai_salary_currency: 'USD', ai_salary_unit_text: 'HOUR' }), 'activejobs', FETCH_AT)!;
    expect(enriched.salaryMin).toBe(100);
    expect(enriched.salaryPeriod).toBe('hour');
  });
  it('stamps externalId with the board prefix and sourceBoard', () => {
    const n = normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!;
    expect(n.externalId).toBe('activejobs:1737000000-0d4f2c9e5b7a41e8b0c2f3a1');
    expect(n.sourceBoard).toBe('activejobs');
  });

  it('coerces a numeric id to string', () => {
    const n = normalizeFantasticJob(atsRow({ id: 4012345678 }), 'activejobs', FETCH_AT)!;
    expect(n.externalId).toBe('activejobs:4012345678');
    expect(n.sourceBoard).toBe('activejobs');
  });

  it('drops rows missing id / title / organization', () => {
    expect(normalizeFantasticJob(atsRow({ id: '' }), 'activejobs', FETCH_AT)).toBeNull();
    expect(normalizeFantasticJob(atsRow({ title: '   ' }), 'activejobs', FETCH_AT)).toBeNull();
    expect(normalizeFantasticJob(atsRow({ organization: undefined }), 'activejobs', FETCH_AT)).toBeNull();
    expect(normalizeFantasticJob(null, 'activejobs', FETCH_AT)).toBeNull();
  });
});

describe('normalizeFantasticJob — location + country ISO preference', () => {
  it('uses locations_derived[0] verbatim and cities_derived[0]', () => {
    const n = normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!;
    expect(n.location).toBe('San Francisco, California, United States');
    expect(n.locationCity).toBe('San Francisco');
  });

  it('prefers JSON-LD ISO alpha-2 over the derived full name', () => {
    const n = normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!;
    expect(n.locationCountry).toBe('US');
  });

  it('falls back to countries_derived full name when no JSON-LD country', () => {
    const n = normalizeFantasticJob(atsRow({ locations_raw: null }), 'activejobs', FETCH_AT)!;
    expect(n.locationCountry).toBe('United States');
  });

  it('uses schema.org Country OBJECT name, not short-circuiting to null (review #2)', () => {
    const n = normalizeFantasticJob(
      atsRow({
        locations_raw: [{ address: { addressCountry: { '@type': 'Country', name: 'United States' } } }],
        countries_derived: ['United States'],
      }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.locationCountry).toBe('United States');
  });

  it('falls through an unusable object country to countries_derived', () => {
    const n = normalizeFantasticJob(
      atsRow({ locations_raw: [{ address: { addressCountry: {} } }], countries_derived: ['Canada'] }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.locationCountry).toBe('Canada');
  });

  it('null-passes empty location arrays', () => {
    const n = normalizeFantasticJob(
      atsRow({ locations_derived: [], cities_derived: [], countries_derived: [], locations_raw: [] }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.location).toBeNull();
    expect(n.locationCity).toBeNull();
    expect(n.locationCountry).toBeNull();
  });
});

describe('normalizeFantasticJob — workType (remote only, never onsite)', () => {
  it('remote_derived true → remote', () => {
    expect(normalizeFantasticJob(atsRow({ remote_derived: true }), 'activejobs', FETCH_AT)!.workType).toBe('remote');
  });
  it('location_type TELECOMMUTE → remote', () => {
    expect(normalizeFantasticJob(atsRow({ location_type: 'TELECOMMUTE' }), 'activejobs', FETCH_AT)!.workType).toBe('remote');
  });
  it('ai_work_arrangement "Remote OK" → remote', () => {
    expect(normalizeFantasticJob(atsRow({ ai_work_arrangement: 'Remote OK' }), 'activejobs', FETCH_AT)!.workType).toBe('remote');
  });
  it('ai_work_arrangement array ["Remote Solely"] → remote', () => {
    expect(normalizeFantasticJob(atsRow({ ai_work_arrangement: ['Remote Solely'] }), 'activejobs', FETCH_AT)!.workType).toBe('remote');
  });
  it('non-remote (Hybrid / On-site / null) → unknown, NEVER onsite', () => {
    expect(normalizeFantasticJob(atsRow({ ai_work_arrangement: 'Hybrid' }), 'activejobs', FETCH_AT)!.workType).toBe('unknown');
    expect(normalizeFantasticJob(atsRow({ ai_work_arrangement: 'On-site' }), 'activejobs', FETCH_AT)!.workType).toBe('unknown');
    expect(normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!.workType).toBe('unknown');
  });
});

describe('normalizeFantasticJob — employment type mapping', () => {
  it.each([
    [['FULL_TIME'], 'full_time'],
    [['PART_TIME'], 'part_time'],
    [['CONTRACTOR'], 'contract'],
    [['TEMPORARY'], 'contract'],
    [['INTERN'], 'internship'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeFantasticJob(atsRow({ employment_type: raw }), 'activejobs', FETCH_AT)!.employmentType).toBe(expected);
  });
  it('unknown / empty → null (null-pass)', () => {
    expect(normalizeFantasticJob(atsRow({ employment_type: ['VOLUNTEER'] }), 'activejobs', FETCH_AT)!.employmentType).toBeNull();
    expect(normalizeFantasticJob(atsRow({ employment_type: [] }), 'activejobs', FETCH_AT)!.employmentType).toBeNull();
  });
  it('falls back to ai_employment_type', () => {
    expect(
      normalizeFantasticJob(atsRow({ employment_type: null, ai_employment_type: ['CONTRACTOR'] }), 'activejobs', FETCH_AT)!
        .employmentType,
    ).toBe('contract');
  });
});

describe('normalizeFantasticJob — salary (irregular JSON-LD)', () => {
  it('nested value.min/max/unit', () => {
    const n = normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!;
    expect(n.salaryMin).toBe(120000);
    expect(n.salaryMax).toBe(180000);
    expect(n.salaryCurrency).toBe('USD');
    expect(n.salaryPeriod).toBe('year');
  });
  it('flat min/max directly on salary_raw', () => {
    const n = normalizeFantasticJob(
      atsRow({ salary_raw: { currency: 'EUR', minValue: 50000, maxValue: 70000, unitText: 'MONTH' } }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.salaryMin).toBe(50000);
    expect(n.salaryMax).toBe(70000);
    expect(n.salaryCurrency).toBe('EUR');
    expect(n.salaryPeriod).toBe('month');
  });
  it('bare-number value → mirrored into min and max', () => {
    const n = normalizeFantasticJob(
      atsRow({ salary_raw: { currency: 'USD', value: 90000, unitText: 'YEAR' } }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.salaryMin).toBe(90000);
    expect(n.salaryMax).toBe(90000);
  });
  it('single min only → mirrored into max', () => {
    const n = normalizeFantasticJob(
      atsRow({ salary_raw: { currency: 'USD', value: { minValue: 100000, unitText: 'YEAR' } } }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.salaryMin).toBe(100000);
    expect(n.salaryMax).toBe(100000);
  });
  it('no salary → all null (currency/period suppressed)', () => {
    const n = normalizeFantasticJob(atsRow({ salary_raw: null }), 'activejobs', FETCH_AT)!;
    expect(n.salaryMin).toBeNull();
    expect(n.salaryMax).toBeNull();
    expect(n.salaryCurrency).toBeNull();
    expect(n.salaryPeriod).toBeNull();
  });
  it('preserves weekly salary periods for the search API', () => {
    const n = normalizeFantasticJob(
      atsRow({ salary_raw: { currency: 'USD', value: { minValue: 2000, maxValue: 3000, unitText: 'WEEK' } } }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.salaryPeriod).toBe('week');
  });
});

describe('normalizeFantasticJob — dates coerced to UTC', () => {
  it('zone-less date_posted is treated as UTC (append Z)', () => {
    const n = normalizeFantasticJob(atsRow({ date_posted: '2026-07-10T00:00:00' }), 'activejobs', FETCH_AT)!;
    expect(n.postedAt).toBe('2026-07-10T00:00:00.000Z');
  });
  it('zoned date_posted preserved', () => {
    const n = normalizeFantasticJob(atsRow({ date_posted: '2026-07-10T05:00:00+05:00' }), 'activejobs', FETCH_AT)!;
    expect(n.postedAt).toBe('2026-07-10T00:00:00.000Z');
  });
  it('falls back to date_created then fetch time', () => {
    const n1 = normalizeFantasticJob(atsRow({ date_posted: null }), 'activejobs', FETCH_AT)!;
    expect(n1.postedAt).toBe('2026-07-11T08:30:00.000Z');
    const n2 = normalizeFantasticJob(atsRow({ date_posted: null, date_created: null }), 'activejobs', FETCH_AT)!;
    expect(n2.postedAt).toBe(FETCH_AT.toISOString());
  });
});

describe('normalizeFantasticJob — apply + publisher + description', () => {
  it('ats source_type → applyIsDirect true, url passthrough', () => {
    const n = normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!;
    expect(n.applyUrl).toBe('https://careers.acme.com/jobs/123');
    expect(n.applyIsDirect).toBe(true);
  });
  it("a row the provider read from a job board (source_type 'jobboard') → applyIsDirect false", () => {
    const n = normalizeFantasticJob(
      atsRow({ source_type: 'jobboard', source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4012345678' }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.applyIsDirect).toBe(false);
    expect(n.sourcePublisher).toBe('LinkedIn');
  });
  it('prettifies the ATS source name; falls back to source_domain host', () => {
    expect(normalizeFantasticJob(atsRow({ source: 'greenhouse' }), 'activejobs', FETCH_AT)!.sourcePublisher).toBe('Greenhouse');
    const n = normalizeFantasticJob(atsRow({ source: null, source_domain: 'jobs.lever.co/foo' }), 'activejobs', FETCH_AT)!;
    expect(n.sourcePublisher).toBe('jobs.lever.co');
  });
  it('description from description_text; html fallback; NUL stripped', () => {
    expect(normalizeFantasticJob(atsRow({ description_text: 'Hello' }), 'activejobs', FETCH_AT)!.description).toBe('Hello');
    expect(
      normalizeFantasticJob(atsRow({ description_text: undefined, description_html: '<p>Hi</p>' }), 'activejobs', FETCH_AT)!
        .description,
    ).toBe('<p>Hi</p>');
    const n = normalizeFantasticJob(atsRow({ description_text: 'a\x00b' }), 'activejobs', FETCH_AT)!;
    expect(n.description).toBe('ab');
  });
});

describe('buildQuery', () => {
  it('title from titleQuery, else query', () => {
    expect(__test.buildQuery({ query: 'q', country: 'us', titleQuery: 'backend engineer' } as any).get('title')).toBe(
      'backend engineer',
    );
    expect(__test.buildQuery({ query: 'nurse', country: 'us' } as any).get('title')).toBe('nurse');
  });
  it('location from locationText, else country name; ISO omitted when unmapped', () => {
    expect(__test.buildQuery({ query: 'q', country: 'us', locationText: 'Taipei' } as any).get('location')).toBe('Taipei');
    expect(__test.buildQuery({ query: 'q', country: 'us' } as any).get('location')).toBe('United States');
    expect(__test.buildQuery({ query: 'q', country: 'zz' } as any).get('location')).toBeNull();
  });
  it('always requests description_format=text and a limit; remote only when workFromHome', () => {
    const q = __test.buildQuery({ query: 'q', country: 'us', workFromHome: true } as any);
    expect(q.get('description_format')).toBe('text');
    expect(q.get('limit')).toBeTruthy();
    expect(q.get('ai_work_arrangement')).toBe('Remote Solely,Remote OK');
    expect(__test.buildQuery({ query: 'q', country: 'us' } as any).get('ai_work_arrangement')).toBeNull();
  });
});

describe('titleFilterFrom — reduce OR-tokens to an AND-able role noun (review #6)', () => {
  it.each([
    ['senior backend engineer', 'backend engineer'],
    ['software engineer', 'software engineer'],
    ['senior staff machine learning engineer', 'machine learning engineer'],
    ['junior product manager', 'product manager'],
    ['recruiter', 'recruiter'],
    ['', ''],
  ])('%j → %j', (raw, expected) => {
    expect(__test.titleFilterFrom(raw)).toBe(expected);
  });

  it('all-stopword input falls back to the raw tokens (never empties a non-empty title)', () => {
    expect(__test.titleFilterFrom('senior lead')).toBe('senior lead');
  });

  it('buildQuery sends the reduced title', () => {
    expect(
      __test.buildQuery({ query: 'q', country: 'us', titleQuery: 'senior backend engineer' } as any).get('title'),
    ).toBe('backend engineer');
  });
});

describe('windowSuffix', () => {
  const orig = process.env.RA_ONBOARDING_FANTASTIC_WINDOW;
  afterEach(() => {
    if (orig === undefined) delete process.env.RA_ONBOARDING_FANTASTIC_WINDOW;
    else process.env.RA_ONBOARDING_FANTASTIC_WINDOW = orig;
  });
  it('defaults to 7d', () => {
    delete process.env.RA_ONBOARDING_FANTASTIC_WINDOW;
    expect(__test.windowSuffix()).toBe('7d');
  });
  it('honors 24h override', () => {
    process.env.RA_ONBOARDING_FANTASTIC_WINDOW = '24h';
    expect(__test.windowSuffix()).toBe('24h');
  });
});

describe('isFantasticJobsEnabled — gating', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    __test.reset();
    delete process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED;
    delete process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED;
    process.env.RAPID_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env = { ...saved };
    __test.reset();
  });

  it('false without a key', () => {
    delete process.env.RAPID_API_KEY;
    expect(isFantasticJobsEnabled('activejobs')).toBe(false);
  });
  it('true with key + switches off', () => {
    expect(isFantasticJobsEnabled('activejobs')).toBe(true);
  });
  it('false when the global kill switch is on', () => {
    process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED = 'true';
    expect(isFantasticJobsEnabled('activejobs')).toBe(false);
  });
  it('per-provider kill switch is independent', () => {
    process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED = 'true';
    expect(isFantasticJobsEnabled('activejobs')).toBe(false);
  });
  it('the LinkedIn board is gone (MARKET_STRATEGY M-4, §1.6): never enabled, never called, never a throw', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect(isFantasticJobsEnabled('linkedin' as never)).toBe(false);
    expect(await searchFantasticJobs('linkedin' as never, { query: 'engineer', country: 'us' })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('searchFantasticJobs — never-throws + wire behavior (fetch mocked)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    __test.reset();
    delete process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED;
    delete process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED;
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

  it('returns null (no throw) when disabled / no key', async () => {
    delete process.env.RAPID_API_KEY;
    expect(await searchFantasticJobs('activejobs', { query: 'dev', country: 'us' })).toBeNull();
  });

  it('parses a bare array and uses the current ATS route with time_frame', async () => {
    const fn = mockFetch(200, [atsRow()]);
    const jobs = await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
    expect(jobs).toHaveLength(1);
    expect(jobs![0].sourceBoard).toBe('activejobs');
    const calledUrl = fn.mock.calls[0][0] as string;
    expect(calledUrl).toContain('active-jobs-db.p.rapidapi.com/active-ats?');
    expect(calledUrl).toContain('title=engineer');
    expect(calledUrl).toContain('time_frame=7d');
    expect(calledUrl).not.toContain('/active-ats-7d');
    expect(calledUrl).toContain('description_format=text');
  });

  it('non-array body (error object) → null', async () => {
    mockFetch(200, { message: 'oops' });
    expect(await searchFantasticJobs('activejobs', { query: 'dev', country: 'us' })).toBeNull();
  });
  it('every request goes to the Active Jobs DB host and route; none names LinkedIn', async () => {
    const fn = mockFetch(200, [atsRow()]);
    await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' });
    const url = new URL(fn.mock.calls[0][0] as string);
    expect(url.host).toBe('active-jobs-db.p.rapidapi.com');
    expect(url.pathname).toBe('/active-ats');
    expect(url.searchParams.get('source')).toBeNull();
    expect(url.href.toLowerCase()).not.toContain('linkedin');
  });

  it('403 opens the breaker so the next call short-circuits (no 2nd fetch)', async () => {
    const fn = mockFetch(403, { message: 'You are not subscribed to this API.' });
    expect(await searchFantasticJobs('activejobs', { query: 'dev', country: 'us' })).toBeNull();
    expect(__test.state('activejobs').breakerOpen).toBe(true);
    await searchFantasticJobs('activejobs', { query: 'dev', country: 'us' });
    expect(fn).toHaveBeenCalledTimes(1); // breaker short-circuited the second call
  });

  it('serves the second identical query from cache (one billed fetch)', async () => {
    const fn = mockFetch(200, [atsRow()]);
    await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
    await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty title (too-broad/costly) without billing', async () => {
    const fn = mockFetch(200, [atsRow()]);
    expect(await searchFantasticJobs('activejobs', { query: '', country: 'us' })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
  it('retains CJK role filters and rejects punctuation-only paid scans', async () => {
    const fn = mockFetch(200, [atsRow()]);
    await searchFantasticJobs('activejobs', { query: '軟體工程師', country: 'tw' });
    expect(new URL(fn.mock.calls[0][0] as string).searchParams.get('title')).toBe('軟體工程師');
    expect(await searchFantasticJobs('activejobs', { query: '---', country: 'tw' })).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('keeps no call counter of its own: the old client-local budget variable refuses nothing here', async () => {
    // RA_ONBOARDING_ACTIVEJOBS_DAILY_BUDGET is now a deprecated alias of INGEST_ACTIVEJOBS_DAILY_CALLS, read by the
    // one budget in features/jobs/ingest (quota.test.ts covers the refusal); with no gate registered every call is allowed.
    process.env.RA_ONBOARDING_ACTIVEJOBS_DAILY_BUDGET = '0';
    const fn = mockFetch(200, [atsRow()]);
    expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(__test.state('activejobs')).toEqual({ breakerOpen: false, cacheSize: 1 });
  });

  describe('the call gate (one budget per provider)', () => {
    afterEach(() => setCallGate(null));

    it('a gate that refuses: no upstream call, null; the board is asked under its own id', async () => {
      let open = false;
      const gate = vi.fn(() => open);
      setCallGate(gate);
      const fn = mockFetch(200, [atsRow()]);
      expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toBeNull();
      expect(fn).not.toHaveBeenCalled();
      expect(gate).toHaveBeenLastCalledWith('activejobs', 'interactive', undefined);
      open = true;
      expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toHaveLength(1);
      expect(gate).toHaveBeenLastCalledWith('activejobs', 'interactive', undefined);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("a gate that allows is asked once per upstream call: 'interactive' for a person's search, 'ingest' when ingest already counted it", async () => {
      const gate = vi.fn(() => true);
      setCallGate(gate);
      const fn = mockFetch(200, [atsRow()]);
      await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' });
      await searchFantasticJobs('activejobs', { query: 'designer', country: 'us' }, { reservedByIngest: true });
      expect(fn).toHaveBeenCalledTimes(2);
      expect(gate.mock.calls).toEqual([
        ['activejobs', 'interactive', undefined],
        ['activejobs', 'ingest', undefined],
      ]);
    });

    it('a cache hit never reaches the gate', async () => {
      const gate = vi.fn(() => true);
      setCallGate(gate);
      const fn = mockFetch(200, [atsRow()]);
      await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
      gate.mockReturnValue(false);
      expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' })).toHaveLength(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(gate).toHaveBeenCalledTimes(1);
    });

    it('isFantasticJobsEnabled asks the gate without counting a call (probe); a gate that throws allows', async () => {
      const gate = vi.fn((_provider: string, _purpose: string, opts?: { probe?: boolean }) => opts?.probe !== true);
      setCallGate(gate);
      expect(isFantasticJobsEnabled('activejobs')).toBe(false);
      expect(gate).toHaveBeenCalledWith('activejobs', 'interactive', { probe: true });
      setCallGate(() => {
        throw new Error('gate broke');
      });
      expect(isFantasticJobsEnabled('activejobs')).toBe(true);
      const fn = mockFetch(200, [atsRow()]);
      expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toHaveLength(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('a kill switch still wins over an open gate', () => {
      setCallGate(() => true);
      process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED = 'true';
      expect(isFantasticJobsEnabled('activejobs')).toBe(false);
    });
  });

  describe('the quota listener (what every upstream response said about the plan)', () => {
    afterEach(() => setQuotaListener(null));
    // A per-job plan states two quotas: requests and postings.
    const quota = {
      'x-ratelimit-requests-limit': '25',
      'x-ratelimit-requests-remaining': '24',
      'x-ratelimit-requests-reset': '1460160',
      'x-ratelimit-jobs-limit': '250',
      'x-ratelimit-jobs-remaining': '230',
    };

    it('200: requests and jobs limit / remaining and seconds to reset; once per upstream response, not for a cache hit', async () => {
      const seen: ProviderQuotaObservation[] = [];
      setQuotaListener((o) => seen.push(o));
      mockFetch(200, [atsRow()], quota);
      await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
      await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' }); // cache hit
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ provider: 'activejobs', status: 200, requestsLimit: 25, requestsRemaining: 24, resetSeconds: 1_460_160, jobsLimit: 250, jobsRemaining: 230, plan: null, reason: null });
      expect(JSON.stringify(seen)).not.toContain('test-key');
    });

    it('429 on a used-up BASIC plan: remaining 0, the plan name from the body, the reset', async () => {
      const seen: ProviderQuotaObservation[] = [];
      setQuotaListener((o) => seen.push(o));
      mockFetch(429, { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC. Upgrade your plan.' }, { ...quota, 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-jobs-remaining': '0' });
      expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ provider: 'activejobs', status: 429, requestsRemaining: 0, jobsRemaining: 0, plan: 'BASIC', reason: 'monthly_quota', resetSeconds: 1_460_160 });
      expect(__test.state('activejobs').breakerOpen).toBe(true);
    });

    it('403 not subscribed is reported for the board that answered it', async () => {
      const seen: ProviderQuotaObservation[] = [];
      setQuotaListener((o) => seen.push(o));
      mockFetch(403, { message: 'You are not subscribed to this API.' });
      expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ provider: 'activejobs', status: 403, reason: 'not_subscribed', requestsLimit: null, requestsRemaining: null, plan: null });
    });

    it("a listener that answers with a promise (a reading being stored) is waited for by a person's search, at most 500 ms; never by an ingest call", async () => {
      vi.useFakeTimers();
      try {
        setQuotaListener(() => new Promise(() => undefined));
        mockFetch(429, { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.' }, { ...quota, 'x-ratelimit-requests-remaining': '0' });
        let done = false;
        const search = searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' }).then((rows) => {
          done = true;
          return rows;
        });
        await vi.advanceTimersByTimeAsync(499);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await search).toBeNull();
        // The pipeline's own call returns without waiting: its tick awaits the writes.
        __test.reset();
        let ingestDone = false;
        const ingest = searchFantasticJobs('activejobs', { query: 'designer', country: 'us' }, { reservedByIngest: true }).then((rows) => {
          ingestDone = true;
          return rows;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(ingestDone).toBe(true);
        expect(await ingest).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a listener that throws does not fail the search', async () => {
      setQuotaListener(() => {
        throw new Error('listener broke');
      });
      mockFetch(200, [atsRow()], quota);
      expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toHaveLength(1);
    });
  });
});
