// extension/src/shared/contract.ts — the `/ext` wire contract, as the extension sees it.
//
// The canonical contract is server/src/features/extension/contract.ts (WP-55a).
// The extension bundles no zod and cannot import server code at runtime, so it
// mirrors the types it uses here; test/contractParity.test.ts fails when the
// mirrored constants drift from the server file.
//
// D1: the extension fills forms; the user clicks Submit. `userMarkedSubmitted`
// is only ever what the user tells us in the panel.

export const EXT_TOKEN_PREFIX = 'rax_';
export const EXT_TOKEN_RE = /^rax_[A-Za-z0-9_-]{20,}$/;
export const PAIR_CODE_RE = /^[A-Z0-9]{8}$/;

/** Question types that never get an AI answer (answer bank / profile only, or left to the user). */
export const PROTECTED_QUESTION_TYPES = [
  'work_authorization',
  'sponsorship',
  'criminal_history',
  'eeo',
  'disability',
  'veteran',
  /** Birth date, age, marital status, 政治面貌, 籍贯, ID numbers, health: never in a prompt (server contract). */
  'personal',
  'salary_history',
  'salary_expectation',
  'years_of_experience',
  'degree',
  'certification',
  'clearance',
  'notice_period',
] as const;
export type ProtectedQuestionType = (typeof PROTECTED_QUESTION_TYPES)[number];

export const AUTOFILL_OUTCOMES = ['filled', 'partial', 'failed'] as const;
export type AutofillOutcome = (typeof AUTOFILL_OUTCOMES)[number];

export type BrandIdWire = 'roboapply' | 'goapply';
export type FitTier = 'great' | 'good' | 'possible' | 'unlikely';

/** GET /ext/me */
export interface ExtMeResponse {
  user: { id: string; email: string | null; firstName: string | null };
  brand: { id: BrandIdWire; name: string };
  entitlements: unknown;
  flags: Record<string, unknown>;
  profileCompleteness: number;
}

export interface WorkAuthEntry {
  country: string;
  authorized: boolean | null;
  sponsorship: 'now' | 'later' | 'no' | null;
}

export interface BankAnswer {
  questionKey: string;
  questionText: string;
  answer: string;
}

/**
 * GET /ext/autofill-profile. `profile` carries the profile view's keys
 * (firstName, lastName, contactEmail, phoneE164, addressLine1, city, region,
 * postalCode, country, links, headline …); `sensitive` is null without the
 * `autofill_sensitive` consent.
 */
export interface AutofillProfile {
  profile: Record<string, unknown>;
  education: Array<Record<string, unknown>>;
  experience: Array<Record<string, unknown>>;
  links: Record<string, string>;
  workAuth: WorkAuthEntry[];
  answers: BankAnswer[];
  sensitive: Record<string, unknown> | null;
}

/** The fit for a page job: the app's scoring service (pre-score or cached AI score). */
export interface FitChip {
  score: number | null;
  tier: FitTier | null;
  kind: 'pre' | 'ai';
}

/** Body of POST /ext/page-job and POST /ext/jobs/save. */
export interface PageJobBody {
  url: string;
  title: string;
  company: string;
  location?: string;
  descriptionText: string;
}
export interface PageJobResponse {
  jobId?: string;
  fit?: FitChip;
}

export interface CreateAutofillRunBody {
  host: string;
  atsType: string;
  url: string;
  jobId?: string;
  fieldsTotal: number;
}
export interface CreateAutofillRunResponse {
  runId: string;
}
export interface PatchAutofillRunBody {
  fieldsFilled: number;
  outcome: AutofillOutcome;
  userMarkedSubmitted?: boolean;
}

export type AnswerFieldType = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox';
export interface AnswerQuestionBody {
  runId: string;
  question: string;
  fieldType: AnswerFieldType;
  maxLength?: number;
  options?: string[];
}
export interface AnswerQuestionResponse {
  answer: string | null;
  source: 'bank' | 'ai' | 'none';
  saveable: boolean;
}

export interface ResumeForJobBody {
  jobId: string;
  runId: string;
}
export interface ResumeForJobResponse {
  variantId: string;
  isTailored: boolean;
  fileName: string;
  downloadUrl: string;
}

export interface SiteRequestBody {
  host: string;
  url: string;
  note?: string;
}

export interface RedeemPairCodeBody {
  code: string;
  name: string;
  browser?: string;
  extVersion?: string;
}

/** The platform envelope (server/src/platform/http.ts). */
export type Envelope<T> = { success: true; data: T } | { success: false; code: string; error?: string; details?: unknown };

export const EXTENSION_ERROR_CODES = {
  deviceRevoked: 'device_revoked',
  pairCodeInvalid: 'pair_code_invalid',
  protectedQuestion: 'protected_question',
  runNotFound: 'run_not_found',
  noResume: 'no_resume',
  fileLinkExpired: 'file_link_expired',
  /** resume-for-job named a job other than the one the autofill run is linked to. */
  runJobMismatch: 'run_job_mismatch',
} as const;
