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
  goapply: ['free', 'pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15'],
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
