// POST /api/revalidate — on-demand revalidation of the SEO data caches
// (ARCHITECTURE.md §9.2). Called by `seo-rebuild` (server/src/features/seo/cron.ts)
// with `x-ra-internal: <INTERNAL_API_SECRET>` and `{ "tags": [...] }`. Runs
// `revalidateTag(tag, 'max')` on each `seo:<brand>:<type>:<slug>` tag that
// lib/server/publicApi.ts assigned to an unstable_cache entry (stale content
// is served while it refreshes). Not under /api/v1, so Next serves it.
//
//   401 without the secret (or when no secret is configured), 422 on a bad
//   body, 200 { revalidated: n } otherwise. Never cached.

import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';

/** `seo:<brand>:<type>:<slug>` — the only tags this route accepts. */
export const SEO_TAG = /^seo:(roboapply|goapply):[a-z_]{1,32}:[\p{L}\p{N}/_-]{1,200}$/u;
export const MAX_TAGS = 500;

const NO_STORE = { 'cache-control': 'no-store' };

function authorized(sent: string | null, secret: string | undefined): boolean {
  if (!secret || !sent) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req.headers.get('x-ra-internal'), process.env.INTERNAL_API_SECRET?.trim())) {
    return Response.json({ success: false, code: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const body = (await req.json().catch(() => null)) as { tags?: unknown } | null;
  const tags = body?.tags;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_TAGS || !tags.every((t) => typeof t === 'string' && SEO_TAG.test(t))) {
    return Response.json({ success: false, code: 'invalid_request' }, { status: 422, headers: NO_STORE });
  }
  for (const tag of new Set(tags as string[])) revalidateTag(tag, 'max');
  return Response.json({ success: true, data: { revalidated: new Set(tags).size } }, { headers: NO_STORE });
}
