// server/src/features/onboarding-cn/contract.ts
//
// GoApply onboarding step bodies G1–G5 (PRODUCT_PLAN.md §4.5; TASK_PLAN.md
// WP-31). No routes: WP-30's onboarding router dispatches GoApply steps to
// this area through `validateCnStep` in index.ts. WP-31 fills the
// validators (届别 range, K/月·N薪 parsing, school typeahead data) and may
// tighten these schemas; it must keep the field names.
//
// Honesty rules encoded here:
//   - No consent is pre-checked and 个性化推荐 has NO default: the body must
//     carry an explicit `true | false` before `下一步` (PIPL Art. 24).
//   - School tier is display and a user-side filter only, never a ranking input.
//   - 户口 / employer tags only label jobs whose official source supports them.

import { z } from 'zod';

/** G1 授权说明 — every value comes from an explicit user tap. */
export const CnConsentStepSchema = z
  .object({
    /** 用户协议 + 隐私政策 + 我已年满16周岁 (`age_16_plus`). Required. */
    agreement: z.literal(true),
    /** `pipl_cross_border` — required while DEPLOY_REGION != cn-mainland (CN-0); the service enforces it. */
    crossBorder: z.boolean().optional(),
    /** `ai_resume_parsing` — off until tapped. */
    aiProcessing: z.boolean(),
    /** `personalized_recommendation` — must be chosen (开启/关闭); no default. */
    personalizedRecommendation: z.boolean(),
    /** Marketing messages; off by default. */
    marketing: z.boolean().optional(),
    /** Prose version shown to the user (stored with each consent record). */
    proseVersion: z.string().min(1).max(40),
  })
  .strict();

export const CN_IDENTITIES = ['yingjie', 'zaixiao', 'shezhao'] as const;
export const CN_YEARS_EXPERIENCE = ['lt1', '1-3', '3-5', '5-10', '10+'] as const;
export const CN_JOB_SEARCH_STATUS = ['left_available', 'employed_within_month', 'employed_open', 'employed_not_looking'] as const;
export const CN_DEGREE_OPTIONS = ['dazhuan', 'bachelor', 'master', 'phd', 'other'] as const;
export const CN_WORK_TYPES = ['full_time', 'internship', 'part_time'] as const;
export const CN_INTERN_MONTHS = ['1-2', '3', '6+'] as const;
export const CN_START_DATES = ['anytime', 'within_month', 'date'] as const;
export const CN_EMPLOYER_TYPES = ['soe', 'foreign', 'big_private', 'startup', 'public_institution', 'any'] as const;

/** 届别 range accepted by the product (PRODUCT G2: 2025届 … 2030届). */
export const CN_CLASS_YEAR_RANGE = { min: 2025, max: 2030 } as const;

/** G2 你的身份. */
export const CnIdentityStepSchema = z
  .object({
    cnIdentity: z.enum(CN_IDENTITIES),
    graduationClass: z.number().int().min(CN_CLASS_YEAR_RANGE.min).max(CN_CLASS_YEAR_RANGE.max).optional(),
    graduationMonth: z.number().int().min(1).max(12).optional(),
    yearsExperience: z.enum(CN_YEARS_EXPERIENCE).optional(),
    jobSearchStatus: z.enum(CN_JOB_SEARCH_STATUS).optional(),
  })
  .strict();

/** G3 教育背景. */
export const CnEducationStepSchema = z
  .object({
    degree: z.enum(CN_DEGREE_OPTIONS).optional(),
    /** 统招 */
    fullTime: z.boolean().optional(),
    school: z.string().trim().min(1).max(120).optional(),
    /** Id from data/schools.json when picked from the typeahead (information only). */
    schoolId: z.string().max(40).optional(),
    major: z.string().trim().max(120).optional(),
    overseas: z.boolean().optional(),
    skip: z.boolean().optional(),
  })
  .strict();

/** G4 求职期望. Salary in K/月; `negotiable` = 面议. */
export const CnIntentStepSchema = z
  .object({
    targetRoles: z.array(z.object({ taxonomyId: z.string().max(80).optional(), label: z.string().trim().min(1).max(80) }).strict()).min(1).max(3),
    /** City names or region codes; `any` = 不限. */
    cities: z.array(z.string().trim().min(1).max(60)).min(1).max(5),
    industries: z.array(z.string().max(60)).max(3).optional(),
    workType: z.enum(CN_WORK_TYPES),
    salaryMonthlyK: z
      .object({ min: z.number().min(1).max(100), max: z.number().min(1).max(100) })
      .strict()
      .refine((v) => v.min <= v.max, { message: 'min must be ≤ max' })
      .or(z.literal('negotiable'))
      .optional(),
    salaryMonths: z.number().int().min(12).max(20).optional(),
    internDailyPay: z
      .object({ min: z.number().min(100).max(1000), max: z.number().min(100).max(1000) })
      .strict()
      .refine((v) => v.min <= v.max, { message: 'min must be ≤ max' })
      .or(z.literal('any'))
      .optional(),
    internDaysPerWeek: z.number().int().min(2).max(5).optional(),
    internMonths: z.enum(CN_INTERN_MONTHS).optional(),
    startDate: z.enum(CN_START_DATES).optional(),
    startDateValue: z.string().max(10).optional(),
    acceptReassignment: z.boolean().optional(),
  })
  .strict();

/** G5 更看重什么 (skippable). */
export const CnTagsStepSchema = z
  .object({
    employerTypes: z.array(z.enum(CN_EMPLOYER_TYPES)).max(6).optional(),
    wantsHukou: z.boolean().optional(),
    skip: z.boolean().optional(),
  })
  .strict();

export const GOAPPLY_STEP_BODY_SCHEMAS = {
  consent: CnConsentStepSchema,
  identity: CnIdentityStepSchema,
  education: CnEducationStepSchema,
  intent: CnIntentStepSchema,
  tags: CnTagsStepSchema,
} as const;

export type CnStep = keyof typeof GOAPPLY_STEP_BODY_SCHEMAS;

/**
 * `RAProfile.cnFields` (documented JSON column, ra-profile.prisma):
 * `{ identity, graduationClass, degree, isFullTimeProgram, schoolName, schoolTags,
 *    major, jobSearchStatus, internshipDaysPerWeek, internshipMonths, availableFrom,
 *    acceptReassignment }` — schoolTags are display/user-filter only.
 */
export const CnProfileFieldsSchema = z
  .object({
    identity: z.enum(CN_IDENTITIES).optional(),
    graduationClass: z.number().int().optional(),
    degree: z.enum(CN_DEGREE_OPTIONS).optional(),
    isFullTimeProgram: z.boolean().optional(),
    schoolName: z.string().optional(),
    schoolTags: z.array(z.string()).optional(),
    major: z.string().optional(),
    jobSearchStatus: z.enum(CN_JOB_SEARCH_STATUS).optional(),
    internshipDaysPerWeek: z.number().int().optional(),
    internshipMonths: z.enum(CN_INTERN_MONTHS).optional(),
    availableFrom: z.string().optional(),
    acceptReassignment: z.boolean().optional(),
  })
  .passthrough();
export type CnProfileFields = z.infer<typeof CnProfileFieldsSchema>;

export interface CnStepValidation {
  ok: boolean;
  /** Normalized answers to store under `onboardingAnswers[step]`. */
  answers?: Record<string, unknown>;
  issues?: Array<{ path: (string | number)[]; message: string }>;
}
