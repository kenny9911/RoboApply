'use client';

// OffersView — /applications?view=offers (flag `offers`): mounts WP-64's
// OfferComparison. Until an application reaches Offer, says how to start.

import { useTranslations } from 'next-intl';

import { OfferComparison } from '../offers';
import type { TrackerEntryView } from '../../../lib/api/contracts/tracker';
import { EntryRow } from './EntryRow';
import styles from './tracker.module.css';

const OFFER_STATUSES = new Set(['offer', 'negotiating', 'accepted', 'signed']);

export interface OffersViewProps {
  entries: readonly TrackerEntryView[];
  onOpen: (id: string) => void;
}

export function OffersView({ entries, onOpen }: OffersViewProps) {
  const t = useTranslations('applications');
  const offers = entries.filter((e) => OFFER_STATUSES.has(e.status));
  return (
    <div>
      <OfferComparison />
      {offers.length === 0 ? (
        <p className={styles.muted}>{t('offers_view.empty')}</p>
      ) : (
        <ul className={styles.rows}>
          {offers.map((e) => (
            <EntryRow key={e.id} entry={e} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}
