// roboapply/lib/seo.ts
//
// Marketing-site SEO/GEO helpers (WP-40 owns the landing metadata; WP-56
// extends this file for the programmatic pages). Server-only (imports the
// message bundles via lib/i18n). WP-56 adds the builders at the end: browse
// path classification, JobPosting / BreadcrumbList JSON-LD, host-aware
// robots rules, sitemap XML and llms.txt.
//
// Brand-aware helpers used by every marketing page since WP-40:
// `homeMetadata(brandId, locale)`, `marketingMetadata(...)`,
// `brandLanguageAlternates(brandId)`, `marketingJsonLd(...)`,
// `faqPageNode(...)`, `messageAt(...)`. Canonical and hreflang follow the
// request's brand (ARCHITECTURE.md §1.6: RoboApply's cluster points zh-CN at
// GoApply; GoApply points en and zh-Hant at RoboApply). Nothing here names a
// product: the name, origin and assets come from the brand registry.
//
// The pre-brand landing helpers (a fixed product name and origin, and plan
// prices in structured data) were deleted in INT-06 together with the legacy
// landing component, after a zero-importer check.
//
// URL scheme: `/` is the brand's default locale AND the x-default; every
// other locale lives at `/{locale}` so crawlers get stable, indexable
// localized documents. On RoboApply `/en` also renders English (so a link
// can force it) but canonicalizes to `/` and is not part of the cluster.

import type { Metadata, MetadataRoute } from 'next';

import { loadMessages } from './i18n';
import {
  HREFLANG,
  SEO_READY_LOCALES,
  localePath,
  type RoboLocale,
} from './localeConfig';
import { getBrand, type BrandId, type ProductBrand } from './brand/registry.generated';
import { PROTECTED_PREFIXES } from './proxyPaths';
import type { PublicJobDetail } from './api/contracts/seo';

export { localePath };

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

// ── Programmatic pages, job pages, crawl policy (WP-56) ──────────────────
//
// Pure builders for the routes WP-56 owns: app/browse/**, app/job/**,
// app/robots.ts, app/sitemap.xml, app/sitemaps/[file], app/llms.txt. Data
// comes from lib/server/publicApi.ts; nothing here fetches.


/** Browse page types (twin of server/src/features/seo/contract.ts SEO_PAGE_TYPES). */
export type BrowsePageType = 'role' | 'role_city' | 'remote_role' | 'sponsorship_role' | 'segment' | 'graduate_role';

const BROWSE_SEGMENTS = new Set(['entry-level', 'internships']);
const BROWSE_SEGMENT_RE = /^[\p{L}\p{N}-]{1,80}$/u;

/**
 * Page type + slug of a browse path WITHOUT resolving it (the server does
 * that). Twin of the server's `classifyBrowsePath`; the slug equals the
 * server's canonical slug for canonical paths, so cache tags line up with
 * the ones `seo-rebuild` revalidates.
 */
export function classifyBrowseSegments(segments: readonly string[]): { type: BrowsePageType; slug: string } | null {
  const parts = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (parts.length === 0 || parts.length > 3 || !parts.every((p) => BROWSE_SEGMENT_RE.test(p))) return null;
  const [a, b, c] = parts;
  if (parts.length === 1 && BROWSE_SEGMENTS.has(a!)) return { type: 'segment', slug: a! };
  if (a === 'remote') return parts.length === 2 ? { type: 'remote_role', slug: b! } : null;
  if (a === 'graduate') return parts.length === 2 ? { type: 'graduate_role', slug: b! } : null;
  if (a === 'visa-sponsorship') return parts.length === 3 ? { type: 'sponsorship_role', slug: `${b}/${c}` } : null;
  if (parts.length === 1) return { type: 'role', slug: a! };
  if (parts.length === 2) return { type: 'role_city', slug: `${a}/${b}` };
  return null;
}

/** What a browse path that did not resolve asked for (`unknown_role` / `unknown_city` from the API). */
export interface BrowseUnknownQuery {
  kind: 'role' | 'city';
  /** The role as typed (dashes → spaces). */
  role: string;
  /** The city as typed, for role × city paths. */
  city: string | null;
}

