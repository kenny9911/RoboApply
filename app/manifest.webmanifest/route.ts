// GET /manifest.webmanifest — host-aware web app manifest (WP-61; ARCHITECTURE.md §8.4).
// The brand comes from the request host exactly as the proxy resolves it
// (lib/server/brand.ts); each host is cached separately (Vary).

import type { NextRequest } from 'next/server';

import { getBrand } from '../../lib/brand/registry.generated';
import { brandIdFromRequestParts } from '../../lib/server/brand';
import { buildManifest } from './manifest';

export function GET(req: NextRequest): Response {
  const brand = getBrand(brandIdFromRequestParts(req.headers, req.cookies));
  return new Response(JSON.stringify(buildManifest(brand)), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      vary: 'Host, X-Forwarded-Host',
    },
  });
}
