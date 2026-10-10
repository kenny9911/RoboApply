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
//
// WP-22. A check is a rubric over the resume (rules + an optional AI pass for
// spelling and the summary); its score is never a chance of passing. Issues
// carry a stable `type` from ISSUE_TYPES plus ICU `params`: the client renders
// `resumeCheck.issue.<type>.{title,why,how}` and falls back to the English
// `why`/`how` stored on the row. Severity on the wire: urgent = "Fix first",
// critical = "Important", optional = "Nice to have".

export const GradeBodySchema = z.object({ targetTitle: z.string().trim().max(120).optional() }).strict();
export const GRADE_LABELS = ['excellent', 'good', 'fair', 'needs_work'] as const;
export type GradeLabel = (typeof GRADE_LABELS)[number];
/** `RAResumeGrade.grade` stores a letter; the wire carries the label. */
export const GRADE_LETTERS: Record<GradeLabel, 'A' | 'B' | 'C' | 'D'> = { excellent: 'A', good: 'B', fair: 'C', needs_work: 'D' };
export const ISSUE_SEVERITIES = ['urgent', 'critical', 'optional'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
/** Grading profile: `intl` (RoboApply) or `cn` (GoApply; Chinese conventions). */
export const GRADE_PROFILES = ['intl', 'cn'] as const;
export type GradeProfile = (typeof GRADE_PROFILES)[number];
export const RESUME_SECTIONS = ['contact', 'summary', 'experience', 'projects', 'education', 'skills', 'layout', 'other'] as const;
export type ResumeSectionKey = (typeof RESUME_SECTIONS)[number];

/** The issue taxonomy (F-RES-04). `cn_*` types fire only on the cn profile. */
export const ISSUE_TYPES = [
  // layout risks ("Company software may not read this")
  'layout_table',
  'layout_columns',
  'layout_image',
  'layout_symbols',
  // contact and sections
  'contact_name_missing',
  'contact_email_missing',
  'contact_phone_missing',
  'section_experience_missing',
  'section_education_missing',
  'section_skills_missing',
  'summary_missing',
  'summary_too_short',
  'summary_too_long',
  // bullets
  'weak_verb',
  'no_numbers',
  'bullet_too_long',
  'buzzwords',
  'skills_too_few',
  'length_too_long',
  // AI pass (only when AI is allowed)
  'spelling',
  'summary_vague',
  // cn profile
  'cn_self_evaluation_missing',
  'cn_internship_missing',
  'cn_english_cert_missing',
  'cn_personal_details_optional',
  'cn_photo_optional',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** `RAResumeGrade.counts`: `{ urgent, critical, optional }` */
export const GradeCountsSchema = z.object({ urgent: z.number().int(), critical: z.number().int(), optional: z.number().int() }).strict();
export type GradeCounts = z.infer<typeof GradeCountsSchema>;
/** `RAResumeGrade.issues`: `[{ id, type, severity, section, anchor, why, how, suggestion?, … }]` */
export const GradeIssueSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    severity: z.enum(ISSUE_SEVERITIES),
    section: z.string(),
    /** Editor anchor (`section-<key>` or `exp-<n>`), or null. */
    anchor: z.string().nullable(),
    /** English fallback; the client renders `resumeCheck.issue.<type>.why`. */
    why: z.string(),
    /** English fallback; the client renders `resumeCheck.issue.<type>.how`. */
    how: z.string(),
    suggestion: z.string().optional(),
    /** ICU values for the localized title/why/how. */
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    /** A verbatim quote from the resume the issue points at. */
    evidence: z.string().optional(),
    /** The exact resume text a fix rewrites (a bullet or the summary). */
    target: z.string().optional(),
    /** True when `target` is set and the fix panel may offer an AI version. */
    fixable: z.boolean().optional(),
    /** 'rules' (deterministic) or 'ai' (the AI pass found it). */
    source: z.enum(['rules', 'ai']).optional(),
  })
  .strict();
