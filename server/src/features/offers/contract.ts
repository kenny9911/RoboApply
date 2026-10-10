// server/src/features/offers/contract.ts
//
// Offer comparison (TASK_PLAN.md WP-64; capability `offers`). Mount:
// /api/v1/roboapply/offers. Offers are user-entered on tracker entries and
// written through `tracker.updateOffer()` (stored in the documented
// `RATrackerEntry.offer` JSON column).
//
//   GET    /                                   every application with an offer → OffersListResponse
//   POST   /compare                            { trackerEntryIds (2–5) } → OfferComparison (deterministic)
//   POST   /explain                            { trackerEntryIds (2–5) } → OfferExplanation (AI, numbers checked)
//   PUT    /:trackerEntryId                    PutOfferBody → OfferView
//   DELETE /:trackerEntryId                    → { deleted: true }
//   GET    /:trackerEntryId/benchmark          → OfferBenchmark (posted pay for the role; no AI)
//   POST   /:trackerEntryId/negotiation-draft  NegotiationDraftBody → NegotiationDraft (AI, numbers checked)
//
// Honesty (D3): totals are computed only from what the user entered, with the
// assumptions stated (`OfferAssumption`); nothing is converted between
// currencies and equity is never valued. The only market figure is the posted
// pay range for the role from our own index, as `Sourced<number>` with N shown,
// and only when at least MIN_SAMPLE (20) postings list pay in the offer's
// currency; below that it is absent. AI text may only repeat numbers it was
// given (checked in numberGuard.ts; a draft that adds a number is refused).

import { z } from 'zod';
import type { Sourced } from '../../platform/http.js';

const Id = z.string().min(1).max(64);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Money = z.number().finite().min(0).max(1_000_000_000);

export const OfferEntryParamsSchema = z.object({ trackerEntryId: Id });

export const OFFER_PERIODS = ['year', 'month', 'hour'] as const;
export type OfferPeriod = (typeof OFFER_PERIODS)[number];

/** Default working hours a week for an hourly offer when the user gives none (stated as an assumption). */
export const DEFAULT_HOURS_PER_WEEK = 40;
/** Weeks a year used to annualize an hourly offer (stated as an assumption). */
export const WEEKS_PER_YEAR = 52;
/** Months a year for a monthly offer when the user gives no 薪数 (stated as an assumption). */
export const DEFAULT_SALARY_MONTHS = 12;

/**
 * GoApply fields (CN_TW_LAUNCH_PLAN §WP-TRK-CN): 薪数 (N薪), 年终 (as the
 * offer states it), 五险一金 base, 公积金 %, 户口. 月薪 is `base` with
 * `period: 'month'`; 签字费 is `signingBonus`; 期权 is `equity`; 城市 is
 * `location`.
 */
export const CnOfferFieldsSchema = z
  .object({
    /** 薪数: how many months of base pay a year (13薪 = 13). */
    salaryMonths: z.number().int().min(12).max(24).optional(),
    /** 年终 as written in the offer ("2–4 个月", "看绩效"); never counted in totals. */
    yearEndBonus: z.string().trim().max(200).optional(),
    /** 五险一金 contribution base (CNY a month). */
    socialInsuranceBase: Money.optional(),
    /** 公积金 percentage (the company pays the same share as the employee). */
    housingFundPercent: z.number().min(0).max(12).optional(),
    /** 户口: the offer includes a hukou (residence registration). */
    hukou: z.boolean().optional(),
  })
  .strict();
export type CnOfferFields = z.infer<typeof CnOfferFieldsSchema>;

