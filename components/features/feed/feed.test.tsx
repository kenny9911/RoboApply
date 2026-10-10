// WP-33 — the /jobs workspace (TASK_PLAN.md WP-33 acceptance):
// tab routing, pagination append, undo apply, hide removes the card and shows
// the diff, the rating card after 10 cards through the popup gate, the
// zero-results relax buttons with counts, the tier view's hidden count, the
// mobile layout, no client-side filtering and no per-card score requests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { __setPopupGate } from '../../../lib/ui/popupGate';
import { __toastStore } from '../../v3/primitives/Toast';
import { __assistantChangeStore, noteAssistantFilterChange } from '../../../hooks/feed/useCalibration';
import { feedKeys } from '../../../hooks/feed/keys';
import { JobsWorkspace } from './JobsWorkspace';
import {
  EMPTY_UI_STATE,
  feedItem,
  fail,
  failReason,
  installFetch,
  installPopupGate,
  ok,
  page,
  profileList,
  renderFeed,
  searchProfile,
  type Route,
} from './feed.testkit';

const FEED = '/api/v1/roboapply/feed';
const PROFILES = '/api/v1/roboapply/search-profiles';
const UI_STATE = '/api/v1/roboapply/ui-state';


const nav = vi.hoisted(() => ({
  pathname: '/jobs',
  search: '',
  push: [] as string[],
  replace: [] as string[],
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    push: (href: string) => nav.push.push(href),
    replace: (href: string) => nav.replace.push(href),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({}),
}));

vi.mock('../job', () => ({
  JobDetailPanel: (p: { jobId: string; mode: string }) => <div data-testid="job-panel" data-job={p.jobId} data-mode={p.mode} />,
}));

function setDesktop(on: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: on && query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => feedItem(from + i));

function baseRoutes(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`GET ${PROFILES}`]: () => ok(profileList([searchProfile()])),
    [`GET ${UI_STATE}`]: () => ok(EMPTY_UI_STATE),
    [`PATCH ${UI_STATE}`]: () => ok(EMPTY_UI_STATE),
    [`POST ${FEED}/query`]: () => ok(page(items(1, 3))),
    [`POST ${FEED}/impressions`]: () => ok(null),
    ...over,
  };
}

beforeEach(() => {
  nav.pathname = '/jobs';
  nav.search = '';
  nav.push = [];
  nav.replace = [];
  setDesktop(false);
  installPopupGate();
  __toastStore.reset();
  __assistantChangeStore.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setPopupGate(null);
});

