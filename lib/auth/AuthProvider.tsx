'use client';

// AuthProvider — client-side session source-of-truth.
//
// Wraps the React tree under app/providers.tsx. Loads /api/v1/seeker/auth/me
// once on mount when the session_token cookie is present, then publishes
// the result through context. Pages call `useAuth()` to read it.
//
// Lightweight by design: pages render eagerly with `status === 'loading'`
// and let the gated /(auth) routes redirect via middleware. The
// F-engineer (Wave-D) extends this once mission/apps wire up real data.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getSession,
  type MeResponse,
  type RoboUserSummary,
} from '../api/auth';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: RoboUserSummary | null;
  profile: MeResponse['profile'] | null;
  onboardingState: MeResponse['onboardingState'] | null;
  refresh: () => Promise<MeResponse | null>;
  setSession: (data: MeResponse) => void;
  clear: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<RoboUserSummary | null>(null);
  const [profile, setProfile] = useState<MeResponse['profile'] | null>(null);
  const [onboardingState, setOnboardingState] = useState<
    MeResponse['onboardingState'] | null
  >(null);

  const setSession = useCallback((data: MeResponse) => {
    setUser(data.user);
    setProfile(data.profile);
    setOnboardingState(data.onboardingState);
    setStatus('authenticated');
  }, []);

  const clear = useCallback(() => {
    setUser(null);
    setProfile(null);
    setOnboardingState(null);
    setStatus('unauthenticated');
  }, []);

  const refresh = useCallback(async (): Promise<MeResponse | null> => {
    // Do NOT pre-check for the session cookie on the client: `session_token`
    // is httpOnly (backend/src/lib/cookieOptions.ts), so it is invisible to
    // document.cookie. A client-side cookie probe ALWAYS reports "absent" and
    // would make us clear() the session for every user — signing out every
    // visitor on every load (the blank-page bug).
    // Instead always call /auth/me: the httpOnly cookie rides along via the
    // client's `credentials: 'include'`, and the response (200 vs 401/403) is
    // the source of truth for authenticated vs unauthenticated.
    try {
      const me = await getSession();
      setSession(me);
      return me;
    } catch {
      clear();
      return null;
    }
  }, [clear, setSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      profile,
      onboardingState,
      refresh,
      setSession,
      clear,
    }),
    [
      status,
      user,
      profile,
      onboardingState,
      refresh,
      setSession,
      clear,
    ],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
