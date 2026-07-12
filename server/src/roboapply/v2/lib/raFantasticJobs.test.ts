// backend/src/roboapply/v2/lib/raFantasticJobs.test.ts
//
// Unit tests for the Fantastic Jobs client (Active Jobs DB + LinkedIn Job
// Search). Focus: the load-bearing normalizer mapping (the synthesis §1 table),
// request building, window/kill-switch/budget gating, and the never-throws
// contract. Run: npx vitest run server/src/roboapply/v2/lib/raFantasticJobs.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeFantasticJob,
  searchFantasticJobs,
  isFantasticJobsEnabled,
  __test,
} from './raFantasticJobs.js';

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
  it('stamps externalId with the board prefix and sourceBoard', () => {
    const n = normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!;
    expect(n.externalId).toBe('activejobs:1737000000-0d4f2c9e5b7a41e8b0c2f3a1');
    expect(n.sourceBoard).toBe('activejobs');
  });

  it('coerces a numeric LinkedIn id to string', () => {
    const n = normalizeFantasticJob(atsRow({ id: 4012345678 }), 'linkedin', FETCH_AT)!;
    expect(n.externalId).toBe('linkedin:4012345678');
    expect(n.sourceBoard).toBe('linkedin');
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
    const n = normalizeFantasticJob(atsRow({ locations_raw: null }), 'linkedin', FETCH_AT)!;
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
  it('WEEK/DAY period → null (no target slot)', () => {
    const n = normalizeFantasticJob(
      atsRow({ salary_raw: { currency: 'USD', value: { minValue: 2000, maxValue: 3000, unitText: 'WEEK' } } }),
      'activejobs',
      FETCH_AT,
    )!;
    expect(n.salaryPeriod).toBeNull();
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
  it('LinkedIn jobboard source_type → applyIsDirect false', () => {
    const n = normalizeFantasticJob(
      atsRow({ source_type: 'jobboard', source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/4012345678' }),
      'linkedin',
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
  it('title_filter from titleQuery, else query', () => {
    expect(__test.buildQuery({ query: 'q', country: 'us', titleQuery: 'backend engineer' } as any).get('title_filter')).toBe(
      'backend engineer',
    );
    expect(__test.buildQuery({ query: 'nurse', country: 'us' } as any).get('title_filter')).toBe('nurse');
  });
  it('location_filter from locationText, else country name; ISO omitted when unmapped', () => {
    expect(__test.buildQuery({ query: 'q', country: 'us', locationText: 'Taipei' } as any).get('location_filter')).toBe('Taipei');
    expect(__test.buildQuery({ query: 'q', country: 'us' } as any).get('location_filter')).toBe('United States');
    expect(__test.buildQuery({ query: 'q', country: 'zz' } as any).get('location_filter')).toBeNull();
  });
  it('always requests description_type=text and a limit; remote only when workFromHome', () => {
    const q = __test.buildQuery({ query: 'q', country: 'us', workFromHome: true } as any);
    expect(q.get('description_type')).toBe('text');
    expect(q.get('limit')).toBeTruthy();
    expect(q.get('remote')).toBe('true');
    expect(__test.buildQuery({ query: 'q', country: 'us' } as any).get('remote')).toBeNull();
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

  it('buildQuery sends the reduced title_filter', () => {
    expect(
      __test.buildQuery({ query: 'q', country: 'us', titleQuery: 'senior backend engineer' } as any).get('title_filter'),
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
    expect(isFantasticJobsEnabled('linkedin')).toBe(true);
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

  it('parses a bare array and normalizes; hits the 7d ATS endpoint', async () => {
    const fn = mockFetch(200, [atsRow()]);
    const jobs = await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
    expect(jobs).toHaveLength(1);
    expect(jobs![0].sourceBoard).toBe('activejobs');
    const calledUrl = fn.mock.calls[0][0] as string;
    expect(calledUrl).toContain('active-jobs-db.p.rapidapi.com/active-ats-7d');
    expect(calledUrl).toContain('title_filter=engineer');
    expect(calledUrl).toContain('description_type=text');
  });

  it('non-array body (error object) → null', async () => {
    mockFetch(200, { message: 'oops' });
    expect(await searchFantasticJobs('activejobs', { query: 'dev', country: 'us' })).toBeNull();
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
});
