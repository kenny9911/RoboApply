// server/src/features/jobs/normalize/types.ts
//
// Input and output shapes of the deterministic job normalizers (WP-16a,
// ARCH §4.4). `ProviderJobInput` is what a fetcher hands over: the shape the
// existing RapidAPI clients already return (`ExternalJobNormalized` in
// roboapply/v2/lib/raExternalJobTypes.ts is structurally assignable to it)
// plus optional provider extras. `NormalizedJob` is what the ingest upsert
// (WP-16b) writes to RAJob / RACompany; its field names match the columns.

import type { JobProvider, Market } from '../../../platform/brand/index.js';

/** Every job source the normalizers know. `ats_public` = WP-42's public ATS boards. */
export type NormalizeProvider = JobProvider | 'ats_public';

export type WorkModel = 'remote' | 'hybrid' | 'onsite';
export type Seniority = 'intern_newgrad' | 'entry' | 'mid' | 'senior' | 'lead_staff' | 'director_exec';
export type RoleType = 'ic' | 'manager';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship';
/** RAJob.educationLevel: the lowest education a posting asks for ('none' = it says any level is fine). */
export type EducationLevel = 'none' | 'associate' | 'bachelor' | 'master' | 'phd';
export type SalaryPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';
export type SalarySource = 'provider' | 'posting_text';
export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'workday'
  | 'ashby'
  | 'smartrecruiters'
  | 'icims'
  | 'workable'
  | 'taleo'
  | 'successfactors'
  | 'moka'
  | 'beisen'
  | 'feishu'
  | 'dayee'
  | 'other';

/** Where a derived value came from (kept for review and for WP-17's skip rule). */
export type FieldSource =
  | 'provider'
  | 'title'
  | 'description'
  | 'location_text'
  | 'posting_text'
  | 'years'
  | 'city_table'
  | 'query_country'
  | 'employment_type';

/** Company fields a provider or bank states, each with its source (D3: no fact without provenance). */
export interface CompanyFactsInput {
  /** e.g. 'provider:activejobs', 'bank', 'website'. Required: facts without a source are dropped. */
  source: string;
  url?: string | null;
  fetchedAt?: string | Date | null;
  website?: string | null;
  domain?: string | null;
  industries?: readonly string[] | null;
  /** Free text ("51-200 employees", "1001-5000") or a band. */
  size?: string | null;
  employeeCount?: number | null;
  hqLocation?: string | null;
  foundedYear?: number | null;
  description?: string | null;
}

export interface ProviderJobInput {
  /** Unique within the source board (e.g. 'activejobs:123', a recruiter Job.id). */
  externalId: string;
  /** RAJob.sourceBoard override; defaults per provider (ats_public: the ATS name). */
  sourceBoard?: string | null;
  title: string;
  company: string;
  companyLogoUrl?: string | null;
  applyUrl?: string | null;
  /** The original posting page, when it differs from the apply link. */
  sourceUrl?: string | null;
  applyIsDirect?: boolean | null;
  /** The original publisher's display name ("Greenhouse", "Indeed", "104人力銀行"). */
  sourcePublisher?: string | null;

  location?: string | null;
  /** Every location of a multi-location posting. */
  locations?: readonly (string | null | undefined)[] | null;
  locationCity?: string | null;
  locationRegion?: string | null;
  locationCountry?: string | null;
  /** True when the provider filled the country from the search, not the posting. */
  locationCountryEstimated?: boolean | null;
  /** Legacy client field: only 'remote' is trusted; anything else means unknown. */
  workType?: string | null;
  /** The provider's explicit work arrangement ('Hybrid', 'On-site', 'Remote OK', 'TELECOMMUTE' …). */
  workModel?: string | null;
  remoteScope?: string | null;

  employmentType?: string | readonly string[] | null;
  salaryMin?: number | string | null;
  salaryMax?: number | string | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  /** The pay text as the posting states it (e.g. "面議", "15-25K·14薪", "$50/hr"). */
  salaryText?: string | null;
  /** CN "N薪" when the provider states it separately. */
  salaryMonths?: number | null;
  /** True when the provider guessed the currency from the search country. */
  salaryCurrencyInferred?: boolean | null;

