// server/src/features/prep/contract.ts
//
// Practice questions (question bank), contributions, moderation
// (ARCHITECTURE.md §2.12, §3.9; TASK_PLAN.md WP-59). Mounts:
// /api/v1/roboapply/interview-bank (seeker; capability `interviewBank` per
// route) and /api/v1/roboapply/admin/prep (moderation).
//
// Where a question came from (D3) — every item carries `sourceKind` and the
// UI renders its source line on every item:
//   user_report  a user shared it after their interview; moderated; the ONLY
//                kind that may name a company ("Shared by a %BRAND% user, {month year}")
//   ai_practice  written by AI from a job post; never attributed to a company
//                ("Written by AI from the job post — not reported by candidates")
//   curated      written by staff; generic, never attributed to a company
//                ("Written by %BRAND% staff — not reported by candidates")
// No scraped community reports. Moderation rejects verbatim assessment or
// test content under NDA or copyright.

import { z } from 'zod';
import type { Sourced } from '../../platform/http.js';

const Id = z.string().min(1).max(64);

export const QUESTION_SOURCE_KINDS = ['user_report', 'ai_practice', 'curated'] as const;
export type QuestionSourceKind = (typeof QUESTION_SOURCE_KINDS)[number];

/**
 * Question categories. `hr` is the GoApply HR-round set (HR面: motivation,
 * plans, salary expectations); the rest follow ARCH §2.12 plus
 * `role_specific` for non-engineering roles.
 */
export const QUESTION_CATEGORIES = ['behavioral', 'role_specific', 'coding', 'system_design', 'domain_design', 'hr'] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export const QUESTION_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

/** Languages a question (and so its shared guide) is stored in. */
export const QUESTION_LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] as const;
export type QuestionLocale = (typeof QUESTION_LOCALES)[number];

/** Message keys (under `practiceQuestions.source`) for each source line. */
export const SOURCE_LABEL_KEYS: Record<QuestionSourceKind, string> = {
  user_report: 'source.userReport',
  ai_practice: 'source.aiPractice',
  curated: 'source.curated',
};

// ── Limits (ARCH §3.9) ───────────────────────────────────────────────────

/** AI guide generations per user per day (the guide is generated on first view). */
export const GUIDE_GENERATIONS_PER_DAY = 30;
/** AI question sets written from a job post, per user per day. */
export const JOB_SET_GENERATIONS_PER_DAY = 10;
/** Contributions per user per day. */
export const CONTRIBUTIONS_PER_DAY = 10;
/** Reports per user per day. */
export const REPORTS_PER_DAY = 10;
/** Distinct user reports that hide a question until staff look at it. */
export const AUTO_HIDE_REPORTS = 3;
/** Questions in one AI set. */
export const JOB_SET_SIZE = 8;

// ── Seeker requests ──────────────────────────────────────────────────────

export const CompaniesQuerySchema = z.object({ q: z.string().trim().max(80).optional(), cursor: z.string().max(64).optional() });
export const CompanySlugParamsSchema = z.object({ slug: z.string().min(1).max(120) });
export const CompanyQuestionsQuerySchema = z.object({
  category: z.enum(QUESTION_CATEGORIES).optional(),
  seniority: z.string().max(40).optional(),
  cursor: z.string().max(64).optional(),
});
/** GET /interview-bank/questions — staff-written practice questions (generic). */
export const CuratedQuestionsQuerySchema = z.object({
  category: z.enum(QUESTION_CATEGORIES).optional(),
  cursor: z.string().max(64).optional(),
});
export const QuestionParamsSchema = z.object({ id: Id });
export const JobParamsSchema = z.object({ jobId: Id });

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.');

/** POST /interview-bank/contributions (moderated; 10/day). */
export const ContributionBodySchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    role: z.string().trim().max(120).optional(),
    question: z.string().trim().min(10).max(2000),
    category: z.enum(QUESTION_CATEGORIES).optional(),
    /** "YYYY-MM" the user was asked (required: it is the month on the source line). */
    period: YearMonth,
  })
  .strict();