/**
 * Map an unresolved browse path to the role (and city) the visitor typed, so
 * the page names the part we could not find: `/browse/backend-engineer/atlantis`
 * with `unknown_city` is a city miss for "backend engineer", not a role named
 * "atlantis". Null for any other reason or shape.
 */
export function browseUnknownQuery(segments: readonly string[], reason: string | null): BrowseUnknownQuery | null {
  if (reason !== 'unknown_role' && reason !== 'unknown_city') return null;
  const cls = classifyBrowseSegments(segments);
  if (!cls || cls.type === 'segment') return null;
  const text = (s: string | undefined) => (s ?? '').replace(/-/g, ' ').trim().slice(0, 80);
  const parts = cls.slug.split('/');
  if (cls.type === 'role_city') {
    const role = text(parts[0]);
    const city = text(parts[1]);
    return reason === 'unknown_city' ? { kind: 'city', role, city } : { kind: 'role', role, city };
  }
  if (reason !== 'unknown_role') return null;
  // sponsorship_role slugs are `<country>/<role>`; the rest are the role alone.
  return { kind: 'role', role: text(parts[parts.length - 1]), city: null };
}

/** The id inside `/job/<id>-<slug>` (twin of the server's parseIdSlug). */
export function parseJobIdSlug(idSlug: string): string | null {
  let raw = idSlug;
  try {
    raw = decodeURIComponent(idSlug);
  } catch {
    /* keep raw */
  }
  const id = raw.split('-')[0] ?? '';
  return /^[A-Za-z0-9_]{1,64}$/.test(id) ? id : null;
}

/** `seo:<brand>:<type>:<slug>` — unstable_cache tag (twin of the server's seoCacheTag). */
export function seoCacheTag(brandId: BrandId, type: string, slug: string): string {
  return `seo:${brandId}:${type}:${slug}`;
}

const SCHEMA_EMPLOYMENT: Record<string, string> = {
  full_time: 'FULL_TIME',
  part_time: 'PART_TIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
};

const SCHEMA_PERIOD: Record<string, string> = { year: 'YEAR', month: 'MONTH', week: 'WEEK', day: 'DAY', hour: 'HOUR' };

function escapeJson(graph: unknown): string {
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}

/**
 * schema.org JobPosting for a public job page (ARCH §9.3):
 *   datePosted only when the posted date was not estimated; validThrough only
 *   from the posting's real end date; baseSalary only when the posting
 *   disclosed pay; TELECOMMUTE only for remote jobs; directApply false (the
 *   user applies on the employer's site).
 */
export function jobPostingNode(job: PublicJobDetail, brandId: BrandId): Record<string, unknown> {
  const url = brandUrl(brandId, job.canonicalPath);
  const description = [job.descriptionPlain, job.responsibilities, job.qualifications, job.benefits].filter(Boolean).join('\n\n');
  const node: Record<string, unknown> = {
    '@type': 'JobPosting',
    '@id': `${url}#job`,
    title: job.title,
    description,
    url,
    directApply: false,
    hiringOrganization: {
      '@type': 'Organization',
      name: job.company.name,
      ...(job.company.website ? { sameAs: job.company.website } : {}),
      ...(job.company.logoUrl ? { logo: job.company.logoUrl } : {}),
    },
  };
  if (job.postedAt) node.datePosted = job.postedAt;
  if (job.expiresAt) node.validThrough = job.expiresAt;
  const employment = job.employmentType ? SCHEMA_EMPLOYMENT[job.employmentType] : undefined;
  if (employment) node.employmentType = employment;
  if (job.workModel === 'remote') {
    node.jobLocationType = 'TELECOMMUTE';
    if (job.remoteScope && job.remoteScope !== 'global') node.applicantLocationRequirements = { '@type': 'Country', name: job.remoteScope };
  }
  if (job.workModel !== 'remote' && (job.city || job.country)) {
    node.jobLocation = {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        ...(job.city ? { addressLocality: job.city } : {}),
        ...(job.region ? { addressRegion: job.region } : {}),
        ...(job.country ? { addressCountry: job.country } : {}),
      },
    };
  }
  if (job.pay && SCHEMA_PERIOD[job.pay.period]) {
    node.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.pay.currency,
      value: {
        '@type': 'QuantitativeValue',
        unitText: SCHEMA_PERIOD[job.pay.period],
        ...(job.pay.min != null ? { minValue: job.pay.min } : {}),
        ...(job.pay.max != null ? { maxValue: job.pay.max } : {}),
      },
    };
  }
  return node;
}

