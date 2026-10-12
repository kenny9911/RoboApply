// MKT-5C — the job card's dates, "New" and the provider-reading badge as the
// card prints them (JI-10, JI-11), on both brands; and where the apply click
// sends a person (never to a posting that is gone).
//
//   dates   "Posted {date}" only for the employer's own date; a job whose
//           posting states none says when we first saw it; "Last checked" is
//           when a source last confirmed the posting listed
//   New     the server's `isNew` (first seen by us since the last visit), a
//           chip beside the fact badges, never one of the three
//   badge   a provider's sponsorship reading names the provider and has no quote

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { __toastStore } from '../../v3/primitives/Toast';
import { JobCard } from './JobCard';
import { fail, feedItem, installFetch, ok, renderFeed } from './feed.testkit';
import type { FeedItem } from '../../../lib/api/contracts/feed';

vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));
vi.mock('../../../hooks/useResumes', () => ({
  resumeKeys: { all: ['v2', 'resumes'] },
  useResumeList: () => ({ data: { resumes: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const card = (item: FeedItem, market: 'intl' | 'cn' = 'intl') => <JobCard item={item} position={0} market={market} />;

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

beforeEach(() => {
  installFetch({});
  __toastStore.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the card\'s dates are three separate facts (JI-10)', () => {
  it('ACCEPT: a board posting published long ago and first seen today shows its true posted date and the New chip', () => {
    renderFeed(card(feedItem(1, { postedAt: '2025-12-14T00:00:00.000Z', postedAtEstimated: false, firstSeenAt: '2026-10-12T07:00:00.000Z', lastSeenAt: '2026-10-12T07:00:00.000Z', isNew: true })));
    const meta = screen.getByTestId('card-meta');
    expect(within(meta).getByText(/^Posted Dec 14, 2025$/)).toBeInTheDocument();
    expect(within(meta).getByText(/^Last checked Oct 12, 2026$/)).toBeInTheDocument();
    expect(meta).not.toHaveTextContent('First seen');
    expect(screen.getByTestId('job-card-new')).toHaveTextContent('New');
  });

  it('ACCEPT: an open-data row (an estimated date) never says "Posted": when we first saw it, and "Last checked" from its last sighting', () => {
    renderFeed(card(feedItem(1, { postedAt: null, postedAtEstimated: true, firstSeenAt: '2026-10-09T03:00:00.000Z', lastSeenAt: '2026-10-11T03:00:00.000Z' })));
    const meta = screen.getByTestId('card-meta');
    expect(within(meta).getByText(/^First seen Oct 9, 2026$/)).toBeInTheDocument();
    expect(within(meta).getByText(/^Last checked Oct 11, 2026$/)).toBeInTheDocument();
    expect(screen.getByTestId('job-card')).not.toHaveTextContent(/Posted /);
    expect(meta).not.toHaveTextContent('Posting date not listed');
  });

  it('no posted date and no first-seen date: "Posting date not listed", and still "Last checked"', () => {
    renderFeed(card(feedItem(1, { postedAt: null, firstSeenAt: null })));
    const meta = screen.getByTestId('card-meta');
    expect(meta).toHaveTextContent('Posting date not listed');
    expect(meta).toHaveTextContent('Last checked');
  });

  it('a row first seen before the last visit has no New chip, whatever its posted date', () => {
    renderFeed(card(feedItem(1, { postedAt: new Date().toISOString(), isNew: false })));
    expect(screen.queryByTestId('job-card-new')).toBeNull();
    // A reserved "new" entry of the badge list is not read either.
    renderFeed(card(feedItem(2, { badges: [{ kind: 'new', label: 'new' }] })));
    expect(screen.queryByTestId('job-card-new')).toBeNull();
  });

  it('GoApply (D5): the New chip shows there too, also when the market block prints the dates', () => {
    renderFeed(card({ ...feedItem(1, { isNew: true, source: { name: 'GoHire', kind: 'bank' } }), cardMeta: CN_META } as FeedItem, 'cn'), { brand: 'goapply' });
    expect(screen.getByTestId('job-card-new')).toHaveTextContent('New');
    // The card's own date line is the market block's there.
    expect(screen.queryByTestId('card-meta')).toBeNull();
  });

  it('"New" sits beside the facts from the post, not among them: three fact badges and the chip', () => {
    renderFeed(
      card(
        feedItem(1, {
          isNew: true,
          fromRecruiterBank: true,
          employerVerified: true,
          badges: [
            { kind: 'sponsorship', label: 'sponsorship', quote: 'We sponsor H-1B visas.' },
            { kind: 'clearance_required', label: 'clearance_required', quote: 'Active clearance required.' },
          ],
        }),
      ),
    );
    const facts = screen.getByRole('list', { name: 'Facts from the post' });
    expect(within(facts).getAllByRole('listitem')).toHaveLength(3);
    expect(within(facts).queryByText('New')).toBeNull();
    expect(screen.getByTestId('job-card-new')).toBeInTheDocument();
  });
});

describe('a provider\'s sponsorship reading on the card (JI-11)', () => {
  it('names the provider, carries no quote, and is not the quoted badge', () => {
    renderFeed(card(feedItem(1, { badges: [{ kind: 'sponsorship_provider', label: 'sponsorship_provider', provider: 'Active Jobs DB' }] })));
    const facts = screen.getByRole('list', { name: 'Facts from the post' });
    const badge = within(facts).getByText('Active Jobs DB lists visa sponsorship');
    expect(badge).not.toHaveAttribute('title');
    expect(within(facts).queryByText('Visa sponsorship mentioned')).toBeNull();
  });

  it('the quoted badge is unchanged, with the sentence it rests on', () => {
    renderFeed(card(feedItem(1, { badges: [{ kind: 'sponsorship', label: 'sponsorship', quote: 'We sponsor H-1B visas.' }] })));
    const badge = screen.getByText('Visa sponsorship mentioned', { selector: '[title]' });
    expect(badge).toHaveAttribute('title', 'The post says: “We sponsor H-1B visas.”');
  });

  it('a reading with no provider name is not printed', () => {
    renderFeed(card(feedItem(1, { badges: [{ kind: 'sponsorship_provider', label: 'sponsorship_provider' }] })));
    expect(screen.queryByRole('list', { name: 'Facts from the post' })).toBeNull();
    expect(screen.getByTestId('job-card')).not.toHaveTextContent('lists visa sponsorship');
  });
});

describe('the apply click never sends a person to a posting that is gone (JI-10)', () => {
  const CLICK = 'POST /api/v1/roboapply/jobs/job_1/apply-click';
  const LINK_ON_CARD = 'https://boards.example.com/acme/1';
  const item = () => feedItem(1, { apply: { url: LINK_ON_CARD, target: 'employer' } } as Partial<FeedItem>);
  const newTab = () => ({ opener: {} as unknown, location: { href: '' }, close: vi.fn() });

  it('the tab is empty inside the click and goes to the link the server answers with', async () => {
    const tab = newTab();
    const open = vi.fn(() => tab);
    vi.stubGlobal('open', open);
    let answer: (r: Response) => void = () => {};
    const net = installFetch({ [CLICK]: () => new Promise<Response>((resolve) => (answer = resolve)) });
    renderFeed(card(item()));
    fireEvent.click(screen.getByRole('button', { name: 'Apply on company site' }));
    // Inside the click: an empty tab. The link the card holds is not opened.
    expect(open.mock.calls).toEqual([['about:blank', '_blank']]);
    expect(tab.location.href).toBe('');
    await waitFor(() => expect(net.to('POST', '/api/v1/roboapply/jobs/job_1/apply-click')).toHaveLength(1));
    answer(ok({ applyUrl: 'https://boards.example.com/acme/1?from=server', atsType: null, extensionSupported: false, trackerEntryId: 'te_1' }));
    await waitFor(() => expect(tab.location.href).toBe('https://boards.example.com/acme/1?from=server'));
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Moved to Applied\./)).toBeInTheDocument();
  });

  it.each([
    ['RoboApply', 'intl', 'roboapply', 'Apply on company site'],
    ['GoApply', 'cn', 'goapply', "Apply on the employer's careers site"],
  ] as const)('%s: 409 job_closed: no tab ever reaches the employer link, the card says the job is no longer listed, and there is no apply button', async (_brand, market, brand, button) => {
    const tab = newTab();
    const open = vi.fn(() => tab);
    vi.stubGlobal('open', open);
    installFetch({ [CLICK]: () => fail(409, 'conflict', { code: 'job_closed' }) });
    renderFeed(card(item(), market), { brand });
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(await screen.findByTestId('job-card-closed')).toHaveTextContent('This job is no longer listed');
    // The only tab was the empty one; it never went anywhere and was closed.
    expect(open.mock.calls).toEqual([['about:blank', '_blank']]);
    expect(tab.location.href).toBe('');
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: button })).toBeNull();
    expect(screen.queryByText(/Moved to Applied/)).toBeNull();
    // Said in plain words on the card, not as "That didn't work. Try again.".
    expect(__toastStore.get().some((t) => t.message === "That didn't work. Try again.")).toBe(false);
  });

  it("inside WeChat's browser (one window) no empty tab is opened, so the page is never replaced by a blank one; a posting that is gone opens nothing at all", async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50 NetType/WIFI Language/zh_CN' });
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const net = installFetch({ [CLICK]: () => fail(409, 'conflict', { code: 'job_closed' }) });
    renderFeed(card(item(), 'cn'), { brand: 'goapply' });
    fireEvent.click(screen.getByRole('button', { name: "Apply on the employer's careers site" }));
    expect(open).not.toHaveBeenCalled();
    await waitFor(() => expect(net.to('POST', '/api/v1/roboapply/jobs/job_1/apply-click')).toHaveLength(1));
    expect(await screen.findByTestId('job-card-closed')).toHaveTextContent('This job is no longer listed');
    expect(open).not.toHaveBeenCalled();
  });

  it('any other refused click keeps the plain error, keeps the apply button, and still opens nothing', async () => {
    const tab = newTab();
    const open = vi.fn(() => tab);
    vi.stubGlobal('open', open);
    installFetch({ [CLICK]: () => fail(500, 'internal_error') });
    renderFeed(card(item()));
    fireEvent.click(screen.getByRole('button', { name: 'Apply on company site' }));
    await waitFor(() => expect(__toastStore.get().some((t) => t.message === "That didn't work. Try again.")).toBe(true));
    expect(screen.queryByTestId('job-card-closed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply on company site' })).toBeEnabled();
    expect(tab.location.href).toBe('');
    expect(tab.close).toHaveBeenCalledTimes(1);
  });
});