export type GradeIssue = z.infer<typeof GradeIssueSchema>;
export const GradeIssuesSchema = z.array(GradeIssueSchema);

export type GradeStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type GradeAiSkipped = 'credits_exhausted' | 'ai_failed' | 'ai_unavailable';

export interface GradeView {
  id: string;
  resumeVariantId: string;
  status: GradeStatus;
  label: GradeLabel | null;
  /** 0–100 on the checklist (a rubric, never a chance of passing). */
  score: number | null;
  counts: GradeCounts | null;
  issues: GradeIssue[];
  profile: GradeProfile;
  /** 'rules' = checklist only; 'rules_ai' = checklist + AI pass. */
  method: 'rules' | 'rules_ai' | null;
  /**
   * Why the AI pass did not run on a 'rules' check, or null:
   *   'credits_exhausted' — no resume check credit left; the free checklist ran;
   *   'ai_failed'         — the AI pass errored or timed out; no credit was used;
   *   'ai_unavailable'    — AI is off for this account (consent / brand).
   */
  aiSkipped: GradeAiSkipped | null;
  /** Number of checklist rules the resume was graded against. */
  rulesChecked: number | null;
  targetTitle: string | null;
  contentHash: string;
  createdAt: string;
  completedAt: string | null;
}

/** A previous finished check, for the re-check comparison (F-RES-06). */
export interface GradeSummaryView {
  id: string;
  label: GradeLabel | null;
  score: number | null;
  counts: GradeCounts | null;
  /** Distinct issue types of that check (what was fixed = previous − current). */
  issueTypes: string[];
  createdAt: string;
}

/** GET /v2/resumes/:id/grade/latest */
export interface LatestGradeResponse {
  /** The newest check that is not cancelled, or null. */
  grade: GradeView | null;
  /** The newest finished check before `grade`, or null. */
  previous: GradeSummaryView | null;
  /** The resume changed after `grade` ran (offer a re-check). */
  stale: boolean;
  /** AI actions (AI pass, fix suggestions) are available for this user. */
  aiAvailable: boolean;
}

export interface GradeStartResponse {
  gradeId: string;
  /** The finished check (the grade runs in the request). */
  grade?: GradeView;
}
export const GradeParamsSchema = z.object({ gradeId: Id });
export interface CancelGradeResponse {
  gradeId: string;
  status: GradeStatus;
  /** True when a reserved credit was given back. */
  released: boolean;
}

/** POST /v2/resumes/:id/issues/:issueId/fix (credit `rewrite`). */
export const IssueParamsSchema = z.object({ id: Id, issueId: z.string().min(1).max(64) });
export const FIX_VARIANTS = ['ai', 'longer', 'shorter', 'stronger'] as const;
export const FixIssueBodySchema = z
  .object({ instruction: z.string().max(1000).optional(), variant: z.enum(FIX_VARIANTS) })
  .strict();
export interface FixIssueResponse {
  suggestions: Array<{ text: string; aiWritten: true }>;
  /** Suggestions dropped because they added numbers not in the resume (CitationGuard). */
  blocked: number;
}

/** POST /v2/resumes/:id/issues/:issueId/apply — replace the issue's target text. */
export const ApplyFixBodySchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
export interface ApplyFixResponse {
  applied: true;
  resumeContentHash: string;
}

// ── Keyword report (deterministic; free) ─────────────────────────────────

const JdSnapshot = z.object({ title: z.string().trim().min(1).max(200), company: z.string().trim().max(200), text: z.string().trim().min(50).max(60_000) }).strict();
/** `RATailorSession.jdSnapshot` (documented JSON column): a pasted posting. */
export const JdSnapshotSchema = JdSnapshot;

