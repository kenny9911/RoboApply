'use client';

// components/features/filters/FiltersDrawer.tsx — "All filters" (PRODUCT F-FILT-01…04).
//
// Edits a draft of the profile's FilterSet; the footer shows the live count
// ("Show {N} jobs", or "Show jobs" while the feed cannot count — D3) and
// saves the whole draft in ONE PATCH with `baseVersion`. A 409 loads the
// server's version into the draft and says so; nothing is overwritten.
//
//   <FiltersDrawer open={open} onClose={close} profile={activeProfile} />

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Drawer } from '../../v3/primitives/Drawer';
import { Btn } from '../../v3/primitives/Btn';
import { toast } from '../../v3/primitives/Toast';
import { useApplyFilters } from '../../../hooks/search/useApplyFilters';
import { useFilterCount } from '../../../hooks/search/useFilterQueries';
import { searchErrorReason, type SearchProfile } from '../../../hooks/search/useSearchProfiles';
import { hiddenFieldsFor, mergePatch, normalizeFilters, sameFilters, type FilterSet, type FilterSetPatch } from '../../../hooks/search/filterModel';
import { FilterSectionsView, useEditorContext, type DrawerSection } from './FilterSections';
import { useProfileLabel } from './SavedSearchSwitcher';
import styles from './filters.module.css';

export interface FiltersDrawerProps {
  open: boolean;
  onClose: () => void;
  profile: SearchProfile | null;
  /** Show only some sections (quick links); default all. */
  sections?: DrawerSection[];
  onApplied?: (profile: SearchProfile) => void;
}

/** The view and search-box fields are not edited in the drawer; "Clear all" keeps them. */
function cleared(fs: FilterSet): FilterSet {
  return normalizeFilters({ fitTier: fs.fitTier, q: fs.q });
}

export function FiltersDrawer({ open, onClose, profile, sections, onApplied }: FiltersDrawerProps) {
  const t = useTranslations('filters');
  const ctx = useEditorContext();
  const labelFor = useProfileLabel();
  const { apply, isPending } = useApplyFilters();
  const [draft, setDraft] = useState<FilterSet>(profile?.filters ?? {});
  const [base, setBase] = useState<SearchProfile | null>(profile);
  const [message, setMessage] = useState<{ tone: 'warn' | 'danger'; text: string } | null>(null);

  // Re-seed the draft each time the drawer opens (or the profile is replaced).
  useEffect(() => {
    if (!open) return;
    setDraft(profile?.filters ?? {});
    setBase(profile);
    setMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile?.id]);

  const hidden = hiddenFieldsFor(ctx.market);
  const visibleDraft = useMemo(() => {
    const out = { ...draft } as Record<string, unknown>;
    for (const f of hidden) delete out[f];
    return out as FilterSet;
  }, [draft, hidden]);

  const count = useFilterCount(open ? visibleDraft : null);
  const set = (patch: FilterSetPatch) => setDraft((d) => mergePatch(d, patch));

  const showLabel =
    count.count === null
      ? t('drawer.show')
      : count.capped
        ? t('drawer.showCapped', { count: count.count })
        : t('drawer.showCount', { count: count.count });

  const onShow = async () => {
    if (!base) return;
    if (sameFilters(base.filters, visibleDraft)) {
      onClose();
      return;
    }
    setMessage(null);
    const result = await apply({ profile: base, replace: visibleDraft, defaultCountry: ctx.defaultCountry });
    if (result.ok) {
      if (result.sponsorshipSynced === false) toast({ message: t('drawer.sponsorshipNotSynced'), tone: 'warn' });
      onApplied?.(result.profile);
      onClose();
      return;
    }
    if (result.conflict) {
      setBase(result.conflict);
      setDraft(result.conflict.filters);
      setMessage({ tone: 'warn', text: t('drawer.conflict') });
      return;
    }
    const reason = searchErrorReason(result.error);
    setMessage({ tone: 'danger', text: reason === 'invalid_filters' ? t('drawer.invalid') : t('drawer.saveFailed') });
  };

  const name = base ? labelFor(base) : t('unnamed');

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('drawer.title')}
      description={t('drawer.description', { name })}
      footer={
        <div className={styles.footer}>
          {message ? (
            <p role={message.tone === 'danger' ? 'alert' : 'status'} className={message.tone === 'danger' ? styles.error : styles.status}>
              {message.text}
            </p>
          ) : null}
          <div className={styles.footerRow}>
            <Btn variant="ghost" onClick={() => setDraft(cleared(draft))} disabled={isPending}>
              {t('drawer.clear')}
            </Btn>
            <Btn variant="primary" onClick={() => void onShow()} disabled={isPending || !base} aria-busy={count.isFetching || isPending}>
              {isPending ? t('drawer.saving') : showLabel}
            </Btn>
          </div>
        </div>
      }
    >
      <FilterSectionsView draft={visibleDraft} set={set} ctx={ctx} only={sections} />
    </Drawer>
  );
}
