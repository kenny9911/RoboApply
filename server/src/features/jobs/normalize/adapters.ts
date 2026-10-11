// server/src/features/jobs/normalize/adapters.ts
//
// Raw provider payloads → ProviderJobInput. WP-16b's fetchers may hand the
// existing clients' `ExternalJobNormalized` rows straight to
// normalizeProviderJob (that shape is already a ProviderJobInput); these
// adapters exist for when ingest keeps the raw payload, so provider fields
// the clients drop today reach the normalizer: Active Jobs DB's experience
// band, key skills and work arrangement (ARCH §4.2: map them first and let
// enrichment skip the LLM), expiry dates, and JSearch's required experience.
//
// Structural input types only: nothing is imported from roboapply/v2 but the
// pure contract file (types and the vendor's documented taxonomy labels).
// Never mapped (H9, D3; MARKET_STRATEGY §1.6): LinkedIn organization fields
// (`linkedin_org_*`, renamed `org_linkedin_*` in the vendor's v1 API: name,
// industry, size, headcount, website, logo permalink, the agency flag derived
// from the LinkedIn profile), Crunchbase fields (`org_crunchbase_*`: no note
// confirms a right to show them), recruiter and hiring-manager names and
// e-mail addresses, and any applicant / view counts.
//
// The licensed feed (MKT-5A, JI-7; MARKET_STRATEGY §1.5 "Provider fields
// first"): `inputFromFantasticJob` maps the feed's own fields before any model
// is asked: experience level, work arrangement, employment type, key skills,
// pay, the employer's derived domain, the stated validity date, the vendor's
// taxonomy label (as a category of our tree, see FANTASTIC_TAXONOMY_CATEGORY)
// and the visa-sponsorship flag as the provider's reading. Field names are the
// v1 API's (OpenAPI document data.fantastic.jobs/openapi, schema ActiveAtsJob,
// read 2026-10-12); the names older responses used stay readable.

import { FANTASTIC_TAXONOMY_LABELS, type ExternalJobNormalized, type FantasticTaxonomyLabel } from '../../../roboapply/v2/lib/raExternalJobTypes.js';
import { pickEmployerLink } from './ats.js';
import { cleanOrNull, safeUrl } from './text.js';
import type { CompanyFactsInput, ProviderJobInput } from './types.js';

/** The existing RapidAPI clients' rows are already valid input (compile-time proof, identity at run time). */
export function inputFromExternalJob(row: ExternalJobNormalized): ProviderJobInput {
  return row;
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const firstStr = (v: unknown): string | null => (Array.isArray(v) ? (v.map(str).find((x) => x) ?? null) : str(v));
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : []);
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);

// ── Fantastic Jobs (Active Jobs DB, LinkedIn Job Search API) ───────────────

/**
 * The vendor's taxonomy labels (`ai_taxonomies_a`) → a category (level 1) of
 * our role tree, or null. The keys are EXACTLY the 33 values the vendor
 * documents (`FANTASTIC_TAXONOMY_LABELS`: the enum of the `ai_taxonomies_a`
 * parameter in the OpenAPI document, read 2026-10-12; the type makes a
 * missing or an extra key a compile error): no label is typed from memory. A
 * label maps to a category only where our category names the same field and
 * no other category could claim it; everything broader or ambiguous is null
 * (never a guess: "Technology" spans five of our categories). The vendor's
 * labels are fields of work, not roles, so none maps to a role (level 3).
 */
export const FANTASTIC_TAXONOMY_CATEGORY: Readonly<Record<FantasticTaxonomyLabel, string | null>> = {
  Technology: null,
  Healthcare: 'healthcare',
  'Management & Leadership': null,
  'Finance & Accounting': 'finance',
  'Human Resources': 'people',
  Sales: 'sales',
  Marketing: 'marketing',
  'Customer Service & Support': 'customer',
  Education: 'education',
  Legal: 'legal',
  Engineering: 'engineering',
  'Science & Research': null,
  Trades: 'manufacturing',
  Construction: null,
  Manufacturing: 'manufacturing',
  Logistics: 'operations',
  'Creative & Media': null,
  Hospitality: 'hospitality',
  'Environmental & Sustainability': null,
  Retail: null,
  'Data & Analytics': 'data_ai',
  Software: 'software_engineering',
  Energy: null,
  Agriculture: null,
  'Social Services': null,
  Administrative: 'administration',
  'Government & Public Sector': 'consulting',
  'Art & Design': 'design',
  'Food & Beverage': null,
  Transportation: null,
  Consulting: 'consulting',
  'Sports & Recreation': null,
  'Security & Safety': null,
};

export { FANTASTIC_TAXONOMY_LABELS };

