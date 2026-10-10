'use client';

// components/features/feed/ZeroResults.tsx — "What's limiting your results"
// (PRODUCT F-FEED-10; ARCHITECTURE.md §4.8 counts).
//
// Each active filter that removes jobs is listed with the real number of jobs
// it removes (`GET /search-profiles/:id/limiting`, WP-20 over WP-32's count
// queries) and a one-tap button that removes just that filter (one PATCH).
// When the feed cannot count yet (`available: false`) no number is shown —
// only the way to the filters (D3).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, toast } from '../../v3/primitives';
import { FiltersDrawer, useFilterLabels } from '../filters';
import { useLimitingFilters, type SearchProfile } from '../../../hooks/search';
import type { FilterField } from '../../../lib/api/contracts/search';
import { relaxPatch } from '../../../hooks/feed/filterOps';
import { useProposalApply } from './useProposalApply';
import styles from './feed.module.css';

export interface ZeroResultsProps {
  profile: SearchProfile | null;
}

export function ZeroResults({ profile }: ZeroResultsProps) {
  const t = useTranslations('jobs.zero');
  const labels = useFilterLabels();
  const proposal = useProposalApply();
  const limiting = useLimitingFilters(profile);
  const [drawer, setDrawer] = useState(false);

  const items = (limiting.data?.available ? limiting.data.items : []).filter(
    (i) => typeof i.removalGain === 'number' && Number.isFinite(i.removalGain) && i.removalGain > 0,
  );

  const relax = async (field: string, value: unknown) => {
    if (!profile) return;
    const res = await proposal.save(relaxPatch(profile.filters, field, value), profile.id);
    if (res === 'saved') toast({ message: t('relaxed'), tone: 'ok' });
  };

  const describe = (field: string, value: unknown) => {
    const f = field as FilterField;
    const name = labels.field(f);
    if (value === undefined || value === null || typeof value === 'boolean') return name;
    return `${name}: ${labels.value(f, value, profile?.filters)}`;
  };

  return (
    <section className={styles.prompt} aria-labelledby="feed-zero-title" data-testid="zero-results">
      <h2 className={styles.promptTitle} id="feed-zero-title">
        {t('title')}
      </h2>
      {items.length > 0 ? (
        <>
          <p className={styles.help}>{t('intro')}</p>
          <ul className={styles.relaxList}>
            {items.map((i) => (
              <li key={`${i.field}:${JSON.stringify(i.value)}`}>
                <Btn className={styles.relaxBtn} disabled={proposal.isPending} onClick={() => void relax(i.field, i.value)}>
                  <span>{t('relax', { filter: describe(i.field, i.value) })}</span>
                  <span className={styles.gain}>{t('gain', { count: i.removalGain })}</span>
                </Btn>
              </li>
            ))}
          </ul>
        </>
      ) : limiting.isPending && profile ? null : (
        <p className={styles.help}>{t('unknown')}</p>
      )}
      <div className={styles.row}>
        <Btn className={styles.actionBtn} onClick={() => setDrawer(true)} disabled={!profile}>
          {t('openFilters')}
        </Btn>
      </div>
      <FiltersDrawer open={drawer} onClose={() => setDrawer(false)} profile={profile} />
    </section>
  );
}
