'use client';

// RecordingRow — the recording line in the practice launch dock (WP-43, H8).
// Shows what this session will keep ("Off" by default) and opens the
// RecordingConsentSheet. Where recording cannot happen at all (switched off
// or no storage), it says so in one line and offers nothing.

import { useTranslations } from 'next-intl';

import type { PracticeRecordingRequest } from '../../../lib/api/interviewEngine';
import styles from './practice.module.css';

export interface RecordingRowProps {
  /** Recording can happen here at all (server: env switch + storage). */
  available: boolean;
  choice: PracticeRecordingRequest;
  onChange: () => void;
}

export function RecordingRow({ available, choice, onChange }: RecordingRowProps) {
  const t = useTranslations('practice.recording');
  if (!available) {
    return <p className={styles.recordingRow} data-testid="practice-recording-row">{t('unavailable')}</p>;
  }
  const value = !choice.audio ? t('off') : choice.video ? t('audioVideo') : t('audio');
  return (
    <p className={styles.recordingRow} data-testid="practice-recording-row">
      <span>
        {t('label')}: <strong>{value}</strong>
      </span>
      <button type="button" className={styles.link} onClick={onChange} aria-haspopup="dialog">
        {t('change')}
      </button>
    </p>
  );
}

export default RecordingRow;