/** schema.org BreadcrumbList for a trail of `{ name, path }`. */
export function breadcrumbNode(brandId: BrandId, trail: ReadonlyArray<{ name: string; path: string }>): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: brandUrl(brandId, t.path) })),
  };
}

/** One JSON-LD document from graph nodes (escaped for a <script> tag). */
export function jsonLdGraph(nodes: ReadonlyArray<Record<string, unknown>>): string {
  return escapeJson({ '@context': 'https://schema.org', '@graph': nodes });
}

/** Metadata for a public page that is not a marketing page: canonical on the brand origin, indexable only when told. */
export function publicPageMetadata(input: { brandId: BrandId; path: string; title: string; description: string; indexable: boolean }): Metadata {
  const brand = getBrand(input.brandId);
  const canonical = brandUrl(brand.id, input.path);
  const image = brandUrl(brand.id, brand.assets.og);
  return {
    title: input.title,
    description: input.description,
    alternates: { canonical },
    openGraph: { type: 'website', url: canonical, siteName: brand.name, title: input.title, description: input.description, images: [{ url: image, width: 1200, height: 630, alt: brand.name }] },
    twitter: { card: 'summary_large_image', title: input.title, description: input.description, images: [image] },
    robots: input.indexable ? { index: true, follow: true, 'max-image-preview': 'large' } : { index: false, follow: true },
  };
}

// ── robots.txt ────────────────────────────────────────────────────────────

/** AI crawlers: welcome on the marketing pages, kept off /job/* until bank syndication consent exists (OPS-A4). */
export const AI_CRAWLERS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'meta-externalagent',
];

/** Every authenticated route plus the API: "requires a session" and "not worth crawling" are the same set. */
export function appDisallowPaths(): string[] {
  return ['/api/', ...PROTECTED_PREFIXES];
}

/**
 * Public utility routes no crawler should fetch: each is reached only from a
 * private link (an email or an invite) and carries a one-time token or a
 * personal code in its path. Same list on both hosts.
 *   /alerts/confirm/   confirm a signed-out job alert (double opt-in token)
 *   /unsubscribe/      one-click unsubscribe (token)
 *   /r/                invite short links (a personal code; redirects to signup)
 * Free-tool results and "keep this result" have no page URL at all: they are
 * API calls under /api/ (already disallowed) and a result id never appears in
 * a link, so there is nothing more to list for them.
 */
export const UTILITY_DISALLOW_PATHS: readonly string[] = ['/alerts/confirm/', '/unsubscribe/', '/r/'];

/**
 * Host-aware robots rules (ARCH §9.5). Every group disallows the app, the API
 * and the utility routes. AI crawlers are also kept off /job/* until
 * recruiter-bank syndication consent exists (OPS-A4); a host Baidu indexes
 * (GoApply) gets a Baiduspider group.
 */
export function robotsFor(brandId: BrandId): MetadataRoute.Robots {
  const brand = getBrand(brandId);
  const closed = [...appDisallowPaths(), ...UTILITY_DISALLOW_PATHS];
  const rules: MetadataRoute.Robots['rules'] = [
    { userAgent: '*', allow: '/', disallow: closed },
    { userAgent: [...AI_CRAWLERS], allow: '/', disallow: [...closed, '/job/'] },
  ];
  if (brand.seo.searchEngines.includes('baidu')) rules.push({ userAgent: 'Baiduspider', allow: '/', disallow: closed });
  return { rules, sitemap: brandUrl(brand.id, '/sitemap.xml'), host: brand.canonicalOrigin };
}

// ── Sitemaps ──────────────────────────────────────────────────────────────

