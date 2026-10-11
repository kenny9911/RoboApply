// components/features/credits/labels.ts — message keys and small pure helpers
// shared by the billing and credits views (WP-21b). No numbers are made up
// here: prices, caps and dates all come from the server.

import type { BrandId } from '../../../lib/brand/registry.generated';
import { formatMoney } from '../../../lib/pricing';

/** Credit buckets with a label under `credits.buckets.*` (R-07 names). */
export const BUCKET_LABEL_KEYS = [
  'fit_analysis',
  'tailor',
  'cover_letter',
  'resume_check',
  'rewrite',
  'outreach',
  'assistant',
  'autofill',
  'ai_answer',
  'job_import',
  'ready_kits',
  'competitiveness',
  'contact_lookup',
  'practice',
] as const;

/** Display order of the credits list (what people use most first). */
export const BUCKET_ORDER: readonly string[] = [
  'fit_analysis',
  'tailor',
  'cover_letter',
  'resume_check',
  'rewrite',
  'assistant',
  'outreach',
  'job_import',
  'ready_kits',
  'autofill',
  'ai_answer',
  'competitiveness',
];

/** Key of a bucket's label (falls back to a generic "This action"). */
export function bucketLabelKey(bucket: string): string {
  return (BUCKET_LABEL_KEYS as readonly string[]).includes(bucket) ? `buckets.${bucket}` : 'buckets.unknown';
}

const PLAN_KEYS_BY_BRAND: Record<BrandId, readonly string[]> = {
  roboapply: ['free', 'pro_weekly', 'pro_monthly', 'pro_quarterly', 'pro_week_pass', 'practice_pack_5', 'practice_pack_15', 'student_monthly', 'student_quarterly'],
  // GoApply's student plans are passes too (学生月卡 30 days, 学生季卡 90 days).
  goapply: ['free', 'pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15', 'student_monthly', 'student_quarterly'],
};

export const LEGACY_PLAN_KEYS = ['starter', 'growth'] as const;

/**
 * Key of a plan's display name under `credits.plans.*`. GoApply's `pro_*`
 * plans are one-time passes, so names are per brand. Legacy practice plans
 * read "Practice plan (legacy)". Unknown keys → null (caller shows "—").
 */
export function planNameKey(brand: BrandId, planKey: string | null | undefined, legacy = false): string | null {
  if (!planKey) return null;
  if (legacy || (LEGACY_PLAN_KEYS as readonly string[]).includes(planKey)) return 'plans.legacy';
  return PLAN_KEYS_BY_BRAND[brand].includes(planKey) ? `plans.${brand}.${planKey}` : null;
}

/** Months a multi-month plan covers (for "Save N%"). */
export function planMonths(plan: { key: string; interval: string | null; passDays: number | null }): number {
  if (plan.interval === 'quarter' || plan.passDays === 90) return 3;
  return 0;
}

/** Period for "renews every {period}" and the price suffix. */
export type PricePeriod = 'week' | 'month' | 'quarter' | 'once';

export function pricePeriod(plan: { kind: string; interval: string | null }): PricePeriod {
  if (plan.kind === 'subscription') {
    if (plan.interval === 'week') return 'week';
    if (plan.interval === 'quarter') return 'quarter';
    return 'month';
  }
  return 'once';
}

/** An amount the server sent, formatted; "—" only when a caller has none to show (never a stand-in for a price that is "not set"). */
export function money(locale: string, amountMinor: number | null | undefined, currency: string): string {
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor)) return '—';
  return formatMoney(locale, amountMinor, currency);
}

/** A parsed ISO time, or null. */
export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `timeZone` when this runtime knows it, else `fallback` (and `undefined` = the device's zone). */
export function knownTimeZone(timeZone: string | null | undefined, fallback?: string | null): string | undefined {
  for (const zone of [timeZone, fallback]) {
    if (typeof zone !== 'string' || !zone.trim()) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() });
      return zone.trim();
    } catch {
      // not an IANA zone this runtime knows; try the next one
    }
  }
  return undefined;
}

/** Calendar days from `now` to `at` as the wall clock in `timeZone` shows them (0 = the same day, 1 = the next day). */
export function calendarDaysUntil(at: Date, now: Date, timeZone?: string): number {
  const dayNumber = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000);
  };
  return dayNumber(at) - dayNumber(now);
}

/**
 * When a credit window refills, for "Refills {when}" and "Wait until {when}":
 *
 *   later the same day   "11:30 PM"                (a bare time means today)
 *   the next day         "tomorrow 12:00 AM"       (the locale's own word)
 *   after that           "Mon, Oct 19, 12:00 AM"   (weekday with its date)
 *
 * A bare weekday ("Mon 12:00 AM") on a daily row read like a weekly reset.
 * Pass the zone the server used to place the window (`summary.timezone`), so
 * a daily refill reads as midnight and "tomorrow" is the account's tomorrow.
 */
export function refillLabel(input: { at: Date; now: Date; locale: string; timeZone?: string | null }): string {
  const timeZone = knownTimeZone(input.timeZone);
  const time = new Intl.DateTimeFormat(input.locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(input.at);
  const days = input.at.getTime() > input.now.getTime() ? calendarDaysUntil(input.at, input.now, timeZone) : -1;
  if (days === 0) return time;
  if (days === 1) return `${new Intl.RelativeTimeFormat(input.locale, { numeric: 'auto' }).format(1, 'day')} ${time}`;
  return new Intl.DateTimeFormat(input.locale, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(input.at);
}
