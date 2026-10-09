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

import { z } from 'zod';

const Id = z.string().min(1).max(64);

/** Device token format: 'rax_' + 32 random bytes, base64url. Stored hashed. */
export const EXT_TOKEN_PREFIX = 'rax_';
export const EXT_TOKEN_RE = /^rax_[A-Za-z0-9_-]{20,}$/;

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

/** POST /ext/pair-codes (session) → 8-char code, +10 min. 10/h. */
export interface PairCodeResponse {
  code: string;
  expiresAt: string;
}
/** POST /ext/pair-codes/redeem (public) → token. 10/h/IP. */
export const RedeemPairCodeBodySchema = z.object({ code: z.string().regex(/^[A-Z0-9]{8}$/), ...DeviceInfo }).strict();

/** GET /ext/me (device). */
export interface ExtMeResponse {
  user: { id: string; email: string | null; firstName: string | null };
  brand: { id: 'roboapply' | 'goapply'; name: string };
  entitlements: unknown;
  flags: Record<string, unknown>;
  profileCompleteness: number;
}

/** GET /ext/autofill-profile (device) — EEO / CN sensitive only with consent `autofill_sensitive`. */
export interface AutofillProfile {
  profile: Record<string, unknown>;
  education: Array<Record<string, unknown>>;
  experience: Array<Record<string, unknown>>;
  links: Record<string, string>;
  workAuth: Array<{ country: string; authorized: boolean | null; sponsorship: 'now' | 'later' | 'no' | null }>;
  answers: Array<{ questionKey: string; questionText: string; answer: string }>;
  sensitive: Record<string, unknown> | null;
}

const PageJob = {
  url: z.string().url().max(2000),
  title: z.string().trim().min(1).max(200),
  company: z.string().trim().min(1).max(200),
  location: z.string().trim().max(200).optional(),
  descriptionText: z.string().max(60_000),
};
/** POST /ext/page-job (device, user click only) → `{ jobId?, fit? }`. 120/day. */
export const PageJobBodySchema = z.object(PageJob).strict();
/** POST /ext/jobs/save (device) → tracker entry (private RAJob when unmatched). 100/day. */
export const SaveJobBodySchema = z.object(PageJob).strict();

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
export const AUTOFILL_OUTCOMES = ['filled', 'partial', 'failed'] as const;
/** PATCH /ext/autofill-runs/:id — commits (fieldsFilled > 0) or releases. */
export const PatchAutofillRunBodySchema = z
  .object({ fieldsFilled: z.number().int().min(0).max(1000), outcome: z.enum(AUTOFILL_OUTCOMES), userMarkedSubmitted: z.boolean().optional() })
  .strict();
export const RunParamsSchema = z.object({ id: Id });

/** Question types that never get an AI answer (bank/profile only, or left to the user). */
export const PROTECTED_QUESTION_TYPES = [
  'work_authorization',
  'sponsorship',
  'criminal_history',
  'eeo',
  'disability',
  'veteran',
  'salary_history',
  'salary_expectation',
  'years_of_experience',
  'degree',
  'certification',
  'clearance',
  'notice_period',
] as const;

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
export interface AnswerQuestionResponse {
  answer: string | null;
  source: 'bank' | 'ai' | 'none';
  saveable: boolean;
}

/** POST /ext/resume-for-job (device) → signed URL (5 min). */
export const ResumeForJobBodySchema = z.object({ jobId: Id, runId: Id }).strict();
export interface ResumeForJobResponse {
  variantId: string;
  isTailored: boolean;
  fileName: string;
  downloadUrl: string;
}
export const FileTokenParamsSchema = z.object({ signedToken: z.string().min(16).max(1024) });

/** POST /ext/site-requests (device) — 10/day. */
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

export const EXTENSION_ERROR_CODES = {
  deviceRevoked: 'device_revoked',
  pairCodeInvalid: 'pair_code_invalid',
  protectedQuestion: 'protected_question',
} as const;
