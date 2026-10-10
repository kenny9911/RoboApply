// WP-41 — GoApply card meta (JobMetaCn via MarketJobMeta), SalaryCn and
// ExternalSearchLinks. Honesty: source + updated + expiry on every card,
// 企业直招 only from the server rule, tags only with a quote, deep links only
// from the user's query.

import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';

const api = vi.hoisted(() => ({ getExternalLinks: vi.fn() }));
vi.mock('../../../../../lib/api/cnJobs', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));

import { MarketJobMeta } from '../../MarketJobMeta';
import { CnFeedSources, ExternalSearchLinks, ExternalSearchPanel, SalaryCn, cnApplyCopy, readCnListing, readCnMeta, withListing, withOwnImport } from '..';
import { cnFeedSummary } from '../../../../../lib/api/cnJobs';
import { listingApply, listingSource } from '../../../../../lib/api/feed';
import { feedItem, feedItemCnBank, feedItemCnBoard, feedResponseCnBoards } from '../../../../../__tests__/fixtures/feed';

const META = {
  cn: {
    sourceLine: { kind: 'source', sourceName: 'GoHire', originalSourceName: '某公司官网', licence: { holder: '某某人力资源有限公司', number: '1100001234' } },
    salary: { text: '15-25K·13薪', disclosed: true },
    updatedAt: '2026-10-09T00:00:00.000Z',
    expiresAt: '2099-11-15T00:00:00.000Z',
    tags: [
      { tag: 'soe', evidenceQuote: '公司为中央企业下属单位', evidenceUrl: null },
      { tag: 'hukou', evidenceQuote: '' },
      { tag: 'bogus', evidenceQuote: 'x' },
    ],
    classYears: [{ year: 2027, evidenceQuote: '面向2027届毕业生' }],
    warnings: [],
  },
};

beforeEach(() => {
  api.getExternalLinks.mockReset();
});

