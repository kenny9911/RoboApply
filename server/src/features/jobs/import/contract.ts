// server/src/features/jobs/import/contract.ts
//
// "Added by you": external job import (ARCHITECTURE.md §3.4; PRODUCT_PLAN.md
// F-TRK-04; TASK_PLAN.md WP-35). Mount: /api/v1/roboapply/jobs/import
// (before the job-detail router), capability `jobs.import`, credit
// `job_import` (Idempotency-Key) spent only when a job is saved.
//
// Flow (the work runs in the request, ≤60 s):
//   1. POST { url }     → the page is read through Firecrawl (never by our
//                         server: no SSRF), the job fields are pulled out of
//                         the page's structured job data (schema.org
//                         JobPosting) or its title/text, and come back as a
//                         DRAFT (`needs_fields`). Nothing is stored and no
//                         credit is spent. Hosts on IMPORT_FETCH_DENYLIST are
//                         never fetched: `needs_text` ("Paste the job text").
//   2. POST { manual }  → the user's confirmed (or typed) fields become a
//                         private RAJob (`visibility='private'`,
//                         `sourceBoard='user_import'`), or the matching public
//                         job / the user's earlier import. Enriched in the
//                         request; a slow enrichment continues in the queue.
// The user always confirms the fields (honesty: nothing is presented as
// verified by us). Imported jobs never appear in counts or public pages.

import { z } from 'zod';

/**
 * Default IMPORT_FETCH_DENYLIST (env adds more). Boards whose terms forbid
 * scraping. `name.*` matches the name under any country domain
 * (indeed.com, uk.indeed.com, indeed.co.uk); `domain` matches it and every
 * subdomain. `lnkd.in` is LinkedIn's link shortener.
 */
export const DEFAULT_IMPORT_FETCH_DENYLIST = [
  'linkedin.com',
  'lnkd.in',
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

const HttpUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .regex(/^https?:\/\//i, 'http(s) only');

export const MIN_DESCRIPTION_CHARS = 50;
export const MAX_DESCRIPTION_CHARS = 60_000;

export const ManualJobSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    company: z.string().trim().min(1).max(200),
    description: z.string().trim().min(MIN_DESCRIPTION_CHARS).max(MAX_DESCRIPTION_CHARS),
    /** The posting or application page. Optional: a job typed by hand may have none. */
    applyUrl: HttpUrl.optional(),
    location: z.string().trim().max(200).optional(),
  })
  .strict();
export type ManualJob = z.infer<typeof ManualJobSchema>;

/** Signed draft ids (`draft_…`) and saved-job ids (`job_…`). */
const ImportId = z.string().min(1).max(512);

/**
 * POST /jobs/import — `{ url }` reads a page into a draft; `{ manual }` saves
 * a job. `importId` on a save names the draft it confirms, so the hourly
 * limit counts the import once.
 */
export const ImportJobBodySchema = z.union([
  z.object({ url: HttpUrl }).strict(),
  z.object({ manual: ManualJobSchema, importId: ImportId.optional() }).strict(),
]);
export type ImportJobBody = z.infer<typeof ImportJobBodySchema>;

