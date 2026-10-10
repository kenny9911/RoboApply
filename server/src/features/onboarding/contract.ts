// server/src/features/onboarding/contract.ts
//
// Wire contract of the onboarding stage machine (TASK_PLAN.md R-06;
// PRODUCT_PLAN.md §4.1–§4.5; ARCHITECTURE.md §2.15, §3.3).
//
// FND-5 owns the canonical pieces of this file and WP-30 may only EXTEND
// them (new step body schemas, new answer keys), never redefine them:
//   - the stage codes per brand and their order,
//   - ONBOARDING_STAGE_ROUTES (stage → route),
//   - the `/auth/me.onboarding` shape (OnboardingMe), read by WP-10's sign-in
//     routing and by AuthGate.
//
// Storage: `SeekerProfile.onboardingStep` (stage code, defaults to 'done' so
// db push never sends existing users back), `onboardingAnswers` (per-step
// answers keyed by stage code), `onboardingPath` (branch), `onboardingEntry`
// (entry attribution). GoApply step bodies are validated by
// `features/onboarding-cn` (WP-31) through its index.ts seam.

import { z } from 'zod';
import type { BrandId } from '../../platform/brand/registry.js';

// ── Stage codes ────────────────────────────────────────────────────────────

/** RoboApply (PRODUCT §4.2). `goal` and `preferences` only on branch `explore`. */
export const ROBOAPPLY_ONBOARDING_STAGES = [
  'account',
  'situation',
  'basics',
  'goal',
  'preferences',
  'resume',
  'matching',
  'confirm',
  'tour',
  'done',
] as const;

/** GoApply (PRODUCT §4.4). */
export const GOAPPLY_ONBOARDING_STAGES = [
  'account',
  'consent',
  'identity',
  'education',
  'intent',
  'tags',
  'resume',
  'matching',
  'confirm',
  'tour',
  'done',
] as const;

export type RoboApplyOnboardingStage = (typeof ROBOAPPLY_ONBOARDING_STAGES)[number];
export type GoApplyOnboardingStage = (typeof GOAPPLY_ONBOARDING_STAGES)[number];
export type OnboardingStage = RoboApplyOnboardingStage | GoApplyOnboardingStage;

export const ONBOARDING_STAGES: Readonly<Record<BrandId, readonly OnboardingStage[]>> = {
  roboapply: ROBOAPPLY_ONBOARDING_STAGES,
  goapply: GOAPPLY_ONBOARDING_STAGES,
};

/** Every stage code of either brand (for params validation). */
export const ALL_ONBOARDING_STAGES = [
  ...new Set<OnboardingStage>([...ROBOAPPLY_ONBOARDING_STAGES, ...GOAPPLY_ONBOARDING_STAGES]),
] as readonly OnboardingStage[];

export const OnboardingStageSchema = z.enum(ALL_ONBOARDING_STAGES as [OnboardingStage, ...OnboardingStage[]]);

/** Sort order (PRODUCT §4.2/§4.4 "Order" column). */
export const ONBOARDING_STAGE_ORDER: Readonly<Record<OnboardingStage, number>> = {
  account: 10,
  consent: 15,
  situation: 20,
  identity: 20,
  education: 25,
  basics: 30,
  intent: 30,
  tags: 35,
  goal: 40,
  preferences: 50,
  resume: 60,
  matching: 70,
  confirm: 80,
  tour: 90,
  done: 100,
};

/** Branch (`SeekerProfile.onboardingPath`): urgent = timing "As soon as possible". */
export const ONBOARDING_BRANCHES = ['urgent', 'explore'] as const;
export type OnboardingBranch = (typeof ONBOARDING_BRANCHES)[number];

/** Stages shown only on a branch (RoboApply). */
export const BRANCH_ONLY_STAGES: Readonly<Partial<Record<OnboardingStage, OnboardingBranch>>> = {
  goal: 'explore',
  preferences: 'explore',
};

