// roboapply/proxy.ts
//
// Edge proxy (Next.js 16 renamed the `middleware` file convention to `proxy`).
// Two responsibilities:
//
// 1. **Auth gate** — every authenticated page redirects to /login with a
//    `?next=` round-trip when the session cookie is missing. Protected
//    prefixes include the V1 holdovers (`/mission`, `/apps`, `/settings`)
//    AND the V2 surface (`/home`, `/resumes`, `/tracker`, `/search`,
//    `/jobs`, `/insights`).
//
// 2. **V2 default landing flip** — `/mission` was the V1 daily driver; V2
//    moves the daily driver to `/home`. When a logged-in user hits `/` or
//    `/mission` we redirect to `/home`. `/mission` stays reachable via
//    direct deep-link from email or bookmark — it just stops being the
//    default landing. Per CTO ruling 03-frontend-architecture.md §0.
//
// Note: V1 public routes (`/`, `/login`, `/signup`) only redirect when the
// user already has a session. Unauthenticated visitors still see the
// landing page.

import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from './lib/config';
// PROTECTED_PREFIXES + isProtectedPath live in a next/server-free module so
// they're unit-testable without the Edge runtime (lib/proxyPaths.ts).
import { isProtectedPath } from './lib/proxyPaths';

/** Paths that, when a user has a session, should bounce to /home. The
 *  landing page (`/`) is bounced too — a logged-in user opening the marketing
 *  page expects to be inside the app. */
const REDIRECT_TO_HOME_WHEN_AUTHED = new Set<string>(['/', '/mission']);

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSession = !!req.cookies.get(SESSION_COOKIE_NAME)?.value;

  // 1. Authed default-landing redirect: / and /mission → /home
  if (hasSession && REDIRECT_TO_HOME_WHEN_AUTHED.has(pathname)) {
    const homeUrl = req.nextUrl.clone();
    homeUrl.pathname = '/home';
    homeUrl.search = '';
    return NextResponse.redirect(homeUrl);
  }

  // 2. Auth gate for protected paths
  if (isProtectedPath(pathname)) {
    if (hasSession) return NextResponse.next();
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every path except Next internals, static assets, and the local
  // /api/health probe. The handler filters from there.
  // Exclude ALL /api/* — those paths are served by the Express serverless
  // function (via vercel.json rewrites), never by the Next.js app, so the
  // proxy must not touch them (raw-body webhooks + SSE would break otherwise).
  matcher: ['/((?!_next/|_static/|favicon.ico|api/).*)'],
};
