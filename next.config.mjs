/**
 * The `next/image` remote pattern for a public asset base URL (WP-76 →
 * INT-13), or null when the value is unset or unusable.
 *
 * GoApply's public images live on mainland storage, not on the R2 bucket:
 * `CN_PUBLIC_ASSET_BASE_URL` names that OSS bucket or CDN origin, for
 * example `https://assets.example.cn/public`.
 * The pattern is exactly that origin: the parsed host (never a wildcard), its
 * port, and the base path as a prefix. Anything that is not a plain https
 * URL — http, credentials in the URL, a `*` in the host, a bare hostname —
 * yields no pattern, so a typo can only make images fail closed, never open
 * the optimizer to other hosts.
 *
 * Build-time: Next.js serializes this config into the build, so the value
 * must be present when `next build` runs (the CN image passes it as a build
 * argument; a runtime-only value has no effect on the standalone server).
 *
 * @param {unknown} raw
 * @returns {{ protocol: 'https', hostname: string, port: string, pathname: string } | null}
 */
export function assetRemotePattern(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  // A real host only: no wildcard, no single-label name, nothing a typo could widen.
  if (!hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname) || hostname.startsWith('.') || hostname.endsWith('.')) return null;
  const base = url.pathname.replace(/\/+$/, '');
  // `*` in the path would be read as a pattern wildcard by the image matcher.
  if (base.includes('*')) return null;
  return { protocol: 'https', hostname, port: url.port, pathname: `${base}/**` };
}

