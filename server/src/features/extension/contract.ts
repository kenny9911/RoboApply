// server/src/features/extension/contract.ts
//
// Browser extension API (ARCHITECTURE.md §3.8, §6; TASK_PLAN.md WP-55a).
// Mounts: /api/v1/roboapply/ext (seeker-session routes for pairing; device
// routes authenticated with `Authorization: Bearer rax_…`) and
// /api/v1/public/ext (uninstall survey). Capability `extension` on every
// route, `ext.autofill` on the autofill routes.
//
// D1: the extension fills forms; the user clicks Submit. It never watches
// submits; `userMarkedSubmitted` is only what the user tells us. Protected
// question types never get an AI answer.
//
// Errors keep the platform `code` generic and put the area reason in
// `details.reason` (EXTENSION_ERROR_CODES): a revoked device answers
// `401 unauthorized` + `details.reason = 'device_revoked'`.

import { z } from 'zod';

const Id = z.string().min(1).max(64);

/** Device token format: 'rax_' + 32 random bytes, base64url. Stored hashed. */
export const EXT_TOKEN_PREFIX = 'rax_';
export const EXT_TOKEN_RE = /^rax_[A-Za-z0-9_-]{20,}$/;

/** Pair codes: 8 characters, no 0/O/1/I so they read back without mistakes. */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_TTL_MS = 10 * 60_000;
/** Signed resume links live this long (ARCH §3.8). */
export const FILE_URL_TTL_MS = 5 * 60_000;
/** `lastSeenAt` is written at most this often per device. */
export const LAST_SEEN_WRITE_MS = 10 * 60_000;

const DeviceInfo = {
  name: z.string().trim().min(1).max(80),
  browser: z.string().trim().max(40).optional(),
  extVersion: z.string().trim().max(20).optional(),
};

/** POST /ext/devices (session) → raw token returned once. 5/day. */
export const CreateDeviceBodySchema = z.object(DeviceInfo).strict();
export interface CreateDeviceResponse {
  deviceId: string;
  token: string;
}
export interface DeviceView {
  id: string;
  name: string;
  browser: string | null;
  extVersion: string | null;
  tokenPrefix: string;
  lastSeenAt: string | null;
  createdAt: string;
}
export const DeviceParamsSchema = z.object({ id: Id });

/**
 * GET /ext/status (session) — what the /extension page and #devices need:
 * the paired devices of this brand and the lowest extension version the
 * server still accepts (`MIN_EXT_VERSION` / `CN_MIN_EXT_VERSION`; null = any).
 */
export interface ExtStatusResponse {
  minExtVersion: string | null;
  devices: DeviceView[];
}

/** POST /ext/pair-codes (session) → 8-char code, +10 min. 10/h. */
export interface PairCodeResponse {
  code: string;
  expiresAt: string;
}
/** POST /ext/pair-codes/redeem (public) → a device token. 10/h/IP. */
/** Codes are case-insensitive for the person typing them: trimmed and uppercased before the format check. */
export const PAIR_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
export const RedeemPairCodeBodySchema = z
  .object({
    code: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(PAIR_CODE_RE)),
    ...DeviceInfo,
  })
  .strict();

/** GET /ext/me (device). */
export interface ExtMeResponse {
  user: { id: string; email: string | null; firstName: string | null };
  brand: { id: 'roboapply' | 'goapply'; name: string };
  entitlements: unknown;
  flags: Record<string, unknown>;
  /** 0–100 from the user's own profile, or null when it could not be read. */
  profileCompleteness: number | null;
  /** Below this version the extension shows "Update the extension". */
  minExtVersion: string | null;
}

/** GET /ext/autofill-profile (device) — EEO / CN sensitive only with consent `autofill_sensitive`. */
export interface AutofillProfile {
  profile: Record<string, unknown>;
  education: Array<Record<string, unknown>>;
  experience: Array<Record<string, unknown>>;
  links: Record<string, string>;
  workAuth: Array<{ country: string; authorized: boolean | null; sponsorship: 'now' | 'later' | 'no' | null }>;
  answers: Array<{ questionKey: string; questionText: string; answer: string }>;
  /** Null without a live `autofill_sensitive` consent (or when nothing is stored). Fill these only for review. */
  sensitive: Record<string, unknown> | null;
}

