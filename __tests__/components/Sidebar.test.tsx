// Sidebar — the V3 248px desktop nav rail (replaces the V2 LeftRail). Top→
// bottom: BrandLogo, the primary nav (6 Workspace items + a Settings group
// with Replay onboarding / Tweaks / Preferences), then the agent OrbCard.
// Active-state follows usePathname() with prefix-match for sub-routes.
// Badges: /queue ← live useQueue().pendingCount, /home ← orbStats
// matchedAboveThreshold (both hidden at 0), /mock-interview ← static
// translated NEW pill. Tests hit the in-memory stub API (NODE_ENV=test).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';
import { raV2Api } from '../../lib/api/v2';
import { QUEUE_REVIEW_ENABLED } from '../../lib/jobApplying';

// Sidebar now reads useAuth() to decide whether to show the admin-only /admin
// nav entry. Point it at the shared mock fixture (default user role 'seeker'
// ⇒ no admin link); follows the module-mock pattern used across the suite.
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const pushMock = vi.fn();
const pathnameRef = { current: '/home' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
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

import { Sidebar } from '../../components/v3/shell/Sidebar';

describe('Sidebar (V3)', () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.restoreAllMocks();
    pathnameRef.current = '/home';
    // Reset shared auth fixture to the default seeker so admin-gate state from
    // one test can't leak into the next.
    mockAuthState.value = buildAuthValue();
  });

  it('hides the Admin nav link for a non-admin seeker, shows it for an admin', () => {
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(screen.queryByRole('link', { name: /Admin/i })).not.toBeInTheDocument();
    // Also renders the Account settings link for everyone.
    expect(screen.getByRole('link', { name: /Account/i })).toBeInTheDocument();
    unmount();

    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: /Admin/i })).toBeInTheDocument();
  });

  it('renders the Workspace nav links + the Preferences settings link', () => {
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: /Today/i })).toBeInTheDocument();
    // Review queue is hidden while QUEUE_REVIEW_ENABLED is off for launch.
    if (QUEUE_REVIEW_ENABLED) {
      expect(
        screen.getByRole('link', { name: /Review queue/i }),
      ).toBeInTheDocument();
    } else {
      expect(
        screen.queryByRole('link', { name: /Review queue/i }),
      ).not.toBeInTheDocument();
    }
    expect(
      screen.getByRole('link', { name: /Resume builder/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Mock interview/i }),
    ).toBeInTheDocument();
    // Tracker is the single umbrella entry (board + activity log live as tabs
    // on /tracker now) — there is no longer a separate "Activity log" link.
    expect(screen.getByRole('link', { name: /Tracker/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Activity log/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Preferences/i }),
    ).toBeInTheDocument();
  });

  it('renders the single Account settings link, active on /account and its sub-routes', () => {
    pathnameRef.current = '/account/plans';
    renderWithProviders(<Sidebar />);
    // Plans folded into the unified Account area — there is no separate
    // "Plans & credits" sidebar link anymore.
    expect(screen.queryByRole('link', { name: /Plans & credits/i })).not.toBeInTheDocument();
    const account = screen.getByRole('link', { name: /Account/i });
    expect(account).toHaveAttribute('href', '/account');
    expect(account).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the Account link when job-applying is OFF (not auto-apply-gated)', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: false });
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('link', { name: /Account/i })).toBeInTheDocument();
  });

  it('gates Tweaks to admins: hidden for a seeker, shown for an admin (both as buttons, not links)', () => {
    // Default seeker: Replay onboarding still shows, but Tweaks is admin-only.
    const { unmount } = renderWithProviders(<Sidebar />);
    expect(
      screen.getByRole('button', { name: /Replay onboarding/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tweaks/i })).not.toBeInTheDocument();
    unmount();

    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
    renderWithProviders(<Sidebar />);
    expect(screen.getByRole('button', { name: /Tweaks/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Replay onboarding/i }),
    ).toBeInTheDocument();
  });

  it('active item highlight follows usePathname() — /home', () => {
    pathnameRef.current = '/home';
    renderWithProviders(<Sidebar />);
    const today = screen.getByRole('link', { name: /Today/i });
    expect(today).toHaveAttribute('aria-current', 'page');
    // Preferences is not active.
    const prefs = screen.getByRole('link', { name: /Preferences/i });
    expect(prefs).not.toHaveAttribute('aria-current');
  });

  it('Resume builder lights up on a /resumes/[id] sub-route', () => {
    pathnameRef.current = '/resumes/cm_resume_abc';
    renderWithProviders(<Sidebar />);
    const resumes = screen.getByRole('link', { name: /Resume builder/i });
    expect(resumes).toHaveAttribute('aria-current', 'page');
  });

  it('opens the Tweaks panel when the (admin-only) Tweaks button is clicked', () => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role: 'admin' }) });
    renderWithProviders(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Tweaks/i }));
    // TweaksPanel renders its heading when open.
    expect(screen.getByLabelText(/Primary/i)).toBeInTheDocument();
  });

  it.runIf(QUEUE_REVIEW_ENABLED)('wires the /queue badge to the live pendingCount from useQueue()', async () => {
    renderWithProviders(<Sidebar />);
    const queueLink = screen.getByRole('link', { name: /Review queue/i });
    // The stub fixture ships 2 pending queue items.
    expect(await within(queueLink).findByText('2')).toBeInTheDocument();
  });

  it('shows the translated "{count} new" badge on Today from orbStats', async () => {
    renderWithProviders(<Sidebar />);
    const todayLink = screen.getByRole('link', { name: /Today/i });
    // FIXTURE_AGENT_STATS.matchedAboveThreshold = 12 → en "12 new".
    expect(await within(todayLink).findByText('12 new')).toBeInTheDocument();
  });

  it('shows the static translated NEW pill on Mock interview', () => {
    renderWithProviders(<Sidebar />);
    const link = screen.getByRole('link', { name: /Mock interview/i });
    expect(within(link).getByText('NEW')).toBeInTheDocument();
  });

  it('carries no fake numeric badges on Resume builder / Tracker', async () => {
    renderWithProviders(<Sidebar />);
    // Let the live badge queries settle so the assertion isn't vacuous.
    await screen.findByText('12 new');
    const resumes = screen.getByRole('link', { name: /Resume builder/i });
    const tracker = screen.getByRole('link', { name: /Tracker/i });
    expect(within(resumes).queryByText(/\d/)).not.toBeInTheDocument();
    expect(within(tracker).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it.runIf(QUEUE_REVIEW_ENABLED)('hides the queue badge entirely when pendingCount is 0', async () => {
    vi.spyOn(raV2Api.queue, 'list').mockResolvedValue({
      items: [],
      pendingCount: 0,
    });
    renderWithProviders(<Sidebar />);
    // orbStats (unmocked stub) resolves after the mocked queue list — once the
    // Today badge is up, both queries have settled.
    await screen.findByText('12 new');
    const queueLink = screen.getByRole('link', { name: /Review queue/i });
    expect(queueLink.querySelector('.count')).toBeNull();
  });

  it('hides the auto-apply surface when job-applying is OFF, keeps Resume/Mock/Preferences', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: false });
    renderWithProviders(<Sidebar />);

    // Auto-apply nav links are gone.
    expect(screen.queryByRole('link', { name: /Today/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Review queue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Tracker/i })).not.toBeInTheDocument();
    // The Tweaks + Replay onboarding settings actions are gone.
    expect(screen.queryByRole('button', { name: /Tweaks/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Replay onboarding/i }),
    ).not.toBeInTheDocument();

    // The kept product surface is still present.
    expect(screen.getByRole('link', { name: /Resume builder/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Mock interview/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Preferences/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Account/i })).toBeInTheDocument();
  });
});
