// FND-6a — the (auth) layout, AppShell, HybridShell and the Topbar's Ask.
//
// Acceptance: the rail slot never auto-opens on route change. Plus: the
// layout mounts its slots and feeds page views to the popup gate; a live
// practice room is full screen; HybridShell shows the app shell with a
// session and marketing chrome without one; Ask opens the rail only on
// click and only when the Assistant is on.
//
// INT-12 (WP-93):
//   • Ask shows with the `copilot` flag and no dev override (the surface is
//     flipped), and still never without the flag;
//   • the signed-out header CTA carries the page's `job`, `ref` and `utm_*`
//     through the marketing site's buildSignupHref (never a job title);
//   • the ⌘K palette searches jobs through the feed wrapper (`queryFeed`),
//     only where the job feed exists, and job hits go to /jobs/[id]. Typing
//     sends nothing: a first-page feed query spends the job list's refresh
//     budget (20 per 10 minutes), so it runs once, on Enter or a click on the
//     "Search jobs for …" row, and a refused search (429) has its own message;
//   • the app shell registers the device cleanup that lib/api/client.ts runs
//     when a session dies;
//   • the failed-renewal banner sits above the page on RoboApply.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue } from '../utils/mockAuth';
import { renderWithBrand } from './helpers';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const pathnameRef = { current: '/jobs' };
const searchRef = { current: '' };
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchRef.current),
  useParams: () => ({}),
}));

// The palette's job search goes through the feed wrapper and nothing else.
const feed = vi.hoisted(() => ({ queryFeed: vi.fn() }));
vi.mock('../../lib/api/feed', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/feed')>()),
  queryFeed: feed.queryFeed,
}));
const legacySearch = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../lib/api/v2', async (orig) => {
  const real = await orig<typeof import('../../lib/api/v2')>();
  return { ...real, raV2Api: { ...real.raV2Api, search: { ...real.raV2Api.search, run: legacySearch.run } } };
});

// What the app shell registers for a dying session (components/v3/shell/signOutCleanup.ts).
const device = vi.hoisted(() => ({ forgetPush: vi.fn(async () => undefined), clearDrafts: vi.fn() }));
vi.mock('../../hooks/pwa', async (orig) => ({
  ...(await orig<typeof import('../../hooks/pwa')>()),
  forgetPushDeviceOnSignOut: device.forgetPush,
}));
vi.mock('../../hooks/resume/useResumePhoto', async (orig) => ({
  ...(await orig<typeof import('../../hooks/resume/useResumePhoto')>()),
  clearResumeBuilderDeviceData: device.clearDrafts,
}));

// The failed-renewal banner reads the subscription state; controllable per test.
const billing = vi.hoisted(() => ({ paymentFailed: false }));
vi.mock('../../hooks/credits/useSubscriptionState', async (orig) => {
  const real = await orig<typeof import('../../hooks/credits/useSubscriptionState')>();
  return {
    ...real,
    useSubscriptionState: () => ({
      ...real.deriveSubscriptionState({ summary: null }),
      paymentFailed: billing.paymentFailed,
      hasPortal: true,
      refetch: () => undefined,
    }),
  };
});

const gateCalls = vi.hoisted(() => ({ views: [] as string[] }));
vi.mock('../../lib/ui/popupGate', async (orig) => {
  const real = await orig<typeof import('../../lib/ui/popupGate')>();
  return {
    ...real,
    notePageView: (v: string) => {
      gateCalls.views.push(v);
      real.notePageView(v);
    },
    usePopupGateSync: () => undefined,
  };
});

