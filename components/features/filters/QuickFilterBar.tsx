'use client';

// components/features/filters/QuickFilterBar.tsx — quick buttons (PRODUCT
// F-FILT-05): Location · Level · Job type · Work model · Date posted · Pay,
// then "All filters (N)" which opens the drawer. A quick button opens a sheet
// with just that field's controls; Apply saves only what changed, in one
// PATCH with `baseVersion`. The bar scrolls sideways inside its own bounds on
// a phone (never the page).

import { useState, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';

import { Sheet } from '../../v3/primitives/Sheet';
import { Btn } from '../../v3/primitives/Btn';
import { toast } from '../../v3/primitives/Toast';
import { cn } from '../../../lib/utils';
import { useApplyFilters } from '../../../hooks/search/useApplyFilters';
import { activeFilterCount, mergePatch, patchBetween, type FilterField, type FilterSet, type FilterSetPatch, type Market } from '../../../hooks/search/filterModel';
import type { SearchProfile } from '../../../hooks/search/useSearchProfiles';
import {
  DailyPayEditor,
  EmploymentTypeEditor,
  JobTypeEditor,
  ListedPayEditor,
  LocationEditor,
  PayEditor,
  PostedEditor,
  SalaryMonthsEditor,
  SeniorityEditor,
  WorkModelEditor,
  type EditorProps,
} from './FilterEditors';
import { FiltersDrawer } from './FiltersDrawer';
import { useEditorContext } from './FilterSections';
import styles from './filters.module.css';

export type QuickFilterId = 'location' | 'level' | 'jobType' | 'workModel' | 'posted' | 'pay';

interface QuickDef {
  id: QuickFilterId;
  labelKey: string;
  fields: FilterField[];
  editors: ComponentType<EditorProps>[];
}

export function quickFilters(market: Market): QuickDef[] {
  return [
    { id: 'location', labelKey: 'quick.location', fields: ['country', 'locations'], editors: [LocationEditor] },
    { id: 'level', labelKey: 'quick.level', fields: ['seniority'], editors: [SeniorityEditor] },
    market === 'cn'
      ? { id: 'jobType', labelKey: 'quick.jobType', fields: ['employmentType', 'jobTypes'], editors: [EmploymentTypeEditor, JobTypeEditor] }
      : { id: 'jobType', labelKey: 'quick.jobType', fields: ['jobTypes'], editors: [JobTypeEditor] },
    { id: 'workModel', labelKey: 'quick.workModel', fields: ['workModels'], editors: [WorkModelEditor] },
    { id: 'posted', labelKey: 'quick.posted', fields: ['postedWithinDays'], editors: [PostedEditor] },
    market === 'cn'
      ? { id: 'pay', labelKey: 'quick.pay', fields: ['salaryMin', 'dailyPay', 'salaryMonthsMin', 'includeUndisclosedPay'], editors: [PayEditor, DailyPayEditor, SalaryMonthsEditor, ListedPayEditor] }
      : { id: 'pay', labelKey: 'quick.pay', fields: ['salaryMin', 'includeUndisclosedPay'], editors: [PayEditor, ListedPayEditor] },
  ];
}

function isSet(fs: FilterSet, fields: FilterField[]): boolean {
  return fields.some((f) => {
    const v = (fs as Record<string, unknown>)[f];
    if (f === 'includeUndisclosedPay') return v === false;
    return v !== undefined && !(Array.isArray(v) && v.length === 0);
  });
}

export interface QuickFilterBarProps {
  profile: SearchProfile | null;
  /** Called after any saved change (the feed refetches on its own; this is for analytics or focus). */
  onApplied?: (profile: SearchProfile) => void;
}

export function QuickFilterBar({ profile, onApplied }: QuickFilterBarProps) {
  const t = useTranslations('filters');
  const ctx = useEditorContext();
  const { apply, isPending } = useApplyFilters();
  const [openId, setOpenId] = useState<QuickFilterId | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<FilterSet>({});
  const [error, setError] = useState<string | null>(null);

  const filters = profile?.filters ?? {};
  const defs = quickFilters(ctx.market);
  const current = defs.find((d) => d.id === openId) ?? null;
  const total = activeFilterCount(filters);

  const openQuick = (id: QuickFilterId) => {
    setDraft(filters);
    setError(null);
    setOpenId(id);
  };

  const onApply = async () => {
    if (!profile || !current) return;
    const patch = patchBetween(profile.filters, draft);
    if (!Object.keys(patch).length) {
      setOpenId(null);
      return;
    }
    const result = await apply({ profile, patch, defaultCountry: ctx.defaultCountry });
    if (result.ok) {
      if (result.sponsorshipSynced === false) toast({ message: t('drawer.sponsorshipNotSynced'), tone: 'warn' });
      onApplied?.(result.profile);
      setOpenId(null);
    } else if (result.conflict) {
      setDraft(result.conflict.filters);
      setError(t('drawer.conflict'));
    } else {
      setError(t('drawer.saveFailed'));
    }
  };

  return (
    <>
      <ul className={styles.quickBar} aria-label={t('quick.label')}>
        {defs.map((d) => {
          const on = isSet(filters, d.fields);
          return (
            <li key={d.id}>
              <button
                type="button"
                className={cn(styles.quickBtn, on && styles.quickBtnActive)}
                aria-haspopup="dialog"
                aria-pressed={on}
                onClick={() => openQuick(d.id)}
                disabled={!profile}
              >
                {t(d.labelKey)}
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className={cn(styles.quickBtn, total > 0 && styles.quickBtnActive)} aria-haspopup="dialog" onClick={() => setDrawerOpen(true)} disabled={!profile}>
            {t('drawer.openButton')}
            {total > 0 ? (
              <span className={styles.badge} aria-hidden="true">
                {total}
              </span>
            ) : null}
            {total > 0 ? <span className={styles.hidden}>{t('drawer.openButtonCount', { count: total })}</span> : null}
          </button>
        </li>
      </ul>

      <Sheet
        open={!!current}
        onClose={() => setOpenId(null)}
        title={current ? t(current.labelKey) : undefined}
        footer={
          <div className={styles.footer}>
            {error ? (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            ) : null}
            <div className={styles.footerRow}>
              <Btn variant="ghost" onClick={() => setOpenId(null)}>
                {t('quick.cancel')}
              </Btn>
              <Btn variant="primary" onClick={() => void onApply()} disabled={isPending}>
                {isPending ? t('drawer.saving') : t('quick.apply')}
              </Btn>
            </div>
          </div>
        }
      >
        {current ? (
          <div className={styles.drawerBody}>
            {current.editors.map((E, i) => (
              <E key={i} draft={draft} set={(p: FilterSetPatch) => setDraft((d) => mergePatch(d, p))} ctx={ctx} />
            ))}
          </div>
        ) : null}
      </Sheet>

      <FiltersDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} profile={profile} onApplied={onApplied} />
    </>
  );
}