  /** Plain text or HTML. */
  description?: string | null;
  descriptionHtml?: string | null;

  postedAt?: string | Date | null;
  postedAtEstimated?: boolean | null;
  fetchedAt?: string | Date | null;
  /** Provider expiry (schema.org validThrough, bank close date …). */
  expiresAt?: string | Date | null;

  /** A provider level label ("Senior", "Entry level", "Mid-Senior level", "实习"). */
  seniority?: string | null;
  /** A provider experience band in years ("0-2", "2-5", "5-10", "10+"). */
  experienceLevel?: string | null;
  /** Required experience in months (JSearch). */
  experienceMonths?: number | null;
  /** Provider-extracted skills (lower-cased, de-duplicated, max 25 kept). */
  skills?: readonly string[] | null;

  /** A provider education label ("本科", "bachelor", "associate", "不限"). */
  educationLevel?: string | null;
  /** Openings the provider states for the posting (a recruiter bank's 招聘人数). */
  headcount?: number | null;

  /** The provider's own agency flag: the COMPANY named on the posting is a staffing / recruitment firm. */
  isAgency?: boolean | null;
  /**
   * The POSTING is placed by a recruiter on behalf of the named employer (a
   * recruiter-bank job whose employer the bank has not verified: 代招). Marks
   * the job as an agency posting; it says nothing about the employer, so the
   * company record is not marked as an agency.
   */
  agencyPosting?: boolean | null;
  /** Bank jobs: the bank's verified-employer field. */
  employerVerified?: boolean | null;
  /** Bank jobs: the bank recorded the employer's consent to syndicate (OPS-A4). */
  syndicationConsent?: boolean | null;

  /** A count from a named, citable source only. Ignored for 'linkedin' and 'jsearch'. */
  applicantCount?: number | null;
  applicantCountSource?: string | null;
  applicantCountAt?: string | Date | null;

  companyFacts?: CompanyFactsInput | null;
  /** Recruiter-bank Company ref ('robohire:<id>' | 'gohire:<id>'). */
  bankCompanyRef?: string | null;
}

export interface NormalizeContext {
  /**
   * The brand market the job enters; default 'cn' for bank_gohire, else 'intl'.
   * Ignored for `ats_public`: an employer-board posting's market is its own
   * resolved location (mainland China → 'cn', anything else → 'intl'), so the
   * caller compares `job.market` with its own market and skips the rest.
   */
  market?: Market;
  /** Clock for expiry and "posted in the future" checks (tests pass a fixed date). */
  now?: Date;
  /** Providers whose licence allows public redisplay (env PUBLIC_DISPLAY_PROVIDERS; default none). */
  publicDisplayProviders?: readonly string[];
  /** user_import only: the importing user. */
  ownerUserId?: string | null;
  /**
   * The country the search asked for. Used when the posting names no country
   * (an ambiguous city then resolves inside it); never overrides the text.
   */
  countryHint?: string | null;
  /**
   * Re-ingest only: the existing RAJob row's firstSeenAt. An undated posting's
   * estimated postedAt (and so its expiresAt) stays at this date instead of
   * moving to the fetch time on every run.
   */
  firstSeenAt?: string | Date | null;
}

export interface NormalizedLocation {
  /** City as shown in the market's language (intl: English; cn: Simplified Chinese). */
  city: string | null;
  /** City-table id, when the city is in the table. */
  cityId: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
}

export interface CompanyUpsert {
  market: Market;
  displayName: string;
  nameNormalized: string;
  logoUrl: string | null;
  isAgency: boolean | null;
  bankCompanyRef: string | null;
  website: string | null;
  domain: string | null;
  industries: string[];
  sizeBand: string | null;
  employeeCount: number | null;
  hqLocation: string | null;
  foundedYear: number | null;
  description: string | null;
  /** RACompany.facts: one provenance entry per field above that has a value. */
  facts: Record<string, { source: string; url?: string; fetchedAt: string }>;
}

