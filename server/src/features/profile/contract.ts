// server/src/features/profile/contract.ts
//
// The candidate profile (ARCHITECTURE.md §2.7, §3.3; TASK_PLAN.md WP-19).
// Mount: /api/v1/roboapply/profile. The profile is not the resume: a resume
// can PROPOSE profile changes (sync-from-resume diff), never apply them
// silently. Sensitive answers (EEO on RoboApply, CN sensitive fields on
// GoApply) are encrypted at rest, returned only to the owner and never
// placed in an LLM prompt (`profileSnapshotForLlm()` is the only context builder).

import { z } from 'zod';

import { TW_WORK_PERMIT_STATUSES, TwProfileFieldsSchema, type TwProfileFields } from '../tw/index.js';

const Id = z.string().min(1).max(64);
const Text = (max = 200) => z.string().trim().max(max);
const IsoDate = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2])(-\d{2})?)?$/, 'YYYY, YYYY-MM or YYYY-MM-DD');

// ── Documented JSON columns (ra-profile.prisma) ──────────────────────────

/** True for a public LinkedIn profile URL (`https://www.linkedin.com/in/<handle>`, any country subdomain). */
export function isLinkedInProfileUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return false;
  return /^\/(in|pub)\/[^/]+\/?/.test(url.pathname);
}

/** `RAProfile.links`. F-NET-01: LinkedIn is optional, used for deep links and outreach drafts, never for ranking. */
export const ProfileLinksSchema = z
  .object({
    linkedin: z
      .string()
      .url()
      .max(300)
      .refine(isLinkedInProfileUrl, { message: 'Use your LinkedIn profile link, like https://www.linkedin.com/in/your-name' })
      .optional(),
    github: z.string().url().max(300).optional(),
    portfolio: z.string().url().max(300).optional(),
    website: z.string().url().max(300).optional(),
    x: z.string().url().max(300).optional(),
  })
  .strict();

/** `RAProfile.skills`: `[{ name, group?, level?, confirmed }]` */
export const ProfileSkillSchema = z
  .object({ name: Text(60).min(1), group: Text(60).optional(), level: z.enum(['beginner', 'intermediate', 'advanced', 'expert']).optional(), confirmed: z.boolean() })
  .strict();

/** `RAProfile.languages`: `[{ language, level }]` */
export const ProfileLanguageSchema = z
  .object({ language: Text(40).min(1), level: z.enum(['basic', 'conversational', 'professional', 'fluent', 'native']) })
  .strict();

/** `RAProfile.workAuth`: a question the user answers per target country (ruling C18). */
export const WorkAuthEntrySchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    authorized: z.boolean().nullable(),
    sponsorship: z.enum(['now', 'later', 'no']).nullable(),
    /** Taiwan only (TW-09): 工作許可 status. Ignored for other countries. */
    permit: z.enum(TW_WORK_PERMIT_STATUSES).nullable().optional(),
  })
  .strict();

/** One row per country. */
export const WorkAuthListSchema = z
  .array(WorkAuthEntrySchema)
  .max(20)
  .refine((rows) => new Set(rows.map((r) => r.country)).size === rows.length, { message: 'Each country only once.' });

// ── GET /profile, PATCH /profile ─────────────────────────────────────────

/** Upper bound on keys in one cnFields PATCH (the documented shape has 12). */
export const CN_FIELDS_MAX_KEYS = 20;
/** cnFields keys that are sensitive and must never be stored in the plaintext column. */
export const CN_FIELDS_REFUSED_KEYS = ['nativePlace', 'politicalStatus', 'familyMembers', 'photoAssetId', 'gender', 'birthDate'] as const;

export const ProfilePatchSchema = z
  .object({
    firstName: Text(80).optional(),
    middleName: Text(80).optional(),
    lastName: Text(80).optional(),
    headline: Text(160).optional(),
    /** `null` clears it (also for phoneE164, phoneType and country). */
    contactEmail: z.string().email().max(254).nullable().optional(),
    phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/).nullable().optional(),
    phoneType: z.enum(['mobile', 'home', 'work', 'other']).nullable().optional(),
    addressLine1: Text(200).optional(),
    city: Text(120).optional(),
    region: Text(120).optional(),
    postalCode: Text(20).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
    links: ProfileLinksSchema.optional(),
    summary: Text(4000).optional(),
    languages: z.array(ProfileLanguageSchema).max(20).optional(),
    workAuth: WorkAuthListSchema.optional(),
    /**
     * GoApply fields (GoApply only). Only the documented CnProfileFields keys are
     * kept (onboarding-cn's schema, unknown keys refused); `null` removes a key.
     * 籍贯 / 政治面貌 / 家庭成员 / photo / gender / birth date are refused here:
     * they live in the encrypted sensitive answers.
     */
    cnFields: z
      .record(z.string().max(40), z.unknown())
      .refine((o) => Object.keys(o).length <= CN_FIELDS_MAX_KEYS, { message: `At most ${CN_FIELDS_MAX_KEYS} fields.` })
      .optional(),
    /** RoboApply-Taiwan deltas (TW-04; RoboApply only). `null` clears them. */
    twFields: TwProfileFieldsSchema.nullable().optional(),
  })
  .strict();