const PageJob = {
  url: z.string().url().max(2000),
  title: z.string().trim().min(1).max(200),
  company: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).optional(),
  descriptionText: z.string().max(60_000),
};
/** POST /ext/page-job (device, user click only — never on page load) → `{ jobId, fit }`. 120/day. */
export const PageJobBodySchema = z.object(PageJob).strict();
/**
 * The fit chip. `jobId` is the matching job in the user's listings (public
 * in this market, or the user's own import), or null when the page is not
 * one of them; `fit` is the same scorer the app uses: a cached AI score when
 * there is one, otherwise the deterministic "Quick estimate" (`kind: 'pre'`).
 * Never a chance of being hired.
 */
export interface PageJobResponse {
  jobId: string | null;
  fit: {
    score: number | null;
    tier: string | null;
    kind: 'pre' | 'ai';
    topOverlap: string | null;
    topGap: string | null;
  } | null;
}

/** Same floor as a job added by hand (jobs/import MIN_DESCRIPTION_CHARS): shorter page text is not a job post. */
export const SAVE_MIN_DESCRIPTION_CHARS = 50;
/** POST /ext/jobs/save (device) → tracker entry (private RAJob when unmatched). 100/day. */
export const SaveJobBodySchema = z
  .object({ ...PageJob, descriptionText: z.string().trim().min(SAVE_MIN_DESCRIPTION_CHARS).max(60_000) })
  .strict();
export interface SaveJobResponse {
  jobId: string;
  trackerEntryId: string;
  /** The job already existed: in our listings (`public`) or among the user's own imports (`yours`). */
  matched: 'public' | 'yours' | null;
}

/** POST /ext/autofill-runs (device) — reserves an `autofill` credit. */
export const CreateAutofillRunBodySchema = z
  .object({
    host: z.string().trim().min(1).max(255),
    atsType: z.string().trim().min(1).max(40),
    url: z.string().url().max(2000),
    jobId: Id.optional(),
    fieldsTotal: z.number().int().min(0).max(1000),
  })
  .strict();
export interface CreateAutofillRunResponse {
  runId: string;
  /** The job the run is linked to (null when the page is not a job we know). */
  jobId: string | null;
}
export const AUTOFILL_OUTCOMES = ['filled', 'partial', 'failed'] as const;
/** PATCH /ext/autofill-runs/:id — commits (fieldsFilled > 0) or releases. */
export const PatchAutofillRunBodySchema = z
  .object({ fieldsFilled: z.number().int().min(0).max(1000), outcome: z.enum(AUTOFILL_OUTCOMES), userMarkedSubmitted: z.boolean().optional() })
  .strict();
export const RunParamsSchema = z.object({ id: Id });
export interface PatchAutofillRunResponse {
  runId: string;
  outcome: (typeof AUTOFILL_OUTCOMES)[number];
  fieldsFilled: number;
  /** The `autofill` credit was spent (only when at least one field was filled). */
  charged: boolean;
  /** True once the user said they submitted (never detected). */
  userMarkedSubmitted: boolean;
  /** The tracker entry moved to Applied, or null (no job linked to the run). */
  trackerEntryId: string | null;
  /** The entry was already at Applied or further along (nothing to undo). */
  alreadyApplied: boolean;
}

