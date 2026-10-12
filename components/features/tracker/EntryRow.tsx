'use client';

// EntryRow — one application as a full-width button row (By date and List
// views). Opens the detail drawer.

import { useTranslations } from 'next-intl';

import type { TrackerEntryView } from '../../../lib/api/contracts/tracker';
import { entryCompany, entryRole, useDateFormat, useStageLabel } from './shared';
import styles from './tracker.module.css';

export interface EntryRowProps {
  entry: TrackerEntryView;
  onOpen: (id: string) => void;
}

export function EntryRow({ entry, onOpen }: EntryRowProps) {
  const t = useTranslations('applications');
  const stageLabel = useStageLabel();
  const { day } = useDateFormat();
  const company = entryCompany(entry) || t('card.untitled_company');
  const role = entryRole(entry) || t('card.untitled_role');
  const stage = entry.outcome ? `${stageLabel(entry.status)} · ${t(`outcome.${entry.outcome}`)}` : stageLabel(entry.status);
  return (
    <li className={styles.rowItem}>
      <button type="button" className={styles.rowButton} onClick={() => onOpen(entry.id)} aria-label={t('card.open', { name: `${company}, ${role}` })}>
        <span className={styles.rowMain}>
          <span className={styles.rowCompany}>{company}</span>
          <span className={styles.rowRole}>{role}</span>
        </span>
        <span className={styles.rowMeta}>{stage}</span>
        <span className={styles.rowMeta}>
          {entry.dateApplied ? t('date_view.applied_on', { date: day(entry.dateApplied) }) : t('date_view.saved_on', { date: day(entry.dateSaved) })}
        </span>
      </button>
    </li>
  );
}
