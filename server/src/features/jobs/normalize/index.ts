// server/src/features/jobs/normalize/index.ts — public surface of the job
// normalizers (WP-16a, ARCH §4.4). Pure, deterministic functions; no I/O.
//
// Callers: ingest (WP-16b) and the ATS board sync (WP-42) run
//   normalizeProviderJob(input, provider, ctx) → marketHooks.afterNormalize → upsert;
// job import (WP-35) uses the same entry with provider 'user_import'.
// Adapters turn raw Fantastic Jobs / JSearch / recruiter-bank rows into the
// input shape; the existing clients' ExternalJobNormalized rows already fit it.

export { asMarketHookJob, marketOfPosting, normalizeProviderJob, normalizeSkills, taxonomyIdsForTitle, MAX_DISTRICT_CHARS, MAX_SKILLS } from './normalizeProviderJob.js';
export { inputFromBankJob, inputFromExternalJob, inputFromFantasticJob, inputFromJSearchJob } from './adapters.js';
export type { BankJobExtras, BankJobLike } from './adapters.js';
export { agencyFromCompanyName, resolveIsAgency } from './agency.js';
export {
  applyLinkKind,
  atsPostingKeyFromBoardRow,
  atsPostingKeyFromUrl,
  atsPostingKeyFromUrls,
  atsPostingKeyOf,
  atsPostingRefFromUrl,
  atsTypeFromUrl,
  atsTypeFromUrls,
  isIndeedHost,
  isJobBoardHost,
  pickEmployerLink,
} from './ats.js';
export type { ApplyLinkKind, AtsPostingKeyAts, AtsPostingRef, EmployerLinkPick } from './ats.js';
export { SIZE_BANDS, buildCompanyUpsert, employerDomain, registrableDomain, sizeBandFromCount, sizeBandFromText } from './company.js';
export type { SizeBand } from './company.js';
export {
  AGE_EXPIRY_BOARDS,
  AGE_EXPIRY_PROVIDERS,
  AGGREGATOR_BOARD_LINK_DAYS,
  DEFAULT_EXPIRY_DAYS,
  NO_DATE_EXPIRY_PROVIDERS,
  buildSearchText,
  deadlineInstant,
  dedupeKey,
  dedupePlace,
  displayPostedAt,
  naiveOffsetMinutesFor,
  resolveExpiresAt,
  resolvePostedAt,
  toDate,
} from './identity.js';
export type { ExpiryOptions } from './identity.js';
export {
  educationFromLabel,
  educationFromText,
  employmentTypeFromLabel,
  employmentTypeFromTitle,
  roleTypeFromTitle,
  seniorityFromLabel,
  seniorityFromTitle,
  seniorityFromYears,
  yearsFromProvider,
  yearsFromText,
} from './level.js';
export type { EducationFromText, YearsRange } from './level.js';
export { annualize, currencyFromText, normalizeSalary, parseSalaryText, payFromDescription, payPlausible, periodFromLabel, periodFromText, statesAmount, withoutPayLabel } from './salary.js';
export type { ParsedPay, SalaryInput, SalaryResult } from './salary.js';
// MKT-1C (JT-1): the "pay not listed" wording and the Art. 5 floor clause as regular-expression sources.
// The Taiwan card hook (sources/atsPublic/hooks.ts) holds character-for-character copies today; with these
// exported it can import them instead (MKT-3D). Exported at the M1 gate.
export { CJK_NEGOTIABLE_SOURCE, TW_FLOOR_CLAUSE_SOURCE, TW_FLOOR_OTHER_PAY_BEFORE_SOURCE, TW_FLOOR_STATUTE_SOURCE } from './salary.js';
export { NEVER_PUBLIC_DISPLAY_PROVIDERS, NO_APPLICANT_COUNT_PROVIDERS, PROVIDER_META, applicantCountAllowed, isLinkedInAssetHost, isLinkedInBranded, isLinkedInHost, sourceFields } from './source.js';
export type { ProviderMeta, SourceFields } from './source.js';
export { foldTwToCn } from './zhVariants.js';
export { cleanText, htmlToPlain, hostOf, normalizeCompanyName, normalizeJobTitle, safeUrl, stripControl } from './text.js';
export { resolveWorkModel, workModelFromDescription, workModelFromProvider, workModelFromTitle } from './workModel.js';
export type {
  AtsType,
  CompanyFactsInput,
  CompanyUpsert,
  EducationLevel,
  EmploymentType,
  FieldSource,
  NormalizeContext,
  NormalizedJob,
  NormalizedLocation,
  NormalizeProvider,
  ProviderJobInput,
  RoleType,
  SalaryPeriod,
  SalarySource,
  Seniority,
  SponsorshipReading,
  WorkModel,
  WorkShift,
} from './types.js';
export { WORK_SHIFTS } from './types.js';
