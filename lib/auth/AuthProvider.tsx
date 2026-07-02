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
  /** Master switch for the auto-apply product surface (backend
   *  JOB_APPLYING_ENABLED, via /auth/me). `null` while the session is still
   *  loading; defaults to `true` for backends that don't send the field. */
  jobApplyingEnabled: boolean | null;
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
  // `null` until /me resolves so gates can tell "unknown" from "disabled".
  const [jobApplyingEnabled, setJobApplyingEnabled] = useState<boolean | null>(
    null,
  );

  const setSession = useCallback((data: MeResponse) => {
    setUser(data.user);
    setProfile(data.profile);
    setOnboardingState(data.onboardingState);
    // Absent (older backend) → enabled, preserving prior behavior.
    setJobApplyingEnabled(data.jobApplyingEnabled ?? true);
    setStatus('authenticated');
  }, []);

  const clear = useCallback(() => {
    setUser(null);
    setProfile(null);
    setOnboardingState(null);
    setJobApplyingEnabled(null);
    setStatus('unauthenticated');
  }, []);

  const refresh = useCallback(async (): Promise<MeResponse | null> => {
    // Do NOT pre-check for the session cookie on the client: `session_token`
    // is httpOnly (backend/src/lib/cookieOptions.ts), so it is invisible to
    // document.cookie. A client-side cookie probe ALWAYS reports "absent" and
    // would make us clear() the session for every user — which left
    // `jobApplyingEnabled` permanently null and hung the Today/Queue/Tracker/
    // Activity routes on the JobApplyingGate spinner (the blank-page bug).
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
      jobApplyingEnabled,
      refresh,
      setSession,
      clear,
    }),
    [
      status,
      user,
      profile,
      onboardingState,
      jobApplyingEnabled,
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
