// lib/auth/signInRoute.ts — where a user goes right after signing in
// (WP-10; TASK_PLAN.md R-06). Only on sign-in, never on every page view:
//   1. a `next` to a free-tool page (PRIORITY_NEXT_PATHS): the visitor asked
//      to keep a result there, and the page is public, so it wins;
//   2. onboarding not finished → its screen (`/auth/me.onboarding.nextRoute`);
//   3. else a same-site `next` the visitor arrived with;
//   4. else /jobs (the AuthGate sends GoApply users to their first-value page).

import type { MeResponse } from '../api/auth';
import { priorityNext, safeNext } from './entry';

export function signInRoute(me: Pick<MeResponse, 'onboarding'> | null | undefined, rawNext: string | null | undefined): string {
  const priority = priorityNext(rawNext);
  if (priority) return priority;
  const onboarding = me?.onboarding;
  if (onboarding && !onboarding.completed && onboarding.nextRoute) return onboarding.nextRoute;
  return safeNext(rawNext) ?? '/jobs';
}