import AuthLayout from '../../app/(auth)/layout';
import { HybridShell, isPracticeLivePath, publicJobIdFromPath, signupHref } from '../../components/v3/shell/HybridShell';
import { Topbar } from '../../components/v3/shell/Topbar';
import {
  CommandPaletteProvider,
  PALETTE_JOB_LIMIT,
  PALETTE_MIN_QUERY,
  PALETTE_SEARCH_STALE_MS,
} from '../../components/v3/shell/CommandPalette';
import { __assistantRailStore, openAssistantRail } from '../../hooks/shared/useOpenAssistant';
import { RoboApiError, runSessionCleanups } from '../../lib/api/client';

beforeEach(() => {
  pathnameRef.current = '/jobs';
  searchRef.current = '';
  gateCalls.views = [];
  mockAuthState.value = buildAuthValue();
  __assistantRailStore.reset();
  routerPush.mockReset();
  feed.queryFeed.mockReset();
  legacySearch.run.mockReset();
  device.forgetPush.mockClear();
  device.clearDrafts.mockClear();
  billing.paymentFailed = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('(auth) layout', () => {
  it('renders the app shell around the page', () => {
    renderWithBrand(<AuthLayout><p>page body</p></AuthLayout>, { flags: {} });
    expect(screen.getByText('page body').closest('.main-inner')).not.toBeNull();
    expect(document.querySelector('aside.side')).not.toBeNull();
    expect(screen.getAllByRole('navigation', { name: 'Main navigation' }).length).toBeGreaterThan(0);
  });

  it('never opens the Assistant rail on route change', () => {
    const view = renderWithBrand(<AuthLayout><p>a</p></AuthLayout>, { flags: { copilot: true } });
    for (const path of ['/applications', '/resume/cm1', '/practice', '/settings', '/jobs']) {
      pathnameRef.current = path;
      view.rerender(<AuthLayout><p>{path}</p></AuthLayout>);
      expect(__assistantRailStore.get().open).toBe(false);
    }
    expect(__assistantRailStore.get().seq).toBe(0);
  });

  it('leaves an open rail alone on navigation (only the user closes it)', () => {
    const view = renderWithBrand(<AuthLayout><p>a</p></AuthLayout>, { flags: { copilot: true } });
    act(() => openAssistantRail({ jobId: 'cm_job', source: 'job_card' }));
    pathnameRef.current = '/applications';
    view.rerender(<AuthLayout><p>b</p></AuthLayout>);
    expect(__assistantRailStore.get()).toMatchObject({ open: true, seq: 1, request: { jobId: 'cm_job' } });
  });

  it('tells the popup gate about every page view', () => {
    const view = renderWithBrand(<AuthLayout><p>a</p></AuthLayout>, { flags: {} });
    pathnameRef.current = '/resume';
    view.rerender(<AuthLayout><p>b</p></AuthLayout>);
    expect(gateCalls.views).toEqual(['/jobs', '/resume']);
  });

  it('a live practice room is full screen: no rail, topbar or slots', () => {
    pathnameRef.current = '/practice/cm_session';
    renderWithBrand(<AuthLayout><p>live</p></AuthLayout>, { flags: {} });
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(document.querySelector('aside.side')).toBeNull();
    expect(document.querySelector('.topbar')).toBeNull();
    expect(gateCalls.views).toEqual([]);
    expect(isPracticeLivePath('/practice/cm_session/report')).toBe(false);
    expect(isPracticeLivePath('/practice/custom/x')).toBe(false);
    expect(isPracticeLivePath('/practice')).toBe(false);
    expect(isPracticeLivePath('/practice/questions')).toBe(false);
    expect(isPracticeLivePath('/practice/questions/')).toBe(false);
    expect(isPracticeLivePath('/practice/cm_session/')).toBe(true);
  });
});

describe('(auth) layout — INT-12 wiring', () => {
  it('registers the device cleanup while the shell is mounted, and removes it on unmount', async () => {
    await runSessionCleanups();
    expect(device.forgetPush).not.toHaveBeenCalled(); // nothing registered without a shell

    const view = renderWithBrand(<AuthLayout><p>page</p></AuthLayout>, { flags: {} });
    await runSessionCleanups(); // what lib/api/client.ts does on auth_expired
    expect(device.forgetPush).toHaveBeenCalledTimes(1);
    expect(device.clearDrafts).toHaveBeenCalledTimes(1);
    expect(device.forgetPush.mock.invocationCallOrder[0]).toBeLessThan(device.clearDrafts.mock.invocationCallOrder[0]);

    view.unmount();
    await runSessionCleanups();
    expect(device.forgetPush).toHaveBeenCalledTimes(1);
  });

  it('also in the full-screen practice room (a session can die there too)', async () => {
    pathnameRef.current = '/practice/cm_session';
    renderWithBrand(<AuthLayout><p>live</p></AuthLayout>, { flags: {} });
    await runSessionCleanups();
    expect(device.forgetPush).toHaveBeenCalledTimes(1);
  });

  it('shows the failed-renewal banner above the page on RoboApply; not on GoApply, not under /settings, not in the live room', () => {
    billing.paymentFailed = true;
    let view = renderWithBrand(<AuthLayout><p>page body</p></AuthLayout>, { flags: {} });
    const banner = screen.getByTestId('payment-failed');
    expect(banner.closest('.main-inner')).not.toBeNull();
    expect(banner.compareDocumentPosition(screen.getByText('page body')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.unmount();

    view = renderWithBrand(<AuthLayout><p>page body</p></AuthLayout>, { brand: 'goapply', flags: {} });
    expect(screen.queryByTestId('payment-failed')).toBeNull();
    view.unmount();

    pathnameRef.current = '/settings';
    view = renderWithBrand(<AuthLayout><p>page body</p></AuthLayout>, { flags: {} });
    expect(screen.queryByTestId('payment-failed')).toBeNull();
    view.unmount();

    pathnameRef.current = '/practice/cm_session';
    renderWithBrand(<AuthLayout><p>page body</p></AuthLayout>, { flags: {} });
    expect(screen.queryByTestId('payment-failed')).toBeNull();
  });

  it('shows no banner while payments are fine', () => {
    renderWithBrand(<AuthLayout><p>page body</p></AuthLayout>, { flags: {} });
    expect(screen.queryByTestId('payment-failed')).toBeNull();
  });
});

describe('Topbar Ask', () => {
  const renderTopbar = (flags: Record<string, boolean>) =>
    renderWithBrand(
      <CommandPaletteProvider>
        <Topbar />
      </CommandPaletteProvider>,
      { flags },
    );

  it('shows with the copilot flag and no dev override (the Assistant shipped; INT-12 flipped the surface), on both brands', () => {
    const ra = renderTopbar({ copilot: true });
    expect(screen.getByRole('button', { name: 'Ask the assistant' })).toBeInTheDocument();
    ra.unmount();
    renderWithBrand(
      <CommandPaletteProvider>
        <Topbar />
      </CommandPaletteProvider>,
      { brand: 'goapply', flags: { copilot: true } },
    );
    expect(screen.getByRole('button', { name: 'Ask the assistant' })).toBeInTheDocument();
  });

  it('is hidden when the copilot flag is off, even with the dev override', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderTopbar({});
    expect(screen.queryByRole('button', { name: 'Ask the assistant' })).not.toBeInTheDocument();
  });

  it('is hidden while the flags are still loading (fail closed)', () => {
    renderWithBrand(
      <CommandPaletteProvider>
        <Topbar />
      </CommandPaletteProvider>,
      { flags: null },
    );
    expect(screen.queryByRole('button', { name: 'Ask the assistant' })).not.toBeInTheDocument();
  });

  it('opens the rail on click', () => {
    renderTopbar({ copilot: true });
    expect(__assistantRailStore.get().open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }));
    expect(__assistantRailStore.get()).toMatchObject({ open: true, request: { source: 'topbar' } });
  });

  it('shows the crumb from the registry', () => {
    pathnameRef.current = '/settings/billing/history';
    renderTopbar({});
    expect(document.querySelector('.crumbs')).toHaveTextContent('Billing');
  });
});

describe('HybridShell', () => {
  it('signed in: the app shell', () => {
    renderWithBrand(<HybridShell from="campus"><p>campus page</p></HybridShell>, { flags: {} });
    expect(screen.getByText('campus page').closest('.main-inner')).not.toBeNull();
    expect(document.querySelector('[data-shell="marketing"]')).toBeNull();
  });

  it('signed out (or still loading): marketing chrome with attributed CTAs', () => {
    for (const status of ['unauthenticated', 'loading'] as const) {
      mockAuthState.value = buildAuthValue({ status, user: null });
      const { unmount } = renderWithBrand(<HybridShell from="campus"><p>campus page</p></HybridShell>, { brand: 'goapply', flags: {} });
      const chrome = document.querySelector('[data-shell="marketing"]') as HTMLElement;
      expect(chrome).not.toBeNull();
      expect(document.querySelector('aside.side')).toBeNull();
      expect(within(chrome).getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/signup?from=campus');
      expect(within(chrome).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
      // The brand name comes from the brand, never a literal.
      expect(within(chrome).getByRole('link', { name: 'GoApply home page' })).toHaveAttribute('href', '/');
      unmount();
    }
    expect(signupHref()).toBe('/signup');
  });
});

describe('HybridShell header CTA keeps job / ref / utm_* (buildSignupHref)', () => {
  const cta = () => within(document.querySelector('[data-shell="marketing"]') as HTMLElement).getByRole('link', { name: 'Get started' });
  const queryOf = (href: string) => Object.fromEntries(new URL(href, 'https://x.test').searchParams.entries());

  beforeEach(() => {
    mockAuthState.value = buildAuthValue({ status: 'unauthenticated', user: null });
  });

  it('/job/<id>-<slug>?utm_source=x&ref=abc → the CTA carries job, ref and utm_source, never the title', () => {
    pathnameRef.current = '/job/cmjob1abc-senior-data-analyst';
    searchRef.current = 'utm_source=x&ref=abc&jobTitle=Senior%20Data%20Analyst&email=a%40b.co';
    renderWithBrand(<HybridShell from="job"><p>job page</p></HybridShell>, { flags: {} });
    const href = cta().getAttribute('href')!;
    expect(href.startsWith('/signup?')).toBe(true);
    expect(queryOf(href)).toEqual({ from: 'job', job: 'cmjob1abc', ref: 'abc', utm_source: 'x' });
    expect(href).not.toMatch(/jobTitle|Senior|Analyst|email|%40/);
    expect(cta()).toHaveAttribute('data-cta-from', 'job');
  });

  it('the page’s own job wins over a stray ?job=, and every utm_* key travels', () => {
    pathnameRef.current = '/job/cmjob1abc-x';
    searchRef.current = 'job=other&utm_campaign=fall&utm_medium=email';
    renderWithBrand(<HybridShell from="job"><p>job page</p></HybridShell>, { brand: 'goapply', flags: {} });
    expect(queryOf(cta().getAttribute('href')!)).toEqual({ from: 'job', job: 'cmjob1abc', utm_campaign: 'fall', utm_medium: 'email' });
  });

  it('other public pages keep ref / utm_* / ?job=; a bare page is just /signup?from=<slug>', () => {
    pathnameRef.current = '/pricing';
    searchRef.current = 'ref=ABCD2345&job=cm9&utm_source=wechat';
    const view = renderWithBrand(<HybridShell from="pricing"><p>pricing</p></HybridShell>, { flags: {} });
    expect(queryOf(cta().getAttribute('href')!)).toEqual({ from: 'pricing', job: 'cm9', ref: 'ABCD2345', utm_source: 'wechat' });
    view.unmount();

    searchRef.current = '';
    renderWithBrand(<HybridShell from="pricing"><p>pricing</p></HybridShell>, { flags: {} });
    expect(cta()).toHaveAttribute('href', '/signup?from=pricing');
  });

  it('signupHref / publicJobIdFromPath (pure)', () => {
    expect(publicJobIdFromPath('/job/cmjob1abc-senior-data-analyst')).toBe('cmjob1abc');
    expect(publicJobIdFromPath('/job/cmjob1abc')).toBe('cmjob1abc');
    expect(publicJobIdFromPath('/job/%E8%81%8C%E4%BD%8D-x')).toBeNull(); // not an id
    expect(publicJobIdFromPath('/jobs/cmjob1abc')).toBeNull(); // the signed-in page, not the public one
    expect(publicJobIdFromPath('/job/a/b')).toBeNull();
    expect(signupHref('browse', { pathname: '/browse/data-analyst', search: '?utm_source=g' })).toBe('/signup?from=browse&utm_source=g');
    expect(queryOf(signupHref(undefined, { pathname: '/job/cm1-x', search: 'ref=r1' }))).toEqual({ job: 'cm1', ref: 'r1' });
    expect(signupHref('job', { pathname: '/job/cm1-x', search: 'ref=has space' })).toBe('/signup?from=job&job=cm1');
  });
});

describe('⌘K palette searches jobs through the feed wrapper', () => {
  const item = (jobId: string, title: string, company: string) => ({ jobId, title, company: { id: null, name: company, logoUrl: null } });
  const page = (items: unknown[]) => ({ items, cursor: null, endOfFeed: true, hiddenByTier: 0, sessionId: 's1' });
  const open = () => fireEvent.click(screen.getAllByRole('button', { name: /Search jobs and companies|Jump to a page/ })[0]);
  const renderShell = (flags: Record<string, boolean>, brand: 'roboapply' | 'goapply' = 'roboapply') =>
    renderWithBrand(
      <CommandPaletteProvider>
        <Topbar />
      </CommandPaletteProvider>,
      { brand, flags },
    );
  const dialog = () => screen.getByRole('dialog');
  const type = (value: string) => fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value } });
  const enter = () => fireEvent.keyDown(window, { key: 'Enter' });
  const searchRow = (q: string) => within(dialog()).queryByRole('button', { name: `Search jobs for “${q}”` });
  /** A failed call shaped like the feed's 429 (`rate_limited`, `details.reason: feed_refresh_limited`). */
  const refreshLimitedError = () =>
    new RoboApiError('You refreshed the list many times in a few minutes. Try again shortly.', {
      code: 'rate_limited',
      status: 429,
      payload: { code: 'rate_limited', details: { reason: 'feed_refresh_limited', retryAfterSec: 240 } },
    });

  it('typing sends nothing: a first-page feed query is a list refresh, so it runs only when asked for', async () => {
    feed.queryFeed.mockResolvedValue(page([item('cm_job1', 'Data Analyst', 'Acme')]));
    renderShell({ 'jobs.feed': true });
    open();
    // A phrase typed with pauses: the old palette sent one request per pause.
    for (const partial of ['da', 'data', 'data an', 'data analyst']) {
      type(partial);
      await new Promise((r) => setTimeout(r, 220));
    }
    expect(feed.queryFeed).not.toHaveBeenCalled();
    expect(searchRow('data analyst')).toBeInTheDocument();
    expect(within(dialog()).queryByText('Data Analyst')).toBeNull();
  });

  it('Enter runs ONE queryFeed({ q }) — never the old /v2/search client — and lists the first hits', async () => {
    feed.queryFeed.mockResolvedValue(page(Array.from({ length: PALETTE_JOB_LIMIT + 3 }, (_, i) => item(`cm_job${i}`, `Data Analyst ${i}`, 'Acme'))));
    renderShell({ 'jobs.feed': true });
    open();
    type('data analyst');
    enter();

    await waitFor(() => expect(feed.queryFeed).toHaveBeenCalledTimes(1));
    expect(feed.queryFeed.mock.calls[0][0]).toEqual({ q: 'data analyst' });
    expect(legacySearch.run).not.toHaveBeenCalled();

    expect(await within(dialog()).findByText('Data Analyst 0')).toBeInTheDocument();
    expect(within(dialog()).getAllByText(/^Data Analyst \d+$/)).toHaveLength(PALETTE_JOB_LIMIT);
    // The search row is gone once the search was asked for; Enter again opens the first hit.
    expect(searchRow('data analyst')).toBeNull();
    enter();
    expect(routerPush).toHaveBeenCalledWith('/jobs/cm_job0');
    expect(feed.queryFeed).toHaveBeenCalledTimes(1);
  });

  it('a click on the search row searches too; the same search again is answered from the cache', async () => {
    feed.queryFeed.mockResolvedValue(page([item('cm_job1', 'Staff Engineer', 'Globex')]));
    renderShell({ 'jobs.feed': true });
    open();
    type('staff');
    fireEvent.click(searchRow('staff')!);
    expect(await within(dialog()).findByText('Staff Engineer')).toBeInTheDocument();

    // Edit the text: the hits go, nothing is sent. Back to the same text and
    // Enter: the hits return without a second refresh.
    type('staffing');
    expect(within(dialog()).queryByText('Staff Engineer')).toBeNull();
    type('staff');
    expect(within(dialog()).queryByText('Staff Engineer')).toBeNull();
    enter();
    expect(await within(dialog()).findByText('Staff Engineer')).toBeInTheDocument();
    expect(feed.queryFeed).toHaveBeenCalledTimes(1);
    expect(PALETTE_SEARCH_STALE_MS).toBe(10 * 60 * 1000);
  });

  it('a job hit goes to /jobs/[id]', async () => {
    feed.queryFeed.mockResolvedValue(page([item('cm job/1', 'Staff Engineer', 'Globex')]));
    renderShell({ 'jobs.feed': true });
    open();
    type('staff');
    enter();
    fireEvent.click(await within(dialog()).findByText('Staff Engineer'));
    expect(routerPush).toHaveBeenCalledWith('/jobs/cm%20job%2F1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a page that matches comes first: Enter goes to the page, the search row is one step down', async () => {
    feed.queryFeed.mockResolvedValue(page([item('cm_job1', 'Resume Writer', 'Acme')]));
    renderShell({ 'jobs.feed': true });
    open();
    type('resume');
    expect(within(dialog()).getByText('Resume')).toBeInTheDocument();
    expect(searchRow('resume')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    enter();
    expect(await within(dialog()).findByText('Resume Writer')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
    // The highlight is on the first hit, under the page.
    enter();
    expect(routerPush).toHaveBeenCalledWith('/jobs/cm_job1');
  });

  it('an Enter that confirms an input-method candidate does not search', async () => {
    renderShell({ 'jobs.feed': true });
    open();
    type('工程');
    fireEvent.keyDown(window, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(window, { key: 'Enter', keyCode: 229 });
    await new Promise((r) => setTimeout(r, 50));
    expect(feed.queryFeed).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('fewer than two characters offers no search and sends nothing; nav targets still filter', async () => {
    renderShell({ 'jobs.feed': true });
    open();
    type('r');
    expect(searchRow('r')).toBeNull();
    await new Promise((r) => setTimeout(r, 250));
    expect(feed.queryFeed).not.toHaveBeenCalled();
    expect(within(dialog()).getByText('Resume')).toBeInTheDocument();
    // No page and no search to offer: Enter does nothing.
    type('z');
    enter();
    await new Promise((r) => setTimeout(r, 50));
    expect(feed.queryFeed).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(PALETTE_MIN_QUERY).toBe(2);
  });

  it('a failed search says so, is never shown as "nothing found", and can be tried again', async () => {
    feed.queryFeed.mockRejectedValueOnce(new Error('boom'));
    renderShell({ 'jobs.feed': true });
    open();
    type('zzzz');
    enter();
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('The search did not work. Try again.');
    expect(within(dialog()).queryByText(/Nothing found|No job in your list matches/)).toBeNull();

    // The search row is back; using it asks again.
    feed.queryFeed.mockResolvedValue(page([item('cm_job1', 'Zzzz Keeper', 'Acme')]));
    fireEvent.click(searchRow('zzzz')!);
    expect(await within(dialog()).findByText('Zzzz Keeper')).toBeInTheDocument();
    expect(within(dialog()).queryByRole('alert')).toBeNull();
    expect(feed.queryFeed).toHaveBeenCalledTimes(2);
  });

  it('a search the server refused because the refresh budget is used up has its own message and no retry row', async () => {
    feed.queryFeed.mockRejectedValue(refreshLimitedError());
    renderShell({ 'jobs.feed': true });
    open();
    type('zzzz');
    enter();
    const alert = await within(dialog()).findByRole('alert');
    expect(alert).toHaveTextContent('You have searched or refreshed the job list many times in the last few minutes. Wait a few minutes, then try again.');
    expect(alert).not.toHaveTextContent('The search did not work');
    expect(within(dialog()).queryByText(/Nothing found|No job in your list matches/)).toBeNull();
    // No row to hammer the limit with: Enter sends nothing more.
    expect(searchRow('zzzz')).toBeNull();
    enter();
    await new Promise((r) => setTimeout(r, 50));
    expect(feed.queryFeed).toHaveBeenCalledTimes(1);
  });

  it('nothing found is said only after a search that worked, and says the saved-search filters apply', async () => {
    feed.queryFeed.mockResolvedValue(page([]));
    renderShell({ 'jobs.feed': true });
    open();
    type('zzzz');
    expect(within(dialog()).queryByText(/No job in your list matches/)).toBeNull();
    enter();
    expect(
      await within(dialog()).findByText('No job in your list matches. The filters of your saved search apply here too.'),
    ).toBeInTheDocument();
  });

  it('GoApply with the job feed off: a page jumper that says so, and no job request at all', async () => {
    renderShell({}, 'goapply');
    // The Topbar button does not promise a job search.
    expect(screen.queryByRole('button', { name: 'Search jobs and companies' })).toBeNull();
    open();
    expect(within(dialog()).getByPlaceholderText('Jump to a page…')).toBeInTheDocument();
    type('zzzz');
    expect(within(dialog()).queryByRole('button', { name: /Search jobs for/ })).toBeNull();
    enter();
    await new Promise((r) => setTimeout(r, 50));
    expect(feed.queryFeed).not.toHaveBeenCalled();
    expect(within(dialog()).getByText('No page with that name.')).toBeInTheDocument();
    // Its quick-nav lists GoApply's own pages. 职位 is one of them (D5: the entry carries no flag;
    // with the feed off the page says so and still lists the jobs the user added).
    type('');
    await waitFor(() => expect(within(dialog()).getByText('Interview practice')).toBeInTheDocument());
    expect(within(dialog()).getByText('Jobs')).toBeInTheDocument();
  });

  it('the palette source: the feed wrapper only, and no request tied to typing', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'components/v3/shell/CommandPalette.tsx'), 'utf8');
    expect(source).not.toMatch(/from '[^']*lib\/api\/v2'/);
    expect(source).not.toMatch(/raV2Api\.search\.run\(/);
    expect(source).toMatch(/queryFeed\(\{ q: term \}/);
    // No debounce feeding the query, and no refetch the user did not ask for.
    expect(source).not.toMatch(/setDebounced|debounced/);
    expect(source).toMatch(/refetchOnWindowFocus: false/);
    expect(source).toMatch(/refetchOnReconnect: false/);
  });
});
