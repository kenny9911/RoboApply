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
import { screen, waitFor } from '@testing-library/react';
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

vi.mock('next/navigation', () => ({
  usePathname: () => '/jobs',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  __setPopupGate(null);
});

describe('/jobs', () => {
  it('renders the feed workspace: tabs and the jobs from POST /feed/query', async () => {
    installPopupGate();
    installFetch({
      'GET /api/v1/roboapply/search-profiles': () => ok(profileList([searchProfile()])),
      'GET /api/v1/roboapply/ui-state': () => ok(EMPTY_UI_STATE),
      'POST /api/v1/roboapply/feed/query': () => ok(page([feedItem(1), feedItem(2)])),
    });
    renderFeed(<JobsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'For you' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
  });

  it('no longer mounts the first-run setup panel (moved to /onboarding)', () => {
    const src = readFileSync(join(process.cwd(), 'app/(auth)/jobs/page.tsx'), 'utf8');
    expect(src).not.toMatch(/SetupPanel|useSetupTrigger|useTodayMatches/);
  });
});