/**
 * Remote image hosts: the international R2 bucket, plus the GoApply asset
 * origin when `CN_PUBLIC_ASSET_BASE_URL` is set (R-03: the CN_ name only; no
 * unprefixed twin is read, because RoboApply's host is the fixed R2 entry).
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function imageRemotePatterns(env = process.env) {
  const patterns = [
    // R2 public bucket. Adjust when production host is finalized.
    { protocol: 'https', hostname: 'r2.robohire.io', pathname: '/**' },
    { protocol: 'https', hostname: '**.r2.cloudflarestorage.com', pathname: '/**' },
  ];
  const cn = assetRemotePattern(env.CN_PUBLIC_ASSET_BASE_URL);
  if (cn) patterns.push(cn);
  return patterns;
}

// Version skew on the mainland stack (several web replicas behind the
// gateway, rolled one at a time): Next.js reads the deployment id from the
// `NEXT_DEPLOYMENT_ID` environment variable at build time, and the CN image
// build sets it to the git SHA (.github/workflows/deploy-cn.yml). It is
// deliberately NOT set as `deploymentId` here: on Vercel the platform provides
// NEXT_DEPLOYMENT_ID itself, and this Next.js version fails the production
// build when a config value disagrees with it
// (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/deploymentId.md).

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    // Dev-only default. NEVER default to localhost in a production build:
    // Vercel builds without NEXT_PUBLIC_API_URL used to bake
    // `http://localhost:4607` into the client bundle, so the deployed site
    // fetched the DEVELOPER'S machine (CORS-blocked "Failed to fetch" on
    // every API call). In production the API is same-origin via the
    // vercel.json rewrite (/api/v1/* → api/index), so an empty API_BASE
    // (relative URLs) is exactly right — only set NEXT_PUBLIC_API_URL in
    // prod if the API genuinely lives on another host.
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ??
      (process.env.NODE_ENV === 'development' ? 'http://localhost:4607' : ''),
  },
  // The legal pages read content/legal/<market>/*.md at request time
  // (app/legal/legalSource.ts, WP-13); file tracing cannot see those reads,
  // so ship the folder with the /legal/[doc] route. The API function gets the
  // same folder through vercel.json includeFiles.
  // Two keys on purpose: the route glob `/legal/*` does not match the index
  // page `/legal` itself (app/legal/page.tsx reads the same folder).
  outputFileTracingIncludes: {
    '/legal': ['./content/legal/**/*'],
    '/legal/*': ['./content/legal/**/*'],
  },
  images: {
    remotePatterns: imageRemotePatterns(),
  },
  experimental: {
    // DEV ONLY, but load-bearing. `next dev` proxies every rewrites() entry
    // through http-proxy with a HARD-CODED 30s cap when this is unset
    // (next/dist/server/lib/router-utils/proxy-request.js: `proxyTimeout || 30_000`).
    // Resume ingest of a scanned PDF runs 45-80s (GoHire parse-resume alone
    // measured 45.4s), so the proxy destroyed the upload socket mid-flight and
    // the browser got a plain-text 500 "Internal Server Error" while the API
    // happily finished and committed the résumé — the user saw "could not be
    // created, try again", retried, and minted duplicate rows.
    //
    // Do NOT "disable" this with 0: the schema accepts it, but `proxyTimeout || 30_000`
    // treats 0 as falsy and silently restores the 30s cut. Use a large positive number.
    // Production is unaffected — rewrites() returns [] outside development and
    // Vercel routes /api/v1/* straight to the function (vercel.json maxDuration: 300).
    proxyTimeout: 600_000,
  },
  async redirects() {
    // No root redirect. The marketing page at `/` is ALWAYS served, session
    // or not — logged-in users can view the landing page (product decision
    // 706aac1 "Stop bouncing logged-in users off the landing page").
    //
    // DO-NOT-RE-ADD: a `/` + ra_session_token cookie → /home config redirect
    // used to live here (5d19a7a). It landed 42 min AFTER 706aac1 dropped the
    // same bounce from proxy.ts, silently reversing that decision in a second
    // file — logged-in visitors to `/` were sent to /home and, on a stale
    // session, bounced on to /login, never seeing the landing page. proxy.ts
    // is now the single source of truth for root routing and deliberately does
    // NOT bounce `/`. Note the Vercel quirk that motivated the config copy: the
    // proxy may not fire for the bare root on prod, so a proxy-only root bounce
    // can behave differently in dev vs prod.
    //
    // 2026-07-26 update: proxy.ts no longer routes anything. Its
    // REDIRECT_TO_HOME_WHEN_AUTHED set (the `/mission` → `/home` bounce) is
    // deleted — it pointed at a route that no longer exists, and it was the
    // second copy of the router the DO-NOT-RE-ADD note above was written about.
    // proxy.ts now only gates auth and stamps x-pathname. THIS FUNCTION is the
    // only destination router in the app. Keep it that way.
    //
    // ── The 2026 information architecture (OVERHAUL_RULINGS R1/D2; the
    // clone's IA is PRODUCT_PLAN.md §3.3–3.4, registry in
    // components/v3/shell/destinations.ts) ─────────────────────────────────
    //
    // Destinations: /jobs · /applications · /resume · /practice (+ the clone's
    // /ready, /profile, … as they ship), plus /settings. Most entries below
    // are routes this app once had. They are permanent (308) because the moves are permanent:
    // pre-launch, nobody has these bookmarked, but the landing page, old
    // emails, the sitemap and nine locale bundles all still point at some of
    // them, and a 404 on the first click after signup is not recoverable.
    //
    // Destination rules, so a future addition lands in the right column:
    //   • a renamed screen goes to its rename (/home → /jobs);
    //   • a DELETED screen goes to the destination that answers the same
    //     question (/queue was a list of jobs → /jobs; /activity and /insights
    //     were both "what happened to my applications" → /applications);
    //   • a setup or account screen goes to /settings;
    //   • a V1 shell route goes to the marketing page at `/`.
    const permanent = true;
    return [
      // Renamed destinations. `:id` and `:path*` carry the deep links.
      { source: '/home', destination: '/jobs', permanent },
      { source: '/tracker', destination: '/applications', permanent },
      { source: '/resumes', destination: '/resume', permanent },
      { source: '/resumes/:id', destination: '/resume/:id', permanent },
      { source: '/mock-interview', destination: '/practice', permanent },
      { source: '/mock-interview/:path*', destination: '/practice/:path*', permanent },

      // Deleted screens, folded into the destination that answers the same
      // question. /queue held jobs the agent had staged; auto-apply is dead
      // (R1) and the jobs themselves live on /jobs.
      { source: '/queue', destination: '/jobs', permanent },
      { source: '/activity', destination: '/applications', permanent },
      { source: '/insights', destination: '/applications', permanent },
      { source: '/search', destination: '/jobs', permanent },

      // Setup and account screens. Settings is ONE page with sections, so all
      // three former routes land on the same URL rather than on fragments —
      // the page opens on "Your search", which is what /preferences was.
      { source: '/preferences', destination: '/settings', permanent },
      { source: '/plans', destination: '/settings', permanent },
      { source: '/account', destination: '/settings', permanent },
      // /account/billing/history moved under /settings; the sub-tree catch-all
      // must come AFTER the exact /account rule above.
      { source: '/account/billing/history', destination: '/settings/billing/history', permanent },
      { source: '/account/:path*', destination: '/settings', permanent },

      // The signup funnel's plan interstitial is deleted: plan choice moved
      // into /settings. (/onboarding is NOT redirected any more: it is the
      // setup flow again — app/(onboarding)/onboarding/[step], PRODUCT §4 —
      // and an authenticated prefix in lib/proxyPaths.ts. FND-6a.)
      { source: '/choose-plan', destination: '/jobs', permanent },

      // /job-search is absorbed by the category browse at /jobs/explore
      // (PRODUCT §3.4). Only the bare path moves: /job-search/developers (API
      // keys) stays where it is, and this rule has no wildcard so it never
      // matches it. Temporary (307) until WP-33 ships /jobs/explore for real,
      // so browsers do not cache the move while the route is still a shell.
      { source: '/job-search', destination: '/jobs/explore', permanent: false },

      // V1 shell routes. Neither had a V2 successor; the marketing page is the
      // honest landing for a link this old.
      { source: '/mission', destination: '/', permanent },
      { source: '/apps', destination: '/', permanent },
    ];
  },
  async rewrites() {
    // Dev only — proxy /api/* to local backend so the cookie path stays
    // same-origin and the client can use relative URLs.
    if (process.env.NODE_ENV === 'development') {
      const target = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4607';
      return [
        // The local /api/health route handler in roboapply-app/ must NOT be
        // proxied (it's our own liveness probe). Everything else under /api/v1
        // forwards to the backend.
        { source: '/api/v1/:path*', destination: `${target}/api/v1/:path*` },
        { source: '/api/auth/:path*', destination: `${target}/api/auth/:path*` },
      ];
    }
    return [];
  },
};

export default nextConfig;
