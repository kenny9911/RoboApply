// server/src/features/search/contract.ts
//
// Wire contract of the one preference store (ARCHITECTURE.md §2.8; PRODUCT
// F-FILT-01…07, F-FEED-03): FilterSet v1 and the search-profile shapes.
// FND-4 owns this file; WP-20 builds the routes and UI on it, WP-32 the feed
// predicates, WP-50 the Assistant's filter edits.
//
// Every FilterSet field is optional; absence means "any". Canonical field
// names are ARCH §2.8's. The task plan's shorthand names are accepted on
// input and renamed (FILTER_SET_ALIASES): industriesInclude → industries,
// industriesExclude → excludedIndustries, includeOnlyCompanies → companies,
// companySize → companySizes.
//
// Deviations from ARCH §2.8, each deliberate:
//   - `locations[].country` is optional: entries migrated from a free-text
//     city have no country, and inventing one would be fabricated data (D3).
//   - `preferredCompanies` (boost only, never a filter) carries the legacy
//     `targetCompanies`, which boosted the feed; turning it into the
//     include-only `companies` filter would silently narrow the feed.
//   - GoApply fields (CN plan; PRODUCT F-FILT-01/02 cn column): `classYear`,
//     `degree`, `employmentType`, `internDays`, `dailyPay`, `salaryMonthsMin`
//     (K·N薪, added by WP-20), `hukouTag`, `schoolTiers`. School tier is a user-side filter on postings that state
//     a requirement and never a ranking input (ruling C15).

import { z } from 'zod';

export const FILTER_SET_SCHEMA_VERSION = 1 as const;

// ── Enumerations ───────────────────────────────────────────────────────────

export const JOB_TYPES = ['full_time', 'contract', 'part_time', 'internship'] as const;
export const WORK_MODELS = ['remote', 'hybrid', 'onsite'] as const;
export const SENIORITY_LEVELS = ['intern_newgrad', 'entry', 'mid', 'senior', 'lead_staff', 'director_exec'] as const;
export const RADIUS_KM = [0, 8, 40, 80, 160] as const;
export const POSTED_WITHIN_DAYS = [1, 3, 7, 30] as const;
export const PAY_PERIODS = ['year', 'month', 'hour'] as const;
export const EXCLUDE_REQUIREMENTS = ['citizenship', 'clearance'] as const;
export const ROLE_TYPES = ['ic', 'manager'] as const;
export const FIT_TIERS = ['all', 'good', 'great'] as const;
/** Company size buckets (employees), hyphen-separated. */
export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1001-5000', '5000+'] as const;
/** GoApply: 央国企 · 事业编 · 可落户 · 外企 (shown only with an evidence quote). */
export const EMPLOYER_TAGS = ['soe', 'bianzhi', 'hukou', 'foreign'] as const;
/** GoApply 学历: 大专 · 本科 · 硕士 · 博士. */
export const CN_DEGREES = ['dazhuan', 'bachelor', 'master', 'phd'] as const;
/** GoApply 工作性质: 校招 · 社招 · 实习. */
export const CN_EMPLOYMENT_TYPES = ['campus', 'social', 'internship'] as const;
/** GoApply school tiers from the official MOE lists (985 / 211 / 双一流). */
export const SCHOOL_TIERS = ['985', '211', 'double_first_class'] as const;

/** Instant-alert frequency options (per day). 100 = "as they arrive" (Pro); never called unlimited. */
export const ALERT_INSTANT_OPTIONS = [0, 1, 2, 5, 100] as const;
export const ALERT_DIGESTS = ['daily', 'weekly'] as const;

// ── FilterSet v1 ───────────────────────────────────────────────────────────

const text = (max = 120) => z.string().trim().min(1).max(max);
const list = <T extends z.ZodType>(item: T, max = 50) => z.array(item).max(max);
const literalUnion = <T extends readonly (string | number)[]>(values: T) =>
  z.union(values.map((v) => z.literal(v)) as unknown as [z.ZodLiteral<T[number]>, z.ZodLiteral<T[number]>, ...z.ZodLiteral<T[number]>[]]);

const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case');
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217, upper case');

