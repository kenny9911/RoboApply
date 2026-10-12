// WP-33 — pure card rules (PRODUCT F-FEED-05/07, F-SAL-01; D3).
// MKT-5C (JI-10, JI-11): the date line from three separate facts, "New" from
// `isNew` only, a provider's sponsorship reading as its own badge, and how
// the apply tab is opened (never an empty tab in a browser with one window).

import { describe, expect, it, vi } from 'vitest';

import { cardBadges, cardDates, cardIsNew, companyInitial, createApplyTabOpener, isDirectFromEmployer, isOneWindowBrowser, itemExtras, payText, shortDate, sourceLine, MAX_BADGES } from './cardModel';
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
        // A reserved entry of the list: ignored ("New" is the field `isNew`).
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

  describe('a provider\'s sponsorship reading (JI-11)', () => {
    const reading = (provider?: string) => ({ kind: 'sponsorship_provider', label: 'sponsorship_provider', ...(provider !== undefined ? { provider } : {}) }) as FeedItem['badges'][number];

    it('is its own badge that names the provider: no quote, and never the quoted badge', () => {
      const badges = cardBadges(feedItem(1, { badges: [reading(' Active Jobs DB ')] }));
      expect(badges).toEqual([{ kind: 'sponsorship_provider', provider: 'Active Jobs DB' }]);
      expect(badges.some((b) => b.kind === 'sponsorship')).toBe(false);
    });

    it('without a provider name it is dropped: an unnamed reading is nobody\'s word', () => {
      expect(cardBadges(feedItem(1, { badges: [reading()] }))).toEqual([]);
      expect(cardBadges(feedItem(1, { badges: [reading('   ')] }))).toEqual([]);
    });

    it('a quote on it is ignored: only the posting\'s own badge carries a quote', () => {
      const odd = { ...reading('Active Jobs DB'), quote: 'We sponsor H-1B visas.' } as FeedItem['badges'][number];
      expect(cardBadges(feedItem(1, { badges: [odd] }))).toEqual([{ kind: 'sponsorship_provider', provider: 'Active Jobs DB' }]);
    });

    it('it takes the sponsorship place in the fixed order and counts toward the three', () => {
      const item = feedItem(1, { fromRecruiterBank: true, employerVerified: true, badges: [{ kind: 'market_tag', label: 'soe', quote: 'q' }, reading('Active Jobs DB'), { kind: 'market_tag', label: 'hukou', quote: 'q' }] });
      expect(cardBadges(item).map((b) => b.kind)).toEqual(['direct', 'sponsorship_provider', 'market']);
    });
  });
});

describe('"New" comes from `isNew` only (JI-10)', () => {
  it('true only when the server says the posting is new to this viewer', () => {
    expect(cardIsNew(feedItem(1, { isNew: true }))).toBe(true);
    expect(cardIsNew(feedItem(1, { isNew: false }))).toBe(false);
    expect(cardIsNew(feedItem(1))).toBe(false);
  });

  it('never from the posted date, and never from a badge of the list', () => {
    const postedNow = feedItem(1, { postedAt: new Date().toISOString(), isNew: false, badges: [{ kind: 'new', label: 'New' }] });
    expect(cardIsNew(postedNow)).toBe(false);
    // The reserved list entry is ignored: it is not one of the card's fact badges either.
    expect(cardBadges(postedNow)).toEqual([]);
  });

  it('ACCEPT: a posting published 300 days ago and first seen an hour ago shows its true posted date and is new', () => {
    const posted = new Date(Date.now() - 300 * 86_400_000).toISOString();
    const item = feedItem(1, { postedAt: posted, postedAtEstimated: false, firstSeenAt: new Date(Date.now() - 3_600_000).toISOString(), isNew: true });
    expect(cardDates(item).lead).toEqual({ kind: 'posted', at: posted });
    expect(cardIsNew(item)).toBe(true);
    // "New" is beside the fact badges, not one of them: a card with three facts keeps all three.
    const full = feedItem(1, { isNew: true, fromRecruiterBank: true, employerVerified: true, badges: [sponsorship('We sponsor.', 'offered'), { kind: 'market_tag', label: 'soe', quote: 'q' }] });
    expect(cardBadges(full)).toHaveLength(MAX_BADGES);
    expect(cardIsNew(full)).toBe(true);
  });
});

