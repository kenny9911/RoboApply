// server/src/features/seo/contract.ts
//
// Programmatic pages, public job pages, sitemaps (ARCHITECTURE.md §9;
// TASK_PLAN.md WP-56). Mount: /api/v1/public/seo (public; responses carry
// `Cache-Control: public, s-maxage=900, stale-while-revalidate=86400`,
// sitemaps s-maxage 3600).
//
// D3: only `publicDisplay` canonical jobs; indexability floors (role ≥20 live
// jobs, role×city ≥5, sponsorship ≥5 quote-backed); medians only when
// sampleSize ≥ MIN_SAMPLE (20); template intros never state a number the
// stats do not hold. A closed job page answers 410.

import { z } from 'zod';

export const SEO_PAGE_TYPES = ['role', 'role_city', 'city', 'company', 'sponsorship', 'remote', 'category'] as const;
export type SeoPageType = (typeof SEO_PAGE_TYPES)[number];
export const SEO_CACHE_CONTROL = 'public, s-maxage=900, stale-while-revalidate=86400';
export const SEO_SITEMAP_CACHE_CONTROL = 'public, s-maxage=3600';
/** Sitemap partitions hold at most 45k URLs. */
export const SITEMAP_PARTITION_MAX = 45_000;

export const SeoPageQuerySchema = z.object({
  type: z.enum(SEO_PAGE_TYPES),
  slug: z.string().regex(/^[a-z0-9-]{1,160}(\/[a-z0-9-]{1,160})?$/),
  locale: z.string().max(8).optional(),
});
export const SeoJobParamsSchema = z.object({ id: z.string().min(1).max(64) });
export const SitemapPartParamsSchema = z.object({ part: z.string().regex(/^[a-z_]{1,40}-\d{1,4}$/) });

/** `RASeoPage.params` (documented JSON column): `{ taxonomyId?, city?, country?, companyId?, segment? }` */
export const SeoPageParamsSchema = z
  .object({
    taxonomyId: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    companyId: z.string().optional(),
    segment: z.string().optional(),
  })
  .strict();

/** `RASeoPage.stats` (documented JSON column). */
export const SeoPageStatsSchema = z
  .object({
    jobCount: z.number().int(),
    newLast7d: z.number().int(),
    medianSalary: z
      .object({ value: z.number(), currency: z.string(), period: z.string(), sampleSize: z.number().int().min(20) })
      .strict()
      .optional(),
    topCompanies: z.array(z.object({ name: z.string(), slug: z.string().optional(), count: z.number().int() }).passthrough()),
    asOf: z.string(),
  })
  .strict();

export interface PublicJobCard {
  id: string;
  /** `<cuid>-<slug>` (R-05). */
  idSlug: string;
  title: string;
  companyName: string;
  location: string | null;
  workModel: string | null;
  pay: { min: number | null; max: number | null; currency: string; period: string } | null;
  postedAt: string | null;
  source: string;
}

export interface SeoPageResponse {
  type: SeoPageType;
  slug: string;
  locale: string;
  title: string;
  intro: string;
  indexable: boolean;
  stats: z.infer<typeof SeoPageStatsSchema>;
  jobs: PublicJobCard[];
}

export interface SitemapPartResponse {
  urls: Array<{ loc: string; lastmod: string | null; alternates?: Array<{ hreflang: string; href: string }> }>;
}
