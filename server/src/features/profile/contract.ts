// server/src/features/profile/contract.ts
//
// The candidate profile (ARCHITECTURE.md §2.7, §3.3; TASK_PLAN.md WP-19).
// Mount: /api/v1/roboapply/profile. The profile is not the resume: a resume
// can PROPOSE profile changes (sync-from-resume diff), never apply them
// silently. Sensitive answers (EEO on RoboApply, CN sensitive fields on
// GoApply) are encrypted at rest, returned only to the owner and never
// placed in an LLM prompt (`profileSnapshotForLlm()` is the only context builder).

import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Text = (max = 200) => z.string().trim().max(max);
const IsoDate = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, 'YYYY-MM or YYYY-MM-DD');

// ── Documented JSON columns (ra-profile.prisma) ──────────────────────────

/** `RAProfile.links` */
export const ProfileLinksSchema = z
  .object({
    linkedin: z.string().url().max(300).optional(),
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
  })
  .strict();

// ── GET /profile, PATCH /profile ─────────────────────────────────────────

export const ProfilePatchSchema = z
  .object({
    firstName: Text(80).optional(),
    middleName: Text(80).optional(),
    lastName: Text(80).optional(),
    headline: Text(160).optional(),
    contactEmail: z.string().email().max(254).optional(),
    phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
    phoneType: z.enum(['mobile', 'home', 'work', 'other']).optional(),
    addressLine1: Text(200).optional(),
    city: Text(120).optional(),
    region: Text(120).optional(),
    postalCode: Text(20).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    links: ProfileLinksSchema.optional(),
    summary: Text(4000).optional(),
    languages: z.array(ProfileLanguageSchema).max(20).optional(),
    workAuth: z.array(WorkAuthEntrySchema).max(20).optional(),
    /** GoApply fields (validated by WP-19 against onboarding-cn's CnProfileFieldsSchema). */
    cnFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface ProfileEducationView {
  id: string;
  school: string;
  degree: string | null;
  major: string | null;
  gpa: string | null;
  startDate: string | null;
  endDate: string | null;
}
export interface ProfileExperienceView {
  id: string;
  company: string;
  title: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  description: string | null;
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
  education: ProfileEducationView[];
  experience: ProfileExperienceView[];
  /** 0–100 */
  completeness: number;
  /** Required autofill fields still missing: `[{ key, label }]` (label is an i18n key). */
  missing: Array<{ key: string; label: string }>;
  updatedAt: string;
}

// ── Education / experience rows ──────────────────────────────────────────

export const EducationBodySchema = z
  .object({
    school: Text(160).min(1),
    degree: Text(120).optional(),
    major: Text(120).optional(),
    gpa: Text(20).optional(),
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
  })
  .strict();
export const EducationPatchSchema = EducationBodySchema.partial();

export const ExperienceBodySchema = z
  .object({
    company: Text(160).min(1),
    title: Text(160).min(1),
    location: Text(160).optional(),
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
    current: z.boolean().optional(),
    description: Text(8000).optional(),
  })
  .strict();
export const ExperiencePatchSchema = ExperienceBodySchema.partial();

export const RowParamsSchema = z.object({ id: Id });

/** PUT /profile/skills */
export const PutSkillsBodySchema = z.object({ skills: z.array(ProfileSkillSchema).max(200) }).strict();

// ── Sensitive answers (owner only; encrypted at rest) ────────────────────

/** RoboApply EEO answers (US targets only, optional, flag `eeoAnswers`); GoApply optional 籍贯/政治面貌/photo. Never used for matching. */
export const SensitiveAnswersSchema = z
  .object({
    eeo: z
      .object({
        gender: Text(60).optional(),
        raceEthnicity: Text(120).optional(),
        veteranStatus: Text(120).optional(),
        disabilityStatus: Text(120).optional(),
      })
      .strict()
      .optional(),
    cn: z
      .object({
        nativePlace: Text(60).optional(),
        politicalStatus: Text(60).optional(),
        photoAssetId: Id.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SensitiveAnswers = z.infer<typeof SensitiveAnswersSchema>;

// ── Sync from resume (preview, then apply chosen fields) ─────────────────

export const SyncFromResumeBodySchema = z.object({ variantId: Id }).strict();
export const SyncFromResumeApplyBodySchema = z.object({ variantId: Id, accept: z.array(z.string().max(120)).min(1).max(200) }).strict();
export interface ProfileFieldDiff {
  /** Dotted path, e.g. `experience[2].title` or `skills`. */
  path: string;
  current: unknown;
  proposed: unknown;
  kind: 'add' | 'change' | 'remove';
}
export interface SyncFromResumeResponse {
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
} as const;
