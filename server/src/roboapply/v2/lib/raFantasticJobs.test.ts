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
//
// MKT-5A (JI-7; MARKET_STRATEGY M-2, §1.2 tier 1): the two transports (the
// RapidAPI marketplace, a direct Fantastic.jobs key), `feedRequest` for the
// licensed feed's two routes, and the title as quoted phrases joined by OR.
// The direct API's host, routes, key header and quota headers are the ones
// the vendor's documentation gives (read 2026-10-12); every key below is a
// made-up test value and none may appear in a log line or an error.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: logged }));

import {
  FANTASTIC_SEARCH_LIMIT,
  FEED_RESPONSE_MAX_BYTES,
  TITLE_PHRASE_MAX,
  fantasticJobsOffReason,
  fantasticKeyPresent,
  fantasticRoutePath,
  fantasticSearchDateWindow,
  fantasticTransport,
  feedRequest,
  isFantasticJobsUsable,
  normalizeFantasticJob,
  searchFantasticJobs,
  isFantasticJobsEnabled,
  setCallGate,
  setQuotaListener,
  __test,
} from './raFantasticJobs.js';
import { quotaObservationFrom, type ProviderQuotaObservation } from './raExternalJobTypes.js';

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
  it('title from titleQuery, else query, as a quoted phrase', () => {
    expect(__test.buildQuery({ query: 'q', country: 'us', titleQuery: 'backend engineer' } as any).get('title')).toBe(
      '"backend engineer"',
    );
    expect(__test.buildQuery({ query: 'nurse', country: 'us' } as any).get('title')).toBe('"nurse"');
  });
  it('location from locationText, else country name; ISO omitted when unmapped', () => {
    expect(__test.buildQuery({ query: 'q', country: 'us', locationText: 'Taipei' } as any).get('location')).toBe('Taipei');
    expect(__test.buildQuery({ query: 'q', country: 'us' } as any).get('location')).toBe('United States');
    expect(__test.buildQuery({ query: 'q', country: 'zz' } as any).get('location')).toBeNull();
  });
  it('always requests description_format=text and a limit; remote only when workFromHome', () => {
    const q = __test.buildQuery({ query: 'q', country: 'us', workFromHome: true } as any);
    expect(q.get('description_format')).toBe('text');
    expect(q.get('limit')).toBe(String(FANTASTIC_SEARCH_LIMIT));
    expect(FANTASTIC_SEARCH_LIMIT).toBe(20);
    expect(q.get('ai_work_arrangement')).toBe('Remote Solely,Remote OK');
    expect(__test.buildQuery({ query: 'q', country: 'us' } as any).get('ai_work_arrangement')).toBeNull();
  });
  it('only documented parameter names are ever sent (the direct API answers 400 to an unknown one)', () => {
    const q = __test.buildQuery({ query: 'q', country: 'us', titleQuery: 'designer', titleSynonyms: ['ux designer'], locationText: 'Berlin', workFromHome: true, language: 'en', datePosted: 'month', employmentTypes: 'FULLTIME', numPages: 3 } as any);
    expect([...q.keys()].sort()).toEqual(['ai_work_arrangement', 'description_format', 'limit', 'location', 'time_frame', 'title']);
  });
});

