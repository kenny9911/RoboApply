// server/src/features/tw/contract.ts — wire contract of the Taiwan routes
// (MKT-5F; MARKET_STRATEGY §9.5 JT-6, JT-7). Types and zod only: the web reads
// these shapes through lib/api/tw.ts.
//
//   GET /api/v1/roboapply/tw/pay-rule          → TwPayRuleView | null
//   GET /api/v1/roboapply/tw/districts         → TwDistrictsResponse
//   GET /api/v1/roboapply/admin/tw/pay-rule    → TwPayRuleAdminView
//   PUT /api/v1/roboapply/admin/tw/pay-rule    PutTwPayRuleBody → TwPayRuleAdminView
//
// All four answer 404 feature_disabled on GoApply: the rule and the district
// table belong to the international brand's Taiwan market.

import { z } from 'zod';

/** AppConfig key of the pay-disclosure rule. */
export const TW_PAY_RULE_CONFIG_KEY = 'tw.payRule.v1';

/** Bounds of an admin's entry (the statutory amount is a round number of thousands). */
export const TW_PAY_RULE_LIMITS = {
  minTwd: 10_000,
  maxTwd: 200_000,
  stepTwd: 1_000,
  lawLabelMax: 120,
  sourceUrlMax: 500,
} as const;

/**
 * The pay-disclosure rule as the note shows it (JT-6). It explains why a
 * posting may say 面議: 就業服務法 lets an employer leave pay unlisted only at
 * or above this monthly amount. It is the law's number, never a job's pay: it
 * is not shown on a job as its pay, not used as a filter value and not written
 * to a job row.
 */
export interface TwPayRuleView {
  /** The statutory monthly amount in whole New Taiwan dollars. */
  thresholdTwd: number;
  /** The provision, in the law's own words (就業服務法第5條第2項第6款): data, not UI copy. */
  lawLabel: string;
  /** Where the rule can be read (https). */
  sourceUrl: string;
  /** The day the rule was read as being in force: YYYY-MM-DD. */
  asOf: string;
  /** True when no admin has stored a rule: the answer is the law in force as read on `asOf`. */
  isDefault: boolean;
}

export interface TwPayRuleAdminView {
  /** What the public route answers right now; null when the stored value cannot be read (the note then shows no amount). */
  rule: TwPayRuleView | null;
  /** `config`: an admin's stored rule. `default`: nothing stored. `invalid`: a stored value that does not pass the rules of the PUT. */
  stored: 'config' | 'default' | 'invalid';
  updatedAt: string | null;
  updatedBy: string | null;
  /** The value used when nothing is stored. */
  default: Omit<TwPayRuleView, 'isDefault'>;
  limits: typeof TW_PAY_RULE_LIMITS;
}

/**
 * PUT /admin/tw/pay-rule. Shape only; the rules that need a clock or a table
 * (whole thousands inside the bounds, an https link, a real date that is not
 * in the future) are checked by `validateTwPayRule` (payRule.ts), which
 * answers 422 with one issue per field.
 */
export const PutTwPayRuleBodySchema = z
  .object({
    thresholdTwd: z.number(),
    lawLabel: z.string(),
    sourceUrl: z.string(),
    asOf: z.string(),
  })
  .strict();
export type PutTwPayRuleBody = z.infer<typeof PutTwPayRuleBodySchema>;

/** One district (鄉鎮市區) of a county. Names are data of the postal list, not UI copy. */
export interface TwDistrictView {
  /** As the postal list writes it, and as a job row stores it (竹北市). */
  name: string;
  /** The filter value: `<county><district>` (新竹縣竹北市). */
  value: string;
  /** First three digits of the postal code. Districts of one city can share a code (新竹市, 嘉義市). */
  zip3: string;
  /** The postal list's English name, when it gives one ("Zhubei City, Hsinchu County"). */
  en: string | null;
}

export interface TwCountyView {
  /** The open-data interface's county code: two digits. */
  code: string;
  /** As the interface document writes it (台北市). */
  name: string;
  /** The 臺 spelling when it differs (臺北市), else null. */
  nameAlt: string | null;
  /**
   * Folded names a place someone typed may match to mean this county (its two
   * spellings, the English city name, common aliases). Compare with the same
   * folding: lib/api/tw.ts `twPlaceKey`.
   */
  keys: string[];
  districts: TwDistrictView[];
}

/** GET /tw/districts: the 22 counties, each with its districts. */
export interface TwDistrictsResponse {
  /** The table's as-of date (YYYY-MM-DD). */
  asOf: string;
  /**
   * Where the district names come from (D3): 中華郵政's published list, under
   * 政府資料開放授權條款 第1版. The licence allows reuse only with attribution, so
   * a screen that lists these names prints `attribution` (the licence's
   * required wording, in Traditional Chinese for every locale: data, not UI
   * copy), linked to `licenseUrl`. Null when the table carries none.
   */
  source: { name: string; publisher: string; url: string; license: string; licenseUrl: string | null; retrievedOn: string; attribution: string | null };
  counties: TwCountyView[];
}