/** Question types that never get an AI answer (bank/profile only, or left to the user). */
export const PROTECTED_QUESTION_TYPES = [
  'work_authorization',
  'sponsorship',
  'criminal_history',
  'eeo',
  'disability',
  'veteran',
  /** Birth date, age, marital status, 政治面貌, 籍贯, ID numbers, health: never in a prompt (§2.2). */
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
/** Every type the classifier answers; `free_text` is the only one AI may draft. */
export type QuestionType = ProtectedQuestionType | 'free_text';

/** POST /ext/answers (device) — bank hit free; AI answer costs `ai_answer`. */
export const AnswerQuestionBodySchema = z
  .object({
    runId: Id,
    question: z.string().trim().min(1).max(2000),
    fieldType: z.enum(['text', 'textarea', 'select', 'radio', 'checkbox']),
    maxLength: z.number().int().min(1).max(20_000).optional(),
    options: z.array(z.string().max(300)).max(100).optional(),
  })
  .strict();
/**
 * Why no answer came back (`source: 'none'`). `unsupported_language`: the
 * question is not in English or Chinese, so AI does not draft it (the
 * classifier cannot vouch that it is not a fact about the person).
 */
export const ANSWER_NONE_REASONS = ['protected', 'choice_field', 'unsupported_language', 'ai_off', 'ai_unavailable', 'empty'] as const;
export interface AnswerQuestionResponse {
  answer: string | null;
  /**
   * `bank`: the user's own saved answer. `ai`: a draft shown ONLY in the side
   * panel; nothing goes into the page until the user clicks "Use this
   * answer" for that field. Never `ai` for a protected question type.
   */
  source: 'bank' | 'ai' | 'none';
  /** The user may save this answer to their bank (AI drafts only). */
  saveable: boolean;
  questionType: QuestionType;
  reason: (typeof ANSWER_NONE_REASONS)[number] | null;
}

/**
 * POST /ext/resume-for-job (device) → signed URL (5 min). `jobId` defaults to
 * the run's job. On a page that is not one of the user's jobs (run `jobId`
 * null) the main resume comes back and the download is not recorded on an
 * application; to record it, save the job first (POST /ext/jobs/save, one
 * `job_import`) and pass the returned `jobId`.
 */
export const ResumeForJobBodySchema = z.object({ jobId: Id.optional(), runId: Id }).strict();
export interface ResumeForJobResponse {
  variantId: string;
  isTailored: boolean;
  fileName: string;
  downloadUrl: string;
  /** A tailored copy exists but still has details to verify, so the main resume is used. */
  tailoredNeedsReview: boolean;
}
export const FileTokenParamsSchema = z.object({ signedToken: z.string().min(16).max(1024) });

/**
 * POST /ext/site-requests (device) — 10/day. Only the page's origin and path
 * are kept (no query string). The stored host is always the URL's own host;
 * `host` is accepted for older extension builds and ignored.
 */
export const SiteRequestBodySchema = z
  .object({ host: z.string().trim().min(1).max(255), url: z.string().url().max(2000), note: z.string().max(500).optional() })
  .strict();

/** POST /api/v1/public/ext/uninstall-survey — 5/day/IP. Stored in RASurveyResponse (`{ reasons, note? }`). */
export const UNINSTALL_REASONS = ['not_useful', 'wrong_fills', 'privacy', 'too_many_prompts', 'site_not_supported', 'other'] as const;
export const UninstallSurveyBodySchema = z
  .object({ reasons: z.array(z.enum(UNINSTALL_REASONS)).min(1).max(6), note: z.string().max(1000).optional() })
  .strict();
/** `RASurveyResponse.answers` (documented JSON column). */
export const SurveyAnswersSchema = z.object({ reasons: z.array(z.string()), note: z.string().optional() }).strict();

/**
 * ATS types each market's extension build can fill (ARCHITECTURE.md §6.2).
 * intl: WP-55b's three plus WP-70's adapters (extension
 * `INTL_FILLABLE_ATS_TYPES`); cn: WP-71's mainland portals. The label-based
 * `generic` adapters are never listed. The web mirror is
 * `hooks/extension/bridge.ts#EXTENSION_ATS_BY_BRAND`; a test keeps them equal.
 */
export const EXTENSION_ATS_TYPES_BY_MARKET = {
  intl: ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'icims', 'workable', 'taleo', 'successfactors'],
  cn: ['moka', 'beisen', 'feishu', 'dayee'],
} as const satisfies Record<'intl' | 'cn', readonly string[]>;

/**
 * Where each adapter runs: its manifest match patterns (extension
 * `adapters/<market>/<type>.ts#hostPatterns`; extension/test/contractParity
 * keeps them equal). `jobs/normalize/ats.ts` maps more hosts to some types
 * (jobs.bytedance.com → feishu, sapsf.* → successfactors, myworkday.com →
 * workday, any *.smartrecruiters.com / *.workable.com) than the adapter has a
 * host permission for, so a job page offers the extension only when its
 * application URL matches one of these (Wave 5 gate).
 */
