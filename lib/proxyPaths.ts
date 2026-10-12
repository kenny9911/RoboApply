// lib/proxyPaths.ts
//
// Pure path-matching helpers for the edge proxy (roboapply/proxy.ts), kept in a
// `next/server`-free module so they are unit-testable in plain Node/jsdom
// without pulling in the Edge runtime.
//
// PROTECTED_PREFIXES = every path that requires a session; the proxy 302s an
// unauthenticated visitor under any of these to /login?next=… .
//
// TWO consumers, and the second is the reason to be careful:
//   1. the edge proxy's login gate;
//   2. lib/api/client.ts's stale-session recovery — on an `auth_expired` 401 it
//      only redirects to /login when isProtectedPath(location.pathname). Drop a
//      real destination from this list and a user holding a pre-DB-split cookie
//      is stranded on a 401'd page with no way back (the bug commit 212a2e6
//      landed to fix). Add a real destination that ISN'T here and the same hole
//      reopens for it.
//
// The list is every authenticated top-level route (PRODUCT_PLAN.md §3.4):
// the pre-clone destinations, /settings and /admin, plus the clone's
// authenticated prefixes (FND-6a): /onboarding, /profile, /assistant, /ready,
// /inbox, /invite, /coaching and /referrals.
//
// It is checked against the route tree (INT-12; __tests__/lib/proxyPaths.test.ts):
// every first segment under app/(auth) and app/(onboarding) must be in this
// list, and no page outside those two groups may sit under one of these
// prefixes. So a new signed-in page cannot ship ungated, and a public page
// cannot end up behind the login gate by accident.
//
// `/job-search` stays although its page is gone (INT-12 deleted the old
// search workspace): `next.config.mjs` redirects the bare path to
// /jobs/explore before the gate sees it, but /job-search/developers (the API
// key page) is still a signed-in page under this prefix, on both brands (the
// Job Search API is offered on RoboApply and GoApply; D5). The public
// reference, /developers/job-search, is not behind the gate on either.
//
// The old V1/V2 entries (/mission, /apps, /home, /resumes, /tracker, /search,
// /insights, /queue, /preferences, /mock-interview, /activity, /choose-plan,
// /plans, /account) are gone: those routes no longer exist, and
// `next.config.mjs` redirects() forwards each one to its successor BEFORE the
// proxy's gate would have seen it — the 308 lands on a path that IS in this
// list, so a logged-out visitor on an old bookmark still ends up at
// /login?next=/jobs.
//
// Public pages that signed-in users also use (/campus, /job/*, /browse/*,
// /extension, /pricing, /tools/*) are NOT here: they render HybridShell.
//
// When you add a new authenticated top-level route, add it here AND to
// APP_PATHS in app/robots.ts (a test keeps the two equal).

export const PROTECTED_PREFIXES = [
  // The four destinations (+ /job-search for /job-search/developers).
  '/jobs',
  '/job-search',
  '/resume',
  '/applications',
  '/practice',
  // Settings (lower nav group) and /admin (role check).
  '/settings',
  '/admin',
  // The clone's authenticated routes (FND-6a; PRODUCT_PLAN.md §3.4).
  '/onboarding',
  '/profile',
  '/assistant',
  '/ready',
  '/inbox',
  '/invite',
  '/coaching',
  '/referrals',
] as const;

/** True when `pathname` is exactly a protected prefix or nested under one. */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Cookie the proxy sets when it clamps a locale the brand does not serve
 * (e.g. /zh-TW on GoApply → /zh), holding the dropped locale for ~10 minutes.
 * Must equal CLAMPED_FROM_COOKIE in components/features/brand/nudge.ts, which
 * the wrong-brand nudge reads (pinned by __tests__/lib/brandFromHost.test.ts).
 */
export const CLAMPED_FROM_COOKIE = 'ra_clamped_from';