describe('JobMetaCn (card)', () => {
  it('shows source, updated date, closing date and verbatim pay', () => {
    renderWithBrand(<MarketJobMeta jobId="j1" meta={META} variant="card" />, { brand: 'goapply' });
    const box = screen.getByTestId('job-meta-cn');
    expect(within(box).getByText('Source: GoHire')).toBeInTheDocument();
    expect(within(box).getByText(/^Updated /)).toBeInTheDocument();
    expect(within(box).getByText(/^Open until /)).toBeInTheDocument();
    expect(within(box).getByText('15-25K·13薪')).toBeInTheDocument();
    expect(within(box).queryByText('Direct from employer')).toBeNull();
  });

  // INT-06: the user's own job has no source name; the slot says whose it is.
  it('a job the user added reads "Added by you"; any other job with no source name reads "Source not listed"', () => {
    const noName = { cn: { ...META.cn, sourceLine: { kind: 'source', sourceName: null, originalSourceName: null, licence: null } } };
    for (const variant of ['card', 'detail'] as const) {
      const own = renderWithBrand(<MarketJobMeta jobId="j1" meta={withOwnImport(noName, true)} variant={variant} />, { brand: 'goapply' });
      expect(screen.getByTestId('cn-source')).toHaveTextContent('Added by you');
      expect(screen.getByTestId('job-meta-cn')).not.toHaveTextContent('Source not listed');
      own.unmount();
      const listed = renderWithBrand(<MarketJobMeta jobId="j1" meta={noName} variant={variant} />, { brand: 'goapply' });
      expect(screen.getByTestId('cn-source')).toHaveTextContent('Source not listed');
      listed.unmount();
    }
    // A named source is never replaced.
    renderWithBrand(<MarketJobMeta jobId="j1" meta={withOwnImport(META, true)} variant="card" />, { brand: 'goapply' });
    expect(screen.getByTestId('cn-source')).toHaveTextContent('Source: GoHire');
  });

  it('withOwnImport leaves the meta alone unless the job is the user\'s own and has a cn block', () => {
    const noCn = { ats_public: { country: 'TW' } };
    expect(withOwnImport(META, false)).toBe(META);
    expect(withOwnImport(noCn, true)).toBe(noCn);
    expect(withOwnImport(null, true)).toBeNull();
    expect(withOwnImport(undefined, true)).toBeUndefined();
    const marked = withOwnImport(META, true)!;
    expect(marked).not.toBe(META);
    expect(readCnMeta(marked)).toEqual(readCnMeta(META));
    expect(META.cn).not.toHaveProperty('ownImport');
  });

  it('"Last verified" shows our crawl date separately from the posting\'s own "Updated" date', () => {
    const { unmount } = renderWithBrand(<MarketJobMeta jobId="j1" meta={{ cn: { ...META.cn, lastCheckedAt: '2026-10-10T00:00:00.000Z' } }} variant="card" />, { brand: 'goapply' });
    expect(screen.getByText(/^Last verified /)).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    unmount();
    renderWithBrand(<MarketJobMeta jobId="j1" meta={META} variant="detail" />, { brand: 'goapply' });
    expect(screen.queryByText(/Last verified/)).toBeNull();
  });

  it('a tag without a quote never renders; quoted tags carry their quote', () => {
    renderWithBrand(<MarketJobMeta jobId="j1" meta={META} variant="card" />, { brand: 'goapply' });
    expect(screen.getByText('State-owned employer')).toHaveAttribute('title', 'The posting says: “公司为中央企业下属单位”');
    expect(screen.getByText('Class of 2027')).toBeInTheDocument();
    expect(screen.queryByText('Hukou support')).toBeNull();
    expect(screen.getByRole('list', { name: 'From the posting' }).children).toHaveLength(2);
  });

  it('unknown values read "not listed"; 企业直招 only when the server says direct', () => {
    const meta = { cn: { sourceLine: { kind: 'direct', sourceName: 'GoHire' }, salary: { text: null, disclosed: false }, updatedAt: null, expiresAt: null } };
    renderWithBrand(<MarketJobMeta jobId="j2" meta={meta} variant="card" />, { brand: 'goapply' });
    expect(screen.getByText('Direct from employer')).toBeInTheDocument();
    expect(screen.getByText('Pay not listed')).toBeInTheDocument();
    expect(screen.getByText('Update date not listed')).toBeInTheDocument();
    expect(screen.getByText('Closing date not listed')).toBeInTheDocument();
  });

  it('renders nothing without cn meta, and nothing on RoboApply', () => {
    const { container } = renderWithBrand(<MarketJobMeta jobId="j3" meta={null} variant="card" />, { brand: 'goapply' });
    expect(container.querySelector('[data-testid="job-meta-cn"]')).toBeNull();
    renderWithBrand(<MarketJobMeta jobId="j3" meta={META} variant="card" />, { brand: 'roboapply' });
    expect(screen.queryByTestId('job-meta-cn')).toBeNull();
  });

  it('own-import warnings show the evidence; AI-raised ones carry the AI label', () => {
    const meta = {
      cn: {
        ...META.cn,
        warnings: [
          { rule: 'upfront_fee', evidence: '入职需缴纳押金500元', ai: false },
          { rule: 'telecom_lure', evidence: '需先垫付任务金额', ai: true },
        ],
      },
    };
    const { container } = renderWithBrand(<MarketJobMeta jobId="j4" meta={meta} variant="card" />, { brand: 'goapply' });
    expect(screen.getByText('This post may be a scam')).toBeInTheDocument();
    expect(screen.getByText('Asks you to pay first')).toBeInTheDocument();
    expect(screen.getByText('The post says: “入职需缴纳押金500元”')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-ai-label]')).toHaveLength(1);
  });
});