export const KeywordReportBodySchema = z.union([z.object({ jobId: Id }).strict(), z.object({ jd: JdSnapshot }).strict()]);
export const KEYWORD_ROW_KEYS = ['title', 'years', 'education', 'skills', 'keywords'] as const;
export type KeywordRowKey = (typeof KEYWORD_ROW_KEYS)[number];
export type KeywordRowStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export interface KeywordReportRow {
  key: KeywordRowKey;
  status: KeywordRowStatus;
  /** ICU values for `resumeCheck.keywords.row.<key>.<status>` (e.g. `{ met, total }`, `{ required, found }`). */
  params: Record<string, string | number>;
  /** English fallbacks. */
  label: string;
  detail: string;
}
/** Wire twin of `Sourced<number>` (platform/http.ts). */
export interface SourcedNumber {
  value: number;
  source: string;
  asOf: string;
  method?: string;
}
export interface KeywordReportResponse {
  /**
   * The 0–100 fit score of this resume for this job when one was computed
   * (MATCH row; PRODUCT F-RES-08: no second scale). Null when none exists.
   */
  fit: SourcedNumber | null;
  /** 'great' | 'good' | 'possible' | 'unlikely', when `fit` is set. */
  fitTier: string | null;
  rows: KeywordReportRow[];
  keywords: { matched: string[]; missing: string[] };
  hardSkills: { matched: string[]; missing: string[] };
  /** Where the job's keywords came from: the stored extraction or the posting text. */
  keywordSource: 'extraction' | 'posting';
}

// ── Tailor sessions (credit `tailor`; WP-36a) ────────────────────────────
//
// Flow (PRODUCT_PLAN.md F-RES-09/10/15; ruling C12):
//   POST /tailor-sessions            one `tailor` credit (Idempotency-Key); the
//                                    tailored copy is written as a new resume
//                                    version (`resultVariantId`) in `review`
//   PATCH /tailor-sessions/:id/claims/:claimId
//                                    Verify details: kept · removed · edited
//   POST /tailor-sessions/:id/finalize
//                                    409 `unverified_claims` while any claim is
//                                    pending; marks the checklist step 'tailor'
// Every keyword, number or statement in the tailored copy that the base resume
// does not show is a `pending` claim. The result version carries
// `RAResumeVariant.unverifiedClaims` = pending count, which blocks export
// (WP-36b via `unverifiedClaimsCount`).

export const TAILOR_MODES = ['fast', 'guided'] as const;
export type TailorMode = (typeof TAILOR_MODES)[number];
export const TAILOR_SECTIONS = ['summary', 'experience', 'skills', 'projects', 'education'] as const;
export type TailorSection = (typeof TAILOR_SECTIONS)[number];
/** Optional instruction length (PRODUCT F-RES-09). */
export const TAILOR_INSTRUCTION_MAX = 1000;
/**
 * Experience "quick" (reword and reorder the bullets that are there) or
 * "full" (bullets may be rewritten, merged or dropped) — PRODUCT F-RES-09.
 * Stored in `RATailorSession.sections` as 'work_quick' | 'work_full'.
 */
export const EXPERIENCE_DEPTHS = ['quick', 'full'] as const;
export type ExperienceDepth = (typeof EXPERIENCE_DEPTHS)[number];

export const CreateTailorSessionBodySchema = z
  .object({
    baseVariantId: Id,
    jobId: Id.optional(),
    jd: JdSnapshot.optional(),
    mode: z.enum(TAILOR_MODES),
    sections: z.array(z.enum(TAILOR_SECTIONS)).min(1).max(5),
    customPrompt: z.string().max(TAILOR_INSTRUCTION_MAX).optional(),
    /** Missing keywords the user confirmed they have. */
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    /** How far the Experience section may change (only read when 'experience' is picked). */
    experienceDepth: z.enum(EXPERIENCE_DEPTHS).default('quick'),
  })
  .strict()
  .refine((v) => Boolean(v.jobId) !== Boolean(v.jd), { message: 'Send either jobId or jd.' });

