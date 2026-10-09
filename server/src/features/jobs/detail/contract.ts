// server/src/features/jobs/detail/contract.ts
//
// Job detail, save, apply click, share, similar (ARCHITECTURE.md §3.4;
// TASK_PLAN.md WP-34; `POST /jobs/:id/score` filled through match/index.ts
// by WP-18). Mount: /api/v1/roboapply/jobs (replaces /v2/jobs/:id).
//
// Rules: a job whose market differs from the brand's answers 404; a private
// (imported) job is visible only to its owner. `apply-click` moves the
// tracker entry to `applied` immediately and the UI shows an inline Undo
// (ruling C11) — D1: we never submit anything.

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const JobIdParamsSchema = z.object({ id: Id });

/** Field provenance (ARCH §2.14). */
export interface SourcedValue<T> {
  value: T;
  source: string;
  sampleSize?: number;
  asOf: string;
  method?: 'stated' | 'computed' | 'ai_estimate';
  url?: string;
}

export interface JobDetail {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  workModel: 'remote' | 'hybrid' | 'onsite' | null;
  employmentType: string | null;
  seniority: string | null;
  pay: { min: number | null; max: number | null; currency: string; period: string; text: string | null } | null;
  /** AI summary: labelled "Summary written by AI from the job post" (`aiWritten: true`). */
  summary: { text: string; aiWritten: true } | null;
  /** Verbatim sections from the posting. */
  sections: Array<{ heading: string | null; body: string }>;
  skills: Array<{ skill: string; kind: 'hard' | 'soft'; required: boolean }>;
  sponsorship: { status: 'offered' | 'not_offered' | 'not_stated'; quote: string | null };
  applyUrl: string | null;
  postedAt: string | null;
  lastSeenAt: string | null;
  closedAt: string | null;
  source: { name: string; kind: string };
  fromRecruiterBank: boolean;
  employerVerified: boolean;
  isAgency: boolean;
  visibility: 'public' | 'private';
  /** GoApply campus fields when stated. */
  campus?: { applyOpensAt: string | null; applyClosesAt: string | null; classYears: number[] } | null;
}

export interface CompanySummary {
  id: string | null;
  name: string;
  logoUrl: string | null;
  /** Only sourced facts (D3); unknown fields are absent. */
  facts: Record<string, SourcedValue<unknown>>;
  /** "{n} open jobs at {company} in %BRAND%" (public rows only). */
  openJobs: number | null;
}

/** Dimension evidence (scorer v3). */
export interface FitDimension {
  key: 'title_level' | 'skills' | 'industry' | 'logistics' | 'career_path';
  weight: number;
  score: number | null;
  status: 'scored' | 'not_stated';
  evidence: Array<{ text: string; source: 'resume' | 'posting'; ref?: string }>;
}
export interface FitView {
  /** 0–100; rendered "87 / 100" with "This is not your chance of getting hired." */
  score: number;
  tier: 'great' | 'good' | 'possible' | 'unlikely';
  /** `pre` renders "Quick estimate". */
  kind: 'pre' | 'ai';
  dimensions: FitDimension[];
  summary: string | null;
  scoredAt: string;
  resumeVariantId: string | null;
}

/** GET /jobs/:id */
export interface JobDetailResponse {
  job: JobDetail;
  company: CompanySummary;
  fit: FitView | null;
  tracker: { id: string; status: string; dateApplied: string | null } | null;
  similarIds: string[];
  autofill: { supported: boolean; atsType: string | null };
}

/** POST /jobs/:id/score (platform-paid; 80/day/user, beyond it the pre-score). */
export const ScoreJobBodySchema = z.object({ resumeVariantId: Id.optional(), force: z.boolean().optional() }).strict();
export interface ScoreJobResponse {
  fit: FitView;
}

/** POST /jobs/:id/apply-click */
export interface ApplyClickResponse {
  applyUrl: string | null;
  atsType: string | null;
  extensionSupported: boolean;
  /** The tracker entry moved to applied (undo with DELETE /jobs/:id/applied). */
  trackerEntryId: string;
}

/** POST /jobs/:id/applied — mark applied manually ("I applied"). */
export const MarkAppliedBodySchema = z.object({ appliedAt: z.iso.datetime().optional() }).strict();

/** POST /jobs/:id/share → public URL only when `publicDisplay`, else an app link. */
export interface ShareResponse {
  url: string;
  public: boolean;
}

export const JOB_DETAIL_ERROR_CODES = {
  notFound: 'job_not_found',
  closed: 'job_closed',
} as const;