describe('/jobs workspace', () => {
  it('routes the tabs: For you is selected, Explore and Added by you push their routes', async () => {
    installFetch(baseRoutes());
    renderFeed(<JobsWorkspace />);
    const tabs = screen.getByRole('tablist', { name: 'Job lists' });
    expect(within(tabs).getByRole('tab', { name: 'For you' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Explore' }));
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Added by you' }));
    expect(nav.push).toEqual(['/jobs/explore', '/jobs/added']);
  });

  it('shows skeletons first, then every job the server returned (no client filtering) with fit from the batch', async () => {
    const odd = [feedItem(1, { pay: null, fit: null }), feedItem(2, { workModel: null, location: null }), feedItem(3)];
    const net = installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page(odd)) }));
    renderFeed(<JobsWorkspace />);
    expect(screen.getAllByTestId('card-skeleton').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(3));
    // Unknown pay is "Pay not listed", never 0; a job without a score shows no number.
    const first = screen.getAllByTestId('job-card')[0];
    expect(within(first).getByTestId('pay')).toHaveTextContent('Pay not listed');
    expect(within(first).queryByText(/\/ 100/)).toBeNull();
    // Scores come in the batch: no per-card score request.
    expect(net.calls.some((c) => /\/jobs\/[^/]+\/score$/.test(c.path))).toBe(false);
    expect(net.to('POST', `${FEED}/query`)[0].body).toMatchObject({ searchProfileId: 'sp_main', sort: 'recommended', fitTier: 'all' });
  });

  it('leads each card with the gap, then the overlap, the tier + score and the honesty line', async () => {
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page([feedItem(1)])) }));
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('job-card');
    const text = card.textContent ?? '';
    expect(text.indexOf('Kubernetes')).toBeLessThan(text.indexOf('Your Go work'));
    expect(text.indexOf('Your Go work')).toBeLessThan(text.indexOf('Backend engineer 1'));
    expect(within(card).getByText('Good fit')).toBeInTheDocument();
    expect(within(card).getByText('72 / 100')).toBeInTheDocument();
    expect(within(card).getByText('This is not your chance of getting hired.')).toBeInTheDocument();
    expect(within(card).getByText('Quick estimate')).toBeInTheDocument();
    expect(within(card).getByText('Source: Example Jobs API')).toBeInTheDocument();
  });

  it('appends the next page with the cursor', async () => {
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: (c) =>
          (c.body as { cursor?: string }).cursor === 'fs_1:20'
            ? ok(page(items(21, 20), { endOfFeed: true }))
            : ok(page(items(1, 20), { cursor: 'fs_1:20', endOfFeed: false })),
      }),
    );
    renderFeed(<JobsWorkspace />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(20));
    fireEvent.click(screen.getByRole('button', { name: 'Show more jobs' }));
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(40));
    expect(net.to('POST', `${FEED}/query`).map((c) => (c.body as { cursor?: string }).cursor)).toEqual([undefined, 'fs_1:20']);
    expect(screen.getByText(/That's every job your search finds/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more jobs' })).toBeNull();
  });

  it('an expired feed session (409 feed_session_expired) restarts the list from page 1', async () => {
    let expired = true;
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: (c) => {
          if ((c.body as { cursor?: string }).cursor === 'fs_1:20') {
            if (expired) {
              expired = false;
              return failReason(409, 'feed_session_expired');
            }
            return ok(page(items(21, 20), { endOfFeed: true }));
          }
          return ok(page(items(1, 20), { cursor: 'fs_1:20', endOfFeed: false }));
        },
      }),
    );
    renderFeed(<JobsWorkspace />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(20));
    fireEvent.click(screen.getByRole('button', { name: 'Show more jobs' }));
    await waitFor(() => expect(net.to('POST', `${FEED}/query`).map((c) => (c.body as { cursor?: string }).cursor)).toEqual([undefined, 'fs_1:20', undefined]));
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(20));
  });

  it('Apply on company site opens the employer page, moves to Applied, and Undo takes it back', async () => {
    const opened = vi.fn(() => ({ opener: null, location: { href: '' }, close: vi.fn() }));
    vi.stubGlobal('open', opened);
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1)])),
        'POST /api/v1/roboapply/jobs/job_1/apply-click': () => ok({ applyUrl: 'https://jobs.example.com/1', atsType: null, extensionSupported: false, trackerEntryId: 'te_1' }),
        'DELETE /api/v1/roboapply/jobs/job_1/applied': () => ok(null),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('job-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Apply on company site' }));
    expect(await within(card).findByText(/Moved to Applied\. You submit the application on their site\./)).toBeInTheDocument();
    expect(opened).toHaveBeenCalled();
    expect(net.to('POST', '/api/v1/roboapply/jobs/job_1/apply-click')).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'Undo · I didn\'t apply' }));
    await waitFor(() => expect(net.to('DELETE', '/api/v1/roboapply/jobs/job_1/applied')).toHaveLength(1));
    await waitFor(() => expect(within(card).queryByText(/Moved to Applied/)).toBeNull());
    expect(within(card).getByRole('button', { name: 'Apply on company site' })).toBeInTheDocument();
  });

  it('a failed Undo keeps the job in Applied with its Undo, and never says it moved back', async () => {
    vi.stubGlobal('open', vi.fn(() => ({ opener: null, location: { href: '' }, close: vi.fn() })));
    let undoFails = true;
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1)])),
        'POST /api/v1/roboapply/jobs/job_1/apply-click': () => ok({ applyUrl: 'https://jobs.example.com/1', atsType: null, extensionSupported: false, trackerEntryId: 'te_1' }),
        'DELETE /api/v1/roboapply/jobs/job_1/applied': () => (undoFails ? fail(500, 'internal') : ok(null)),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('job-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Apply on company site' }));
    await within(card).findByText(/Moved to Applied\./);
    fireEvent.click(within(card).getByRole('button', { name: 'Undo · I didn\'t apply' }));
    await waitFor(() => expect(net.to('DELETE', '/api/v1/roboapply/jobs/job_1/applied')).toHaveLength(1));
    await waitFor(() => expect(__toastStore.get().some((t) => t.message === "That didn't work. Try again.")).toBe(true));
    // Still Applied, the Undo is still there to retry, and no "moved back" claim.
    expect(within(card).getByText(/Moved to Applied\./)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Undo · I didn\'t apply' })).toBeEnabled();
    expect(within(card).queryByRole('button', { name: 'Apply on company site' })).toBeNull();
    expect(__toastStore.get().some((t) => t.message === 'Moved back out of Applied.')).toBe(false);
    // The retry works and only then says so.
    undoFails = false;
    fireEvent.click(within(card).getByRole('button', { name: 'Undo · I didn\'t apply' }));
    await waitFor(() => expect(within(card).queryByText(/Moved to Applied/)).toBeNull());
    expect(__toastStore.get().filter((t) => t.message === 'Moved back out of Applied.')).toHaveLength(1);
  });

  it('a failed hide says it once (in the sheet), a failed share once (its own toast)', async () => {
    installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1)])),
        'POST /api/v1/roboapply/feed/jobs/job_1/hide': () => fail(500, 'internal'),
        'POST /api/v1/roboapply/jobs/job_1/share': () => fail(500, 'internal'),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('job-card');
    fireEvent.click(within(card).getByRole('button', { name: 'More options' }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Not interested' }));
    const sheet = await screen.findByTestId('sheet');
    fireEvent.click(within(sheet).getByLabelText('This company'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Hide this job' }));
    expect(await within(screen.getByTestId('sheet')).findByRole('alert')).toHaveTextContent("That didn't work. Try again.");
    await act(async () => undefined);
    expect(__toastStore.get()).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(card).getByRole('button', { name: 'More options' }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Share' }));
    await waitFor(() => expect(__toastStore.get().some((t) => t.message === 'The link could not be made. Try again.')).toBe(true));
    await act(async () => undefined);
    expect(__toastStore.get()).toHaveLength(1);
  });

  it('a proposal that changes nothing is not offered: the sheet closes and the card goes', async () => {
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1), feedItem(2)])),
        'POST /api/v1/roboapply/feed/jobs/job_1/hide': () =>
          ok({ proposedFilterDiff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'add', path: 'companies/excluded', value: 'Example Co 1' }], countAfter: 41 } }),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = (await screen.findAllByTestId('job-card'))[0];
    fireEvent.click(within(card).getByRole('button', { name: 'More options' }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Not interested' }));
    fireEvent.click(within(await screen.findByTestId('sheet')).getByLabelText('This company'));
    fireEvent.click(within(screen.getByTestId('sheet')).getByRole('button', { name: 'Hide this job' }));
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
    expect(screen.queryByText('Change your search too?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save this change' })).toBeNull();
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
  });

  it('a post that says no sponsorship is labelled so, with its quote', async () => {
    // WP-32's real shape: the stance is the kind (feed/items.ts badgesFor).
    const badges: ReturnType<typeof feedItem>['badges'] = [{ kind: 'no_sponsorship', label: 'no_sponsorship', quote: 'We cannot sponsor visas.' }];
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page([feedItem(1, { badges })])) }));
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('job-card');
    expect(within(card).getByText('Says no visa sponsorship')).toBeInTheDocument();
    expect(within(card).queryByText('Visa sponsorship mentioned')).toBeNull();
    expect(within(card).getByText(/We cannot sponsor visas\./)).toBeInTheDocument();
  });

  it('GoApply employer tags render their copy, never the raw id', async () => {
    const badges: ReturnType<typeof feedItem>['badges'] = [{ kind: 'market_tag', label: 'soe', quote: '国有独资企业' }];
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page([feedItem(1, { badges })])) }));
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('job-card');
    expect(within(card).getByText('State-owned employer')).toBeInTheDocument();
    expect(within(card).queryByText('soe')).toBeNull();
  });

  it('opening the feed clears the Jobs nav badge once the list is on screen', async () => {
    installFetch(baseRoutes());
    const { QueryClient } = await import('@tanstack/react-query');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(feedKeys.newCount(), { count: 5, since: '2026-10-01T00:00:00.000Z' });
    renderFeed(<JobsWorkspace />, { client });
    await screen.findAllByTestId('job-card');
    await waitFor(() => expect(client.getQueryData(feedKeys.newCount())).toEqual({ count: 0, since: null }));
  });

  it('Save for later marks the job saved; a failed save is undone and said', async () => {
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1), feedItem(2)])),
        'POST /api/v1/roboapply/jobs/job_1/save': () => ok(null),
        'POST /api/v1/roboapply/jobs/job_2/save': () => fail(500, 'internal'),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const [one, two] = await screen.findAllByTestId('job-card');
    fireEvent.click(within(one).getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(net.to('POST', '/api/v1/roboapply/jobs/job_1/save')).toHaveLength(1));
    expect(within(one).getByRole('button', { name: 'Saved' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(two).getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(within(two).getByRole('button', { name: 'Save for later' })).toHaveAttribute('aria-pressed', 'false'));
    expect(__toastStore.get().some((t) => t.message === "That didn't work. Try again.")).toBe(true);
  });

  it('Not interested shows the filter change before saving, then removes the card', async () => {
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1), feedItem(2)])),
        'POST /api/v1/roboapply/feed/jobs/job_1/hide': () =>
          ok({ proposedFilterDiff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'add', path: 'excludedCompanies', value: 'Example Co 1' }], countAfter: 41 } }),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = (await screen.findAllByTestId('job-card'))[0];
    fireEvent.click(within(card).getByRole('button', { name: 'More options' }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Not interested' }));
    const sheet = await screen.findByTestId('sheet');
    fireEvent.click(within(sheet).getByLabelText('This company'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Hide this job' }));
    expect(await within(screen.getByTestId('sheet')).findByText('Change your search too?')).toBeInTheDocument();
    expect(within(screen.getByTestId('sheet')).getByText(/Example Co 1/)).toBeInTheDocument();
    expect(within(screen.getByTestId('sheet')).getByText('41 jobs would still show.')).toBeInTheDocument();
    // Nothing saved yet.
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
    expect(screen.getAllByTestId('job-card')).toHaveLength(2);
    fireEvent.click(within(screen.getByTestId('sheet')).getByRole('button', { name: 'Just hide this job' }));
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(0);
    expect(net.to('POST', '/api/v1/roboapply/feed/jobs/job_1/hide')[0].body).toEqual({ reasonCode: 'company' });
  });

  it('saving the proposed change sends one PATCH with the base version', async () => {
    const net = installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([feedItem(1)])),
        'POST /api/v1/roboapply/feed/jobs/job_1/hide': () =>
          ok({ proposedFilterDiff: { searchProfileId: 'sp_main', baseVersion: 3, ops: [{ op: 'add', path: 'excludedCompanies', value: 'Example Co 1' }], countAfter: null } }),
        [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4, filters: { excludedCompanies: ['Example Co 1'] } })),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('job-card');
    fireEvent.click(within(card).getByRole('button', { name: 'More options' }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Not interested' }));
    fireEvent.click(within(await screen.findByTestId('sheet')).getByLabelText('This company'));
    fireEvent.click(within(screen.getByTestId('sheet')).getByRole('button', { name: 'Hide this job' }));
    fireEvent.click(await within(screen.getByTestId('sheet')).findByRole('button', { name: 'Save this change' }));
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { excludedCompanies: ['Example Co 1'] } });
  });

  it('asks for a rating after 10 cards, through the popup gate', async () => {
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page(items(1, 12))) }));
    renderFeed(<JobsWorkspace />);
    expect(await screen.findByTestId('rating-card')).toBeInTheDocument();
    // It sits after the 10th card.
    const list = screen.getByRole('list', { name: 'Jobs for you' });
    const children = Array.from(list.children);
    const at = children.findIndex((li) => li.querySelector('[data-testid="rating-card"]'));
    expect(at).toBe(10);
  });

  it('no rating card when the gate gives the slot to another prompt, or before 10 cards', async () => {
    installPopupGate({ deny: true });
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page(items(1, 12))) }));
    const { unmount } = renderFeed(<JobsWorkspace />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(12));
    await act(async () => undefined);
    expect(screen.queryByTestId('rating-card')).toBeNull();
    unmount();

    installPopupGate();
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page(items(1, 9))) }));
    renderFeed(<JobsWorkspace />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(9));
    await act(async () => undefined);
    expect(screen.queryByTestId('rating-card')).toBeNull();
  });

  it('no rating card when the list was already rated today', async () => {
    const today = { ...EMPTY_UI_STATE, state: { ...EMPTY_UI_STATE.state, dismissals: { 'feed.rating': { count: 1, at: new Date().toISOString() } } } };
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page(items(1, 12))), [`GET ${UI_STATE}`]: () => ok(today) }));
    renderFeed(<JobsWorkspace />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(12));
    await act(async () => undefined);
    expect(screen.queryByTestId('rating-card')).toBeNull();
  });

  it('a low rating opens reasons and sends them', async () => {
    const net = installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page(items(1, 10))), [`POST ${FEED}/rating`]: () => ok(null) }));
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('rating-card');
    fireEvent.click(within(card).getByRole('button', { name: '5' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Jobs look old' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(net.to('POST', `${FEED}/rating`)).toHaveLength(1));
    expect(net.to('POST', `${FEED}/rating`)[0].body).toEqual({ score: 5, reasons: ['jobs_old'] });
    // The reason maps to a one-tap filter change.
    expect(await screen.findByRole('button', { name: 'Show jobs from the past week only' })).toBeInTheDocument();
  });

  it('a second rating the same day (409 feed_rating_already_today) says so and closes the card', async () => {
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => ok(page(items(1, 10))), [`POST ${FEED}/rating`]: () => failReason(409, 'feed_rating_already_today') }));
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('rating-card');
    fireEvent.click(within(card).getByRole('button', { name: '9' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByTestId('rating-card')).toBeNull());
  });

  it('a rating is marked done as soon as it is saved: applying a fix reloads the list without asking again', async () => {
    let version = 3;
    const net = installFetch(
      baseRoutes({
        [`GET ${PROFILES}`]: () => ok(profileList([searchProfile({ version })])),
        [`POST ${FEED}/query`]: () => ok(page(items(1, 12))),
        [`POST ${FEED}/rating`]: () => ok(null),
        [`PATCH ${PROFILES}/sp_main`]: () => {
          version = 4;
          return ok(searchProfile({ version: 4, filters: { postedWithinDays: 7 } }));
        },
        [`PATCH ${UI_STATE}`]: () =>
          ok({ ...EMPTY_UI_STATE, state: { ...EMPTY_UI_STATE.state, dismissals: { 'feed.rating': { count: 1, at: new Date().toISOString() } } } }),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('rating-card');
    fireEvent.click(within(card).getByRole('button', { name: '4' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Jobs look old' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    // Marked rated the moment the server accepted it — before any fix is used.
    await waitFor(() => expect(net.to('PATCH', UI_STATE).some((c) => JSON.stringify(c.body) === JSON.stringify({ dismiss: ['feed.rating'] }))).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Show jobs from the past week only' }));
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    // The search changed, so the list reloads; no second 0–10 card appears.
    await waitFor(() => expect(net.to('POST', `${FEED}/query`).length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(12));
    await act(async () => undefined);
    expect(screen.queryByTestId('rating-card')).toBeNull();
    expect(screen.queryByTestId('rating-fixes')).toBeNull();
    expect(net.to('POST', `${FEED}/rating`)).toHaveLength(1);
  });

  it('zero results lists each limiting filter with its real count and relaxes it in one PATCH', async () => {
    const profile = searchProfile({ filters: { workModels: ['remote'], postedWithinDays: 1 } });
    const net = installFetch(
      baseRoutes({
        [`GET ${PROFILES}`]: () => ok(profileList([profile])),
        [`POST ${FEED}/query`]: () => ok(page([])),
        [`GET ${PROFILES}/sp_main/limiting`]: () =>
          ok({ available: true, items: [{ field: 'workModels', value: 'remote', removalGain: 120 }, { field: 'postedWithinDays', value: 1, removalGain: 30 }, { field: 'skills', value: 'Go', removalGain: 0 }] }),
        [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4, filters: { postedWithinDays: 1 } })),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const panel = await screen.findByTestId('zero-results');
    expect(await within(panel).findByText("What's limiting your results:")).toBeInTheDocument();
    const buttons = await within(panel).findAllByRole('button', { name: /^Remove / });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('+120 jobs');
    expect(buttons[1]).toHaveTextContent('+30 jobs');
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filtersPatch: { workModels: null } });
  });

  it('zero results without counts says so and shows no number', async () => {
    installFetch(
      baseRoutes({
        [`POST ${FEED}/query`]: () => ok(page([])),
        [`GET ${PROFILES}/sp_main/limiting`]: () => ok({ available: false, items: [] }),
      }),
    );
    renderFeed(<JobsWorkspace />);
    const panel = await screen.findByTestId('zero-results');
    expect(await within(panel).findByText(/can't count which filter/)).toBeInTheDocument();
    expect(within(panel).queryByText(/\+\d/)).toBeNull();
  });

  it('the fit view shows how many weaker fits it hides', async () => {
    installFetch(
      baseRoutes({
        [`GET ${PROFILES}`]: () => ok(profileList([searchProfile({ filters: { fitTier: 'good' } })])),
        [`POST ${FEED}/query`]: () => ok(page(items(1, 2), { hiddenByTier: 37 })),
      }),
    );
    renderFeed(<JobsWorkspace />);
    expect(await screen.findByText(/37/)).toBeInTheDocument();
  });

  it('phone: the title opens /jobs/[id] (no split view)', async () => {
    installFetch(baseRoutes());
    renderFeed(<JobsWorkspace />);
    const link = (await screen.findAllByRole('link', { name: /Open Backend engineer 1 at/ }))[0];
    expect(link).toHaveAttribute('href', '/jobs/job_1');
    fireEvent.click(link);
    expect(nav.replace).toEqual([]);
    expect(screen.queryByTestId('split-detail')).toBeNull();
  });

  it('phone: a shared ?job= link opens the job page', async () => {
    nav.search = 'job=job_7';
    installFetch(baseRoutes());
    renderFeed(<JobsWorkspace />);
    await waitFor(() => expect(nav.replace).toContain('/jobs/job_7'));
  });

  it('desktop: the title opens the split detail via ?job=', async () => {
    setDesktop(true);
    installFetch(baseRoutes());
    const view = renderFeed(<JobsWorkspace />);
    const link = (await screen.findAllByRole('link', { name: /Open Backend engineer 2 at/ }))[0];
    fireEvent.click(link);
    expect(nav.replace).toEqual(['/jobs?job=job_2']);
    nav.search = 'job=job_2';
    view.rerender(<JobsWorkspace />);
    const panel = await screen.findByTestId('job-panel');
    expect(panel).toHaveAttribute('data-job', 'job_2');
    expect(panel).toHaveAttribute('data-mode', 'split');
    fireEvent.click(screen.getByRole('button', { name: 'Close job details' }));
    expect(nav.replace.at(-1)).toBe('/jobs');
  });

  it('a refused refresh says to wait, politely', async () => {
    installFetch(baseRoutes({ [`POST ${FEED}/query`]: () => failReason(429, 'feed_refresh_limited', { retryAfterSec: 600 }) }));
    renderFeed(<JobsWorkspace />);
    expect(await screen.findByText(/refreshed the list many times/)).toBeInTheDocument();
  });

  it('feed off (GoApply without a licence): no list, only the way to added jobs', async () => {
    const net = installFetch(baseRoutes());
    renderFeed(<JobsWorkspace />, { brand: 'goapply', flags: { 'jobs.feed': false } });
    expect(screen.getByText(/Job listings are not available here yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a job' })).toHaveAttribute('href', '/jobs/added');
    await act(async () => undefined);
    expect(net.to('POST', `${FEED}/query`)).toHaveLength(0);
  });

  it('header links the report only with the competitiveness flag; sort offers the ranking page', async () => {
    installFetch(baseRoutes());
    const { unmount } = renderFeed(<JobsWorkspace />);
    expect(screen.queryByRole('link', { name: 'You and what employers ask' })).toBeNull();
    expect(screen.getByRole('link', { name: 'How ranking works' })).toHaveAttribute('href', '/help/ranking');
    expect(screen.queryByRole('option', { name: 'Applications closing soonest' })).toBeNull();
    unmount();
    renderFeed(<JobsWorkspace />, { flags: { competitiveness: true } });
    expect(screen.getByRole('link', { name: 'You and what employers ask' })).toHaveAttribute('href', '/jobs/report');
  });

  it('changing the sort queries the new order', async () => {
    const net = installFetch(baseRoutes());
    renderFeed(<JobsWorkspace />);
    await screen.findAllByTestId('job-card');
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'best_fit' } });
    await waitFor(() => expect(net.to('POST', `${FEED}/query`).some((c) => (c.body as { sort: string }).sort === 'best_fit')).toBe(true));
  });

  it('after an Assistant change: "Not quite" restores the previous search', async () => {
    const net = installFetch(baseRoutes({ [`PATCH ${PROFILES}/sp_main`]: () => ok(searchProfile({ version: 4, filters: { q: 'data' } })) }));
    noteAssistantFilterChange({ searchProfileId: 'sp_main', before: { q: 'data' } });
    renderFeed(<JobsWorkspace />);
    const card = await screen.findByTestId('after-change');
    fireEvent.click(within(card).getByRole('button', { name: 'Not quite' }));
    await waitFor(() => expect(net.to('PATCH', `${PROFILES}/sp_main`)).toHaveLength(1));
    expect(net.to('PATCH', `${PROFILES}/sp_main`)[0].body).toEqual({ baseVersion: 3, filters: { q: 'data' } });
    await waitFor(() => expect(screen.queryByTestId('after-change')).toBeNull());
  });
});
