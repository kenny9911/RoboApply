'use client';

// components/features/filters/FilterBar.tsx — the search strip for /jobs
// (WP-33 renders it above the list; docs/agent-driven/REDESIGN.md §6).
//
//   summary   the active search in words + "Change search" (SearchSummary)
//   controls  search with typeahead, the saved-search switcher, quick buttons
//             + "All filters", the active chips. Shown on demand, in place:
//             nothing was removed, the summary line stands for them until the
//             user opens them.
//   view      the fit view ("Hiding {n} weaker fits" included) and whatever
//             the caller puts beside it (the feed's sort). Always visible.
//
// Everything reads and writes the ACTIVE search profile.
//
// Open or closed is the caller's when it passes `open` (/jobs opens the
// controls for a link that asks for them and after an Assistant change);
// without it the bar keeps its own state and starts closed. The controls stay
// open while they are used: only the button and "Done" close them. "Done"
// hands focus back to the button, so the keyboard is never left on a control
// that is gone.

import { useCallback, useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useOptimisticFilters } from '../../../hooks/search/useApplyFilters';
import { useActiveSearchProfile } from '../../../hooks/search/useSearchProfiles';
import type { SearchProfile } from '../../../hooks/search/useSearchProfiles';
import { ActiveFilterChips } from './ActiveFilterChips';
import { FitTierFilter } from './FitTierFilter';
import { QuickFilterBar } from './QuickFilterBar';
import { SavedSearchSwitcher } from './SavedSearchSwitcher';
import { SearchSummary } from './SearchSummary';
import { SearchTypeahead } from './SearchTypeahead';
import styles from './filters.module.css';

export interface FilterBarProps {
  /** Jobs the fit view hides (from the feed); null when unknown. */
  hiddenWeakerFits?: number | null;
  onApplied?: (profile: SearchProfile) => void;
  /** Whether the search controls are shown. Leave it out and the bar keeps its own state (closed first). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shown beside the fit view on the row that stays visible (the feed's sort). */
  trailing?: ReactNode;
}

export function FilterBar({ hiddenWeakerFits = null, onApplied, open: controlled, onOpenChange, trailing }: FilterBarProps) {
  const t = useTranslations('filters');
  const { profile, data, isPending } = useActiveSearchProfile();
  // Chips and the fit view already show a change the moment it is made; this line says it is being saved.
  const { saving } = useOptimisticFilters(profile);
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const panelId = useId();
  const buttonId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      setOwn(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const done = () => {
    setOpen(false);
    // The control that had focus is about to go: the button that opened the controls takes it.
    if (typeof document !== 'undefined') document.getElementById(buttonId)?.focus();
  };

  return (
    <div className={styles.bar} aria-busy={saving} data-open={open ? 'true' : 'false'}>
      <SearchSummary profile={profile} loading={isPending} open={open} onToggle={() => setOpen(!open)} panelId={panelId} buttonId={buttonId} />
      {/* Always in the page (the button's aria-controls names it); its controls mount when it opens. */}
      <div id={panelId} className={styles.searchPanel} role="group" aria-label={t('summary.panel')} hidden={!open} data-testid="search-panel">
        {open ? (
          <>
            <div className={styles.row}>
              <SearchTypeahead profile={profile} onApplied={onApplied} />
            </div>
            <SavedSearchSwitcher list={data} active={profile} />
            <QuickFilterBar profile={profile} onApplied={onApplied} />
            <ActiveFilterChips profile={profile} onApplied={onApplied} />
            <div className={styles.row}>
              <Btn variant="ghost" onClick={done}>
                {t('summary.done')}
              </Btn>
            </div>
          </>
        ) : null}
      </div>
      <div className={styles.viewRow}>
        <FitTierFilter profile={profile} hiddenCount={hiddenWeakerFits} onApplied={onApplied} />
        {trailing}
      </div>
      <p className={styles.savingNote} role="status" data-testid="filters-saving">
        {saving ? t('drawer.saving') : ''}
      </p>
    </div>
  );
}
