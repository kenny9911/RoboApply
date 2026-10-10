'use client';

// components/features/seo/labels.ts — locale-aware labels for the public
// SEO views: role and city names from the taxonomy / city table (the API
// sends English and Chinese), money, dates and pay lines. No data of its own.

import { useFormatter, useLocale, useTranslations } from 'next-intl';

import type { PublicPay } from '../../../lib/api/contracts/seo';

export { cityLabel, countryLabel, roleLabel } from './names';

export function useSeoFormat() {
  const t = useTranslations('seo');
  const format = useFormatter();
  const locale = useLocale();
  const money = (amount: number, currency: string) => {
    try {
      return format.number(amount, { style: 'currency', currency, maximumFractionDigits: 0 });
    } catch {
      return `${currency} ${format.number(amount)}`;
    }
  };
  const date = (iso: string | null | undefined) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : format.dateTime(d, { dateStyle: 'medium' });
  };
  /** The pay line exactly as disclosed ("$120,000 – $150,000 a year"), or null. */
  const pay = (p: PublicPay | null) => {
    if (!p) return null;
    const period = ['year', 'month', 'week', 'day', 'hour'].includes(p.period) ? t(`pay.period.${p.period as 'year'}`) : '';
    if (p.min != null && p.max != null && p.min !== p.max) return t('pay.range', { min: money(p.min, p.currency), max: money(p.max, p.currency), period });
    const amount = p.min ?? p.max;
    return amount == null ? null : t('pay.single', { amount: money(amount, p.currency), period });
  };
  const workModel = (w: string | null) => (w === 'remote' || w === 'hybrid' ? t(`workModel.${w}`) : w === 'onsite' ? t('workModel.office') : null);
  const employment = (e: string | null) => (e && ['full_time', 'part_time', 'contract', 'internship'].includes(e) ? t(`employment.${e as 'full_time'}`) : null);
  return { t, locale, money, date, pay, workModel, employment };
}