/** Stages without Skip (PRODUCT §4.1: the intl situation step and the cn identity step), plus the non-step stages. */
export const UNSKIPPABLE_STAGES: readonly OnboardingStage[] = ['account', 'situation', 'consent', 'identity', 'matching', 'done'];

// ── Stage → route (canonical; WP-30 may extend, never change) ─────────────

/**
 * Where each stage lives. `account` is the signup page; `tour` is the
 * first-value screen (RoboApply `/jobs`; GoApply `/campus` with the R-14
 * fallback applied by `firstValueRoute`); `done` has no route (the landing
 * is decided by `landingRoute`).
 */
export const ONBOARDING_STAGE_ROUTES: Readonly<Record<BrandId, Readonly<Record<string, string | null>>>> = {
  roboapply: {
    account: '/signup',
    situation: '/onboarding/situation',
    basics: '/onboarding/basics',
    goal: '/onboarding/goal',
    preferences: '/onboarding/preferences',
    resume: '/onboarding/resume',
    matching: '/onboarding/matching',
    confirm: '/onboarding/confirm',
    tour: '/jobs',
    done: null,
  },
  goapply: {
    account: '/signup',
    consent: '/onboarding/consent',
    identity: '/onboarding/identity',
    education: '/onboarding/education',
    intent: '/onboarding/intent',
    tags: '/onboarding/tags',
    resume: '/onboarding/resume',
    matching: '/onboarding/matching',
    confirm: '/onboarding/confirm',
    tour: '/campus',
    done: null,
  },
};

export function isStageOfBrand(brand: BrandId, stage: string): stage is OnboardingStage {
  return (ONBOARDING_STAGES[brand] as readonly string[]).includes(stage);
}

/** Whether a stage is shown for this brand and branch (goal/preferences only on `explore`). */
export function isStageShown(brand: BrandId, stage: OnboardingStage, branch: OnboardingBranch | null | undefined): boolean {
  if (!isStageOfBrand(brand, stage)) return false;
  const only = BRANCH_ONLY_STAGES[stage];
  if (!only || brand !== 'roboapply') return true;
  return branch === only;
}

/** The stage after `stage` for this brand and branch (skips branch-only stages). `done` stays `done`. */
export function nextStage(brand: BrandId, stage: OnboardingStage, branch: OnboardingBranch | null | undefined): OnboardingStage {
  const stages = ONBOARDING_STAGES[brand];
  const at = stages.indexOf(stage);
  if (at < 0) return 'done';
  for (let i = at + 1; i < stages.length; i++) {
    if (isStageShown(brand, stages[i], branch)) return stages[i];
  }
  return 'done';
}

/** What the first-value screen may use (R-14: GoApply `/campus` → `/jobs` → `/resume`). */
export interface FirstValueContext {
  /** `jobs.campusCalendar` capability. */
  campusCalendar?: boolean;
  /** `jobs.feed` capability. */
  jobsFeed?: boolean;
  /** GoApply 社招 users land on `/jobs` (PRODUCT G7). */
  cnIdentity?: 'yingjie' | 'zaixiao' | 'shezhao' | null;
}

/** First-value route (stage `tour`). RoboApply is always `/jobs`. */
export function firstValueRoute(brand: BrandId, ctx: FirstValueContext = {}): string {
  if (brand === 'roboapply') return '/jobs';
  const campus = ctx.campusCalendar === true;
  const feed = ctx.jobsFeed === true;
  if (ctx.cnIdentity === 'shezhao' && feed) return '/jobs';
  if (campus) return '/campus';
  if (feed) return '/jobs';
  return '/resume';
}

/** Route for a stage; `tour` resolves through `firstValueRoute`, `done` → null. */
export function routeForStage(brand: BrandId, stage: string, ctx: FirstValueContext = {}): string | null {
  if (!isStageOfBrand(brand, stage)) return null;
  if (stage === 'tour') return firstValueRoute(brand, ctx);
  return ONBOARDING_STAGE_ROUTES[brand][stage] ?? null;
}

