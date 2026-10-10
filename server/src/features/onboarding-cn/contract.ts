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

/**
 * `RAProfile.cnFields` (documented JSON column, ra-profile.prisma):
 * `{ identity, graduationClass, graduationMonth, yearsExperience, degree,
 *    isFullTimeProgram, schoolName, schoolId, schoolTags, overseasSchool, major,
 *    jobSearchStatus, internshipDaysPerWeek, internshipMonths, availableFrom,
 *    acceptReassignment }` — schoolTags are display/user-filter only.
 * WP-31 added graduationMonth, yearsExperience, schoolId and overseasSchool
 * (the profile service stores exactly these keys; WP-19 spreads this shape).
 */
export const CnProfileFieldsSchema = z
  .object({
    identity: z.enum(CN_IDENTITIES).optional(),
    graduationClass: z.number().int().optional(),
    graduationMonth: z.number().int().min(1).max(12).optional(),
    yearsExperience: z.enum(CN_YEARS_EXPERIENCE).optional(),
    degree: z.enum(CN_DEGREE_OPTIONS).optional(),
    isFullTimeProgram: z.boolean().optional(),
    schoolName: z.string().optional(),
    schoolId: z.string().max(40).optional(),
    schoolTags: z.array(z.string()).optional(),
    overseasSchool: z.boolean().optional(),
    major: z.string().optional(),
    jobSearchStatus: z.enum(CN_JOB_SEARCH_STATUS).optional(),
    internshipDaysPerWeek: z.number().int().optional(),
    internshipMonths: z.enum(CN_INTERN_MONTHS).optional(),
    availableFrom: z.string().optional(),
    acceptReassignment: z.boolean().optional(),
  })
  .passthrough();
export type CnProfileFields = z.infer<typeof CnProfileFieldsSchema>;

// ── Option grids (PRODUCT G4) ──────────────────────────────────────────────

/** 期望薪资 K/月: 1–30K in 1K steps, then 35–100K in 5K steps. */
export const CN_SALARY_K_OPTIONS: readonly number[] = [
  ...Array.from({ length: 30 }, (_, i) => i + 1),
  ...Array.from({ length: 14 }, (_, i) => 35 + i * 5),
];
/** ·N薪: 12–20. */
export const CN_SALARY_MONTHS_OPTIONS: readonly number[] = Array.from({ length: 9 }, (_, i) => 12 + i);
/** 实习 元/天: 100–1000 in 50-yuan steps. */
export const CN_INTERN_DAILY_OPTIONS: readonly number[] = Array.from({ length: 19 }, (_, i) => 100 + i * 50);
/** 实习 天/周. */
export const CN_INTERN_DAYS_OPTIONS = [2, 3, 4, 5] as const;
export const CN_MAX_ROLES = 3;
export const CN_MAX_CITIES = 5;
export const CN_MAX_INDUSTRIES = 3;
/** 期望城市 "不限". */
export const CN_ANY_CITY = 'any';

/** G7 "你从哪里知道我们" (optional). */
export const CN_HEARD_FROM = ['xiaohongshu', 'douyin', 'wechat', 'zhihu', 'bilibili', 'friend', 'school', 'other'] as const;

/** G7 确认 (PUT /onboarding/steps/confirm on GoApply): suggested extra roles and the optional source. */
export const CnConfirmStepSchema = z
  .object({
    extraRoles: z
      .array(z.object({ taxonomyId: z.string().max(80).optional(), label: z.string().trim().min(1).max(80) }).strict())
      .max(3)
      .optional(),
    heardFrom: z.enum(CN_HEARD_FROM).optional(),
    heardFromNote: z.string().trim().max(200).optional(),
  })
  .strict();

/** GoApply step bodies validated by this area (WP-30 dispatches `PUT /onboarding/steps/:step`). */
export const GOAPPLY_STEP_BODY_SCHEMAS = {
  consent: CnConsentStepSchema,
  identity: CnIdentityStepSchema,
  education: CnEducationStepSchema,
  intent: CnIntentStepSchema,
  tags: CnTagsStepSchema,
  confirm: CnConfirmStepSchema,
} as const;

export type CnStep = keyof typeof GOAPPLY_STEP_BODY_SCHEMAS;

export function isCnStep(step: string): step is CnStep {
  return Object.prototype.hasOwnProperty.call(GOAPPLY_STEP_BODY_SCHEMAS, step);
}

// ── Step results and their effects ─────────────────────────────────────────

/** A consent answer the consent step records (compliance `recordConsent`, with the prose version shown). */
export interface CnConsentEffect {
  type: 'pipl_basic_processing' | 'age_16_plus' | 'pipl_cross_border' | 'ai_resume_parsing' | 'personalized_recommendation' | 'marketing_email';
  granted: boolean;
}