export const QUESTION_REPORT_REASONS = ['wrong', 'duplicate', 'offensive', 'confidential', 'other'] as const;
export const ReportQuestionBodySchema = z.object({ reason: z.enum(QUESTION_REPORT_REASONS), note: z.string().trim().max(500).optional() }).strict();

// ── Views ────────────────────────────────────────────────────────────────

/** `RAInterviewQuestion.guide` (documented JSON column; AI-generated, labelled). */
export const QuestionGuideSchema = z
  .object({
    approach: z.string(),
    whatTheyTest: z.array(z.string()),
    commonMistakes: z.array(z.string()),
    rubric: z.array(z.string()),
    followUps: z.array(z.string()),
  })
  .partial()
  .passthrough();
export type QuestionGuide = z.infer<typeof QuestionGuideSchema>;

export interface QuestionView {
  id: string;
  /** Only user reports carry a company; null otherwise (never attributed). */
  companySlug: string | null;
  companyName: string | null;
  title: string;
  body: string;
  category: QuestionCategory;
  difficulty: QuestionDifficulty | null;
  seniority: string | null;
  locale: string;
  sourceKind: QuestionSourceKind;
  /** Message key under `practiceQuestions` for the source line (see SOURCE_LABEL_KEYS). */
  sourceLabelKey: string;
  /** 'YYYY-MM' the user was asked (user reports only). */
  reportedPeriod: string | null;
  /** True for AI-written questions (GoApply renders AiGeneratedBadge). */
  aiGenerated: boolean;
}

export type GuideStatus = 'ready' | 'not_generated' | 'limit_reached' | 'ai_unavailable';

export interface QuestionDetail extends QuestionView {
  /** AI guide, generated on first view (30/day), always labelled as AI. */
  guide: QuestionGuide | null;
  guideStatus: GuideStatus;
}

export interface QuestionListResponse {
  items: QuestionView[];
  cursor: string | null;
}

/** A company with moderated user reports. */
export interface PrepCompanyView {
  /** Route segment: the company record's slug, or the company name when there is no record. */
  slug: string;
  name: string;
  hasCompanyRecord: boolean;
  /** Count of moderated user reports (real rows; never estimated). */
  questionCount: Sourced<number>;
  /** Newest 'YYYY-MM' among them. */
  latestPeriod: string | null;
}

export interface CompaniesResponse {
  items: PrepCompanyView[];
  cursor: string | null;
}

export interface CompanyQuestionsResponse extends QuestionListResponse {
  company: { slug: string; name: string; hasCompanyRecord: boolean };
  /** Moderated user reports for this company; null when there are none. */
  count: Sourced<number> | null;
  latestPeriod: string | null;
}

export type JobSetStatus = 'ready' | 'not_generated' | 'ai_unavailable';

/**
 * Practice questions for one job: AI-written questions from the job post
 * (and the titles of the company's other open posts), plus moderated user
 * reports about the company. Each item carries its own `sourceKind`.
 */
export interface JobQuestionSetResponse {
  jobId: string;
  jobTitle: string;
  companyName: string;
  /** Route segment for the company page, or null when there is nothing to link. */
  companySlug: string | null;
  status: JobSetStatus;
  /** ISO time the AI set was written; null when there is none. */
  generatedAt: string | null;
  aiQuestions: QuestionView[];
  /** Moderated user reports about this company (newest first, at most 5). */
  companyReports: QuestionView[];
}

export interface ReportQuestionResponse {
  reported: true;
  /** True when this report hid the question until staff look at it. */
  hidden: boolean;
}

export interface ContributionReceipt {
  id: string;
  status: 'pending';
}

// ── Admin moderation ─────────────────────────────────────────────────────

export const CONTRIBUTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

