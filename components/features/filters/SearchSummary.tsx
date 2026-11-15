'use client';

// components/features/filters/SearchSummary.tsx — the active search in one
// line, with the button that shows the search controls
// (docs/agent-driven/REDESIGN.md §6: "Product designer · Remote · Senior ·
// Past month" + "Change search").
//
// The words are the active chips' own labels in the chips' order, so the line
// and the chips never disagree. A long search names its first values and says
// how many more there are; every value is in the chips once the controls are
// open. Nothing is claimed while the saved search is still loading (D3).
//
// The button is a disclosure: `aria-expanded` + `aria-controls` point at the
// element the caller shows and hides; its label does not change.

import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { IconChevron } from '../../v3/primitives/Iconset';
import type { SearchProfile } from '../../../hooks/search/useSearchProfiles';
import { useActiveChips } from './ActiveFilterChips';
import styles from './filters.module.css';

/** Values named on the line before "{n} more". */
export const SUMMARY_MAX_VALUES = 6;

/**
 * Which labels the line names and how many it leaves to the chips. One value
 * over the limit is simply named ("1 more" would take the same room). Pure.
 */
export function summaryParts(labels: readonly string[], max: number = SUMMARY_MAX_VALUES): { shown: string[]; more: number } {
  const all = labels.map((l) => l.trim()).filter(Boolean);
  const limit = Math.max(1, max);
  const shown = all.length <= limit + 1 ? all : all.slice(0, limit);
  return { shown, more: all.length - shown.length };
}

export interface SearchSummaryProps {
  profile: SearchProfile | null;
  /** The saved search is still being read: the line says so instead of "All jobs". */
  loading?: boolean;
  open: boolean;
  onToggle: () => void;
  /** id of the element this button shows and hides. */
  panelId: string;
  /** id for the button, so the caller can hand focus back to it. */
  buttonId?: string;
}

export function SearchSummary({ profile: saved, loading = false, open, onToggle, panelId, buttonId }: SearchSummaryProps) {
  const t = useTranslations('filters.summary');
  const { profile, chips } = useActiveChips(saved);
  const { shown, more } = summaryParts(chips.map((c) => c.label));

  let text: string;
  if (!profile) text = loading ? t('loading') : t('all');
  else if (shown.length === 0) text = t('all');
  else text = [...shown, ...(more > 0 ? [t('more', { count: more })] : [])].join(' · ');

  return (
    <div className={styles.summaryRow}>
      <p className={styles.summaryText} data-testid="search-summary" data-filters={profile ? chips.length : undefined}>
        <span className={styles.hidden}>{t('label')} </span>
        {text}
      </p>
      <Btn id={buttonId} className={styles.summaryBtn} aria-expanded={open} aria-controls={panelId} onClick={onToggle} data-testid="change-search">
        {t('change')}
        <IconChevron size={16} className={styles.summaryChevron} aria-hidden="true" />
      </Btn>
    </div>
  );
}
