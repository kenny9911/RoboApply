// lib/auth/signInRoute.ts — where a user goes right after signing in
// (WP-10; TASK_PLAN.md R-06). Only on sign-in, never on every page view:
//   1. onboarding not finished → its screen (`/auth/me.onboarding.nextRoute`);
//   2. else a same-site `next` the visitor arrived with;
//   3. else /jobs (the AuthGate sends GoApply users to their first-value page).

import type { MeResponse } from '../api/auth';
import { safeNext } from './entry';

export function signInRoute(me: Pick<MeResponse, 'onboarding'> | null | undefined, rawNext: string | null | undefined): string {
  const onboarding = me?.onboarding;
  if (onboarding && !onboarding.completed && onboarding.nextRoute) return onboarding.nextRoute;
  return safeNext(rawNext) ?? '/jobs';
}
