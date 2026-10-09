// server/src/features/offers/contract.ts
//
// Offer comparison (TASK_PLAN.md WP-64; capability `offers`). Mount:
// /api/v1/roboapply/offers. Offers are user-entered on tracker entries and
// written through `tracker.updateOffer()`. The negotiation draft is grounded
// only in posted ranges for the role with N shown (n ≥ MIN_SAMPLE = 20);
// below that it says there is not enough data.

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const OfferEntryParamsSchema = z.object({ trackerEntryId: Id });

/** GoApply fields: 月薪·N薪, 年终, 五险一金 base, 公积金 %, 户口, 签字费, 期权. */
export const CnOfferFieldsSchema = z
  .object({
    monthlyBase: z.number().positive().optional(),
    salaryMonths: z.number().int().min(12).max(20).optional(),
    yearEndBonus: z.string().max(200).optional(),
    socialInsuranceBase: z.number().positive().optional(),
    housingFundPercent: z.number().min(0).max(12).optional(),
    hukou: z.boolean().optional(),
    signingBonus: z.number().min(0).optional(),
    equity: z.string().max(200).optional(),
  })
  .strict();

export const PutOfferBodySchema = z
  .object({
    base: z.number().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    period: z.enum(['year', 'month', 'hour']),
    bonus: z.string().max(200).optional(),
    equity: z.string().max(200).optional(),
    deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().max(2000).optional(),
    cn: CnOfferFieldsSchema.optional(),
  })
  .strict();

export interface OfferView {
  trackerEntryId: string;
  jobId: string | null;
  title: string;
  companyName: string;
  offer: z.infer<typeof PutOfferBodySchema>;
  updatedAt: string;
}

export const CompareOffersBodySchema = z.object({ trackerEntryIds: z.array(Id).min(2).max(5) }).strict();
export interface OfferComparison {
  rows: Array<{ key: string; label: string; values: Array<string | number | null> }>;
  /** Annualized totals computed only from what the user entered. */
  annualized: Array<{ trackerEntryId: string; value: number | null; currency: string }>;
}

/** Negotiation draft: posted range for the role with N; null below MIN_SAMPLE. */
export interface NegotiationDraft {
  text: string;
  aiWritten: true;
  postedRange: { low: number; high: number; currency: string; period: string; sampleSize: number; source: 'index'; asOf: string } | null;
}

export const OFFERS_ERROR_CODES = {
  notFound: 'offer_not_found',
} as const;
