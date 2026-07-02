// MobileNav — V3 mobile-only fixed bottom bar (replaces the V2 BottomNav).
// 5 Workspace items: Today / Review queue / Resume builder / Mock interview /
// Pipeline. Active item gets the accent color via aria-current="page".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue } from '../utils/mockAuth';

// MobileNav now reads useAuth() (via useJobApplyingEnabled) to gate the
// auto-apply tabs. Point it at the shared mock fixture (default: enabled).
vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const pathnameRef = { current: '/home' };
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

describe('MobileNav (V3)', () => {
  beforeEach(() => {
    pathnameRef.current = '/home';
    mockAuthState.value = buildAuthValue();
  });

  it('renders exactly 5 Workspace link items', () => {
    renderWithProviders(<MobileNav />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(5);
  });

  it('marks the active item with aria-current when on /home', () => {
    pathnameRef.current = '/home';
    renderWithProviders(<MobileNav />);
    const today = screen.getByRole('link', { name: /Today/i });
    expect(today).toHaveAttribute('aria-current', 'page');
    const pipeline = screen.getByRole('link', { name: /Pipeline/i });
    expect(pipeline).not.toHaveAttribute('aria-current');
  });

  it('Mock interview lights up on a /mock-interview subroute', () => {
    pathnameRef.current = '/mock-interview/cm_session_xyz';
    renderWithProviders(<MobileNav />);
    const mock = screen.getByRole('link', { name: /Mock interview/i });
    expect(mock).toHaveAttribute('aria-current', 'page');
  });

  it('aria-label="Mobile" on the nav', () => {
    renderWithProviders(<MobileNav />);
    expect(screen.getByLabelText(/Mobile/i)).toBeInTheDocument();
  });

  it('hides the auto-apply tabs when job-applying is OFF (Resume + Mock remain)', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: false });
    renderWithProviders(<MobileNav />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2); // Resume builder + Mock interview only
    expect(screen.queryByRole('link', { name: /Today/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Review queue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Pipeline/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Resume builder/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Mock interview/i })).toBeInTheDocument();
  });
});