/** Landing at the end (PRODUCT §4.1): the carried job, else the first-value route. */
export function landingRoute(brand: BrandId, entry: { jobId?: string | null } | null | undefined, ctx: FirstValueContext = {}): string {
  if (entry?.jobId) return `/jobs/${encodeURIComponent(entry.jobId)}`;
  return firstValueRoute(brand, ctx);
}

// ── /auth/me.onboarding (canonical) ───────────────────────────────────────

/**
 * `GET /auth/me` → `onboarding` (ARCH §2.15, R-06). WP-10 builds it with
 * `buildOnboardingMe`; sign-in routing sends the user to `nextRoute` only on
 * sign-in, never on every page view.
 *   - `step`: the stored stage code (unknown values read as 'done').
 *   - `path`: the branch (`urgent | explore`), null when not chosen or on GoApply.
 *   - `completed`: step === 'done'.
 *   - `nextRoute`: where the stage lives; null when completed.
 */
export const OnboardingMeSchema = z.object({
  step: OnboardingStageSchema,
  path: z.enum(ONBOARDING_BRANCHES).nullable(),
  completed: z.boolean(),
  nextRoute: z.string().nullable(),
});
export type OnboardingMe = z.infer<typeof OnboardingMeSchema>;

/** Pure builder for `/auth/me.onboarding` from the SeekerProfile columns. */
export function buildOnboardingMe(
  brand: BrandId,
  profile: { onboardingStep?: string | null; onboardingPath?: string | null } | null | undefined,
  ctx: FirstValueContext = {},
): OnboardingMe {
  const raw = profile?.onboardingStep ?? 'done';
  const step: OnboardingStage = isStageOfBrand(brand, raw) ? raw : 'done';
  const path = (ONBOARDING_BRANCHES as readonly string[]).includes(profile?.onboardingPath ?? '')
    ? (profile!.onboardingPath as OnboardingBranch)
    : null;
  const completed = step === 'done';
  return { step, path: brand === 'roboapply' ? path : null, completed, nextRoute: completed ? null : routeForStage(brand, step, ctx) };
}

// ── Entry attribution (SeekerProfile.onboardingEntry, F-ONB-02) ──────────

export const OnboardingEntrySchema = z
  .object({
    from: z.string().max(80).optional(),
    jobId: z.string().max(64).optional(),
    action: z.enum(['apply']).optional(),
    ref: z.string().max(64).optional(),
    inviteCode: z.string().max(64).optional(),
    utmSource: z.string().max(120).optional(),
    utmMedium: z.string().max(120).optional(),
    utmCampaign: z.string().max(120).optional(),
    alert: z.string().max(200).optional(),
  })
  .strict();
export type OnboardingEntry = z.infer<typeof OnboardingEntrySchema>;

// ── Step bodies: RoboApply (PRODUCT §4.3; GoApply bodies live in onboarding-cn) ──

export const ONBOARDING_TIMINGS = ['asap', 'next_few_months', 'just_looking'] as const;
export const SEEKER_TYPES = ['student', 'recent_graduate', 'experienced', 'career_change'] as const;
export const CAREER_GOALS = [
  'more_senior',
  'management',
  'higher_pay',
  'new_industry',
  'different_role',
  'learn_skills',
  'work_life_balance',
  'job_security',
  'flexibility',
] as const;
export const ONBOARDING_JOB_TYPES = ['full_time', 'part_time', 'contract', 'internship'] as const;
export const ONBOARDING_WORK_MODELS = ['remote', 'hybrid', 'onsite'] as const;
export const ONBOARDING_COMPANY_SIZES = ['1-50', '51-200', '201-1000', '1001-10000', '10000+', 'any'] as const;
export const ONBOARDING_EXPERIENCE_LEVELS = ['internship', 'entry', 'mid', 'senior', 'lead_staff', 'director_plus'] as const;
export const ALERT_FREQUENCIES = ['daily', 'weekly', 'off'] as const;
export const HEARD_FROM_OPTIONS = [
  'search_engine',
  'linkedin',
  'instagram',
  'tiktok',
  'youtube',
  'reddit',
  'friend',
  'ai_assistant',
  'school',
  'other',
] as const;
export const SPONSORSHIP_ANSWERS = ['yes', 'no', 'not_sure'] as const;

