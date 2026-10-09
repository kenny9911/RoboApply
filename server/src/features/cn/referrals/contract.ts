// server/src/features/cn/referrals/contract.ts
//
// GoApply 内推码 hub: user-contributed referral codes with company,
// programme and expiry, moderated and reportable (TASK_PLAN.md WP-54;
// capability `cn.referralCodes`, separate from the invite-friends `invites`).
// Mount: /api/v1/roboapply/cn/referrals.
//
// Honesty: a code is shown as "shared by a %BRAND% user" with its date; we
// never claim a code works or that a referral leads to an interview.

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
export const ReportReferralCodeBodySchema = z
  .object({ reason: z.enum(REFERRAL_REPORT_REASONS), note: z.string().max(500).optional() })
  .strict();

export interface ReferralCodeView {
  id: string;
  company: string;
  code: string;
  programme: string | null;
  expiresAt: string | null;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  sharedAt: string;
  mine: boolean;
}

export const CN_REFERRALS_ERROR_CODES = {
  notFound: 'referral_code_not_found',
  duplicate: 'referral_code_duplicate',
} as const;
