// The first-visit prompts inside the app shell, with the REAL popup gate.
//
// Review finding: the shell (app/(auth)/layout.tsx AuthLayoutSlots) notes the
// page view in its own effect and hosts <TourOverlay /> as a child. React runs
// the child's effect first, so a prompt that mounted in the same commit as the
// route change asked under the old view and was denied:
//   - the tour after "Show my jobs" (client navigation with /auth/me already
//     at step 'tour'), which left onboarding stuck at 'tour';
//   - the "Finish setting up" banner on every in-app return to /jobs with warm
//     caches (it showed only on a hard load).
// tour.test.tsx replaces usePopupGate, so it cannot see this. 375 px, fetch
// double only.

import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';

const page = vi.hoisted(() => ({ pathname: '/resume' }));
vi.mock('next/navigation', async (orig) => {
  const real = await orig<typeof import('next/navigation')>();
  return { ...real, usePathname: () => page.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) };
});
const auth = vi.hoisted(() => ({ value: { status: 'authenticated', refresh: vi.fn(async () => null), me: null as unknown } }));
vi.mock('../../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => auth.value,
}));
vi.mock('../growth', () => ({ GettingStartedChecklist: () => <p>Checklist card</p> }));

import { __setPopupGate, getPopupGate, notePageView, UI_STATE_QUERY_KEY } from '../../../lib/ui/popupGate';
import { onboardingKeys } from '../../../hooks/onboarding/useOnboarding';
import { installFetch, ok, renderWith } from '../filters/filters.testkit';
import { FINISH_BANNER_POPUP_KEY } from './FirstVisitPrompts';
import { TourOverlay } from './TourOverlay';

const P = '/api/v1/roboapply/onboarding';
const me = (step: string, completed = false) => ({ onboarding: { step, path: null, completed, nextRoute: completed ? null : '/jobs' } });
const ui = { state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} }, lastFeedVisitAt: null, updatedAt: null };
const leftEarly = {
  brand: 'roboapply',
  stage: 'basics',
  nextRoute: '/onboarding/basics',
  branch: 'urgent',
  answers: {},
  entry: null,
  completed: false,
  progress: { total: 5, stepsLeft: 4, leftEarly: { at: 'x', stage: 'basics' } },
  defaults: { country: null },
};

/** Same order as AuthLayoutSlots: the overlay is a child, the page view is noted in the parent's effect. */
function Shell() {
  const pathname = page.pathname;
  useEffect(() => {
    notePageView(pathname);
  }, [pathname]);
  return <TourOverlay />;
}

beforeEach(() => {
  page.pathname = '/resume';
  auth.value = { status: 'authenticated', refresh: vi.fn(async () => null), me: null };
  __setPopupGate(null);
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setPopupGate(null);
  window.localStorage.clear();
});

describe('first-visit prompts mount in the same commit as the route change', () => {
  it('the tour shows on the first arrival at /jobs from onboarding (stage already "tour")', async () => {
    auth.value.me = me('tour');
    installFetch({});
    page.pathname = '/onboarding/confirm';
    const view = renderWith(<Shell />);
    expect(view.container).toBeEmptyDOMElement();
    // "Show my jobs": the shell and the tour gate reach /jobs in one commit.
    page.pathname = '/jobs';
    view.rerender(<Shell />);
    expect(await screen.findByText("Why you fit and what's missing")).toBeInTheDocument();
    expect(getPopupGate().snapshot()).toMatchObject({ viewKey: '/jobs', shownThisView: 'onboarding:tour' });
  });

  it('the tour shows when the shell itself mounts on /jobs (hard load with the session already known)', async () => {
    auth.value.me = me('tour');
    installFetch({});
    page.pathname = '/jobs';
    renderWith(<Shell />);
    expect(await screen.findByText("Why you fit and what's missing")).toBeInTheDocument();
  });

  it('the finish banner shows on an in-app return to /jobs with warm caches', async () => {
    auth.value.me = me('done', true);
    const net = installFetch({ [`GET ${P}/state`]: () => ok(leftEarly), 'GET /api/v1/roboapply/ui-state': () => ok(ui) });
    // The shell keeps ui-state warm and onboarding state is cached for minutes:
    // the banner is due on the dock's very first render.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } } });
    client.setQueryData(UI_STATE_QUERY_KEY, ui);
    client.setQueryData(onboardingKeys.state(), leftEarly);

    const view = renderWith(<Shell />, { client });
    expect(view.container).toBeEmptyDOMElement();
    page.pathname = '/jobs';
    view.rerender(<Shell />);
    expect(await screen.findByText('Finish setting up — 4 steps left')).toBeInTheDocument();
    expect(getPopupGate().snapshot()).toMatchObject({ viewKey: '/jobs', shownThisView: FINISH_BANNER_POPUP_KEY });
    // Nothing was refetched to get there: the caches really were warm.
    expect(net.to('GET', `${P}/state`)).toHaveLength(0);

    // Leaving and coming back is a new page view: the banner shows again.
    page.pathname = '/resume';
    view.rerender(<Shell />);
    await waitFor(() => expect(screen.queryByTestId('finish-banner')).toBeNull());
    page.pathname = '/jobs';
    view.rerender(<Shell />);
    expect(await screen.findByTestId('finish-banner')).toBeInTheDocument();
  });
});
