// MobileNav — the fixed bottom bar below 760px, where the 248px rail is
// hidden.
//
// The bar IS the information architecture (ruling D3): the same four
// destinations as the Sidebar, same labels, same order, unconditionally. The
// tests below are mostly about what must NOT be possible — a fifth tab, a
// flag-dependent tab count, a label the rail does not use, or a tap target
// under 44px.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const pathnameRef = { current: '/jobs' };
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { MobileNav } from '../../components/v3/shell/MobileNav';
import { DESTINATIONS } from '../../components/v3/shell/Sidebar';

const IA: [string, string][] = [
  ['/jobs', 'Jobs'],
  ['/resume', 'Resume'],
  ['/applications', 'Applications'],
  ['/practice', 'Interview prep'],
];

describe('MobileNav', () => {
  beforeEach(() => {
    pathnameRef.current = '/jobs';
    mockAuthState.value = buildAuthValue();
  });

  it('renders exactly the four destinations, in the sidebar order', () => {
    renderWithProviders(<MobileNav />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(IA.map(([h]) => h));
    for (const [href, label] of IA) {
      const link = links.find((l) => l.getAttribute('href') === href)!;
      expect(link).toHaveTextContent(label);
    }
  });

  it('renders the same array the Sidebar renders, not a copy of it', () => {
    renderWithProviders(<MobileNav />);
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(
      DESTINATIONS.map((d) => d.href),
    );
  });

  it('does not lose or gain a tab for any auth state', () => {
    const { unmount } = renderWithProviders(<MobileNav />);
    expect(screen.getAllByRole('link')).toHaveLength(4);
    unmount();

    // There is no flag left that may hide a destination; a signed-in user with
    // nothing set up sees the same four as everyone else.
    mockAuthState.value = buildAuthValue({ onboardingState: null, profile: null });
    renderWithProviders(<MobileNav />);
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });

  it('carries none of the deleted tabs', () => {
    renderWithProviders(<MobileNav />);
    for (const gone of [/Today/, /Review queue/, /Pipeline/, /Mock interview/]) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
  });

  it('labels are sentence case, not the old uppercase micro-label', () => {
    renderWithProviders(<MobileNav />);
    for (const [, label] of IA) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText(label.toUpperCase())).not.toBeInTheDocument();
    }
  });

  it('every tab is at least 44×44', () => {
    renderWithProviders(<MobileNav />);
    for (const link of screen.getAllByRole('link')) {
      expect(link.style.minHeight).toBe('44px');
      expect(link.style.minWidth).toBe('44px');
    }
  });

  it('marks the active tab with aria-current, including sub-routes', () => {
    pathnameRef.current = '/jobs';
    const { unmount } = renderWithProviders(<MobileNav />);
    expect(screen.getByRole('link', { name: /Jobs/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('link', { name: /Applications/ }),
    ).not.toHaveAttribute('aria-current');
    unmount();

    pathnameRef.current = '/practice/cm_session_xyz';
    renderWithProviders(<MobileNav />);
    expect(screen.getByRole('link', { name: /Interview prep/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('is a labelled navigation landmark', () => {
    renderWithProviders(<MobileNav />);
    const bar = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(bar).getAllByRole('link')).toHaveLength(4);
  });
});