// Parity wave (JC-1): every mainland posting that is not a recruiter-bank row
// names its original publisher, links to the original posting and says when it
// was last verified. The facts come from the contract's `source` / `apply`
// (lib/api/feed.ts readers), handed to the slot by `withListing`.
describe('JobMetaCn with the listing contract', () => {
  const BOARD_META = {
    cn: {
      sourceLine: { kind: 'source', sourceName: 'SmartRecruiters', originalSourceName: null, licence: null },
      salary: { text: null, disclosed: false },
      updatedAt: '2026-10-09T00:00:00.000Z',
      expiresAt: null,
      tags: [],
      classYears: [],
      warnings: [],
    },
  };
  const board = { source: listingSource(feedItemCnBoard), apply: listingApply(feedItemCnBoard) };
  const bank = { source: listingSource(feedItemCnBank), apply: listingApply(feedItemCnBank) };

  it.each(['card', 'detail'] as const)('%s: a board row shows 来源：the employer, the original link and the last-verified date', (variant) => {
    renderWithBrand(<MarketJobMeta jobId="j1" meta={withListing(BOARD_META, board)} variant={variant} />, { brand: 'goapply' });
    expect(screen.getByTestId('cn-source')).toHaveTextContent('Source: 示例科技有限公司');
    expect(screen.getByTestId('job-meta-cn')).not.toHaveTextContent('SmartRecruiters');
    const link = screen.getByTestId('cn-original-link');
    expect(link).toHaveAttribute('href', 'https://jobs.smartrecruiters.com/ExampleTech/744000012345678');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link).toHaveTextContent('Original posting');
    expect(screen.getByTestId('job-meta-cn')).toHaveTextContent(/Last verified .*2026/);
    // No pay stated: "Pay not listed", never a figure and never "negotiable".
    expect(screen.getByText('Pay not listed')).toBeInTheDocument();
  });

  it('a recruiter-bank row keeps the bank as its source, with the licence line only when the server sent one', () => {
    renderWithBrand(<MarketJobMeta jobId="j1" meta={withListing(META, bank)} variant="detail" />, { brand: 'goapply' });
    expect(screen.getByTestId('cn-source')).toHaveTextContent('Source: GoHire');
    expect(screen.getByText('某某人力资源有限公司, HR service licence 1100001234')).toBeInTheDocument();
    expect(screen.getByTestId('cn-original-link')).toHaveAttribute('href', 'https://www.gohire.top/postings/9001');
  });

  it('a board row with no publisher in the contract falls back to the names the card meta has, never to nothing', () => {
    const noOriginal = { source: { ...board.source, original: null }, apply: board.apply };
    renderWithBrand(<MarketJobMeta jobId="j1" meta={withListing(BOARD_META, noOriginal)} variant="card" />, { brand: 'goapply' });
    expect(screen.getByTestId('cn-source')).toHaveTextContent('Source: SmartRecruiters');
  });

  it('the user’s own job says "Added by you" and gets no original link', () => {
    const own = { source: { name: null, original: null, url: 'https://example.com/x', lastVerifiedAt: null, via: 'import' as const }, apply: { url: null, target: null } };
    const noName = { cn: { ...BOARD_META.cn, sourceLine: { kind: 'source', sourceName: null, originalSourceName: null, licence: null } } };
    renderWithBrand(<MarketJobMeta jobId="j1" meta={withListing(withOwnImport(noName, true), own)} variant="card" />, { brand: 'goapply' });
    expect(screen.getByTestId('cn-source')).toHaveTextContent('Added by you');
    expect(screen.queryByTestId('cn-original-link')).toBeNull();
  });

  it('withListing changes nothing without a cn block; readCnListing drops malformed values', () => {
    const noCn = { ats_public: { country: 'TW' } };
    expect(withListing(noCn, board)).toBe(noCn);
    expect(withListing(null, board)).toBeNull();
    expect(withListing(BOARD_META, null)).toBe(BOARD_META);
    expect(readCnListing(BOARD_META)).toEqual({ original: null, url: null, lastVerifiedAt: null, via: null, applyTarget: null });
    const bad = { cn: { ...BOARD_META.cn, listing: { original: ' ', url: 'javascript:alert(1)', lastVerifiedAt: 7, via: 'scrape', applyTarget: 'us' } } };
    expect(readCnListing(bad)).toEqual({ original: null, url: null, lastVerifiedAt: null, via: null, applyTarget: null });
    expect(readCnListing(withListing(BOARD_META, board))).toEqual({
      original: '示例科技有限公司',
      url: 'https://jobs.smartrecruiters.com/ExampleTech/744000012345678',
      lastVerifiedAt: '2026-10-11T02:00:00.000Z',
      via: 'ats',
      applyTarget: 'employer',
    });
  });

  it('a pay line that only says 面议 is shown as "Pay not listed"', () => {
    for (const text of ['面议', '薪资面议', '待遇面議']) {
      const meta = { cn: { ...BOARD_META.cn, salary: { text, disclosed: true } } };
      expect(readCnMeta(meta)!.salary).toEqual({ text: null, disclosed: false });
    }
    expect(readCnMeta({ cn: { ...BOARD_META.cn, salary: { text: '15-25K，可面议', disclosed: true } } })!.salary).toEqual({ text: '15-25K，可面议', disclosed: true });
  });

  it('cnApplyCopy: the employer’s careers site for a board row, the bank’s page for a bank row, nothing guessed otherwise', () => {
    expect(cnApplyCopy(board)).toEqual({ labelKey: 'apply.employer', hintKey: 'apply.employerHint', name: '' });
    expect(cnApplyCopy(bank)).toEqual({ labelKey: 'apply.bank', hintKey: 'apply.bankHint', name: 'GoHire' });
    expect(cnApplyCopy({ source: listingSource(feedItem), apply: listingApply(feedItem) })).toBeNull();
  });
});

