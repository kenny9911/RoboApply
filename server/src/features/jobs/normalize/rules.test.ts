// @vitest-environment node
// Table tests for the smaller normalizer rules: work model, ATS host, agency,
// source line, dedupe key, dates and company facts.
import { describe, expect, it } from 'vitest';
import { agencyFromCompanyName, resolveIsAgency } from './agency.js';
import { atsTypeFromUrl, atsTypeFromUrls, isJobBoardHost } from './ats.js';
import { buildCompanyUpsert, sizeBandFromCount, sizeBandFromText } from './company.js';
import { buildSearchText, dedupeKey, dedupePlace, resolveExpiresAt, resolvePostedAt, toDate } from './identity.js';
import { NO_APPLICANT_COUNT_PROVIDERS, PROVIDER_META, applicantCountAllowed, isLinkedInAssetHost, isLinkedInBranded, isLinkedInHost, sourceFields } from './source.js';
import { resolveWorkModel, workModelFromDescription, workModelFromProvider, workModelFromTitle } from './workModel.js';

describe('work model', () => {
  it.each([
    ['Remote Solely', 'remote'],
    ['Remote OK', 'remote'],
    ['TELECOMMUTE', 'remote'],
    ['Hybrid', 'hybrid'],
    ['On-site', 'onsite'],
    ['onsite', 'onsite'],
    ['远程', 'remote'],
    ['混合办公', 'hybrid'],
    ['unknown', null],
    ['Flexible', null],
    ['', null],
    [null, null],
  ])('provider %s → %s', (label, expected) => {
    expect(workModelFromProvider(label as string | null)).toBe(expected);
  });

  it.each([
    ['This is a fully remote role.', 'remote'],
    ['The position is remote.', 'remote'],
    ['We are a remote-first company.', null],
    ['Join our fully remote team in Europe.', null],
    ['This is a fully remote position.', 'remote'],
    ['You will be in the office 5 days a week.', null],
    ['We work 5 days a week in the office.', 'onsite'],
    ['Expect 2 days per week at the office.', 'hybrid'],
    ['This role is not remote.', null],
    ['Our hybrid working model means 3 days a week in the office.', 'hybrid'],
    ['You will work 3 days per week in the office.', 'hybrid'],
    ['This is an on-site role in Austin.', 'onsite'],
    ['The role is 100% on-site.', 'onsite'],
    ['每週進辦公室三天', 'hybrid'],
    ['本岗位为全远程', 'remote'],
    ['不支持远程办公', 'onsite'],
    ['We have an on-site gym and remote collaboration tools.', null],
    ['This is a fully remote role. Our hybrid working model also applies.', null],
    ['', null],
  ])('description %s → %s', (text, expected) => {
    expect(workModelFromDescription(text)).toBe(expected);
  });

  it('trusts the first level that states one; disagreement at a level is unknown', () => {
    expect(resolveWorkModel({ provider: 'Hybrid', description: 'This is a fully remote role.' })).toEqual({ value: 'hybrid', source: 'provider' });
    expect(resolveWorkModel({ legacyWorkType: 'remote' })).toEqual({ value: 'remote', source: 'provider' });
    expect(resolveWorkModel({ legacyWorkType: 'onsite' })).toBeNull();
    expect(resolveWorkModel({ provider: 'Hybrid', legacyWorkType: 'remote' })).toBeNull();
    expect(resolveWorkModel({ locationModels: ['remote', null, 'remote'] })).toEqual({ value: 'remote', source: 'location_text' });
    expect(resolveWorkModel({ locationModels: ['remote', 'hybrid'] })).toBeNull();
    expect(resolveWorkModel({ title: 'Engineer (Hybrid)' })).toEqual({ value: 'hybrid', source: 'title' });
    expect(resolveWorkModel({ description: 'The role is 100% on-site.' })).toEqual({ value: 'onsite', source: 'description' });
    expect(resolveWorkModel({ title: 'Engineer', description: 'Great team.' })).toBeNull();
    expect(resolveWorkModel({})).toBeNull();
  });
});

