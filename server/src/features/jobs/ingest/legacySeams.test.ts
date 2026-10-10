// @vitest-environment node
// WP-16b changes to legacy modules it owns:
//   - job-search: the default country comes from the serving brand;
//   - cross-bank materialization writes the inventory honesty fields
//     (market from the bank, fromRecruiterBank) and never invents a currency;
//     its update never revives a closed row or rewrites the normalized names
//     the bank sync owns.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runWithBrand } from '../../../platform/brand/index.js';
import { defaultSearchCountry, parseSearchInput } from '../../../job-search/validation.js';
import { mapRecruiterJobToRAJobUpsert } from '../../../roboapply/v2/lib/raCrossBankMatch.js';
import { normalizeCompanyName, normalizeJobTitle } from '../normalize/index.js';
import type { PreMatchedCandidate } from '../../../roboapply/v2/types/crossBank.js';

describe('job-search country defaults from the brand', () => {
  it('RoboApply → us, GoApply → cn, explicit country wins', () => {
    expect(defaultSearchCountry()).toBe('us');
    expect(runWithBrand('roboapply', () => parseSearchInput({ query: 'engineer' }).country)).toBe('us');
    expect(runWithBrand('goapply', () => parseSearchInput({ query: '数据分析' }).country)).toBe('cn');
    expect(runWithBrand('goapply', () => parseSearchInput({ query: 'engineer', country: 'TW' }).country)).toBe('tw');
  });
});

describe('cross-bank materialization honesty fields', () => {
  const cand = (bank: 'robohire' | 'gohire', salaryCurrency: string | null): PreMatchedCandidate =>
    ({
      bank,
      job: {
        id: 'j1',
        title: 'Engineer',
        description: 'd',
        qualifications: null,
        hardRequirements: null,
        niceToHave: null,
        benefits: null,
        location: null,
        locationCity: null,
        locationCountry: null,
        workType: null,
        employmentType: null,
        experienceLevel: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency,
        salaryPeriod: null,
        requiredTagSet: [],
        preferredTagSet: [],
        requiredKeywordSet: [],
        preferredKeywordSet: [],
        matchInviteScore: null,
        publishedAt: null,
      },
      company: { companyName: 'Acme', companyLogoUrl: null },
      retrievedVia: 'title',
      missingRequiredTags: [],
      missingRequiredKeywords: [],
      inviteBar: 60,
      barIsDefault: true,
      alsoOnBank: null,
    }) as unknown as PreMatchedCandidate;

  beforeEach(() => {
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://example.test/p/{id}');
    vi.stubEnv('ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE', 'https://jobs.example.test/r/{id}');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('GoHire rows are market cn, RoboHire intl, on create and on update; both fromRecruiterBank; no invented USD', () => {
    const gh = mapRecruiterJobToRAJobUpsert(cand('gohire', null))!;
    expect(gh.create).toMatchObject({ market: 'cn', fromRecruiterBank: true, sourceName: 'GoHire', sourcePriority: 15, salaryCurrency: null });
    // The update moves a row that sits in the wrong market back to its bank's market.
    expect(gh.update).toMatchObject({ market: 'cn' });
    expect(gh.create).not.toHaveProperty('publicDisplay');
    expect(gh.create).not.toHaveProperty('employerVerified');
    const rh = mapRecruiterJobToRAJobUpsert(cand('robohire', 'CAD'))!;
    expect(rh.update).toMatchObject({ market: 'intl', fromRecruiterBank: true, salaryCurrency: 'CAD' });
    expect(rh.create).toMatchObject({ market: 'intl' });
  });

  it('a candidate whose bank has no posting page is not materialised at all', () => {
    vi.stubEnv('GOHIRE_PUBLIC_JOB_URL_TEMPLATE', '');
    expect(mapRecruiterJobToRAJobUpsert(cand('gohire', null))).toBeNull();
    expect(mapRecruiterJobToRAJobUpsert(cand('robohire', 'USD'))).not.toBeNull();
  });

  it('the update never revives a closed row or rewrites the normalized names the bank sync owns', () => {
    const args = mapRecruiterJobToRAJobUpsert({ ...cand('robohire', 'USD'), company: { companyName: 'Acme, Inc.', companyLogoUrl: null } } as PreMatchedCandidate)!;
    // A row closed as 'reported' / 'duplicate' stays closed; the bank sync revives only bank_closed / source_removed.
    expect(args.update).not.toHaveProperty('archivedAt');
    expect(args.update).not.toHaveProperty('titleNormalized');
    expect(args.update).not.toHaveProperty('companyNameNormalized');
    // A new row is born live, with the WP-16a normalizers (agreeing with dedupeKey / companyId later).
    expect(args.create).toMatchObject({
      archivedAt: null,
      titleNormalized: normalizeJobTitle('Engineer'),
      companyNameNormalized: normalizeCompanyName('Acme, Inc.'),
    });
  });
});
