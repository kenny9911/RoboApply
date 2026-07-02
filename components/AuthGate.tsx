'use client';

// AuthGate — client-side authentication guard for the RoboApply (auth) shell.
//
// Historically the authenticated routes were gated ONLY by the edge proxy
// (roboapply/proxy.ts), which redirects unauthenticated requests to /login.
// That single guard has two blind spots:
//   1. Next.js middleware/proxy does NOT run on client-side soft navigations,
//      so following an in-app <Link> (e.g. the sidebar logo → /home) never hits
//      it — a logged-out user lands on the protected route client-side.
//   2. If the proxy is inactive for any reason, nothing redirects at all.
// In either case an unauthenticated visitor reaches a protected route and the
// downstream JobApplyingGate hangs on an infinite spinner (a blank page),
// because the session never resolves to "authenticated".
//
// This gate closes that gap on the client: once auth resolves to
// `unauthenticated`, it redirects to /login (preserving a ?next= return path
// the login page already honours). It renders children while auth is still
// `loading` (eager render — matches RoboApplyAccessGate / ResumeGate) and once
// `authenticated`, so signed-in users never see a flash or a gating spinner.

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth/AuthProvider';

export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const unauthenticated = status === 'unauthenticated';

  useEffect(() => {
    if (!unauthenticated) return;
    // Preserve a return path so the login page can bounce the user back to the
    // page they tried to reach (it reads ?next= and router.replace()s to it).
    const next =
      pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
    router.replace(`/login${next}`);
  }, [unauthenticated, pathname, router]);

  if (unauthenticated) {
    return (
      <div
        className="dark-canvas v3-root"
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}
      >
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }

  return <>{children}</>;
}
