// robots.txt — the marketing surface is open to everyone, including AI
// crawlers (being cited by ChatGPT/Perplexity/Claude answers is a growth
// channel — GEO). The authed app surface is disallowed: those URLs only
// bounce crawlers to /login and dilute the crawl budget.

import type { MetadataRoute } from 'next';

import { SITE_URL } from '../lib/seo';
import { PROTECTED_PREFIXES } from '../lib/proxyPaths';

// Every authenticated route — the same list as PROTECTED_PREFIXES in
// lib/proxyPaths.ts (plus /api/), and it must stay that way: "requires a
// session" and "not worth crawling" are the same set here
// (__tests__/shell/routes.test.ts checks the output). /job-search is listed
// through PROTECTED_PREFIXES like everything else.
// The pre-2026 routes (/home, /tracker, /resumes, /queue, /activity, /account,
// /preferences, /mock-interview, /plans, /choose-plan, /mission, /apps) are
// gone; next.config.mjs redirects() 308s each one, and a crawler following a
// stale link lands on a path this list already covers.
const APP_PATHS: string[] = ['/api/', ...PROTECTED_PREFIXES];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: APP_PATHS },
      // AI assistants explicitly welcome on the marketing pages — same app
      // disallows, spelled out so "are we blocking AI crawlers?" has an
      // unambiguous answer in the file itself.
      {
        userAgent: [
          'GPTBot',
          'OAI-SearchBot',
          'ChatGPT-User',
          'ClaudeBot',
          'Claude-User',
          'PerplexityBot',
          'Perplexity-User',
          'Google-Extended',
          'Applebot-Extended',
          'CCBot',
        ],
        allow: '/',
        disallow: APP_PATHS,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