const Country = z.string().regex(/^([A-Z]{2}|REMOTE)$/, 'ISO 3166-1 alpha-2 (or REMOTE)');

/** O1 situation: no Skip; branch derives from timing (asap → urgent). */
export const SituationStepSchema = z
  .object({ timing: z.enum(ONBOARDING_TIMINGS), seekerType: z.enum(SEEKER_TYPES) })
  .strict();

/** O2 basics. `jobFunctions` are taxonomy ids or custom titles (1–3). */
export const BasicsStepSchema = z
  .object({
    jobFunctions: z
      .array(z.object({ taxonomyId: z.string().max(80).optional(), label: z.string().trim().min(1).max(120) }).strict())
      .min(1)
      .max(3),
    jobTypes: z.array(z.enum(ONBOARDING_JOB_TYPES)).min(1).max(4),
    countries: z.array(Country).min(1).max(17),
    locations: z
      .array(z.object({ country: Country, city: z.string().trim().min(1).max(120).optional(), label: z.string().max(160) }).strict())
      .max(5)
      .optional(),
    remoteOk: z.boolean().optional(),
    needsSponsorship: z.record(z.string(), z.enum(SPONSORSHIP_ANSWERS)).optional(),
  })
  .strict();

/** O3 goal (explore only). */
export const GoalStepSchema = z.object({ goal: z.enum(CAREER_GOALS) }).strict();

/** O4 nice-to-have (explore only). All optional. No funding/stage field (D3). */
export const PreferencesStepSchema = z
  .object({
    industries: z.array(z.string().max(80)).max(5).optional(),
    skills: z.array(z.string().trim().min(1).max(60)).max(15).optional(),
    companySizes: z.array(z.enum(ONBOARDING_COMPANY_SIZES)).max(6).optional(),
    minPay: z
      .object({ amount: z.number().positive(), currency: z.string().regex(/^[A-Z]{3}$/), period: z.enum(['year', 'month', 'hour']) })
      .strict()
      .optional(),
    workModels: z.array(z.enum(ONBOARDING_WORK_MODELS)).max(3).optional(),
  })
  .strict();

/** O5 resume: a variant id, or skip ("use my answers only"). */
export const ResumeStepSchema = z
  .object({ resumeVariantId: z.string().min(1).max(64).optional(), skip: z.boolean().optional() })
  .strict();

/** O7 confirm (also accepted by POST /onboarding/confirm). */
export const ConfirmStepSchema = z
  .object({
    experienceLevels: z.array(z.enum(ONBOARDING_EXPERIENCE_LEVELS)).min(1).max(6),
    extraFunctions: z.array(z.string().max(80)).max(3).optional(),
    linkedinUrl: z
      .string()
      .regex(/^https:\/\/(www\.)?linkedin\.com\/in\/[^\s/]+\/?$/, 'Use your LinkedIn profile URL (https://www.linkedin.com/in/…).')
      .optional(),
    alertFrequency: z.enum(ALERT_FREQUENCIES).optional(),
    heardFrom: z.enum(HEARD_FROM_OPTIONS).optional(),
    heardFromNote: z.string().max(200).optional(),
  })
  .strict();

/** Per-step body schemas for RoboApply (WP-30 may add, never change). */
export const ROBOAPPLY_STEP_BODY_SCHEMAS = {
  situation: SituationStepSchema,
  basics: BasicsStepSchema,
  goal: GoalStepSchema,
  preferences: PreferencesStepSchema,
  resume: ResumeStepSchema,
  confirm: ConfirmStepSchema,
} as const;

