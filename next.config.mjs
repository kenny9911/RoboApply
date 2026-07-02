/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4607',
  },
  images: {
    remotePatterns: [
      // R2 public bucket. Adjust when production host is finalized.
      { protocol: 'https', hostname: 'r2.robohire.io', pathname: '/**' },
      { protocol: 'https', hostname: '**.r2.cloudflarestorage.com', pathname: '/**' },
    ],
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
