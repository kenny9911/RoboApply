// WP-33 — pure card rules (PRODUCT F-FEED-05/07, F-SAL-01; D3).

import { describe, expect, it } from 'vitest';

import { cardBadges, companyInitial, isDirectFromEmployer, itemExtras, payText, shortDate, sourceLine, MAX_BADGES } from './cardModel';
import { feedItem } from './feed.testkit';
import type { FeedItem } from '../../../lib/api/contracts/feed';

/** A sponsorship badge as WP-32 (`feed/items.ts` badgesFor) sends it: the stance is the kind. */
const sponsorship = (quote?: string, stance: 'offered' | 'not_offered' = 'offered') =>
  ({
    kind: stance === 'offered' ? 'sponsorship' : 'no_sponsorship',
    label: stance === 'offered' ? 'sponsorship' : 'no_sponsorship',
    ...(quote !== undefined ? { quote } : {}),
  }) as FeedItem['badges'][number];

const fmt = {
  locale: 'en-US',
  market: 'intl' as const,
  range: (a: string, b: string) => `${a}–${b}`,
  from: (a: string) => `From ${a}`,
  upTo: (a: string) => `Up to ${a}`,
};

describe('Direct from employer', () => {
  it('needs recruiter bank AND verified employer AND not an agency', () => {
    expect(isDirectFromEmployer({ fromRecruiterBank: true, employerVerified: true, isAgency: false })).toBe(true);
    expect(isDirectFromEmployer({ fromRecruiterBank: true, employerVerified: false, isAgency: false })).toBe(false);
    expect(isDirectFromEmployer({ fromRecruiterBank: true, employerVerified: true, isAgency: true })).toBe(false);
    expect(isDirectFromEmployer({ fromRecruiterBank: false, employerVerified: true, isAgency: false })).toBe(false);
  });

  it('a server badge alone never makes a job "Direct from employer"', () => {
    const item = feedItem(1, { badges: [{ kind: 'direct_from_employer', label: 'x' }] });
    expect(cardBadges(item).map((b) => b.kind)).not.toContain('direct');
  });

  it('an unverified bank job gets the recruiter source line instead', () => {
    const item = feedItem(1, { fromRecruiterBank: true, source: { name: 'RoboHire', kind: 'bank' } });
    expect(sourceLine(item)).toEqual({ key: 'bank', sourceName: 'RoboHire' });
    const direct = feedItem(2, { fromRecruiterBank: true, employerVerified: true, source: { name: 'RoboHire', kind: 'bank' } });
    expect(sourceLine(direct)).toBeNull();
    expect(cardBadges(direct)[0]).toEqual({ kind: 'direct' });
  });
});

describe('badges', () => {
  it('drops a sponsorship badge without a quote and keeps the quote otherwise', () => {
    expect(cardBadges(feedItem(1, { badges: [sponsorship(undefined, 'offered')] }))).toEqual([]);
    expect(cardBadges(feedItem(1, { badges: [sponsorship(' We sponsor H-1B visas. ', 'offered')] }))).toEqual([
      { kind: 'sponsorship', status: 'offered', quote: 'We sponsor H-1B visas.' },
    ]);
  });

  it('keeps a post that says no sponsorship as "not_offered", never as "mentioned"', () => {
    expect(cardBadges(feedItem(1, { badges: [sponsorship('We are unable to sponsor visas.', 'not_offered')] }))).toEqual([
      { kind: 'sponsorship', status: 'not_offered', quote: 'We are unable to sponsor visas.' },
    ]);
  });

  it('never reads a stance from a label or an extra field (only the kind)', () => {
    const odd = { kind: 'remote', label: 'sponsorship', quote: 'We sponsor H-1B visas.', status: 'offered' } as unknown as FeedItem['badges'][number];
    expect(cardBadges(feedItem(1, { badges: [odd] }))).toEqual([]);
  });

  it('clearance and citizens-only requirements show only with their quote', () => {
    const item = feedItem(1, {
      badges: [
        { kind: 'clearance_required', label: 'clearance_required', quote: 'Active TS/SCI clearance required.' },
        { kind: 'citizens_only', label: 'citizens_only', quote: 'Must be a U.S. citizen.' },
      ],
    });
    expect(cardBadges(item)).toEqual([
      { kind: 'clearance', quote: 'Active TS/SCI clearance required.' },
      { kind: 'citizens', quote: 'Must be a U.S. citizen.' },
    ]);
    expect(cardBadges(feedItem(1, { badges: [{ kind: 'clearance_required', label: 'clearance_required' }] }))).toEqual([]);
  });

  it('shows a deadline only when the post states one (no invented urgency)', () => {
    expect(cardBadges(feedItem(1, { badges: [{ kind: 'closing_soon', label: 'soon' }] }))).toEqual([]);
    const dated = feedItem(1, { campus: { applyClosesAt: '2026-11-01', applyClosesQuote: '网申截止11月1日', classYears: [2027] } });
    expect(cardBadges(dated)).toEqual([{ kind: 'closes', at: '2026-11-01', quote: '网申截止11月1日' }]);
    expect(shortDate('2026-11-01', 'en-US')).toBe('Nov 1, 2026');
  });

  it('GoApply employer tags keep their quote', () => {
    expect(cardBadges(feedItem(1, { badges: [{ kind: 'market_tag', label: 'soe', quote: '国有独资企业' }] }))).toEqual([{ kind: 'market', label: 'soe', quote: '国有独资企业' }]);
  });

  it('keeps at most 3 in a fixed priority', () => {
    const item = feedItem(1, {
      fromRecruiterBank: true,
      employerVerified: true,
      isAgency: false,
      badges: [
        { kind: 'new', label: 'New' },
        { kind: 'market_tag', label: 'SOE' },
        { kind: 'market_tag', label: 'SOE' },
        sponsorship('Sponsorship available.', 'offered'),
        { kind: 'market_tag', label: 'Hukou' },
      ],
    });
    const badges = cardBadges(item);
    expect(badges).toHaveLength(MAX_BADGES);
    expect(badges.map((b) => b.kind)).toEqual(['direct', 'sponsorship', 'market']);
  });

  it('marks agency posts', () => {
    expect(cardBadges(feedItem(1, { isAgency: true }))).toEqual([{ kind: 'agency' }]);
  });
});

