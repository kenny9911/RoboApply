// server/src/features/cn/jobs/contract.ts
//
// GoApply jobs: recruitment-info mode (on by default, D5: `off` is the kill
// switch), GoHire honesty fields, anti-fraud, market tags, external search
// deep links (WP-41; GOAPPLY_PARITY_PLAN §3.2, §3.9; CN_TW_LAUNCH_PLAN.md
// CN-E-05, CN-E-08, CN-L-04). Mounts:
//   /api/v1/roboapply/cn/jobs        (seeker: deep links)
//   /api/v1/roboapply/admin/cn/jobs  (admin: fraud review, employer blacklist)
//
// Honesty: 企业直招 only when `fromRecruiterBank && employerVerified &&
// !isAgency`, otherwise "来源：{sourceName}"; never "not on other job
// boards"; market tags (可落户/央国企/事业编/外企) only with an
// `evidenceQuote`; deep links carry only the user's own query; with mode
// `off` no GoApply route returns third-party postings. Every mainland card
// names its source: the original publisher, the original link and when we
// last verified it (`sourceLine.original / url`, `lastCheckedAt`); an indexed
// posting's text carries no recruiter phone number or WeChat id.

import { z } from 'zod';

// The mainland pay line (one rule for the feed card, the job page and the card
// meta). A pure module with no runtime import, re-exported here so other areas
// read it through the contract.
export { cnSalary, formatCnSalary } from './salary.js';

export const CN_EXTERNAL_BOARDS = ['boss', 'zhaopin', 'liepin'] as const;
export type CnExternalBoard = (typeof CN_EXTERNAL_BOARDS)[number];
export const CN_MARKET_TAGS = ['hukou', 'soe', 'bianzhi', 'foreign'] as const;
export type CnMarketTag = (typeof CN_MARKET_TAGS)[number];

/** GET /cn/jobs/external-links?q&city — deep links built from the user's own query only. */
export const ExternalLinksQuerySchema = z.object({ q: z.string().trim().min(1).max(80), city: z.string().trim().max(40).optional() });
export interface ExternalLinksResponse {
  links: Array<{ board: CnExternalBoard; label: string; url: string }>;
}

/**
 * Fraud rule ids (keywords + cheap CN LLM, WP-41). Every id is unique to the
 * CN classifier (no `intl_` prefix: those belong to WP-17's scamSignals).
 */
export const CN_FRAUD_RULES = ['training_to_hire', 'training_loan', 'upfront_fee', 'mlm', 'gambling', 'telecom_lure', 'blacklisted_employer', 'other'] as const;
export type CnFraudRule = (typeof CN_FRAUD_RULES)[number];

/** How a flag was raised. Stored on the flag; optional for flags written by other modules. */
export const CN_FRAUD_METHODS = ['keywords', 'llm', 'blacklist', 'admin'] as const;
export type CnFraudMethod = (typeof CN_FRAUD_METHODS)[number];

/** One `RAJob.fraudFlags` entry written by this module. */
export interface CnFraudFlag {
  rule: CnFraudRule;
  /** Verbatim sentence from the posting (or the blacklist reason). */
  evidence: string;
  /** ISO time the flag was raised. */
  at: string;
  method: CnFraudMethod;
}

// ── Admin: fraud review (可疑职位待审核) and employer blacklist ──────────

export const FRAUD_QUEUE_STATUSES = ['flagged', 'cleared', 'confirmed'] as const;
export type FraudQueueStatus = (typeof FRAUD_QUEUE_STATUSES)[number];

export const FraudQueueQuerySchema = z.object({
  status: z.enum(FRAUD_QUEUE_STATUSES).optional(),
  cursor: z.string().max(64).optional(),
});
export const FraudJobParamsSchema = z.object({ jobId: z.string().min(1).max(64) });
export const ResolveFraudBodySchema = z
  .object({ decision: z.enum(['clear', 'confirm']), note: z.string().max(500).optional(), blacklistEmployer: z.boolean().optional() })
  .strict();
