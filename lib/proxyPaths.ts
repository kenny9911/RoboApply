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
// authenticated prefixes (FND-6a): /onboarding (setup screens, no longer a
// redirect), /profile, /assistant, /ready, /inbox, /invite, /coaching and
// /referrals. A route whose page has not shipped yet is still gated: a
// signed-out visitor lands on /login, never on a stub.
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
  // The four destinations.
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
