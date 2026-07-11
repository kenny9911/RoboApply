// roboapply/lib/seo.ts
//
// Landing-page SEO/GEO helpers shared by app/page.tsx, app/[locale]/page.tsx,
// and app/sitemap.ts. Server-only (imports the message bundles via lib/i18n).
//
// URL scheme: `/` is English AND the x-default (content-negotiated for
// first-time visitors via Accept-Language); every other locale lives at
// `/{locale}` so crawlers get stable, indexable localized documents with a
// full hreflang cluster. `/en` permanently redirects to `/`.

import type { Metadata } from 'next';

import { loadMessages } from './i18n';
import {
  HREFLANG,
  LOCALES,
  SEO_READY_LOCALES,
  localePath,
  type RoboLocale,
} from './localeConfig';

export { localePath };

export const SITE_URL = 'https://www.roboapply.io';
export const SITE_NAME = 'RoboApply';

/** Open Graph locale tags per RoboLocale. */
const OG_LOCALE: Record<RoboLocale, string> = {
  en: 'en_US',
  zh: 'zh_CN',
  'zh-TW': 'zh_TW',
  ja: 'ja_JP',
  ko: 'ko_KR',
  es: 'es_ES',
  fr: 'fr_FR',
  pt: 'pt_BR',
  de: 'de_DE',
};

/** hreflang → absolute URL map for the landing cluster (incl. x-default).
 *  Only SEO-ready (translated) locales participate; plus Bing-compat region
 *  aliases for Chinese (zh-CN / zh-HK don't parse script subtags). */
export function languageAlternates(): Record<string, string> {
  const langs: Record<string, string> = {};
  for (const locale of SEO_READY_LOCALES) {
    langs[HREFLANG[locale]] = `${SITE_URL}${localePath(locale)}`;
  }
  if (SEO_READY_LOCALES.includes('zh')) {
    langs['zh-CN'] = `${SITE_URL}${localePath('zh')}`;
  }
  if (SEO_READY_LOCALES.includes('zh-TW')) {
    langs['zh-HK'] = `${SITE_URL}${localePath('zh-TW')}`;
  }
  langs['x-default'] = `${SITE_URL}/`;
  return langs;
}

interface LandingMetaStrings {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  keywords?: string;
}

/** Pull the localized meta strings, with hard EN defaults so the landing
 *  never ships metadata-less even before a bundle has `landing.meta`. */
export function landingMetaStrings(locale: RoboLocale): LandingMetaStrings {
  const landing = (loadMessages(locale) as Record<string, unknown>).landing as
    | Record<string, unknown>
    | undefined;
  const meta = (landing?.meta ?? {}) as Partial<LandingMetaStrings>;
  return {
    title:
      meta.title ??
      'RoboApply — AI Job Application Agent | We apply. You interview.',
    description:
      meta.description ??
      'RoboApply is an AI agent that finds matching jobs, writes tailored cover letters, and applies for you overnight — plus AI mock interviews with real-time feedback. Start free.',
    ogTitle: meta.ogTitle ?? meta.title ?? 'RoboApply — We apply. You interview.',
    ogDescription:
      meta.ogDescription ??
      meta.description ??
      'Your AI agent applies to matching jobs while you sleep. You wake up to interviews.',
    keywords: meta.keywords,
  };
}

/** Full Metadata object for a landing page (root or /{locale}). */
export function landingMetadata(locale: RoboLocale): Metadata {
  const { title, description, ogTitle, ogDescription, keywords } =
    landingMetaStrings(locale);
  const canonical = `${SITE_URL}${localePath(locale)}`;
  return {
    title,
    description,
    ...(keywords ? { keywords } : {}),
    alternates: {
      canonical,
      languages: languageAlternates(),
    },
    openGraph: {
      type: 'website',
      url: canonical,
      siteName: SITE_NAME,
      title: ogTitle,
      description: ogDescription,
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((l) => l !== locale).map(
        (l) => OG_LOCALE[l],
      ),
      // Text-free brand image so one asset serves all 9 locales.
      images: [
        {
          url: `${SITE_URL}/og.png`,
          width: 1200,
          height: 630,
          alt: 'RoboApply — the AI job-search agent',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description: ogDescription,
      images: [`${SITE_URL}/og.png`],
    },
    robots: SEO_READY_LOCALES.includes(locale)
      ? { index: true, follow: true, 'max-image-preview': 'large' }
      : // Untranslated locale URLs stay reachable for humans (language menu)
        // but out of the index until their landing bundle ships.
        { index: false, follow: true },
  };
}

/**
 * JSON-LD @graph for the landing pages: Organization + WebSite + WebPage +
 * SoftwareApplication with an AggregateOffer. Entity hygiene only — no
 * aggregateRating/review (we have no collected ratings; faking them is a
 * manual-action trigger) and no FAQPage (Google removed FAQ rich results
 * May 2026; the visible FAQ text is what AI engines actually extract).
 * Prices must stay in sync with the visible pricing section
 * (server/src/lib/mockInterviewPlans.ts: Free $0 / Starter $15 / Growth $29).
 */
export function landingJsonLd(locale: RoboLocale): string {
  const { title, description } = landingMetaStrings(locale);
  const url = `${SITE_URL}${localePath(locale)}`;
  const lang = HREFLANG[locale];
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: SITE_NAME,
        url: SITE_URL,
        logo: {
          '@type': 'ImageObject',
          url: `${SITE_URL}/roboapply-logo.png`,
        },
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: SITE_NAME,
        publisher: { '@id': `${SITE_URL}/#organization` },
        inLanguage: lang,
      },
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: title,
        description,
        inLanguage: lang,
        isPartOf: { '@id': `${SITE_URL}/#website` },
        about: { '@id': `${SITE_URL}/#app` },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#app`,
        name: SITE_NAME,
        url: SITE_URL,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description,
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'USD',
          lowPrice: '0',
          highPrice: '29',
          offerCount: 3,
          offers: [
            { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Starter', price: '15', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Growth', price: '29', priceCurrency: 'USD' },
          ],
        },
      },
    ],
  };
  // Escape `<` so a malicious translation string can't break out of the
  // <script> element.
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}
