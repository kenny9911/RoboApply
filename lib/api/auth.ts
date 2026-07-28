// roboapply-app/lib/api/auth.ts
//
// Typed wrappers around the auth surface. RoboApply owns its auth at
// `/api/v1/roboapply/auth/*` (backend/src/roboapply/routes/auth.ts), which
// wraps the shared auth engine now living under
// backend/src/roboapply/engine/. The legacy `/api/v1/seeker/auth/*` routes
// were removed when the /job-seeker product was retired.

import { roboApi } from './client';

export interface RoboUserSummary {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  roles: string[];
}

export type OnboardingStep =
  | 'resume'
  | 'preferences'
  | 'interview'
  | 'profile_video'
  | 'complete';

export interface MeResponse {
  user: RoboUserSummary;
  profile: Record<string, unknown> | null;
  // The /roboapply/auth/me endpoint returns a `mission` snapshot; legacy
  // callers also read `onboardingState`. Both are optional so either shape
  // round-trips without a type error.
  mission?: Record<string, unknown> | null;
  // The signal the setup panel on /jobs runs off. All four fields matter:
  //   completedSteps → WHICH step opens (no 'resume' → step 1; resume but no
  //     'preferences' → step 2; both → closed);
  //   skippedAt → suppress the auto-open for 7 days, EXCEPT in the no-resume
  //     state, which always opens because the scorer has nothing to compare
  //     without a parsed resume;
  //   autoOpens → the hard cap. Two auto-opens ever; after that the panel is
  //     reachable only by tap. Incremented by POST /v2/onboarding/seen.
  onboardingState?: {
    completed: boolean;
    step?: OnboardingStep;
    completedSteps?: OnboardingStep[];
    /** ISO timestamp, or null when the user never skipped. */
    skippedAt?: string | null;
    autoOpens?: number;
  };
}

export interface AuthSessionResponse {
  user: RoboUserSummary;
  token: string;
}

export interface SignupPayload {
  email: string;
  password: string;
  name?: string;
  locale?: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export function signup(body: SignupPayload) {
  return roboApi.post<AuthSessionResponse>(
    '/api/v1/roboapply/auth/signup',
    body,
  );
}

export function login(body: LoginPayload) {
  return roboApi.post<AuthSessionResponse>(
    '/api/v1/roboapply/auth/login',
    body,
  );
}

export function logout() {
  return roboApi.post<{ success: true }>(
    '/api/v1/roboapply/auth/logout',
  );
}

export function getSession() {
  return roboApi.get<MeResponse>('/api/v1/roboapply/auth/me');
}
