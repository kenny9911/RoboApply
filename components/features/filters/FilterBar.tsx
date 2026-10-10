'use client';

// components/features/filters/FilterBar.tsx — the whole filter strip for
// /jobs (WP-33 renders it above the list): search with typeahead, the
// saved-search switcher, quick buttons + "All filters", active chips and the
// fit view. Everything reads and writes the ACTIVE search profile.

import { useTranslations } from 'next-intl';

import { useOptimisticFilters } from '../../../hooks/search/useApplyFilters';
import { useActiveSearchProfile } from '../../../hooks/search/useSearchProfiles';
import type { SearchProfile } from '../../../hooks/search/useSearchProfiles';
import { ActiveFilterChips } from './ActiveFilterChips';
import { FitTierFilter } from './FitTierFilter';
import { QuickFilterBar } from './QuickFilterBar';
import { SavedSearchSwitcher } from './SavedSearchSwitcher';
import { SearchTypeahead } from './SearchTypeahead';
import styles from './filters.module.css';

export interface FilterBarProps {
  /** Jobs the fit view hides (from the feed); null when unknown. */
  hiddenWeakerFits?: number | null;
  onApplied?: (profile: SearchProfile) => void;
}

export function FilterBar({ hiddenWeakerFits = null, onApplied }: FilterBarProps) {
  const t = useTranslations('filters');
  const { profile, data } = useActiveSearchProfile();
  // Chips and the fit view already show a change the moment it is made; this line says it is being saved.
  const { saving } = useOptimisticFilters(profile);
  return (
    <div className={styles.drawerBody} aria-busy={saving}>
      <div className={styles.row}>
        <SearchTypeahead profile={profile} onApplied={onApplied} />
      </div>
      <SavedSearchSwitcher list={data} active={profile} />
      <QuickFilterBar profile={profile} onApplied={onApplied} />
      <ActiveFilterChips profile={profile} onApplied={onApplied} />
      <FitTierFilter profile={profile} hiddenCount={hiddenWeakerFits} onApplied={onApplied} />
      <p className={styles.savingNote} role="status" data-testid="filters-saving">
        {saving ? t('drawer.saving') : ''}
      </p>
    </div>
  );
}
