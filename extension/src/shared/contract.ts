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
/** 8 characters, no 0/O/1/I (the server's alphabet). */
export const PAIR_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
/** What the extension sends as its device name and `browser` when it redeems a pair code. */
export const EXT_BROWSER_NAMES = ['Chrome', 'Edge'] as const;
export type ExtBrowserName = (typeof EXT_BROWSER_NAMES)[number];

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
  /** Grades and test scores (GPA, 绩点, 排名, 成绩, 四六级 / CET, IELTS, TOEFL): the user's own record, never drafted. */
  'grades',
] as const;
export type ProtectedQuestionType = (typeof PROTECTED_QUESTION_TYPES)[number];

export const AUTOFILL_OUTCOMES = ['filled', 'partial', 'failed'] as const;
export type AutofillOutcome = (typeof AUTOFILL_OUTCOMES)[number];

export type BrandIdWire = 'roboapply' | 'goapply';
export type FitTier = 'great' | 'good' | 'possible' | 'unlikely';

/**
 * GET /ext/me. `flags.aiAnswers` is true only when AI drafts may be offered
 * for this account (the account's AI consent — aiAllowed() on GoApply — and a
 * text model for the brand); anything else hides "Write a draft".
 */
export interface ExtMeResponse {
  user: { id: string; email: string | null; firstName: string | null };
  brand: { id: BrandIdWire; name: string };
  entitlements: unknown;
  flags: Record<string, unknown> & { aiAnswers?: boolean };
  /** 0–100, or null when the profile could not be read. */
  profileCompleteness: number | null;
  /** Below this version the server asks for an update (null = any). */
  minExtVersion?: string | null;
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
  /**
   * `ai_confirmed`: a draft the user approved on one employer's form ("Save
   * this answer"). It fills by itself only into the same question; for a
   * similar one it is offered as a draft. Absent / `user`: typed in the app.
   */
  source?: 'user' | 'ai_confirmed';
}

/**
 * GET /ext/autofill-profile. `profile` carries the profile view's keys
 * (firstName, middleName, lastName, contactEmail, phoneE164, addressLine1,
 * city, region, postalCode, country, links, headline …); `education[]` rows
 * carry school, degree, major; `experience[]` rows company, title, current.
 * `sensitive` is null without the `autofill_sensitive` consent; with it,
 * `sensitive.eeo` holds gender, race (or ethnicity), hispanicLatino, veteran,
 * disability and pronouns as the words a form shows.
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
  /** The matching job in the user's listings; null (or absent) when the page is not one of them. */
  jobId?: string | null;
  fit?: FitChip | null;
}

export interface CreateAutofillRunBody {
  host: string;
  atsType: string;
  url: string;
  jobId?: string;
  fieldsTotal: number;
}
/**
 * One run, and one form-fill credit, per application: asking again for the
 * same application (the next page of a page-by-page form, or a reloaded tab)
 * returns the first run with `reused: true` and what its earlier pages reported.
 */
export interface CreateAutofillRunResponse {
  runId: string;
  /** The job the server linked the run to (null: not one of the user's jobs). */
  jobId?: string | null;
  reused?: boolean;
  fieldsFilled?: number;
  fieldsTotal?: number;
}
/** `fieldsFilled` / `fieldsTotal` are running totals for the whole application. Sent after each fill pass and again with `userMarkedSubmitted`. */
export interface PatchAutofillRunBody {
  fieldsFilled: number;
  fieldsTotal?: number;
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
/**
 * A protected question with no saved answer is not answered: the server
 * refuses it (`details.reason = 'protected_question'`, `details.type`).
 */
export interface AnswerQuestionResponse {
  answer: string | null;
  source: 'bank' | 'ai' | 'none';
  saveable: boolean;
  questionType?: ProtectedQuestionType | 'free_text';
  reason?: string | null;
}

/** POST /ext/answers/save — "Save this answer": an answer the user approved goes to their saved answers. Free. */
export interface SaveAnswerBody {
  runId: string;
  question: string;
  answer: string;
}
export interface SaveAnswerResponse {
  saved: true;
  questionKey: string;
}

/**
 * POST /ext/resume-for-job. `jobId` is left out on a page that is not one of
 * the user's jobs: the server then returns the main resume (and records the
 * download on no application).
 */
export interface ResumeForJobBody {
  jobId?: string;
  runId: string;
}
export interface ResumeForJobResponse {
  variantId: string;
  isTailored: boolean;
  fileName: string;
  downloadUrl: string;
  tailoredNeedsReview?: boolean;
}

export interface SiteRequestBody {
  host: string;
  url: string;
  note?: string;
}

/** POST /ext/pair-codes/redeem → `{ token }`. */
export interface RedeemPairCodeBody {
  code: string;
  name: string;
  browser?: ExtBrowserName;
  extVersion?: string;
}

/** The platform envelope (server/src/platform/http.ts). */
export type Envelope<T> = { success: true; data: T } | { success: false; code: string; error?: string; details?: unknown };

/**
 * Area reasons. The server keeps the envelope `code` generic and puts these
 * in `details.reason` (a refused protected question is `invalid_request` with
 * `details.reason = 'protected_question'` and `details.type`).
 */
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

/** The area reason of a failed call: `details.reason`, else the envelope code. */
export function errorReason(result: { code: string; details?: unknown }): string {
  const reason = (result.details as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' && reason ? reason : result.code;
}
