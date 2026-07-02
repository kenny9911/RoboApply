// JobApplyingGate — the route-level guard for JOB_APPLYING_ENABLED. When the
// flag is off, a direct hit on a hidden auto-apply route (/home, /queue,
// /tracker, /activity) redirects to the Mock Interview home instead of
// rendering it. Loading-tolerant: holds (spinner) only while the SESSION is
// resolving, and must NOT hold forever for a cleared/unauthenticated session
// (the blank-page bug).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { mockAuthState, buildAuthValue } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));

const replace = vi.fn();
const pathnameRef = { current: '/home' };
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({
    replace,
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

import { JobApplyingGate } from '../../components/JobApplyingGate';

const Child = () => <div data-testid="child">content</div>;

describe('JobApplyingGate', () => {
  beforeEach(() => {
    replace.mockReset();
    pathnameRef.current = '/home';
    mockAuthState.value = buildAuthValue();
  });

  it('flag OFF + hidden route (/home) → redirects to /mock-interview and hides content', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: false });
    pathnameRef.current = '/home';
    renderWithProviders(
      <JobApplyingGate>
        <Child />
      </JobApplyingGate>,
    );
    expect(replace).toHaveBeenCalledWith('/mock-interview');
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });

  it('flag OFF on every hidden prefix redirects', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: false });
    for (const p of ['/queue', '/tracker', '/activity', '/tracker/abc']) {
      replace.mockReset();
      pathnameRef.current = p;
      const { unmount } = renderWithProviders(
        <JobApplyingGate>
          <Child />
        </JobApplyingGate>,
      );
      expect(replace, p).toHaveBeenCalledWith('/mock-interview');
      unmount();
    }
  });

  it('flag OFF + KEPT route (/resumes) → renders content, no redirect', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: false });
    pathnameRef.current = '/resumes';
    renderWithProviders(
      <JobApplyingGate>
        <Child />
      </JobApplyingGate>,
    );
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('flag ON + hidden route → renders content, no redirect', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: true });
    pathnameRef.current = '/home';
    renderWithProviders(
      <JobApplyingGate>
        <Child />
      </JobApplyingGate>,
    );
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('loading (null, status=loading) + hidden route → holds (no content, no redirect)', () => {
    mockAuthState.value = buildAuthValue({ jobApplyingEnabled: null, status: 'loading' });
    pathnameRef.current = '/home';
    renderWithProviders(
      <JobApplyingGate>
        <Child />
      </JobApplyingGate>,
    );
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });

  it('cleared/unauthenticated (null, NOT loading) + hidden route → does NOT hold forever (blank-page bug)', () => {
    mockAuthState.value = buildAuthValue({
      jobApplyingEnabled: null,
      status: 'unauthenticated',
    });
    pathnameRef.current = '/home';
    renderWithProviders(
      <JobApplyingGate>
        <Child />
      </JobApplyingGate>,
    );
    // Must not hang on a spinner — children render (AuthGate handles the /login bounce).
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
