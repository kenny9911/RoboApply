'use client';

// components/features/filters/FitTierFilter.tsx — the fit view filter
// (PRODUCT F-FILT-05, rulings C2/C3): "Great fits only · Good fits and better
// · Everything", and "Hiding {n} weaker fits. Show them." when the feed says
// how many it hides. `hiddenCount` comes from the feed (WP-32/33); when it is
// unknown nothing is claimed. Unscored jobs are never hidden (server rule).

import { useTranslations } from 'next-intl';

import { toast } from '../../v3/primitives/Toast';
import { FIT_TIERS, type FilterSet } from '../../../hooks/search/filterModel';
import { useApplyFilters } from '../../../hooks/search/useApplyFilters';
import type { SearchProfile } from '../../../hooks/search/useSearchProfiles';
import { SegmentedChoice } from './FilterControls';
import { useEditorContext } from './FilterSections';
import styles from './filters.module.css';

type Tier = NonNullable<FilterSet['fitTier']>;

export interface FitTierFilterProps {
  profile: SearchProfile | null;
  /** Jobs the current tier hides (from the feed); null = unknown. */
  hiddenCount: number | null;
  onApplied?: (profile: SearchProfile) => void;
}

export function FitTierFilter({ profile, hiddenCount, onApplied }: FitTierFilterProps) {
  const t = useTranslations('filters');
  const ctx = useEditorContext();
  const { apply } = useApplyFilters();
  if (!profile) return null;
  const tier: Tier = profile.filters.fitTier ?? 'all';

  const choose = async (next: Tier) => {
    if (next === tier) return;
    const result = await apply({ profile, patch: { fitTier: next === 'all' ? null : next }, defaultCountry: ctx.defaultCountry });
    if (result.ok) onApplied?.(result.profile);
    else toast({ message: result.conflict ? t('drawer.conflict') : t('drawer.saveFailed'), tone: 'warn' });
  };

  return (
    <div className={styles.fitBar}>
      <SegmentedChoice
        label={t('fit.label')}
        hideLegend
        options={FIT_TIERS.map((v) => ({ value: v, label: t(`options.fitTier.${v}`) }))}
        value={tier}
        onChange={(v) => void choose(v)}
      />
      {tier !== 'all' && hiddenCount !== null && hiddenCount > 0 ? (
        <p className={styles.hiding} role="status">
          <span>{t('fit.hiding', { count: hiddenCount })}</span>
          <button type="button" className={styles.linkBtn} onClick={() => void choose('all')}>
            {t('fit.showThem')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
