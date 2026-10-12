'use client';

// components/features/filters/FilterDiff.tsx — "What will change" (PRODUCT
// F-FEED-11, F-ORION-04). Shows, field by field, exactly which filters a
// change adds, removes or changes BEFORE anything is saved. Reused by the
// Assistant's diff card (WP-51) and the "Not interested" sheet (WP-33); the
// caller owns the confirm button and saves with useApplyFilters().
//
//   <FilterDiff before={profile.filters} after={proposed} />
//   <FilterDiff changes={serverDiff} filters={profile.filters} />

import { useTranslations } from 'next-intl';

import { diffFilters, type FilterChange, type FilterSet } from '../../../hooks/search/filterModel';
import { cn } from '../../../lib/utils';
import { useFilterLabels } from './useFilterLabels';
import styles from './filters.module.css';

export interface FilterDiffProps {
  before?: FilterSet;
  after?: FilterSet;
  /** Precomputed changes (e.g. the server's `diffFilterSets`). */
  changes?: FilterChange[];
  /** Context for value labels (country for radius units). */
  filters?: FilterSet;
  title?: string;
  className?: string;
}

interface DiffLine {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  text: string;
}

export function FilterDiff({ before = {}, after = {}, changes, filters, title, className }: FilterDiffProps) {
  const t = useTranslations('filters.diff');
  const labels = useFilterLabels();
  const list = changes ?? diffFilters(before, after);
  const ctx = filters ?? after;

  const lines: DiffLine[] = [];
  for (const c of list) {
    const field = labels.field(c.field);
    if (c.addedItems || c.removedItems) {
      for (const item of c.addedItems ?? []) lines.push({ key: `${c.field}+${JSON.stringify(item)}`, kind: 'added', text: t('setTo', { field, value: labels.value(c.field, item, ctx) }) });
      for (const item of c.removedItems ?? []) lines.push({ key: `${c.field}-${JSON.stringify(item)}`, kind: 'removed', text: t('setTo', { field, value: labels.value(c.field, item, ctx) }) });
      continue;
    }
    if (c.kind === 'added') lines.push({ key: c.field, kind: 'added', text: t('setTo', { field, value: labels.value(c.field, c.to, ctx) }) });
    else if (c.kind === 'removed') lines.push({ key: c.field, kind: 'removed', text: t('cleared', { field }) });
    else lines.push({ key: c.field, kind: 'changed', text: t('fromTo', { field, from: labels.value(c.field, c.from, ctx), to: labels.value(c.field, c.to, ctx) }) });
  }

  const kindClass = { added: styles.diffAdd, removed: styles.diffRemove, changed: styles.diffChange } as const;
  const kindLabel = { added: t('added'), removed: t('removed'), changed: t('changed') } as const;

  return (
    <section className={cn(styles.diff, className)} aria-label={title ?? t('title')}>
      <h3 className={styles.diffTitle}>{title ?? t('title')}</h3>
      {lines.length === 0 ? (
        <p className={styles.help}>{t('none')}</p>
      ) : (
        <ul className={styles.diffList}>
          {lines.map((l) => (
            <li key={l.key} className={styles.diffRow}>
              <span className={cn(styles.diffKind, kindClass[l.kind])}>{kindLabel[l.kind]}</span>
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