/** `SeekerProfile.onboardingAnswers`: answers keyed by stage code (GoApply keys come from onboarding-cn). */
export type OnboardingAnswers = Partial<{
  situation: z.infer<typeof SituationStepSchema>;
  basics: z.infer<typeof BasicsStepSchema>;
  goal: z.infer<typeof GoalStepSchema>;
  preferences: z.infer<typeof PreferencesStepSchema>;
  resume: z.infer<typeof ResumeStepSchema>;
  confirm: z.infer<typeof ConfirmStepSchema>;
}> &
  Record<string, unknown>;

// ── Endpoints (ARCH §3.3 with R-06) ───────────────────────────────────────

/** PUT /onboarding/steps/:step */
export const StepParamsSchema = z.object({ step: OnboardingStageSchema });
/** Body is validated per step by the service (ROBOAPPLY_STEP_BODY_SCHEMAS or onboarding-cn); the route only requires an object. */
export const StepBodySchema = z.record(z.string(), z.unknown());
export interface StepResponse {
  stage: OnboardingStage;
  nextStage: OnboardingStage;
  nextRoute: string | null;
}

/** GET /onboarding/state */
export interface OnboardingStateResponse {
  stage: OnboardingStage;
  nextRoute: string | null;
  branch: OnboardingBranch | null;
  answers: OnboardingAnswers;
  entry: OnboardingEntry | null;
}

/** GET /onboarding/title-suggest?q= (≥2 chars; 60/min). */
export const TitleSuggestQuerySchema = z.object({ q: z.string().trim().min(2).max(80), locale: z.string().max(8).optional() });
export interface TitleSuggestion {
  taxonomyId: string;
  label: string;
  level: 1 | 2 | 3;
  /** A level-1 title: "This is broad. Pick a more specific title…". */
  tooGeneral: boolean;
}

/** GET /onboarding/market-snapshot?taxonomyId&country (6 h cache; counts public canonical live rows of the brand's market only). */
export const MarketSnapshotQuerySchema = z.object({
  taxonomyId: z.string().min(1).max(80),
  country: z.string().regex(/^[A-Z]{2}$/),
  city: z.string().max(120).optional(),
});
/** D3: every number is `Sourced`; pay only with ≥ MIN_SAMPLE pay-listing rows in one currency and period. */
export interface MarketSnapshotResponse {
  /** N open roles in the window (always shown when ≥1). */
  jobCount: SourcedNumber;
  windowDays: number;
  /** "Pay listed on {X} of {N} posts" — null below MIN_SAMPLE. */
  pay: {
    listedCount: number;
    sampleSize: number;
    currency: string;
    period: 'year' | 'month' | 'hour';
    low: number;
    high: number;
    source: 'index';
    asOf: string;
  } | null;
  /** Top skills — empty below MIN_SAMPLE. */
  topSkills: Array<{ value: string; count: number; sampleSize: number; source: 'index'; asOf: string }>;
}
export interface SourcedNumber {
  value: number;
  source: 'index';
  sampleSize?: number;
  asOf: string;
}

/** POST /onboarding/resume */
export const OnboardingResumeBodySchema = z.object({ resumeVariantId: z.string().min(1).max(64) }).strict();
export interface OnboardingResumeResponse {
  suggestedSeniority: Array<(typeof ONBOARDING_EXPERIENCE_LEVELS)[number]>;
  suggestedTaxonomyIds: string[];
  suggestedSkills: string[];
  profileDraft: Record<string, unknown>;
}

/** POST /onboarding/match — SSE; each phase is emitted only after its server step finished. */
export const ONBOARDING_MATCH_PHASES = ['reading', 'saving', 'searching', 'comparing', 'ranking'] as const;
export type OnboardingMatchPhase = (typeof ONBOARDING_MATCH_PHASES)[number];
export type OnboardingMatchEvent =
  | { event: 'phase'; data: { phase: OnboardingMatchPhase; skipped?: boolean } }
  | { event: 'done'; data: { jobCount: number; topJobIds: string[]; continuedInBackground: boolean } }
  | { event: 'error'; data: { code: string; message: string } };

