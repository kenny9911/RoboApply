// server/src/features/tools/contract.ts
//
// Free tools without an account (TASK_PLAN.md WP-57; PRODUCT_PLAN.md F-TOOL-01…03;
// ARCHITECTURE.md §3.9). Mount: /api/v1/public/tools (public).
//
//   GET  /config                 limits, accepted files, today's remaining runs, consent rule
//   POST /resume-check           multipart: resume (+ consent on GoApply) → short report
//   POST /resume-job-match       multipart: resume + postingTitle + postingText (+ consent) → requirement rows
//   GET  /results/:id            the short view of a result again (within 24 h, same browser)
//   POST /results/:id/claim      signed in: keep the resume in the account; answers the full report
//
// Rules:
//   - Parse through the brand's parser path (GoHire on GoApply when configured,
//     the local parser otherwise). The file itself is never stored. What is kept
//     for 24 h is a hash-keyed cache row (the report and the text read from the
//     file, redacted per the brand's storage rule) so the visitor can carry it
//     into an account; `./cron.ts` and every request purge expired rows.
//   - 3 runs a day per IP for EACH tool, persisted (RARateCounter; PRODUCT
//     §limits). A run counts only once the file was read: an unreadable file
//     does not use a check. Every attempt (also a repeat answered from the
//     cache) counts against a looser per-IP attempts guard, which bounds the
//     parses and rows an IP can cause. A repeat of the same file (and posting)
//     from the same browser inside 24 h answers from the cache and does not
//     count against the 3.
//   - A result belongs to the browser that ran it: the run sets an HttpOnly
//     visitor cookie (TOOLS_VISITOR_COOKIE) and the row keeps only its hash.
//     GET /results/:id and the claim answer 404 without the matching cookie,
//     so a leaked result id alone opens nothing. The web never puts a result
//     id in a URL.
//   - GoApply in CN-0 (the offshore, invite-only closed beta): the tools are
//     off (404 feature_disabled; /config says `available: false`) — an open,
//     anonymous upload would send mainland visitors' resumes offshore outside
//     the invite-only beta and its cross-border consent.
//   - The resume check is the deterministic checklist (no AI pass, no number):
//     a label, counts by severity and the top issues; the rest after signup.
//   - The resume–job check is the deterministic requirement rows of the
//     keyword report. No score: the 0–100 fit score exists only in the app,
//     from the scorer (PRODUCT F-RES-08: no second scale).
//   - Plain language: no "ATS", no "score", no "match" in copy (C8).

import { z } from 'zod';

import type { GradeCounts, GradeIssue, GradeLabel, GradeProfile, KeywordReportRow } from '../resume/contract.js';

export const TOOL_KINDS = ['resume_check', 'resume_job_match'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** Public page slug of each tool (`/tools/<slug>`). */
export const TOOL_SLUGS: Readonly<Record<ToolKind, string>> = {
  resume_check: 'resume-check',
  resume_job_match: 'resume-job-match',
};

/** Multipart field names. */
export const TOOLS_UPLOAD_FIELDS = {
  resume: 'resume',
  postingTitle: 'postingTitle',
  postingText: 'postingText',
  /** GoApply: the consent version the visitor ticked (TOOLS_CONSENT_VERSION). */
  consent: 'consent',
} as const;

export const TOOLS_LIMITS = {
  /** Runs a day per IP, for each tool. */
  perIpPerDay: 3,
  /** Attempts a day per IP across both tools (any upload that passes the free checks, cache hits too). */
  attemptsPerIpPerDay: 20,
  maxFileBytes: 15 * 1024 * 1024,
  cacheHours: 24,
  /** Issues shown before signup; the rest are counted, not listed. */
  shortReportIssues: 3,
  postingTitleMaxChars: 200,
  postingMinChars: 50,
  postingMaxChars: 60_000,
} as const;

export const TOOLS_ACCEPTED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;
export const TOOLS_ACCEPTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'] as const;

/**
 * GoApply processes a visitor's resume only after the visitor ticks the tool's
 * processing notice (there is no account to hold an `ai_resume_parsing` grant).
 * The form sends this version back; anything else answers 422 `consent_required`.
 */
export const TOOLS_CONSENT_VERSION = 'tools-processing.2026-10-10.v2';

/**
 * The browser-binding cookie: a random nonce, HttpOnly, SameSite=Lax, scoped
 * to this API's path, 24 h. Only sha256 of it is stored, in the result row.
 */
export const TOOLS_VISITOR_COOKIE = 'ra_tool_visitor';
export const TOOLS_VISITOR_COOKIE_PATH = '/api/v1/public/tools';
/** 32 random bytes, base64url. */
export const TOOLS_VISITOR_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `details.reason` of a 422 `invalid_request` / 404 `not_found` / 409 `conflict` from this area. */
export const TOOLS_ERROR_REASONS = {
  missingFile: 'file_missing',
  unreadable: 'file_unreadable',
  tooLarge: 'file_too_large',
  wrongType: 'file_wrong_type',
  consentRequired: 'consent_required',
  postingTitleMissing: 'posting_title_missing',
  postingTooShort: 'posting_too_short',
  postingTooLong: 'posting_too_long',
  resultExpired: 'result_expired',
  /** GET /results/:id after the result was kept in an account (the text now lives there). */
  resultClaimed: 'result_claimed',
  resumeLimit: 'resume_limit',
  /** 429: a run of this tool is already going for this visitor (this server instance). */
  runInProgress: 'run_in_progress',
  /** 429: the per-IP attempts guard (not the 3 a day) is used up. */
  tooManyAttempts: 'too_many_attempts',
} as const;
export type ToolsErrorReason = (typeof TOOLS_ERROR_REASONS)[keyof typeof TOOLS_ERROR_REASONS];

/** @deprecated FND-5 name; use TOOLS_ERROR_REASONS. */
export const TOOLS_ERROR_CODES = {
  unreadable: TOOLS_ERROR_REASONS.unreadable,
  tooLarge: TOOLS_ERROR_REASONS.tooLarge,
  wrongType: TOOLS_ERROR_REASONS.wrongType,
} as const;

/** A result id: 43 url-safe characters (32 random bytes). */
export const ToolResultParamsSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) }).strict();

