// server/src/features/seo/contract.ts
//
// Programmatic browse pages, public job pages, sitemaps, the job ticker
// (ARCHITECTURE.md §9; TASK_PLAN.md WP-56). Mount: /api/v1/public/seo
// (public). Every response carries a `Cache-Control` header: successful
// reads `public, s-maxage=900, stale-while-revalidate=86400` (sitemaps
// s-maxage 3600), so Vercel's CDN (keyed on host + path + query) serves
// repeat requests and the two brands never share an entry.
//
//   GET /page?path=<browse path>[&country=XX]  → SeoPageResponse     (flag `seo.browse`)
//   GET /hub                                   → SeoHubResponse      (flag `seo.browse`)
//   GET /jobs/:id                              → { job: PublicJobDetail } | 404 | 410 gone (closed)
//   GET /ticker                                → TickerResponse
//   GET /sitemap                               → SitemapIndexResponse
//   GET /sitemap/:part                         → SitemapPartResponse  (`roles-<n>` | `jobs-<n>`)
//
// D3 (tested in seo.test.ts / routes.test.ts):
//   - every list, count and aggregate reads only jobs we may show publicly:
//     market = brand.market, visibility 'public', isCanonical, not archived,
//     not closed, not expired, no fraud flags, `publicDisplay` set by ingest
//     AND the provider still listed in PUBLIC_DISPLAY_PROVIDERS (bank jobs:
//     syndication consent recorded by the bank) — a user's import never counts;
//   - indexability floors on real inventory: role ≥ 20 live jobs, role × city
//     ≥ 5, sponsorship ≥ 5 quote-backed (see INDEX_FLOORS); below the floor
//     the page is `noindex` and stays out of the sitemap;
//   - the median listed pay is published only with sampleSize ≥ MIN_SAMPLE
//     (20) rows in one currency and period, and always with N;
//   - intros are templates filled from `stats` only (never extra facts); the
//     stored English intro is checked number by number against `stats`;
//   - a closed job answers 410; `datePosted` is omitted when the posted date
//     was estimated; pay only when the posting disclosed it;
//   - every job card and job page carries the date we last found the posting
//     at its source; a GoApply job page also carries GoHire's licence for a
//     GoHire bank posting when it is configured (MARKET_STRATEGY 1.4);
//   - visa-sponsorship pages are RoboApply's: GoApply has none (`pageTypeOpen`).

import { z } from 'zod';

import type { Sourced } from '../../platform/http.js';

/** Page types (`RASeoPage.type`). */
export const SEO_PAGE_TYPES = ['role', 'role_city', 'remote_role', 'sponsorship_role', 'segment', 'graduate_role'] as const;
export type SeoPageType = (typeof SEO_PAGE_TYPES)[number];

/** Segment hubs (`/browse/<segment>`). */
export const SEO_SEGMENTS = ['entry-level', 'internships'] as const;
export type SeoSegment = (typeof SEO_SEGMENTS)[number];

export const SEO_CACHE_CONTROL = 'public, s-maxage=900, stale-while-revalidate=86400';
export const SEO_SITEMAP_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400';
/** A 404 / 410 is cacheable too, briefly (a job may open later; a closed one stays closed). */
export const SEO_MISSING_CACHE_CONTROL = 'public, s-maxage=300';
export const SEO_GONE_CACHE_CONTROL = 'public, s-maxage=3600';
/** Errors that must not be kept (rate limit, validation, server error). */
export const SEO_NO_STORE = 'no-store';

/** Sitemap partitions hold at most 45k URLs. */
export const SITEMAP_PARTITION_MAX = 45_000;

/** Indexability floors: live, publicly displayable jobs a page needs to be indexed. */
export const INDEX_FLOORS: Readonly<Record<SeoPageType, number>> = {
  role: 20,
  role_city: 5,
  remote_role: 5,
  sponsorship_role: 5,
  segment: 20,
  graduate_role: 5,
};