/** POST /onboarding/confirm */
export const OnboardingConfirmBodySchema = ConfirmStepSchema;

/** POST /onboarding/complete | /onboarding/skip */
export interface OnboardingStageResponse {
  stage: OnboardingStage;
  nextRoute: string | null;
}

export const ONBOARDING_ERROR_CODES = {
  /** The step does not exist for this brand or branch. */
  stepNotAvailable: 'onboarding_step_not_available',
  /** The step cannot be skipped. */
  stepRequired: 'onboarding_step_required',
} as const;

// ── WP-30 extensions (additive; nothing above is changed) ─────────────────
//
// The views below EXTEND the FND-5 response types: every field FND declared is
// still there with the same meaning; WP-30 adds what the screens need.

/** O2 country picker (PRODUCT §4.3 MVP set) plus "Remote anywhere". */
export const ONBOARDING_MVP_COUNTRIES = [
  'US',
  'CA',
  'GB',
  'IE',
  'AU',
  'NZ',
  'SG',
  'HK',
  'TW',
  'JP',
  'KR',
  'DE',
  'FR',
  'ES',
  'PT',
  'NL',
  'REMOTE',
] as const;
export type OnboardingCountry = (typeof ONBOARDING_MVP_COUNTRIES)[number];

/** O4 industries: the closed 19-item list the legacy preferences already store (labels are stored as-is; the UI localizes by slug). */
export const ONBOARDING_INDUSTRIES = [
  { id: 'Healthtech', slug: 'healthtech' },
  { id: 'Climate', slug: 'climate' },
  { id: 'Fintech', slug: 'fintech' },
  { id: 'Edtech', slug: 'edtech' },
  { id: 'Developer tools', slug: 'developer_tools' },
  { id: 'AI / ML', slug: 'ai_ml' },
  { id: 'B2B SaaS', slug: 'b2b_saas' },
  { id: 'Consumer', slug: 'consumer' },
  { id: 'E-commerce', slug: 'ecommerce' },
  { id: 'Marketplaces', slug: 'marketplaces' },
  { id: 'Logistics', slug: 'logistics' },
  { id: 'Manufacturing', slug: 'manufacturing' },
  { id: 'Cybersecurity', slug: 'cybersecurity' },
  { id: 'Media', slug: 'media' },
  { id: 'Gaming', slug: 'gaming' },
  { id: 'Hardware', slug: 'hardware' },
  { id: 'Bio / Pharma', slug: 'bio_pharma' },
  { id: 'Real estate', slug: 'real_estate' },
  { id: 'Legal-tech', slug: 'legal_tech' },
] as const;

/** O6 timing (PRODUCT §4.3): target p50 and the hard cap after which the rest is queued as `onboarding.match`. */
export const ONBOARDING_MATCH_TARGET_MS = 45_000;
export const ONBOARDING_MATCH_HARD_CAP_MS = 120_000;
/** O6: how many top candidates get an AI fit analysis (queued `job.score`). */
export const ONBOARDING_MATCH_AI_TOP_N = 20;
/** O5: resumes a user may add through onboarding per day (persisted, `RARateCounter`). */
export const ONBOARDING_RESUME_UPLOADS_PER_DAY = 10;
/** POST /onboarding/match runs per user per hour (each run ingests and may queue AI scoring). */
export const ONBOARDING_MATCH_RUNS_PER_HOUR = 5;
/** Stages at which POST /onboarding/match may run (the O6 screen, or a deliberate re-run from O7 / the tour). */
export const ONBOARDING_MATCH_STAGES = ['matching', 'confirm', 'tour'] as const;
/** O5 upload limit (the existing upload route's limit). */
export const ONBOARDING_RESUME_MAX_BYTES = 15 * 1024 * 1024;
/** O5 paste door: minimum characters. */
export const ONBOARDING_PASTE_MIN_CHARS = 200;

