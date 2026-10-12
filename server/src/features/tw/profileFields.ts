// server/src/features/tw/profileFields.ts
//
// Taiwan profile deltas (CN_TW_LAUNCH_PLAN.md §TW profile deltas; FEATURE_CATALOG
// TW-04, TW-09; TASK_PLAN.md WP-19). RoboApply serves Taiwan, so these fields
// live on the RoboApply profile, never on GoApply:
//
//   希望職稱 / 職類   desired titles (free text, ≤5) and optional taxonomy ids
//   希望地點          desired places: Taiwan's 22 county/city codes (multi)
//   希望待遇          expected pay: a monthly or annual NT$ range, or the two
//                     wordings Taiwanese forms use instead of a number:
//                     面議 (`negotiable`) and 依公司規定 (`company_policy`)
//   工作許可           work permit status for foreign nationals, stored on the
//                     profile's Taiwan work-authorization row (`workAuth[].permit`)
//
// These are the user's own answers. Nothing here is inferred, and the permit
// status is a question the user answers (ruling C18), never a label we derive.
// Job-side permit tags (可協助申請工作許可 / 就業金卡) come only from posting
// quotes and live with the jobs plan, not here.

import { z } from 'zod';

/** Taiwan's 22 special municipalities, counties and cities (ISO 3166-2:TW codes). */
export const TW_COUNTIES = [
  'TPE', // 臺北市 Taipei City
  'NWT', // 新北市 New Taipei City
  'KEE', // 基隆市 Keelung City
  'TAO', // 桃園市 Taoyuan City
  'HSZ', // 新竹市 Hsinchu City
  'HSQ', // 新竹縣 Hsinchu County
  'MIA', // 苗栗縣 Miaoli County
  'TXG', // 臺中市 Taichung City
  'CHA', // 彰化縣 Changhua County
  'NAN', // 南投縣 Nantou County
  'YUN', // 雲林縣 Yunlin County
  'CYI', // 嘉義市 Chiayi City
  'CYQ', // 嘉義縣 Chiayi County
  'TNN', // 臺南市 Tainan City
  'KHH', // 高雄市 Kaohsiung City
  'PIF', // 屏東縣 Pingtung County
  'ILA', // 宜蘭縣 Yilan County
  'HUA', // 花蓮縣 Hualien County
  'TTT', // 臺東縣 Taitung County
  'PEN', // 澎湖縣 Penghu County
  'KIN', // 金門縣 Kinmen County
  'LIE', // 連江縣 Lienchiang County
] as const;
export type TwCounty = (typeof TW_COUNTIES)[number];

/** Pseudo-location for "remote / anywhere in Taiwan". */
export const TW_ANYWHERE = 'ANY' as const;

/**
 * 工作許可 status for a person who wants to work in Taiwan (TW-09):
 *   citizen_or_resident — 本國籍 or a resident who needs no work permit
 *   work_permit_needed  — needs the employer to apply for a work permit
 *   gold_card           — holds an Employment Gold Card (就業金卡)
 */
export const TW_WORK_PERMIT_STATUSES = ['citizen_or_resident', 'work_permit_needed', 'gold_card'] as const;
export type TwWorkPermitStatus = (typeof TW_WORK_PERMIT_STATUSES)[number];

/** Upper bounds that keep a typo (an extra zero) from being stored as an answer. */
export const TW_PAY_LIMITS = { monthlyMax: 2_000_000, annualMax: 30_000_000 } as const;

const PayRange = (max: number) =>
  z
    .object({
      min: z.number().int().min(0).max(max).nullable(),
      max: z.number().int().min(0).max(max).nullable(),
    })
    .strict()
    .refine((v) => v.min !== null || v.max !== null, { message: 'Give a lower or an upper amount.' })
    .refine((v) => v.min === null || v.max === null || v.min <= v.max, { message: 'The lower amount must not exceed the upper amount.' });

/** 希望待遇: a stated NT$ range, 面議, or 依公司規定. Currency is always TWD. */
export const TwDesiredPaySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly'), range: PayRange(TW_PAY_LIMITS.monthlyMax) }).strict(),
  z.object({ kind: z.literal('annual'), range: PayRange(TW_PAY_LIMITS.annualMax) }).strict(),
  /** 面議 */
  z.object({ kind: z.literal('negotiable') }).strict(),
  /** 依公司規定 */
  z.object({ kind: z.literal('company_policy') }).strict(),
]);
export type TwDesiredPay = z.infer<typeof TwDesiredPaySchema>;

const LocationCode = z.union([z.enum(TW_COUNTIES), z.literal(TW_ANYWHERE)]);

/** `RAProfile.twFields` (schema request SR-WP19-1): the RoboApply-Taiwan profile deltas. */
export const TwProfileFieldsSchema = z
  .object({
    /** 希望職稱 — the user's own words, up to five. */
    desiredTitles: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
    /** 希望職類 — taxonomy role ids picked from the typeahead (optional). */
    desiredCategoryIds: z.array(z.string().min(1).max(80)).max(3).optional(),
    /** 希望地點 — county/city codes, or `ANY`. */
    desiredLocations: z
      .array(LocationCode)
      .max(TW_COUNTIES.length + 1)
      .refine((v) => new Set(v).size === v.length, { message: 'Each place only once.' })
      .optional(),
    /** 希望待遇 */
    desiredPay: TwDesiredPaySchema.nullable().optional(),
  })
  .strict();
export type TwProfileFields = z.infer<typeof TwProfileFieldsSchema>;

/** True when a TW profile delta carries at least one answer. */
export function hasTwAnswers(fields: TwProfileFields | null | undefined): boolean {
  if (!fields) return false;
  return Boolean(
    (fields.desiredTitles?.length ?? 0) > 0 ||
      (fields.desiredCategoryIds?.length ?? 0) > 0 ||
      (fields.desiredLocations?.length ?? 0) > 0 ||
      fields.desiredPay,
  );
}

/**
 * Tolerant read of a stored value: returns the parsed fields, or null when the
 * stored JSON is absent or malformed (a bad row never breaks the profile page).
 */
export function readTwProfileFields(raw: unknown): TwProfileFields | null {
  if (raw === null || raw === undefined) return null;
  const parsed = TwProfileFieldsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Should the profile offer the Taiwan section? Only on the international
 * brand, and only when Taiwan is relevant to this person: they live there,
 * answered the Taiwan work-authorization question, use zh-TW, or already
 * filled the section. Pure; the web mirrors it.
 */
export function isTaiwanRelevant(input: {
  market: 'intl' | 'cn';
  country?: string | null;
  workAuthCountries?: readonly string[];
  locale?: string | null;
  hasAnswers?: boolean;
}): boolean {
  if (input.market !== 'intl') return false;
  if (input.hasAnswers) return true;
  if (input.country === 'TW') return true;
  if (input.workAuthCountries?.includes('TW')) return true;
  return input.locale === 'zh-TW';
}