/** Profile sections, in page order (PRODUCT O9 / F-ACCT-03). `basics` is GoApply's 基本信息. */
export const PROFILE_SECTIONS = ['personal', 'basics', 'education', 'work', 'skills', 'links', 'workAuth', 'taiwan', 'answers', 'eeo'] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** A required field (for filling application forms) that is still empty. `label` is an i18n key. */
export interface ProfileMissingField {
  key: string;
  label: string;
  section: ProfileSection;
}

/** What this profile can hold on this brand and deployment (drives which sections render). */
export interface ProfileAvailability {
  market: 'intl' | 'cn';
  /** The Taiwan deltas can be stored (RoboApply, and the column exists — SR-WP19-1). */
  twFields: boolean;
  /** Equal-opportunity answers (RoboApply, flag `eeoAnswers`). Shown only to people targeting the US. */
  eeo: boolean;
  /** GoApply optional 籍贯 / 政治面貌. */
  cnSensitive: boolean;
  /** GoApply photo: hidden in CN-0 (no original upload or photo is stored, WP-15 rule). */
  cnPhoto: boolean;
}

export interface ProfileEducationView {
  id: string;
  school: string;
  degree: string | null;
  major: string | null;
  gpa: string | null;
  /** 'YYYY-MM' */
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  location: string | null;
}
export interface ProfileExperienceView {
  id: string;
  company: string;
  title: string;
  location: string | null;
  /** 'YYYY-MM' */
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  description: string | null;
  bullets: string[];
  /** 'work' | 'internship' (GoApply lists 实习 separately) */
  kind: 'work' | 'internship';
  employmentType: string | null;
}
export interface ProfileView {
  userId: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  headline: string | null;
  contactEmail: string | null;
  phoneE164: string | null;
  phoneType: string | null;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  links: z.infer<typeof ProfileLinksSchema>;
  summary: string | null;
  skills: Array<z.infer<typeof ProfileSkillSchema>>;
  languages: Array<z.infer<typeof ProfileLanguageSchema>>;
  workAuth: Array<z.infer<typeof WorkAuthEntrySchema>>;
  cnFields: Record<string, unknown> | null;
  /** RoboApply-Taiwan deltas, or null. */
  twFields: TwProfileFields | null;
  education: ProfileEducationView[];
  experience: ProfileExperienceView[];
  /** 0–100 */
  completeness: number;
  /** Required autofill fields still missing (label is an i18n key). */
  missing: ProfileMissingField[];
  availability: ProfileAvailability;
  /** The resume this profile was last updated from (the user accepted the changes). */
  syncedFromVariantId: string | null;
  /** ISO time, or null when the profile was never saved. */
  updatedAt: string | null;
}

// ── Education / experience rows ──────────────────────────────────────────

export const EducationBodySchema = z
  .object({
    school: Text(160).min(1),
    degree: Text(120).optional(),
    major: Text(120).optional(),
    gpa: Text(20).optional(),
    /** `null` clears it. */
    startDate: IsoDate.nullable().optional(),
    endDate: IsoDate.nullable().optional(),
    current: z.boolean().optional(),
    location: Text(160).optional(),
  })
  .strict();
export const EducationPatchSchema = EducationBodySchema.partial();

export const ExperienceBodySchema = z
  .object({
    company: Text(160).min(1),
    title: Text(160).min(1),
    location: Text(160).optional(),
    /** `null` clears it. */
    startDate: IsoDate.nullable().optional(),
    endDate: IsoDate.nullable().optional(),
    current: z.boolean().optional(),
    description: Text(8000).optional(),
    bullets: z.array(Text(600).min(1)).max(30).optional(),
    kind: z.enum(['work', 'internship']).optional(),
    employmentType: Text(40).optional(),
  })
  .strict();
export const ExperiencePatchSchema = ExperienceBodySchema.partial();

export const RowParamsSchema = z.object({ id: Id });

