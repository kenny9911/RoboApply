// lib/proxyPaths.ts
//
// Pure path-matching helpers for the edge proxy (roboapply/proxy.ts), kept in a
// `next/server`-free module so they are unit-testable in plain Node/jsdom
// without pulling in the Edge runtime.
//
// PROTECTED_PREFIXES = every path that requires a session; the proxy 302s an
// unauthenticated visitor under any of these to /login?next=… . When you add a
// new authenticated top-level route, add it here (and, if it lives in the
// (auth) shell, the client gates already cover soft navigations).

export const PROTECTED_PREFIXES = [
  // V1 holdovers
  '/mission',
  '/apps',
  '/settings',
  // V2 daily driver + product surfaces
  '/home',
  '/resumes',
  '/tracker',
  '/search',
  '/jobs',
  '/insights',
  // V3 surfaces
  '/queue',
  '/preferences',
  '/mock-interview',
  '/activity',
  '/onboarding',
  '/choose-plan',
  '/plans',
] as const;

/** True when `pathname` is exactly a protected prefix or nested under one. */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