describe('titleFilterFrom: a role is asked as quoted phrases joined by OR (JOB_SOURCES_INTL §6.2)', () => {
  it.each([
    ['Senior Product Manager', '"senior product manager"'],
    ['senior backend engineer', '"senior backend engineer"'],
    ['software engineer', '"software engineer"'],
    ['  Registered   Nurse  ', '"registered nurse"'],
    ['recruiter', '"recruiter"'],
    ['C++ Developer', '"c++ developer"'],
    ['軟體工程師', '"軟體工程師"'],
    ['', ''],
    ['---', ''],
    ['"" “”', ''],
  ])('%j → %j', (raw, expected) => {
    expect(__test.titleFilterFrom(raw)).toBe(expected);
  });

  it('with synonyms: the OR of the quoted phrases, the role first, at most two synonyms, no repeats', () => {
    expect(__test.titleFilterFrom('Product Manager', ['Product Owner'])).toBe('"product manager" OR "product owner"');
    expect(__test.titleFilterFrom('Product Manager', ['Product Owner', 'PM lead', 'Program Manager', 'Fourth'])).toBe('"product manager" OR "product owner" OR "pm lead"');
    expect(__test.titleFilterFrom('Product Manager', ['product manager', ' PRODUCT  OWNER ', 'Product Owner'])).toBe('"product manager" OR "product owner"');
    // A synonym that names nothing is skipped; it does not use up a place.
    expect(__test.titleFilterFrom('后端工程师', ['', '---', 'Backend engineer'])).toBe('"后端工程师" OR "backend engineer"');
    // Without a role there is no query at all, whatever the synonyms say.
    expect(__test.titleFilterFrom('  ', ['Product Owner'])).toBe('');
  });

  it('a role containing a double quote is cleaned: no quote of any kind, no backslash and no control character reaches the phrase', () => {
    expect(__test.titleFilterFrom('Head of "Growth" Marketing')).toBe('"head of growth marketing"');
    expect(__test.titleFilterFrom('“Staff” Engineer\\ OR "x')).toBe('"staff engineer or x"');
    expect(__test.titleFilterFrom('Data\u0000 Analyst\n\t(Remote)')).toBe('"data analyst (remote)"');
    expect(__test.titleFilterFrom('Nurse', ['RN" OR "anything'])).toBe('"nurse" OR "rn or anything"');
    for (const raw of ['a"b', 'a\u201cb\u201d', 'a\u00abb\u00bb', 'a\uff02b', 'a\\b']) {
      const phrase = __test.titleFilterFrom(raw);
      expect(phrase.slice(1, -1), raw).not.toMatch(/["\u201c\u201d\u00ab\u00bb\uff02\\]/);
    }
  });

  it('a phrase is capped at 60 characters', () => {
    const long = 'Senior Principal Distinguished Staff Software Engineering Manager of Platform Reliability';
    const phrase = __test.titlePhrase(long);
    expect(TITLE_PHRASE_MAX).toBe(60);
    expect(phrase.length).toBeLessThanOrEqual(60);
    expect(long.toLowerCase().startsWith(phrase)).toBe(true);
    expect(__test.titleFilterFrom(long)).toBe(`"${phrase}"`);
  });

  it('buildQuery sends the phrase, with the synonyms the caller passes', () => {
    expect(__test.buildQuery({ query: 'q', country: 'us', titleQuery: 'Senior Backend Engineer' } as any).get('title')).toBe('"senior backend engineer"');
    expect(__test.buildQuery({ query: 'q', country: 'us', titleQuery: 'Product manager', titleSynonyms: ['Product owner'] } as any).get('title')).toBe('"product manager" OR "product owner"');
    // A value that is not a list of names is ignored.
    expect(__test.buildQuery({ query: 'q', country: 'us', titleQuery: 'Product manager', titleSynonyms: 'Product owner' } as any).get('title')).toBe('"product manager"');
  });

  it('the cache key changes with the phrase: a page cached for the old token form is never served for a phrase query', () => {
    const key = (params: Record<string, unknown>) => __test.cacheKeyFor('activejobs', __test.buildQuery({ query: 'q', country: 'us', ...params } as any));
    const plain = key({ titleQuery: 'product manager' });
    // What the earlier client stored a page under (the bare tokens).
    const oldKey = ['activejobs', __test.windowSuffix(), 'product manager', 'united states', ''].join('|');
    expect(plain).not.toBe(oldKey);
    expect(plain).toContain('"product manager"');
    expect(key({ titleQuery: 'product manager', titleSynonyms: ['product owner'] })).not.toBe(plain);
    expect(key({ titleQuery: 'PRODUCT  manager' })).toBe(plain);
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
    expect(new URL(calledUrl).searchParams.get('title')).toBe('"engineer"');
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
    expect(new URL(fn.mock.calls[0][0] as string).searchParams.get('title')).toBe('"軟體工程師"');
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

// ─── MKT-5A: v1 field names, the two transports and the licensed feed's routes ───

describe('normalizeFantasticJob: the v1 field names and the provider\'s sponsorship reading', () => {
  it('reads date_valid_through (v1) before the older names, and an integer id', () => {
    const v1 = normalizeFantasticJob(atsRow({ id: 2900000001, date_valid_through: '2026-11-20T00:00:00', date_validthrough: '2031-01-01T00:00:00' }), 'activejobs', FETCH_AT)!;
    expect(v1.externalId).toBe('activejobs:2900000001');
    expect(v1.expiresAt).toBe('2026-11-20T00:00:00');
    expect(normalizeFantasticJob(atsRow({ date_validthrough: '2026-12-24T00:00:00' }), 'activejobs', FETCH_AT)!.expiresAt).toBe('2026-12-24T00:00:00');
    expect(normalizeFantasticJob(atsRow({ date_valid_through: 'soon' }), 'activejobs', FETCH_AT)!.expiresAt).toBeUndefined();
  });

  it('ai_visa_sponsorship true is the provider\'s reading "offered"; false or absent is no reading', () => {
    expect(normalizeFantasticJob(atsRow({ ai_visa_sponsorship: true }), 'activejobs', FETCH_AT)!.sponsorshipProvider).toBe('offered');
    expect(normalizeFantasticJob(atsRow({ ai_visa_sponsorship: false }), 'activejobs', FETCH_AT)!.sponsorshipProvider).toBeUndefined();
    expect(normalizeFantasticJob(atsRow(), 'activejobs', FETCH_AT)!.sponsorshipProvider).toBeUndefined();
    expect(normalizeFantasticJob(atsRow({ ai_visa_sponsorship: 'true' }), 'activejobs', FETCH_AT)!.sponsorshipProvider).toBeUndefined();
  });
});

describe('transport (FANTASTIC_TRANSPORT)', () => {
  const RAPID = 'rapid-key-0000-test';
  const DIRECT = 'direct-key-1111-test';

  it('rapidapi by default; direct only when the variable says so', () => {
    expect(fantasticTransport({})).toBe('rapidapi');
    expect(fantasticTransport({ FANTASTIC_TRANSPORT: 'rapidapi' })).toBe('rapidapi');
    expect(fantasticTransport({ FANTASTIC_TRANSPORT: ' Direct ' })).toBe('direct');
    expect(fantasticTransport({ FANTASTIC_TRANSPORT: 'something' })).toBe('rapidapi');
  });

  it('each transport has its own key: presence only', () => {
    expect(fantasticKeyPresent({ RAPID_API_KEY: RAPID })).toBe(true);
    expect(fantasticKeyPresent({ FANTASTIC_API_KEY: DIRECT })).toBe(false);
    expect(fantasticKeyPresent({ FANTASTIC_TRANSPORT: 'direct', RAPID_API_KEY: RAPID })).toBe(false);
    expect(fantasticKeyPresent({ FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY: DIRECT })).toBe(true);
    expect(fantasticKeyPresent({ FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY: '  ' })).toBe(false);
    expect(fantasticJobsOffReason({ RAPID_API_KEY: RAPID })).toBeNull();
    expect(fantasticJobsOffReason({})).toBe('no_api_key');
    expect(fantasticJobsOffReason({ FANTASTIC_TRANSPORT: 'direct', RAPID_API_KEY: RAPID })).toBe('no_api_key');
    expect(fantasticJobsOffReason({ RAPID_API_KEY: RAPID, RA_ONBOARDING_ACTIVEJOBS_DISABLED: 'true' })).toBe('kill_switch');
    expect(fantasticJobsOffReason({ RAPID_API_KEY: RAPID, RA_ONBOARDING_EXTERNAL_JOBS_DISABLED: 'true' })).toBe('kill_switch');
  });

  it('rapidapi: the marketplace host with its two headers', () => {
    expect(__test.resolveTransport({ RAPID_API_KEY: RAPID })).toEqual({
      kind: 'rapidapi',
      host: 'active-jobs-db.p.rapidapi.com',
      headers: { 'x-rapidapi-key': RAPID, 'x-rapidapi-host': 'active-jobs-db.p.rapidapi.com' },
    });
    expect(__test.resolveTransport({})).toBeNull();
  });

  it('direct: data.fantastic.jobs with the documented Authorization: Bearer header; FANTASTIC_API_KEY_HEADER overrides the header name', () => {
    expect(__test.resolveTransport({ FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY: DIRECT })).toEqual({ kind: 'direct', host: 'data.fantastic.jobs', headers: { Authorization: `Bearer ${DIRECT}` } });
    // Another header name carries the raw key.
    expect(__test.resolveTransport({ FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY: DIRECT, FANTASTIC_API_KEY_HEADER: 'X-Api-Key' })!.headers).toEqual({ 'X-Api-Key': DIRECT });
    expect(__test.resolveTransport({ FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY: DIRECT, FANTASTIC_API_KEY_HEADER: 'authorization' })!.headers).toEqual({ authorization: `Bearer ${DIRECT}` });
    // A value that is not a header name is not used.
    expect(__test.resolveTransport({ FANTASTIC_TRANSPORT: 'direct', FANTASTIC_API_KEY: DIRECT, FANTASTIC_API_KEY_HEADER: 'bad name\r\nX: y' })!.headers).toEqual({ Authorization: `Bearer ${DIRECT}` });
    // No direct key: no transport, whatever the marketplace key is.
    expect(__test.resolveTransport({ FANTASTIC_TRANSPORT: 'direct', RAPID_API_KEY: RAPID })).toBeNull();
    expect(__test.resolveTransport({ FANTASTIC_TRANSPORT: 'direct', RAPID_API_KEY: RAPID, FANTASTIC_API_KEY_HEADER: 'X-Api-Key' })).toBeNull();
  });

  it('routes: /active-ats and /expired-ats on the marketplace, /v1/... on the direct API; FANTASTIC_FEED_PATH / FANTASTIC_EXPIRED_PATH override a plain path', () => {
    expect([fantasticRoutePath('active', {}), fantasticRoutePath('expired', {})]).toEqual(['/active-ats', '/expired-ats']);
    const direct = { FANTASTIC_TRANSPORT: 'direct' };
    expect([fantasticRoutePath('active', direct), fantasticRoutePath('expired', direct)]).toEqual(['/v1/active-ats', '/v1/expired-ats']);
    expect(fantasticRoutePath('active', { FANTASTIC_FEED_PATH: '/active-ats-v2' })).toBe('/active-ats-v2');
    expect(fantasticRoutePath('expired', { ...direct, FANTASTIC_EXPIRED_PATH: '/v2/expired-ats' })).toBe('/v2/expired-ats');
    // Not a plain path (a host, a query, a missing slash): the default stands.
    for (const bad of ['active-ats', 'https://evil.example/x', '/a?b=c', '/a b', '//evil.example', '/a//b', '/a/', '/', '']) {
      expect(fantasticRoutePath('active', { FANTASTIC_FEED_PATH: bad }), bad).toBe('/active-ats');
    }
  });

  it('the search asks one fixed frame: week by default, today under RA_ONBOARDING_FANTASTIC_WINDOW=24h', () => {
    const orig = process.env.RA_ONBOARDING_FANTASTIC_WINDOW;
    try {
      delete process.env.RA_ONBOARDING_FANTASTIC_WINDOW;
      expect(fantasticSearchDateWindow()).toBe('week');
      process.env.RA_ONBOARDING_FANTASTIC_WINDOW = '24h';
      expect(fantasticSearchDateWindow()).toBe('today');
    } finally {
      if (orig === undefined) delete process.env.RA_ONBOARDING_FANTASTIC_WINDOW;
      else process.env.RA_ONBOARDING_FANTASTIC_WINDOW = orig;
    }
  });
});

describe('the two transports on the wire (fetch mocked): search and feedRequest', () => {
  const saved = { ...process.env };
  const RAPID = 'rapid-key-0000-test';
  const DIRECT = 'direct-key-1111-test';

  beforeEach(() => {
    __test.reset();
    for (const name of ['RA_ONBOARDING_EXTERNAL_JOBS_DISABLED', 'RA_ONBOARDING_ACTIVEJOBS_DISABLED', 'FANTASTIC_TRANSPORT', 'FANTASTIC_API_KEY', 'FANTASTIC_API_KEY_HEADER', 'FANTASTIC_FEED_PATH', 'FANTASTIC_EXPIRED_PATH']) delete process.env[name];
    process.env.RAPID_API_KEY = RAPID;
    for (const fn of Object.values(logged)) fn.mockClear();
  });
  afterEach(() => {
    process.env = { ...saved };
    __test.reset();
    setCallGate(null);
    setQuotaListener(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  type Reply = { status: number; body: unknown; headers?: Record<string, string> };
  function mockReplies(...replies: Reply[]) {
    let i = 0;
    const fn = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => {
      const r = replies[Math.min(i, replies.length - 1)]!;
      i += 1;
      const headers = r.headers ?? {};
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        json: async () => {
          if (typeof r.body === 'string') throw new SyntaxError('not json');
          return r.body;
        },
        text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  const useDirect = () => {
    process.env.FANTASTIC_TRANSPORT = 'direct';
    process.env.FANTASTIC_API_KEY = DIRECT;
  };
  const everythingLogged = () => JSON.stringify(Object.values(logged).flatMap((fn) => fn.mock.calls));
  // What the feed adapter sends for an hour's slice: the seven-day window cut by explicit bounds (never `1h`).
  const FEED_PARAMS = { time_frame: '7d', limit: '1000', offset: '0', description_format: 'text', location: '"United States" OR "Canada"', date_created_gte: '2026-10-12T07:00:00', date_created_lt: '2026-10-12T08:00:00' };

  it('feedRequest, rapidapi: the documented URL and headers of the new-jobs route; the body is the bare array', async () => {
    const fn = mockReplies({ status: 200, body: [atsRow(), atsRow({ id: 2 })] });
    const res = await feedRequest('active', FEED_PARAMS);
    expect(res).toEqual({ ok: true, status: 200, body: [atsRow(), atsRow({ id: 2 })], called: true });
    const [url, init] = fn.mock.calls[0]!;
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://active-jobs-db.p.rapidapi.com/active-ats');
    expect(Object.fromEntries(parsed.searchParams)).toEqual(FEED_PARAMS);
    expect(init!.headers).toEqual({ 'x-rapidapi-key': RAPID, 'x-rapidapi-host': 'active-jobs-db.p.rapidapi.com' });
  });

  it('feedRequest, rapidapi: the expired route returns ids', async () => {
    const fn = mockReplies({ status: 200, body: [101, 102, 103] });
    expect(await feedRequest('expired', { time_frame: '1h' })).toEqual({ ok: true, status: 200, body: [101, 102, 103], called: true });
    expect(fn.mock.calls[0]![0]).toBe('https://active-jobs-db.p.rapidapi.com/expired-ats?time_frame=1h');
  });

  it('feedRequest, direct: data.fantastic.jobs/v1 with Authorization: Bearer, and never the marketplace key or host', async () => {
    useDirect();
    const fn = mockReplies({ status: 200, body: [atsRow()] }, { status: 200, body: [7] });
    expect((await feedRequest('active', FEED_PARAMS)).ok).toBe(true);
    expect((await feedRequest('expired', { time_frame: '1d' })).ok).toBe(true);
    const [activeUrl, activeInit] = fn.mock.calls[0]!;
    expect(new URL(activeUrl).origin + new URL(activeUrl).pathname).toBe('https://data.fantastic.jobs/v1/active-ats');
    expect(Object.fromEntries(new URL(activeUrl).searchParams)).toEqual(FEED_PARAMS);
    expect(activeInit!.headers).toEqual({ Authorization: `Bearer ${DIRECT}` });
    expect(fn.mock.calls[1]![0]).toBe('https://data.fantastic.jobs/v1/expired-ats?time_frame=1d');
    expect(JSON.stringify(fn.mock.calls)).not.toContain(RAPID);
    expect(JSON.stringify(fn.mock.calls)).not.toContain('rapidapi');
  });

  it('the search uses the same transport as the feed: one plan, one quota reading', async () => {
    useDirect();
    const fn = mockReplies({ status: 200, body: [atsRow()] });
    const jobs = await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us', titleQuery: 'engineer' });
    expect(jobs).toHaveLength(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(new URL(url).origin + new URL(url).pathname).toBe('https://data.fantastic.jobs/v1/active-ats');
    expect(init!.headers).toEqual({ Authorization: `Bearer ${DIRECT}` });
    // Without the direct key the client is off, whatever the marketplace key is.
    delete process.env.FANTASTIC_API_KEY;
    __test.reset();
    expect(isFantasticJobsEnabled('activejobs')).toBe(false);
    expect(isFantasticJobsUsable()).toBe(false);
    expect(await searchFantasticJobs('activejobs', { query: 'designer', country: 'us' })).toBeNull();
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'no_key', status: null, called: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a route override is used on the chosen host', async () => {
    process.env.FANTASTIC_FEED_PATH = '/active-ats-next';
    process.env.FANTASTIC_EXPIRED_PATH = '/expired-ats-next';
    const fn = mockReplies({ status: 200, body: [] });
    await feedRequest('active', FEED_PARAMS);
    await feedRequest('expired', { time_frame: '1h' });
    expect(new URL(fn.mock.calls[0]![0]).pathname).toBe('/active-ats-next');
    expect(new URL(fn.mock.calls[1]![0]).pathname).toBe('/expired-ats-next');
  });

  it('the listener is called with what the response said about the plan, in either header family; never for a refused call', async () => {
    const seen: ProviderQuotaObservation[] = [];
    setQuotaListener((o) => seen.push(o));
    mockReplies({
      status: 200,
      body: [atsRow()],
      headers: { 'x-ratelimit-requests-limit': '50000', 'x-ratelimit-requests-remaining': '49990', 'x-ratelimit-requests-reset': '86400', 'x-ratelimit-jobs-limit': '100000', 'x-ratelimit-jobs-remaining': '99000' },
    });
    await feedRequest('active', FEED_PARAMS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ provider: 'activejobs', status: 200, requestsLimit: 50000, requestsRemaining: 49990, resetSeconds: 86400, jobsLimit: 100000, jobsRemaining: 99000, reason: null });

    useDirect();
    __test.reset();
    mockReplies({
      status: 200,
      body: [atsRow()],
      headers: { 'x-api-jobs-this-request': '1', 'x-api-jobs-remaining': '9450', 'x-api-jobs-limit': '10000', 'x-api-requests-remaining': '4823', 'x-api-requests-limit': '5000', 'x-api-next-billing-date': '2026-11-01T00:00:00.000Z' },
    });
    await feedRequest('active', FEED_PARAMS);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ provider: 'activejobs', status: 200, requestsLimit: 5000, requestsRemaining: 4823, jobsLimit: 10000, jobsRemaining: 9450 });
    expect(seen[1]!.resetSeconds).toBeGreaterThan(0);
    // The key is in no observation.
    expect(JSON.stringify(seen)).not.toContain(RAPID);
    expect(JSON.stringify(seen)).not.toContain(DIRECT);
  });

  it('quotaObservationFrom reads the direct API\'s x-api-* headers and turns the next billing date into seconds to the reset', () => {
    const at = new Date('2026-10-12T00:00:00.000Z');
    const headers = new Map(Object.entries({ 'x-api-jobs-remaining': '9450', 'x-api-jobs-limit': '10000', 'x-api-requests-remaining': '4823', 'x-api-requests-limit': '5000', 'x-api-next-billing-date': '2026-10-13T00:00:00.000Z' }));
    const o = quotaObservationFrom('activejobs', { status: 200, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } }, '', at);
    expect(o).toEqual({ provider: 'activejobs', status: 200, requestsLimit: 5000, requestsRemaining: 4823, resetSeconds: 86_400, jobsLimit: 10000, jobsRemaining: 9450, plan: null, reason: null, at });
    // A billing date in the past is 0 seconds away; one that is not a date was not stated.
    headers.set('x-api-next-billing-date', '2026-10-01T00:00:00.000Z');
    expect(quotaObservationFrom('activejobs', { status: 200, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } }, '', at).resetSeconds).toBe(0);
    headers.set('x-api-next-billing-date', 'soon');
    expect(quotaObservationFrom('activejobs', { status: 200, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } }, '', at).resetSeconds).toBeNull();
    // A 429 with no requests left is the monthly quota, in the direct family too.
    headers.set('x-api-requests-remaining', '0');
    expect(quotaObservationFrom('activejobs', { status: 429, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } }, '{"title":"Too Many Requests"}', at)).toMatchObject({ requestsRemaining: 0, reason: 'monthly_quota' });
  });

  it('a monthly-quota 429 opens the breaker: the next feed request and the next search make no call', async () => {
    const seen: ProviderQuotaObservation[] = [];
    setQuotaListener((o) => seen.push(o));
    const fn = mockReplies({ status: 429, body: { message: 'You have exceeded the MONTHLY quota for Jobs on your current plan, BASIC.' }, headers: { 'x-ratelimit-requests-remaining': '3', 'x-ratelimit-jobs-remaining': '0' } });
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'quota', status: 429, called: true });
    expect(seen[0]).toMatchObject({ status: 429, plan: 'BASIC', reason: 'monthly_quota', jobsRemaining: 0 });
    expect(__test.state('activejobs').breakerOpen).toBe(true);
    expect(await feedRequest('expired', { time_frame: '1h' })).toEqual({ ok: false, error: 'breaker_open', status: null, called: false });
    expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toBeNull();
    expect(isFantasticJobsUsable()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a 401 / 403 opens the breaker too; a burst 429 gets one retry and asks the gate again', async () => {
    const refused = mockReplies({ status: 403, body: { message: 'You are not subscribed to this API.' } });
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'refused', status: 403, called: true });
    expect(__test.state('activejobs').breakerOpen).toBe(true);
    expect(refused).toHaveBeenCalledTimes(1);

    __test.reset();
    vi.useFakeTimers();
    const gate = vi.fn(() => true);
    setCallGate(gate);
    const burst = mockReplies({ status: 429, body: { title: 'Too Many Requests' } }, { status: 200, body: [atsRow()] });
    const pending = feedRequest('active', FEED_PARAMS);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).ok).toBe(true);
    expect(burst).toHaveBeenCalledTimes(2);
    // Asked as ingest (the feed is the pipeline's own call), once per upstream call.
    expect(gate.mock.calls).toEqual([
      ['activejobs', 'ingest', undefined],
      ['activejobs', 'ingest', undefined],
    ]);
    expect(__test.state('activejobs').breakerOpen).toBe(false);
  });

  it('a 401 / 403 on the EXPIRED route is about that route: no breaker, no "key refused" reading, and the search and the new-jobs route go on', async () => {
    const seen: ProviderQuotaObservation[] = [];
    setQuotaListener((o) => seen.push(o));
    const fn = mockReplies(
      // The marketplace's answer for a part of the API the plan does not include.
      { status: 403, body: { message: 'This endpoint is disabled for your subscription.' } },
      { status: 200, body: [atsRow()], headers: { 'x-ratelimit-jobs-limit': '100000', 'x-ratelimit-jobs-remaining': '99000' } },
      { status: 200, body: [atsRow({ id: 2 })] },
      { status: 401, body: { message: 'Unauthorized' } },
      { status: 200, body: [atsRow({ id: 3 })] },
    );
    expect(await feedRequest('expired', { time_frame: '1h' }, { requestId: 'req-7' })).toEqual({ ok: false, error: 'refused', status: 403, called: true });
    // Nothing else happened: the breaker is closed, the client is usable, the listener was told nothing.
    expect(__test.state('activejobs').breakerOpen).toBe(false);
    expect(isFantasticJobsUsable()).toBe(true);
    expect(isFantasticJobsEnabled('activejobs')).toBe(true);
    expect(seen).toEqual([]);
    // A person's own search right after it is served, and the reading it brings is the plan's own.
    expect(await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' })).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 200, jobsLimit: 100_000, jobsRemaining: 99_000 });
    // So is the next page of the feed's new-jobs route.
    expect(await feedRequest('active', FEED_PARAMS)).toMatchObject({ ok: true, body: [{ id: 2 }] });
    // A 401 on the expired route reads the same.
    expect(await feedRequest('expired', { time_frame: '1d' })).toEqual({ ok: false, error: 'refused', status: 401, called: true });
    expect(__test.state('activejobs').breakerOpen).toBe(false);
    expect(await feedRequest('active', { ...FEED_PARAMS, offset: '1000' })).toMatchObject({ ok: true });
    expect(fn).toHaveBeenCalledTimes(5);
    expect(seen.map((o) => o.status)).toEqual([200, 200, 200]);
    // Said once per refusal, with the route and the status; the body, the URL and the key are not in it.
    const said = logged.warn.mock.calls.filter((c) => c[0] === 'RA_V2_FANTASTIC_ROUTE_REFUSED');
    expect(said.map((c) => c[2])).toEqual([
      { requestId: 'req-7', board: 'activejobs', route: 'expired', httpStatus: 403 },
      { requestId: undefined, board: 'activejobs', route: 'expired', httpStatus: 401 },
    ]);
    expect(everythingLogged()).not.toContain(RAPID);
    // The same answers on the route the search shares are a refused key, as before: the breaker opens.
    __test.reset();
    mockReplies({ status: 403, body: { message: 'You are not subscribed to this API.' } });
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'refused', status: 403, called: true });
    expect(__test.state('activejobs').breakerOpen).toBe(true);
    expect(seen.at(-1)).toMatchObject({ status: 403 });
  });

  it('a monthly-quota 429 on the expired route is the plan\'s, not the route\'s: the breaker opens as on any route', async () => {
    mockReplies({ status: 429, body: { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, PRO.' }, headers: { 'x-ratelimit-requests-remaining': '0' } });
    expect(await feedRequest('expired', { time_frame: '1h' })).toEqual({ ok: false, error: 'quota', status: 429, called: true });
    expect(__test.state('activejobs').breakerOpen).toBe(true);
  });

  it('a gate that refuses, a kill switch, an aborted signal: no upstream call', async () => {
    const fn = mockReplies({ status: 200, body: [] });
    setCallGate(() => false);
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'quota', status: null, called: false });
    setCallGate(null);
    process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED = 'true';
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'disabled', status: null, called: false });
    delete process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED;
    process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED = 'true';
    expect(await feedRequest('expired', { time_frame: '1h' })).toEqual({ ok: false, error: 'disabled', status: null, called: false });
    delete process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED;
    const aborted = new AbortController();
    aborted.abort();
    expect(await feedRequest('active', FEED_PARAMS, { signal: aborted.signal })).toEqual({ ok: false, error: 'aborted', status: null, called: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('never throws: an HTTP error, a body that is not an array, bad JSON, a network failure and an answer too large to read are short codes', async () => {
    mockReplies({ status: 500, body: { message: 'boom' } });
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'http_500', status: 500, called: true });
    mockReplies({ status: 200, body: { message: 'not an array' } });
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'bad_shape', status: 200, called: true });
    mockReplies({ status: 200, body: '<html>gateway</html>' });
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'bad_shape', status: 200, called: true });
    mockReplies({ status: 200, body: [1, 2], headers: { 'content-length': String(FEED_RESPONSE_MAX_BYTES + 1) } });
    expect(await feedRequest('expired', { time_frame: '1m' })).toEqual({ ok: false, error: 'too_large', status: 200, called: true });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'network', status: null, called: true });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    }));
    expect(await feedRequest('active', FEED_PARAMS)).toEqual({ ok: false, error: 'timeout', status: null, called: true });
  });

  it('no key value appears in a result, a log line or an error text, on either transport', async () => {
    const results: unknown[] = [];
    for (const direct of [false, true]) {
      __test.reset();
      if (direct) useDirect();
      mockReplies({ status: 200, body: [atsRow()] });
      results.push(await feedRequest('active', FEED_PARAMS), await searchFantasticJobs('activejobs', { query: 'engineer', country: 'us' }));
      mockReplies({ status: 500, body: { message: 'boom' } });
      results.push(await feedRequest('expired', { time_frame: '1h' }));
      mockReplies({ status: 429, body: { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.' } });
      results.push(await feedRequest('active', FEED_PARAMS));
      __test.reset();
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        // An upstream failure whose message quotes the request (a proxy that echoes headers).
        throw new Error(`connect failed for ${JSON.stringify(init.headers)}`);
      }));
      results.push(await feedRequest('active', FEED_PARAMS), await searchFantasticJobs('activejobs', { query: 'designer', country: 'us' }));
    }
    const everything = JSON.stringify(results) + everythingLogged();
    expect(everything).not.toContain(RAPID);
    expect(everything).not.toContain(DIRECT);
    expect(everything).not.toContain('Bearer');
    // The log lines exist (the assertion above is not vacuous).
    expect(logged.info.mock.calls.length + logged.warn.mock.calls.length).toBeGreaterThan(4);
  });
});
