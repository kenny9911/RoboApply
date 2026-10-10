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
// Structural input types only: no imports from roboapply/v2 (decoupled).
// Never mapped (H9, D3): LinkedIn organization fields (`linkedin_org_*`),
// hiring-manager names, and any applicant / view counts.

import type { ExternalJobNormalized } from '../../../roboapply/v2/lib/raExternalJobTypes.js';
import { cleanOrNull } from './text.js';
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
  const website = str(r.organization_url) ?? (str(r.domain_derived) ? `https://${str(r.domain_derived)}` : null);
  const companyFacts: CompanyFactsInput | null = website ? { source: `provider:${board}`, website, fetchedAt } : null;

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
    expiresAt: str(r.date_validthrough) ?? str(r.valid_through),
    experienceLevel: firstStr(r.ai_experience_level),
    skills: strList(r.ai_key_skills),
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

  const options = Array.isArray(r.apply_options) ? (r.apply_options as unknown[]).map(obj).filter((o): o is Raw => !!o) : [];
  const direct = options.find((o) => o.is_direct === true && str(o.apply_link));
  const applyUrl = str(direct?.apply_link) ?? str(r.job_apply_link);
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
    sourceUrl: str(r.job_apply_link),
    applyIsDirect: !!direct || r.job_apply_is_direct === true,
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
