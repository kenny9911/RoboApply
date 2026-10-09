'use client';

// components/features/filters/ActiveFilterChips.tsx — one removable chip per
// active filter value (PRODUCT F-FILT-05). Removing a chip saves at once:
// one PATCH with `baseVersion` and a FilterSetPatch for that field.

import { useTranslations } from 'next-intl';

import { IconX } from '../../v3/primitives/Iconset';
import { toast } from '../../v3/primitives/Toast';
import { useApplyFilters } from '../../../hooks/search/useApplyFilters';
import { FIELD_ORDER, hiddenFieldsFor, normalizeFilters, type FilterField, type FilterSet, type FilterSetPatch } from '../../../hooks/search/filterModel';
import type { SearchProfile } from '../../../hooks/search/useSearchProfiles';
import { useEditorContext } from './FilterSections';
import { useFilterLabels, type FilterLabels } from './useFilterLabels';
import styles from './filters.module.css';

export interface ActiveChip {
  key: string;
  field: FilterField;
  label: string;
  /** The patch that removes this chip. */
  remove: FilterSetPatch;
}

/** Fields that never get a chip: the fit view has its own control; preferred companies only boost. */
const NO_CHIP: ReadonlySet<FilterField> = new Set<FilterField>(['fitTier', 'preferredCompanies']);
const EXCLUDING: ReadonlySet<FilterField> = new Set<FilterField>(['excludedTitles', 'excludedSkills', 'excludedIndustries', 'excludedCompanies']);

/** The chips for a filter set (pure apart from the labels; exported for tests and the Assistant). */
export function activeChips(
  fs: FilterSet,
  hidden: readonly FilterField[],
  labels: Pick<FilterLabels, 'value'>,
  wrap: { excluded: (v: string) => string; only: (v: string) => string; quoted: (v: string) => string },
): ActiveChip[] {
  const n = normalizeFilters(fs) as Record<string, unknown>;
  const chips: ActiveChip[] = [];
  for (const field of FIELD_ORDER) {
    const v = n[field];
    if (v === undefined || NO_CHIP.has(field) || hidden.includes(field)) continue;
    if (field === 'includeUndisclosedPay' && v !== false) continue;
    if (typeof v === 'boolean' && v === false && field !== 'includeUndisclosedPay') continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const rest = v.filter((_, j) => j !== i);
        let label = labels.value(field, item, fs);
        if (EXCLUDING.has(field)) label = wrap.excluded(label);
        if (field === 'companies') label = wrap.only(label);
        chips.push({ key: `${field}:${i}:${label}`, field, label, remove: { [field]: rest.length ? rest : null } as FilterSetPatch });
      });
      continue;
    }
    const label = field === 'q' ? wrap.quoted(String(v)) : labels.value(field, v, fs);
    chips.push({ key: field, field, label, remove: { [field]: null } as FilterSetPatch });
  }
  return chips;
}

export interface ActiveFilterChipsProps {
  profile: SearchProfile | null;
  onApplied?: (profile: SearchProfile) => void;
}

export function ActiveFilterChips({ profile, onApplied }: ActiveFilterChipsProps) {
  const t = useTranslations('filters');
  const ctx = useEditorContext();
  const labels = useFilterLabels();
  const { apply, isPending } = useApplyFilters();
  if (!profile) return null;

  const chips = activeChips(profile.filters, hiddenFieldsFor(ctx.market), labels, {
    excluded: (v) => t('chips.excluded', { value: v }),
    only: (v) => t('chips.only', { value: v }),
    quoted: (v) => `“${v}”`,
  });
  if (!chips.length) return null;

  const run = async (patch: FilterSetPatch) => {
    const result = await apply({ profile, patch, defaultCountry: ctx.defaultCountry });
    if (result.ok) {
      if (result.sponsorshipSynced === false) toast({ message: t('drawer.sponsorshipNotSynced'), tone: 'warn' });
      onApplied?.(result.profile);
    } else {
      toast({ message: result.conflict ? t('drawer.conflict') : t('drawer.saveFailed'), tone: 'warn' });
    }
  };

  const clearAll = () => {
    const patch: Record<string, null> = {};
    for (const c of chips) patch[c.field] = null;
    void run(patch as FilterSetPatch);
  };

  return (
    <div className={styles.chipsBar} role="group" aria-label={t('chips.label')}>
      <ul className={styles.tags}>
        {chips.map((c) => (
          <li key={c.key} className={styles.tag}>
            <span className={styles.tagText}>{c.label}</span>
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={t('chips.remove', { label: c.label })}
              disabled={isPending}
              onClick={() => void run(c.remove)}
            >
              <IconX size={14} />
            </button>
          </li>
        ))}
      </ul>
      {chips.length > 1 ? (
        <button type="button" className={styles.clearAll} onClick={clearAll} disabled={isPending}>
          {t('chips.clearAll')}
        </button>
      ) : null}
    </div>
  );
}