/**
 * Our category for a row's taxonomy labels: the mapping of its PRIMARY label
 * (the first: the vendor orders them by relevance). Null when the row has
 * none, the label is not one the vendor documents, or the table maps it to
 * nothing: the title dictionary then decides, as for every other source.
 */
export function fantasticTaxonomyCategory(labels: unknown): string | null {
  const primary = firstStr(labels)?.trim();
  if (!primary || !Object.hasOwn(FANTASTIC_TAXONOMY_CATEGORY, primary)) return null;
  return FANTASTIC_TAXONOMY_CATEGORY[primary as FantasticTaxonomyLabel] ?? null;
}

/** A stated employer domain as a bare host ("https://www.acme.example/careers" → "acme.example"); null when it is not one. */
function bareDomain(v: unknown): string | null {
  const raw = str(v)?.trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** One raw Fantastic Jobs row → ProviderJobInput (null without id / title / organization). */
export function inputFromFantasticJob(j: unknown, board: 'activejobs' | 'linkedin', fetchedAt: Date): ProviderJobInput | null {
  const r = obj(j);
  if (!r) return null;
  const id = r.id;
  const title = str(r.title);
  const company = str(r.organization);
  if (id == null || String(id).trim() === '' || !title || !company) return null;

  const sal = obj(r.salary) ?? obj(r.salary_raw) ?? {};
  const salValue = obj(sal.value);
  const bare = typeof sal.value === 'number' ? sal.value : null;
  const salaryMin = numOrNull(salValue?.minValue ?? sal.minValue ?? bare ?? r.ai_salary_min_value ?? r.ai_salary_minvalue ?? r.ai_salary_value);
  const salaryMax = numOrNull(salValue?.maxValue ?? sal.maxValue ?? bare ?? r.ai_salary_max_value ?? r.ai_salary_maxvalue ?? r.ai_salary_value);
  const hasSalary = salaryMin != null || salaryMax != null;
  const period = str(salValue?.unitText) ?? str(sal.unitText) ?? str(r.ai_salary_unit_text) ?? str(r.ai_salary_unittext);

  const locs = (Array.isArray(r.locations) ? r.locations : Array.isArray(r.locations_raw) ? r.locations_raw : []) as unknown[];
  const address = obj(obj(locs[0])?.address);
  const rawCountry = address?.addressCountry;
  const country = str(rawCountry) ?? str(obj(rawCountry)?.name) ?? firstStr(r.countries_derived);

  const workArrangement = firstStr(r.ai_work_arrangement);
  const remoteFlag = r.remote_derived === true || r.location_type === 'TELECOMMUTE';
  // The employer's own domain as the vendor derived it (it feeds the employer-domain dedupe key: MARKET_STRATEGY §1.5 K3).
  const domain = bareDomain(r.domain_derived);
  const website = str(r.organization_url) ?? (str(r.domain_derived) ? `https://${str(r.domain_derived)}` : null);
  const companyFacts: CompanyFactsInput | null = website || domain ? { source: `provider:${board}`, ...(website ? { website } : {}), ...(domain ? { domain } : {}), fetchedAt } : null;
  // The vendor's category for the posting, when it is one our tree names too (never a role: the title decides that).
  const category = fantasticTaxonomyCategory(r.ai_taxonomies_a);

  return {
    externalId: `${board}:${String(id)}`,
    sourceBoard: board,
    title,
    company,
    companyLogoUrl: str(r.organization_logo),
    applyUrl: str(r.url),
    sourceUrl: str(r.url),
    applyIsDirect: r.source_type === 'ats',
    sourcePublisher: str(r.source) ?? str(r.source_domain),
    location: firstStr(r.locations_derived),
    locations: strList(r.locations_derived),
    locationCity: firstStr(r.cities_derived),
    locationRegion: firstStr(r.regions_derived),
    locationCountry: country,
    workModel: workArrangement ?? (remoteFlag ? 'remote' : null),
    employmentType: firstStr(r.employment_type) ?? firstStr(r.ai_employment_type),
    salaryMin: hasSalary ? salaryMin : null,
    salaryMax: hasSalary ? salaryMax : null,
    salaryCurrency: hasSalary ? (str(sal.currency) ?? str(r.ai_salary_currency)) : null,
    salaryPeriod: hasSalary ? period : null,
    description: str(r.description_text) ?? str(r.description_html) ?? '',
    postedAt: str(r.date_posted) ?? str(r.date_created),
    postedAtEstimated: !str(r.date_posted),
    fetchedAt,
    // `date_valid_through` is the v1 name; older responses wrote `date_validthrough`.
    expiresAt: str(r.date_valid_through) ?? str(r.date_validthrough) ?? str(r.valid_through),
    experienceLevel: firstStr(r.ai_experience_level),
    skills: strList(r.ai_key_skills),
    ...(category ? { taxonomyId: category } : {}),
    // The provider's reading, never a fact (stored with sponsorshipSource 'provider:<provider id>' and
    // never over a posting quote: ingest/upsert.ts). The flag is "true if the job description mentions
    // visa sponsorship opportunities" (vendor field description, read 2026-10-12): `false` says the
    // description does not mention it, which is not "the employer does not sponsor", so only `true`
    // is a reading. An absent flag and `false` are both "the provider states none".
    sponsorshipProvider: r.ai_visa_sponsorship === true ? 'offered' : null,
    companyFacts,
  };
}

// ── JSearch ───────────────────────────────────────────────────────────────

/** One raw JSearch /search-v2 row → ProviderJobInput (null without id / title / employer). */
export function inputFromJSearchJob(j: unknown, req: { country: string; fetchedAt: Date }): ProviderJobInput | null {
  const r = obj(j);
  if (!r) return null;
  const id = str(r.job_id);
  const title = str(r.job_title);
  const company = str(r.employer_name);
  if (!id || !title || !company) return null;

  // Where a candidate applies is decided by the link's HOST, never by `is_direct` (true on 0 of 58 probed
  // rows; MARKET_STRATEGY M-3, JI-6): the employer's or ATS's page first, then a job board that is neither
  // LinkedIn nor Indeed. `pickEmployerLink` is the same rule the normalizer applies, so this raw-payload
  // path and the client path (raRapidApiJobs) agree. A row whose only links are LinkedIn's or Indeed's
  // keeps its link here; the normalizer refuses it ('linkedin_only_link' / 'indeed_only_link').
  const options = Array.isArray(r.apply_options) ? (r.apply_options as unknown[]).map(obj).filter((o): o is Raw => !!o) : [];
  const postingLink = str(r.job_apply_link);
  const link = pickEmployerLink([postingLink, ...options.map((o) => str(o.apply_link))]);
  const applyUrl = link.url ?? postingLink ?? options.map((o) => str(o.apply_link)).find((u) => u) ?? null;
  // Employer-direct by host; a provider's explicit flag on the chosen link is still honoured.
  const flaggedDirect =
    !!link.url && (options.some((o) => o.is_direct === true && safeUrl(str(o.apply_link)) === link.url) || (r.job_apply_is_direct === true && safeUrl(postingLink) === link.url));
  const exp = obj(r.job_required_experience);
  const months = exp?.no_experience_required === true ? 0 : numOrNull(exp?.required_experience_in_months);
  const city = str(r.job_city);
  const state = str(r.job_state);
  const jobCountry = str(r.job_country);
  const location = city ? [city, state, jobCountry].filter(Boolean).join(', ') : str(r.job_location);
  const website = str(r.employer_website);

  return {
    externalId: `jsearch:${id}`,
    sourceBoard: 'jsearch',
    title,
    company,
    companyLogoUrl: str(r.employer_logo),
    applyUrl,
    sourceUrl: postingLink,
    applyIsDirect: link.direct || flaggedDirect,
    sourcePublisher: str(r.job_publisher),
    location,
    locationCity: city,
    locationRegion: state,
    locationCountry: jobCountry,
    locationCountryEstimated: !jobCountry,
    workType: r.job_is_remote === true ? 'remote' : 'unknown',
    employmentType: Array.isArray(r.job_employment_types) ? strList(r.job_employment_types) : str(r.job_employment_type),
    salaryMin: numOrNull(r.job_min_salary),
    salaryMax: numOrNull(r.job_max_salary),
    salaryCurrency: str(r.job_salary_currency),
    salaryPeriod: str(r.job_salary_period),
    salaryText: str(r.job_salary),
    description: str(r.job_description) ?? '',
    postedAt: str(r.job_posted_at_datetime_utc) ?? (typeof r.job_posted_at_timestamp === 'number' ? new Date(r.job_posted_at_timestamp * 1000) : null),
    postedAtEstimated: !str(r.job_posted_at_datetime_utc) && typeof r.job_posted_at_timestamp !== 'number',
    fetchedAt: req.fetchedAt,
    expiresAt: str(r.job_offer_expiration_datetime_utc),
    experienceMonths: months,
    skills: strList(r.job_required_skills),
    companyFacts: website ? { source: 'provider:jsearch', website, fetchedAt: req.fetchedAt } : null,
  };
}

// ── Recruiter banks (RoboHire / GoHire `Job` rows) ────────────────────────

export interface BankJobLike {
  id: string;
  title: string | null;
  description?: string | null;
  qualifications?: string | null;
  hardRequirements?: string | null;
  niceToHave?: string | null;
  benefits?: string | null;
  location?: string | null;
  /** `[{ country, city }]` */
  locations?: unknown;
  workType?: string | null;
  employmentType?: string | null;
  experienceLevel?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  salaryText?: string | null;
  publishedAt?: Date | string | null;
  companyName?: string | null;
  company?: { id?: string | null; name?: string | null; logoUrl?: string | null } | null;
  requiredKeywordSet?: readonly string[] | null;
  /** The bank's 学历 field: its enum ('bachelor', 'associate' …) or the Chinese word ('本科'). */
  education?: string | null;
  /** 招聘人数 as the bank states it. */
  headcount?: number | null;
}

export interface BankJobExtras {
  /**
   * The job's page on the bank's own site: bankPublicJobUrl(bank, job.id) from
   * raCrossBankMatch. A bank with no candidate-facing page has none; the bank
   * adapter does not call this for such a job (it is held, not listed).
   */
  applyUrl: string;
  /** The bank's verified-employer field. */
  employerVerified?: boolean | null;
  /**
   * The posting is placed by a recruiter for the named employer (代招). The
   * GoHire adapter sets it for every job whose employer the bank has not
   * verified; only a verified employer's job may carry 企业直招.
   */
  agencyPosting?: boolean | null;
  /** The bank's recorded consent to syndicate (OPS-A4). */
  syndicationConsent?: boolean | null;
}

/** Currencies in which a monthly figure of 30,000 or more is implausible enough to distrust a defaulted "monthly". */
const HIGH_VALUE_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'CHF', 'NZD']);