describe('ATS host', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://jobs.lever.co/acme/1', 'lever'],
    ['https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1', 'workday'],
    ['https://jobs.ashbyhq.com/acme/1', 'ashby'],
    ['https://jobs.smartrecruiters.com/Acme/1', 'smartrecruiters'],
    ['https://careers-acme.icims.com/jobs/1', 'icims'],
    ['https://apply.workable.com/acme/j/1', 'workable'],
    ['https://acme.taleo.net/careersection/1', 'taleo'],
    ['https://career5.successfactors.eu/career?company=acme', 'successfactors'],
    ['https://app.mokahr.com/campus-recruitment/acme/1', 'moka'],
    ['https://acme.zhiye.com/campus/jobs/1', 'beisen'],
    ['https://acme.jobs.feishu.cn/campus/position/1', 'feishu'],
    ['https://acme.dayee.com/campus/1', 'dayee'],
    ['https://careers.acme.example/jobs/1', 'other'],
    ['https://www.linkedin.com/jobs/view/1', null],
    ['https://www.104.com.tw/job/abc', null],
    ['https://www.zhipin.com/job_detail/1.html', null],
    ['https://www.gohire.top/jobs/1', null],
    ['ftp://example.com', null],
    [null, null],
  ])('%s → %s', (url, expected) => {
    expect(atsTypeFromUrl(url as string | null)).toBe(expected);
  });

  it('prefers the first URL that names an ATS', () => {
    expect(atsTypeFromUrls('https://www.linkedin.com/jobs/view/1', 'https://jobs.lever.co/a/1')).toBe('lever');
    expect(atsTypeFromUrls('https://careers.acme.example/1', 'https://www.indeed.com/x')).toBe('other');
    expect(atsTypeFromUrls('https://www.indeed.com/x', null)).toBeNull();
    expect(isJobBoardHost('seek.com.au')).toBe(true);
    expect(isJobBoardHost(null)).toBe(false);
  });
});

describe('agency detection', () => {
  it.each([
    ['Robert Half', true],
    ['Robert Half International Inc.', true],
    ['Randstad USA', true],
    ['TEKsystems, Inc.', true],
    ['Hays', true],
    ['Hays Companies', null],
    ['Maple Staffing Group', true],
    ['Bright Recruitment Ltd', true],
    ['Apex Executive Search', true],
    ['万宝盛华企业管理咨询（上海）有限公司', true],
    ['某某猎头有限公司', true],
    ['某某人力资源服务有限公司', true],
    ['某某人力派遣股份有限公司', true],
    ['Acme Analytics', null],
    ['示例科技有限公司', null],
    ['', null],
    [null, null],
  ])('%s → %s', (name, expected) => {
    expect(agencyFromCompanyName(name as string | null)).toBe(expected);
  });

  it('never turns "not on our list" into false', () => {
    expect(resolveIsAgency('Acme', null)).toBeNull();
    expect(resolveIsAgency('Acme', false)).toBe(false);
    expect(resolveIsAgency('Acme', true)).toBe(true);
    expect(resolveIsAgency('Robert Half', false)).toBe(true);
  });
});