/** Jobs listed on a browse page (the VisitorFeed below it carries the rest). */
export const SEO_PAGE_JOB_LIMIT = 20;
/** Child links (cities, variants) per browse page. */
export const SEO_PAGE_CHILD_LIMIT = 12;
/** Items in the job ticker. */
export const TICKER_LIMIT = 10;
/** Pages listed on the /browse hub. */
export const SEO_HUB_LIMIT = 120;
/** Per-IP guard on cache misses (CDN hits never reach the API). Requested as RATE_LIMITS `seoPublicPerIp`. */
export const SEO_PUBLIC_RATE = { limit: 120, windowSec: 60 } as const;

/** How sponsorship pages select jobs (stated on the page). */
export const SPONSORSHIP_METHOD = 'posting_quote';

// ── Inputs ────────────────────────────────────────────────────────────────

/** One browse path segment: letters (any script), digits and `-`. */
const SEGMENT = /^[\p{L}\p{N}-]{1,80}$/u;

export const SeoPageQuerySchema = z.object({
  /** The path after `/browse/`, e.g. `backend-engineer/taipei`. */
  path: z
    .string()
    .min(1)
    .max(200)
    .refine((p) => p.split('/').every((s) => SEGMENT.test(s)) && p.split('/').length <= 3, 'invalid browse path'),
  /** ISO-3166 alpha-2 filter (`?country=US`). */
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
  /** Brand echo the web adds to separate CDN entries on shared preview hosts; ignored when it matches. */
  brand: z.string().max(20).optional(),
});
export type SeoPageQuery = z.infer<typeof SeoPageQuerySchema>;

export const SeoJobParamsSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
export const SitemapPartParamsSchema = z.object({ part: z.string().regex(/^[a-z_]{1,40}-\d{1,4}$/) });
export const SeoBrandQuerySchema = z.object({ brand: z.string().max(20).optional() });

// ── Stored JSON columns (RASeoPage) ─────────────────────────────────────

/** `RASeoPage.params` (documented JSON column). */
export const SeoPageParamsSchema = z
  .object({
    taxonomyId: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    companyId: z.string().optional(),
    segment: z.string().optional(),
  })
  .strict();
export type SeoPageParams = z.infer<typeof SeoPageParamsSchema>;

/** `RASeoPage.stats` (documented JSON column; `payListed` added by WP-56). */
export const SeoPageStatsSchema = z
  .object({
    jobCount: z.number().int(),
    newLast7d: z.number().int(),
    payListed: z.number().int().optional(),
    medianSalary: z
      .object({ value: z.number(), currency: z.string(), period: z.string(), sampleSize: z.number().int().min(20) })
      .strict()
      .optional(),
    topCompanies: z.array(z.object({ name: z.string(), slug: z.string().optional(), count: z.number().int() }).passthrough()),
    asOf: z.string(),
  })
  .strict();
export type SeoPageStats = z.infer<typeof SeoPageStatsSchema>;

// ── Wire types ──────────────────────────────────────────────────────────

export interface PublicPay {
  min: number | null;
  max: number | null;
  currency: string;
  /** 'year' | 'month' | 'week' | 'day' | 'hour' — as the posting stated it. */
  period: string;
}

export interface PublicJobCard {
  id: string;
  /** `<id>-<slug>` (R-05). */
  idSlug: string;
  /** `/job/<idSlug>`. */
  path: string;
  title: string;
  companyName: string;
  location: string | null;
  /** ISO country, or null. */
  country: string | null;
  /** 'remote' | 'hybrid' | 'onsite' | null (not stated). */
  workModel: string | null;
  employmentType: string | null;
  /** Only when the posting disclosed pay. */
  pay: PublicPay | null;
  /** The posted date; null when it was estimated (or unknown). */
  postedAt: string | null;
  /** When we first saw the posting. */
  firstSeenAt: string;
  /** When we last found the posting at its source (`RAJob.lastSeenAt`); null when unknown. */
  lastVerifiedAt: string | null;
  /** Where we got the posting (display name), or null. */
  sourceName: string | null;
  /** The original publisher when it differs. */
  originalSourceName: string | null;
  /** Sponsorship pages: the sentence from the posting (≤ 240 chars). */
  sponsorshipQuote: string | null;
}

