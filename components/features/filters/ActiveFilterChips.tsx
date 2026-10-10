'use client';

// components/features/filters/ActiveFilterChips.tsx — one removable chip per
// active filter value (PRODUCT F-FILT-05). Removing a chip saves at once:
// one PATCH with `baseVersion` and a FilterSetPatch for that field.

import { useTranslations } from 'next-intl';

import { IconX } from '../../v3/primitives/Iconset';
import { toast } from '../../v3/primitives/Toast';
import { useApplyFilters, useOptimisticFilters } from '../../../hooks/search/useApplyFilters';
import {
  FIELD_ORDER,
  hiddenFieldsFor,
  isCountryWideLocation,
  normalizeFilters,
  type FilterField,
  type FilterLocation,
  type FilterSet,
  type FilterSetPatch,
} from '../../../hooks/search/filterModel';
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
  // "Anywhere in United States" next to the country filter "United States" is one statement, so one chip:
  // the location chip stands for both and removing it clears both.
  const wholeCountry = (n.locations as FilterLocation[] | undefined)?.find((l) => isCountryWideLocation(l) && l.country === n.country);
  for (const field of FIELD_ORDER) {
    const v = n[field];
    if (v === undefined || NO_CHIP.has(field) || hidden.includes(field)) continue;
    if (field === 'includeUndisclosedPay' && v !== false) continue;
    if (typeof v === 'boolean' && v === false && field !== 'includeUndisclosedPay') continue;
    if (field === 'country' && wholeCountry) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const rest = v.filter((_, j) => j !== i);
        let label = labels.value(field, item, fs);
        // A name that has not loaded yet (job functions): hold the chip rather than show an id.
        if (!label) return;
        if (EXCLUDING.has(field)) label = wrap.excluded(label);
        if (field === 'companies') label = wrap.only(label);
        const remove = { [field]: rest.length ? rest : null } as FilterSetPatch;
        if (field === 'locations' && item === wholeCountry) (remove as Record<string, unknown>).country = null;
        chips.push({ key: `${field}:${i}:${label}`, field, label, remove });
      });
      continue;
    }
    const label = field === 'q' ? wrap.quoted(String(v)) : labels.value(field, v, fs);
    if (!label) continue;
    chips.push({ key: field, field, label, remove: { [field]: null } as FilterSetPatch });
  }
  return chips;
}

export interface ActiveFilterChipsProps {
  profile: SearchProfile | null;
  onApplied?: (profile: SearchProfile) => void;
}

export function ActiveFilterChips({ profile: saved, onApplied }: ActiveFilterChipsProps) {
  const t = useTranslations('filters');
  const ctx = useEditorContext();
  const labels = useFilterLabels();
  const { apply } = useApplyFilters();
  // A chip disappears as soon as it is removed; the write behind it is queued (useApplyFilters).
  const { profile } = useOptimisticFilters(saved);
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
    return result;
  };

  // "Clear all" empties the saved search (alerts use it too), so it can be taken back:
  // Undo puts back exactly the fields that were cleared.
  const clearAll = async () => {
    const before = normalizeFilters(profile.filters) as Record<string, unknown>;
    const patch: Record<string, null> = {};
    const restore: Record<string, unknown> = {};
    for (const c of chips) {
      for (const field of Object.keys(c.remove)) {
        patch[field] = null;
        if (before[field] !== undefined) restore[field] = before[field];
      }
    }
    const result = await run(patch as FilterSetPatch);
    if (!result.ok) return;
    const cleared = result.profile;
    toast({
      message: t('chips.cleared'),
      tone: 'ok',
      action: {
        label: t('chips.undo'),
        onClick: () => {
          void apply({ profile: cleared, patch: restore as FilterSetPatch, defaultCountry: ctx.defaultCountry }).then((undone) => {
            if (undone.ok) onApplied?.(undone.profile);
            else toast({ message: t('drawer.saveFailed'), tone: 'warn' });
          });
        },
      },
    });
  };

  return (
    <div className={styles.chipsBar} role="group" aria-label={t('chips.label')}>
      <ul className={styles.tags}>
        {chips.map((c) => (
          <li key={c.key} className={styles.tag}>
            <span className={styles.tagText}>{c.label}</span>
            <button type="button" className={styles.chipRemove} aria-label={t('chips.remove', { label: c.label })} onClick={() => void run(c.remove)}>
              <IconX size={14} />
            </button>
          </li>
        ))}
      </ul>
      {chips.length > 1 ? (
        <button type="button" className={styles.clearAll} onClick={() => void clearAll()}>
          {t('chips.clearAll')}
        </button>
      ) : null}
    </div>
  );
}
