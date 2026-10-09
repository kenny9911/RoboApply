// server/src/features/jobs/companies/contract.ts
//
// Company profiles, typeahead, H-1B history, company jobs (ARCHITECTURE.md
// §2.4, §3.4; TASK_PLAN.md WP-16b). Mount: /api/v1/roboapply/companies.
// Also documents the RAJob / RACompany / RAIngestQuery / RAH1bEmployerStat
// JSON columns (ra-jobs.prisma), which INGEST (WP-16a/16b) writes.
//
// D3: every company fact is `Sourced` (per-field provenance in
// `RACompany.facts`); no funding block unless `companyFunding` (licensed
// provider); H-1B numbers cite the DOL LCA source file. Market-scoped:
// a company of the other market answers 404.

import { z } from 'zod';

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
  /** Live canonical public jobs at this company in the brand's market. */
  openJobs: number;
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

// ── Documented JSON columns (ra-jobs.prisma) ─────────────────────────────

/** `RACompany.facts`: `{ [field]: { source, url?, fetchedAt } }` — no field is shown without an entry. */
export const CompanyFactsSchema = z.record(
  z.string(),
  z.object({ source: z.string(), url: z.string().optional(), fetchedAt: z.string() }).passthrough(),
);

/** `RAJob.skillsDetail`: `[{ skill, kind, required }]` */
export const JobSkillsDetailSchema = z.array(z.object({ skill: z.string(), kind: z.enum(['hard', 'soft']), required: z.boolean() }).strict());

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
