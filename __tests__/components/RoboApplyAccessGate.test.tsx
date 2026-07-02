// RoboApplyAccessGate — the front-end half of req 2 ("job seeker, not recruiter,
// except Admin"). A CONFIRMED recruiter is full-page-redirected to the
// /job-seeker bridge; seekers, GoHire candidates, and admins fall through.
// We never bounce while auth is still `loading` (eager render).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockAuthState, buildAuthValue, buildFakeUser } from '../utils/mockAuth';

vi.mock('../../lib/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => mockAuthState.value,
}));
vi.mock('../../lib/config', () => ({
  getRoboHireUrl: (p = '/') => `https://robohire.test${p}`,
}));

import { RoboApplyAccessGate } from '../../components/RoboApplyAccessGate';

const replaceMock = vi.fn();

beforeEach(() => {
  replaceMock.mockReset();
  // jsdom's window.location.replace throws "not implemented"; override it so the
  // redirect side-effect is observable and silent.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { replace: replaceMock, assign: vi.fn(), href: 'http://localhost/' },
  });
  mockAuthState.value = buildAuthValue();
});

function renderGate() {
  return render(
    <RoboApplyAccessGate>
      <div data-testid="child">candidate app</div>
    </RoboApplyAccessGate>,
  );
}

describe('RoboApplyAccessGate', () => {
  it.each(['seeker', 'candidate', 'admin'])('renders the app for %s (allowed in)', (role) => {
    mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role }) });
    renderGate();
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it.each(['user', 'internal', 'agency', 'sales', 'customer_success'])(
    'bounces recruiter "%s" to the /job-seeker bridge and hides the app',
    (role) => {
      mockAuthState.value = buildAuthValue({ user: buildFakeUser({ role }) });
      renderGate();
      expect(screen.queryByTestId('child')).not.toBeInTheDocument();
      expect(screen.getByText(/Redirecting/i)).toBeInTheDocument();
      expect(replaceMock).toHaveBeenCalledWith('https://robohire.test/job-seeker');
    },
  );

  it('does not bounce while auth is still loading', () => {
    mockAuthState.value = buildAuthValue({ status: 'loading', user: null });
    renderGate();
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
