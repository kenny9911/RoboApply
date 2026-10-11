// @vitest-environment node
// End-to-end normalizer tests over anonymized provider fixtures (en, zh,
// zh-TW) plus the WP-16a acceptance rules: no applicant counts from
// linkedin / jsearch, work model null unless stated, no LinkedIn branding on
// source fields, no estimated pay, deterministic output.
import { describe, expect, it } from 'vitest';
import bank from './__fixtures__/bank.json' with { type: 'json' };
import fantastic from './__fixtures__/fantastic.json' with { type: 'json' };
import jsearch from './__fixtures__/jsearch.json' with { type: 'json' };
import { afterNormalize, type MarketHookSet } from '../marketHooks.js';
import { providerOfBoard } from '../ingest/verifyFeed.js';
import { getTaxonomyNode, taxonomyAncestors } from '../taxonomy/index.js';
import {
  asMarketHookJob,
  inputFromBankJob,
  inputFromExternalJob,
  inputFromFantasticJob,
  inputFromJSearchJob,
  isLinkedInBranded,
  marketOfPosting,
  normalizeProviderJob,
  normalizeSkills,
  PROVIDER_META,
  taxonomyIdsForTitle,
  type NormalizedJob,
  type NormalizeProvider,
  type ProviderJobInput,
} from './index.js';

const now = new Date('2026-10-10T00:00:00Z');

const aj = () => normalizeProviderJob(inputFromFantasticJob(fantastic.activejobs_en, 'activejobs', now)!, 'activejobs', { now });
const li = () => normalizeProviderJob(inputFromFantasticJob(fantastic.linkedin_en, 'linkedin', now)!, 'linkedin', { now });
const jsTw = () => normalizeProviderJob(inputFromJSearchJob(jsearch.tw_zhTW, { country: 'tw', fetchedAt: now })!, 'jsearch', { now, countryHint: 'TW' });
const jsTw2 = () => normalizeProviderJob(inputFromJSearchJob(jsearch.tw_range_zhTW, { country: 'tw', fetchedAt: now })!, 'jsearch', { now });
const jsUs = () => normalizeProviderJob(inputFromJSearchJob(jsearch.us_en, { country: 'us', fetchedAt: now })!, 'jsearch', { now });
const gh = () =>
  normalizeProviderJob(inputFromBankJob(bank.gohire_zh, 'gohire', { applyUrl: 'https://www.gohire.top/jobs/gh_job_example_01', employerVerified: true })!, 'bank_gohire', { now });
const ghIntern = () => normalizeProviderJob(inputFromBankJob(bank.gohire_intern_zh, 'gohire', { applyUrl: 'https://www.gohire.top/jobs/gh_job_example_02' })!, 'bank_gohire', { now });
const rh = () =>
  normalizeProviderJob(inputFromBankJob(bank.robohire_en, 'robohire', { applyUrl: 'https://robohire.example/jobs/rh_job_example_03', syndicationConsent: true })!, 'bank_robohire', { now });

const ALL: [string, () => NormalizedJob][] = [
  ['activejobs en', aj],
  ['linkedin en', li],
  ['jsearch zh-TW (面議)', jsTw],
  ['jsearch zh-TW (range)', jsTw2],
  ['jsearch en', jsUs],
  ['gohire zh', gh],
  ['gohire zh intern', ghIntern],
  ['robohire en', rh],
];