/**
 * What saving a step changes besides `onboardingAnswers[step]` (applied by
 * `applyCnStep`): consent records, `RAProfile.cnFields` keys (`null` removes a
 * key) and a patch of the default search profile's filters (`null` clears).
 */
export interface CnStepEffects {
  consents: CnConsentEffect[];
  cnFields: Record<string, unknown> | null;
  filterPatch: Record<string, unknown> | null;
}

export interface CnStepValidation {
  ok: boolean;
  /** Normalized answers to store under `onboardingAnswers[step]`. */
  answers?: Record<string, unknown>;
  issues?: Array<{ path: (string | number)[]; message: string }>;
  /** Present when ok: what `applyCnStep` writes. */
  effects?: CnStepEffects;
}

/** What validation may read: earlier answers (G3/G4 depend on the G2 identity) and the env (CN-0). */
export interface CnStepContext {
  /** `SeekerProfile.onboardingAnswers` as stored (keyed by stage code). */
  answers?: Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
  now?: Date;
}

// ── Market snapshot (G4 "现在开放的机会") ───────────────────────────────────

const csv = (max: number, itemMax: number) =>
  z
    .string()
    .max(max * (itemMax + 1))
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(itemMax)).max(max));

/** GET …/onboarding/cn/market-snapshot?roles=&taxonomyIds=&cities=&class= */
export const CnMarketSnapshotQuerySchema = z.object({
  roles: csv(CN_MAX_ROLES, 80).optional(),
  taxonomyIds: csv(CN_MAX_ROLES, 80).optional(),
  cities: csv(CN_MAX_CITIES, 60).optional(),
  class: z.coerce.number().int().min(CN_CLASS_YEAR_RANGE.min).max(CN_CLASS_YEAR_RANGE.max).optional(),
});
export type CnMarketSnapshotQuery = z.output<typeof CnMarketSnapshotQuerySchema>;

/** A count from our own index (D3: source and as-of date; never estimated). */
export interface CnSourcedCount {
  value: number;
  source: 'index' | 'campus_calendar';
  asOf: string;
}

/**
 * Counts only public, canonical, live rows of the GoApply market (users'
 * imported jobs never count). Pay only with ≥ MIN_SAMPLE (20) postings that
 * list monthly CNY pay, shown as "Pay listed on {listedCount} of {jobCount}".
 */
export interface CnMarketSnapshotResponse {
  jobCount: CnSourcedCount;
  /** Published 校招 programmes whose 网申 window is open now. */
  campusOpenCount: CnSourcedCount;
  pay: {
    /** Median of each posting's stated monthly range midpoint, in yuan. */
    medianMonthly: number;
    /** Middle half of the same midpoints (25th–75th percentile), in yuan. */
    p25Monthly: number;
    p75Monthly: number;
    listedCount: number;
    sampleSize: number;
    currency: 'CNY';
    period: 'month';
    source: 'index';
    asOf: string;
  } | null;
  windowDays: number;
}

// ── Schools and places (data/*.json, each file states its source) ─────────

/**
 * Where a bundled data file comes from (D3). `verified` = checked against
 * the official publication, and `asOf` is then that publication's date; until
 * then `asOf` is null and the UI shows the coverage, never an "as of" date.
 * `compiledAt` is when the file was put together.
 */
export interface CnDataSource {
  name: string;
  asOf: string | null;
  verified: boolean;
  compiledAt: string;
  coverage: string;
}

export const CN_SCHOOL_TAGS = ['985', '211', 'double_first_class'] as const;
export type CnSchoolTag = (typeof CN_SCHOOL_TAGS)[number];

export interface CnSchool {
  id: string;
  name: string;
  province: string;
  /** Information only; never a ranking input. */
  tags: CnSchoolTag[];
  aliases?: string[];
}

/** GET …/onboarding/cn/schools?q= */
export const CnSchoolSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(40), limit: z.coerce.number().int().min(1).max(20).optional() });
export interface CnSchoolSearchResponse {
  items: CnSchool[];
  source: CnDataSource;
}

export interface CnProvince {
  code: string;
  name: string;
  type: 'municipality' | 'province' | 'autonomous_region' | 'sar';
  cities: string[];
  extra?: string[];
}
export interface CnProvincesResponse {
  items: CnProvince[];
  source: CnDataSource;
}

/** GB/T 4754-2017 国民经济行业分类, sections A–T (期望行业 options). */
export const CN_INDUSTRY_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'] as const;
export type CnIndustryCode = (typeof CN_INDUSTRY_CODES)[number];

/** How the feed may rank for this user (PIPL Art. 24; GoApply 个性化推荐). */
export type CnRankingMode = 'personalized' | 'non_personalized';

export const ONBOARDING_CN_ERROR_CODES = {
  /** The consent prose changed since the screen loaded. */
  proseOutdated: 'onboarding_cn_prose_outdated',
  /** A step body failed the GoApply rules. */
  invalidStep: 'onboarding_cn_invalid_step',
} as const;