/** PUT /profile/skills */
export const PutSkillsBodySchema = z.object({ skills: z.array(ProfileSkillSchema).max(200) }).strict();

// ── Sensitive answers (owner only; encrypted at rest) ────────────────────

/**
 * The answer codes the profile offers for US equal-opportunity questions (F-ACCT-04).
 * Every question has "I prefer not to say"; leaving a question blank is also fine.
 */
export const EEO_OPTIONS = {
  gender: ['female', 'male', 'non_binary', 'decline'],
  raceEthnicity: ['hispanic_latino', 'white', 'black', 'asian', 'native_american', 'pacific_islander', 'two_or_more', 'decline'],
  veteranStatus: ['protected_veteran', 'not_veteran', 'decline'],
  disabilityStatus: ['yes', 'no', 'decline'],
} as const;

/** RoboApply EEO answers (US targets only, optional, flag `eeoAnswers`); GoApply optional 籍贯/政治面貌/photo. Never used for matching. */
export const SensitiveAnswersSchema = z
  .object({
    eeo: z
      .object({
        gender: z.enum(EEO_OPTIONS.gender).optional(),
        raceEthnicity: z.enum(EEO_OPTIONS.raceEthnicity).optional(),
        veteranStatus: z.enum(EEO_OPTIONS.veteranStatus).optional(),
        disabilityStatus: z.enum(EEO_OPTIONS.disabilityStatus).optional(),
      })
      .strict()
      .optional(),
    cn: z
      .object({
        nativePlace: Text(60).optional(),
        politicalStatus: Text(60).optional(),
        photoAssetId: Id.optional(),
        /** 家庭成员 — some 网申 forms ask for it; optional, filled only by the user. */
        familyMembers: z
          .array(
            z
              .object({ relation: Text(30).min(1), name: Text(60).min(1), employer: Text(120).optional(), title: Text(80).optional() })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SensitiveAnswers = z.infer<typeof SensitiveAnswersSchema>;

/** GET/PUT /profile/sensitive response. Returned only to the owner. */
export interface SensitiveAnswersView {
  answers: SensitiveAnswers;
  /** False when the deployment has no encryption key: answers cannot be saved. */
  configured: boolean;
  availability: Pick<ProfileAvailability, 'market' | 'eeo' | 'cnSensitive' | 'cnPhoto'>;
  /** ISO time, or null when nothing is stored. */
  updatedAt: string | null;
  /**
   * True when answers are stored but cannot be read on this deployment (no key,
   * or a key that was rotated out). `answers` is then empty; saving or deleting
   * replaces the stored row.
   */
  unreadable: boolean;
}

// ── Sync from resume (preview, then apply chosen fields) ─────────────────

export const SyncFromResumeBodySchema = z.object({ variantId: Id }).strict();
export const SyncFromResumeApplyBodySchema = z.object({ variantId: Id, accept: z.array(z.string().max(120)).min(1).max(200) }).strict();
export interface ProfileFieldDiff {
  /**
   * Stable path, e.g. `firstName`, `links.linkedin`, `skills`, or a row key
   * `experience[3f9a01bc]` (a hash of company + title + start, so the key
   * survives other edits between preview and apply).
   */
  path: string;
  /** Section the change belongs to (for grouping the review). */
  section: ProfileSection;
  current: unknown;
  proposed: unknown;
  /** The resume never removes anything from the profile, so `remove` is not proposed today. */
  kind: 'add' | 'change' | 'remove';
}
export interface SyncFromResumeResponse {
  variantId: string;
  /** False when the resume has no structured content to compare (e.g. still being read). */
  parsed: boolean;
  diff: ProfileFieldDiff[];
}

/** The only profile view an LLM prompt may contain (no sensitive answers, EEO, photo, 籍贯, 政治面貌, gender, birth date, family). */
export interface ProfileSnapshotForLlm {
  text: string;
  /** Cache key: profile updatedAt + primary variant content hash. */
  cacheKey: string;
}

export const PROFILE_ERROR_CODES = {
  rowNotFound: 'profile_row_not_found',
  resumeNotFound: 'profile_resume_not_found',
  /** A change in `accept` is not in the current diff (the profile or resume changed). */
  staleDiff: 'profile_sync_stale',
  /** A field this brand or deployment does not hold (e.g. cnFields on RoboApply, a photo in CN-0). */
  fieldNotAvailable: 'profile_field_not_available',
  /** No SENSITIVE_DATA_KEY on this deployment. */
  sensitiveNotConfigured: 'profile_sensitive_not_configured',
} as const;
