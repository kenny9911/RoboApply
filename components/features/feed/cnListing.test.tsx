// components/features/feed/cnListing.test.tsx — the listing contract on the
// GoApply jobs page (parity wave; MARKET_STRATEGY JC-1; D1, D3):
//   - every public card names its source, links the original posting and says
//     when it was last verified; undisclosed pay reads "Pay not listed";
//   - the apply button opens the posting's own link and says where it leads;
//   - the header says where the list's postings come from, from the response;
//   - a thin result set shows the search links on other job sites under it;
//   - a response from before the contract renders as it did (safe defaults);
//   - RoboApply's card and header are unchanged.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import JobsPage from '../../../app/(auth)/jobs/page';
import { __setPopupGate } from '../../../lib/ui/popupGate';
import { cnFeedSummary } from '../../../lib/api/cnJobs';
import { feedIsThin, feedSources, listingApply, listingSource, payUndisclosed, safeHttpUrl } from '../../../lib/api/feed';
import { jobListing } from '../../../lib/api/jobs';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import { feedItem as fixtureItem, feedItemCnBank, feedItemCnBoard, feedItemCnRecency, feedResponseCnBoards } from '../../../__tests__/fixtures/feed';
import { hasNamedSource, payText } from './cardModel';
import { cnApplyCopy, marketPayLineText, marketPayWords } from '../market';
import { JobCard } from './JobCard';
import { EMPTY_UI_STATE, feedItem, installFetch, installPopupGate, ok, page, profileList, renderFeed, searchProfile } from './feed.testkit';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));
vi.mock('../../../hooks/useResumes', () => ({
  resumeKeys: { all: ['v2', 'resumes'] },
  useResumeList: () => ({ data: { resumes: [{ id: 'r_main', name: 'Main', isPrimary: true }] }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const QUERY = '/api/v1/roboapply/feed/query';
const board = feedItemCnBoard as unknown as FeedItem;
const bank = feedItemCnBank as unknown as FeedItem;

function routes(response: unknown) {
  return {
    'GET /api/v1/roboapply/search-profiles': () => ok(profileList([searchProfile({ filters: { q: '数据分析师' } })])),
    'GET /api/v1/roboapply/ui-state': () => ok(EMPTY_UI_STATE),
    'GET /api/v1/roboapply/cn/jobs/external-links': () => ok({ links: [] }),
    [`POST ${QUERY}`]: () => ok(response),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  __setPopupGate(null);
  nav.search = '';
});

describe('contract readers (lib/api)', () => {
  it('read the contract fields of a board row and of a bank row', () => {
    expect(listingSource(board)).toEqual({
      name: 'SmartRecruiters',
      original: '示例科技有限公司',
      url: 'https://jobs.smartrecruiters.com/ExampleTech/744000012345678',
      lastVerifiedAt: '2026-10-11T02:00:00.000Z',
      via: 'ats',
    });
    expect(listingApply(board)).toEqual({ url: 'https://careers.example-tech.cn/jobs/744000012345678', target: 'employer' });
    expect(listingApply(bank)).toEqual({ url: 'https://www.gohire.top/postings/9001', target: 'gohire' });
    expect(payUndisclosed(board)).toBe(true);
    expect(payUndisclosed(feedItem(1, { pay: { min: 1, max: 2, currency: 'CNY', period: 'month', text: null } }))).toBe(false);
  });

  it('fall back safely on an item from before the contract: nothing is invented', () => {
    // `source: { name, kind }` only, no `apply`.
    expect(listingSource(feedItemCnRecency)).toEqual({ name: 'GoHire', original: null, url: null, lastVerifiedAt: '2026-10-09T00:00:00.000Z', via: 'bank' });
    expect(listingApply(feedItemCnRecency)).toEqual({ url: null, target: 'gohire' });
    expect(listingSource(fixtureItem)).toMatchObject({ name: 'Example Board', original: null, url: null, via: null });
    expect(listingApply(fixtureItem)).toEqual({ url: null, target: null });
    for (const junk of [null, undefined, 7, 'x', [], {}]) {
      expect(listingSource(junk)).toEqual({ name: null, original: null, url: null, lastVerifiedAt: null, via: null });
      expect(listingApply(junk)).toEqual({ url: null, target: null });
    }
  });

  it('never returns a link that is not http(s), and never guesses the apply target from a link', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'mailto:a@b.c', '', '  ', 42, null]) expect(safeHttpUrl(bad)).toBeNull();
    expect(safeHttpUrl(' https://careers.example.cn/jobs/1 ')).toBe('https://careers.example.cn/jobs/1');
    const item = { source: { name: 'X', kind: 'provider', url: 'javascript:alert(1)' }, apply: { url: 'https://www.gohire.top/x', target: 'us' } };
    expect(listingSource(item).url).toBeNull();
    expect(listingApply(item)).toEqual({ url: 'https://www.gohire.top/x', target: null });
  });

  it('the job page reads the same facts from the detail response, with its older fields as the fallback', () => {
    const before = { job: { applyUrl: 'https://boards.example.com/acme/1', lastSeenAt: '2026-10-10T00:00:00.000Z', pay: null, payText: null, source: { name: 'Greenhouse', kind: 'ats_public', originalName: 'Acme' } } };
    expect(jobListing(before as never)).toEqual({
      source: { name: 'Greenhouse', original: 'Acme', url: null, lastVerifiedAt: '2026-10-10T00:00:00.000Z', via: 'ats' },
      apply: { url: 'https://boards.example.com/acme/1', target: 'employer' },
    });
    expect(jobListing(null)).toEqual({ source: { name: null, original: null, url: null, lastVerifiedAt: null, via: null }, apply: { url: null, target: null } });
  });

  it('a `target: null` the server sent is final: it is never replaced by a guess from the source kind', () => {
    // A recruiter-bank row whose page the server does not claim to be GoHire's (PAR-11 applyLinkOf).
    const unlabelled = { apply: { url: 'https://bank.example.cn/postings/1', target: null }, source: { name: 'Other bank', kind: 'bank' }, fromRecruiterBank: true };
    expect(listingApply(unlabelled)).toEqual({ url: 'https://bank.example.cn/postings/1', target: null });
    // The same row from before the contract (no `apply` field at all) still follows the source kind.
    expect(listingApply({ source: { name: 'Other bank', kind: 'bank' }, fromRecruiterBank: true })).toEqual({ url: null, target: 'gohire' });
    // `apply: null` is a posting with no usable link: no link is taken from the older field either.
    expect(listingApply({ apply: null, applyUrl: 'https://boards.example.com/acme/1', source: { name: 'Greenhouse', kind: 'ats_public' } })).toEqual({ url: null, target: null });
    expect(listingApply({ apply: { url: 'https://boards.example.com/acme/1' }, source: { name: 'Greenhouse', kind: 'ats_public' } })).toEqual({ url: 'https://boards.example.com/acme/1', target: null });
  });

  it('the unlabelled bank row gets the shared apply wording on GoApply, never "Apply on GoHire"', () => {
    expect(cnApplyCopy({ source: listingSource({ source: { name: 'Other bank', kind: 'bank' } }), apply: { url: 'https://bank.example.cn/postings/1', target: null } })).toBeNull();
  });

  it('`salary` of the contract decides "no pay stated"; before it, the absence of any pay does', () => {
    expect(payUndisclosed({ salary: null, pay: null, payText: '面议' })).toBe(true);
    expect(payUndisclosed({ salary: { text: '15-25K·14薪', min: 15000, max: 25000, currency: 'CNY', period: 'month', months: 14 }, pay: null, payText: null })).toBe(false);
    expect(payUndisclosed({ pay: null, payText: null })).toBe(true);
    // Before the contract, pay in words is still a stated pay line (Taiwan's 面議 on RoboApply).
    expect(payUndisclosed({ pay: null, payText: '待遇面議' })).toBe(false);
  });

  it('pay in words by market: GoApply never prints 面议, RoboApply prints the posting\'s words as they are', () => {
    for (const words of ['面议', '薪资面议', '待遇面議', ' 月薪 面议 ']) {
      expect(marketPayWords('cn', { pay: null, payText: words }), words).toBeNull();
      expect(marketPayLineText('cn', words), words).toBe('');
      expect(marketPayWords('intl', { pay: null, payText: words }), words).toBe(words);
      expect(marketPayLineText('intl', words), words).toBe(words.trim());
    }
    // The server says the posting states no pay: its words are not printed on GoApply, whatever they are.
    expect(marketPayWords('cn', { salary: null, pay: null, payText: '薪资面议，详谈' })).toBeNull();
    // Words that state a pay are kept on both.
    expect(marketPayWords('cn', { pay: null, payText: '15-25K·14薪' })).toBe('15-25K·14薪');
    expect(marketPayWords('cn', { salary: { text: '15-25K·14薪' }, pay: null, payText: '15-25K·14薪' })).toBe('15-25K·14薪');
    expect(marketPayWords('intl', { pay: null, payText: 'Competitive' })).toBe('Competitive');
    expect(marketPayWords('cn', null)).toBeNull();
    expect(marketPayWords('intl', { payText: null })).toBeNull();
  });

  it('a card\'s own pay line: 面议 beside no figures is "Pay not listed" on GoApply, and the figures are kept when there are some', () => {
    const opts = { locale: 'en', range: (min: string, max: string) => `${min}–${max}`, from: (a: string) => `from ${a}`, upTo: (a: string) => `up to ${a}` };
    expect(payText({ min: null, max: null, currency: 'CNY', period: 'month', text: '面议' }, { ...opts, market: 'cn' })).toBeNull();
    expect(payText({ min: 15000, max: 25000, currency: 'CNY', period: 'month', text: '薪资面议' }, { ...opts, market: 'cn' })?.amount).toMatch(/15K.*25K/);
    expect(payText({ min: null, max: null, currency: 'CNY', period: 'month', text: '15-25K·14薪' }, { ...opts, market: 'cn' })).toEqual({ amount: '15-25K·14薪', period: null });
    // RoboApply is unchanged: the words are shown as the posting states them.
    expect(payText({ min: null, max: null, currency: 'TWD', period: 'month', text: '待遇面議' }, { ...opts, market: 'intl' })).toEqual({ amount: '待遇面議', period: null });
  });

  it('feed sources and thin come only from the response', () => {
    expect(feedSources(feedResponseCnBoards)).toEqual({ gohire: false, employerBoards: 27 });
    expect(feedSources(page([]))).toBeNull();
    expect(feedSources({ sources: { gohire: true, employerBoards: 2.9 } })).toEqual({ gohire: true, employerBoards: 2 });
    expect(feedSources({ sources: { gohire: 1, employerBoards: -4 } })).toEqual({ gohire: false, employerBoards: 0 });
    expect(feedIsThin(feedResponseCnBoards)).toBe(true);
    expect(feedIsThin(page([]))).toBe(false);
    expect(feedIsThin({ thin: 'true' })).toBe(false);
    expect(cnFeedSummary(feedResponseCnBoards)).toEqual({ header: { kind: 'boards', boards: 27 }, thin: true });
  });

  it('hasNamedSource: a public posting needs a publisher or a source name; the user’s own job does not', () => {
    expect(hasNamedSource(board)).toBe(true);
    expect(hasNamedSource(feedItem(1, { source: { name: '', kind: 'ats_public' } }))).toBe(false);
    expect(hasNamedSource(feedItem(1, { source: { name: ' ', kind: 'provider', original: '示例科技' } as never }))).toBe(true);
    expect(hasNamedSource(feedItem(1, { source: { name: '', kind: 'user_import' } }))).toBe(true);
  });
});

describe('GoApply card with the listing contract', () => {
  const card = (item: FeedItem, market: 'intl' | 'cn' = 'cn') => <JobCard item={item} position={0} market={market} />;

  it('a board row: 来源 the employer, the original link, last verified, pay not listed, and an apply button that says where it leads', () => {
    installFetch({});
    renderFeed(card(board), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).getByTestId('cn-source')).toHaveTextContent('Source: 示例科技有限公司');
    expect(within(el).getByTestId('cn-original-link')).toHaveAttribute('href', 'https://jobs.smartrecruiters.com/ExampleTech/744000012345678');
    expect(within(el).getAllByText(/^Last verified /)).toHaveLength(1);
    expect(within(el).getAllByText('Pay not listed')).toHaveLength(1);
    expect(el).not.toHaveTextContent(/面议|Negotiable/i);
    expect(within(el).getByRole('button', { name: "Apply on the employer's careers site" })).toBeInTheDocument();
    expect(el).not.toHaveTextContent(/we apply|apply for you|auto-?apply/i);
  });

  it('the apply button opens apply.url in a new tab inside the click, and records the click', async () => {
    const net = installFetch({ 'POST /api/v1/roboapply/jobs/job_fixture_cn_board_1/apply-click': () => ok({ applyUrl: 'https://careers.example-tech.cn/jobs/744000012345678', tracker: { status: 'applied' }, undoToken: 'u1' }) });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    renderFeed(card(board), { brand: 'goapply' });
    fireEvent.click(screen.getByRole('button', { name: "Apply on the employer's careers site" }));
    expect(open).toHaveBeenCalledWith('https://careers.example-tech.cn/jobs/744000012345678', '_blank', 'noopener,noreferrer');
    await waitFor(() => expect(net.to('POST', '/api/v1/roboapply/jobs/job_fixture_cn_board_1/apply-click')).toHaveLength(1));
  });

  it('a bank row says the bank’s page and keeps the bank as its source', () => {
    installFetch({});
    renderFeed(card(bank), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).getByTestId('cn-source')).toHaveTextContent('Source: GoHire');
    expect(within(el).getByRole('button', { name: 'Apply on GoHire' })).toBeInTheDocument();
    expect(within(el).getByTestId('cn-original-link')).toHaveAttribute('href', 'https://www.gohire.top/postings/9001');
  });

  it('an item from before the contract renders as it did: its source, no original link, the bank wording only where the source says bank', () => {
    installFetch({});
    renderFeed(card(feedItemCnRecency as unknown as FeedItem), { brand: 'goapply' });
    const el = screen.getByTestId('job-card');
    expect(within(el).getByTestId('cn-source')).toHaveTextContent('Source: GoHire');
    expect(within(el).queryByTestId('cn-original-link')).toBeNull();
    expect(within(el).getByRole('button', { name: 'Apply on GoHire' })).toBeInTheDocument();
  });

  it('RoboApply is unchanged by the contract fields: the same button, the same source line, no GoApply block', () => {
    installFetch({});
    const item = { ...feedItem(1), source: { name: 'Greenhouse', kind: 'ats_public', original: 'Acme', url: 'https://boards.greenhouse.io/acme/jobs/1', lastVerifiedAt: '2026-10-11T02:00:00.000Z', via: 'ats' }, apply: { url: 'https://boards.greenhouse.io/acme/jobs/1', target: 'employer' } } as unknown as FeedItem;
    renderFeed(card(item, 'intl'));
    const el = screen.getByTestId('job-card');
    expect(within(el).getByRole('button', { name: 'Apply on company site' })).toBeInTheDocument();
    expect(within(el).getByTestId('source-line')).toHaveTextContent("From the company's job board (Greenhouse)");
    expect(within(el).queryByTestId('job-meta-cn')).toBeNull();
    expect(within(el).queryByTestId('cn-original-link')).toBeNull();
  });
});

