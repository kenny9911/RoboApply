// FND-6a — the (auth) layout, AppShell, HybridShell and the Topbar's Ask.
//
// Acceptance: the rail slot never auto-opens on route change. Plus: the
// layout mounts its slots and feeds page views to the popup gate; a live
// practice room is full screen; HybridShell shows the app shell with a
// session and marketing chrome without one; Ask opens the rail only on
// click and only when the Assistant is on and shipped.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';

import { mockAuthState, buildAuthValue } from '../utils/mockAuth';
import { renderWithBrand } from './helpers';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const pathnameRef = { current: '/jobs' };
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

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
import { HybridShell, isPracticeLivePath, signupHref } from '../../components/v3/shell/HybridShell';
import { Topbar } from '../../components/v3/shell/Topbar';
import { CommandPaletteProvider } from '../../components/v3/shell/CommandPalette';
import { __assistantRailStore, openAssistantRail } from '../../hooks/shared/useOpenAssistant';

beforeEach(() => {
  pathnameRef.current = '/jobs';
  gateCalls.views = [];
  mockAuthState.value = buildAuthValue();
  __assistantRailStore.reset();
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

describe('Topbar Ask', () => {
  const renderTopbar = (flags: Record<string, boolean>) =>
    renderWithBrand(
      <CommandPaletteProvider>
        <Topbar />
      </CommandPaletteProvider>,
      { flags },
    );

  it('is hidden until the Assistant ships, even with the copilot flag on', () => {
    renderTopbar({ copilot: true });
    expect(screen.queryByRole('button', { name: 'Ask the assistant' })).not.toBeInTheDocument();
  });

  it('is hidden when the copilot flag is off', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
    renderTopbar({});
    expect(screen.queryByRole('button', { name: 'Ask the assistant' })).not.toBeInTheDocument();
  });

  it('opens the rail on click (the dev override shows it early)', () => {
    vi.stubEnv('NEXT_PUBLIC_SHOW_ALL_NAV', 'true');
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