export interface FraudQueueItem {
  jobId: string;
  title: string;
  companyName: string;
  sourceName: string | null;
  /** The user's own import (private) or an indexed posting. */
  visibility: 'public' | 'private';
  flags: Array<{ rule: string; evidence: string; at: string; method?: string }>;
  /** Fraud-type reports from users (scam, 培训贷, pay to work, fee required). */
  reportCount: number;
  /** Earliest flag or report time; null when neither has a time. */
  flaggedAt: string | null;
  /** Set on cleared / confirmed items. `by` is the admin's user id; `byName` their name or email (null when unknown). */
  review: { decision: 'clear' | 'confirm'; note: string | null; at: string; by: string; byName: string | null } | null;
}
export interface FraudQueueResponse {
  items: FraudQueueItem[];
  cursor: string | null;
}
export interface ResolveFraudResponse {
  jobId: string;
  status: Exclude<FraudQueueStatus, 'flagged'>;
  /** The blacklist entry created by `blacklistEmployer: true`, if any. */
  blacklistEntryId: string | null;
}

export const BlacklistEntryBodySchema = z
  .object({ employerName: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(300) })
  .strict();
export const BlacklistParamsSchema = z.object({ id: z.string().min(1).max(64) });
export interface BlacklistEntryView {
  id: string;
  employerName: string;
  reason: string;
  createdAt: string;
  createdBy: string;
}
/** POST /blacklist: the entry, and how many open posts its name matched (all of them are now flagged). */
export interface BlacklistAddResponse extends BlacklistEntryView {
  matchedOpenJobs: number;
}
export interface BlacklistListResponse {
  items: BlacklistEntryView[];
}

/** Card meta returned by the cn marketHooks.cardMeta hook (rendered by JobMetaCn). */
export interface CnCardMeta {
  /**
   * 企业直招 (`kind: 'direct'`) only when the three-field rule holds;
   * otherwise "来源：{sourceName}". The source name is always present when known.
   */
  sourceLine: {
    kind: 'direct' | 'source';
    sourceName: string | null;
    /** For reposted jobs: the original publisher. */
    originalSourceName: string | null;
    /**
     * "来源：{original}": the original publisher. The employer for a posting
     * read from a public employer board; the stored original publisher for a
     * repost; null when not known (then `sourceName` is the line). Always sent
     * by the server (typed optional so an object built elsewhere is still a
     * CnCardMeta; readers default it to null).
     */
    original?: string | null;
    /** The original posting link (http/https), or null. Always sent by the server. */
    url?: string | null;
    /** How the posting reached us (the same value as the feed item's `source.via`); absent when it is none of these. */
    via?: 'bank' | 'ats' | 'import';
    /**
     * GoHire's HR-service licence line. Only on a GoHire row, and only when
     * CN_HR_LICENCE_HOLDER and CN_HR_LICENCE_NUMBER are both set (never a
     * made-up licence, D3); null while the recruitment-info mode is off.
     */
    licence: { holder: string; number: string } | null;
  };
  /** Verbatim `salaryText` (e.g. "15-25K·13薪"), structured pay rendered the same way, or not disclosed. */
  salary: { text: string | null; disclosed: boolean };
  /** When the source posted or last updated the posting (postedAt); null when it does not say. */
  updatedAt: string | null;
  /** When we last saw the posting live at its source (lastSeenAt): "Last checked {date}", never "Updated". */
  lastCheckedAt: string | null;
  expiresAt: string | null;
  tags: Array<{ tag: CnMarketTag; evidenceQuote: string; evidenceUrl: string | null }>;
  /** 届别 the posting states (`class_year:<yyyy>` market tags), each with its quote. */
  classYears: Array<{ year: number; evidenceQuote: string }>;
  /**
   * Fraud warnings, shown only on the user's own imports (indexed flagged
   * jobs are not shown at all). `ai: true` = raised by the LLM check (the UI
   * labels it as AI output).
   */
  warnings: Array<{ rule: string; evidence: string; ai: boolean }>;
}
