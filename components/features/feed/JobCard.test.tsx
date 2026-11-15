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
//
// Agent-driven redesign §6 — the action row with the `agent` flag on and off:
// one primary button per card ("Prepare application" with the flag, "Apply on
// company site" without), "Tailor resume" and "Ask about this job" in the "…"
// menu with the flag, and neither apply nor prepare for a job that was applied
// to or whose posting is gone. (The Tailor menu item: jobCard.int.test.tsx.)
//
// Redesign §9 — a job on the user's list says where it is before any tap (the
// item's `application`), and the card open in the split view is the selected
// one (still gap first, still the honesty line: R2, C5).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { __toastStore } from '../../v3/primitives/Toast';
import { __assistantRailStore } from '../../../hooks/shared/useOpenAssistant';
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

describe('the action row: one primary button, with the `agent` flag off and on (redesign §6)', () => {
  const CLICK = 'POST /api/v1/roboapply/jobs/job_1/apply-click';
  const QUEUE = 'POST /api/v1/roboapply/agent/queue';
  const row = () => screen.getByRole('group', { name: 'Actions for Backend engineer 1' });
  const rowLabels = () => within(row()).getAllByRole('button').map((b) => b.textContent);
  const primaries = () => [...screen.getByTestId('job-card').querySelectorAll('.btn.primary')].map((b) => b.textContent);
  const openMenu = () => {
    fireEvent.click(within(row()).getByRole('button', { name: 'More options' }));
    return screen.getByRole('menu', { name: 'More options' });
  };
  const menuLabels = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((b) => b.textContent);
  const queued = (state: string) => ({
    id: 'q_1',
    jobId: 'job_1',
    state,
    weekKey: '2026-W46',
    trackerEntryId: null,
    resumeVariantId: null,
    coverLetterId: null,
    missingFields: [],
    addedVia: 'feed',
    openedAt: null,
    userMarkedSubmitted: false,
    updatedAt: '2026-11-11T00:00:00.000Z',
  });

  beforeEach(() => {
    __assistantRailStore.reset();
  });

  it('flag off: the row is as before. "Apply on company site" is the one primary button, Ask sits in the row, there is no "Prepare application"', () => {
    const net = installFetch({});
    renderFeed(card(feedItem(1)), { flags: { copilot: true } });
    expect(rowLabels()).toEqual(['Save for later', 'Apply on company site', 'Ask about this job', '…']);
    expect(primaries()).toEqual(['Apply on company site']);
    expect(screen.queryByTestId('prepare-application')).toBeNull();
    expect(screen.queryByText('Prepare application')).toBeNull();
    // The menu holds what it held.
    expect(menuLabels(openMenu())).toEqual(['Not interested', 'Already applied', 'Report a problem', 'Share']);
    expect(net.to('POST', '/api/v1/roboapply/agent/queue')).toHaveLength(0);
  });

  it('flag on: "Prepare application" is the one primary button, "Apply on company site" is the second action in the default style, "Save for later" stays', () => {
    installFetch({});
    renderFeed(card(feedItem(1)), { flags: { agent: true, copilot: true } });
    expect(rowLabels()).toEqual(['Prepare application', 'Apply on company site', 'Save for later', '…']);
    expect(primaries()).toEqual(['Prepare application']);
    const apply = within(row()).getByRole('button', { name: 'Apply on company site' });
    expect(apply).toHaveClass('btn');
    expect(apply).not.toHaveClass('primary');
    expect(apply).not.toHaveClass('ghost');
    expect(within(row()).getByRole('button', { name: 'Save for later' })).toHaveAttribute('aria-pressed', 'false');
    // Tailor and Ask left the row.
    expect(within(row()).queryByRole('button', { name: 'Ask about this job' })).toBeNull();
    expect(within(row()).queryByRole('button', { name: /Tailor/ })).toBeNull();
  });

  it('flag on: the menu has a name and holds "Ask about this job", which opens the Assistant about this job', () => {
    installFetch({});
    renderFeed(card(feedItem(1)), { flags: { agent: true, copilot: true } });
    const menu = openMenu();
    expect(menuLabels(menu)).toEqual(['Ask about this job', 'Not interested', 'Already applied', 'Report a problem', 'Share']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Ask about this job' }));
    expect(__assistantRailStore.get()).toMatchObject({ open: true, request: { jobId: 'job_1', source: 'job_card' } });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('flag on without the Assistant (copilot off): no Ask anywhere, as before', () => {
    installFetch({});
    renderFeed(card(feedItem(1)), { flags: { agent: true } });
    expect(rowLabels()).toEqual(['Prepare application', 'Apply on company site', 'Save for later', '…']);
    expect(menuLabels(openMenu())).toEqual(['Not interested', 'Already applied', 'Report a problem', 'Share']);
  });

  it('the menu is reachable from the keyboard: its items are buttons in the tab order, and Escape closes it and gives focus back to "More options"', () => {
    installFetch({});
    renderFeed(card(feedItem(1)), { flags: { agent: true, copilot: true } });
    const more = within(row()).getByRole('button', { name: 'More options' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    const menu = openMenu();
    expect(more).toHaveAttribute('aria-expanded', 'true');
    for (const item of within(menu).getAllByRole('menuitem')) {
      expect(item.tagName).toBe('BUTTON');
      expect(item).not.toHaveAttribute('tabindex', '-1');
    }
    within(menu).getByRole('menuitem', { name: 'Ask about this job' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more).toHaveFocus();
  });

  it('flag on: "Apply on company site" does what it did (Applied at once, Undo); a job in Applied offers neither apply nor prepare, and Undo brings both back', async () => {
    vi.stubGlobal('open', vi.fn(() => ({ opener: null, location: { href: '' }, close: vi.fn() })));
    const net = installFetch({
      [CLICK]: () => ok({ applyUrl: 'https://jobs.example.com/1', atsType: null, extensionSupported: false, trackerEntryId: 'te_1' }),
      'DELETE /api/v1/roboapply/jobs/job_1/applied': () => ok(null),
    });
    renderFeed(card(feedItem(1)), { flags: { agent: true } });
    fireEvent.click(within(row()).getByRole('button', { name: 'Apply on company site' }));
    expect(await screen.findByText(/Moved to Applied\. You submit the application on their site\./)).toBeInTheDocument();
    expect(net.to('POST', '/api/v1/roboapply/jobs/job_1/apply-click')).toHaveLength(1);
    expect(rowLabels()).toEqual(['Save for later', '…']);
    expect(primaries()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: "Undo · I didn't apply" }));
    await waitFor(() => expect(net.to('DELETE', '/api/v1/roboapply/jobs/job_1/applied')).toHaveLength(1));
    await waitFor(() => expect(rowLabels()).toEqual(['Prepare application', 'Apply on company site', 'Save for later', '…']));
    expect(primaries()).toEqual(['Prepare application']);
  });

  it('flag on: a job already in the user\'s applications offers neither, like today', () => {
    installFetch({});
    renderFeed(card(feedItem(1, { tracker: { status: 'applied' } })), { flags: { agent: true } });
    expect(rowLabels()).toEqual(['Save for later', '…']);
    expect(screen.queryByTestId('prepare-application')).toBeNull();
  });

  it('flag on: a posting that is gone (409 job_closed) says so and offers neither apply nor prepare', async () => {
    vi.stubGlobal('open', vi.fn(() => ({ opener: null, location: { href: '' }, close: vi.fn() })));
    installFetch({ [CLICK]: () => fail(409, 'conflict', { code: 'job_closed' }) });
    renderFeed(card(feedItem(1)), { flags: { agent: true } });
    fireEvent.click(within(row()).getByRole('button', { name: 'Apply on company site' }));
    expect(await screen.findByTestId('job-card-closed')).toHaveTextContent('This job is no longer listed');
    expect(rowLabels()).toEqual(['Save for later', '…']);
    expect(screen.queryByTestId('prepare-application')).toBeNull();
    expect(primaries()).toEqual([]);
  });

  it('flag on: "Prepare application" puts this job on the list as added from the feed, then shows the cost before anything is spent', async () => {
    const net = installFetch({ [QUEUE]: () => ok({ items: [queued('picked')] }) });
    renderFeed(card(feedItem(1)), { flags: { agent: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    await waitFor(() => expect(net.to('POST', '/api/v1/roboapply/agent/queue')).toHaveLength(1));
    expect(net.to('POST', '/api/v1/roboapply/agent/queue')[0].body).toEqual({ jobIds: ['job_1'], addedVia: 'feed' });
    expect(await screen.findByTestId('prepare-sheet')).toBeInTheDocument();
    // Nothing was applied to and nothing moved: the card's own apply path was not touched.
    expect(net.to('POST', '/api/v1/roboapply/jobs/job_1/apply-click')).toHaveLength(0);
    expect(screen.queryByText(/Moved to Applied/)).toBeNull();
  });

  it('flag on: a job already being prepared turns the button into a link to it; "Apply on company site" stays', async () => {
    installFetch({ [QUEUE]: () => ok({ items: [queued('preparing')] }) });
    renderFeed(card(feedItem(1)), { flags: { agent: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));
    const link = await screen.findByRole('link', { name: 'Being prepared' });
    expect(link).toHaveAttribute('href', '/ready/job_1');
    expect(screen.queryByTestId('prepare-sheet')).toBeNull();
    expect(within(row()).getByRole('button', { name: 'Apply on company site' })).toBeEnabled();
    // Never two primary buttons.
    expect(primaries().length).toBeLessThanOrEqual(1);
  });

  it('GoApply (D5): the same row, with its own apply label', () => {
    installFetch({});
    renderFeed(card(feedItem(1, { apply: { url: 'https://boards.example.com/acme/1', target: 'employer' } } as Partial<FeedItem>), 'cn'), { brand: 'goapply', flags: { agent: true } });
    expect(rowLabels()).toEqual(['Prepare application', "Apply on the employer's careers site", 'Save for later', '…']);
    expect(primaries()).toEqual(['Prepare application']);
  });
});

describe("a job already on the user's list says where it is up front (redesign §9: the item carries `application`)", () => {
  const row = () => screen.getByRole('group', { name: 'Actions for Backend engineer 1' });
  const primaries = () => [...screen.getByTestId('job-card').querySelectorAll('.btn.primary')].map((b) => b.textContent);
  const listed = (state: NonNullable<FeedItem['application']>['state'], trackerEntryId: string | null = null) =>
    feedItem(1, { application: { state, trackerEntryId } });

  it('being prepared: a quiet link to the application, no "Prepare application", and no request', () => {
    const net = installFetch({});
    renderFeed(card(listed('preparing')), { flags: { agent: true } });
    const link = within(row()).getByRole('link', { name: 'Being prepared' });
    expect(link).toHaveAttribute('href', '/ready/job_1');
    expect(link).not.toHaveClass('primary');
    expect(within(row()).queryByRole('button', { name: 'Prepare application' })).toBeNull();
    // "Apply on company site" stays the second action; no primary button competes with a status.
    expect(within(row()).getByRole('button', { name: 'Apply on company site' })).toBeEnabled();
    expect(primaries()).toEqual([]);
    expect(net.to('POST', '/api/v1/roboapply/agent/queue')).toHaveLength(0);
  });

  it.each(['ready_for_review', 'approved'] as const)('%s: "Check and open" leads to the application page and keeps the card\'s one primary', (state) => {
    installFetch({});
    renderFeed(card(listed(state)), { flags: { agent: true } });
    const link = within(row()).getByRole('link', { name: 'Check and open' });
    expect(link).toHaveAttribute('href', '/ready/job_1');
    expect(primaries()).toEqual(['Check and open']);
  });

  it('a job on the list that can still be prepared, or one not on it, keeps the one-tap button and its flow', async () => {
    const net = installFetch({});
    for (const item of [listed('picked'), listed('failed'), feedItem(1, { application: null }), feedItem(1)]) {
      const view = renderFeed(card(item), { flags: { agent: true } });
      expect(within(row()).getByRole('button', { name: 'Prepare application' })).toBeEnabled();
      expect(primaries()).toEqual(['Prepare application']);
      view.unmount();
    }
    // Nothing is asked until the tap.
    expect(net.to('POST', '/api/v1/roboapply/agent/queue')).toHaveLength(0);
  });

  it('the agent flag off: the list state changes nothing on the card', () => {
    installFetch({});
    renderFeed(card(listed('ready_for_review')), { flags: {} });
    expect(screen.queryByTestId('prepare-application')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Check and open' })).toBeNull();
    expect(primaries()).toEqual(['Apply on company site']);
  });
});

describe('the job open in the split view is the selected card (resume.io look)', () => {
  it('marks only the active card, and its title link says so to assistive tech', () => {
    installFetch({});
    const view = renderFeed(<JobCard item={feedItem(1)} position={0} market="intl" active />);
    expect(screen.getByTestId('job-card')).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('link', { name: /Open Backend engineer 1 at/ })).toHaveAttribute('aria-current', 'true');
    view.unmount();
    renderFeed(<JobCard item={feedItem(1)} position={0} market="intl" />);
    expect(screen.getByTestId('job-card')).not.toHaveAttribute('data-active');
    expect(screen.getByRole('link', { name: /Open Backend engineer 1 at/ })).not.toHaveAttribute('aria-current');
  });

  it('keeps the gap first and the honesty line under the score (R2, C5)', () => {
    installFetch({});
    renderFeed(<JobCard item={feedItem(1)} position={0} market="intl" active />);
    const text = screen.getByTestId('job-card').textContent ?? '';
    expect(text.indexOf('Kubernetes')).toBeGreaterThan(-1);
    expect(text.indexOf('Kubernetes')).toBeLessThan(text.indexOf('72 / 100'));
    expect(screen.getByText('This is not your chance of getting hired.')).toBeInTheDocument();
  });
});
