// server/src/features/jobs/import/contract.ts
//
// "Added by you": external job import (ARCHITECTURE.md §3.4; TASK_PLAN.md
// WP-35). Mount: /api/v1/roboapply/jobs/import (before the job-detail
// router), capability `jobs.import`, credit `job_import` (Idempotency-Key).
//
// No direct fetch: URLs go through Firecrawl only (http/https, size cap);
// hosts on IMPORT_FETCH_DENYLIST are never fetched and answer `needs_text`.
// Imported jobs are private (`visibility='private'`, `sourceBoard='user_import'`)
// and never appear in counts or public pages.

import { z } from 'zod';

/** Default IMPORT_FETCH_DENYLIST (env overrides). Matching is by registrable domain. */
export const DEFAULT_IMPORT_FETCH_DENYLIST = [
  'linkedin.com',
  'indeed.*',
  'glassdoor.*',
  'zhipin.com',
  'zhaopin.com',
  'liepin.com',
  '51job.com',
  'maimai.cn',
  '104.com.tw',
  '1111.com.tw',
  'cake.me',
  'yourator.co',
] as const;

export const ManualJobSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    company: z.string().trim().min(1).max(200),
    description: z.string().trim().min(50).max(60_000),
    applyUrl: z.string().url().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
  })
  .strict();

/** POST /jobs/import — `{ url }` or `{ manual }`. */
export const ImportJobBodySchema = z.union([
  z.object({ url: z.string().url().max(2000).regex(/^https?:\/\//i, 'http(s) only') }).strict(),
  z.object({ manual: ManualJobSchema }).strict(),
]);
export type ImportJobBody = z.infer<typeof ImportJobBodySchema>;

export const IMPORT_STATUSES = ['processing', 'needs_text', 'needs_fields', 'done', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface ImportJobResponse {
  importId: string;
  status: ImportStatus;
}

/** GET /jobs/import/:importId */
export const ImportParamsSchema = z.object({ importId: z.string().min(1).max(64) });
export interface ImportStatusResponse {
  status: ImportStatus;
  jobId: string | null;
  /** Fields the user must confirm or fill (title, company, location, …). */
  missingFields: string[];
  /** GoApply fraud warning from marketHooks (WP-41), shown before saving. */
  warnings: Array<{ rule: string; evidence: string }>;
}

/** Limits (persisted): 10/h; 20 consecutive failures → 1 h lock; 3 locks in 7 days → 7-day lock. */
export const IMPORT_LIMITS = { perHour: 10, failuresBeforeLock: 20, lockMinutes: 60, locksBeforeLongLock: 3, longLockDays: 7 } as const;

export const IMPORT_ERROR_CODES = {
  locked: 'import_locked',
  needsText: 'import_needs_text',
  notFound: 'import_not_found',
} as const;
