// server/src/features/cn/referrals/contract.ts
//
// GoApply 内推码 hub: user-contributed referral codes with company,
// programme and expiry, moderated and reportable (TASK_PLAN.md WP-54;
// capability `cn.referralCodes`, separate from the invite-friends `invites`).
// Mount: /api/v1/roboapply/cn/referrals (seeker);
// admin queue: /api/v1/roboapply/admin/cn/referrals (createCnReferralsAdminRouter).
//
// Honesty: a code appears only after a moderator approved it, labelled
// "Shared by a %BRAND% user, {month year}". We never claim a code works or
// that a referral leads to an interview. Paid or traded codes are rejected.

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const ReferralCodeParamsSchema = z.object({ id: Id });

export const ListReferralCodesQuerySchema = z.object({
  company: z.string().trim().max(120).optional(),
  classYear: z.coerce.number().int().min(2025).max(2030).optional(),
  cursor: z.string().max(64).optional(),
});

export const CreateReferralCodeBodySchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    code: z.string().trim().min(2).max(64),
    /** Programme name, e.g. "2027届校园招聘". */
    programme: z.string().trim().max(120).optional(),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export const REFERRAL_REPORT_REASONS = ['expired', 'invalid', 'spam', 'paid', 'other'] as const;
export type ReferralReportReason = (typeof REFERRAL_REPORT_REASONS)[number];
export const ReportReferralCodeBodySchema = z
  .object({ reason: z.enum(REFERRAL_REPORT_REASONS), note: z.string().max(500).optional() })
  .strict();

export const REFERRAL_CODE_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ReferralCodeStatus = (typeof REFERRAL_CODE_STATUSES)[number];

export interface ReferralCodeView {
  id: string;
  company: string;
  code: string;
  programme: string | null;
  expiresAt: string | null;
  note: string | null;
  status: ReferralCodeStatus;
  /** When the user shared it (the card says "Shared by a %BRAND% user, {month year}"). */
  sharedAt: string;
  mine: boolean;
  /** The viewer already reported this code. */
  reportedByMe: boolean;
  /** Mine and rejected: the moderator's reason code. */
  rejectReason: string | null;
}

export interface ListReferralCodesResponse {
  items: ReferralCodeView[];
  cursor: string | null;
  /** The viewer's own codes in every state (newest first), so they can follow review. */
  mine: ReferralCodeView[];
}

export const REFERRALS_PAGE_SIZE = 30;
/** New codes a user may share per day. */
export const REFERRAL_SHARES_PER_DAY = 10;
/** Reports that take an approved code off the hub until a moderator looks again. */
export const REFERRAL_REPORTS_TO_HIDE = 3;

// ── Admin moderation queue ───────────────────────────────────────────────

export const REFERRAL_REJECT_REASONS = ['not_a_referral_code', 'paid_or_traded', 'contact_details', 'duplicate', 'expired', 'other'] as const;
export const ModerateReferralCodeBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.enum(REFERRAL_REJECT_REASONS).optional(),
  })
  .strict()
  .refine((b) => b.decision === 'approve' || Boolean(b.reason), { message: 'A rejection needs a reason.' });
export const ReferralQueueQuerySchema = z.object({ cursor: z.string().max(64).optional() });

export interface ReferralQueueItem extends Omit<ReferralCodeView, 'mine' | 'reportedByMe'> {
  userId: string;
  reportCount: number;
  reports: Array<{ reason: ReferralReportReason; note: string | null; createdAt: string }>;
  /** Pending first review, or approved and hidden by reports. */
  queue: 'new' | 'reported';
}

export interface ReferralQueueResponse {
  items: ReferralQueueItem[];
  cursor: string | null;
}

export const CN_REFERRALS_ERROR_CODES = {
  notFound: 'referral_code_not_found',
  duplicate: 'referral_code_duplicate',
  shareLimit: 'referral_share_limit',
  contactDetails: 'referral_contact_details',
  alreadyReported: 'referral_already_reported',
  storageUnavailable: 'referral_storage_unavailable',
} as const;
