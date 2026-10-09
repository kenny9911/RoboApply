// server/src/features/tools/contract.ts
//
// Free tools without an account (TASK_PLAN.md WP-57; ARCHITECTURE.md §3.9).
// Mount: /api/v1/public/tools (public). Multipart uploads; parse through
// the brand's parser path; 3/day/IP persisted; nothing stored beyond a 24 h
// hash cache (purged by ./cron.ts). Short report before signup, full after.
// No "ATS" wording (scoped allow: `applicant tracking` under seo.tools.resumeChecker.meta.*).

/** Multipart field names. */
export const TOOLS_UPLOAD_FIELDS = { resume: 'resume', postingText: 'postingText' } as const;
export const TOOLS_LIMITS = { perIpPerDay: 3, maxFileBytes: 15 * 1024 * 1024, cacheHours: 24 } as const;
export const TOOLS_ACCEPTED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;

export interface ResumeCheckReport {
  /** Short report: top issues only; `fullAvailableAfterSignup` true. */
  label: 'excellent' | 'good' | 'fair' | 'needs_work';
  issues: Array<{ type: string; severity: 'urgent' | 'critical' | 'optional'; why: string }>;
  hiddenIssueCount: number;
  fullAvailableAfterSignup: boolean;
}

export interface ResumeJobMatchReport {
  score10: number;
  keywords: { matched: string[]; missing: string[] };
  rows: Array<{ label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
}

export const TOOLS_ERROR_CODES = {
  unreadable: 'file_unreadable',
  tooLarge: 'file_too_large',
  wrongType: 'file_wrong_type',
} as const;