export interface SitemapEntry {
  loc: string;
  lastmod?: string | null;
  /** hreflang → absolute URL. */
  alternates?: Record<string, string>;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function urlsetXml(entries: readonly SitemapEntry[]): string {
  const hasAlt = entries.some((e) => e.alternates && Object.keys(e.alternates).length);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hasAlt ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>`,
  ];
  for (const e of entries) {
    lines.push('  <url>');
    lines.push(`    <loc>${xmlEscape(e.loc)}</loc>`);
    if (e.lastmod) lines.push(`    <lastmod>${xmlEscape(e.lastmod)}</lastmod>`);
    for (const [lang, href] of Object.entries(e.alternates ?? {})) {
      lines.push(`    <xhtml:link rel="alternate" hreflang="${xmlEscape(lang)}" href="${xmlEscape(href)}"/>`);
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  return `${lines.join('\n')}\n`;
}

export function sitemapIndexXml(sitemaps: ReadonlyArray<{ loc: string; lastmod?: string | null }>): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const s of sitemaps) {
    lines.push('  <sitemap>');
    lines.push(`    <loc>${xmlEscape(s.loc)}</loc>`);
    if (s.lastmod) lines.push(`    <lastmod>${xmlEscape(s.lastmod)}</lastmod>`);
    lines.push('  </sitemap>');
  }
  lines.push('</sitemapindex>');
  return `${lines.join('\n')}\n`;
}

/**
 * The free-tool pages a brand's static sitemap lists (WP-57, WP-78). One rule
 * for both brands (D5):
 *   /tools                 the hub;
 *   /tools/<tool>          each tool page, where the tools run (`toolsOpen`);
 *   /tools/job-alerts      signed-out job alerts, while the brand's
 *                          `jobs.alerts` capability is on (`alerts`; the page
 *                          is `noindex` when it is off, and a sitemap never
 *                          lists a URL its own page marks noindex).
 * `toolPaths` are the tool pages' own paths (components/features/tools
 * catalog), passed in so this module stays free of component imports. Pure.
 */
export function toolSitemapPaths(opts: { toolsOpen: boolean; toolPaths: readonly string[]; alerts: boolean }): string[] {
  const out = ['/tools'];
  if (opts.toolsOpen) out.push(...opts.toolPaths);
  if (opts.alerts) out.push('/tools/job-alerts');
  return out;
}

/**
 * Whether signed-out job alerts are live for a brand, from the sitemap index's
 * `surfaces`. Only an explicit `false` turns them off: the capability is on by
 * default on both brands, so a response without the field (an older API build)
 * or a failed read counts as on.
 */
export function alertsSurfaceOn(surfaces: { alerts?: boolean } | null | undefined): boolean {
  return surfaces?.alerts !== false;
}

/**
 * The static sitemap of a brand: the home cluster (each home URL with the
 * brand's hreflang set — only `brand.seoLocales` plus the cross-domain
 * alternates), the marketing subpages (with "How ranking works"), indexable
 * feature pages, the free tools (`toolPaths`, from `toolSitemapPaths`),
 * signup, and the surfaces that are live (`/browse`, `/campus`).
 */
export function staticSitemapEntries(
  brandId: BrandId,
  opts: { featurePaths: readonly string[]; surfaces: { browse: boolean; campus: boolean; alerts?: boolean }; toolPaths?: readonly string[] },
): SitemapEntry[] {
  const brand = getBrand(brandId);
  const languages = brandLanguageAlternates(brand.id);
  const homes = SEO_READY_LOCALES.filter((l) => brand.seoLocales.includes(l)).map((l) => homePath(brand, l));
  const out: SitemapEntry[] = [...new Set(homes)].map((p) => ({ loc: brandUrl(brand.id, p), alternates: languages }));
  const pages = ['/pricing', '/about', '/security', '/help', '/help/ranking', ...opts.featurePaths, ...(opts.toolPaths ?? []), '/signup'];
  // Both brands: `/browse` is listed whenever the brand's `seo.browse` surface is live.
  if (opts.surfaces.browse) pages.push('/browse');
  if (opts.surfaces.campus && brand.market === 'cn') pages.push('/campus');
  for (const p of [...new Set(pages)]) out.push({ loc: brandUrl(brand.id, p) });
  return out;
}

// ── llms.txt ──────────────────────────────────────────────────────────────

const LOCALE_NAMES: Record<RoboLocale, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  pt: 'Português',
  de: 'Deutsch',
};

/**
 * llms.txt per brand (ARCH §9.5; replaces the stale public/llms.txt). States
 * only what the product does today; never claims it applies for the user
 * (D1) and quotes no prices (they live in config and change).
 */
export function llmsTxt(brandId: BrandId, opts: { campus?: boolean } = {}): string {
  const brand = getBrand(brandId);
  const url = (p: string) => brandUrl(brand.id, p);
  const other = getBrand(brand.otherBrand);
  const langs = brand.locales.map((l) => LOCALE_NAMES[l]).join(', ');
  if (brand.market === 'cn') {
    return [
      `# ${brand.name}`,
      '',
      `> ${brand.name} (${url('/')}) is a job-search toolkit for students and job seekers in mainland China: resume writing and checks, a record of the applications you send${opts.campus ? ', interview practice, and a campus recruiting calendar built from official sources' : ' and interview practice'}. You submit every application yourself on the employer's site; ${brand.name} never applies for you.`,
      '',
      `${brand.name}（${url('/')}）是面向中国大陆学生和求职者的求职工具：简历撰写与检查、投递记录${opts.campus ? '、面试练习，以及根据官方来源整理的校招日历' : '和面试练习'}。所有申请都由你本人在招聘方网站提交，${brand.name} 不会代你投递。`,
      '',
      '## Facts',
      `- Languages: ${langs}.`,
      '- AI-written text is labelled as AI-generated.',
      `- Prices: see ${url('/pricing')} (prices change; do not quote them from memory).`,
      `- International users (including Taiwan) are served by ${other.name}: ${other.canonicalOrigin}/`,
      '',
      '## Pages',
      `- [首页 Home](${url('/')})`,
      `- [价格 Pricing](${url('/pricing')})`,
      `- [关于 About](${url('/about')})`,
      `- [安全 Security](${url('/security')})`,
      `- [帮助 Help](${url('/help')})`,
      ...(opts.campus ? [`- [校招日历 Campus calendar](${url('/campus')})`] : []),
      `- [免费工具 Free tools](${url('/tools')})`,
      '',
      '## Crawling',
      '- Public job pages (/job/...) are not open to AI crawlers; see robots.txt.',
      '',
    ].join('\n');
  }
  const homes = SEO_READY_LOCALES.filter((l) => brand.seoLocales.includes(l) && l !== brand.defaultLocale).map((l) => `${url(homePath(brand, l))} (${LOCALE_NAMES[l]})`);
  return [
    `# ${brand.name}`,
    '',
    `> ${brand.name} (${url('/')}) helps job seekers find openings that fit their resume, see what each posting asks for that the resume does not show yet, tailor the resume and write a cover letter from their own experience, practice the interview with an AI interviewer, and keep track of their applications. You apply on the employer's site yourself; ${brand.name} never submits an application for you.`,
    '',
    '## Facts',
    '- The fit score shows how a resume lines up with a posting. It is not a chance of being hired.',
    '- Resume edits and cover letters are suggestions the user reviews before using them; claims must come from the user\'s own experience.',
    '- Numbers about jobs (pay, counts) come from the postings or our job index and are shown with their source; unknown values are shown as not listed.',
    `- Languages: ${langs}.`,
    `- Prices: see ${url('/pricing')} (prices change; do not quote them from memory).`,
    `- Users in mainland China are served by ${other.name}: ${other.canonicalOrigin}/`,
    '',
    '## Pages',
    `- [Home](${url('/')}): what the product does and how it works.`,
    `- [Pricing](${url('/pricing')})`,
    `- [About](${url('/about')})`,
    `- [Security](${url('/security')}): how data is stored and which AI providers process it.`,
    `- [Help](${url('/help')})`,
    ...(homes.length ? [`- Home page in other languages: ${homes.join(', ')}.`] : []),
    '',
    '## Crawling',
    '- Public job pages (/job/...) are not open to AI crawlers; see robots.txt.',
    '',
  ].join('\n');
}
