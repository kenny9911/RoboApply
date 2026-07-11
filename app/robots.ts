// robots.txt — the marketing surface is open to everyone, including AI
// crawlers (being cited by ChatGPT/Perplexity/Claude answers is a growth
// channel — GEO). The authed app surface is disallowed: those URLs only
// bounce crawlers to /login and dilute the crawl budget.

import type { MetadataRoute } from 'next';

import { SITE_URL } from '../lib/seo';

const APP_PATHS = [
  '/api/',
  '/home',
  '/tracker',
  '/resumes',
  '/queue',
  '/activity',
  '/admin',
  '/account',
  '/preferences',
  '/mock-interview',
  '/plans',
  '/choose-plan',
  '/onboarding',
  '/mission',
  '/apps',
  '/settings',
];

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
