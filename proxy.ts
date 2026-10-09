// roboapply/proxy.ts
//
// Edge proxy (Next.js 16 renamed the `middleware` file convention to `proxy`).
// Three responsibilities, and deliberately no fourth:
//
// 1. **Brand** (ARCHITECTURE.md §1.3, §1.5) — one codebase serves RoboApply
//    (roboapply.io) and GoApply (goapply.top), resolved per request from the
//    Host. The proxy:
//      a. deletes any inbound `x-ra-brand` request header (anti-spoofing);
//      b. resolves the brand with lib/brand/runtime.ts (x-forwarded-host,
//         BRAND_HOST_MAP; on dev/preview hosts only: `?__brand=` →
//         `ra_brand_override` cookie → BRAND_FORCE). `?__brand=goapply` sets
//         the cookie (7 days, host-only); `?__brand=clear` deletes it;
//      c. refuses a brand this deployment does not serve (ALLOWED_BRANDS /
//         BRAND_LOCK) with a 404, like the API;
//      d. **locale clamp** — when the path's first segment is a locale the
//         brand does not serve, redirects to the same path under the brand's
//         default locale (GoApply: `/zh-TW/x` → `/zh/x`; the page then shows
//         the RoboApply nudge). This is a locale redirect, not a destination
//         router, so it does not break ruling C29 below;
//      e. stamps `x-ra-brand` on the request for server components
//         (lib/server/brand.ts).
//
// 2. **Auth gate** — every authenticated page redirects to /login with a
//    `?next=` round-trip when the session cookie is missing. The protected
//    surface is the four destinations (`/jobs`, `/resume`, `/applications`,
//    `/practice`) plus `/settings` and `/admin`. The list itself lives in
//    lib/proxyPaths.ts, which is also read by the API client's stale-session
//    recovery — see the note there before editing it.
//
// 3. **x-pathname** — stamp the request path onto a header so server layouts
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
// there. Do not add a second one here. The brand never redirects across
// domains either: a visitor in the "other" market gets a dismissible nudge,
// never a redirect (TW-01).
//
// The marketing landing page (`/`) is ALWAYS served, session or not, so a
// logged-in user can still read it. `/login` and `/signup` are likewise never
// redirected here.

import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from './lib/config';
import { getBrand } from './lib/brand/registry.generated';
import {
  BRAND_HEADER,
  BRAND_OVERRIDE_COOKIE,
  BRAND_OVERRIDE_MAX_AGE_SEC,
  BRAND_QUERY_PARAM,
  PATHNAME_HEADER,
  clampLocalePath,
  resolveWebBrand,
  type WebBrandResolution,
} from './lib/brand/runtime';
// PROTECTED_PREFIXES + isProtectedPath live in a next/server-free module so
// they're unit-testable without the Edge runtime (lib/proxyPaths.ts).
import { CLAMPED_FROM_COOKIE, isProtectedPath } from './lib/proxyPaths';

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // 1. Brand.
  const resolution = resolveWebBrand({
    host: req.headers.get('host'),
    forwardedHost: req.headers.get('x-forwarded-host'),
    queryOverride: req.nextUrl.searchParams.get(BRAND_QUERY_PARAM),
    cookieOverride: req.cookies.get(BRAND_OVERRIDE_COOKIE)?.value ?? null,
  });
  if (!resolution.allowed) {
    return new NextResponse('This site is not served by this deployment.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const brand = getBrand(resolution.brandId);

  const clamped = clampLocalePath(pathname, brand);
  if (clamped) {
    const url = req.nextUrl.clone();
    url.pathname = clamped;
    const res = NextResponse.redirect(url);
    // Remember the dropped locale for ~10 min so the wrong-brand nudge can
    // offer the other brand (e.g. /zh-TW on GoApply → RoboApply in Traditional
    // Chinese). Readable by the client; never used for routing.
    res.cookies.set(CLAMPED_FROM_COOKIE, pathname.split('/')[1]!, { path: '/', sameSite: 'lax', maxAge: 600 });
    return withOverrideCookie(res, resolution);
  }

  // 2. Auth gate for protected paths.
  const hasSession = !!req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (isProtectedPath(pathname) && !hasSession) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', pathname + search);
    return withOverrideCookie(NextResponse.redirect(loginUrl), resolution);
  }

  // 3. Continue with the stamped headers.
  return withOverrideCookie(next(req, pathname, resolution.brandId), resolution);
}

/**
 * Pass the request through with `x-pathname` and `x-ra-brand` attached.
 * Server layouts/pages can't read the URL from `headers()` otherwise; the
 * localized landing routes (`/es`, `/ja`, …) rely on it to resolve <html lang>
 * + the message bundle from the path (see lib/serverLocale.ts). Any inbound
 * `x-ra-brand` is replaced, never trusted.
 */
function next(req: NextRequest, pathname: string, brandId: string) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete(BRAND_HEADER);
  requestHeaders.set(BRAND_HEADER, brandId);
  requestHeaders.set(PATHNAME_HEADER, pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/** Apply the dev/preview override cookie decision to a response. */
function withOverrideCookie<T extends NextResponse>(res: T, resolution: WebBrandResolution): T {
  if (resolution.overrideCookie === 'clear') {
    res.cookies.delete(BRAND_OVERRIDE_COOKIE);
  } else if (resolution.overrideCookie) {
    res.cookies.set({
      name: BRAND_OVERRIDE_COOKIE,
      value: resolution.overrideCookie,
      path: '/',
      maxAge: BRAND_OVERRIDE_MAX_AGE_SEC,
      sameSite: 'lax',
      // Readable by lib/api/client.ts, which echoes it as X-RA-Brand in dev.
      httpOnly: false,
      // No `domain`: host-only, so roboapply and goapply dev hosts stay apart.
    });
  }
  return res;
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