export const FilterLocationSchema = z
  .object({
    label: text(160),
    city: text().optional(),
    region: text().optional(),
    country: CountryCode.optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    radiusKm: literalUnion(RADIUS_KM),
  })
  .strict();

export const SalaryMinSchema = z
  .object({
    amount: z.number().positive().max(100_000_000),
    currency: CurrencyCode,
    period: z.enum(PAY_PERIODS),
  })
  .strict();

const RangeSchema = (min: number, max: number) =>
  z
    .object({ min: z.number().int().min(min).max(max).optional(), max: z.number().int().min(min).max(max).optional() })
    .strict()
    .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, { message: 'min must be ≤ max' });

export const FilterSetV1Schema = z
  .object({
    // Basic (F-FILT-01)
    taxonomyIds: list(text(80), 30).optional(),
    titles: list(text(), 30).optional(),
    excludedTitles: list(text(), 30).optional(),
    jobTypes: list(z.enum(JOB_TYPES), 4).optional(),
    workModels: list(z.enum(WORK_MODELS), 3).optional(),
    country: CountryCode.optional(),
    locations: list(FilterLocationSchema, 20).optional(),
    seniority: list(z.enum(SENIORITY_LEVELS), 6).optional(),
    yearsRange: RangeSchema(0, 50).optional(),
    postedWithinDays: literalUnion(POSTED_WITHIN_DAYS).optional(),
    // Pay and sponsorship (F-FILT-02)
    salaryMin: SalaryMinSchema.optional(),
    /** Default true: jobs without listed pay stay unless this is false ("Only jobs that list pay"). */
    includeUndisclosedPay: z.boolean().optional(),
    needsSponsorship: z.boolean().optional(),
    excludeRequirements: list(z.enum(EXCLUDE_REQUIREMENTS), 2).optional(),
    // Interests (F-FILT-03)
    industries: list(text(), 30).optional(),
    excludedIndustries: list(text(), 30).optional(),
    skills: list(text(80), 50).optional(),
    excludedSkills: list(text(80), 50).optional(),
    roleType: z.enum(ROLE_TYPES).optional(),
    // Companies (F-FILT-04)
    /** Include-only: when set, only these companies. */
    companies: list(text(160), 50).optional(),
    /** Boost only, never a filter (legacy `targetCompanies`). */
    preferredCompanies: list(text(160), 50).optional(),
    excludedCompanies: list(text(160), 200).optional(),
    companySizes: list(z.enum(COMPANY_SIZES), 6).optional(),
    excludeAgencies: z.boolean().optional(),
    /** Jobs from our recruiter bank only. Free on every plan; no entitlement (C16). */
    recruiterJobsOnly: z.boolean().optional(),
    // View (F-FILT-05): hides weaker fits, "Hiding {n} weaker fits. Show them."
    fitTier: z.enum(FIT_TIERS).optional(),
    // Free-text title/company keywords (F-FILT-06)
    q: z.string().trim().min(1).max(200).optional(),
    // GoApply only
    employerTags: list(z.enum(EMPLOYER_TAGS), 4).optional(),
    /** 届别, e.g. 2027. */
    classYear: z.number().int().min(2000).max(2100).optional(),
    /** Postings whose stated 学历 requirement is one of these. */
    degree: list(z.enum(CN_DEGREES), 4).optional(),
    employmentType: list(z.enum(CN_EMPLOYMENT_TYPES), 3).optional(),
    /** 实习天数: days a week. */
    internDays: RangeSchema(1, 7).optional(),
    /** 元/天 floor for internships. */
    dailyPay: z.object({ min: z.number().int().positive().max(100_000) }).strict().optional(),
    /** K·N薪: at least N months of pay a year, when the posting states it (12–24). WP-20 addition. */
    salaryMonthsMin: z.number().int().min(12).max(24).optional(),
    /** Only postings whose official text says 可落户. */
    hukouTag: z.boolean().optional(),
    /** The user's own school tiers: hides postings that require a tier the user lacks. */
    schoolTiers: list(z.enum(SCHOOL_TIERS), 3).optional(),
  })
  .strict();

export type FilterSet = z.infer<typeof FilterSetV1Schema>;
export type FilterField = keyof FilterSet;
export type FilterLocation = z.infer<typeof FilterLocationSchema>;
export type SalaryMin = z.infer<typeof SalaryMinSchema>;