/**
 * A recruiter-bank Job row → ProviderJobInput. The bank columns default
 * `salaryCurrency` to USD and `salaryPeriod` to monthly, so a defaulted value
 * is not trusted where it contradicts the row: GoHire USD is dropped unless the
 * pay text says USD, and a "monthly" figure ≥ 30,000 in a high-value currency
 * loses its period (no annual figure is computed from it).
 */
export function inputFromBankJob(row: BankJobLike, bank: 'robohire' | 'gohire', extras: BankJobExtras): ProviderJobInput | null {
  const title = cleanOrNull(row.title);
  const company = cleanOrNull(row.companyName) ?? cleanOrNull(row.company?.name);
  if (!row.id || !title || !company) return null;

  let currency = cleanOrNull(row.salaryCurrency)?.toUpperCase() ?? null;
  if (bank === 'gohire' && currency === 'USD' && !/USD|US\$|美元|美金/i.test(row.salaryText ?? '')) currency = null;
  let period = cleanOrNull(row.salaryPeriod);
  const top = Math.max(row.salaryMin ?? 0, row.salaryMax ?? 0);
  if (period && /month/i.test(period) && currency && HIGH_VALUE_CURRENCIES.has(currency) && top >= 30_000) period = null;

  const locs = Array.isArray(row.locations)
    ? (row.locations as unknown[])
        .map(obj)
        .filter((l): l is Raw => !!l)
        .map((l) => [str(l.city), str(l.country)].filter(Boolean).join(', '))
        .filter(Boolean)
    : [];
  const description = [row.description, row.qualifications, row.hardRequirements, row.niceToHave, row.benefits]
    .map((p) => cleanOrNull(p))
    .filter((p): p is string => !!p)
    .join('\n\n');

  return {
    externalId: row.id,
    sourceBoard: bank,
    title,
    company,
    companyLogoUrl: cleanOrNull(row.company?.logoUrl),
    applyUrl: extras.applyUrl,
    sourceUrl: extras.applyUrl,
    applyIsDirect: true,
    sourcePublisher: null,
    location: cleanOrNull(row.location) ?? locs[0] ?? null,
    locations: locs.length ? locs : null,
    workModel: cleanOrNull(row.workType),
    employmentType: cleanOrNull(row.employmentType),
    seniority: cleanOrNull(row.experienceLevel),
    salaryMin: row.salaryMin ?? null,
    salaryMax: row.salaryMax ?? null,
    salaryCurrency: currency,
    salaryPeriod: period,
    salaryText: cleanOrNull(row.salaryText),
    description,
    postedAt: row.publishedAt ?? null,
    skills: row.requiredKeywordSet ? [...row.requiredKeywordSet] : null,
    educationLevel: cleanOrNull(row.education),
    headcount: typeof row.headcount === 'number' && Number.isInteger(row.headcount) && row.headcount > 0 ? row.headcount : null,
    agencyPosting: extras.agencyPosting ?? null,
    employerVerified: extras.employerVerified ?? null,
    syndicationConsent: extras.syndicationConsent ?? null,
    bankCompanyRef: row.company?.id ? `${bank}:${row.company.id}` : null,
  };
}