describe('the date line: three separate facts (JI-10)', () => {
  const SEEN = '2026-10-09T03:00:00.000Z';
  const CHECKED = '2026-10-12T05:00:00.000Z';

  it('a real posted date leads as "posted"; last verified is its own fact', () => {
    expect(cardDates(feedItem(1, { postedAt: '2026-06-10T00:00:00.000Z', postedAtEstimated: false, firstSeenAt: SEEN, lastSeenAt: CHECKED }))).toEqual({
      lead: { kind: 'posted', at: '2026-06-10T00:00:00.000Z' },
      verified: { kind: 'last_verified', at: CHECKED },
    });
  });

  it('ACCEPT: an estimated date (an open-data row) is never "posted": the card says when we first saw it and when it was last verified', () => {
    // As the server sends it: no posting date at all, our two facts in their own fields.
    const wire = cardDates(feedItem(1, { postedAt: null, postedAtEstimated: true, firstSeenAt: SEEN, lastSeenAt: CHECKED }));
    expect(wire).toEqual({ lead: { kind: 'first_seen', at: SEEN }, verified: { kind: 'last_verified', at: CHECKED } });
    // Even if a date still arrives under `postedAt` with the flag (an older server), it is not a posted date.
    const legacy = cardDates(feedItem(1, { postedAt: '2026-06-10T00:00:00.000Z', postedAtEstimated: true, lastSeenAt: CHECKED }));
    expect(legacy.lead).toEqual({ kind: 'first_seen', at: '2026-06-10T00:00:00.000Z' });
    // With our own first-seen date on the wire, that is the one shown, never the estimate.
    const both = cardDates(feedItem(1, { postedAt: '2026-06-10T00:00:00.000Z', postedAtEstimated: true, firstSeenAt: SEEN, lastSeenAt: CHECKED }));
    expect(both.lead).toEqual({ kind: 'first_seen', at: SEEN });
    for (const d of [wire, legacy, both]) expect(d.lead?.kind).not.toBe('posted');
  });

  it('a posting with no date at all: first seen when we know it, otherwise nothing leads ("Posting date not listed"); last verified stands', () => {
    expect(cardDates(feedItem(1, { postedAt: null, firstSeenAt: SEEN, lastSeenAt: CHECKED }))).toEqual({ lead: { kind: 'first_seen', at: SEEN }, verified: { kind: 'last_verified', at: CHECKED } });
    expect(cardDates(feedItem(1, { postedAt: null, lastSeenAt: CHECKED }))).toEqual({ lead: null, verified: { kind: 'last_verified', at: CHECKED } });
    expect(cardDates(feedItem(1, { postedAt: 'not a date', firstSeenAt: 'nope', lastSeenAt: null }))).toEqual({ lead: null, verified: null });
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
    // JT-8 (M5 gate, MKT-5F Request 6): a Taiwan row found through Google's job index does not name the aggregator;
    // the Taiwan slot prints "{publisher} · found through Google job search" instead (twExtras.test.tsx).
    const viaGoogle = { ...feedItem(1, { source: { name: 'JSearch', kind: 'provider' } }), cardMeta: { tw_sources: { via: 'google_jobs', publisher: '104人力銀行', url: 'https://www.104.com.tw/job/abc12' } } };
    expect(sourceLine(viaGoogle as never)).toBeNull();
    // An open-data row (an attribution, no `via`) and any other provider row keep their source line.
    expect(sourceLine({ ...feedItem(1), cardMeta: { tw_sources: { attribution: { text: 'x', url: null } } } } as never)).toEqual({ key: 'provider', name: 'Example Jobs API' });
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

describe('the apply tab (MKT-5C; the card and the job page share it)', () => {
  // User agents of the shapes the browsers send; nothing here identifies a person or a device.
  const UA = {
    chromeDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    wechatIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003237) NetType/WIFI Language/zh_CN',
    wechatAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 XWEB/1300001 MMWEBSDK/20240404 MicroMessenger/8.0.50 WeChat/arm64',
    linkedinIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.100',
    androidWebView: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    iosWebView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  };

  it('a browser with tabs, and a browser with one window', () => {
    for (const ua of [UA.chromeDesktop, UA.safariIphone, UA.chromeIphone, UA.chromeAndroid, '', null, undefined]) expect(isOneWindowBrowser(ua)).toBe(false);
    for (const ua of [UA.wechatIphone, UA.wechatAndroid, UA.linkedinIphone, UA.androidWebView, UA.iosWebView]) expect(isOneWindowBrowser(ua)).toBe(true);
  });

  const browser = (userAgent: string) => {
    const tab = { location: { href: '' } } as unknown as Window;
    const open = vi.fn((_url: string, _target: string, _features?: string) => tab);
    const go = vi.fn();
    return { opener: createApplyTabOpener({ userAgent: () => userAgent, open, go }), open, go, tab };
  };

  it('with tabs: an empty tab inside the click, and a link opened without a handle on our page', () => {
    const b = browser(UA.chromeDesktop);
    expect(b.opener.blank()).toBe(b.tab);
    expect(b.open.mock.calls).toEqual([['about:blank', '_blank']]);
    b.opener.open('https://boards.example.com/acme/1');
    expect(b.open).toHaveBeenLastCalledWith('https://boards.example.com/acme/1', '_blank', 'noopener,noreferrer');
    expect(b.go).not.toHaveBeenCalled();
  });

  it('with one window: no empty tab is ever opened (it would replace the page); the page goes to the answered link itself', () => {
    for (const ua of [UA.wechatIphone, UA.wechatAndroid, UA.androidWebView, UA.iosWebView]) {
      const b = browser(ua);
      // Inside the click: nothing is opened, and the hook is told there is no tab to point.
      expect(b.opener.blank()).toBeNull();
      expect(b.open).not.toHaveBeenCalled();
      // When the server has answered with the link: the page goes there.
      b.opener.open('https://careers.example-tech.cn/jobs/1');
      expect(b.go.mock.calls).toEqual([['https://careers.example-tech.cn/jobs/1']]);
      expect(b.open).not.toHaveBeenCalled();
    }
  });
});