export const FILTER_FIELDS = Object.keys(FilterSetV1Schema.shape) as FilterField[];

/** Fields that exist only on GoApply (market `cn`). */
export const CN_ONLY_FIELDS: readonly FilterField[] = [
  'employerTags',
  'classYear',
  'degree',
  'employmentType',
  'internDays',
  'dailyPay',
  'salaryMonthsMin',
  'hukouTag',
  'schoolTiers',
];
/** Fields that exist only on RoboApply (market `intl`); GoApply replaces sponsorship with 户口/届别. */
export const INTL_ONLY_FIELDS: readonly FilterField[] = ['needsSponsorship', 'excludeRequirements'];

/** Task-plan shorthand → canonical ARCH name. */
export const FILTER_SET_ALIASES: Readonly<Record<string, FilterField>> = {
  industriesInclude: 'industries',
  industriesExclude: 'excludedIndustries',
  includeOnlyCompanies: 'companies',
  companySize: 'companySizes',
};

/** A partial update: a value replaces the field, `null` clears it, absent leaves it. */
export type FilterSetPatch = { [K in FilterField]?: FilterSet[K] | null };

export const FilterSetPatchSchema = z
  .object(
    Object.fromEntries(Object.entries(FilterSetV1Schema.shape).map(([k, schema]) => [k, (schema as z.ZodOptional<z.ZodType>).unwrap().nullable().optional()])) as {
      [K in FilterField]: z.ZodOptional<z.ZodNullable<z.ZodType<NonNullable<FilterSet[K]>>>>;
    },
  )
  .strict();

// ── Search profiles (RASearchProfile) ─────────────────────────────────────

const ProfileName = z.string().trim().max(60);
const Version = z.number().int().min(1);

export const AlertInstantSchema = literalUnion(ALERT_INSTANT_OPTIONS);

export const CreateSearchProfileBodySchema = z
  .object({
    /** '' = unnamed: the UI shows its localized default label. */
    name: ProfileName,
    filters: z.unknown(),
    isDefault: z.boolean().optional(),
    activate: z.boolean().optional(),
    alertInstantMax: AlertInstantSchema.optional(),
    alertDigest: z.enum(ALERT_DIGESTS).nullable().optional(),
  })
  .strict();

/**
 * PATCH /search-profiles/:id (ARCH §3.3). `baseVersion` is the version the
 * client read; a mismatch answers 409 version_conflict with the current
 * profile. `version` is accepted as an alias (FND-4's original name).
 * `filters` replaces the whole set; `filtersPatch` (FilterSetPatch: a value
 * replaces a field, `null` clears it) is what the Assistant, "Not interested"
 * and the chips send. They are mutually exclusive. `makeDefault: true` makes
 * this the default profile (there is no way to un-default: pick another).
 */