describe('CnFeedSources (the list header)', () => {
  it('says how many employer careers sites the postings come from, and that it is not the whole market', () => {
    renderWithBrand(<CnFeedSources header={cnFeedSummary(feedResponseCnBoards).header} />, { brand: 'goapply' });
    const line = screen.getByTestId('cn-feed-sources');
    expect(line).toHaveTextContent('From 27 employer careers sites.');
    expect(line).toHaveTextContent('not every job on the market');
    expect(line).not.toHaveTextContent('GoHire');
  });

  it('names GoHire only when the response says GoHire rows are listed', () => {
    const both = renderWithBrand(<CnFeedSources header={cnFeedSummary({ ...feedResponseCnBoards, sources: { gohire: true, employerBoards: 1 } }).header} />, { brand: 'goapply' });
    expect(screen.getByTestId('cn-feed-sources')).toHaveTextContent('From GoHire and 1 employer careers site.');
    both.unmount();
    renderWithBrand(<CnFeedSources header={cnFeedSummary({ sources: { gohire: true, employerBoards: 0 } }).header} />, { brand: 'goapply' });
    expect(screen.getByTestId('cn-feed-sources')).toHaveTextContent('From GoHire.');
  });

  it('says nothing when the response names no source, and nothing on RoboApply', () => {
    expect(cnFeedSummary({ items: [] })).toEqual({ header: null, thin: false });
    expect(cnFeedSummary({ sources: { gohire: false, employerBoards: 0 }, thin: true })).toEqual({ header: null, thin: true });
    expect(cnFeedSummary({ sources: { gohire: 'yes', employerBoards: '27' } })).toEqual({ header: null, thin: false });
    const none = renderWithBrand(<CnFeedSources header={null} />, { brand: 'goapply' });
    expect(screen.queryByTestId('cn-feed-sources')).toBeNull();
    none.unmount();
    renderWithBrand(<CnFeedSources header={{ kind: 'boards', boards: 27 }} />, { brand: 'roboapply' });
    expect(screen.queryByTestId('cn-feed-sources')).toBeNull();
  });
});

describe('ExternalSearchPanel under a thin result set', () => {
  it('says few jobs match instead of saying nothing is listed', () => {
    api.getExternalLinks.mockResolvedValue({ links: [] });
    renderWithBrand(<ExternalSearchPanel variant="thin" initialQuery="数据分析师" />, { brand: 'goapply' });
    const panel = screen.getByTestId('cn-external-search');
    expect(panel).toHaveAttribute('data-variant', 'thin');
    expect(panel).toHaveTextContent('Only a few jobs match here.');
    expect(panel).not.toHaveTextContent('does not list jobs from other sites');
  });
});

describe('JobMetaCn (detail)', () => {
  it('prints the licence line, the original publisher and each tag quote', () => {
    renderWithBrand(<MarketJobMeta jobId="j1" meta={META} variant="detail" />, { brand: 'goapply' });
    expect(screen.getByRole('heading', { name: 'About this posting' })).toBeInTheDocument();
    expect(screen.getByText('某某人力资源有限公司, HR service licence 1100001234')).toBeInTheDocument();
    expect(screen.getByText('First posted on 某公司官网')).toBeInTheDocument();
    expect(screen.getByText('The posting says: “公司为中央企业下属单位”')).toBeInTheDocument();
  });
});

describe('readCnMeta', () => {
  it('drops malformed parts instead of guessing', () => {
    const m = readCnMeta({ cn: { sourceLine: { kind: 'weird' }, salary: { text: '10K', disclosed: false }, tags: 'nope', warnings: [{ rule: 'x' }] } });
    expect(m).toMatchObject({ sourceLine: { kind: 'source', sourceName: null, licence: null }, salary: { text: null, disclosed: false }, tags: [], warnings: [] });
    expect(readCnMeta({})).toBeNull();
  });
});

describe('SalaryCn', () => {
  it('verbatim or "Pay not listed"', () => {
    renderWithBrand(
      <>
        <SalaryCn text="200-300元/天" disclosed />
        <SalaryCn text="8K" disclosed={false} />
      </>,
      { brand: 'goapply' },
    );
    expect(screen.getByText('200-300元/天')).toBeInTheDocument();
    expect(screen.getByText('Pay not listed')).toBeInTheDocument();
  });
});

