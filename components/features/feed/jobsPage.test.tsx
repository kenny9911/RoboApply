// components/features/feed/jobsPage.test.tsx — /jobs page wiring (WP-33).
//
// The route renders the feed workspace (components/features/feed/
// JobsWorkspace.tsx) and no longer mounts the legacy V2 "Today" feed or the
// first-run SetupPanel (TASK_PLAN.md WP-33: "drops the SetupPanel /
// useSetupTrigger imports"; first-run setup is /onboarding, WP-30). The
// workspace's behaviour is tested in feed.test.tsx and explore.test.tsx; this
// file only proves the route renders it.
//
// It replaces __tests__/pages/jobs.test.tsx, which covered the removed page
// and sits outside WP-33's owned paths: its deletion is requested in the
// WP-33 handoff.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import JobsPage from '../../../app/(auth)/jobs/page';
import { __setPopupGate } from '../../../lib/ui/popupGate';
import {
  EMPTY_UI_STATE,
  feedItem,
  installFetch,
  installPopupGate,
  ok,
  page,
  profileList,
  renderFeed,
  searchProfile,
} from './feed.testkit';

const nav = vi.hoisted(() => ({ search: '', replace: [] as string[] }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn(), replace: (href: string) => nav.replace.push(href), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));

const QUERY = '/api/v1/roboapply/feed/query';

function routes() {
  return {
    'GET /api/v1/roboapply/search-profiles': () => ok(profileList([searchProfile()])),
    'GET /api/v1/roboapply/ui-state': () => ok(EMPTY_UI_STATE),
    [`POST ${QUERY}`]: () => ok(page([feedItem(1), feedItem(2)])),
  };
}

const sortsAsked = (net: ReturnType<typeof installFetch>) => net.to('POST', QUERY).map((c) => (c.body as { sort: string }).sort);

afterEach(() => {
  vi.unstubAllGlobals();
  __setPopupGate(null);
  nav.search = '';
  nav.replace = [];
});

describe('/jobs', () => {
  it('renders the feed workspace: tabs and the jobs from POST /feed/query', async () => {
    installPopupGate();
    installFetch(routes());
    renderFeed(<JobsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'For you' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
  });

  // INT-06 (wave4 WP-93 #1): the Assistant's "Show jobs sorted this way" link.
  it('/jobs?sort=newest opens sorted newest and the sort menu shows it', async () => {
    installPopupGate();
    nav.search = 'sort=newest';
    const net = installFetch(routes());
    renderFeed(<JobsPage />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(sortsAsked(net)).toEqual(['newest']);
    expect(screen.getByLabelText('Sort')).toHaveValue('newest');
    expect((screen.getByRole('option', { name: 'Newest' }) as HTMLOptionElement).selected).toBe(true);
  });

  it('an unknown ?sort= is ignored: the list opens in the recommended order', async () => {
    installPopupGate();
    nav.search = 'sort=salary_desc';
    const net = installFetch(routes());
    renderFeed(<JobsPage />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(sortsAsked(net)).toEqual(['recommended']);
    expect(screen.getByLabelText('Sort')).toHaveValue('recommended');
  });

  it('?sort=deadline is a GoApply order only', async () => {
    installPopupGate();
    nav.search = 'sort=deadline';
    const intl = installFetch(routes());
    const first = renderFeed(<JobsPage />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(sortsAsked(intl)).toEqual(['recommended']);
    first.unmount();

    const cn = installFetch(routes());
    renderFeed(<JobsPage />, { brand: 'goapply' });
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(sortsAsked(cn)).toEqual(['deadline']);
  });

  it('a sort link followed while /jobs is already open re-sorts the list', async () => {
    installPopupGate();
    const net = installFetch(routes());
    const view = renderFeed(<JobsPage />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(sortsAsked(net)).toEqual(['recommended']);
    nav.search = 'sort=highest_pay';
    view.rerender(<JobsPage />);
    await waitFor(() => expect(sortsAsked(net)).toContain('highest_pay'));
    expect(screen.getByLabelText('Sort')).toHaveValue('highest_pay');
  });

  it('picking a sort keeps the address in step and leaves the other parameters alone', async () => {
    installPopupGate();
    nav.search = 'from=assistant&sort=newest';
    installFetch(routes());
    renderFeed(<JobsPage />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'best_fit' } });
    expect(nav.replace.at(-1)).toBe('/jobs?from=assistant&sort=best_fit');
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'recommended' } });
    expect(nav.replace.at(-1)).toBe('/jobs?from=assistant');
  });

  it('no longer mounts the first-run setup panel (moved to /onboarding)', () => {
    const src = readFileSync(join(process.cwd(), 'app/(auth)/jobs/page.tsx'), 'utf8');
    expect(src).not.toMatch(/SetupPanel|useSetupTrigger|useTodayMatches/);
  });
});
