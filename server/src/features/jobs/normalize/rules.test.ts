// @vitest-environment node
// Table tests for the smaller normalizer rules: work model, ATS host, agency,
// source line, dedupe key, dates and company facts.
import { describe, expect, it } from 'vitest';
import { agencyFromCompanyName, resolveIsAgency } from './agency.js';
import { atsTypeFromUrl, atsTypeFromUrls, isJobBoardHost } from './ats.js';
import { buildCompanyUpsert, employerDomain, registrableDomain, sizeBandFromCount, sizeBandFromText } from './company.js';
import {
  AGE_EXPIRY_BOARDS,
  AGE_EXPIRY_PROVIDERS,
  AGGREGATOR_BOARD_LINK_DAYS,
  DEFAULT_EXPIRY_DAYS,
  NO_DATE_EXPIRY_PROVIDERS,
  buildSearchText,
  deadlineInstant,
  dedupeKey,
  dedupePlace,
  naiveOffsetMinutesFor,
  resolveExpiresAt,
  resolvePostedAt,
  toDate,
} from './identity.js';
import { NO_APPLICANT_COUNT_PROVIDERS, PROVIDER_META, applicantCountAllowed, isLinkedInAssetHost, isLinkedInBranded, isLinkedInHost, sourceFields } from './source.js';
import type { NormalizeProvider } from './types.js';
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
    expect(sourceFields({ provider: 'ats_public', sourceBoard: 'Lever', applyUrl: 'https://jobs.lever.co/a/1' })).toMatchObject({ sourceBoard: 'lever', sourceName: 'Lever', originalSourceName: null, sourcePriority: 5 });
    expect(sourceFields({ provider: 'bank_gohire', applyUrl: 'https://www.gohire.top/jobs/1' })).toMatchObject({ sourceName: 'GoHire', sourceBoard: 'gohire', fromRecruiterBank: true, sourcePriority: 3 });
    expect(sourceFields({ provider: 'bank_robohire', applyUrl: 'https://www.robohire.io/jobs/1' })).toMatchObject({ sourceName: 'RoboHire', sourceBoard: 'robohire', fromRecruiterBank: true, sourcePriority: 15 });
    expect(sourceFields({ provider: 'user_import' })).toMatchObject({ sourceName: null, sourceUrl: null, originalHost: null, sourcePriority: 90 });
  });

  it('never allows applicant counts from linkedin or jsearch', () => {
    // MKT-1C: the government open-data sources publish no count either (PROVIDER_META.applicantCountAllowed).
    expect(NO_APPLICANT_COUNT_PROVIDERS).toEqual(['linkedin', 'jsearch', 'tw_open_data', 'tw_gov_jobs', 'usajobs']);
    expect(applicantCountAllowed('linkedin')).toBe(false);
    expect(applicantCountAllowed('jsearch')).toBe(false);
    expect(applicantCountAllowed('activejobs')).toBe(true);
    expect(isLinkedInBranded('領英')).toBe(true);
    expect(isLinkedInBranded('Linked-In')).toBe(true);
    expect(isLinkedInBranded(null)).toBe(false);
  });

  it('JI-5 / JC-7: orders providers for dedupe (GoHire bank 3 > employer board 5 > … > aggregator)', () => {
    const order = (Object.keys(PROVIDER_META) as NormalizeProvider[]).map((p) => [p, PROVIDER_META[p].sourcePriority] as const).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    expect(order).toEqual([
      ['bank_gohire', 3],
      ['ats_public', 5],
      ['usajobs', 8],
      ['activejobs', 10],
      ['activejobs_feed', 10],
      ['tw_gov_jobs', 12],
      ['tw_open_data', 12],
      ['bank_robohire', 15],
      ['linkedin', 20],
      ['jsearch', 30],
      ['user_import', 90],
    ]);
    // The employer's own listing no longer ties with the aggregator that copied it.
    expect(PROVIDER_META.ats_public.sourcePriority).toBeLessThan(PROVIDER_META.activejobs.sourcePriority);
    // Mainland order: GoHire bank, then the employer's board, then any aggregator.
    expect(PROVIDER_META.bank_gohire.sourcePriority).toBeLessThan(PROVIDER_META.ats_public.sourcePriority);
    // The four new job-board systems have display names for the source line.
    for (const [board, name] of [['recruitee', 'Recruitee'], ['personio', 'Personio'], ['teamtailor', 'Teamtailor'], ['bamboohr', 'BambooHR']] as const) {
      expect(sourceFields({ provider: 'activejobs', sourcePublisher: board }).originalSourceName).toBe(name);
    }
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

  it('JI-5 K3: the employer domain replaces the company name in the key; without one the key is the name key, byte for byte', () => {
    const place = { cityId: 'us-austin' };
    const byName = dedupeKey('stripe', 'backend engineer', place);
    // The value the name key has always had: sha1("stripe|backend engineer|us-austin"), computed outside this code.
    expect(byName).toBe('aa333d1753d8d54db04adf7f24be5fb61addfe4e');
    expect(dedupeKey('stripe', 'backend engineer', place, null)).toBe(byName);
    expect(dedupeKey('stripe', 'backend engineer', place, undefined)).toBe(byName);
    expect(dedupeKey('stripe', 'backend engineer', place, '')).toBe(byName);
    const byDomain = dedupeKey('stripe', 'backend engineer', place, 'stripe.com');
    expect(byDomain).toMatch(/^[0-9a-f]{40}$/);
    expect(byDomain).not.toBe(byName);
    // "Stripe" and "Stripe, Inc." agree once both resolve to stripe.com, whatever the name normalizer makes of them.
    expect(dedupeKey('stripe inc', 'backend engineer', place, 'stripe.com')).toBe(byDomain);
    // Two companies called "Summit" with different domains do not.
    expect(dedupeKey('summit', 'analyst', place, 'summit-health.example')).not.toBe(dedupeKey('summit', 'analyst', place, 'summit-partners.example'));
    // A company whose NAME is a domain never collides with the domain key of that domain.
    expect(dedupeKey('stripe.com', 'backend engineer', place)).not.toBe(byDomain);
    // Title and place still count.
    expect(dedupeKey('stripe', 'frontend engineer', place, 'stripe.com')).not.toBe(byDomain);
    expect(dedupeKey('stripe', 'backend engineer', { cityId: 'us-seattle' }, 'stripe.com')).not.toBe(byDomain);
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

  it.each([
    // A string with no zone is a wall-clock time: UTC by default (as it always was) …
    ['2026-10-11T09:00:00', 0, '2026-10-11T09:00:00.000Z'],
    ['2026-10-11 09:00:00', 0, '2026-10-11T09:00:00.000Z'],
    ['2026/10/11 09:00', 0, '2026-10-11T09:00:00.000Z'],
    ['2026-10-11T09:00:00.123456', 0, '2026-10-11T09:00:00.123Z'],
    ['2026-10-11', 0, '2026-10-11T00:00:00.000Z'],
    // … and UTC+8 for a mainland source: 09:00 there is 01:00 UTC.
    ['2026-10-11T09:00:00', 480, '2026-10-11T01:00:00.000Z'],
    ['2026-10-11 09:00:00', 480, '2026-10-11T01:00:00.000Z'],
    ['2026/10/11 00:30', 480, '2026-10-10T16:30:00.000Z'],
    ['2026-10-11', 480, '2026-10-10T16:00:00.000Z'],
    ['2026/1/5', 480, '2026-01-04T16:00:00.000Z'],
    // A string that names its zone is an instant: never shifted.
    ['2026-10-11T09:00:00Z', 480, '2026-10-11T09:00:00.000Z'],
    ['2026-10-11T09:00:00+08:00', 480, '2026-10-11T01:00:00.000Z'],
    ['2026-10-11T09:00:00.000-05:00', 480, '2026-10-11T14:00:00.000Z'],
  ])('toDate(%s, %i) is %s', (value, offset, iso) => {
    expect(toDate(value, offset)?.toISOString()).toBe(iso);
  });

  it('a Date or an epoch is an instant and is never shifted; an impossible wall-clock time is no date', () => {
    const instant = new Date('2026-10-11T09:00:00Z');
    expect(toDate(instant, 480)).toBe(instant);
    expect(toDate(instant.getTime(), 480)?.toISOString()).toBe('2026-10-11T09:00:00.000Z');
    expect(toDate('2026-13-40T09:00:00', 480)).toBeNull();
    expect(toDate('2026-10-11T25:00:00', 480)).toBeNull();
    expect(toDate('2026-13-40', 480)).toBeNull();
  });

  it('zone-less times are UTC+8 for every mainland row and for the two Taiwan government sources, UTC otherwise', () => {
    for (const provider of Object.keys(PROVIDER_META) as NormalizeProvider[]) expect(naiveOffsetMinutesFor(provider, 'cn')).toBe(480);
    expect(naiveOffsetMinutesFor('tw_open_data', 'intl')).toBe(480);
    expect(naiveOffsetMinutesFor('tw_gov_jobs', 'intl')).toBe(480);
    for (const provider of ['activejobs', 'activejobs_feed', 'jsearch', 'linkedin', 'ats_public', 'bank_robohire', 'bank_gohire', 'usajobs', 'user_import'] as const) {
      expect(naiveOffsetMinutesFor(provider, 'intl')).toBe(0);
    }
    // The mainland "no date" placeholder stays no date: year 1 is before 2000.
    expect(resolvePostedAt('0001-01-01T00:00:00', { now, fetchedAt: '2026-10-09T00:00:00Z', naiveOffsetMinutes: 480 })).toEqual({ postedAt: new Date('2026-10-09T00:00:00Z'), estimated: true });
    expect(resolvePostedAt('1999-12-31 23:59:59', { now, naiveOffsetMinutes: 480 }).estimated).toBe(true);
    expect(resolvePostedAt('2026-10-09 09:00:00', { now, naiveOffsetMinutes: 480 })).toEqual({ postedAt: new Date('2026-10-09T01:00:00Z'), estimated: false });
    expect(resolveExpiresAt('bank_gohire', '0001-01-01T00:00:00', null, { naiveOffsetMinutes: 480 })).toBeNull();
  });

  it('a deadline given as a calendar day runs through that day; a deadline with a time is that instant', () => {
    expect(deadlineInstant('2026-11-15')?.toISOString()).toBe('2026-11-15T23:59:59.999Z');
    expect(deadlineInstant('2026/11/15')?.toISOString()).toBe('2026-11-15T23:59:59.999Z');
    // The day ends when it ends where the source is.
    expect(deadlineInstant('2026-11-15', 480)?.toISOString()).toBe('2026-11-15T15:59:59.999Z');
    expect(deadlineInstant('2026-11-15T12:00:00')?.toISOString()).toBe('2026-11-15T12:00:00.000Z');
    expect(deadlineInstant('2026-11-15T12:00:00', 480)?.toISOString()).toBe('2026-11-15T04:00:00.000Z');
    expect(deadlineInstant('2026-11-15T12:00:00Z', 480)?.toISOString()).toBe('2026-11-15T12:00:00.000Z');
    const instant = new Date('2026-11-15T00:00:00Z');
    expect(deadlineInstant(instant)).toBe(instant);
    expect(deadlineInstant(null)).toBeNull();
    expect(deadlineInstant('garbage')).toBeNull();
  });

  describe('expiry (JI-10, M-22): a stated deadline for every source; a life by posting age for aggregators only', () => {
    const posted = new Date('2026-10-01T00:00:00Z');
    const plus = (days: number) => new Date(posted.getTime() + days * 86_400_000);
    const ALL = Object.keys(PROVIDER_META) as NormalizeProvider[];

    it('the aggregators are the only providers with an age rule, and the two lists cover every provider once', () => {
      expect([...AGE_EXPIRY_PROVIDERS]).toEqual(['activejobs', 'activejobs_feed', 'linkedin', 'jsearch']);
      expect([...AGE_EXPIRY_BOARDS]).toEqual(['activejobs', 'linkedin', 'jsearch']);
      expect([...NO_DATE_EXPIRY_PROVIDERS].sort()).toEqual(['ats_public', 'bank_gohire', 'bank_robohire', 'tw_gov_jobs', 'tw_open_data', 'usajobs', 'user_import']);
      expect([...AGE_EXPIRY_PROVIDERS, ...NO_DATE_EXPIRY_PROVIDERS].sort()).toEqual([...ALL].sort());
      expect(DEFAULT_EXPIRY_DAYS).toBe(45);
      expect(AGGREGATOR_BOARD_LINK_DAYS).toBe(21);
    });

    it.each([
      ['activejobs', 45],
      ['activejobs_feed', 45],
      ['linkedin', 45],
      ['jsearch', 45],
      ['ats_public', null],
      ['bank_robohire', null],
      ['bank_gohire', null],
      ['tw_open_data', null],
      ['tw_gov_jobs', null],
      ['usajobs', null],
      ['user_import', null],
    ] as Array<[NormalizeProvider, number | null]>)('%s with no stated deadline: %s days after posting', (provider, days) => {
      const got = resolveExpiresAt(provider, null, posted);
      if (days === null) expect(got).toBeNull();
      else expect(got).toEqual(plus(days));
      // Without a posting date there is nothing to count from.
      expect(resolveExpiresAt(provider, null, null)).toBeNull();
      // An unreadable or placeholder deadline is no deadline.
      expect(resolveExpiresAt(provider, 'garbage', posted)).toEqual(got);
      expect(resolveExpiresAt(provider, '1970-01-01', posted)).toEqual(got);
      expect(resolveExpiresAt(provider, '0001-01-01T00:00:00', posted)).toEqual(got);
    });

    it.each(ALL.filter((p) => p !== 'user_import'))('%s keeps the deadline its source states', (provider) => {
      // Greenhouse application_deadline, 台灣就業通 STOP_DATE, USAJOBS ApplicationCloseDate, a bank job's validity, an aggregator's validThrough.
      expect(resolveExpiresAt(provider, '2026-12-01T12:00:00Z', posted)?.toISOString()).toBe('2026-12-01T12:00:00.000Z');
      expect(resolveExpiresAt(provider, '2026-12-01', posted)?.toISOString()).toBe('2026-12-01T23:59:59.999Z');
      expect(resolveExpiresAt(provider, new Date('2026-12-01T00:00:00Z'), posted)?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      // Also when the posting itself is very old: the deadline decides, not the age.
      expect(resolveExpiresAt(provider, '2026-12-01', new Date('2025-01-01T00:00:00Z'))?.toISOString()).toBe('2026-12-01T23:59:59.999Z');
      // A deadline in the source's own zone.
      expect(resolveExpiresAt(provider, '2026-12-01', posted, { naiveOffsetMinutes: 480 })?.toISOString()).toBe('2026-12-01T15:59:59.999Z');
    });

    it("a user's own import never expires, whatever it states", () => {
      expect(resolveExpiresAt('user_import', '2026-12-01', posted)).toBeNull();
      expect(resolveExpiresAt('user_import', null, posted)).toBeNull();
    });

    it('JI-6: a JSearch row whose link is a job board lives 21 days; an employer or ATS link keeps 45; a stated deadline wins over both', () => {
      expect(resolveExpiresAt('jsearch', null, posted, { boardLink: true })).toEqual(plus(21));
      expect(resolveExpiresAt('jsearch', null, posted, { boardLink: false })).toEqual(plus(45));
      expect(resolveExpiresAt('jsearch', null, posted)).toEqual(plus(45));
      expect(resolveExpiresAt('jsearch', '2026-12-01T00:00:00Z', posted, { boardLink: true })?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      // The 21-day rule is JSearch's: its payload carries no closure signal. The licensed feed has its expired feed.
      for (const provider of ['activejobs', 'activejobs_feed', 'linkedin'] as const) expect(resolveExpiresAt(provider, null, posted, { boardLink: true })).toEqual(plus(45));
      // A board link never gives an employer-board or bank row a life by age.
      for (const provider of ['ats_public', 'bank_gohire', 'bank_robohire', 'tw_open_data', 'usajobs'] as const) expect(resolveExpiresAt(provider, null, posted, { boardLink: true })).toBeNull();
    });
  });
});

describe('the employer\'s registrable domain (JI-5 K3)', () => {
  it.each([
    ['https://careers.stripe.com/jobs/1', 'stripe.com'],
    ['jobs.foo.co.uk', 'foo.co.uk'],
    ['acme.github.io', null],
    // Lower case, www and career sub-domains removed.
    ['Stripe.COM', 'stripe.com'],
    ['https://www.stripe.com/', 'stripe.com'],
    ['http://WWW.Careers.Stripe.com:8443/jobs?x=1#y', 'stripe.com'],
    ['stripe.com/jobs/search?gh_jid=1', 'stripe.com'],
    ['stripe.com.', 'stripe.com'],
    ['careers.acme.example', 'acme.example'],
    ['jobs.acme.example', 'acme.example'],
    ['job.acme.example', 'acme.example'],
    ['work.acme.example', 'acme.example'],
    ['boards.acme.example', 'acme.example'],
    ['apply.acme.example', 'acme.example'],
    ['recruiting.acme.example', 'acme.example'],
    ['www.careers.acme.example', 'acme.example'],
    // The last two labels otherwise: any other sub-domain is dropped too.
    ['eng.blog.acme.example', 'acme.example'],
    ['talent.acme.example', 'acme.example'],
    // A careers label that IS the name is kept.
    ['jobs.com', 'jobs.com'],
    ['work.co', 'work.co'],
    // Under a country code, a category at the second level is part of the suffix: three labels.
    ['www.acme.co.uk', 'acme.co.uk'],
    ['careers.acme.com.au', 'acme.com.au'],
    ['acme.com.sg', 'acme.com.sg'],
    ['hr.acme.com.tw', 'acme.com.tw'],
    ['acme.co.jp', 'acme.co.jp'],
    ['zhaopin.acme.com.cn', 'acme.com.cn'],
    ['acme.com.hk', 'acme.com.hk'],
    ['acme.co.nz', 'acme.co.nz'],
    ['acme.com.br', 'acme.com.br'],
    ['acme.co.in', 'acme.co.in'],
    ['acme.co.kr', 'acme.co.kr'],
    // The rule is general (review finding 1): every category label under every country code, never only a list of eleven.
    ['ucl.ac.uk', 'ucl.ac.uk'],
    ['www.kcl.ac.uk', 'kcl.ac.uk'],
    ['https://www.guysandstthomas.nhs.uk/careers', 'guysandstthomas.nhs.uk'],
    ['jobs.bartshealth.nhs.uk', 'bartshealth.nhs.uk'],
    ['jobs.acme.org.uk', 'acme.org.uk'],
    ['acme.gov.uk', 'acme.gov.uk'],
    ['www.ntu.edu.tw', 'ntu.edu.tw'],
    ['hr.nccu.edu.tw', 'nccu.edu.tw'],
    ['acme.org.tw', 'acme.org.tw'],
    ['careers.acme.edu.au', 'acme.edu.au'],
    ['foo.com.mx', 'foo.com.mx'],
    ['acme.co.za', 'acme.co.za'],
    ['acme.gob.mx', 'acme.gob.mx'],
    ['acme.or.jp', 'acme.or.jp'],
    ['acme.go.kr', 'acme.go.kr'],
    ['acme.gouv.fr', 'acme.gouv.fr'],
    ['cra-arc.gc.ca', 'cra-arc.gc.ca'],
    ['acme.police.uk', 'acme.police.uk'],
    // A category label counts only under a two-letter country code, and only at the second level.
    ['careers.go.com', 'go.com'],
    ['www.org.example', 'org.example'],
    ['t.co', 't.co'],
    ['acme.de', 'acme.de'],
    // Namespaces one level down: UK schools, US states (and k12 / cc / lib under them), mainland provinces.
    ['www.stmarys.kent.sch.uk', 'stmarys.kent.sch.uk'],
    ['kent.sch.uk', null],
    ['www.ci.austin.tx.us', 'austin.tx.us'],
    ['www.lausd.k12.ca.us', 'lausd.k12.ca.us'],
    ['k12.ca.us', null],
    ['zoom.us', 'zoom.us'],
    ['hr.acme.sh.cn', 'acme.sh.cn'],
    ['acme.cn', 'acme.cn'],
    // The bare suffix names nobody.
    ['co.uk', null],
    ['com.cn', null],
    ['gov.uk', null],
    ['ac.uk', null],
    ['nhs.uk', null],
    ['com.mx', null],
    ['edu.tw', null],
    ['gov.sg', null],
    ['ca.us', null],
    ['sh.cn', null],
    // A careers label standing directly on such a suffix is a sector's shared portal, not one employer.
    ['www.gov.uk', null],
    ['https://www.jobs.nhs.uk/candidate', null],
    ['careers.nhs.uk', null],
    ['jobs.ac.uk', null],
    ['careers.gov.sg', null],
    ['jobs.gov.sg', null],
    ['careers.co.uk', null],
    ['beta.jobs.nhs.uk', null],
    // Shared hosting and profile hosts: the last two labels name the platform, not the employer.
    ['acme.notion.site', null],
    ['acme.wixsite.com', null],
    ['acme.webflow.io', null],
    ['github.io', null],
    ['https://acme.vercel.app/careers', null],
    ['https://www.facebook.com/acme', null],
    ['https://www.linkedin.com/company/acme', null],
    ['https://mp.weixin.qq.com/s/abc', null],
    // Not a registrable host.
    ['192.168.1.10', null],
    ['https://10.0.0.1/jobs', null],
    ['[2001:db8::1]', null],
    ['localhost', null],
    ['intranet', null],
    ['acme..example', null],
    ['-acme.example', null],
    ['acme.123', null],
    ['ftp://acme.example/jobs', null],
    ['mailto:jobs@acme.example', null],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
  ])('registrableDomain(%s) is %s', (input, expected) => {
    expect(registrableDomain(input as string | null | undefined)).toBe(expected);
  });

  it.each([
    ['https://careers.stripe.com/jobs/1', 'stripe.com'],
    ['stripe.com', 'stripe.com'],
    ['https://www.acme.co.uk/about', 'acme.co.uk'],
    ['https://www.ucl.ac.uk/work-at-ucl', 'ucl.ac.uk'],
    // A bare suffix or a sector portal is nobody's own domain.
    ['https://www.gov.uk/', null],
    ['nhs.uk', null],
    ['https://www.jobs.nhs.uk/', null],
    // A job board, an aggregator or an ATS host never names the employer.
    ['https://boards.greenhouse.io/acme', null],
    ['https://jobs.lever.co/acme', null],
    ['https://acme.wd5.myworkdayjobs.com/External', null],
    ['https://acme.recruitee.com', null],
    ['https://acme.jobs.personio.de', null],
    ['https://acme.zhiye.com', null],
    ['https://www.linkedin.com/company/acme', null],
    ['https://uk.indeed.com/cmp/acme', null],
    ['https://www.104.com.tw/company/abc', null],
    ['https://www.zhipin.com/gongsi/abc.html', null],
    ['https://www.gohire.top/company/1', null],
    // Everything registrableDomain refuses.
    ['acme.github.io', null],
    ['192.168.1.10', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('employerDomain(%s) is %s', (input, expected) => {
    expect(employerDomain(input as string | null | undefined)).toBe(expected);
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