describe('ExternalSearchLinks', () => {
  it('links open in a new tab without referrer, from the user query only', async () => {
    api.getExternalLinks.mockResolvedValue({
      links: [
        { board: 'boss', label: 'BOSS直聘', url: 'https://www.zhipin.com/web/geek/job?query=%E4%BA%A7%E5%93%81' },
        { board: 'zhaopin', label: '智联招聘', url: 'https://sou.zhaopin.com/?kw=%E4%BA%A7%E5%93%81' },
      ],
    });
    renderWithBrand(<ExternalSearchLinks query=" 产品 " city="上海" />, { brand: 'goapply' });
    const link = await screen.findByRole('link', { name: /Search on BOSS直聘/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(api.getExternalLinks).toHaveBeenCalledWith({ q: '产品', city: '上海' }, expect.anything());
  });

  it('shows an error line when links cannot be built', async () => {
    api.getExternalLinks.mockRejectedValue(new Error('down'));
    renderWithBrand(<ExternalSearchLinks query="产品" />, { brand: 'goapply' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be prepared'));
  });

  it('renders nothing on RoboApply or for an empty query', () => {
    renderWithBrand(<ExternalSearchLinks query="product" />, { brand: 'roboapply' });
    renderWithBrand(<ExternalSearchLinks query="   " />, { brand: 'goapply' });
    expect(screen.queryByTestId('cn-external-links')).toBeNull();
    expect(api.getExternalLinks).not.toHaveBeenCalled();
  });
});

// INT-06 (wave3 WP-93 #8): the panel the jobs pages show while GoApply lists
// no third-party posts.
describe('ExternalSearchPanel', () => {
  const LINKS = { links: [{ board: 'boss', label: 'BOSS直聘', url: 'https://www.zhipin.com/web/geek/job?query=x' }] };

  it('asks for the user\'s own words and only then builds links for them', async () => {
    api.getExternalLinks.mockResolvedValue(LINKS);
    renderWithBrand(<ExternalSearchPanel />, { brand: 'goapply' });
    const panel = screen.getByTestId('cn-external-search');
    expect(within(panel).getByRole('heading', { level: 2, name: 'Search other job sites' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('does not list jobs from other sites here yet');
    expect(within(panel).getByRole('button', { name: 'Show search links' })).toBeDisabled();
    expect(api.getExternalLinks).not.toHaveBeenCalled();

    fireEvent.change(within(panel).getByLabelText('What job are you looking for?'), { target: { value: ' 产品经理 ' } });
    expect(api.getExternalLinks).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show search links' }));
    expect(await within(panel).findByRole('link', { name: /Search on BOSS直聘/ })).toHaveAttribute('target', '_blank');
    expect(api.getExternalLinks).toHaveBeenCalledTimes(1);
    expect(api.getExternalLinks).toHaveBeenCalledWith({ q: '产品经理' }, expect.anything());
  });

  /** The saved search arrives after the panel mounted (a late profile load). */
  function LateStart() {
    const [loaded, setLoaded] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setLoaded(true)}>
          load saved search
        </button>
        <ExternalSearchPanel initialQuery={loaded ? '数据分析' : null} city="上海" />
      </>
    );
  }

  it('starts from the saved search words, also when they load after the panel', async () => {
    api.getExternalLinks.mockResolvedValue(LINKS);
    renderWithBrand(<LateStart />, { brand: 'goapply' });
    expect(screen.getByLabelText('What job are you looking for?')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'load saved search' }));
    expect(screen.getByLabelText('What job are you looking for?')).toHaveValue('数据分析');
    await screen.findByRole('link', { name: /Search on BOSS直聘/ });
    expect(api.getExternalLinks).toHaveBeenCalledWith({ q: '数据分析', city: '上海' }, expect.anything());
  });

  it('words the user typed are not replaced by a saved search that loads later', () => {
    renderWithBrand(<LateStart />, { brand: 'goapply' });
    fireEvent.change(screen.getByLabelText('What job are you looking for?'), { target: { value: '运营' } });
    fireEvent.click(screen.getByRole('button', { name: 'load saved search' }));
    expect(screen.getByLabelText('What job are you looking for?')).toHaveValue('运营');
    expect(api.getExternalLinks).not.toHaveBeenCalled();
  });

  it('renders nothing on RoboApply', () => {
    renderWithBrand(<ExternalSearchPanel initialQuery="product manager" />, { brand: 'roboapply' });
    expect(screen.queryByTestId('cn-external-search')).toBeNull();
    expect(screen.queryByTestId('cn-external-links')).toBeNull();
    expect(api.getExternalLinks).not.toHaveBeenCalled();
  });
});
