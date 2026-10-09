'use client';

// components/features/filters/useFilterLabels.ts — plain-language labels for
// filter fields and values (chips, FilterDiff, quick-bar buttons). WP-20.
//
// Values come from the user's own filters or from our taxonomy; countries and
// money are formatted by the browser's Intl for the UI locale. Nothing here
// renders a number that is not the user's own input.

import { useCallback, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { useTaxonomyLabels } from '../../../hooks/search/useFilterQueries';
import { distanceUnitFor, radiusInUnit, type FilterField, type FilterLocation, type FilterSet } from '../../../hooks/search/filterModel';

export interface FilterLabels {
  field: (field: FilterField) => string;
  /** One list item, or a scalar value, of `field`. */
  value: (field: FilterField, value: unknown, fs?: FilterSet) => string;
  country: (code: string) => string;
  radius: (km: FilterLocation['radiusKm'], country?: string | null) => string;
  money: (amount: number, currency: string) => string;
}

export function useFilterLabels(): FilterLabels {
  const t = useTranslations('filters');
  const locale = useLocale();
  const taxonomy = useTaxonomyLabels();

  const regions = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      return null;
    }
  }, [locale]);

  const country = useCallback((code: string) => regions?.of(code) ?? code, [regions]);

  const money = useCallback(
    (amount: number, currency: string) => {
      try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
      } catch {
        return `${amount} ${currency}`;
      }
    },
    [locale],
  );

  const radius = useCallback(
    (km: FilterLocation['radiusKm'], c?: string | null) => {
      if (km === 0) return t('options.radiusSameCity');
      const unit = distanceUnitFor(c);
      const distance = radiusInUnit(km, unit);
      return unit === 'mi' ? t('options.radiusMi', { distance }) : t('options.radiusKm', { distance });
    },
    [t],
  );

  const field = useCallback((f: FilterField) => t(`fields.${f}`), [t]);

  const option = useCallback(
    (group: string, key: string) => {
      const path = `options.${group}.${key}`;
      return t.has(path) ? t(path) : key;
    },
    [t],
  );

  const value = useCallback(
    (f: FilterField, v: unknown, fs?: FilterSet): string => {
      switch (f) {
        case 'taxonomyIds':
          return taxonomy.get(String(v)) ?? String(v);
        case 'jobTypes':
        case 'workModels':
        case 'seniority':
        case 'excludeRequirements':
        case 'companySizes':
        case 'employerTags':
        case 'degree':
        case 'employmentType':
        case 'schoolTiers':
          return option(f, String(v));
        case 'roleType':
          return option('roleType', String(v));
        case 'fitTier':
          return option('fitTier', String(v));
        case 'postedWithinDays':
          return option('postedWithinDays', String(v));
        case 'country':
          return country(String(v));
        case 'locations': {
          const l = v as FilterLocation;
          return `${l.label} · ${radius(l.radiusKm, l.country ?? fs?.country)}`;
        }
        case 'salaryMin': {
          const s = v as NonNullable<FilterSet['salaryMin']>;
          return t('chips.payValue', { amount: money(s.amount, s.currency), period: t(`options.payPeriod.${s.period}`) });
        }
        case 'dailyPay':
          return t('chips.dailyPayValue', { amount: money((v as { min: number }).min, 'CNY') });
        case 'salaryMonthsMin':
          return t('options.salaryMonths', { months: Number(v) });
        case 'classYear':
          return t('options.classYear', { year: Number(v) });
        case 'yearsRange': {
          const r = v as { min?: number; max?: number };
          if (r.min !== undefined && r.max !== undefined) return t('chips.yearsValue', { min: r.min, max: r.max });
          if (r.min !== undefined) return t('chips.yearsMin', { min: r.min });
          return t('chips.yearsMax', { max: r.max ?? 0 });
        }
        case 'internDays': {
          const r = v as { min?: number; max?: number };
          return t('chips.internDaysValue', { min: r.min ?? 1, max: r.max ?? 7 });
        }
        case 'recruiterJobsOnly':
          return t('chips.recruiterOnly');
        case 'excludeAgencies':
          return t('chips.noAgencies');
        case 'includeUndisclosedPay':
          return v === false ? t('chips.listedPayOnly') : t('options.any');
        case 'needsSponsorship':
          return t('chips.sponsorshipNeeded');
        case 'hukouTag':
          return t('chips.hukouOnly');
        default:
          return typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v);
      }
    },
    [t, taxonomy, option, country, radius, money],
  );

  return { field, value, country, radius, money };
}
