// robots.txt — host-aware (ARCHITECTURE.md §9.5; TASK_PLAN.md WP-56):
//   - every crawler: the marketing pages are open; the authenticated app
//     (PROTECTED_PREFIXES) and /api/ are disallowed — "requires a session"
//     and "not worth crawling" are the same set — and so are the utility
//     routes reached from private links (UTILITY_DISALLOW_PATHS in
//     lib/seo.ts: /alerts/confirm/, /unsubscribe/, /r/). Free-tool results
//     have no page URL (API only), so /api/ already covers them;
//   - AI crawlers (GPTBot, ClaudeBot, PerplexityBot, …): welcome on the
//     marketing pages (being cited in AI answers is a growth channel), but
//     disallowed on /job/* until recruiter-bank syndication consent exists
//     (OPS-A4);
//   - brands Baidu indexes (GoApply) get a Baiduspider group;
//   - `sitemap:` points at this host's /sitemap.xml.
// The rules live in lib/seo.ts `robotsFor(brand)`.

import type { MetadataRoute } from 'next';

import { robotsFor } from '../lib/seo';
import { getServerBrandId } from '../lib/server/brand';

export default async function robots(): Promise<MetadataRoute.Robots> {
  return robotsFor(await getServerBrandId());
}
