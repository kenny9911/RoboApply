// Sidebar — the 248px desktop nav rail.
//
// What this file is defending (OVERHAUL_RULINGS.md R1/D2/D3, C11, C14):
//   • exactly four destinations, in order, with the target labels — no
//     Workspace/Settings section headers, no /queue, no "NEW" pill,
//   • Admin is an admin-only trailing entry, not a fifth destination,
//   • the only badge is the count of applications with no reply in 10+ days,
//     hidden at zero,
//   • active state follows usePathname(), including sub-routes.
//
// Tests hit the in-memory stub API (NODE_ENV=test), whose tracker fixture has
// two rows in `applied` with 2026-05 apply dates.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';
import { raV2Api } from '../../lib/api/v2';
import type { TrackerListResponse } from '../../lib/api/v2';
import { FIXTURE_TRACKER } from '../../lib/fixtures';

// The rail reads useAuth() for the admin gate. Point it at the shared fixture
// (default role 'seeker' ⇒ no admin link); the module-mock pattern the rest of
// the suite uses.
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const pathnameRef = { current: '/jobs' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import {
  Sidebar,
  DESTINATIONS,
  countAwaitingReply,
} from '../../components/v3/shell/Sidebar';

/** The IA, spelled out here so a change to the nav has to be a change to this
 *  list too. Route = nav label. */
const IA: [string, string][] = [
  ['/jobs', 'Jobs'],
  ['/resume', 'Resume'],
  ['/applications', 'Applications'],
  ['/practice', 'Interview prep'],
];

describe('Sidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pathnameRef.current = '/jobs';
    mockAuthState.value = buildAuthValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders exactly the four destinations, in order, and nothing else', async () => {
    renderWithProviders(<Sidebar />);
    // Let the badge query settle so a late render can't add a fifth link.
    await screen.findByRole('link', { name: 'Interview prep' });

    const rail = screen.getByRole('navigation');
    const links = within(rail).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(IA.map(([h]) => h));
    for (const [href, label] of IA) {
      const link = links.find((l) => l.getAttribute('href') === href)!;
      expect(link).toHaveTextContent(label);
    }
  });

  it('exports the same four destinations MobileNav renders', () => {
    expect(DESTINATIONS.map((d) => d.href)).toEqual(IA.map(([h]) => h));
    expect(DESTINATIONS.map((d) => d.labelKey)).toEqual([
      'jobs',
      'resume',
      'applications',
      'practice',
    ]);
  });

  it('carries no section headers — one nav group, no Workspace/Settings', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument();
    // "Settings" moved to the avatar menu; it is not a rail entry.
    expect(screen.queryByRole('link', { name: /^Settings$/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.nav-section')).toHaveLength(0);
  });

  it('carries none of the deleted destinations', () => {
    renderWithProviders(<Sidebar />);
    for (const gone of [
      /Today/,
      /Review queue/,
      /Pipeline/,
      /Activity log/,
      /Preferences/,
      /Plans/,
      /Account/,
      /Mock interview/,
    ]) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('NEW')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Resume builder/ }),
    ).not.toBeInTheDocument();
  });

  it('hides Admin from a seeker and shows it to an admin, after the four', () => {
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    unmount();

    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
    renderWithProviders(<Sidebar />);
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      ...IA.map(([h]) => h),
      '/admin',
    ]);
  });

  it('marks the active destination with aria-current', () => {
    pathnameRef.current = '/jobs';
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Resume' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('lights the destination on a sub-route (/resume/[id], /practice/[id])', () => {
    pathnameRef.current = '/resume/cm_resume_abc';
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    unmount();

    pathnameRef.current = '/practice/cm_session_xyz/report';
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: 'Interview prep' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('every entry is a link — the rail has no button-shaped actions', async () => {
    renderWithProviders(<Sidebar />);
    await screen.findByRole('link', { name: 'Interview prep' });
    expect(within(screen.getByRole('navigation')).queryAllByRole('button')).toHaveLength(0);
  });

  describe('the no-reply badge (ruling C11)', () => {
    it('counts only applications still in `applied` past the 10-day mark', () => {
      const day = 24 * 60 * 60 * 1000;
      const now = Date.parse('2026-06-01T00:00:00.000Z');
      const base = FIXTURE_TRACKER[0];
      const rows = [
        // applied 11 days ago, still waiting → counts.
        { ...base, status: 'applied' as const, dateApplied: new Date(now - 11 * day).toISOString() },
        // applied 9 days ago → too soon.
        { ...base, status: 'applied' as const, dateApplied: new Date(now - 9 * day).toISOString() },
        // a reply moved it on, however long ago it was sent → not waiting.
        { ...base, status: 'interviewing' as const, dateApplied: new Date(now - 40 * day).toISOString() },
        // saved but never sent → nothing to wait for.
        { ...base, status: 'bookmarked' as const, dateApplied: null },
      ];
      expect(countAwaitingReply(rows, now)).toBe(1);
      expect(countAwaitingReply([], now)).toBe(0);
    });

    it('shows the count on Applications, with a sentence for screen readers', async () => {
      // The tracker fixture ships two `applied` rows dated 2026-05, both well
      // past 10 days at any real clock.
      renderWithProviders(<Sidebar />);
      const applications = await screen.findByRole('link', { name: /^Applications/ });
      expect(await within(applications).findByText('2')).toBeInTheDocument();
      expect(
        within(applications).getByText('2 with no reply in 10 days'),
      ).toBeInTheDocument();
    });

    it('renders no badge at all when nothing is waiting', async () => {
      const listSpy = vi.spyOn(raV2Api.tracker, 'list').mockResolvedValue({
        entries: [],
        statusCounts: {} as TrackerListResponse['statusCounts'],
        total: 0,
      });
      renderWithProviders(<Sidebar />);
      const applications = await screen.findByRole('link', { name: /^Applications/ });
      // Wait for the query to settle, then assert the badge never appeared.
      await waitFor(() => expect(listSpy).toHaveBeenCalled());
      expect(applications.querySelector('.count')).toBeNull();
    });

    it('puts no badge on any other destination', async () => {
      renderWithProviders(<Sidebar />);
      // Settle the badge query first so this is not vacuous.
      await within(
        await screen.findByRole('link', { name: /^Applications/ }),
      ).findByText('2');
      for (const label of ['Jobs', 'Resume', 'Interview prep']) {
        const link = screen.getByRole('link', { name: label });
        expect(link.querySelector('.count')).toBeNull();
      }
    });
  });
});