/**
 * A normalized job. A type alias (not an interface) so it is assignable to
 * `MarketHookJob` (jobs/marketHooks.ts) for `afterNormalize`.
 */
export type NormalizedJob = {
  provider: NormalizeProvider;
  market: Market;
  visibility: 'public' | 'private';
  ownerUserId: string | null;
  externalId: string;
  sourceBoard: string;
  /** Lower wins in dedupe (activejobs 10, bank 15, linkedin 20, jsearch 30, user_import 90). */
  sourcePriority: number;

  title: string;
  titleNormalized: string;
  companyName: string;
  companyNameNormalized: string;
  companyLogoUrl: string | null;

  /** http(s) only; null when the input had none (the upsert skips such rows). */
  applyUrl: string | null;
  sourceUrl: string | null;
  /** Aggregator or bank display name (never LinkedIn). */
  sourceName: string | null;
  /** The original publisher (never LinkedIn). */
  originalSourceName: string | null;
  /**
   * Host of the original posting (never linkedin.com); prefers the employer /
   * ATS host over a job board's. Stored in `RAJob.originalHost` (SCHEMA-2) by
   * the ingest upsert and the import writer.
   */
  originalHost: string | null;
  /**
   * `[{ rule, evidence, at, method? }]` a market hook raised at normalize time
   * (`marketHooks.afterNormalize`: GoApply keyword and blacklist fraud rules).
   * The normalizer itself never sets it. The ingest upsert stores it, keeping
   * other modules' flags on the row (R41-2).
   */
  fraudFlags?: unknown;
  /**
   * `[{ tag, evidenceQuote, evidenceUrl }]` a market hook read from the posting
   * at normalize time (GoApply 届别 / 校招 / 网申截止 tags). Stored by the
   * ingest upsert next to the tags enrichment writes (R41-2).
   */
  marketTags?: unknown;
  atsType: AtsType | null;
  /** true when a provider or our agency list says so; null = not known (never false by guess). */
  isAgency: boolean | null;
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  publicDisplay: boolean;

  location: string | null;
  locationCity: string | null;
  locationRegion: string | null;
  locationCountry: string | null;
  locations: NormalizedLocation[];
  geoLat: number | null;
  geoLng: number | null;
  /** Null unless the provider or the posting states it. */
  workModel: WorkModel | null;
  remoteScope: string | null;

  employmentType: EmploymentType | null;
  /** The lowest education the posting asks for; null = not stated (never guessed). */
  educationLevel: EducationLevel | null;
  /** The posting's own words the level was read from (posting_text only; not stored on the row). */
  educationEvidence: string | null;
  /** Openings the provider states. Carried, not stored: RAJob has no column for it yet (schema request). */
  headcount: number | null;

  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  salarySource: SalarySource | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryMonths: number | null;
  salaryDisclosed: boolean;
  salaryText: string | null;

  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  seniority: Seniority | null;
  roleType: RoleType | null;
  minYears: number | null;
  maxYears: number | null;
  skills: string[];

  description: string;
  descriptionPlain: string;

  postedAt: Date | null;
  postedAtEstimated: boolean;
  expiresAt: Date | null;

  applicantCount: number | null;
  applicantCountSource: string | null;
  applicantCountAt: Date | null;

  dedupeKey: string;
  searchText: string;

  company: CompanyUpsert;
  fieldSources: Partial<Record<'workModel' | 'seniority' | 'years' | 'roleType' | 'employmentType' | 'educationLevel' | 'salary' | 'country' | 'taxonomy' | 'skills', FieldSource>>;
  /** ARCH §4.5 skip rule: enrichment may skip the LLM when `complete`. */
  coverage: { taxonomy: boolean; seniority: boolean; skills: number; complete: boolean };
  /** Values the normalizer refused, for ingest logs (e.g. 'applicant_count_dropped:linkedin'). */
  notes: string[];
};
