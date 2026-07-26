// roboapply/proxy.ts
//
// Edge proxy (Next.js 16 renamed the `middleware` file convention to `proxy`).
// Two responsibilities, and deliberately no third:
//
// 1. **Auth gate** — every authenticated page redirects to /login with a
//    `?next=` round-trip when the session cookie is missing. The protected
//    surface is the four destinations (`/jobs`, `/resume`, `/applications`,
//    `/practice`) plus `/settings` and `/admin`. The list itself lives in
//    lib/proxyPaths.ts, which is also read by the API client's stale-session
//    recovery — see the note there before editing it.
//
// 2. **x-pathname** — stamp the request path onto a header so server layouts
//    can read it (see `next()` below).
//
// **This file does NOT route destinations.** It used to: a
// `REDIRECT_TO_HOME_WHEN_AUTHED = new Set(['/mission'])` sent authed visitors
// to `/home`, the V1→V2 default-landing flip. That set is deleted (ruling C29).
// `/home` no longer exists, and more importantly it was a SECOND router living
// beside the one in next.config.mjs — exactly the duplication the DO-NOT-RE-ADD
// note in `next.config.mjs`'s `redirects()` was written about, after the two
// copies silently reversed a product decision (5d19a7a vs 706aac1). Every
// destination redirect now lives in `next.config.mjs redirects()` and only
// there. Do not add a second one here.
//
// The marketing landing page (`/`) is ALWAYS served, session or not, so a
// logged-in user can still read it. `/login` and `/signup` are likewise never
// redirected here.

import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from './lib/config';
// PROTECTED_PREFIXES + isProtectedPath live in a next/server-free module so
// they're unit-testable without the Edge runtime (lib/proxyPaths.ts).
import { isProtectedPath } from './lib/proxyPaths';

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSession = !!req.cookies.get(SESSION_COOKIE_NAME)?.value;

  // Auth gate for protected paths.
  if (isProtectedPath(pathname)) {
    if (hasSession) return next(req, pathname);
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  return next(req, pathname);
}

/**
 * Pass the request through with an `x-pathname` header attached. Server
 * layouts/pages can't read the URL from `headers()` otherwise; the localized
 * landing routes (`/es`, `/ja`, …) rely on it to resolve <html lang> + the
 * message bundle from the path (see lib/serverLocale.ts).
 */
function next(req: NextRequest, pathname: string) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Run on every path except Next internals, static assets, and the local
  // /api/health probe. The handler filters from there.
  // Exclude ALL /api/* — those paths are served by the Express serverless
  // function (via vercel.json rewrites), never by the Next.js app, so the
  // proxy must not touch them (raw-body webhooks + SSE would break otherwise).
  //
  // '/' is listed EXPLICITLY: on Vercel's production router the unnamed-group
  // pattern requires a non-empty first segment, so it matches /settings but NOT
  // the bare root. The root is not protected, so this costs one no-op pass —
  // but the localized landing pages need their x-pathname header, and that is
  // what the explicit entry buys.
  matcher: ['/', '/((?!_next/|_static/|favicon.ico|api/).*)'],
};
