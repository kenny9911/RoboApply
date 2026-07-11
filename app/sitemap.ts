// sitemap.xml — the landing cluster (x-default `/` + 8 localized URLs), each
// entry carrying the full hreflang alternate set, plus the public auth pages.

import type { MetadataRoute } from 'next';

import { SEO_READY_LOCALES } from '../lib/localeConfig';
import { SITE_URL, languageAlternates, localePath } from '../lib/seo';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const languages = languageAlternates();

  const landingCluster: MetadataRoute.Sitemap = SEO_READY_LOCALES.map((locale) => ({
    url: `${SITE_URL}${localePath(locale)}`,
    lastModified,
    changeFrequency: 'weekly',
    priority: localePath(locale) === '/' ? 1 : 0.8,
    alternates: { languages },
  }));

  return [
    ...landingCluster,
    {
      url: `${SITE_URL}/signup`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/login`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.3,
    },
  ];
}