export interface PublicJobDetail extends PublicJobCard {
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  applyUrl: string;
  sourceUrl: string | null;
  /** The posting's real end date, or null (never invented). */
  expiresAt: string | null;
  seniority: string | null;
  remoteScope: string | null;
  region: string | null;
  city: string | null;
  /** The posting stated pay as text only (e.g. "Negotiable"). */
  salaryText: string | null;
  company: { name: string; website: string | null; logoUrl: string | null };
  /** Canonical path; differs from the request when the slug was wrong (the page 301s). */
  canonicalPath: string;
  /**
   * GoApply, GoHire bank postings only: GoHire's HR-service licence, when both
   * CN_HR_LICENCE_HOLDER and CN_HR_LICENCE_NUMBER are set. Null everywhere
   * else (never a made-up licence).
   */
  licence: { holder: string; number: string } | null;
}

export interface PublicJobResponse {
  job: PublicJobDetail;
}

export interface SeoRoleRef {
  id: string;
  /** `backend-engineer`. */
  slug: string;
  label: string;
  labelZh: string;
}

export interface SeoCityRef {
  id: string;
  slug: string;
  name: string;
  zh: string | null;
  zhHant: string | null;
  country: string;
}

export interface SeoStatsView {
  jobCount: Sourced<number>;
  newLast7d: Sourced<number>;
  /** Jobs on this list whose posting lists pay. */
  payListed: Sourced<number>;
  /** Median listed annual pay; null below MIN_SAMPLE rows in one currency. */
  medianPay: Sourced<{ value: number; currency: string; period: 'year' }> | null;
  /** Companies with the most jobs on this list; each count is an index count (D3). */
  topCompanies: Array<{ name: string; count: Sourced<number> }>;
  asOf: string;
}

export interface SeoLink {
  kind: 'role' | 'city' | 'remote' | 'graduate' | 'segment' | 'sponsorship' | 'hub';
  path: string;
  role?: SeoRoleRef;
  city?: SeoCityRef;
  segment?: SeoSegment;
  country?: string;
  /** Live public jobs on the linked list (index count with `asOf`), or null when not counted. */
  jobCount: Sourced<number> | null;
}

export interface SeoIntro {
  /** Template id under `seo.browse.intro.*`. */
  template: string;
  /** Every number is a field of `stats` (checked). */
  params: Record<string, string | number>;
}

export interface SeoPageResponse {
  type: SeoPageType;
  slug: string;
  /** Canonical path, e.g. `/browse/backend-engineer/taipei`. */
  path: string;
  /** True when the requested path was not canonical (the page 301s to `path`). */
  redirect: boolean;
  indexable: boolean;
  floor: number;
  /** `?country=` filter (the canonical page has none; filtered views are noindex). */
  country: string | null;
  role: SeoRoleRef | null;
  city: SeoCityRef | null;
  sponsorCountry: string | null;
  segment: SeoSegment | null;
  /** How the list is selected (sponsorship pages). */
  method: string | null;
  stats: SeoStatsView;
  intro: SeoIntro;
  jobs: PublicJobCard[];
  up: SeoLink;
  children: SeoLink[];
}

export interface SeoHubResponse {
  pages: SeoLink[];
  asOf: string;
}

export interface TickerItem {
  id: string;
  idSlug: string;
  path: string;
  title: string;
  companyName: string;
  location: string | null;
  firstSeenAt: string;
  /** Null when the posted date was estimated. */
  postedAt: string | null;
}

export interface TickerResponse {
  items: TickerItem[];
  asOf: string;
}

export interface SitemapIndexResponse {
  parts: Array<{ name: string; count: number; lastmod: string | null }>;
  /**
   * Public surfaces the static sitemap may list: `/browse` (`seo.browse`),
   * `/campus` (`jobs.campusCalendar`) and `/tools/job-alerts` (`jobs.alerts`).
   * A reader treats a missing `alerts` as on (the capability's default).
   */
  surfaces: { browse: boolean; campus: boolean; alerts: boolean };
}

export interface SitemapPartResponse {
  urls: Array<{ path: string; lastmod: string | null }>;
}

/** Error codes this router answers besides the platform's. */
export type SeoErrorCode = 'gone' | 'not_found' | 'feature_disabled';
