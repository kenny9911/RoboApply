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
// The list is exactly the four destinations plus the two non-destination
// authenticated surfaces (OVERHAUL_RULINGS D2). The old V1/V2 entries
// (/mission, /apps, /home, /resumes, /tracker, /search, /insights, /queue,
// /preferences, /mock-interview, /activity, /onboarding, /choose-plan, /plans,
// /account) are gone: those routes no longer exist, and `next.config.mjs`
// redirects() forwards each one to its successor BEFORE the proxy's gate would
// have seen it — the 308 lands on a path that IS in this list, so a logged-out
// visitor on an old bookmark still ends up at /login?next=/jobs.
//
// When you add a new authenticated top-level route, add it here.

export const PROTECTED_PREFIXES = [
  // The four destinations.
  '/jobs',
  '/resume',
  '/applications',
  '/practice',
  // Not destinations: settings lives behind the avatar menu, /admin behind a
  // role check.
  '/settings',
  '/admin',
] as const;

/** True when `pathname` is exactly a protected prefix or nested under one. */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