export const EXTENSION_ATS_HOST_PATTERNS = {
  greenhouse: ['https://boards.greenhouse.io/*', 'https://job-boards.greenhouse.io/*', 'https://job-boards.eu.greenhouse.io/*'],
  lever: ['https://jobs.lever.co/*', 'https://jobs.eu.lever.co/*'],
  ashby: ['https://jobs.ashbyhq.com/*'],
  workday: ['https://*.myworkdayjobs.com/*', 'https://*.myworkdaysite.com/*'],
  smartrecruiters: ['https://jobs.smartrecruiters.com/*'],
  icims: ['https://*.icims.com/*'],
  workable: ['https://apply.workable.com/*'],
  taleo: ['https://*.taleo.net/careersection/*'],
  successfactors: ['https://*.successfactors.com/career*', 'https://*.successfactors.eu/career*'],
  moka: ['https://*.mokahr.com/*'],
  beisen: ['https://*.zhiye.com/*', 'https://*.beisen.com/*'],
  feishu: ['https://*.jobs.feishu.cn/*'],
  dayee: ['https://*.dayee.com/*', 'https://*.hotjob.cn/*'],
} as const satisfies Record<(typeof EXTENSION_ATS_TYPES_BY_MARKET)[keyof typeof EXTENSION_ATS_TYPES_BY_MARKET][number], readonly string[]>;

/**
 * Forms the user moves through page by page. Until one run covers every
 * page of one application (R4, WP-93) each page starts its own run and
 * reserves its own `autofill` credit, so job pages do not offer the
 * extension for these (the extension still fills them where the user opens
 * one). Mirrored in `hooks/extension/bridge.ts#EXTENSION_PER_PAGE_ATS`.
 */
export const EXTENSION_PER_PAGE_ATS_TYPES = ['workday', 'icims', 'taleo', 'successfactors'] as const;

/** Chrome match-pattern semantics for the https patterns the adapters declare (extension `matchesHostPattern`). */
export function matchesExtensionHostPattern(url: string, pattern: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const m = pattern.match(/^(\*|https?):\/\/(\*\.)?([^/]+)(\/.*)$/);
  if (!m) return false;
  const [, scheme, anySub, host, path] = m;
  if (scheme === '*' ? !/^https?:$/.test(u.protocol) : u.protocol !== `${scheme}:`) return false;
  const h = u.hostname.toLowerCase();
  const base = host!.toLowerCase();
  if (!(h === base || (anySub && h.endsWith(`.${base}`)))) return false;
  const re = new RegExp(`^${path!.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(`${u.pathname}${u.search}`);
}

/**
 * Whether a job page should offer "Fill this form": the market's extension
 * fills this ATS, it is not a page-by-page form (R4), and the application
 * URL is on a host the adapter can run on.
 */
export function extensionOffersFill(market: 'intl' | 'cn', atsType: string | null | undefined, applyUrl: string | null | undefined): boolean {
  if (!atsType || !applyUrl) return false;
  if (!(EXTENSION_ATS_TYPES_BY_MARKET[market] as readonly string[]).includes(atsType)) return false;
  if ((EXTENSION_PER_PAGE_ATS_TYPES as readonly string[]).includes(atsType)) return false;
  const patterns = (EXTENSION_ATS_HOST_PATTERNS as Record<string, readonly string[]>)[atsType] ?? [];
  return patterns.some((p) => matchesExtensionHostPattern(applyUrl.trim(), p));
}

/** Area reasons, sent in `details.reason` under a generic platform code. */
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

// ── Web page ↔ extension messages (chrome.runtime.sendMessage; WP-55b answers) ──
//
// The /extension page talks to the installed extension through
// `externally_connectable` with the brand's extension id
// (NEXT_PUBLIC_EXT_ID / NEXT_PUBLIC_CN_EXT_ID). The device token travels only
// in the `pair` message; it never touches page storage.

/** `{ type: 'ping' }` → ExtPingReply. */
export interface ExtPingMessage {
  type: 'ping';
}
export interface ExtPingReply {
  ok: true;
  version: string;
  /** The extension holds a device token for this brand. */
  paired: boolean;
  brand?: 'roboapply' | 'goapply';
}
/** `{ type: 'pair', token, apiOrigin }` → `{ ok }`. */
export interface ExtPairMessage {
  type: 'pair';
  token: string;
  apiOrigin: string;
}
export interface ExtPairReply {
  ok: boolean;
}
export type ExtWebMessage = ExtPingMessage | ExtPairMessage;