/** `processing` is reserved for a future background import; the request flow never returns it. */
export const IMPORT_STATUSES = ['processing', 'needs_text', 'needs_fields', 'done', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Why a link could not be read (drives the plain-language message). */
export const IMPORT_REASONS = [
  /** The site does not allow copying its posts (IMPORT_FETCH_DENYLIST). */
  'blocked_site',
  /** Reading links is not available here (no Firecrawl key, or GoApply on the mainland stack). */
  'fetch_unavailable',
  /** The page could not be opened. */
  'fetch_failed',
  /** The page opened but had no job post we could read. */
  'nothing_found',
  /** The link itself contains personal details (an email, a phone number…). */
  'personal_info_in_link',
  /** The page is larger than we read. */
  'too_large',
  /** Not a public web address (an IP address, localhost, a login in the link). */
  'not_a_web_address',
] as const;
export type ImportReason = (typeof IMPORT_REASONS)[number];

export const IMPORT_FIELDS = ['title', 'company', 'description', 'location', 'applyUrl'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Fields a save needs. */
export const REQUIRED_IMPORT_FIELDS = ['title', 'company', 'description'] as const satisfies readonly ImportField[];

/**
 * Where a draft value came from, so the form can say how sure it is:
 *   job_data       the page's own structured job data (schema.org JobPosting)
 *   page_title     the page title (check it)
 *   page_site_name the site's name (often the company; check it)
 *   page_text      the page's text (check it; may include extra page text)
 *   link           the link the user gave
 */
export const IMPORT_FIELD_SOURCES = ['job_data', 'page_title', 'page_site_name', 'page_text', 'link'] as const;
export type ImportFieldSource = (typeof IMPORT_FIELD_SOURCES)[number];

/** A draft: every value is a suggestion the user confirms; null = not found. */
export interface ImportDraft {
  title: string | null;
  company: string | null;
  description: string | null;
  location: string | null;
  applyUrl: string | null;
  sources: Partial<Record<ImportField, ImportFieldSource>>;
}

/** A warning shown before (and after) saving: a rule and the posting's own words. */
export interface ImportWarning {
  /** Rule id (`intl_pay_to_apply`, `intl_fee_required`, `intl_messaging_app_only`; GoApply rules from WP-41's market hooks). */
  rule: string;
  /** The sentence of the posting the warning rests on. */
  evidence: string;
}

export interface ImportJobResponse {
  importId: string;
  status: ImportStatus;
  /** Set when `status === 'done'`. */
  jobId: string | null;
  /** Required fields that are empty in the draft (title, company, description). */
  missingFields: ImportField[];
  warnings: ImportWarning[];
  /** For `needs_text` / `failed`: why. */
  reason: ImportReason | null;
  /**
   * For `needs_fields`: the values to confirm. For `needs_text` / `failed`:
   * only the link (when it may be kept), so the paste form starts with it.
   */
  draft: ImportDraft | null;
  /** For `done`: the job already existed — in our listings (`public`) or among the user's own imports (`yours`). */
  matched: 'public' | 'yours' | null;
}

/** GET /jobs/import/:importId */
export const ImportParamsSchema = z.object({ importId: ImportId });
export interface ImportStatusResponse {
  status: ImportStatus;
  jobId: string | null;
  /** Fields the user must confirm or fill (title, company, description). */
  missingFields: string[];
  /** GoApply fraud warning from marketHooks (WP-41) and the rule-based scam signals, shown before saving. */
  warnings: Array<{ rule: string; evidence: string }>;
  reason: ImportReason | null;
}

// ── GET /jobs/import — the "Added by you" list ────────────────────────────

export const AddedJobsQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export interface AddedJobItem {
  jobId: string;
  title: string;
  companyName: string;
  location: string | null;
  workModel: 'remote' | 'hybrid' | 'onsite' | null;
  /** The posting link the user gave; null when the job was typed by hand. */
  applyUrl: string | null;
  /** Host of `applyUrl`, for the source line ("Added from boards.example.com"). */
  sourceHost: string | null;
  addedAt: string;
  /** Warnings stored on the job (scam signals, GoApply fraud rules). */
  warnings: ImportWarning[];
  /** The user's tracker status for the job, when tracked. */
  trackerStatus: string | null;
}

export interface AddedJobsResponse {
  items: AddedJobItem[];
  cursor: string | null;
}

// ── DELETE /jobs/import/jobs/:jobId — remove an added job ─────────────────

export const AddedJobParamsSchema = z.object({ jobId: z.string().min(1).max(64) });

/** Limits (persisted): 10/h; 20 consecutive failures → 1 h lock; 3 locks in 7 days → 7-day lock. */
export const IMPORT_LIMITS = { perHour: 10, failuresBeforeLock: 20, lockMinutes: 60, locksBeforeLongLock: 3, longLockDays: 7 } as const;

/**
 * `details.reason` on a `429 rate_limited` from this area, plus the legacy
 * names. (`import_needs_text` is a status, not an error.)
 */
export const IMPORT_ERROR_CODES = {
  locked: 'import_locked',
  hourly: 'import_hourly_limit',
  needsText: 'import_needs_text',
  notFound: 'import_not_found',
} as const;

/** `details` of a 429 from POST /jobs/import. */
export interface ImportLimitDetails {
  reason: (typeof IMPORT_ERROR_CODES)['locked'] | (typeof IMPORT_ERROR_CODES)['hourly'];
  retryAfterSec: number;
  /** ISO time the lock ends (`import_locked`). */
  lockedUntil?: string;
}
