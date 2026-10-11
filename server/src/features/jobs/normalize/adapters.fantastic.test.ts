// @vitest-environment node
// MKT-5A item 5 (JI-7; MARKET_STRATEGY §1.5 "Provider fields first"; JOB_SOURCES_INTL §8.2 S3):
// the licensed feed's own fields are mapped before any model is asked, the
// sponsorship flag is carried as the provider's reading, and nothing LinkedIn,
// Crunchbase or personal ever reaches the normalizer's input.
// Fixtures: fantastic-feed.json (SYNTHETIC, v1 field names) and fantastic.json
// (the older field names). No network, no database.
import { describe, expect, it } from 'vitest';

import feed from './__fixtures__/fantastic-feed.json' with { type: 'json' };
import expired from './__fixtures__/fantastic-expired.json' with { type: 'json' };
import legacy from './__fixtures__/fantastic.json' with { type: 'json' };
import { FANTASTIC_TAXONOMY_CATEGORY, FANTASTIC_TAXONOMY_LABELS, fantasticTaxonomyCategory, inputFromFantasticJob } from './adapters.js';
import { normalizeProviderJob } from './normalizeProviderJob.js';
import { getTaxonomyNode } from '../taxonomy/index.js';

const now = new Date('2026-10-12T09:00:00.000Z');
const input = (row: unknown) => inputFromFantasticJob(row, 'activejobs', now)!;
const normalized = (row: unknown) => normalizeProviderJob(input(row), 'activejobs_feed', { now, market: 'intl' });

describe('the feed row → normalizer input (v1 field names)', () => {
  const row = feed.us_offered;
  const mapped = input(row);

  it('identity: the integer id becomes the externalId the search adapter writes too', () => {
    expect(mapped.externalId).toBe('activejobs:2900000001');
    expect(mapped.sourceBoard).toBe('activejobs');
    expect(mapped.title).toBe('Backend Engineer, Billing Platform');
    expect(mapped.company).toBe('Larkspur Freight Systems');
    expect(mapped.applyUrl).toBe(row.url);
    expect(mapped.applyIsDirect).toBe(true);
  });

  it("the provider's level, work arrangement, employment type, skills and pay", () => {
    expect(mapped.experienceLevel).toBe('5-10');
    expect(mapped.workModel).toBe('Hybrid');
    expect(mapped.employmentType).toBe('Full time');
    expect(mapped.skills).toEqual(['Go', 'Kotlin', 'PostgreSQL', 'Kafka', 'Kubernetes', 'gRPC']);
    expect(mapped).toMatchObject({ salaryMin: 150000, salaryMax: 185000, salaryCurrency: 'USD', salaryPeriod: 'YEAR' });
  });

  it("the employer's derived domain is a company fact with its source", () => {
    expect(mapped.companyFacts).toEqual({
      source: 'provider:activejobs',
      website: 'https://larkspurfreight.wd5.myworkdayjobs.example/careers',
      domain: 'larkspurfreight.example',
      fetchedAt: now,
    });
    // A row that states only the derived domain still gets the fact.
    const { organization_url: _url, ...rest } = row;
    expect(input(rest).companyFacts).toEqual({ source: 'provider:activejobs', website: 'https://larkspurfreight.example', domain: 'larkspurfreight.example', fetchedAt: now });
    // A value that is not a host is not a domain.
    expect(input({ ...rest, domain_derived: 'not a domain' }).companyFacts).toEqual({ source: 'provider:activejobs', website: 'https://not a domain', fetchedAt: now });
    expect(input({ ...rest, domain_derived: 'HTTPS://WWW.Larkspurfreight.example/jobs?x=1' }).companyFacts?.domain).toBe('larkspurfreight.example');
  });

  it('dates: posted from date_posted, expiry from date_valid_through (and from the older name)', () => {
    expect(mapped.postedAt).toBe('2026-10-09T14:00:00');
    expect(mapped.postedAtEstimated).toBe(false);
    expect(mapped.expiresAt).toBe('2026-11-20T00:00:00');
    const { date_valid_through: _new, ...rest } = row;
    expect(input({ ...rest, date_validthrough: '2026-12-24T00:00:00' }).expiresAt).toBe('2026-12-24T00:00:00');
    // The v1 name wins when a row carries both.
    expect(input({ ...row, date_validthrough: '2031-01-01T00:00:00' }).expiresAt).toBe('2026-11-20T00:00:00');
  });

  it('a row without date_posted is dated by date_created and marked estimated', () => {
    const undated = input(feed.no_flag);
    expect(undated.postedAt).toBe('2026-10-10T03:05:10');
    expect(undated.postedAtEstimated).toBe(true);
    expect(undated.expiresAt).toBeNull();
  });

  it('through the normalizer: seniority from the level, the work model, skills, the domain, the reading and the expiry', () => {
    const job = normalized(row);
    expect(job.provider).toBe('activejobs_feed');
    expect(job.sourceBoard).toBe('activejobs');
    expect(job.externalId).toBe('activejobs:2900000001');
    expect(job.seniority).toBe('senior');
    expect(job.fieldSources.seniority).toBe('years');
    expect([job.minYears, job.maxYears]).toEqual([5, 10]);
    expect(job.workModel).toBe('hybrid');
    expect(job.fieldSources.workModel).toBe('provider');
    expect(job.employmentType).toBe('full_time');
    expect(job.skills).toEqual(['go', 'kotlin', 'postgresql', 'kafka', 'kubernetes', 'grpc']);
    expect(job.fieldSources.skills).toBe('provider');
    expect(job.company.domain).toBe('larkspurfreight.example');
    expect(job.sponsorshipProvider).toBe('offered');
    expect(job.expiresAt?.toISOString()).toBe('2026-11-20T00:00:00.000Z');
    expect(job.postedAt?.toISOString()).toBe('2026-10-09T14:00:00.000Z');
    expect(job.salaryDisclosed).toBe(true);
    expect(job.applyUrl).toBe(row.url);
  });
});