describe('GoApply /jobs header and list', () => {
  it('says where the postings come from, shows the search links under a thin list, and says the list is by date', async () => {
    installPopupGate();
    installFetch(routes(feedResponseCnBoards));
    renderFeed(<JobsPage />, { brand: 'goapply' });
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
    const header = await screen.findByTestId('cn-feed-sources');
    expect(header).toHaveTextContent('From 27 employer careers sites.');
    expect(header).toHaveTextContent('not every job on the market');
    expect(header).not.toHaveTextContent('GoHire');
    const panel = screen.getByTestId('cn-external-search');
    expect(panel).toHaveAttribute('data-variant', 'thin');
    // It comes after the list, not instead of it.
    expect(Boolean(screen.getByTestId('job-card').compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // Ordered by date: the intro does not say "ranked by your resume".
    expect(screen.getByText('Jobs are listed by date posted, newest first. Open one to see the details.')).toBeInTheDocument();
  });

  it('names GoHire only when the response says its rows are listed; a full list shows no search panel', async () => {
    installPopupGate();
    installFetch(routes({ ...feedResponseCnBoards, items: [board, bank], sources: { gohire: true, employerBoards: 3 }, thin: false }));
    renderFeed(<JobsPage />, { brand: 'goapply' });
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(await screen.findByTestId('cn-feed-sources')).toHaveTextContent('From GoHire and 3 employer careers sites.');
    expect(screen.queryByTestId('cn-external-search')).toBeNull();
  });

  it('a response from before the contract: no header line, no panel, the list as before', async () => {
    installPopupGate();
    installFetch(routes(page([feedItemCnRecency as unknown as FeedItem])));
    renderFeed(<JobsPage />, { brand: 'goapply' });
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
    expect(screen.queryByTestId('cn-feed-sources')).toBeNull();
    expect(screen.queryByTestId('cn-external-search')).toBeNull();
  });

  it('no GoApply card is shown without a source: a public row that names none is left out', async () => {
    installPopupGate();
    const nameless = { ...board, jobId: 'job_nameless', source: { name: '', kind: 'ats_public' }, cardMeta: {} } as unknown as FeedItem;
    installFetch(routes({ ...feedResponseCnBoards, items: [board, nameless], thin: false }));
    renderFeed(<JobsPage />, { brand: 'goapply' });
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
    expect(screen.getByTestId('job-card')).toHaveAttribute('data-job-id', 'job_fixture_cn_board_1');
  });

  it('RoboApply: the same response fields change nothing (no sources line, no search panel, its intro)', async () => {
    installPopupGate();
    installFetch(routes({ ...page([feedItem(1), feedItem(2)]), sources: { gohire: true, employerBoards: 5 }, thin: true }));
    renderFeed(<JobsPage />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(screen.queryByTestId('cn-feed-sources')).toBeNull();
    expect(screen.queryByTestId('cn-external-search')).toBeNull();
    expect(screen.getByText(/Jobs ranked by how well your resume lines up with each post/)).toBeInTheDocument();
  });
});