describe('source line (H9: no LinkedIn branding)', () => {
  it('names the aggregator and the original publisher and host', () => {
    expect(sourceFields({ provider: 'activejobs', sourcePublisher: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' })).toEqual({
      sourceBoard: 'activejobs',
      sourcePriority: 10,
      sourceName: 'Active Jobs DB',
      originalSourceName: 'Greenhouse',
      originalHost: 'boards.greenhouse.io',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      fromRecruiterBank: false,
    });
  });

  it('drops LinkedIn publishers and URLs and falls back to the employer host', () => {
    const f = sourceFields({
      provider: 'jsearch',
      sourcePublisher: 'LinkedIn',
      sourceUrl: 'https://www.linkedin.com/jobs/view/1',
      applyUrl: 'https://careers.acme.example/jobs/1',
    });
    expect(f).toMatchObject({ sourceName: 'JSearch', originalSourceName: null, originalHost: 'careers.acme.example', sourceUrl: 'https://careers.acme.example/jobs/1' });
    const li = sourceFields({ provider: 'linkedin', sourcePublisher: 'linkedin', sourceUrl: 'https://www.linkedin.com/jobs/view/2', applyUrl: 'https://lnkd.in/abc' });
    expect(li).toMatchObject({ sourceName: 'Fantastic Jobs', originalSourceName: null, originalHost: null, sourceUrl: null });
    // sourceBoard stays the internal key 'linkedin' (never rendered); every display field is clean.
    for (const k of ['sourceName', 'originalSourceName', 'originalHost', 'sourceUrl'] as const) expect(isLinkedInBranded(li[k])).toBe(false);
  });

  it('keeps a job board as host when it is the only source, and names the ATS for public boards and the bank', () => {
    expect(sourceFields({ provider: 'jsearch', sourcePublisher: '104人力銀行', applyUrl: 'https://www.104.com.tw/job/1' })).toMatchObject({ originalSourceName: '104人力銀行', originalHost: '104.com.tw' });
    expect(sourceFields({ provider: 'ats_public', sourceBoard: 'Lever', applyUrl: 'https://jobs.lever.co/a/1' })).toMatchObject({ sourceBoard: 'lever', sourceName: 'Lever', originalSourceName: null, sourcePriority: 10 });
    expect(sourceFields({ provider: 'bank_gohire', applyUrl: 'https://www.gohire.top/jobs/1' })).toMatchObject({ sourceName: 'GoHire', sourceBoard: 'gohire', fromRecruiterBank: true, sourcePriority: 15 });
    expect(sourceFields({ provider: 'user_import' })).toMatchObject({ sourceName: null, sourceUrl: null, originalHost: null, sourcePriority: 90 });
  });

  it('never allows applicant counts from linkedin or jsearch', () => {
    expect(NO_APPLICANT_COUNT_PROVIDERS).toEqual(['linkedin', 'jsearch']);
    expect(applicantCountAllowed('linkedin')).toBe(false);
    expect(applicantCountAllowed('jsearch')).toBe(false);
    expect(applicantCountAllowed('activejobs')).toBe(true);
    expect(isLinkedInBranded('領英')).toBe(true);
    expect(isLinkedInBranded('Linked-In')).toBe(true);
    expect(isLinkedInBranded(null)).toBe(false);
  });

  it('orders providers for dedupe as ARCH §4.2 says', () => {
    expect(['activejobs', 'bank_robohire', 'linkedin', 'jsearch', 'user_import'].map((p) => PROVIDER_META[p as keyof typeof PROVIDER_META].sourcePriority)).toEqual([10, 15, 20, 30, 90]);
  });
});

describe('dedupe key, search text and dates', () => {
  it('hashes company | title | place, with the place falling back from city to remote scope to country', () => {
    expect(dedupePlace({ cityId: 'us-austin', city: 'Austin' })).toBe('us-austin');
    expect(dedupePlace({ city: 'Springfield' })).toBe('springfield');
    expect(dedupePlace({ remoteScope: 'US', country: 'US' })).toBe('remote:us');
    expect(dedupePlace({ country: 'TW' })).toBe('tw');
    expect(dedupePlace({})).toBe('');
    const a = dedupeKey('acme', 'backend engineer', { cityId: 'us-austin' });
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(dedupeKey('acme', 'backend engineer', { cityId: 'us-austin' })).toBe(a);
    expect(dedupeKey('acme', 'backend engineer', { cityId: 'us-seattle' })).not.toBe(a);
  });

  it('builds search text from title, company and up to ten skills, capped at 500 characters', () => {
    expect(buildSearchText('backend engineer', 'acme', ['go', 'sql'])).toBe('backend engineer acme go sql');
    expect(buildSearchText('x'.repeat(600), 'acme', [])).toHaveLength(500);
    expect(buildSearchText('a', 'b', Array.from({ length: 12 }, (_, i) => `s${i}`)).split(' ')).toHaveLength(12);
  });

  const now = new Date('2026-10-10T00:00:00Z');
  it('reads dates and refuses impossible posting dates', () => {
    expect(toDate('2026-10-01T08:00:00')?.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(toDate(0)?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(toDate(new Date('bad'))).toBeNull();
    expect(toDate(Number.NaN)).toBeNull();
    expect(toDate('garbage')).toBeNull();
    expect(toDate('')).toBeNull();
    expect(resolvePostedAt('2026-10-01T00:00:00Z', { now })).toEqual({ postedAt: new Date('2026-10-01T00:00:00Z'), estimated: false });
    expect(resolvePostedAt('2026-10-01T00:00:00Z', { now, estimated: true }).estimated).toBe(true);
    expect(resolvePostedAt(null, { now, fetchedAt: '2026-10-09T00:00:00Z' })).toEqual({ postedAt: new Date('2026-10-09T00:00:00Z'), estimated: true });
    expect(resolvePostedAt('2027-01-01T00:00:00Z', { now })).toEqual({ postedAt: now, estimated: true });
    expect(resolvePostedAt('1999-01-01T00:00:00Z', { now }).estimated).toBe(true);
  });

  it('expires at the provider date, else 45 days after posting; bank and imported jobs never by date', () => {
    const posted = new Date('2026-10-01T00:00:00Z');
    expect(resolveExpiresAt('activejobs', '2026-11-15', posted)?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(resolveExpiresAt('jsearch', null, posted)?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(resolveExpiresAt('jsearch', '1970-01-01', posted)?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(resolveExpiresAt('jsearch', null, null)).toBeNull();
    expect(resolveExpiresAt('bank_gohire', '2026-12-01', posted)).toBeNull();
    expect(resolveExpiresAt('bank_robohire', null, posted)).toBeNull();
    expect(resolveExpiresAt('user_import', null, posted)).toBeNull();
  });
});

describe('company facts (D3: provenance per field)', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const base = { market: 'intl' as const, displayName: 'Acme, Inc.', nameNormalized: 'acme', isAgency: null, bankCompanyRef: null, logoSource: 'provider:activejobs', now };

  it('fills only fields a sourced statement gives, each with a provenance entry', () => {
    const c = buildCompanyUpsert({
      ...base,
      logoUrl: 'https://media.example/acme.png',
      facts: {
        source: 'bank',
        url: 'https://acme.example/about',
        fetchedAt: '2026-10-01T00:00:00Z',
        website: 'https://www.acme.example',
        industries: ['Software', ' ', 'Payments'],
        employeeCount: 420,
        hqLocation: 'Austin, TX',
        foundedYear: 2012,
        description: 'Makes analytics.',
      },
    });
    expect(c).toMatchObject({ website: 'https://www.acme.example/', domain: 'acme.example', industries: ['Software', 'Payments'], employeeCount: 420, sizeBand: '201-500', hqLocation: 'Austin, TX', foundedYear: 2012 });
    expect(Object.keys(c.facts).sort()).toEqual(['description', 'domain', 'employeeCount', 'foundedYear', 'hqLocation', 'industries', 'logoUrl', 'sizeBand', 'website']);
    expect(c.facts.website).toEqual({ source: 'bank', url: 'https://acme.example/about', fetchedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('drops facts without a source and impossible values', () => {
    const c = buildCompanyUpsert({ ...base, logoUrl: 'javascript:x', facts: { source: ' ', website: 'https://acme.example', employeeCount: 10 } });
    expect(c).toMatchObject({ website: null, employeeCount: null, logoUrl: null, facts: {} });
    const d = buildCompanyUpsert({ ...base, logoUrl: 'https://media.example/a.png', facts: { source: 'provider:x', foundedYear: 3000, employeeCount: -1, size: '51-200 employees' } });
    expect(d).toMatchObject({ foundedYear: null, employeeCount: null, sizeBand: '51-200' });
    expect(d.facts.logoUrl).toEqual({ source: 'provider:x', fetchedAt: now.toISOString() });
    const e = buildCompanyUpsert({ ...base, logoUrl: 'https://media.example/a.png', facts: null });
    expect(e.facts).toEqual({ logoUrl: { source: 'provider:activejobs', fetchedAt: now.toISOString() } });
  });

  it.each([
    [5, '1-10'], [50, '11-50'], [200, '51-200'], [500, '201-500'], [1000, '501-1000'], [5000, '1001-5000'], [5001, '5001+'], [0, null], [null, null],
  ])('size band for %s', (count, band) => {
    expect(sizeBandFromCount(count as number | null)).toBe(band);
  });

  it.each([
    ['51-200 employees', '51-200'],
    ['1,001-5,000', '1001-5000'],
    ['10,001+', '5001+'],
    ['10000人以上', '5001+'],
    ['100-1000', null],
    ['500+', null],
    ['big', null],
    [null, null],
  ])('size text %s', (text, band) => {
    expect(sizeBandFromText(text as string | null)).toBe(band);
  });
});

describe('review regressions: titles state a work model only in a segment of their own', () => {
  it.each([
    ['Hybrid Cloud Architect', null],
    ['Remote Sensing Scientist', null],
    ['Remote Patient Monitoring Nurse', null],
    ['Senior Engineer - Remote Sensing', null],
    ['混合云架构师', null],
    ['混合动力系统工程师', null],
    ['远程医疗产品经理', null],
    ['Remote', null],
    ['Designer (Remote/Hybrid)', null],
    ['Engineer (Remote)', 'remote'],
    ['Engineer – Hybrid', 'hybrid'],
    ['Engineer | Remote - US', 'remote'],
    ['Remote - Software Engineer', 'remote'],
    ['Engineer (Remote, US)', 'remote'],
    ['Engineer (Hybrid - Taipei)', 'hybrid'],
    ['Data Engineer, Remote', 'remote'],
    ['Field Engineer (On-site)', 'onsite'],
    ['Java开发工程师（远程）', 'remote'],
    ['前端工程师-可远程', 'remote'],
    ['数据分析师（混合办公）', 'hybrid'],
    ['运维工程师（驻场）', 'onsite'],
    ['Engineer (Hybrid Taipei)', 'hybrid'],
    ['Engineer (Remote Sensing)', null],
  ])('%s → %s', (title, expected) => {
    expect(workModelFromTitle(title)).toBe(expected);
    expect(resolveWorkModel({ title })).toEqual(expected ? { value: expected, source: 'title' } : null);
  });

  it('5 days a week in the office is on-site, not hybrid', () => {
    expect(workModelFromDescription('We work 5 days a week in the office.')).toBe('onsite');
    expect(workModelFromDescription('In-office 5 days per week.')).toBe('onsite');
    expect(workModelFromDescription('Our fully remote team in Europe ships weekly. The role is based in Austin.')).toBeNull();
  });
});

describe('review regressions: job boards are listed by full domain', () => {
  it.each([
    ['https://careers.google.com/jobs/results/1', 'other'],
    ['https://www.google.com/search?q=engineer&ibp=htl;jobs', null],
    ['https://talent.acme.example/jobs/1', 'other'],
    ['https://www.talent.com/view?id=1', null],
    ['https://www.seek.com.au/job/1', null],
    ['https://boss.acme.example/careers/1', 'other'],
    ['https://www.zhipin.com/job_detail/1.html', null],
    ['https://www.cake.me/companies/acme/jobs/1', null],
    ['https://cake.acme.example/careers', 'other'],
    ['https://uk.indeed.com/viewjob?jk=1', null],
    ['https://www.indeed.co.uk/viewjob?jk=1', null],
    ['https://www.glassdoor.de/job/1', null],
    ['https://www.104.com.tw/job/1', null],
    ['https://www.gohire.top/jobs/1', null],
  ])('%s → %s', (url, expected) => {
    expect(atsTypeFromUrl(url)).toBe(expected);
  });

  it('prefers the employer host for originalHost when the other link is a board', () => {
    expect(sourceFields({ provider: 'jsearch', sourceUrl: 'https://www.indeed.com/viewjob?jk=1', applyUrl: 'https://careers.google.com/jobs/1' }).originalHost).toBe('careers.google.com');
  });

  it('knows LinkedIn page and media hosts', () => {
    expect(isLinkedInHost('www.linkedin.com')).toBe(true);
    expect(isLinkedInHost('media.licdn.com')).toBe(false);
    expect(isLinkedInAssetHost('media.licdn.com')).toBe(true);
    expect(isLinkedInAssetHost('licdn.com')).toBe(true);
    expect(isLinkedInAssetHost('logo.clearbit.com')).toBe(false);
    expect(isLinkedInAssetHost(null)).toBe(false);
  });
});

describe('review regressions: estimated posting dates are stable across re-ingest', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  it('an undated job keeps the existing row\'s firstSeenAt, so expiry does not move', () => {
    const first = new Date('2026-09-01T00:00:00Z');
    expect(resolvePostedAt(null, { now, firstSeenAt: first, fetchedAt: now })).toEqual({ postedAt: first, estimated: true });
    expect(resolveExpiresAt('jsearch', null, first)).toEqual(new Date('2026-10-16T00:00:00Z'));
    // A fetch time earlier than firstSeenAt wins; a firstSeenAt in the future is ignored.
    expect(resolvePostedAt(null, { now, firstSeenAt: '2026-09-05T00:00:00Z', fetchedAt: '2026-09-02T00:00:00Z' }).postedAt).toEqual(new Date('2026-09-02T00:00:00Z'));
    expect(resolvePostedAt(null, { now, firstSeenAt: '2027-01-01T00:00:00Z' }).postedAt).toEqual(now);
    // A stated date is never replaced.
    expect(resolvePostedAt('2026-10-01', { now, firstSeenAt: first })).toEqual({ postedAt: new Date('2026-10-01T00:00:00Z'), estimated: false });
  });
});