export const PutOfferBodySchema = z
  .object({
    /** Base pay per `period`, before tax. */
    base: z.number().finite().positive().max(1_000_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    period: z.enum(OFFER_PERIODS),
    /** Hourly offers: hours a week (default 40, stated). */
    hoursPerWeek: z.number().min(1).max(80).optional(),
    /** Bonus as the offer states it ("10% target"); shown, not counted. */
    bonus: z.string().trim().max(200).optional(),
    /** Yearly bonus amount in the offer's currency, when the offer names one; counted. */
    bonusAmount: Money.optional(),
    /** One-time signing bonus (签字费); counted in the first year only. */
    signingBonus: Money.optional(),
    /** Equity as the offer states it (期权); shown, never valued. */
    equity: z.string().trim().max(200).optional(),
    /** City or "Remote" (城市). */
    location: z.string().trim().max(120).optional(),
    startDate: DateOnly.optional(),
    /** Reply-by date. */
    deadline: DateOnly.optional(),
    notes: z.string().max(2000).optional(),
    cn: CnOfferFieldsSchema.optional(),
  })
  .strict();
export type OfferInput = z.infer<typeof PutOfferBodySchema>;

export interface OfferView {
  trackerEntryId: string;
  jobId: string | null;
  title: string;
  companyName: string;
  /** The application's tracker stage (an offer can be entered at any stage). */
  status: string;
  offer: OfferInput;
  /** Totals computed from `offer` only (see OfferTotals). */
  totals: OfferTotals;
  updatedAt: string;
}

/** 2–5 different applications (a repeated id would compare an offer with itself). */
/** GET / — the user's offers, plus whether the AI actions can run for them. */
export interface OffersListResponse {
  items: OfferView[];
  /**
   * aiAllowed(user) AND the brand's `ai.text` (the gate the AI routes apply).
   * False (e.g. GoApply without the AI consent) → the UI hides the AI actions.
   */
  aiAvailable: boolean;
}

/** 2–5 different applications (a repeated id would compare an offer with itself). */
export const CompareOffersBodySchema = z
  .object({
    trackerEntryIds: z
      .array(Id)
      .min(2)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Each application can be picked once.' }),
  })
  .strict();
/** Same input as compare: the AI explanation is written over the compared offers. */
export const ExplainOffersBodySchema = CompareOffersBodySchema;

/** Entered values that are shown but not added into totals. */
export type OfferExcludedPart = 'bonus_text' | 'equity' | 'year_end_text' | 'hukou';

/** Totals computed only from the user's numbers (pre-tax, in the offer's own currency). */
export interface OfferTotals {
  trackerEntryId: string;
  currency: string;
  /** base × months (month), × hours × 52 (hour), × 1 (year). */
  baseAnnual: number;
  bonusAnnual: number | null;
  /** 公积金 company part: base × % × 12 (GoApply, when both are entered). */
  housingFundAnnual: number | null;
  signingBonus: number | null;
  /** baseAnnual + bonusAnnual + housingFundAnnual. */
  recurringAnnual: number;
  /** recurringAnnual + signingBonus. */
  firstYear: number;
  excluded: OfferExcludedPart[];
}

export type OfferAssumptionCode =
  | 'pre_tax'
  | 'month_times_months'
  | 'hour_times_hours'
  | 'housing_fund_company_match'
  | 'signing_first_year_only'
  | 'no_currency_conversion'
  | 'equity_not_valued'
  | 'bonus_text_not_counted'
  | 'year_end_text_not_counted';

export interface OfferAssumption {
  code: OfferAssumptionCode;
  /** ICU params for the sentence (months, hours, percent …). */
  params?: Record<string, string | number>;
  /** The offers it applies to (absent = all compared offers). */
  trackerEntryIds?: string[];
}

export type OfferRowKey =
  | 'base'
  | 'bonus'
  | 'bonusAmount'
  | 'signingBonus'
  | 'equity'
  | 'location'
  | 'startDate'
  | 'deadline'
  | 'salaryMonths'
  | 'yearEndBonus'
  | 'socialInsuranceBase'
  | 'housingFundPercent'
  | 'hukou';

export interface OfferComparisonRow {
  key: OfferRowKey;
  /** One value per compared offer, in `offers` order; null = not entered. */
  values: Array<string | number | boolean | null>;
}

export interface OfferComparison {
  offers: OfferView[];
  totals: OfferTotals[];
  /** Only rows at least one offer filled in. */
  rows: OfferComparisonRow[];
  /** Recurring yearly totals (the headline number per offer). */
  annualized: Array<{ trackerEntryId: string; value: number | null; currency: string }>;
  assumptions: OfferAssumption[];
  sameCurrency: boolean;
  /** Ids with the highest totals; null when the currencies differ (no conversion). */
  highest: { recurringAnnual: string[]; firstYear: string[] } | null;
}

/** Posted pay for the role from our own index (p25 / median / p75 of each posting's range midpoint). */
export interface PostedRange {
  low: Sourced<number>;
  median: Sourced<number>;
  high: Sourced<number>;
  currency: string;
  period: string;
  sampleSize: number;
  source: 'index';
  asOf: string;
}

export type OfferPosition = 'below' | 'within' | 'above';

export interface OfferBenchmark {
  trackerEntryId: string;
  /** Null below MIN_SAMPLE, without a role, or when the index is unavailable (render "Not enough data"). */
  postedRange: PostedRange | null;
  /** Postings that matched the role and place (pay listed or not). */
  totalCount: number;
  /** Of those, postings that list pay in the offer's currency and the reported period. */
  listedCount: number;
  minSample: number;
  scope: { title: string | null; taxonomyId: string | null; country: string | null; city: string | null };
  /** Where the offer's base sits against the posted p25–p75 (null without a range). */
  position: OfferPosition | null;
  /** The offer's base in the range's period (stated factors), null without a range. */
  offerBaseInRangePeriod: number | null;
  reason: 'not_enough_data' | 'no_role' | 'unavailable' | null;
}

export const NEGOTIATION_FOCUS = ['overall', 'base', 'signing_bonus', 'start_date', 'equity'] as const;
export type NegotiationFocus = (typeof NEGOTIATION_FOCUS)[number];

export const NegotiationDraftBodySchema = z
  .object({
    focus: z.enum(NEGOTIATION_FOCUS).optional(),
    /** Other offers of this user the message may mention (their own numbers). */
    compareWith: z.array(Id).max(4).optional(),
  })
  .strict();

/** Negotiation draft: posted range for the role with N; null below MIN_SAMPLE. */
export interface NegotiationDraft {
  /** A message the user can edit and send themselves. */
  text: string;
  talkingPoints?: string[];
  aiWritten: true;
  postedRange: PostedRange | null;
  position?: OfferPosition | null;
}

export interface OfferExplanation {
  /** Plain-language trade-offs between the compared offers. */
  text: string;
  aiWritten: true;
  trackerEntryIds: string[];
}

/** AI calls (draft + explanation) per user per day. */
export const OFFERS_AI_DAILY_LIMIT = 15;

export const OFFERS_ERROR_CODES = {
  notFound: 'offer_not_found',
  entryNotFound: 'tracker_entry_not_found',
  unsupportedNumbers: 'ai_unsupported_numbers',
} as const;