describe('fixtures: Active Jobs DB (en)', () => {
  it('maps every stated field and nothing else', () => {
    expect(aj()).toMatchObject({
      provider: 'activejobs',
      market: 'intl',
      visibility: 'public',
      externalId: 'activejobs:1900000001',
      sourceBoard: 'activejobs',
      sourcePriority: 10,
      title: 'Senior Backend Engineer (Remote - US)',
      titleNormalized: 'senior backend engineer',
      companyNameNormalized: 'acme analytics',
      sourceName: 'Active Jobs DB',
      originalSourceName: 'Greenhouse',
      originalHost: 'boards.greenhouse.io',
      atsType: 'greenhouse',
      isAgency: null,
      workModel: 'remote',
      remoteScope: 'US',
      locationCountry: 'US',
      locationCity: null,
      geoLat: null,
      employmentType: 'full_time',
      salaryMin: 165000,
      salaryMax: 210000,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
      salarySource: 'provider',
      salaryAnnualMin: 165000,
      salaryDisclosed: true,
      taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
      primaryTaxonomyId: 'backend_engineer',
      seniority: 'senior',
      roleType: 'ic',
      minYears: 5,
      maxYears: 10,
      skills: ['go', 'python', 'postgresql', 'kubernetes', 'grpc', 'aws'],
      postedAtEstimated: false,
      coverage: { taxonomy: true, seniority: true, skills: 6, complete: true },
    });
    expect(aj().postedAt?.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(aj().expiresAt?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('never maps LinkedIn organization data or hiring-manager names into company facts', () => {
    const c = aj().company;
    expect(c).toMatchObject({ industries: [], sizeBand: null, employeeCount: null, website: 'https://www.acme-analytics.example/' });
    expect(JSON.stringify(aj())).not.toContain('Pat Example');
    expect(Object.values(c.facts).every((f) => f.source === 'provider:activejobs')).toBe(true);
  });
});

describe('fixtures: LinkedIn Job Search API (en)', () => {
  it('has no LinkedIn branding on any source field, no applicant count, and a stated hybrid model', () => {
    const job = normalizeProviderJob({ ...inputFromFantasticJob(fantastic.linkedin_en, 'linkedin', now)!, applicantCount: 187, applicantCountSource: 'LinkedIn' }, 'linkedin', { now });
    expect(job).toMatchObject({
      sourceName: 'Fantastic Jobs',
      originalSourceName: null,
      originalHost: null,
      sourceUrl: null,
      atsType: null,
      applicantCount: null,
      applicantCountSource: null,
      applicantCountAt: null,
      workModel: 'hybrid',
      locationCity: 'London',
      locationRegion: 'England',
      locationCountry: 'GB',
      geoLat: 51.51,
      roleType: 'ic',
      seniority: null,
      salaryDisclosed: false,
      sourcePriority: 20,
    });
    expect(job.notes).toEqual(expect.arrayContaining(['linkedin_publisher_dropped', 'applicant_count_dropped:linkedin']));
  });
});

describe('FIX-3: the stored description keeps the posting\'s own punctuation', () => {
  it('full-width punctuation is not folded to half-width in what the page shows; parsing still reads the folded text', () => {
    const text = '岗位职责：负责后端服务开发（Go、MySQL），参与架构设计。\n薪资：18-28K·15薪\n网申截止：2026年11月30日';
    const job = normalizeProviderJob({ title: '后端开发工程师', company: '示例科技', description: text, market: 'cn', country: 'CN' } as never, 'user_import');
    expect(job.description).toBe(text);
    expect(job.description).toContain('：');
    expect(job.description).toContain('（Go、MySQL），');
    // The parse input is still folded, and pay is still read from it.
    expect(job.descriptionPlain).toContain('岗位职责:负责后端服务开发(Go、MySQL),参与架构设计。');
    expect(job).toMatchObject({ salaryMin: 18000, salaryMax: 28000, salaryMonths: 15, salaryText: '18-28K·15薪' });
  });
});

describe('fixtures: JSearch (zh-TW, en)', () => {
  it('TW 面議 with the NT$40k floor sentence: pay not disclosed, verbatim text kept, nothing estimated', () => {
    expect(jsTw()).toMatchObject({
      titleNormalized: '資深後端工程師',
      companyNameNormalized: '範例資訊',
      originalSourceName: '104人力銀行',
      originalHost: '104.com.tw',
      sourceName: 'JSearch',
      locationCity: 'Taipei',
      locationCountry: 'TW',
      workModel: null,
      employmentType: 'full_time',
      salaryDisclosed: false,
      salaryMin: null,
      salaryMax: null,
      salaryAnnualMin: null,
      salaryCurrency: null,
      salaryText: '待遇面議(經常性薪資達4萬元或以上)',
      seniority: 'senior',
      minYears: 3,
      primaryTaxonomyId: 'backend_engineer',
      postedAtEstimated: true,
    });
  });

  it('TW monthly range from the description, hybrid from a stated office schedule', () => {
    expect(jsTw2()).toMatchObject({
      locationCity: 'Hsinchu',
      locationCountry: 'TW',
      salaryMin: 55000,
      salaryMax: 75000,
      salaryCurrency: 'TWD',
      salaryPeriod: 'month',
      salarySource: 'posting_text',
      salaryAnnualMin: 660000,
      salaryDisclosed: true,
      workModel: 'hybrid',
      fieldSources: expect.objectContaining({ workModel: 'description', salary: 'posting_text' }),
      primaryTaxonomyId: 'frontend_engineer',
    });
  });

  it('US: the direct employer link wins, LinkedIn publisher dropped, currency only from the matching pay line', () => {
    expect(jsUs()).toMatchObject({
      applyUrl: 'https://contoso.wd5.myworkdayjobs.com/en-US/careers/job/Austin-TX/Data-Analyst-II_R-1003',
      atsType: 'workday',
      originalSourceName: null,
      originalHost: 'contoso.wd5.myworkdayjobs.com',
      locationCity: 'Austin',
      locationRegion: 'TX',
      geoLat: 30.27,
      salaryMin: 38,
      salaryMax: 46,
      salaryPeriod: 'hour',
      salaryCurrency: 'USD',
      salaryAnnualMin: 79040,
      salaryAnnualMax: 95680,
      seniority: 'mid',
      minYears: 2,
      skills: ['sql', 'tableau'],
      applicantCount: null,
      workModel: null,
    });
    expect(jsUs().expiresAt?.toISOString()).toBe('2026-11-06T15:00:00.000Z');
  });
});

describe('fixtures: recruiter banks (zh, en)', () => {
  it('GoHire: CN market, Chinese city label, 15-25K·14薪, USD column default ignored, verified employer kept', () => {
    expect(gh()).toMatchObject({
      market: 'cn',
      sourceBoard: 'gohire',
      sourceName: 'GoHire',
      fromRecruiterBank: true,
      employerVerified: true,
      publicDisplay: false,
      locationCity: '深圳',
      locationRegion: 'Guangdong',
      locationCountry: 'CN',
      salaryMin: 15000,
      salaryMax: 25000,
      salaryCurrency: 'CNY',
      salaryPeriod: 'month',
      salaryMonths: 14,
      salaryAnnualMin: 210000,
      salaryAnnualMax: 350000,
      seniority: 'intern_newgrad',
      expiresAt: null,
      companyNameNormalized: '示例科技',
      workModel: null,
    });
    expect(gh().company).toMatchObject({ market: 'cn', bankCompanyRef: 'gohire:co_example_01' });
  });

  it('GoHire intern: daily pay, internship from the bank, onsite only because the bank states it', () => {
    expect(ghIntern()).toMatchObject({ employmentType: 'internship', seniority: 'intern_newgrad', salaryPeriod: 'day', salaryCurrency: 'CNY', workModel: 'onsite', employerVerified: false, locationCity: '上海' });
  });

  it('RoboHire: agency detected from the name, implausible "monthly" default dropped, consent → public display', () => {
    expect(rh()).toMatchObject({
      market: 'intl',
      isAgency: true,
      salaryMin: 85000,
      salaryCurrency: 'CAD',
      salaryPeriod: null,
      salaryAnnualMin: null,
      salaryDisclosed: true,
      publicDisplay: true,
      workModel: 'hybrid',
      seniority: 'senior',
      locationRegion: 'ON',
      locationCountry: 'CA',
    });
    expect(rh().company.isAgency).toBe(true);
  });

  it('a bank job without syndication consent is not publicly displayed', () => {
    const job = normalizeProviderJob(inputFromBankJob(bank.robohire_en, 'robohire', { applyUrl: 'https://robohire.example/jobs/x' })!, 'bank_robohire', { now });
    expect(job.publicDisplay).toBe(false);
  });
});

describe('acceptance rules over every fixture', () => {
  it.each(ALL)('%s: no LinkedIn branding on source fields', (_label, make) => {
    const job = make();
    for (const k of ['sourceName', 'originalSourceName', 'originalHost', 'sourceUrl'] as const) expect(isLinkedInBranded(job[k])).toBe(false);
  });

  it.each(ALL)('%s: annual pay only with a stated period, never "estimate"', (_label, make) => {
    const job = make();
    expect(['provider', 'posting_text', null]).toContain(job.salarySource);
    if (job.salaryAnnualMin != null) expect(job.salaryPeriod).not.toBeNull();
    if (!job.salaryDisclosed) expect([job.salaryMin, job.salaryMax, job.salaryAnnualMin, job.salaryAnnualMax]).toEqual([null, null, null, null]);
  });

  it.each(ALL)('%s: deterministic', (_label, make) => {
    expect(make()).toEqual(make());
  });

  it.each(ALL)('%s: is a MarketHookJob and passes through afterNormalize', async (_label, make) => {
    const job = make();
    const seen: string[] = [];
    const set: MarketHookSet = {
      id: 'test',
      appliesTo: (j) => j.market === job.market,
      afterNormalize: (j) => {
        seen.push(String(j.provider));
        return { ...j, tagged: true };
      },
    };
    const out = await afterNormalize(asMarketHookJob(job), { brand: job.market === 'cn' ? 'goapply' : 'roboapply', market: job.market, stage: 'ingest' }, [set]);
    expect(out).toMatchObject({ dedupeKey: job.dedupeKey, tagged: true });
    expect(seen).toEqual([job.provider]);
  });
});

describe('applicant counts (F-FEED-08 / D3)', () => {
  const base: ProviderJobInput = { externalId: 'x:1', title: 'Engineer', company: 'Acme', applyUrl: 'https://careers.acme.example/1', applicantCount: 42, applicantCountSource: 'Acme careers API', applicantCountAt: '2026-10-09T00:00:00Z' };

  it.each(['linkedin', 'jsearch'] as NormalizeProvider[])('is never set from %s, even with a source', (provider) => {
    const job = normalizeProviderJob(base, provider, { now });
    expect(job).toMatchObject({ applicantCount: null, applicantCountSource: null, applicantCountAt: null });
    expect(job.notes).toContain(`applicant_count_dropped:${provider}`);
  });

  it('is kept only with a citable non-LinkedIn source', () => {
    expect(normalizeProviderJob(base, 'activejobs', { now })).toMatchObject({ applicantCount: 42, applicantCountSource: 'Acme careers API' });
    expect(normalizeProviderJob(base, 'activejobs', { now }).applicantCountAt?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(normalizeProviderJob({ ...base, applicantCountAt: null }, 'ats_public', { now }).applicantCountAt).toEqual(now);
    expect(normalizeProviderJob({ ...base, applicantCountSource: null }, 'activejobs', { now })).toMatchObject({ applicantCount: null, notes: ['applicant_count_dropped:no_citable_source'] });
    expect(normalizeProviderJob({ ...base, applicantCountSource: 'LinkedIn' }, 'activejobs', { now }).applicantCount).toBeNull();
    expect(normalizeProviderJob({ ...base, applicantCount: 4.5 }, 'activejobs', { now }).applicantCount).toBeNull();
    expect(normalizeProviderJob({ ...base, applicantCount: undefined }, 'activejobs', { now }).notes).toEqual([]);
  });
});

describe('work model: null unless stated', () => {
  const base: ProviderJobInput = { externalId: 'x:2', title: 'Accountant', company: 'Acme', applyUrl: 'https://careers.acme.example/2', location: 'Austin, TX', description: 'Join our finance team.' };

  it('is null when nothing states it (legacy "unknown" and "onsite" defaults are not statements)', () => {
    expect(normalizeProviderJob(base, 'jsearch', { now }).workModel).toBeNull();
    expect(normalizeProviderJob({ ...base, workType: 'unknown' }, 'jsearch', { now }).workModel).toBeNull();
    expect(normalizeProviderJob({ ...base, workType: 'onsite' }, 'activejobs', { now }).workModel).toBeNull();
  });

  it('comes from the provider, location, title or description, in that order', () => {
    expect(normalizeProviderJob({ ...base, workType: 'remote' }, 'jsearch', { now })).toMatchObject({ workModel: 'remote', remoteScope: null });
    expect(normalizeProviderJob({ ...base, location: 'Remote - US' }, 'jsearch', { now })).toMatchObject({ workModel: 'remote', remoteScope: 'US' });
    expect(normalizeProviderJob({ ...base, title: 'Accountant (Hybrid)' }, 'jsearch', { now }).workModel).toBe('hybrid');
    expect(normalizeProviderJob({ ...base, description: 'This is an on-site role.' }, 'jsearch', { now }).workModel).toBe('onsite');
    expect(normalizeProviderJob({ ...base, workModel: 'Remote', remoteScope: 'global' }, 'activejobs', { now })).toMatchObject({ workModel: 'remote', remoteScope: 'global' });
    expect(normalizeProviderJob({ ...base, workModel: 'Hybrid', remoteScope: 'US' }, 'activejobs', { now }).remoteScope).toBeNull();
  });
});

describe('inputs, context and edge cases', () => {
  it('accepts the existing clients\' ExternalJobNormalized rows unchanged', () => {
    const row = {
      externalId: 'jsearch:abc',
      sourceBoard: 'jsearch' as const,
      title: 'Backend Engineer',
      company: 'Acme',
      companyLogoUrl: null,
      location: '台北市',
      locationCity: null,
      locationCountry: 'TW',
      locationCountryEstimated: true,
      workType: 'unknown' as const,
      employmentType: 'full_time',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
      postedAt: '2026-10-08T00:00:00.000Z',
      postedAtEstimated: false,
      applyUrl: 'https://careers.acme.example/1',
      applyIsDirect: true,
      description: '',
      sourcePublisher: 'Acme Careers',
    };
    const job = normalizeProviderJob(inputFromExternalJob(row), 'jsearch', { now });
    expect(job).toMatchObject({ locationCity: 'Taipei', locationCountry: 'TW', workModel: null, originalSourceName: 'Acme Careers', atsType: 'other', fieldSources: expect.objectContaining({ country: 'city_table' }) });
  });

  it('fills a missing country from the search only when the posting names none', () => {
    const base: ProviderJobInput = { externalId: 'x:3', title: 'Engineer', company: 'Acme', applyUrl: 'https://careers.acme.example/3' };
    expect(normalizeProviderJob({ ...base, location: 'Remote' }, 'jsearch', { now, countryHint: 'TW' })).toMatchObject({ locationCountry: 'TW', remoteScope: null, fieldSources: expect.objectContaining({ country: 'query_country' }) });
    expect(normalizeProviderJob({ ...base }, 'jsearch', { now, countryHint: 'TW' })).toMatchObject({ locationCountry: 'TW' });
    expect(normalizeProviderJob({ ...base, location: 'Tokyo' }, 'jsearch', { now, countryHint: 'TW' }).locationCountry).toBe('JP');
    expect(normalizeProviderJob({ ...base, locationCountry: 'TW', locationCountryEstimated: true, location: 'Unknownville' }, 'jsearch', { now })).toMatchObject({ locationCountry: 'TW', locationCity: 'Unknownville', geoLat: null });
    expect(normalizeProviderJob({ ...base, locationCity: 'Austin', locationRegion: 'TX', locationCountry: 'US' }, 'jsearch', { now })).toMatchObject({ locationCity: 'Austin', locationCountry: 'US', fieldSources: expect.objectContaining({ country: 'city_table' }) });
    expect(normalizeProviderJob({ ...base, locationCity: 'Smallville', locationCountry: 'US' }, 'jsearch', { now })).toMatchObject({ locationCity: 'Smallville', locationCountry: 'US', fieldSources: expect.objectContaining({ country: 'provider' }) });
    expect(normalizeProviderJob(base, 'jsearch', { now })).toMatchObject({ locationCountry: null, locations: [], location: null });
  });

  it('keeps every location of a multi-location post and uses the first table city as primary', () => {
    const job = normalizeProviderJob(
      { externalId: 'x:4', title: 'Engineer', company: 'Acme', applyUrl: 'https://careers.acme.example/4', locations: ['Remote - US', 'Seattle, WA', 'Austin, TX', 'Seattle, Washington'] },
      'activejobs',
      { now },
    );
    expect(job.locations.map((l) => l.cityId ?? l.country)).toEqual(['US', 'us-seattle', 'us-austin']);
    expect(job).toMatchObject({ locationCity: 'Seattle', geoLat: 47.61, workModel: 'remote', remoteScope: 'US' });
  });

  it('user imports are private, owned, never public and never expire by date', () => {
    const job = normalizeProviderJob({ externalId: 'import:1', title: 'Designer', company: 'Acme', applyUrl: 'https://careers.acme.example/9' }, 'user_import', { now, ownerUserId: 'u1', publicDisplayProviders: ['user_import'] });
    expect(job).toMatchObject({ visibility: 'private', ownerUserId: 'u1', publicDisplay: false, expiresAt: null, sourcePriority: 90, sourceName: null });
  });

  it('public display only for configured providers (default none)', () => {
    const input: ProviderJobInput = { externalId: 'x:5', title: 'Engineer', company: 'Acme', applyUrl: 'https://jobs.lever.co/acme/5', sourceBoard: 'lever' };
    expect(normalizeProviderJob(input, 'ats_public', { now }).publicDisplay).toBe(false);
    expect(normalizeProviderJob(input, 'ats_public', { now, publicDisplayProviders: ['ats_public'] })).toMatchObject({ publicDisplay: true, sourceName: 'Lever', atsType: 'lever', ownerUserId: null });
  });

  it('refuses unsafe URLs and notes a missing apply link', () => {
    const job = normalizeProviderJob({ externalId: 'x:6', title: 'Engineer', company: 'Acme', applyUrl: 'javascript:alert(1)', companyLogoUrl: 'data:image/png;base64,xx' }, 'activejobs', { now });
    expect(job).toMatchObject({ applyUrl: null, companyLogoUrl: null, atsType: null });
    expect(job.notes).toContain('no_apply_url');
    expect(normalizeProviderJob({ externalId: 'x:7', title: 'E', company: 'A', sourceUrl: 'https://careers.acme.example/7' }, 'activejobs', { now }).applyUrl).toBe('https://careers.acme.example/7');
  });

  it('reads HTML descriptions and the descriptionHtml field', () => {
    const job = normalizeProviderJob({ externalId: 'x:8', title: 'Engineer', company: 'Acme', descriptionHtml: '<p>Requirements</p><ul><li>3+ years of experience</li></ul>' }, 'activejobs', { now });
    expect(job.descriptionPlain).toBe('Requirements\n\n• 3+ years of experience');
    expect(job).toMatchObject({ minYears: 3, seniority: 'mid', fieldSources: expect.objectContaining({ seniority: 'years', years: 'description' }) });
  });

  it('marks internships from the employment type, and the search-country currency note', () => {
    const job = normalizeProviderJob(
      { externalId: 'x:9', title: 'Data Programme', company: 'Acme', employmentType: 'INTERN', salaryMin: 30, salaryMax: 30, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryCurrencyInferred: true },
      'jsearch',
      { now },
    );
    expect(job).toMatchObject({ employmentType: 'internship', seniority: 'intern_newgrad', fieldSources: expect.objectContaining({ seniority: 'employment_type' }) });
    expect(job.notes).toContain('salary_currency_from_search_country');
    expect(normalizeProviderJob({ externalId: 'x:10', title: 'Summer Intern', company: 'Acme' }, 'jsearch', { now })).toMatchObject({ employmentType: 'internship', fieldSources: expect.objectContaining({ employmentType: 'title' }) });
  });

  it('dedupe keys: same job on two boards collide; different level or city do not', () => {
    const a = normalizeProviderJob({ externalId: 'a', title: 'Backend Engineer - Austin, TX', company: 'Acme, Inc.', location: 'Austin, TX' }, 'activejobs', { now });
    const b = normalizeProviderJob({ externalId: 'b', title: 'Backend Engineer', company: 'ACME', location: 'Austin, Texas, United States' }, 'jsearch', { now });
    const c = normalizeProviderJob({ externalId: 'c', title: 'Senior Backend Engineer', company: 'Acme', location: 'Austin, TX' }, 'jsearch', { now });
    const d = normalizeProviderJob({ externalId: 'd', title: 'Backend Engineer', company: 'Acme', location: 'Seattle, WA' }, 'jsearch', { now });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(c.dedupeKey).not.toBe(a.dedupeKey);
    expect(d.dedupeKey).not.toBe(a.dedupeKey);
    expect(a.sourcePriority).toBeLessThan(b.sourcePriority);
  });

  it('defaults the market per provider and honours ctx.market', () => {
    const input: ProviderJobInput = { externalId: 'x', title: 'Engineer', company: 'Acme' };
    expect(normalizeProviderJob(input, 'bank_gohire', { now }).market).toBe('cn');
    expect(normalizeProviderJob(input, 'jsearch', { now }).market).toBe('intl');
    expect(normalizeProviderJob(input, 'jsearch', { now, market: 'cn' }).market).toBe('cn');
  });

  it('cn market labels a city without a Chinese name in English, and keeps a company name made only of notes', () => {
    const job = normalizeProviderJob({ externalId: 'x', title: 'Engineer', company: '(深圳)', location: 'Plano, TX' }, 'bank_gohire', { now });
    expect(job).toMatchObject({ locationCity: 'Plano', companyNameNormalized: '(深圳)' });
  });

  it('throws only for an unknown provider', () => {
    expect(() => normalizeProviderJob({ externalId: 'x', title: 'E', company: 'A' }, 'nope' as NormalizeProvider)).toThrow(/unknown provider/);
  });

  it('uses the call time when no clock is given', () => {
    const job = normalizeProviderJob({ externalId: 'x', title: 'E', company: 'A' }, 'jsearch');
    expect(job.postedAtEstimated).toBe(true);
    expect(Math.abs((job.postedAt?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
  });
});

describe('helpers', () => {
  it('normalizes skills: lower case, de-duplicated, at most 25, each ≤ 60 chars', () => {
    expect(normalizeSkills(['Go', 'go', ' SQL ', '', 'x'.repeat(61), 5 as unknown as string])).toEqual(['go', 'sql']);
    expect(normalizeSkills(Array.from({ length: 40 }, (_, i) => `s${i}`))).toHaveLength(25);
    expect(normalizeSkills(null)).toEqual([]);
  });

  it('maps titles to [L1, L2, L3] taxonomy ids, folding Taiwan vocabulary for the match', () => {
    expect(taxonomyIdsForTitle('Senior Backend Engineer')).toEqual({ ids: ['software_engineering', 'swe_backend', 'backend_engineer'], primary: 'backend_engineer' });
    expect(taxonomyIdsForTitle('資料分析師').primary).toBe('data_analyst');
    expect(taxonomyIdsForTitle('Chief Vibes Officer')).toEqual({ ids: [], primary: null });
  });
});

describe('adapters', () => {
  it('reject rows without identity fields', () => {
    expect(inputFromFantasticJob(null, 'activejobs', now)).toBeNull();
    expect(inputFromFantasticJob({ id: '', title: 'x', organization: 'y' }, 'activejobs', now)).toBeNull();
    expect(inputFromFantasticJob({ id: 1, title: 'x' }, 'linkedin', now)).toBeNull();
    expect(inputFromJSearchJob([], { country: 'us', fetchedAt: now })).toBeNull();
    expect(inputFromJSearchJob({ job_id: 'a', job_title: 'x' }, { country: 'us', fetchedAt: now })).toBeNull();
    expect(inputFromBankJob({ id: '', title: 'x', companyName: 'y' }, 'robohire', { applyUrl: 'https://x.example' })).toBeNull();
    expect(inputFromBankJob({ id: 'a', title: 'x', companyName: null, company: null }, 'robohire', { applyUrl: 'https://x.example' })).toBeNull();
  });

  it('reads alternative Fantastic Jobs salary and location shapes', () => {
    const input = inputFromFantasticJob(
      {
        id: 7,
        title: 'Engineer',
        organization: 'Acme',
        salary_raw: { currency: 'EUR', value: 60000, unitText: 'YEAR' },
        locations_raw: [{ address: { addressCountry: { name: 'Germany' } } }],
        location_type: 'TELECOMMUTE',
        domain_derived: 'acme.example',
        date_created: '2026-10-01T00:00:00',
      },
      'activejobs',
      now,
    )!;
    expect(input).toMatchObject({ salaryMin: 60000, salaryMax: 60000, salaryCurrency: 'EUR', salaryPeriod: 'YEAR', locationCountry: 'Germany', workModel: 'remote', postedAtEstimated: true });
    expect(input.companyFacts?.website).toBe('https://acme.example');
    const ai = inputFromFantasticJob({ id: 8, title: 'E', organization: 'A', ai_salary_minvalue: 50, ai_salary_maxvalue: 70, ai_salary_currency: 'USD', ai_salary_unittext: 'HOUR', ai_employment_type: ['PART_TIME'] }, 'activejobs', now)!;
    expect(ai).toMatchObject({ salaryMin: 50, salaryMax: 70, salaryCurrency: 'USD', salaryPeriod: 'HOUR', employmentType: 'PART_TIME', companyFacts: null });
  });

  it('reads JSearch timestamps, the fallback location and "no experience required"', () => {
    const input = inputFromJSearchJob(
      { job_id: 'z', job_title: 'Cashier', employer_name: 'Shop', job_posted_at_timestamp: 1_760_000_000, job_location: 'Taipei, Taiwan', job_required_experience: { no_experience_required: true }, job_employment_types: ['PARTTIME'] },
      { country: 'tw', fetchedAt: now },
    )!;
    expect(input).toMatchObject({ location: 'Taipei, Taiwan', experienceMonths: 0, postedAtEstimated: false, employmentType: ['PARTTIME'], locationCountryEstimated: true });
    expect(input.postedAt).toEqual(new Date(1_760_000_000_000));
  });

  it('keeps bank USD for GoHire only when the pay text says USD, and joins the description parts', () => {
    const input = inputFromBankJob(
      { id: 'g', title: 'Engineer', companyName: 'Acme', salaryCurrency: 'USD', salaryText: 'USD 5k/month', description: 'Build things.', qualifications: 'Go.', locations: [{ city: '深圳', country: '中国' }, 'bad'] },
      'gohire',
      { applyUrl: 'https://www.gohire.top/jobs/g' },
    )!;
    expect(input).toMatchObject({ salaryCurrency: 'USD', description: 'Build things.\n\nGo.', location: '深圳, 中国', locations: ['深圳, 中国'], bankCompanyRef: null, skills: null });
  });
});

describe('review regressions: end to end', () => {
  const base: ProviderJobInput = { externalId: 'r:1', title: 'Engineer', company: 'Acme', applyUrl: 'https://careers.acme.example/1' };

  it('places an ambiguous city in the country the provider or the search states', () => {
    expect(normalizeProviderJob({ ...base, location: 'Cambridge', locationCountry: 'GB' }, 'activejobs', { now })).toMatchObject({
      locationCity: 'Cambridge',
      locationRegion: 'England',
      locationCountry: 'GB',
      geoLat: 52.21,
    });
    expect(normalizeProviderJob({ ...base, location: 'Cambridge' }, 'jsearch', { now, countryHint: 'GB' })).toMatchObject({ locationCountry: 'GB', geoLat: 52.21 });
    expect(normalizeProviderJob({ ...base, location: 'Birmingham', locationRegion: 'AL', locationCountry: 'US' }, 'activejobs', { now })).toMatchObject({
      locationCountry: 'US',
      locationRegion: 'AL',
      geoLat: 33.52,
    });
    // Later locations of a multi-location post use the provider country only as a weak hint.
    const multi = normalizeProviderJob({ ...base, locations: ['Austin, TX', 'London'], locationCountry: 'US' }, 'activejobs', { now });
    expect(multi.locations.map((l) => l.country)).toEqual(['US', 'GB']);
  });

  it('keeps a single stated pay bound single through the Fantastic adapter', () => {
    const row = { ...fantastic.activejobs_en, salary: { currency: 'USD', value: { minValue: 150000, unitText: 'YEAR' } } };
    const job = normalizeProviderJob(inputFromFantasticJob(row, 'activejobs', now)!, 'activejobs', { now });
    expect(job).toMatchObject({ salaryMin: 150000, salaryMax: null, salaryAnnualMin: 150000, salaryAnnualMax: null, salaryDisclosed: true });
    const exact = { ...fantastic.activejobs_en, salary: { currency: 'USD', value: 120000, unitText: 'YEAR' } };
    expect(normalizeProviderJob(inputFromFantasticJob(exact, 'activejobs', now)!, 'activejobs', { now })).toMatchObject({ salaryMin: 120000, salaryMax: 120000 });
  });

  it('never sets a work model from domain words in a title', () => {
    for (const title of ['Hybrid Cloud Architect', 'Remote Sensing Scientist', '混合云架构师']) {
      const job = normalizeProviderJob({ ...base, title }, 'activejobs', { now });
      expect(job.workModel).toBeNull();
      expect(job.fieldSources.workModel).toBeUndefined();
    }
  });

  it('drops LinkedIn-hosted logos and flags a LinkedIn apply link', () => {
    const job = normalizeProviderJob(
      { ...base, applyUrl: 'https://www.linkedin.com/jobs/view/4100000002', companyLogoUrl: 'https://media.licdn.com/dms/image/acme.png' },
      'linkedin',
      { now },
    );
    expect(job.companyLogoUrl).toBeNull();
    expect(job.company.logoUrl).toBeNull();
    expect(job.applyUrl).toBe('https://www.linkedin.com/jobs/view/4100000002');
    expect(job.sourceUrl).toBeNull();
    expect(job.notes).toEqual(expect.arrayContaining(['apply_url_linkedin_host', 'linkedin_logo_dropped']));
    const other = normalizeProviderJob({ ...base, companyLogoUrl: 'https://media.example/acme.png' }, 'activejobs', { now });
    expect(other.companyLogoUrl).toBe('https://media.example/acme.png');
    expect(other.notes).not.toContain('linkedin_logo_dropped');
  });

  it('keeps an undated job\'s estimated postedAt at the existing row\'s firstSeenAt', () => {
    const firstSeenAt = new Date('2026-09-20T00:00:00Z');
    const again = normalizeProviderJob({ ...base, fetchedAt: now }, 'jsearch', { now, firstSeenAt });
    expect(again).toMatchObject({ postedAt: firstSeenAt, postedAtEstimated: true, expiresAt: new Date('2026-11-04T00:00:00Z') });
    expect(normalizeProviderJob({ ...base, fetchedAt: now }, 'jsearch', { now }).postedAt).toEqual(now);
  });

  it('computes originalHost (employer host over a job board)', () => {
    const job = normalizeProviderJob({ ...base, sourceUrl: 'https://www.indeed.com/viewjob?jk=1' }, 'jsearch', { now });
    expect(job.originalHost).toBe('careers.acme.example');
  });
  it('SCHEMA-2 RAJob.originalHost: the WP-16b upsert persists originalHost (insert column, VALUES and ON CONFLICT … SET)', async () => {
    const { UPSERT_COLUMNS, buildJobUpsertSql, toUpsertRow } = await import('../ingest/upsert.js');
    const job = normalizeProviderJob({ ...base, sourceUrl: 'https://www.indeed.com/viewjob?jk=1' }, 'jsearch', { now });
    expect(job.originalHost).toBe('careers.acme.example');
    const row = toUpsertRow(job, null, 'cjobid000000000000000000');
    expect(row.originalHost).toBe('careers.acme.example');
    const sql = buildJobUpsertSql([row]);
    const text = sql.text.replace(/\s+/g, ' ');
    expect(text).toMatch(/INSERT INTO "RAJob" \([^)]*"originalHost"/);
    expect(text).toContain('"originalHost" = EXCLUDED."originalHost"');
    expect(sql.values[UPSERT_COLUMNS.indexOf('originalHost')]).toBe('careers.acme.example');
    // A posting with no usable host stores NULL, never a job board's or LinkedIn's host.
    const none = toUpsertRow(normalizeProviderJob({ ...base, applyUrl: 'https://www.linkedin.com/jobs/view/1', sourceUrl: null }, 'linkedin', { now }), null);
    expect(none.originalHost === null || !/linkedin/.test(none.originalHost)).toBe(true);
  });
});

describe('PAR-7: mainland normalisation and the market of an employer-board posting', () => {
  const board = (over: Record<string, unknown> = {}) => ({
    externalId: 'acme:1',
    sourceBoard: 'greenhouse',
    title: '后端工程师',
    company: 'Acme',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    location: '上海',
    description: '岗位职责：负责后端服务开发。\n任职要求：本科及以上学历，3年以上经验。\n工作性质：全职\n薪资：1.5-2.5万',
    ...over,
  });

  it('a posting whose text says 本科及以上 gets bachelor with its quote; a provider label wins over the text', () => {
    const fromText = normalizeProviderJob(board(), 'ats_public', { now });
    expect(fromText).toMatchObject({ educationLevel: 'bachelor', educationEvidence: '本科及以上学历' });
    expect(fromText.fieldSources.educationLevel).toBe('posting_text');
    const fromProvider = normalizeProviderJob(board({ educationLevel: '硕士' }), 'ats_public', { now });
    expect(fromProvider).toMatchObject({ educationLevel: 'master', educationEvidence: null });
    expect(fromProvider.fieldSources.educationLevel).toBe('provider');
    const silent = normalizeProviderJob(board({ description: '负责后端服务开发。' }), 'ats_public', { now });
    expect(silent.educationLevel).toBeNull();
    expect(silent.fieldSources.educationLevel).toBeUndefined();
  });

  it('全职 becomes full_time and a mainland posting\'s 1.5-2.5万 becomes 15,000-25,000 CNY a month', () => {
    const job = normalizeProviderJob(board({ employmentType: '全职' }), 'ats_public', { now });
    expect(job).toMatchObject({ employmentType: 'full_time', salaryMin: 15000, salaryMax: 25000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryDisclosed: true });
    expect(normalizeProviderJob(board({ employmentType: '劳务' }), 'ats_public', { now }).employmentType).toBe('contract');
  });

  it('an ats_public posting takes the market of its own location, whatever market the caller reads the board for', () => {
    for (const ctxMarket of ['intl', 'cn', undefined] as const) {
      expect(normalizeProviderJob(board(), 'ats_public', { now, market: ctxMarket }).market).toBe('cn');
      expect(normalizeProviderJob(board({ location: 'Singapore' }), 'ats_public', { now, market: ctxMarket }).market).toBe('intl');
    }
    // The company record follows the job's market, and the mainland city is shown in Chinese.
    const cn = normalizeProviderJob(board({ location: 'Shanghai, China' }), 'ats_public', { now, market: 'intl' });
    expect(cn).toMatchObject({ market: 'cn', locationCountry: 'CN', locationCity: '上海' });
    expect(cn.company.market).toBe('cn');
  });

  it.each([
    // Review cases: named without the words Hong Kong, Macau or Taiwan, filed under China.
    [{ location: 'Kowloon, China' }],
    [{ location: 'Wan Chai, HK, CN' }],
    [{ location: 'Tsim Sha Tsui', locationCountry: 'cn' }],
    [{ location: 'New Territories', locationCountry: 'CN' }],
    [{ location: 'Cotai', locationCountry: 'cn' }],
    [{ location: 'Hsinchu, China' }],
    [{ location: 'Kaohsiung City, China' }],
    [{ location: 'Tainan, China' }],
    [{ location: 'Zhubei', locationCountry: 'cn' }],
    [{ location: 'Taichung', locationCountry: 'cn' }],
    // The region field says so.
    [{ location: 'Kwun Tong', locationCity: 'Kwun Tong', locationRegion: 'HK', locationCountry: 'cn' }],
    [{ location: 'Central', locationRegion: 'Hong Kong', locationCountry: 'cn' }],
    // A Taiwan city the city table knows, filed under China (no pattern needed).
    [{ location: 'Keelung, China' }],
    // The three words themselves, as before.
    [{ location: 'Hong Kong SAR, China' }],
    [{ location: 'Macau SAR, China' }],
    [{ location: '新竹', locationCountry: 'cn' }],
  ])('Hong Kong, Macau and Taiwan are never mainland China: %j', (place) => {
    expect(marketOfPosting({ externalId: 'x:1', title: 'Engineer', company: 'Acme', ...place })).toBe('intl');
    expect(normalizeProviderJob(board(place), 'ats_public', { now, market: 'cn' }).market).toBe('intl');
  });

  it.each([
    [{ location: 'Shanghai, China' }],
    [{ location: 'Shenzhen', locationCountry: 'cn' }],
    [{ location: 'Suzhou, Jiangsu, China' }],
    // 九龙 inside a mainland address, and a mainland county that shares a Taiwan city's name.
    [{ location: '重庆市九龙坡区' }],
    [{ location: 'Taoyuan, Hunan, China' }],
    // A mainland town the city table does not know.
    [{ location: 'Kunshan', locationCountry: 'cn' }],
  ])('a mainland place stays mainland: %j', (place) => {
    expect(marketOfPosting({ externalId: 'x:1', title: 'Engineer', company: 'Acme', ...place })).toBe('cn');
  });

  it('every other provider keeps the caller\'s market (a bank or search row is never re-routed by its location)', () => {
    expect(normalizeProviderJob(board({ sourceBoard: 'jsearch' }), 'jsearch', { now, market: 'intl' }).market).toBe('intl');
    expect(normalizeProviderJob(board({ sourceBoard: 'robohire' }), 'bank_robohire', { now }).market).toBe('intl');
    expect(normalizeProviderJob(board({ sourceBoard: 'gohire', location: 'Singapore' }), 'bank_gohire', { now }).market).toBe('cn');
  });

  it('an agency posting marks the job, never the employer\'s company record', () => {
    const job = normalizeProviderJob(board({ sourceBoard: 'gohire', agencyPosting: true }), 'bank_gohire', { now });
    expect(job.isAgency).toBe(true);
    expect(job.company.isAgency).toBeNull();
    // A staffing firm by name is an agency in both places, as before.
    const firm = normalizeProviderJob(board({ sourceBoard: 'gohire', company: '某某人力资源服务有限公司' }), 'bank_gohire', { now });
    expect(firm.isAgency).toBe(true);
    expect(firm.company.isAgency).toBe(true);
  });
});

// ── MKT-1C: the contracts the source wave builds on (MARKET_STRATEGY §1.2 to §1.5; MARKET_TASK_PLAN "Provider ids and adapter options") ──

describe('MKT-1C: a role the source states (ProviderJobInput.taxonomyId)', () => {
  // SYNTHETIC rows. The title names no role of the taxonomy (or another one), so only the source's own code can place it.
  const base: ProviderJobInput = { externalId: 'tw:1', title: '儲備幹部', company: 'Formosa Example Co', location: '台北市中山區', applyUrl: 'https://example.com/jobs/1' };
  const chain = (id: string) => taxonomyAncestors(id).map((n) => n.id).reverse();

  it('a valid role (L3) id becomes the primary taxonomy id with its ancestors, source provider', () => {
    expect(taxonomyIdsForTitle(base.title).primary).toBeNull();
    const job = normalizeProviderJob({ ...base, taxonomyId: 'software_engineer' }, 'tw_open_data', { now });
    expect(job.primaryTaxonomyId).toBe('software_engineer');
    expect(job.taxonomyIds).toEqual(chain('software_engineer'));
    expect(job.taxonomyIds).toHaveLength(3);
    expect(job.fieldSources.taxonomy).toBe('provider');
    expect(job.coverage.taxonomy).toBe(true);
  });

  it('the source\'s role wins over an unrelated title, for any provider', () => {
    const titled = { ...base, title: 'Senior Product Manager' };
    expect(normalizeProviderJob(titled, 'tw_open_data', { now })).toMatchObject({ primaryTaxonomyId: 'product_manager', fieldSources: { taxonomy: 'title' } });
    for (const provider of ['tw_open_data', 'activejobs_feed', 'usajobs', 'ats_public'] as NormalizeProvider[]) {
      const job = normalizeProviderJob({ ...titled, taxonomyId: ' software_engineer ' }, provider, { now });
      expect(job.primaryTaxonomyId, provider).toBe('software_engineer');
      expect(job.fieldSources.taxonomy, provider).toBe('provider');
    }
  });

  it.each([
    ['an unknown id', 'not_a_role_id'],
    ['a group (L2) id', 'swe_backend'],
    ['a category (L1) id', 'software_engineering'],
    ['an empty string', ''],
    ['null', null],
    ['absent', undefined],
  ])('%s is ignored: the title dictionary decides as before', (_label, taxonomyId) => {
    if (typeof taxonomyId === 'string' && taxonomyId) expect(getTaxonomyNode(taxonomyId)?.level ?? 0).not.toBe(3);
    const titled = { ...base, title: 'Senior Product Manager' };
    const withId = normalizeProviderJob({ ...titled, taxonomyId }, 'tw_open_data', { now });
    expect(withId).toEqual(normalizeProviderJob(titled, 'tw_open_data', { now }));
    expect(withId).toMatchObject({ primaryTaxonomyId: 'product_manager', taxonomyIds: chain('product_manager'), fieldSources: { taxonomy: 'title' } });
    // No title match either: no role at all (enrichment decides), never a guess.
    const none = normalizeProviderJob({ ...base, taxonomyId }, 'tw_open_data', { now });
    expect(none).toMatchObject({ primaryTaxonomyId: null, taxonomyIds: [], coverage: { taxonomy: false } });
    expect(none.fieldSources.taxonomy).toBeUndefined();
  });

  it('the other new input fields are carried on the input only: nothing reads them yet', () => {
    const plain = normalizeProviderJob(base, 'tw_open_data', { now });
    const extra = normalizeProviderJob({ ...base, sponsorshipProvider: 'offered', locationDistrict: '中山區', workShift: '日班' }, 'tw_open_data', {
      now,
      companyDomains: new Map([[plain.companyNameNormalized, 'example.com']]),
    });
    expect(extra).toEqual(plain);
  });
});

describe('MKT-1C: the four new providers', () => {
  const minimal: ProviderJobInput = { externalId: 'x:1', title: 'Accountant', company: 'Example Works', applyUrl: 'https://example.com/jobs/1' };

  it.each([
    ['tw_open_data', { sourceBoard: 'tw_open_data', sourcePriority: 12, sourceName: '台灣就業通' }],
    ['tw_gov_jobs', { sourceBoard: 'tw_gov_jobs', sourcePriority: 12, sourceName: '事求人' }],
    ['usajobs', { sourceBoard: 'usajobs', sourcePriority: 8, sourceName: 'USAJOBS' }],
    ['activejobs_feed', { sourceBoard: 'activejobs', sourcePriority: 10, sourceName: 'Active Jobs DB' }],
  ] as Array<[NormalizeProvider, { sourceBoard: string; sourcePriority: number; sourceName: string }]>)('%s normalises a minimal input', (provider, expected) => {
    const job = normalizeProviderJob(minimal, provider, { now });
    expect(job).toMatchObject({
      provider,
      market: 'intl',
      visibility: 'public',
      ownerUserId: null,
      externalId: 'x:1',
      ...expected,
      fromRecruiterBank: false,
      employerVerified: false,
      publicDisplay: false,
      applyUrl: 'https://example.com/jobs/1',
      originalHost: 'example.com',
      salaryDisclosed: false,
      salaryMin: null,
      workModel: null,
    });
    expect(job.notes).toEqual([]);
    // Deterministic, and a MarketHookJob like every other provider's row.
    expect(normalizeProviderJob(minimal, provider, { now })).toEqual(job);
    expect(asMarketHookJob(job).provider).toBe(provider);
  });

  it('the feed and the search provider write the same board, priority and source line: one posting, one row', () => {
    const feed = normalizeProviderJob(minimal, 'activejobs_feed', { now });
    const search = normalizeProviderJob(minimal, 'activejobs', { now });
    expect({ ...feed, provider: 'activejobs', company: { ...feed.company, facts: search.company.facts } }).toEqual(search);
    expect(feed.dedupeKey).toBe(search.dedupeKey);
  });

  it("the board 'activejobs' still resolves to the search provider in the feed check's reverse lookup", () => {
    expect(providerOfBoard('activejobs')).toBe('activejobs');
    expect(providerOfBoard('tw_open_data')).toBe('tw_open_data');
    expect(providerOfBoard('tw_gov_jobs')).toBe('tw_gov_jobs');
    expect(providerOfBoard('usajobs')).toBe('usajobs');
    expect(providerOfBoard('jsearch')).toBe('jsearch');
    expect(providerOfBoard('greenhouse')).toBe('ats_public');
    // The rule that keeps it so: only the feed shares a board, and its entry comes before the search provider's.
    const keys = Object.keys(PROVIDER_META);
    expect(keys.indexOf('activejobs_feed')).toBeLessThan(keys.indexOf('activejobs'));
    const boards = Object.entries(PROVIDER_META).filter(([p]) => p !== 'activejobs_feed').map(([, m]) => m.sourceBoard);
    expect(new Set(boards).size).toBe(boards.length);
  });

  it('existing providers keep their priority, board and source name', () => {
    expect(Object.fromEntries(Object.entries(PROVIDER_META).map(([p, m]) => [p, [m.sourcePriority, m.sourceBoard, m.aggregatorName, m.applicantCountAllowed, m.fromRecruiterBank]]))).toMatchObject({
      activejobs: [10, 'activejobs', 'Active Jobs DB', true, false],
      ats_public: [10, 'ats_public', null, true, false],
      bank_robohire: [15, 'robohire', 'RoboHire', true, true],
      bank_gohire: [15, 'gohire', 'GoHire', true, true],
      linkedin: [20, 'linkedin', 'Fantastic Jobs', false, false],
      jsearch: [30, 'jsearch', 'JSearch', false, false],
      user_import: [90, 'user_import', null, false, false],
    });
    expect(Object.keys(PROVIDER_META).sort()).toEqual(
      ['activejobs', 'activejobs_feed', 'ats_public', 'bank_gohire', 'bank_robohire', 'jsearch', 'linkedin', 'tw_gov_jobs', 'tw_open_data', 'usajobs', 'user_import'].sort(),
    );
  });

  it('a government source carries no applicant count; the licensed feed may, with a citable source', () => {
    const counted = { ...minimal, applicantCount: 12, applicantCountSource: 'Example ATS' };
    for (const provider of ['tw_open_data', 'tw_gov_jobs', 'usajobs'] as NormalizeProvider[]) {
      const job = normalizeProviderJob(counted, provider, { now });
      expect(job, provider).toMatchObject({ applicantCount: null, applicantCountSource: null, applicantCountAt: null });
      expect(job.notes, provider).toContain(`applicant_count_dropped:${provider}`);
    }
    expect(normalizeProviderJob(counted, 'activejobs_feed', { now })).toMatchObject({ applicantCount: 12, applicantCountSource: 'Example ATS' });
  });

  it('JT-1 end to end: a 台灣就業通 row with the no-figure sentence has no pay; numeric fields are the only figures', () => {
    // SYNTHETIC row in the shape MKT-3E's adapter will hand over: SALARYCD as salaryText when NT_L / NT_U are '-'.
    const row: ProviderJobInput = {
      externalId: 'tw_open_data:SYNTHETIC-1',
      title: '門市人員',
      company: 'Formosa Example Co',
      location: '台北市中山區',
      locationCountry: 'TW',
      applyUrl: 'https://example.com/tw/jobs/1',
      salaryText: '依學經歷、證照核薪(每月經常性薪資達4萬元以上)',
    };
    const job = normalizeProviderJob(row, 'tw_open_data', { now });
    expect(job).toMatchObject({
      locationCountry: 'TW',
      salaryDisclosed: false,
      salaryMin: null,
      salaryMax: null,
      salaryAnnualMin: null,
      salaryAnnualMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
      salarySource: null,
      salaryText: '依學經歷、證照核薪(每月經常性薪資達4萬元以上)',
    });
    expect(job.fieldSources.salary).toBeUndefined();
    expect(normalizeProviderJob({ ...row, salaryMin: 32000, salaryMax: 38000, salaryCurrency: 'TWD', salaryPeriod: 'month', salaryText: '月薪' }, 'tw_open_data', { now })).toMatchObject({
      salaryDisclosed: true,
      salaryMin: 32000,
      salaryMax: 38000,
      salaryCurrency: 'TWD',
      salaryPeriod: 'month',
      salarySource: 'provider',
      salaryAnnualMin: 384000,
    });
  });

  // Review finding (high): a recruiter-bank row is market cn whatever its location, and the licensed feed will
  // serve the mainland too. A job in Taipei on such a row carried NT$40,000 as disclosed pay.
  it('JT-1 end to end: a GoApply (market cn) row for a job in Taiwan never stores the threshold as pay', () => {
    for (const salaryText of ['待遇面議（經常性薪資達4萬元或以上）', '依學經歷、證照核薪(每月經常性薪資達4萬元以上)', '面議，月薪5萬以上']) {
      const row: ProviderJobInput = { externalId: 'bank:SYNTHETIC-TW-1', title: '後端工程師', company: 'Formosa Example Co', location: '台北市', locationCountry: 'TW', applyUrl: 'https://example.com/tw/jobs/2', salaryText };
      for (const provider of ['bank_gohire', 'bank_robohire', 'activejobs_feed'] as NormalizeProvider[]) {
        const job = normalizeProviderJob(row, provider, { now, market: 'cn' });
        expect(job, `${provider} ${salaryText}`).toMatchObject({
          market: 'cn',
          locationCountry: 'TW',
          salaryDisclosed: false,
          salaryMin: null,
          salaryMax: null,
          salaryAnnualMin: null,
          salaryCurrency: null,
          salaryPeriod: null,
          salaryText: salaryText.normalize('NFKC'),
        });
      }
      // The clause in the description only, wording on one line and the clause on the next.
      const inDescription = normalizeProviderJob({ ...row, salaryText: null, description: '工作內容：後端開發\n薪資：依學經歷、證照核薪\n（每月經常性薪資達4萬元以上）' }, 'bank_gohire', { now, market: 'cn' });
      expect(inDescription).toMatchObject({ salaryDisclosed: false, salaryMin: null, salaryAnnualMin: null, salaryText: '依學經歷、證照核薪' });
    }
    // The statute's wording on a mainland row whose location is unknown: never ¥40,000 a month.
    const unknown = normalizeProviderJob({ externalId: 'bank:SYNTHETIC-TW-2', title: '后端工程师', company: 'Example Co', applyUrl: 'https://example.com/jobs/3', salaryText: '待遇面議（經常性薪資達4萬元或以上）' }, 'bank_gohire', { now, market: 'cn' });
    expect(unknown).toMatchObject({ market: 'cn', salaryDisclosed: false, salaryMin: null, salaryCurrency: null });
    // A mainland posting's own minimum next to 面议 is unchanged.
    const mainland = normalizeProviderJob({ externalId: 'bank:SYNTHETIC-CN-1', title: '后端工程师', company: 'Example Co', location: '上海', locationCountry: 'CN', applyUrl: 'https://example.com/jobs/4', salaryText: '薪资面议，月薪5万以上' }, 'bank_gohire', { now, market: 'cn' });
    expect(mainland).toMatchObject({ market: 'cn', salaryDisclosed: true, salaryMin: 50000, salaryMax: null, salaryCurrency: 'CNY', salaryPeriod: 'month' });
  });

  // Review finding: a posting whose description lists payroll work (核薪) and states no pay stores no pay text.
  it('a description that lists 核薪 as a duty stores no pay text (D3)', () => {
    for (const [market, country, location] of [['intl', 'TW', '台北市'], ['cn', 'CN', '上海']] as const) {
      const job = normalizeProviderJob(
        { externalId: `ats:SYNTHETIC-HR-${market}`, sourceBoard: 'greenhouse', title: '人資專員', company: 'Formosa Example Co', location, locationCountry: country, applyUrl: 'https://example.com/jobs/5', description: '工作內容：\n1. 負責每月薪資核算、核薪、勞健保加退保\n2. 负责公司绩效考核薪酬体系搭建\n3. 人資將審核薪水並核薪' },
        'ats_public',
        { now, market },
      );
      expect(job, market).toMatchObject({ salaryDisclosed: false, salaryMin: null, salaryMax: null, salaryText: null, salarySource: null });
    }
  });
});