/** UI-state keys (RAUserUiState) the onboarding screens use. */
export const ONBOARDING_UI_KEYS = {
  /** O8 overlay seen. */
  tour: 'jobs.firstVisit',
  /** "Finish setting up — {n} steps left" banner; demoted to Settings after 2 dismissals. */
  finishBanner: 'onboarding.finishBanner',
  /** O8 inline prompts (each shown once). */
  scoreTip: 'onboarding.scoreTip',
  resumeCheckBanner: 'onboarding.resumeCheckBanner',
  skillsCheck: 'onboarding.skillsCheck',
} as const;
/** Dismissals after which the finish banner becomes a line in Settings. */
export const FINISH_BANNER_MAX_DISMISSALS = 2;

/** `onboardingAnswers.matching`: what O6 found (O7 reads it). */
export interface OnboardingMatchResult {
  /** Ranked jobs at Good fit or better (pre-score tiers until the AI scores land). */
  jobCount: number;
  /** Candidates compared. */
  compared: number;
  topJobIds: string[];
  /** True while the remaining work runs as an `onboarding.match` queue item. */
  continuedInBackground: boolean;
  finishedAt: string;
}

/** `onboardingAnswers.resumeSuggestions`: what POST /onboarding/resume suggested (O7 chips). */
export type OnboardingResumeSuggestions = OnboardingResumeResponse & { resumeVariantId: string };

/** `onboardingAnswers.leftEarly`: the user closed onboarding after the account step (PRODUCT §4.1 "Leaving early"). */
export interface OnboardingLeftEarly {
  at: string;
  /** The stage they left at; the finish banner links back to it. */
  stage: OnboardingStage;
}

/** Steps the user skipped (`onboardingAnswers.skipped`). */
export type OnboardingSkipped = OnboardingStage[];

export interface OnboardingProgress {
  /** Screens shown for this brand and branch (account/tour/done excluded). */
  total: number;
  /** Screens from the current (or left-at) stage to `confirm`, inclusive. 0 when finished. */
  stepsLeft: number;
  /** Set while the user has left onboarding early and not finished it. */
  leftEarly: OnboardingLeftEarly | null;
}

/** GET /onboarding/state (extends FND's OnboardingStateResponse). */
export interface OnboardingStateView extends OnboardingStateResponse {
  brand: BrandId;
  completed: boolean;
  progress: OnboardingProgress;
  /** Prefill the server knows from the request (never a guess about the person). */
  defaults: {
    /** From the visitor's country header or locale, when it is one of the MVP countries. */
    country: OnboardingCountry | null;
  };
}

/** GET /onboarding/title-suggest (extends FND's TitleSuggestion). */
export interface TitleSuggestionView extends TitleSuggestion {
  /** "Role group · Category" for roles; null for categories. */
  context: string | null;
  /** For a broad (level-1) title: more specific titles to offer as chips. */
  children: Array<{ taxonomyId: string; label: string; level: 1 | 2 | 3 }>;
}

/** PUT /onboarding/steps/:step: `skip: true` keeps whatever was entered (validated leniently) and marks the step skipped. */
export const STEP_SKIP_FLAG = 'skip' as const;

/** WP-30 error codes (added to the FND set). */
export const ONBOARDING_EXTRA_ERROR_CODES = {
  /** The resume variant does not exist or is not the user's. */
  resumeNotFound: 'onboarding_resume_not_found',
  /** The resume has no readable text. */
  resumeUnusable: 'onboarding_resume_unusable',
  /** The daily onboarding resume limit is spent. */
  resumeDailyLimit: 'onboarding_resume_daily_limit',
  /** POST /complete before the tour. */
  notFinished: 'onboarding_not_finished',
  /** POST /match outside the O6 stage (before the resume step, or after setup). */
  matchNotAvailable: 'onboarding_match_not_available',
} as const;
