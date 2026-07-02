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
    // Logged-in `/` → /home. This duplicates proxy.ts's root rule on purpose:
    // on Vercel's production router the proxy is never invoked for the bare
    // root path (even with '/' listed explicitly in its matcher — verified
    // against the deployed functions-config manifest), so the redirect
    // silently didn't fire in prod while working in `next dev`. A config
    // redirect compiles into the routes-manifest and runs in Vercel's routing
    // layer before any page, immune to the proxy quirk. Cookie PRESENCE is
    // the condition (same signal the proxy uses) — an invalid session still
    // lands on /home and gets bounced to /login by the client auth check.
    return [
      {
        source: '/',
        has: [{ type: 'cookie', key: 'ra_session_token' }],
        destination: '/home',
        permanent: false,
      },
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
