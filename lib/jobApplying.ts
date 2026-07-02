// roboapply/lib/jobApplying.ts
//
// Single source of truth for the JOB_APPLYING_ENABLED feature gate on the
// client. The flag itself lives in the backend's env and is delivered through
// /auth/me (see AuthProvider.jobApplyingEnabled); this module owns the derived
// rules every consumer (Sidebar, MobileNav, route guard, redirects) shares so
// they never drift.
//
// When job-applying is OFF the app collapses to the Resume Builder + Mock
// Interview product: the auto-apply surfaces (Today feed, Review queue,
// Pipeline tracker, Activity log, the agent orb, the auto-apply onboarding, and
// the auto-apply preferences section) are hidden and their routes redirect.

import { useAuth } from './auth/AuthProvider';

/** Route prefixes that only make sense while job-applying is enabled. Visiting
 *  any of these with the flag OFF redirects to JOB_APPLY_OFF_LANDING. */
export const JOB_APPLY_ROUTE_PREFIXES = [
  '/home', // Today feed
  '/queue', // Review queue
  '/tracker', // Pipeline
  '/activity', // Activity log
] as const;

/** Where authenticated users land when job-applying is OFF (and where the
 *  hidden routes redirect to). The product home becomes Mock Interview. */
export const JOB_APPLY_OFF_LANDING = '/mock-interview';

/** Where a brand-new user (no resume yet) is sent when job-applying is OFF —
 *  the auto-apply onboarding is skipped in favour of the Resume Builder. */
export const JOB_APPLY_OFF_NEW_USER_LANDING = '/resumes';

/** True when `pathname` belongs to a job-applying-only surface. */
export function isJobApplyRoute(pathname: string): boolean {
  return JOB_APPLY_ROUTE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** LAUNCH KILL SWITCH: the /queue Review-queue surface is hidden for launch —
 *  its backend can't yet deliver what the UI promises ("Send now" flips a DB
 *  status without submitting anywhere, and the matcher can't populate the
 *  queue). Flip to `true` to restore the nav entries, the /queue route, the
 *  home-hero queue copy, and the queue-review notification row; the tests
 *  keyed to this constant flip back automatically. */
export const QUEUE_REVIEW_ENABLED = false;

/** True when `pathname` is the Review-queue surface (gated separately from the
 *  JOB_APPLYING_ENABLED master switch by QUEUE_REVIEW_ENABLED). */
export function isQueueRoute(pathname: string): boolean {
  return pathname === '/queue' || pathname.startsWith('/queue/');
}

/**
 * Client hook: is the job-applying surface enabled?
 *   `true`  → show it · `false` → hide it · `null` → still loading /auth/me
 * Consumers should treat `null` as "don't act yet" (don't flash, don't
 * redirect) and only hide/redirect on an explicit `false`.
 */
export function useJobApplyingEnabled(): boolean | null {
  return useAuth().jobApplyingEnabled;
}
