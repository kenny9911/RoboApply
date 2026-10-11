// INT-06 — the feed card's market lines and the Tailor entry
// (wave3 WP-93 #7 and #26).
//
//   GoApply   the market slot (JobMetaCn) prints pay, the post's date, "Last
//             checked" and the source; the card then prints none of them a
//             second time. Without a `cn` block the card keeps its own lines.
//   RoboApply unchanged: pay, posted, last checked and source on the card.
//   Tailor    <TailorButton from="feed"> shows only when AI tailoring is
//             available to this user; it opens /resume?tailor=<jobId>.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { JobCard } from './JobCard';
import { itemExtras } from './cardModel';
import { marketMetaCoversBasics } from '../market';
import { feedItem, installFetch, ok, renderFeed, type Route } from './feed.testkit';
import type { FeedItem } from '../../../lib/api/contracts/feed';

const nav = vi.hoisted(() => ({ push: [] as string[] }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: (href: string) => nav.push.push(href), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));

// The resume list comes through the frozen V2 client (a stub under Vitest):
// give the hook a fixed list, as the other areas' tests do.
const resumes = vi.hoisted(() => ({ list: [{ id: 'r_main', name: 'Main', isPrimary: true }] as Array<{ id: string; name: string; isPrimary: boolean }> }));
vi.mock('../../../hooks/useResumes', () => ({
  resumeKeys: { all: ['v2', 'resumes'] },
  useResumeList: () => ({ data: { resumes: resumes.list }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const GRADE = '/api/v1/roboapply/v2/resumes/r_main/grade/latest';

const CN_META = {
  cn: {
    sourceLine: { kind: 'source', sourceName: 'GoHire', originalSourceName: null, licence: null },
    salary: { text: '15-25K·14薪', disclosed: true },
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastCheckedAt: '2026-10-09T00:00:00.000Z',
    expiresAt: null,
    tags: [],
    classYears: [],
    warnings: [],
  },
};

const cnItem = (over: Record<string, unknown> = {}): FeedItem =>
  ({
    ...feedItem(1, {
      title: '数据分析师',
      company: { id: 'co_1', name: '示例科技', logoUrl: null },
      location: '上海',
      pay: { min: 15000, max: 25000, currency: 'CNY', period: 'month', text: '15-25K·14薪' },
      source: { name: 'GoHire', kind: 'bank' },
    }),
    ...over,
  }) as FeedItem;

/** GET /v2/resumes/:id/grade/latest — `aiAvailable` is the server's answer to "may this user use AI" (GoApply consent). */
function resumeRoutes(aiAvailable: boolean): Record<string, Route> {
  return { [`GET ${GRADE}`]: () => ok({ grade: null, previous: null, stale: false, aiAvailable }) };
}

const card = (item: FeedItem, market: 'intl' | 'cn') => <JobCard item={item} position={0} market={market} />;

beforeEach(() => {
  nav.push = [];
  resumes.list = [{ id: 'r_main', name: 'Main', isPrimary: true }];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('marketMetaCoversBasics', () => {
  it('is true only on GoApply with a readable cn block', () => {
    expect(marketMetaCoversBasics('cn', CN_META)).toBe(true);
    expect(marketMetaCoversBasics('cn', null)).toBe(false);
    expect(marketMetaCoversBasics('cn', {})).toBe(false);
    expect(marketMetaCoversBasics('cn', { ats_public: { country: 'TW' } })).toBe(false);
    expect(marketMetaCoversBasics('intl', CN_META)).toBe(false);
    expect(marketMetaCoversBasics('cn', itemExtras(cnItem({ cardMeta: CN_META })).cardMeta)).toBe(true);
  });
});

describe('feed card — GoApply (cn) with cardMeta', () => {
  it('shows ONE pay line, one "Updated", one "Last verified" and one source, all from the market slot', () => {
    installFetch({});
    renderFeed(card(cnItem({ cardMeta: CN_META }), 'cn'), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).queryByTestId('pay')).toBeNull();
    expect(within(el).queryByTestId('card-meta')).toBeNull();
    expect(within(el).queryByTestId('source-line')).toBeNull();
    expect(within(el).getAllByText('15-25K·14薪')).toHaveLength(1);
    expect(within(el).getAllByText(/^Updated /)).toHaveLength(1);
    expect(within(el).getAllByText(/^Last verified /)).toHaveLength(1);
    expect(within(el).queryByText(/^Posted /)).toBeNull();
    const slot = within(el).getByTestId('job-meta-cn');
    expect(slot).toHaveTextContent('Source: GoHire');
    expect(slot).toHaveTextContent('15-25K·14薪');
    // The other facts stay on the card.
    expect(el).toHaveTextContent('上海');
  });

  it('undisclosed pay is said once, by the slot, never as a number', () => {
    installFetch({});
    renderFeed(card(cnItem({ pay: null, cardMeta: { cn: { ...CN_META.cn, salary: { text: null, disclosed: false } } } }), 'cn'), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).queryByTestId('pay')).toBeNull();
    expect(within(el).getAllByText('Pay not listed')).toHaveLength(1);
    expect(within(el).getByTestId('job-meta-cn')).toHaveTextContent('Pay not listed');
  });

  it('a job the user added says "Added by you" once (never "Source not listed"), with one pay line', () => {
    installFetch({});
    const own = { cn: { ...CN_META.cn, sourceLine: { kind: 'source', sourceName: null, originalSourceName: null, licence: null } } };
    renderFeed(card(cnItem({ source: { name: '', kind: 'user_import' }, cardMeta: own }), 'cn'), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).getAllByText('Added by you')).toHaveLength(1);
    expect(within(el).getByTestId('cn-source')).toHaveTextContent('Added by you');
    expect(el).not.toHaveTextContent('Source not listed');
    expect(within(el).queryByTestId('pay')).toBeNull();
    expect(within(el).getAllByText('15-25K·14薪')).toHaveLength(1);
    expect(within(el).getAllByText(/^Updated /)).toHaveLength(1);
  });

  it('a listed job with no source name still reads "Source not listed"', () => {
    installFetch({});
    const noName = { cn: { ...CN_META.cn, sourceLine: { kind: 'source', sourceName: null, originalSourceName: null, licence: null } } };
    renderFeed(card(cnItem({ source: { name: '', kind: 'provider' }, cardMeta: noName }), 'cn'), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).getByTestId('cn-source')).toHaveTextContent('Source not listed');
    expect(el).not.toHaveTextContent('Added by you');
  });

  it('without a cn block the card keeps its own pay and date lines (nothing dropped without a replacement)', () => {
    installFetch({});
    renderFeed(card(cnItem(), 'cn'), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).queryByTestId('job-meta-cn')).toBeNull();
    expect(within(el).getByTestId('pay')).toHaveTextContent('15-25K·14薪');
    expect(within(el).getByTestId('card-meta')).toHaveTextContent('Posted');
    expect(within(el).getByTestId('source-line')).toBeInTheDocument();
  });
});

describe('FIX-3: a date we assigned is "First seen", as on the job page', () => {
  it('a job with an estimated posting date (a job the user added, or one with no date at its source) never says "Posted"', () => {
    installFetch({});
    const { unmount } = renderFeed(card({ ...feedItem(1), postedAtEstimated: true }, 'intl'));
    expect(within(screen.getByTestId('card-meta')).getByText(/^First seen /)).toBeInTheDocument();
    expect(within(screen.getByTestId('card-meta')).queryByText(/^Posted /)).toBeNull();
    unmount();
    renderFeed(card({ ...feedItem(1), postedAtEstimated: false }, 'intl'));
    expect(within(screen.getByTestId('card-meta')).getByText(/^Posted /)).toBeInTheDocument();
  });
});

describe('feed card — RoboApply (intl) is unchanged', () => {
  it('pay, posted, last checked and source are on the card, cn meta or not', () => {
    installFetch({});
    const { unmount } = renderFeed(card(feedItem(1), 'intl'));
    let el = screen.getByTestId('job-card');
    expect(within(el).getAllByTestId('pay')).toHaveLength(1);
    expect(within(el).getByTestId('pay')).toHaveTextContent(/€70K–€90K/);
    expect(within(el).getByTestId('card-meta')).toHaveTextContent('Posted');
    expect(within(el).getByTestId('card-meta')).toHaveTextContent('Last checked');
    expect(within(el).getByTestId('source-line')).toBeInTheDocument();
    unmount();

    renderFeed(card({ ...feedItem(1), cardMeta: CN_META } as FeedItem, 'intl'));
    el = screen.getByTestId('job-card');
    expect(within(el).getByTestId('pay')).toBeInTheDocument();
    expect(within(el).getByTestId('card-meta')).toBeInTheDocument();
    expect(within(el).queryByTestId('job-meta-cn')).toBeNull();
  });
});

// ── MKT-2F: the card says when a quick estimate rests on little (strategy 2.4; MATCH 4.4 point 6) ──

describe('MKT-2F: feed card fit, kind and confidence', () => {
  const withFit = (fit: FeedItem['fit']) => card({ ...feedItem(1), fit } as FeedItem, 'intl');
  const base = { topGap: null, topOverlap: null };

  const WORK_PRE = 'Compared the title, skills and location with your resume.';

  it.each([
    ['no_skills_listed', 'This post lists no skills'],
    ['no_level_stated', 'This post states no level'],
    ['no_role_evidence', 'Your resume shows no role to compare'],
    ['no_resume', 'Add a resume for a full comparison. This estimate uses your profile and preferences.'],
    ['few_details', 'This post says too little to compare'],
  ])('a low-confidence estimate (%s) shows the tag and one plain reason', (confidenceReason, text) => {
    installFetch({});
    renderFeed(withFit({ ...base, tier: 'good', score: 68, kind: 'pre', confidence: 'low', confidenceReason }));
    const el = screen.getByTestId('job-card');
    expect(within(el).getAllByTestId('job-card-estimate')).toHaveLength(1);
    expect(within(el).getByTestId('job-card-estimate')).toHaveTextContent(/^Quick estimate$/);
    expect(within(el).getAllByTestId('job-card-estimate-reason')).toHaveLength(1);
    expect(within(el).getByTestId('job-card-estimate-reason')).toHaveTextContent(text);
    // The reason takes the place of "what we compared": a post that lists no skills was not compared on skills.
    expect(within(el).queryByText(WORK_PRE)).toBeNull();
    // The number and its honesty line are unchanged.
    expect(within(el).getByText('Good fit')).toBeInTheDocument();
    expect(within(el).getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });

  it('a high- or medium-confidence estimate shows "Quick estimate" only', () => {
    installFetch({});
    for (const confidence of ['high', 'medium'] as const) {
      const r = renderFeed(withFit({ ...base, tier: 'good', score: 72, kind: 'pre', confidence, confidenceReason: null }));
      expect(screen.getByTestId('job-card-estimate')).toHaveTextContent(/^Quick estimate$/);
      expect(screen.queryByTestId('job-card-estimate-reason')).toBeNull();
      expect(screen.getByText(WORK_PRE)).toBeInTheDocument();
      r.unmount();
    }
    // A server from before estimate v2 sends no confidence: the tag alone, as before.
    const older = renderFeed(withFit({ ...base, tier: 'good', score: 72, kind: 'pre' }));
    expect(screen.getByTestId('job-card-estimate')).toHaveTextContent(/^Quick estimate$/);
    expect(screen.queryByTestId('job-card-estimate-reason')).toBeNull();
    older.unmount();
    // Low confidence with a reason we have no words for: the tag alone, never a guessed reason.
    renderFeed(withFit({ ...base, tier: 'good', score: 72, kind: 'pre', confidence: 'low', confidenceReason: 'something_new' }));
    expect(screen.queryByTestId('job-card-estimate-reason')).toBeNull();
    expect(screen.getByText(WORK_PRE)).toBeInTheDocument();
  });

  it('a card with an AI fit shows neither the tag nor a reason, even for a thin posting', () => {
    installFetch({});
    renderFeed(withFit({ ...base, tier: 'possible', score: 63, kind: 'ai', confidence: 'low', confidenceReason: 'no_skills_listed' }));
    const el = screen.getByTestId('job-card');
    expect(within(el).queryByTestId('job-card-estimate')).toBeNull();
    expect(within(el).queryByTestId('job-card-estimate-reason')).toBeNull();
    expect(within(el).queryByText(/Quick estimate/)).toBeNull();
    expect(within(el).getByText('Read the full post and compared it with your resume.')).toBeInTheDocument();
    expect(within(el).getByText('Possible')).toBeInTheDocument();
  });

  it('never a tier chip for a null score: a fit without a number shows "—" and no tier word', () => {
    installFetch({});
    // A shape the server does not send (its badge is null without a score); the card must still never label it.
    renderFeed(withFit({ ...base, tier: 'great', score: null as unknown as number, kind: 'pre', confidence: 'low', confidenceReason: 'few_details' }));
    const el = screen.getByTestId('job-card');
    expect(within(el).queryByText('Great fit')).toBeNull();
    expect(within(el).queryByText(/fit$/)).toBeNull();
    expect(within(el).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('GoApply: the same tag and reason, in the same words (one rule for both brands)', () => {
    installFetch({});
    renderFeed(card({ ...cnItem(), fit: { ...base, tier: 'good', score: 68, kind: 'pre', confidence: 'low', confidenceReason: 'no_skills_listed' } } as FeedItem, 'cn'), { brand: 'goapply' });
    expect(screen.getByTestId('job-card-estimate')).toHaveTextContent(/^Quick estimate$/);
    expect(screen.getByTestId('job-card-estimate-reason')).toHaveTextContent('This post lists no skills');
  });
});

describe('feed card — Tailor resume', () => {
  it('shows when AI tailoring is available and opens the tailor flow for this job', async () => {
    installFetch(resumeRoutes(true));
    renderFeed(card(feedItem(7), 'intl'), { flags: { 'ai.text': true } });
    const btn = await screen.findByRole('button', { name: 'Tailor your resume for Backend engineer 7' });
    expect(btn).toHaveTextContent('Tailor resume');
    fireEvent.click(btn);
    expect(nav.push).toEqual(['/resume?tailor=job_7&from=feed']);
  });

  it('is absent when the brand has no usable text model (ai.text off): no button and no consent lookup', async () => {
    const net = installFetch(resumeRoutes(true));
    renderFeed(card(feedItem(7), 'cn'), { brand: 'goapply', flags: { 'ai.text': false } });
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: /Tailor/ })).toBeNull();
    expect(net.to('GET', GRADE)).toHaveLength(0);
  });

  it('is absent on GoApply when the user has not agreed to AI (aiAvailable false)', async () => {
    const net = installFetch(resumeRoutes(false));
    renderFeed(card(feedItem(7), 'cn'), { brand: 'goapply', flags: { 'ai.text': true } });
    await waitFor(() => expect(net.to('GET', GRADE)).toHaveLength(1));
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: /Tailor/ })).toBeNull();
  });

  it('is absent when the user has no resume yet', async () => {
    resumes.list = [];
    const net = installFetch(resumeRoutes(true));
    renderFeed(card(feedItem(7), 'intl'), { flags: { 'ai.text': true } });
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: /Tailor/ })).toBeNull();
    expect(net.to('GET', GRADE)).toHaveLength(0);
  });

  it('twenty cards share one consent lookup', async () => {
    const net = installFetch(resumeRoutes(true));
    renderFeed(
      <>
        {Array.from({ length: 20 }, (_, i) => (
          <JobCard key={i} item={feedItem(i + 1)} position={i} market="intl" />
        ))}
      </>,
      { flags: { 'ai.text': true } },
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Tailor your resume for/ })).toHaveLength(20));
    expect(net.to('GET', GRADE)).toHaveLength(1);
  });
});
