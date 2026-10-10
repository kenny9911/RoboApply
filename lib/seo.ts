// roboapply/lib/seo.ts
//
// Marketing-site SEO/GEO helpers (WP-40 owns the landing metadata; WP-56
// extends this file for the programmatic pages). Server-only (imports the
// message bundles via lib/i18n).
//
// Two layers:
//   - Brand-aware helpers used by every marketing page since WP-40:
//     `homeMetadata(brandId, locale)`, `marketingMetadata(...)`,
//     `brandLanguageAlternates(brandId)`, `marketingJsonLd(...)`,
//     `faqPageNode(...)`, `messageAt(...)`. Canonical and hreflang follow the
//     request's brand (ARCHITECTURE.md §1.6: RoboApply's cluster points zh-CN
//     at GoApply; GoApply points en and zh-Hant at RoboApply).
//   - The pre-brand landing helpers (`landingMetadata`, `landingJsonLd`,
//     `languageAlternates`) kept for app/sitemap.ts and existing tests.
//     @deprecated for new pages; WP-56 rewrites the sitemap, WP-75 deletes them.
//
// URL scheme: `/` is the brand's default locale AND the x-default; every
// other locale lives at `/{locale}` so crawlers get stable, indexable
// localized documents. On RoboApply `/en` also renders English (so a link
// can force it) but canonicalizes to `/` and is not part of the cluster.

import type { Metadata } from 'next';

import { loadMessages } from './i18n';
import {
  HREFLANG,
  LOCALES,
  SEO_READY_LOCALES,
  localePath,
  type RoboLocale,
} from './localeConfig';
import { MARKET_CURRENCY, PLAN_PRICES_MINOR, type BillingMarket } from './pricing';
import { getBrand, type BrandId, type ProductBrand } from './brand/registry.generated';

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
    // Fallbacks only matter before a bundle has `landing.meta`. The retired
    // auto-apply tagline is gone (ruling R1, WP-40): the product never applies.
    title: meta.title ?? `Find out why you're not getting interviews | ${SITE_NAME}`,
    description:
      meta.description ??
      `${SITE_NAME} shows the jobs that fit your resume, names what each one is missing, and lets you practice the interview. You send every application yourself.`,
    ogTitle: meta.ogTitle ?? meta.title ?? `${SITE_NAME}: find out why you're not getting interviews`,
    ogDescription: meta.ogDescription ?? meta.description ?? `${SITE_NAME} shows the jobs that fit your resume and what each one is missing.`,
    keywords: meta.keywords,
  };
}

/** Full Metadata object for a landing page (root or /{locale}). @deprecated use homeMetadata (brand-aware). */
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
          alt: SITE_NAME,
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
 * Prices come from lib/pricing.ts — the table the visible pricing section
 * renders from — in the currency this visitor's market pays in, so the
 * structured data never disagrees with the page beside it.
 */
/** @deprecated legacy practice-plan offers; new pages use marketingJsonLd (no prices in structured data). */
export function landingJsonLd(locale: RoboLocale, market: BillingMarket = 'other'): string {
  const { title, description } = landingMetaStrings(locale);
  const url = `${SITE_URL}${localePath(locale)}`;
  const lang = HREFLANG[locale];
  const currency = MARKET_CURRENCY[market];
  // schema.org wants a decimal string in major units.
  const price = (plan: keyof typeof PLAN_PRICES_MINOR) =>
    String(PLAN_PRICES_MINOR[plan][currency] / 100);
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
          priceCurrency: currency,
          lowPrice: price('free'),
          highPrice: price('growth'),
          offerCount: 3,
          offers: [
            { '@type': 'Offer', name: 'Free', price: price('free'), priceCurrency: currency },
            { '@type': 'Offer', name: 'Starter', price: price('starter'), priceCurrency: currency },
            { '@type': 'Offer', name: 'Growth', price: price('growth'), priceCurrency: currency },
          ],
        },
      },
    ],
  };
  // Escape `<` so a malicious translation string can't break out of the
  // <script> element.
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}

// ── Brand-aware marketing helpers (WP-40) ───────────────────────────────

type Tree = Record<string, unknown>;

/** A string from the brand × locale bundle (`%BRAND%` substituted), or `fallback`. */
export function messageAt(locale: RoboLocale, brandId: BrandId, path: string, fallback = ''): string {
  let node: unknown = loadMessages(locale, brandId);
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return fallback;
    node = (node as Tree)[part];
  }
  return typeof node === 'string' ? node : fallback;
}

