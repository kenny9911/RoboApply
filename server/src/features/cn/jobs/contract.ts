// server/src/features/cn/jobs/contract.ts
//
// GoApply jobs: recruitment-info mode, GoHire honesty fields, anti-fraud,
// market tags, external search deep links (TASK_PLAN.md R-14, WP-41;
// CN_TW_LAUNCH_PLAN.md CN-E-05, CN-E-08, CN-L-04). Mounts:
//   /api/v1/roboapply/cn/jobs        (seeker: deep links)
//   /api/v1/roboapply/admin/cn/jobs  (admin: fraud review, employer blacklist)
//
// Honesty: 企业直招 only when `fromRecruiterBank && employerVerified &&
// !isAgency`, otherwise "来源：{sourceName}"; never "not on other job
// boards"; market tags (可落户/央国企/事业编/外企) only with an
// `evidenceQuote`; deep links carry only the user's own query; with mode
// `off` no GoApply route returns third-party postings.

import { z } from 'zod';

export const CN_EXTERNAL_BOARDS = ['boss', 'zhaopin', 'liepin'] as const;
export const CN_MARKET_TAGS = ['hukou', 'soe', 'bianzhi', 'foreign'] as const;

/** GET /cn/jobs/external-links?q&city — deep links built from the user's own query only. */
export const ExternalLinksQuerySchema = z.object({ q: z.string().trim().min(1).max(80), city: z.string().trim().max(40).optional() });
export interface ExternalLinksResponse {
  links: Array<{ board: (typeof CN_EXTERNAL_BOARDS)[number]; label: string; url: string }>;
}

/** Fraud rule ids (keywords + cheap CN LLM, WP-41). */
export const CN_FRAUD_RULES = ['training_to_hire', 'training_loan', 'upfront_fee', 'mlm', 'gambling', 'telecom_lure', 'blacklisted_employer', 'other'] as const;

// ── Admin: fraud review (可疑职位待审核) and employer blacklist ──────────

export const FraudQueueQuerySchema = z.object({
  status: z.enum(['flagged', 'cleared', 'confirmed']).optional(),
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
  flags: Array<{ rule: string; evidence: string; at: string }>;
  reportCount: number;
  flaggedAt: string;
}

export const BlacklistEntryBodySchema = z
  .object({ employerName: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(300) })
  .strict();
export const BlacklistParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** Card meta returned by the cn marketHooks.cardMeta hook (rendered by JobMetaCn). */
export interface CnCardMeta {
  /** "来源：{sourceName}" + licence line, or 企业直招 when the three-field rule holds. */
  sourceLine: { kind: 'direct' | 'source'; sourceName: string | null };
  /** Verbatim `salaryText` (e.g. "15-25K·13薪") or "薪资未披露" (salaryDisclosed=false). */
  salary: { text: string | null; disclosed: boolean };
  expiresAt: string | null;
  tags: Array<{ tag: (typeof CN_MARKET_TAGS)[number]; evidenceQuote: string; evidenceUrl: string | null }>;
}