describe("the visa-sponsorship flag is the provider's reading, never a fact", () => {
  it("true → 'offered'; no flag → null", () => {
    expect(input(feed.us_offered).sponsorshipProvider).toBe('offered');
    expect(input(feed.no_flag).sponsorshipProvider).toBeNull();
    expect(normalized(feed.no_flag).sponsorshipProvider).toBeNull();
  });

  it('false is "the description does not mention it", not "not offered": no reading (D3)', () => {
    expect(input({ ...feed.us_offered, ai_visa_sponsorship: false }).sponsorshipProvider).toBeNull();
    // The older fixture carries the flag as false.
    expect(legacy.activejobs_en.ai_visa_sponsorship).toBe(false);
    expect(input(legacy.activejobs_en).sponsorshipProvider).toBeNull();
  });

  it('only the boolean true is a reading (a string or a number is not the documented flag)', () => {
    for (const value of ['true', 1, 'yes', null, {}]) expect(input({ ...feed.us_offered, ai_visa_sponsorship: value }).sponsorshipProvider).toBeNull();
  });
});

describe("the vendor's taxonomy label → a category of our tree", () => {
  it('the table holds exactly the 33 labels the vendor documents, each mapped to a category (level 1) of our tree or to null', () => {
    expect(FANTASTIC_TAXONOMY_LABELS).toHaveLength(33);
    expect(new Set(FANTASTIC_TAXONOMY_LABELS).size).toBe(33);
    for (const [label, id] of Object.entries(FANTASTIC_TAXONOMY_CATEGORY)) {
      if (id === null) continue;
      const node = getTaxonomyNode(id);
      expect(node, label).toBeTruthy();
      expect(node!.level, label).toBe(1);
    }
    // Every label a fixture row carries is one of the documented ones.
    for (const row of [feed.us_offered, feed.no_flag, feed.cn_shanghai, feed.cn_hongkong]) {
      for (const label of row.ai_taxonomies_a) expect(FANTASTIC_TAXONOMY_LABELS, label).toContain(label);
    }
  });

  it('the primary label decides; a broad or unknown label maps to nothing', () => {
    expect(fantasticTaxonomyCategory(['Software', 'Technology'])).toBe('software_engineering');
    expect(fantasticTaxonomyCategory(['Finance & Accounting'])).toBe('finance');
    expect(fantasticTaxonomyCategory(['Manufacturing', 'Engineering'])).toBe('manufacturing');
    // The first label is the primary one: a mapped label further down does not count.
    expect(fantasticTaxonomyCategory(['Technology', 'Software'])).toBeNull();
    expect(fantasticTaxonomyCategory(['Quantum Basketry'])).toBeNull();
    expect(fantasticTaxonomyCategory(['software'])).toBeNull();
    expect(fantasticTaxonomyCategory([])).toBeNull();
    expect(fantasticTaxonomyCategory(undefined)).toBeNull();
    // A key of Object.prototype is not a label.
    expect(fantasticTaxonomyCategory(['constructor'])).toBeNull();
  });

  it('a mapped label sets taxonomyId; an unmapped one leaves it unset', () => {
    expect(input(feed.us_offered).taxonomyId).toBe('software_engineering');
    expect(input(feed.cn_hongkong).taxonomyId).toBe('finance');
    expect(input(feed.no_flag)).not.toHaveProperty('taxonomyId');
    expect(input({ ...feed.us_offered, ai_taxonomies_a: ['Quantum Basketry'] })).not.toHaveProperty('taxonomyId');
    expect(input(legacy.activejobs_en)).not.toHaveProperty('taxonomyId');
  });

  it('a category is not a role: the title still names the role, and the title dictionary decides when the label is unmapped', () => {
    // The normalizer takes a source's role only when it is a role (level 3) id; a category never replaces the title's role.
    const withCategory = normalized(feed.us_offered);
    const withoutCategory = normalizeProviderJob({ ...input(feed.us_offered), taxonomyId: null }, 'activejobs_feed', { now, market: 'intl' });
    expect(withCategory.primaryTaxonomyId).toBe(withoutCategory.primaryTaxonomyId);
    expect(withCategory.taxonomyIds).toEqual(withoutCategory.taxonomyIds);
    expect(withCategory.fieldSources.taxonomy).toBe(withoutCategory.fieldSources.taxonomy);
    const nurse = normalized(feed.no_flag);
    expect(nurse.fieldSources.taxonomy === undefined || nurse.fieldSources.taxonomy === 'title').toBe(true);
  });
});

