// @vitest-environment node
// WP-32: FeedItem shape and the honesty rules for badges, pay, source and dates (D3).

import { describe, expect, it } from 'vitest';
import { badgesFor, needsSponsorshipFor, publicItem, toFeedItem } from './items.js';
import { feedRow } from './testkit.js';

const needs = { needsSponsorship: true, workAuth: [] };
const noNeed = { needsSponsorship: false, workAuth: [] };

describe('FeedItem', () => {
  it('carries salaryPeriod, employmentType, workModel, fit{tier,score,kind,topGap,topOverlap}, lastSeenAt', () => {
    const fit = { tier: 'good' as const, score: 72, kind: 'pre' as const, topGap: 'Go', topOverlap: 'Python' };
    const item = toFeedItem(
      feedRow({ id: 'j1', salaryDisclosed: true, salaryMin: 40, salaryMax: 55, salaryCurrency: 'USD', salaryPeriod: 'hour', employmentType: 'contract', workModel: 'hybrid' }),
      { user: null, fit, tracker: { status: 'bookmarked' }, position: 3 },
    );
    expect(item).toMatchObject({
      jobId: 'j1',
      pay: { min: 40, max: 55, currency: 'USD', period: 'hour', text: null },
      employmentType: 'contract',
      workModel: 'hybrid',
      fit,
      tracker: { status: 'bookmarked' },
      position: 3,
      lastSeenAt: '2026-10-10T06:00:00.000Z',
    });
  });

  it('pay is null ("Pay not listed") when undisclosed — never 0; 面議 text alone does not count as disclosed', () => {
    expect(publicItem(feedRow({ id: 'a', salaryDisclosed: false, salaryMin: 40000, salaryText: '面議' })).pay).toBeNull();
    expect(publicItem(feedRow({ id: 'b', salaryDisclosed: true, salaryMin: null, salaryMax: null, salaryText: null })).pay).toBeNull();
  });

  it('FIX-3: a stored figure that cannot be pay is not shown as a number ("$60,000,000–$90,000,000 an hour")', () => {
    const typo = feedRow({ id: 'typo', salaryDisclosed: true, salaryMin: 60_000_000, salaryMax: 90_000_000, salaryCurrency: 'USD', salaryPeriod: 'hour', salaryText: '$60,000K-$90,000K' });
    expect(publicItem(typo).pay).toBeNull();
    // Real pay is untouched, in every period.
    expect(publicItem(feedRow({ id: 'ok', salaryDisclosed: true, salaryMin: 60_000, salaryMax: 90_000, salaryCurrency: 'USD', salaryPeriod: 'year' })).pay).toMatchObject({ min: 60_000, max: 90_000, period: 'year' });
    expect(publicItem(feedRow({ id: 'hr', salaryDisclosed: true, salaryMin: 40, salaryMax: 55, salaryCurrency: 'USD', salaryPeriod: 'hour' })).pay).toMatchObject({ min: 40, max: 55, period: 'hour' });
    // Words with no amount are not pay text; words with one are.
    expect(publicItem(feedRow({ id: 'w', salaryDisclosed: true, salaryMin: null, salaryMax: null, salaryText: 'Competitive Pay and Benefits' })).pay).toBeNull();
    expect(publicItem(feedRow({ id: 'x', salaryDisclosed: true, salaryMin: null, salaryMax: null, salaryText: '18-28K·15薪' })).pay).toMatchObject({ text: '18-28K·15薪' });
  });

  it('GoApply: N薪 and the 届别 / 网申 close date only as the posting states them', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const item = publicItem(
      feedRow({
        id: 'c',
        market: 'cn',
        salaryMonths: 14,
        expiresAt: new Date('2026-11-01T00:00:00Z'),
        marketTags: [
          { tag: 'class_year:2027', evidenceQuote: '面向2027届' },
          { tag: 'apply_closes:2026-10-31', evidenceQuote: '网申截止时间：2026年10月31日' },
          { tag: 'apply_closes:2026-12-01' },
        ],
      }),
      null,
      now,
    );
    expect(item.payMonths).toBe(14);
    expect(item.campus).toEqual({ applyClosesAt: '2026-10-31', applyClosesQuote: '网申截止时间：2026年10月31日', classYears: [2027] });
    // RAJob.expiresAt (often postedAt + 45 days) is never shown as a deadline.
    const estimated = publicItem(feedRow({ id: 'e', market: 'cn', expiresAt: new Date('2026-11-01T00:00:00Z'), marketTags: [{ tag: 'class_year:2027', evidenceQuote: '2027届' }] }), null, now);
    expect(estimated.campus).toEqual({ applyClosesAt: null, applyClosesQuote: null, classYears: [2027] });
    // A close date without a quote does not count; a stated date alone opens the campus block.
    expect(publicItem(feedRow({ id: 'f', market: 'cn', marketTags: [{ tag: 'apply_closes:2026-10-31' }] }), null, now).campus).toBeNull();
    expect(publicItem(feedRow({ id: 'g', market: 'cn', marketTags: [{ tag: 'apply_closes:2026-10-31', evidenceQuote: '10月31日截止' }] }), null, now).campus).toEqual({
      applyClosesAt: '2026-10-31',
      applyClosesQuote: '10月31日截止',
      classYears: [],
    });
    expect(publicItem(feedRow({ id: 'd' })).campus).toBeNull();
  });

  it('source kind and name from real fields', () => {
    expect(publicItem(feedRow({ id: 'e', fromRecruiterBank: true, sourceBoard: 'robohire', sourceName: 'RoboHire' })).source).toMatchObject({ name: 'RoboHire', kind: 'bank' });
    expect(publicItem(feedRow({ id: 'f', sourceBoard: 'user_import', visibility: 'private', sourceName: null })).source).toMatchObject({ name: 'user_import', kind: 'user_import' });
    expect(publicItem(feedRow({ id: 'g', sourceBoard: 'greenhouse', sourceName: 'Greenhouse' })).source.kind).toBe('ats_public');
  });

  it('company size only with a provenance entry', () => {
    expect(publicItem(feedRow({ id: 'h', companySizeBand: '51-200', companyFacts: {} })).company.sizeBand).toBeNull();
    expect(
      publicItem(feedRow({ id: 'i', companySizeBand: '51-200', companyFacts: { sizeBand: { source: 'provider:linkedin', fetchedAt: '2026-10-01T00:00:00Z' } } })).company.sizeBand,
    ).toEqual({ value: '51-200', source: 'provider:linkedin', asOf: '2026-10-01T00:00:00Z' });
  });
});

