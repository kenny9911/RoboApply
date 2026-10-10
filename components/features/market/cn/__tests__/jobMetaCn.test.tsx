// WP-41 — GoApply card meta (JobMetaCn via MarketJobMeta), SalaryCn and
// ExternalSearchLinks. Honesty: source + updated + expiry on every card,
// 企业直招 only from the server rule, tags only with a quote, deep links only
// from the user's query.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';

import { renderWithBrand } from '../../../../../__tests__/shell/helpers';

const api = vi.hoisted(() => ({ getExternalLinks: vi.fn() }));
vi.mock('../../../../../lib/api/cnJobs', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...api }));

import { MarketJobMeta } from '../../MarketJobMeta';
import { ExternalSearchLinks, SalaryCn, readCnMeta } from '..';

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

  it('"Last checked" shows our crawl date separately from the posting\'s own "Updated" date', () => {
    const { unmount } = renderWithBrand(<MarketJobMeta jobId="j1" meta={{ cn: { ...META.cn, lastCheckedAt: '2026-10-10T00:00:00.000Z' } }} variant="card" />, { brand: 'goapply' });
    expect(screen.getByText(/^Last checked /)).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    unmount();
    renderWithBrand(<MarketJobMeta jobId="j1" meta={META} variant="detail" />, { brand: 'goapply' });
    expect(screen.queryByText(/Last checked/)).toBeNull();
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
