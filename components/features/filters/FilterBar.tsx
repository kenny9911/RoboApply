'use client';

// components/features/filters/FilterBar.tsx — the whole filter strip for
// /jobs (WP-33 renders it above the list): search with typeahead, the
// saved-search switcher, quick buttons + "All filters", active chips and the
// fit view. Everything reads and writes the ACTIVE search profile.

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
  const { profile, data } = useActiveSearchProfile();
  return (
    <div className={styles.drawerBody}>
      <div className={styles.row}>
        <SearchTypeahead profile={profile} onApplied={onApplied} />
      </div>
      <SavedSearchSwitcher list={data} active={profile} />
      <QuickFilterBar profile={profile} onApplied={onApplied} />
      <ActiveFilterChips profile={profile} onApplied={onApplied} />
      <FitTierFilter profile={profile} hiddenCount={hiddenWeakerFits} onApplied={onApplied} />
    </div>
  );
}