describe('never mapped (H9, D3; MARKET_STRATEGY §1.6)', () => {
  /** The only keys the mapper may ever produce. */
  const ALLOWED = new Set([
    'externalId',
    'sourceBoard',
    'title',
    'company',
    'companyLogoUrl',
    'applyUrl',
    'sourceUrl',
    'applyIsDirect',
    'sourcePublisher',
    'location',
    'locations',
    'locationCity',
    'locationRegion',
    'locationCountry',
    'workModel',
    'employmentType',
    'salaryMin',
    'salaryMax',
    'salaryCurrency',
    'salaryPeriod',
    'description',
    'postedAt',
    'postedAtEstimated',
    'fetchedAt',
    'expiresAt',
    'experienceLevel',
    'skills',
    'taxonomyId',
    'sponsorshipProvider',
    'companyFacts',
  ]);
  const FACT_KEYS = new Set(['source', 'website', 'domain', 'fetchedAt']);

  it('the input holds only the keys of the list: no LinkedIn organisation field, no recruiter or hiring-manager field, no count', () => {
    for (const row of [feed.us_offered, feed.no_flag, feed.cn_shanghai, feed.cn_hongkong, legacy.activejobs_en]) {
      const mapped = input(row);
      for (const key of Object.keys(mapped)) expect(ALLOWED, key).toContain(key);
      for (const key of Object.keys(mapped.companyFacts ?? {})) expect(FACT_KEYS, key).toContain(key);
      expect(mapped).not.toHaveProperty('isAgency');
      expect(mapped).not.toHaveProperty('applicantCount');
    }
  });

  it('no value of a never-mapped field appears anywhere in the input', () => {
    const row = feed.us_offered;
    const text = JSON.stringify(input(row));
    for (const value of [
      row.ai_hiring_manager_name,
      row.ai_hiring_manager_email_address,
      row.org_linkedin_slug,
      row.org_linkedin_website,
      row.org_linkedin_industry,
      String(row.org_linkedin_headcount),
      row.org_linkedin_size,
      row.org_logo_permalink,
      String(row.org_linkedin_id),
      String(row.org_crunchbase_total_investment),
    ]) {
      expect(text, value).not.toContain(value);
    }
    expect(text.toLowerCase()).not.toContain('linkedin');
    expect(text.toLowerCase()).not.toContain('crunchbase');
    // The fixture really carries them (the assertion above is not vacuous).
    expect(Object.keys(row).filter((k) => k.startsWith('org_linkedin_')).length).toBeGreaterThanOrEqual(8);
  });

  it('the company record gets no industry, size or head count from the feed (the feed has them only as LinkedIn fields)', () => {
    const job = normalized(feed.us_offered);
    expect(job.company.industries).toEqual([]);
    expect(job.company.sizeBand).toBeNull();
    expect(job.company.employeeCount).toBeNull();
    expect(job.isAgency).toBeNull();
    expect(job.applicantCount).toBeNull();
  });
});

describe('the older field names still map (fantastic.json)', () => {
  it('activejobs_en: level, skills, work arrangement, expiry, website; no LinkedIn organisation field', () => {
    const mapped = input(legacy.activejobs_en);
    expect(mapped.externalId).toBe('activejobs:1900000001');
    expect(mapped.experienceLevel).toBe('5-10');
    expect(mapped.workModel).toBe('Remote Solely');
    expect(mapped.expiresAt).toBe('2026-11-15T00:00:00');
    expect(mapped.companyFacts).toEqual({ source: 'provider:activejobs', website: 'https://www.acme-analytics.example', fetchedAt: now });
    expect(JSON.stringify(mapped)).not.toContain('Software Development');
    expect(JSON.stringify(mapped)).not.toContain('Pat Example');
  });

  it('a row without id, title or organization is dropped', () => {
    expect(inputFromFantasticJob({ ...feed.us_offered, id: null }, 'activejobs', now)).toBeNull();
    expect(inputFromFantasticJob({ ...feed.us_offered, title: ' ' }, 'activejobs', now)).toBeNull();
    expect(inputFromFantasticJob({ ...feed.us_offered, organization: undefined }, 'activejobs', now)).toBeNull();
    expect(inputFromFantasticJob(42, 'activejobs', now)).toBeNull();
  });
});

describe('the expired fixture (ids only)', () => {
  it('is a bare array of integers, as the vendor documents the route', () => {
    expect(Array.isArray(expired)).toBe(true);
    for (const id of expired) expect(Number.isInteger(id)).toBe(true);
    // Its first two ids are rows of the two job fixtures; the rest were never stored.
    expect(expired[0]).toBe(feed.cn_shanghai.id);
    expect(String(expired[1])).toBe(legacy.activejobs_en.id);
  });
});