// ── Source and apply contract (GOAPPLY_PARITY_PLAN §5; MARKET_STRATEGY §1.4, M-7, JC-1) ──

describe('every card names its source and carries its own apply link', () => {
  const SEEN = new Date('2026-10-10T06:00:00.000Z');
  /** A posting read from a public employer board, located in mainland China. */
  const board = (over: Partial<Parameters<typeof feedRow>[0]> = {}) =>
    feedRow({
      id: 'b1',
      market: 'cn',
      sourceBoard: 'smartrecruiters',
      sourceName: '示例汽车 · SmartRecruiters',
      originalSourceName: null,
      companyName: '示例汽车（中国）投资有限公司',
      applyUrl: 'https://jobs.smartrecruiters.com/ExampleAuto/123-apply',
      sourceUrl: 'https://jobs.smartrecruiters.com/ExampleAuto/123',
      lastSeenAt: SEEN,
      ...over,
    });
  /** A GoHire bank row, which exists as a listed row only with its public GoHire page. */
  const bank = (over: Partial<Parameters<typeof feedRow>[0]> = {}) =>
    feedRow({
      id: 'g1',
      market: 'cn',
      sourceBoard: 'gohire',
      sourceName: 'GoHire',
      fromRecruiterBank: true,
      applyUrl: 'https://jobs.gohire.example/p/g1',
      sourceUrl: 'https://jobs.gohire.example/p/g1',
      lastSeenAt: SEEN,
      ...over,
    });

  it('a board row: the employer as the original publisher, its original link, a last-verified date, apply.target employer', () => {
    const item = publicItem(board());
    expect(item.source).toEqual({
      name: '示例汽车 · SmartRecruiters',
      kind: 'ats_public',
      original: '示例汽车（中国）投资有限公司',
      url: 'https://jobs.smartrecruiters.com/ExampleAuto/123',
      lastVerifiedAt: SEEN.toISOString(),
      via: 'ats',
    });
    expect(item.apply).toEqual({ url: 'https://jobs.smartrecruiters.com/ExampleAuto/123-apply', target: 'employer' });
    // The company record's display name wins when there is one.
    expect(publicItem(board({ companyDisplayName: '示例汽车' })).source.original).toBe('示例汽车');
    // No separate posting link: the apply link is the original link.
    expect(publicItem(board({ sourceUrl: null })).source.url).toBe('https://jobs.smartrecruiters.com/ExampleAuto/123-apply');
  });

  it('a bank row: apply.target gohire and its GoHire page; a RoboHire bank row is not called GoHire', () => {
    const item = publicItem(bank());
    expect(item.apply).toEqual({ url: 'https://jobs.gohire.example/p/g1', target: 'gohire' });
    expect(item.source).toMatchObject({ name: 'GoHire', kind: 'bank', via: 'bank', original: null, lastVerifiedAt: SEEN.toISOString() });
    // A repost keeps the publisher the bank names.
    expect(publicItem(bank({ originalSourceName: '示例科技' })).source.original).toBe('示例科技');
    const robohire = publicItem(feedRow({ id: 'r1', fromRecruiterBank: true, sourceBoard: 'robohire', sourceName: 'RoboHire' }));
    expect(robohire.apply).toEqual({ url: 'https://jobs.example.com/apply/r1', target: null });
    expect(robohire.source.via).toBe('bank');
  });

  it("a user's own import: via import, and nothing is claimed about where its link leads", () => {
    const own = feedRow({ id: 'o1', market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', sourceName: null, applyUrl: 'https://www.zhipin.example/job/1', sourceUrl: null });
    const item = publicItem(own);
    expect(item.source).toMatchObject({ kind: 'user_import', via: 'import', original: null, url: 'https://www.zhipin.example/job/1' });
    expect(item.apply).toEqual({ url: 'https://www.zhipin.example/job/1', target: null });
    // A pasted description has no link at all: apply is null, never invented.
    const pasted = publicItem({ ...own, applyUrl: '', sourceUrl: null });
    expect(pasted.apply).toBeNull();
    expect(pasted.source.url).toBeNull();
  });

  it('an aggregator row (RoboApply) is none of bank / ats / import: no `via`, no claimed target, never a LinkedIn link', () => {
    const item = publicItem(feedRow({ id: 'p1', sourceBoard: 'jsearch', sourceName: 'JSearch', originalSourceName: 'Acme careers', sourceUrl: 'https://www.linkedin.com/jobs/view/1', applyUrl: 'https://acme.example/apply/1' }));
    expect(item.source).toEqual({ name: 'JSearch', kind: 'provider', original: 'Acme careers', url: null, lastVerifiedAt: '2026-10-10T06:00:00.000Z' });
    expect(item.source).not.toHaveProperty('via');
    expect(item.apply).toEqual({ url: 'https://acme.example/apply/1', target: null });
    // A source board nobody knows is never called an employer board.
    expect(publicItem(feedRow({ id: 'p2', sourceBoard: 'mystery_board' })).source.kind).toBe('provider');
  });

  it('only an http(s) link is an apply link', () => {
    for (const applyUrl of ['', '   ', 'javascript:alert(1)', 'mailto:hr@example.cn', '/jobs/1', 'not a url']) {
      expect(publicItem(board({ applyUrl, sourceUrl: null })).apply, applyUrl).toBeNull();
    }
    expect(publicItem(board({ applyUrl: ' https://careers.example.cn/1 ' })).apply).toEqual({ url: 'https://careers.example.cn/1', target: 'employer' });
  });

  it('salary: null when the posting states no pay (薪资未披露), never 面议 and never 0; as posted otherwise', () => {
    expect(publicItem(board({ salaryDisclosed: false })).salary).toBeNull();
    expect(publicItem(board({ salaryDisclosed: false, salaryText: '面议' })).salary).toBeNull();
    expect(publicItem(board({ salaryDisclosed: true, salaryText: '面议', salaryMin: null, salaryMax: null })).salary).toBeNull();
    expect(publicItem(board({ salaryDisclosed: true, salaryMin: 0, salaryMax: 0, salaryText: null })).salary).toBeNull();
    expect(publicItem(board({ salaryDisclosed: true, salaryMin: 0, salaryMax: 0, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryText: null })).salary).toBeNull();
    // The posting's own words, with the stated N薪.
    expect(publicItem(board({ salaryDisclosed: true, salaryMin: 18_000, salaryMax: 28_000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryMonths: 15, salaryText: '18-28K·15薪' })).salary).toEqual({
      text: '18-28K·15薪',
      min: 18_000,
      max: 28_000,
      currency: 'CNY',
      period: 'month',
      months: 15,
    });
    // Figures only: the mainland notation of the stated figures.
    expect(publicItem(board({ salaryDisclosed: true, salaryMin: 15_000, salaryMax: 25_000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryText: null })).salary).toMatchObject({ text: '15-25K', min: 15_000, max: 25_000 });
    // RoboApply: the same field, agreeing with `pay`.
    // Stated pay the mainland notation has no line for (another currency, a weekly rate) is still stated pay:
    // `salary` carries the figures, so the card never prints 薪资未披露 over a posting that states pay (D3).
    const usd = publicItem(board({ salaryDisclosed: true, salaryMin: 8_000, salaryMax: 12_000, salaryCurrency: 'USD', salaryPeriod: 'month', salaryText: null }));
    expect(usd.pay).toMatchObject({ min: 8_000, max: 12_000, currency: 'USD' });
    expect(usd.salary).toEqual({ text: null, min: 8_000, max: 12_000, currency: 'USD', period: 'month', months: null });
    const hkd = publicItem(board({ salaryDisclosed: true, salaryMin: 30_000, salaryMax: null, salaryCurrency: 'HKD', salaryPeriod: 'month', salaryText: null }));
    expect(hkd.salary).toMatchObject({ min: 30_000, max: null, currency: 'HKD', period: 'month' });
    const weekly = publicItem(board({ salaryDisclosed: true, salaryMin: 2_000, salaryMax: 3_000, salaryCurrency: 'CNY', salaryPeriod: 'week', salaryText: null }));
    expect(weekly.salary).toMatchObject({ text: null, min: 2_000, max: 3_000, currency: 'CNY', period: 'week' });
    const intl = publicItem(feedRow({ id: 's1', salaryDisclosed: true, salaryMin: 40, salaryMax: 55, salaryCurrency: 'USD', salaryPeriod: 'hour' }));
    expect(intl.salary).toEqual({ text: null, min: 40, max: 55, currency: 'USD', period: 'hour', months: null });
    expect(publicItem(feedRow({ id: 's2', salaryDisclosed: false })).salary).toBeNull();
    expect(publicItem(feedRow({ id: 's2', salaryDisclosed: false })).pay).toBeNull();
  });

  it('the same facts reach the signed-in card', () => {
    const item = toFeedItem(board(), { user: null, fit: null, tracker: null, position: 0 });
    expect(item.apply?.target).toBe('employer');
    expect(item.source.via).toBe('ats');
    expect(item).toHaveProperty('salary', null);
  });
});

describe('cardMeta and explanation (WP-33 ← WP-32)', () => {
  const explanation = {
    mode: 'personalized' as const,
    headline: { key: 'legal.explain.headline.personalized', params: { tier: 'good' } },
    reasons: [{ key: 'legal.explain.reason.skills' }],
    gaps: [],
    notices: [{ key: 'legal.explain.notice.notHiringChance' }],
  };

  it('carries the market card meta as the hooks return it, keyed by hook set', () => {
    const cardMeta = { cn: { sourceLine: { kind: 'source', sourceName: 'GoHire' }, salary: { text: '15-25K·13薪', disclosed: true } } };
    const item = toFeedItem(feedRow({ id: 'c1', market: 'cn' }), { user: null, fit: null, tracker: null, position: 0, cardMeta });
    expect(item.cardMeta).toEqual(cardMeta);
  });

  it('carries the "Why this job" explanation next to the fit', () => {
    const fit = { tier: 'good' as const, score: 72, kind: 'pre' as const, topGap: null, topOverlap: 'Python' };
    const item = toFeedItem(feedRow({ id: 'e1' }), { user: null, fit, tracker: null, position: 0, explanation });
    expect(item.explanation).toEqual(explanation);
    expect(item.fit).toEqual(fit);
  });

  it('both are left off the wire when there is nothing to say (never an empty object or null)', () => {
    const bare = toFeedItem(feedRow({ id: 'b1' }), { user: null, fit: null, tracker: null, position: 0 });
    expect('cardMeta' in bare).toBe(false);
    expect('explanation' in bare).toBe(false);
    const empty = toFeedItem(feedRow({ id: 'b2' }), { user: null, fit: null, tracker: null, position: 0, cardMeta: {}, explanation: null });
    expect('cardMeta' in empty).toBe(false);
    expect('explanation' in empty).toBe(false);
  });

  it('the visitor item never carries either', () => {
    const item = publicItem(feedRow({ id: 'p1', market: 'cn' }));
    expect(item).not.toHaveProperty('cardMeta');
    expect(item).not.toHaveProperty('explanation');
  });
});

describe('badges', () => {
  it('"Direct from employer" only when fromRecruiterBank && employerVerified && !isAgency', () => {
    const kinds = (o: object) => badgesFor(feedRow({ id: 'x', workModel: 'onsite', ...o }), null).map((b) => b.kind);
    expect(kinds({ fromRecruiterBank: true, employerVerified: true, isAgency: false })).toContain('direct_from_employer');
    expect(kinds({ fromRecruiterBank: true, employerVerified: false })).not.toContain('direct_from_employer');
    expect(kinds({ fromRecruiterBank: true, employerVerified: true, isAgency: true })).not.toContain('direct_from_employer');
    expect(kinds({ fromRecruiterBank: false, employerVerified: true })).not.toContain('direct_from_employer');
  });

  it('sponsorship badges only for users who need it, only with the quote; "says no" needs a negation', () => {
    const offered = feedRow({ id: 's', sponsorship: 'offered', sponsorshipEvidence: 'We sponsor H-1B visas.' });
    expect(badgesFor(offered, needs)[0]).toEqual({ kind: 'sponsorship', label: 'sponsorship', quote: 'We sponsor H-1B visas.' });
    expect(badgesFor(offered, noNeed).map((b) => b.kind)).not.toContain('sponsorship');
    expect(badgesFor({ ...offered, sponsorshipEvidence: null }, needs).map((b) => b.kind)).not.toContain('sponsorship');
    const no = feedRow({ id: 'n', sponsorship: 'not_offered', sponsorshipEvidence: 'We are unable to sponsor visas.' });
    expect(badgesFor(no, needs)[0]?.kind).toBe('no_sponsorship');
    expect(badgesFor({ ...no, sponsorshipEvidence: 'Sponsorship: see FAQ' }, needs).map((b) => b.kind)).not.toContain('no_sponsorship');
  });

  it('per-country work auth decides who needs sponsorship', () => {
    expect(needsSponsorshipFor({ needsSponsorship: false, workAuth: [{ country: 'US', authorized: false, sponsorship: 'now' }] }, 'US')).toBe(true);
    expect(needsSponsorshipFor({ needsSponsorship: true, workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }] }, 'US')).toBe(false);
    expect(needsSponsorshipFor(null, 'US')).toBe(false);
  });

  it('citizens-only / clearance and CN market tags render only with their evidence quote', () => {
    const quoted = feedRow({ id: 'q', workModel: 'onsite', clearanceRequired: true, marketTags: [{ tag: 'clearance_required', evidenceQuote: 'Active TS/SCI required.' }] });
    expect(badgesFor(quoted, null)[0]).toEqual({ kind: 'clearance_required', label: 'clearance_required', quote: 'Active TS/SCI required.' });
    expect(badgesFor({ ...quoted, marketTags: null }, null).map((b) => b.kind)).not.toContain('clearance_required');
    const cn = feedRow({ id: 'c', market: 'cn', workModel: 'onsite', employerTags: ['soe', 'hukou'], marketTags: [{ tag: 'soe', evidenceQuote: '国务院国资委监管企业' }] });
    expect(badgesFor(cn, null)).toEqual([{ kind: 'market_tag', label: 'soe', quote: '国务院国资委监管企业' }]);
  });

  it('at most three, fixed priority; never "new" or "closing soon"', () => {
    const row = feedRow({
      id: 'm',
      fromRecruiterBank: true,
      employerVerified: true,
      isAgency: false,
      workModel: 'remote',
      salaryDisclosed: true,
      salaryMin: 100,
      hasBenefits: true,
      postedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const b = badgesFor(row, null);
    expect(b.map((x) => x.kind)).toEqual(['direct_from_employer', 'remote', 'pay_listed']);
    expect(b.some((x) => x.kind === 'new' || x.kind === 'closing_soon')).toBe(false);
  });
});