export const UpdateSearchProfileBodySchema = z
  .object({
    baseVersion: Version.optional(),
    version: Version.optional(),
    name: ProfileName.optional(),
    filters: z.unknown().optional(),
    filtersPatch: z.unknown().optional(),
    alertInstantMax: AlertInstantSchema.optional(),
    alertDigest: z.enum(ALERT_DIGESTS).nullable().optional(),
    makeDefault: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => b.baseVersion !== undefined || b.version !== undefined, { message: 'baseVersion is required', path: ['baseVersion'] })
  .refine((b) => b.filters === undefined || b.filtersPatch === undefined, { message: 'send filters or filtersPatch, not both', path: ['filtersPatch'] });

/** @deprecated Use `UpdateSearchProfileBodySchema` with `filtersPatch` (one PATCH). */
export const PatchSearchProfileFiltersBodySchema = z
  .object({
    version: Version,
    patch: z.unknown(),
  })
  .strict();

export type CreateSearchProfileBody = z.infer<typeof CreateSearchProfileBodySchema>;
export type UpdateSearchProfileBody = z.infer<typeof UpdateSearchProfileBodySchema>;

/** The version a PATCH body carries (`baseVersion`, else the `version` alias). */
export function baseVersionOf(body: { baseVersion?: number; version?: number }): number {
  return (body.baseVersion ?? body.version) as number;
}

/** Response shape for one profile. */
export interface SearchProfileWire {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  schemaVersion: number;
  filters: FilterSet;
  alertInstantMax: number;
  alertDigest: 'daily' | 'weekly' | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchProfileListWire {
  profiles: SearchProfileWire[];
  /** From entitlements: Free 1, Pro 10. */
  maxProfiles: number;
  /** Highest instant-alert option the plan allows. */
  maxInstantAlerts: number;
  /** The Pro column's saved-search cap, for the inline Pro note; null when no Pro plan is sellable or the user is Pro. */
  proMaxProfiles: number | null;
  /** A sellable Pro plan exists and the user is not on it. */
  upgradable: boolean;
}

// ── Route params, queries and responses (WP-20) ─────────────────────────

export const SearchProfileParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** POST /search-profiles/count → `FeedCountResult` (count capped at 5,000; `{count:null}` until the feed counts). */
export const CountFiltersBodySchema = z.object({ filters: z.unknown() }).strict();

/** GET /taxonomy?locale&q */
export const TaxonomyQuerySchema = z.object({ locale: z.string().max(8).optional(), q: z.string().trim().max(80).optional() });

/** GET /taxonomy/skills?q= (≥2 characters, 1 for Chinese; market-scoped; the client offers the typed text as a custom entry). */
export const SkillsQuerySchema = z.object({ q: z.string().trim().min(1).max(60), locale: z.string().max(8).optional() });

/** One taxonomy node with its label in the requested locale. */
export interface TaxonomyNodeWire {
  id: string;
  level: 1 | 2 | 3;
  parent: string | null;
  label: string;
}

/** A role suggestion for the title typeahead. */
export interface TaxonomySuggestionWire {
  id: string;
  level: 1 | 2 | 3;
  label: string;
  /** "Role group · Category" for roles, the category for groups, null for categories. */
  context: string | null;
}

/** GET /taxonomy: the tree (no `q`), or ranked suggestions (with `q`). */
export interface TaxonomyResponse {
  version: number;
  asOf: string;
  locale: string;
  /** Every node (no `q`); empty when `q` is sent. */
  nodes: TaxonomyNodeWire[];
  /** Ranked suggestions (with `q`); empty without. */
  suggestions: TaxonomySuggestionWire[];
  /** Public sources the taxonomy is built from (D3). */
  sources: Array<{ name: string; url: string | null; license: string }>;
}

/** One skill suggestion. `postings` = seen in job posts of this market; `common_name` = a well-known alias was expanded. */
export interface SkillSuggestionWire {
  value: string;
  label: string;
  source: 'postings' | 'common_name';
}

export interface SkillSuggestionsResponse {
  items: SkillSuggestionWire[];
}

/** One zero-results relaxation (mirrors feed's LimitingFilter). */
export interface LimitingFilterWire {
  field: string;
  value: unknown;
  /** Jobs the feed would show without this filter. */
  removalGain: number;
}

/** GET /search-profiles/:id/limiting. `available: false` until the feed can measure (WP-32). */
export interface LimitingFiltersResponse {
  items: LimitingFilterWire[];
  available: boolean;
}

/**
 * Error answers of the search routes (WP-20). Each uses a platform code
 * (`platform/http.ts`) with `details.reason` naming the search case:
 *   404 not_found          { reason: 'search_profile_not_found' }
 *   409 version_conflict   { currentVersion, profile }
 *   403 forbidden          { reason: 'saved_search_limit', max, upgradable }
 *   403 forbidden          { reason: 'alert_frequency_not_allowed', max }
 *   422 invalid_request    { reason: 'invalid_filters', issues }
 *   409 conflict           { reason: 'cannot_delete_last_profile' | 'cannot_delete_default_profile' }
 */
export const SEARCH_ERROR_CODES = {
  notFound: 'search_profile_not_found', // 404
  versionConflict: 'version_conflict', // 409 { currentVersion, profile }
  limit: 'saved_search_limit', // 403 { max, upgradable }
  alertFrequency: 'alert_frequency_not_allowed', // 403 { max }
  invalidFilters: 'invalid_filters', // 422 { issues }
  lastProfile: 'cannot_delete_last_profile', // 409
  defaultProfile: 'cannot_delete_default_profile', // 409
} as const;
