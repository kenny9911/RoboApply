// server/src/features/resume/contract.ts
//
// NEW resume-suite paths under /v2/resumes (ARCHITECTURE.md §3.6;
// TASK_PLAN.md WP-22 grade/fix/keyword report, WP-36a tailor sessions,
// WP-36b layout + export guard, WP-65 builder). The legacy
// roboapply/v2/routes/resumes.ts keeps every existing path; this router is
// mounted after it at /api/v1/roboapply/v2/resumes and declares only new paths.
//
// Rules: no "ATS" in copy (layout risks read "Company software may not read
// this"); a grade is a rubric, never a chance of passing; tailoring claims
// not found in the base resume stay `pending` and block finalize/export
// (`unverified_claims`, ruling C12).

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const ResumeIdParamsSchema = z.object({ id: Id });

// ── Resume check (credit `resume_check`; ≤45 s; release on failure) ──────

export const GradeBodySchema = z.object({ targetTitle: z.string().trim().max(120).optional() }).strict();
export const GRADE_LABELS = ['excellent', 'good', 'fair', 'needs_work'] as const;
export const ISSUE_SEVERITIES = ['urgent', 'critical', 'optional'] as const;

/** `RAResumeGrade.counts`: `{ urgent, critical, optional }` */
export const GradeCountsSchema = z.object({ urgent: z.number().int(), critical: z.number().int(), optional: z.number().int() }).strict();
/** `RAResumeGrade.issues`: `[{ id, type, severity, section, anchor, why, how, suggestion? }]` */
export const GradeIssueSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    severity: z.enum(ISSUE_SEVERITIES),
    section: z.string(),
    anchor: z.string().nullable(),
    why: z.string(),
    how: z.string(),
    suggestion: z.string().optional(),
  })
  .strict();
export const GradeIssuesSchema = z.array(GradeIssueSchema);

export interface GradeView {
  id: string;
  resumeVariantId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  label: (typeof GRADE_LABELS)[number] | null;
  score: number | null;
  counts: z.infer<typeof GradeCountsSchema> | null;
  issues: Array<z.infer<typeof GradeIssueSchema>>;
  createdAt: string;
}
export interface GradeStartResponse {
  gradeId: string;
}
export const GradeParamsSchema = z.object({ gradeId: Id });

/** POST /v2/resumes/:id/issues/:issueId/fix (credit `rewrite`). */
export const IssueParamsSchema = z.object({ id: Id, issueId: z.string().min(1).max(64) });
export const FixIssueBodySchema = z
  .object({ instruction: z.string().max(1000).optional(), variant: z.enum(['ai', 'longer', 'shorter', 'stronger']) })
  .strict();
export interface FixIssueResponse {
  suggestions: Array<{ text: string; aiWritten: true }>;
}

// ── Keyword report (deterministic; free) ─────────────────────────────────

const JdSnapshot = z.object({ title: z.string().trim().min(1).max(200), company: z.string().trim().max(200), text: z.string().trim().min(50).max(60_000) }).strict();
/** `RATailorSession.jdSnapshot` (documented JSON column): a pasted posting. */
export const JdSnapshotSchema = JdSnapshot;

export const KeywordReportBodySchema = z.union([z.object({ jobId: Id }).strict(), z.object({ jd: JdSnapshot }).strict()]);
export interface KeywordReportResponse {
  /** 0–10 */
  score10: number;
  rows: Array<{ label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
  keywords: { matched: string[]; missing: string[] };
  hardSkills: { matched: string[]; missing: string[] };
}

// ── Tailor sessions (credit `tailor`) ────────────────────────────────────

export const TAILOR_MODES = ['fast', 'guided'] as const;
export const TAILOR_SECTIONS = ['summary', 'experience', 'skills', 'projects', 'education'] as const;

export const CreateTailorSessionBodySchema = z
  .object({
    baseVariantId: Id,
    jobId: Id.optional(),
    jd: JdSnapshot.optional(),
    mode: z.enum(TAILOR_MODES),
    sections: z.array(z.enum(TAILOR_SECTIONS)).min(1).max(5),
    customPrompt: z.string().max(1000).optional(),
    /** Missing keywords the user confirmed they have. */
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  })
  .strict()
  .refine((v) => Boolean(v.jobId) !== Boolean(v.jd), { message: 'Send either jobId or jd.' });

export const CLAIM_KINDS = ['keyword', 'number', 'claim'] as const;
export const CLAIM_STATUSES = ['pending', 'kept', 'removed', 'edited'] as const;
/** `RATailorSession.claims` (documented JSON column). */
export const TailorClaimSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    kind: z.enum(CLAIM_KINDS),
    status: z.enum(CLAIM_STATUSES),
    evidence: z.object({ source: z.literal('resume'), ref: z.string() }).strict().optional(),
  })
  .strict();
export const TailorClaimsSchema = z.array(TailorClaimSchema);

export interface TailorSessionView {
  id: string;
  status: 'generating' | 'review' | 'finalized' | 'failed';
  baseVariantId: string;
  jobId: string | null;
  scoreBefore: number | null;
  scoreAfter: number | null;
  changes: Array<{ section: string; before: string; after: string }>;
  claims: Array<z.infer<typeof TailorClaimSchema>>;
  resultVariantId: string | null;
}
export const TailorSessionParamsSchema = z.object({ id: Id });
export const ClaimParamsSchema = z.object({ id: Id, claimId: z.string().min(1).max(64) });
export const UpdateClaimBodySchema = z
  .object({ status: z.enum(['kept', 'removed', 'edited']), text: z.string().trim().min(1).max(1000).optional() })
  .strict()
  .refine((v) => v.status !== 'edited' || Boolean(v.text), { message: 'An edited claim needs text.' });

// ── Layout (WP-36b) ──────────────────────────────────────────────────────

export const RESUME_TEMPLATES = ['standard', 'compact', 'centered', 'structured', 'two_column'] as const;
/** `RAResumeVariant.layout` (documented JSON column). */
export const ResumeLayoutSchema = z
  .object({
    template: z.enum(RESUME_TEMPLATES).optional(),
    font: z.string().max(60).optional(),
    sizes: z.object({ name: z.number(), section: z.number(), sub: z.number(), body: z.number() }).partial().strict().optional(),
    page: z.enum(['letter', 'a4']).optional(),
    spacing: z.object({ section: z.number(), entry: z.number(), line: z.number(), marginY: z.number(), marginX: z.number() }).partial().strict().optional(),
    justify: z.boolean().optional(),
    headerAlign: z.enum(['left', 'center']).optional(),
    accent: z.string().max(20).optional(),
    bullet: z.string().max(4).optional(),
    skillsLayout: z.enum(['inline', 'grouped', 'columns']).optional(),
    eduOrder: z.enum(['before_experience', 'after_experience']).optional(),
    dateFormat: z.string().max(20).optional(),
    hideDivider: z.boolean().optional(),
  })
  .strict();
export const PatchLayoutBodySchema = z.object({ layout: ResumeLayoutSchema }).strict();

export const RESUME_ERROR_CODES = {
  /** Finalize/export refused while any claim is pending (409). */
  unverifiedClaims: 'unverified_claims',
  gradeNotFound: 'grade_not_found',
  sessionNotFound: 'tailor_session_not_found',
} as const;
