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
  images: {
    remotePatterns: [
      // R2 public bucket. Adjust when production host is finalized.
      { protocol: 'https', hostname: 'r2.robohire.io', pathname: '/**' },
      { protocol: 'https', hostname: '**.r2.cloudflarestorage.com', pathname: '/**' },
    ],
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
    // ── The 2026 information architecture (OVERHAUL_RULINGS R1/D2) ──────────
    //
    // Four destinations: /jobs · /resume · /applications · /practice, plus a
    // /settings page behind the avatar menu. Everything below is a route this
    // app once had. They are permanent (308) because the moves are permanent:
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

      // The signup funnel's two interstitials. Both are deleted: plan choice
      // moved into /settings and the setup chat became a panel in the /jobs
      // filter bar (C21), so a new account goes straight to the product.
      { source: '/choose-plan', destination: '/jobs', permanent },
      { source: '/onboarding', destination: '/jobs', permanent },

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