/** Absolute URL on the brand's canonical origin. */
export function brandUrl(brandId: BrandId, path: string): string {
  const origin = getBrand(brandId).canonicalOrigin.replace(/\/+$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The home path of a locale on a brand (`/` for the brand's default locale). */
export function homePath(brand: Pick<ProductBrand, 'defaultLocale'>, locale: RoboLocale): string {
  return localePath(locale, brand.defaultLocale);
}

/**
 * hreflang cluster of the home pages per brand (ARCHITECTURE.md §1.6):
 *   RoboApply — every translated locale on roboapply.io (+ zh-HK → zh-TW),
 *               `zh-CN` → www.goapply.top/, x-default → /.
 *   GoApply   — `zh-CN` → www.goapply.top/ (only zh-CN: RoboApply's /zh owns
 *               `zh-Hans`, and two clusters claiming one value get ignored),
 *               `en` → www.roboapply.io/, `zh-Hant` → www.roboapply.io/zh-TW,
 *               x-default → /.
 */
export function brandLanguageAlternates(brandId: BrandId): Record<string, string> {
  const brand = getBrand(brandId);
  const other = getBrand(brand.otherBrand);
  const langs: Record<string, string> = {};
  if (brand.market === 'cn') {
    langs['zh-CN'] = brandUrl(brand.id, '/');
    langs.en = brandUrl(other.id, homePath(other, 'en'));
    if (SEO_READY_LOCALES.includes('zh-TW')) langs['zh-Hant'] = brandUrl(other.id, homePath(other, 'zh-TW'));
    langs['x-default'] = brandUrl(brand.id, '/');
    return langs;
  }
  for (const locale of SEO_READY_LOCALES) {
    if (!brand.seoLocales.includes(locale)) continue;
    langs[HREFLANG[locale]] = brandUrl(brand.id, homePath(brand, locale));
  }
  if (langs[HREFLANG['zh-TW']]) langs['zh-HK'] = brandUrl(brand.id, homePath(brand, 'zh-TW'));
  langs['zh-CN'] = brandUrl(other.id, homePath(other, 'zh'));
  langs['x-default'] = brandUrl(brand.id, '/');
  return langs;
}

/** True when a locale page of this brand may be indexed (translated and an SEO locale of the brand). */
export function isIndexableLocale(brandId: BrandId, locale: RoboLocale): boolean {
  return getBrand(brandId).seoLocales.includes(locale) && SEO_READY_LOCALES.includes(locale);
}

export interface MarketingMetaInput {
  brandId: BrandId;
  locale: RoboLocale;
  /** Path on the brand origin, e.g. `/pricing`. */
  path: string;
  title: string;
  description: string;
  ogTitle?: string;
  ogDescription?: string;
  /** hreflang alternates (home pages only). */
  languages?: Record<string, string>;
  /** Force noindex (gated pages). Default: indexable when the locale is. */
  noindex?: boolean;
}

/** Metadata for any marketing page: canonical on the brand origin, brand-named OG, robots per locale. */
export function marketingMetadata(input: MarketingMetaInput): Metadata {
  const brand = getBrand(input.brandId);
  const canonical = brandUrl(brand.id, input.path);
  const ogTitle = input.ogTitle ?? input.title;
  const ogDescription = input.ogDescription ?? input.description;
  const image = brandUrl(brand.id, brand.assets.og);
  const indexable = !input.noindex && isIndexableLocale(brand.id, input.locale);
  return {
    title: input.title,
    description: input.description,
    alternates: { canonical, ...(input.languages ? { languages: input.languages } : {}) },
    openGraph: {
      type: 'website',
      url: canonical,
      siteName: brand.name,
      title: ogTitle,
      description: ogDescription,
      locale: OG_LOCALE[input.locale],
      images: [{ url: image, width: 1200, height: 630, alt: brand.name }],
    },
    twitter: { card: 'summary_large_image', title: ogTitle, description: ogDescription, images: [image] },
    robots: indexable ? { index: true, follow: true, 'max-image-preview': 'large' } : { index: false, follow: true },
  };
}

/** Home page metadata per brand × locale (canonical `/` for the default locale, `/{locale}` otherwise). */
export function homeMetadata(brandId: BrandId, locale: RoboLocale): Metadata {
  const brand = getBrand(brandId);
  const ns = brand.market === 'cn' ? 'landing.cnHome.meta' : 'landing.home.meta';
  const title = messageAt(locale, brandId, `${ns}.title`, brand.name);
  const description = messageAt(locale, brandId, `${ns}.description`);
  return marketingMetadata({
    brandId,
    locale,
    path: homePath(brand, locale),
    title,
    description,
    ogTitle: messageAt(locale, brandId, `${ns}.ogTitle`, title),
    ogDescription: messageAt(locale, brandId, `${ns}.ogDescription`, description),
    languages: brandLanguageAlternates(brandId),
  });
}

export interface FaqEntry {
  q: string;
  a: string;
}

/** A schema.org FAQPage node (only for pages that show this FAQ text). */
export function faqPageNode(url: string, items: FaqEntry[]): Record<string, unknown> {
  return {
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: items.map((i) => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })),
  };
}

/**
 * JSON-LD for a marketing page: Organization + WebSite + WebPage, plus a
 * FAQPage when the page renders FAQ content. No prices, ratings or reviews
 * (D3: nothing the page can't back up; plan prices live in config).
 */
export function marketingJsonLd(input: { brandId: BrandId; locale: RoboLocale; path: string; name: string; description: string; faq?: FaqEntry[] }): string {
  const brand = getBrand(input.brandId);
  const site = brandUrl(brand.id, '/');
  const url = brandUrl(brand.id, input.path);
  const lang = HREFLANG[input.locale];
  const graph: Record<string, unknown>[] = [
    { '@type': 'Organization', '@id': `${site}#organization`, name: brand.name, url: site, logo: { '@type': 'ImageObject', url: brandUrl(brand.id, brand.assets.logo) } },
    { '@type': 'WebSite', '@id': `${site}#website`, url: site, name: brand.name, publisher: { '@id': `${site}#organization` }, inLanguage: lang },
    { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: input.name, description: input.description, inLanguage: lang, isPartOf: { '@id': `${site}#website` } },
  ];
  if (input.faq && input.faq.length > 0) graph.push(faqPageNode(url, input.faq));
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

/** FAQ entries from `<base>.<key>.q/.a` strings (skips empty ones). */
export function faqFromMessages(locale: RoboLocale, brandId: BrandId, base: string, keys: readonly string[]): FaqEntry[] {
  return keys
    .map((k) => ({ q: messageAt(locale, brandId, `${base}.${k}.q`), a: messageAt(locale, brandId, `${base}.${k}.a`) }))
    .filter((e) => e.q && e.a);
}