/** The text fields of POST /resume-job-match (the file is the `resume` part). */
export const ResumeJobMatchFieldsSchema = z.object({
  postingTitle: z.string().trim().min(1).max(TOOLS_LIMITS.postingTitleMaxChars),
  postingText: z.string().trim().min(TOOLS_LIMITS.postingMinChars).max(TOOLS_LIMITS.postingMaxChars),
});

// ── Views ────────────────────────────────────────────────────────────────

/** GET /config */
export interface ToolsConfigView {
  /** False when the tools are off for this brand and stage (GoApply CN-0): hide them. */
  available: boolean;
  /** Runs a day per IP, for each tool. */
  perIpPerDay: number;
  /** Runs left today for this visitor, per tool; null when the counter could not be read. */
  remainingByTool: Record<ToolKind, number | null>;
  /** When today's allowance resets (ISO). */
  resetsAt: string;
  maxFileBytes: number;
  acceptedTypes: readonly string[];
  acceptedExtensions: readonly string[];
  cacheHours: number;
  shortReportIssues: number;
  /** GoApply: the processing notice must be ticked (send `consent=<consentVersion>`). */
  consentRequired: boolean;
  consentVersion: string | null;
  /** GoApply offshore beta (CN-0): the notice says the resume is processed outside mainland China. */
  processedOutsideMainland: boolean;
  /**
   * GoApply: the outside resume-reading service a file may be sent to (named
   * in the notice), or null when none is configured for the brand.
   */
  parserName: string | null;
}

interface ToolReportBase {
  /**
   * Opaque id for GET /results/:id and the claim. Works only together with
   * the visitor cookie of the browser that ran the check; the web keeps it in
   * sessionStorage, never in a URL.
   */
  resultId: string;
  /** When the cached result and the text read from the file are deleted (ISO). */
  expiresAt: string;
  /** Answered from the 24 h cache (did not count against today's runs). */
  cached: boolean;
  /** True on the claim response (everything); false before signup. */
  full: boolean;
}

/** One issue of the tool's report: the resume check issue without the editor-only fields. */
export type ToolIssue = Omit<GradeIssue, 'target' | 'fixable' | 'suggestion'>;

/** POST /resume-check — the deterministic checklist (rules only; no AI pass). */
export interface ResumeCheckReport extends ToolReportBase {
  kind: 'resume_check';
  label: GradeLabel;
  /** Counts over EVERY issue (also the ones listed only after signup). */
  counts: GradeCounts;
  /** Before signup: the first `TOOLS_LIMITS.shortReportIssues`, most severe first. After: all. */
  issues: ToolIssue[];
  /** Issues not listed in this view. */
  hiddenIssueCount: number;
  /** Rules the resume was checked against. */
  rulesChecked: number | null;
  profile: GradeProfile;
  /** Always 'rules': an automated checklist, not a person and not an AI read. */
  method: 'rules';
}

/** POST /resume-job-match — requirement rows from the posting text (no score). */
export interface ResumeJobMatchReport extends ToolReportBase {
  kind: 'resume_job_match';
  postingTitle: string;
  rows: KeywordReportRow[];
  keywords: { matched: string[]; missing: string[] };
  hardSkills: { matched: string[]; missing: string[] };
  method: 'rules';
}

export type ToolReport = ResumeCheckReport | ResumeJobMatchReport;

/** POST /results/:id/claim */
export interface ClaimToolResultResponse {
  /** The resume created in the account from the checked file. */
  resumeId: string;
  /** The full report. */
  report: ToolReport;
  /** The same user claimed it before (a repeat call). */
  alreadyClaimed: boolean;
}