export const CLAIM_KINDS = ['keyword', 'number', 'claim'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const CLAIM_STATUSES = ['pending', 'kept', 'removed', 'edited'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/**
 * Why a line needs the user's check:
 *   new_number     a number the base resume does not have (CitationGuard)
 *   new_keyword    a skill or keyword the base resume does not show
 *   new_statement  a new sentence that does not come from the base resume
 *   posting_text   words taken from the job posting (never the candidate's own fact)
 */
export const CLAIM_REASONS = ['new_number', 'new_keyword', 'new_statement', 'posting_text'] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];
/** `RATailorSession.claims` (documented JSON column). */
export const TailorClaimSchema = z
  .object({
    id: z.string(),
    /** The line as it stands in the tailored version (the user's text once edited). */
    text: z.string(),
    kind: z.enum(CLAIM_KINDS),
    status: z.enum(CLAIM_STATUSES),
    evidence: z.object({ source: z.literal('resume'), ref: z.string() }).strict().optional(),
    /** The words in `text` the base resume does not show (numbers, keywords). */
    terms: z.array(z.string()).optional(),
    reasons: z.array(z.enum(CLAIM_REASONS)).optional(),
    /** Heading of the section the line is in. */
    section: z.string().optional(),
    /** The base resume line this one replaced, or null for a new line. */
    original: z.string().nullable().optional(),
    /** What the AI wrote, kept after an edit for the record. */
    proposed: z.string().optional(),
    /**
     * Every place the line appears, in document order, when the AI wrote the
     * same line more than once. A decision applies to every copy; Remove
     * restores each copy to the base line it replaced (or deletes it).
     */
    copies: z
      .array(z.object({ section: z.string().optional(), original: z.string().nullable() }).strict())
      .optional(),
  })
  .strict();
export const TailorClaimsSchema = z.array(TailorClaimSchema);
export type TailorClaim = z.infer<typeof TailorClaimSchema>;

export type TailorChangeKind = 'rewrite' | 'add' | 'remove';
export interface TailorChange {
  section: string;
  /** '' for an added line. */
  before: string;
  /** '' for a removed line. */
  after: string;
  kind?: TailorChangeKind;
}

export type TailorSessionStatus = 'generating' | 'review' | 'finalized' | 'failed';

export interface TailorSessionView {
  id: string;
  status: TailorSessionStatus;
  baseVariantId: string;
  jobId: string | null;
  /** 0–100 fit score of the base resume for this job (AI fit score), or null ("—"). */
  scoreBefore: number | null;
  /** 0–100 fit score of the tailored version, or null ("—"). */
  scoreAfter: number | null;
  changes: TailorChange[];
  claims: TailorClaim[];
  resultVariantId: string | null;
  // ── WP-36a additions ──
  mode: TailorMode;
  /** The picked sections (TAILOR_SECTIONS values). */
  sections: string[];
  /** Experience depth when 'experience' was picked, else null. */
  experienceDepth: ExperienceDepth | null;
  /** The job the copy was tailored for (job record or pasted posting). */
  target: { title: string | null; company: string | null };
  /** Claims still waiting for "Verify details"; export and finalize need 0. */
  pendingClaims: number;
  /** The two scores as sourced values (D3); null when not computed. */
  fit: { before: SourcedNumber | null; after: SourcedNumber | null };
  /** The tailored text is AI output (AiGeneratedBadge on GoApply). */
  aiWritten: true;
  /** Why the session failed: the AI step failed, or the request stopped. */
  failure: 'ai_failed' | 'stopped' | null;
  createdAt: string;
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
  /** The issue has no resume text an AI version could rewrite (422). */
  issueNotFixable: 'issue_not_fixable',
  /** Every AI version added numbers that are not in the resume (409). */
  citationGuard: 'citation_guard',
  sessionNotFound: 'tailor_session_not_found',
  /** The session is not in review (still generating, failed or finalized) (409). */
  sessionNotReviewable: 'tailor_session_not_reviewable',
  claimNotFound: 'tailor_claim_not_found',
  /** A removed claim cannot be decided again; the claim's line changed (409). */
  claimLocked: 'tailor_claim_locked',
} as const;
