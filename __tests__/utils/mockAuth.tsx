// Auth provider wrapper for unit tests.
//
// Provides a mutable mock object that subjects can read via useAuth(). The
// real AuthProvider in lib/auth/AuthProvider.tsx fires GET /me on mount
// which we never want in unit tests, so test files mock that module
// wholesale and point useAuth() at this fixture instead.
//
// Usage pattern in a test file:
//
//   import { mockAuthState, AuthWrapper } from '../utils/mockAuth';
//   vi.mock('../../lib/auth/AuthProvider', () => ({
//     AuthProvider: ({ children }: any) => children,
//     useAuth: () => mockAuthState.value,
//   }));

import { type ReactNode } from 'react';
import type { MeResponse, RoboUserSummary } from '../../lib/api/auth';

export interface AuthContextValue {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: RoboUserSummary | null;
  profile: MeResponse['profile'] | null;
  onboardingState: MeResponse['onboardingState'] | null;
  jobApplyingEnabled: boolean | null;
  refresh: () => Promise<MeResponse | null>;
  setSession: (data: MeResponse) => void;
  clear: () => void;
}

export interface FakeUserOpts {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  tier?: 'free' | 'premium' | 'premium_plus';
}

export function buildFakeUser(opts: FakeUserOpts = {}): RoboUserSummary {
  return {
    id: opts.id ?? 'seeker-1',
    email: opts.email ?? 'jane@example.com',
    name: opts.name ?? 'Jane Seeker',
    role: opts.role ?? 'seeker',
    roles: [opts.role ?? 'seeker'],
  };
}

export function buildAuthValue(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    status: 'authenticated',
    user: buildFakeUser(),
    profile: { id: 'profile-1', userId: 'seeker-1', locale: 'en' },
    onboardingState: { completed: true },
    // Default to the job-applying surface being ON so existing tests see the
    // full nav; flag-off tests override this to false.
    jobApplyingEnabled: true,
    refresh: async () => null,
    setSession: () => {},
    clear: () => {},
    ...overrides,
  };
}

/**
 * Shared mutable state pointer. Tests reassign `mockAuthState.value` in a
 * `beforeEach` so they can supply per-case auth state without re-mocking
 * the module each time.
 */
export const mockAuthState: { value: AuthContextValue } = {
  value: buildAuthValue(),
};

export function AuthWrapper({
  children,
  value,
}: {
  children: ReactNode;
  value?: Partial<AuthContextValue>;
}) {
  // For tests that aren't mocking lib/auth/AuthProvider but still want a
  // provider in the tree, expose the value here. Most page tests should
  // mock the module instead and ignore this wrapper.
  if (value) mockAuthState.value = buildAuthValue(value);
  return <>{children}</>;
}
