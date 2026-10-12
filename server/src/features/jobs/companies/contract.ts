// server/src/features/jobs/companies/contract.ts
//
// Company profiles, typeahead, H-1B history, company jobs (ARCHITECTURE.md
// §2.4, §3.4; TASK_PLAN.md WP-16b). Mount: /api/v1/roboapply/companies.
// Also documents the RAJob / RACompany / RAIngestQuery / RAH1bEmployerStat
// JSON columns (ra-jobs.prisma), which INGEST (WP-16a/16b) writes.
//
// D3: every company fact is `Sourced` (per-field provenance in
// `RACompany.facts`); no funding block unless `companyFunding` (licensed
// provider); H-1B numbers cite the DOL LCA source file; a sponsorship fact
// names its publication, file and date and is never a statement about a job.
// Market-scoped: a company of the other market answers 404.

import { z } from 'zod';
import type { Sourced } from '../../../platform/http.js';
import type { FeedItem } from '../../feed/contract.js';

/**
 * The one industry vocabulary of `RACompany.industries` (SM-10): the closed
 * list the industries filter uses, and the exact-label mapping onto it. Other
 * areas (enrichment) read it from here.
 */
export { INDUSTRY_IDS, industryIdFor, mapIndustries } from './industryMap.js';

/**
 * GET /companies/:id/sponsorship (RoboApply, flag `h1bHistory`): the company's
 * sponsorship facts, each with its year, source and date (JI-11). The types
 * live in sponsorship/contract.ts and are part of this contract, so the web
 * reads them through the same mirror.
 */
export * from './sponsorship/contract.js';

/** GET /companies?q= — trigram typeahead on the normalized name (≥2 chars), market-scoped, with logo. */
export const CompanyTypeaheadQuerySchema = z.object({ q: z.string().trim().min(2).max(80), limit: z.coerce.number().int().min(1).max(20).optional() });
export interface CompanyTypeaheadItem {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  domain: string | null;
}
export interface CompanyTypeaheadResponse {
  items: CompanyTypeaheadItem[];
}

export const CompanyIdOrSlugParamsSchema = z.object({ idOrSlug: z.string().min(1).max(120) });
export const CompanyIdParamsSchema = z.object({ id: z.string().min(1).max(64) });

export interface SourcedFact<T> {
  value: T;
  source: 'provider:linkedin' | 'provider:activejobs' | 'provider:jsearch' | 'bank' | 'website' | 'user' | (string & {});
  asOf: string;
  url?: string;
}

/** GET /companies/:idOrSlug */
export interface CompanyProfile {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  domain: string | null;
  /** Only fields with provenance; unknown fields are absent ("Not listed"). */
  facts: Partial<{
    industry: SourcedFact<string>;
    size: SourcedFact<string>;
    headquarters: SourcedFact<string>;
    founded: SourcedFact<number>;
    description: SourcedFact<string>;
    website: SourcedFact<string>;
  }>;
  /**
   * Live canonical public jobs at this company in the brand's market — our
   * own count (source 'index', method 'computed'), rendered "{n} open jobs at
   * {company} in %BRAND%" through SourceNote (D3).
   */
  openJobs: Sourced<number>;
}

/** GET /companies/:id/h1b (RoboApply, flag `h1bHistory`; US DOL LCA). */
export interface H1bHistoryResponse {
  years: Array<{
    fiscalYear: number;
    certifiedCount: number;
    medianWage: { value: number; source: 'dol_lca'; asOf: string; url?: string; sourceFile: string } | null;
  }>;
  disclaimer: string;
}

/** GET /companies/:id/jobs */
export const CompanyJobsQuerySchema = z.object({ cursor: z.string().max(512).optional() });
/**
 * Live canonical public jobs at the company (newest first, 20 a page), as
 * feed cards without fit or derived badges. `cursor` is opaque; null = last page.
 * Not listed (and not in the profile's open-job count): a recruiter-bank job
 * whose bank has no candidate-facing posting page, and a job that owes a
 * credit line (the Taiwan open-data sources) while the surface reading this
 * list cannot print it. When such rows are listed, each carries its line as
 * `cardMeta.tw_sources.attribution { text, url }`, like a feed card.
 */
export interface CompanyJobsResponse {
  items: FeedItem[];
  cursor: string | null;
}

// ── Documented JSON columns (ra-jobs.prisma) ─────────────────────────────

/** `RACompany.facts`: `{ [field]: { source, url?, fetchedAt } }` — no field is shown without an entry. */
export const CompanyFactsSchema = z.record(
  z.string(),
  z.object({ source: z.string(), url: z.string().optional(), fetchedAt: z.string() }).passthrough(),
);

/**
 * `RAJob.skillsDetail`. Enrichment v3 (MKT-4D) writes ONE entry per skill:
 * `[{ skill, kind: 'hard' | 'soft' | 'certification', required, skillId, via, also? }]`
 * (`skillId` null when the vocabulary holds no skill for the string; `via:
 * 'embedding'` is a machine guess; `also` names the other spellings of the
 * skill that `RAJob.skills` keeps). A row enriched before version 3 carries
 * `[{ skill, kind: 'hard' | 'soft', required }]`. Both shapes parse; the type
 * the writer uses is `SkillDetail` (jobs/enrich/reconcile.ts).
 */
export const JobSkillsDetailSchema = z.array(
  z
    .object({
      skill: z.string(),
      kind: z.enum(['hard', 'soft', 'certification']),
      required: z.boolean(),
      skillId: z.string().nullable().optional(),
      via: z.enum(['alias', 'embedding', 'new', 'none']).optional(),
      also: z.array(z.string()).optional(),
    })
    .strict(),
);

/** `RAJob.locations`: `[{ city, region, country, lat, lng }]` */
export const JobLocationsSchema = z.array(
  z
    .object({
      city: z.string().nullable().optional(),
      region: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      lat: z.number().nullable().optional(),
      lng: z.number().nullable().optional(),
    })
    .strict(),
);

/** `RAJob.fraudFlags`: `[{ rule, evidence, at }]` — flagged jobs are excluded from ranking until reviewed. */
export const JobFraudFlagsSchema = z.array(z.object({ rule: z.string(), evidence: z.string(), at: z.string() }).strict());

/** `RAJob.marketTags`: `[{ tag, evidenceQuote, evidenceUrl }]` — every tag cites its source. */
export const JobMarketTagsSchema = z.array(
  z.object({ tag: z.string(), evidenceQuote: z.string().min(1), evidenceUrl: z.string().nullable().optional() }).strict(),
);

/** `RAJob.seedTags` (seed-only metadata). */
export const JobSeedTagsSchema = z.object({ companyTier: z.string().optional(), role: z.string().optional() }).passthrough();

/** `RAIngestQuery.params`: `{ q, taxonomyId?, country, city?, remote?, datePosted, cursor? }` */
export const IngestQueryParamsSchema = z
  .object({
    q: z.string(),
    taxonomyId: z.string().optional(),
    country: z.string(),
    city: z.string().optional(),
    remote: z.boolean().optional(),
    datePosted: z.string(),
    cursor: z.string().optional(),
  })
  .strict();

/** `RAH1bEmployerStat.topTitles`: `[{ title, count, medianWageAnnualUsd }]` */
export const H1bTopTitlesSchema = z.array(
  z.object({ title: z.string(), count: z.number().int(), medianWageAnnualUsd: z.number().int().nullable() }).strict(),
);

export const COMPANY_ERROR_CODES = {
  notFound: 'company_not_found',
} as const;