describe('pay (never 0)', () => {
  it('null pay and zero amounts are "not listed"', () => {
    expect(payText(null, fmt)).toBeNull();
    expect(payText({ min: 0, max: 0, currency: 'USD', period: 'year', text: null }, fmt)).toBeNull();
    expect(payText({ min: null, max: null, currency: 'USD', period: 'year', text: null }, fmt)).toBeNull();
  });

  it('formats a range with its period and one-sided amounts', () => {
    expect(payText({ min: 120000, max: 150000, currency: 'USD', period: 'year', text: null }, fmt)).toEqual({ amount: '$120K–$150K', period: 'year' });
    expect(payText({ min: 150000, max: 120000, currency: 'USD', period: 'year', text: null }, fmt)?.amount).toBe('$120K–$150K');
    expect(payText({ min: 40, max: null, currency: 'USD', period: 'hour', text: null }, fmt)).toEqual({ amount: 'From $40', period: 'hour' });
    expect(payText({ min: null, max: 5000, currency: 'EUR', period: 'month', text: null }, fmt)?.amount).toBe('Up to €5,000');
    expect(payText({ min: 3000, max: 3000, currency: 'USD', period: 'month', text: null }, fmt)?.amount).toBe('$3,000');
  });

  it('GoApply prefers the post text (K·N薪)', () => {
    expect(payText({ min: 15000, max: 25000, currency: 'CNY', period: 'month', text: '15-25K·13薪' }, { ...fmt, market: 'cn' })).toEqual({ amount: '15-25K·13薪', period: null });
    expect(payText({ min: null, max: null, currency: 'TWD', period: 'month', text: '面議' }, fmt)).toEqual({ amount: '面議', period: null });
  });

  it('a broken currency falls back to the plain number', () => {
    expect(payText({ min: 10, max: null, currency: 'NOPE!', period: 'hour', text: null }, fmt)?.amount).toBe('From 10 NOPE!');
    expect(payText({ min: 10, max: null, currency: '', period: 'hour', text: null }, fmt)).toBeNull();
  });
});

describe('source line, dates, extras', () => {
  it('names the source per kind', () => {
    expect(sourceLine(feedItem(1))).toEqual({ key: 'provider', name: 'Example Jobs API' });
    expect(sourceLine(feedItem(1, { source: { name: 'Greenhouse', kind: 'ats_public' } }))).toEqual({ key: 'ats_public', name: 'Greenhouse' });
    expect(sourceLine(feedItem(1, { source: { name: '', kind: 'user_import' } }))).toEqual({ key: 'user_import' });
    expect(sourceLine(feedItem(1, { source: { name: '  ', kind: 'provider' } }))).toBeNull();
  });

  it('formats dates and rejects broken ones', () => {
    expect(shortDate('2026-10-03T12:00:00.000Z', 'en-GB')).toBe('3 Oct 2026');
    expect(shortDate('nope', 'en')).toBeNull();
    expect(shortDate(null, 'en')).toBeNull();
  });

  it('reads optional server fields through a narrow adapter', () => {
    expect(itemExtras(feedItem(1))).toEqual({ cardMeta: null, explanation: null });
    const explanation = { mode: 'personalized', headline: { key: 'legal.explain.headline.personalized' }, reasons: [], gaps: [], notices: [] };
    const extra = { ...feedItem(1), cardMeta: { cn: { deadline: 'x' } }, explanation };
    expect(itemExtras(extra)).toEqual({ cardMeta: { cn: { deadline: 'x' } }, explanation });
  });

  it('logo initial', () => {
    expect(companyInitial('acme')).toBe('A');
    expect(companyInitial('  ')).toBe('·');
    expect(companyInitial('字节跳动')).toBe('字');
  });
});