/** Why a contribution may need a closer look (shown to staff; never decides on its own). */
export const SCREEN_FLAGS = ['nda_or_test_content', 'copyright', 'personal_info', 'not_a_question', 'too_long'] as const;
export type ScreenFlag = (typeof SCREEN_FLAGS)[number];

export const REJECT_REASONS = ['nda_or_test_content', 'copyright', 'personal_info', 'not_a_question', 'duplicate', 'offensive', 'other'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const ModerationQueueQuerySchema = z.object({ status: z.enum(CONTRIBUTION_STATUSES).optional(), cursor: z.string().max(64).optional() });
export const ContributionParamsSchema = z.object({ id: Id });

/** Staff publish a contribution as a user report (they may tidy the wording and must pick a category). */
export const ApproveContributionBodySchema = z
  .object({
    category: z.enum(QUESTION_CATEGORIES),
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(10).max(2000),
    companyName: z.string().trim().min(1).max(120).optional(),
    difficulty: z.enum(QUESTION_DIFFICULTIES).optional(),
    seniority: z.string().trim().max(40).optional(),
    /**
     * The language the question is written in (its guide is written in it too).
     * The console prefills ContributionView.locale; omitted → guessed from the text.
     */
    locale: z.enum(QUESTION_LOCALES).optional(),
    /** Required when the screen raised flags (title or body): staff confirm the text is not test content under NDA or copyright. */
    confirmScreened: z.boolean().optional(),
  })
  .strict();

export const RejectContributionBodySchema = z.object({ reason: z.enum(REJECT_REASONS), note: z.string().trim().max(300).optional() }).strict();

export interface ContributionView {
  id: string;
  companyName: string;
  role: string;
  /** 'YYYY-MM' the user was asked. */
  period: string;
  body: string;
  status: ContributionStatus;
  createdAt: string;
  moderatedAt: string | null;
  /** Automatic screen (wording only; staff decide). */
  flags: ScreenFlag[];
  /** The language guessed from the text; the console prefills its language field with it. */
  locale: QuestionLocale;
}

export interface ContributionListResponse {
  items: ContributionView[];
  cursor: string | null;
}

export const ADMIN_QUESTION_FILTERS = ['reported', 'hidden', 'curated'] as const;
export const AdminQuestionsQuerySchema = z.object({ filter: z.enum(ADMIN_QUESTION_FILTERS).optional(), cursor: z.string().max(64).optional() });

export interface AdminQuestionView extends QuestionView {
  status: 'published' | 'hidden';
  reportsCount: number;
  /** Newest reports first (at most 5). */
  reports: Array<{ reason: (typeof QUESTION_REPORT_REASONS)[number]; note: string | null; createdAt: string }>;
}

export interface AdminQuestionListResponse {
  items: AdminQuestionView[];
  cursor: string | null;
}

/** Staff-written practice question: generic, never attributed to a company (strict: no company fields). */
export const CreateCuratedQuestionBodySchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(10).max(2000),
    category: z.enum(QUESTION_CATEGORIES),
    difficulty: z.enum(QUESTION_DIFFICULTIES).optional(),
    seniority: z.string().trim().max(40).optional(),
    locale: z.enum(QUESTION_LOCALES),
  })
  .strict();

export const PREP_ERROR_CODES = {
  /** details.reason on 429 when the daily guide limit is used up. */
  guideLimit: 'guide_daily_limit',
  /** details.reason on 429 when the daily AI question-set limit is used up. */
  jobSetLimit: 'job_set_daily_limit',
  /** details.reason on 422 when a non-report item names a company (service check). */
  companyOnNonReport: 'company_on_non_report',
  /** details.reason on 409 when approving flagged text without confirmScreened. */
  screenNotConfirmed: 'screen_not_confirmed',
  /** details.reason on 409 when a contribution was already moderated. */
  alreadyModerated: 'already_moderated',
} as const;
