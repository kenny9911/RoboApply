// server/src/features/prep/contract.ts
//
// Practice questions (question bank), contributions, moderation
// (ARCHITECTURE.md §2.12, §3.9; TASK_PLAN.md WP-59). Mounts:
// /api/v1/roboapply/interview-bank (seeker; capability `interviewBank` per
// route) and /api/v1/roboapply/admin/prep (moderation).
//
// Labels (D3): AI-written questions always say "Written by AI from the job
// post — not reported by candidates"; contributions say "Shared by a %BRAND%
// user, {month year}". Every item carries `sourceKind`.

import { z } from 'zod';

const Id = z.string().min(1).max(64);

export const QUESTION_SOURCE_KINDS = ['ai_from_posting', 'user_contribution', 'curated'] as const;
export const QUESTION_CATEGORIES = ['behavioral', 'technical', 'case', 'role_specific', 'culture', 'other'] as const;

export const CompaniesQuerySchema = z.object({ q: z.string().trim().max(80).optional(), cursor: z.string().max(64).optional() });
export const CompanySlugParamsSchema = z.object({ slug: z.string().min(1).max(120) });
export const CompanyQuestionsQuerySchema = z.object({
  category: z.enum(QUESTION_CATEGORIES).optional(),
  seniority: z.string().max(40).optional(),
  cursor: z.string().max(64).optional(),
});
export const QuestionParamsSchema = z.object({ id: Id });

export interface QuestionView {
  id: string;
  companySlug: string | null;
  text: string;
  category: (typeof QUESTION_CATEGORIES)[number];
  sourceKind: (typeof QUESTION_SOURCE_KINDS)[number];
  /** Rendered source line (e.g. AI label or "Shared by a %BRAND% user, Oct 2026"). */
  sourceLabelKey: string;
  reportedPeriod: string | null;
}
export interface QuestionDetail extends QuestionView {
  /** AI guide, generated on first view (30/day), labelled as AI. */
  guide: z.infer<typeof QuestionGuideSchema> | null;
}

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

/** POST /interview-bank/contributions (moderated; 10/day). */
export const ContributionBodySchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    role: z.string().trim().max(120).optional(),
    question: z.string().trim().min(10).max(2000),
    category: z.enum(QUESTION_CATEGORIES).optional(),
    /** "YYYY-MM" the user was asked. */
    period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  })
  .strict();
export const QUESTION_REPORT_REASONS = ['wrong', 'duplicate', 'offensive', 'confidential', 'other'] as const;
export const ReportQuestionBodySchema = z.object({ reason: z.enum(QUESTION_REPORT_REASONS), note: z.string().max(500).optional() }).strict();

// ── Admin moderation ─────────────────────────────────────────────────────

export const ModerationQueueQuerySchema = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional(), cursor: z.string().max(64).optional() });
export const ContributionParamsSchema = z.object({ id: Id });
export const RejectContributionBodySchema = z.object({ reason: z.string().trim().min(1).max(300) }).strict();

export const PREP_ERROR_CODES = {
  guideLimit: 'guide_daily_limit',
} as const;
